const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3100;
const N8N_RENDER_WEBHOOK = process.env.N8N_RENDER_WEBHOOK || 'https://n8n.felaniam.cloud/webhook/scrapes-render';

// ScreenshotOne credentials
const SSO_ACCESS = process.env.SSO_ACCESS_KEY;
const SSO_SECRET = process.env.SSO_SECRET_KEY;

// Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Screenshot ---
async function takeScreenshot(targetUrl) {
  const params = [
    `access_key=${SSO_ACCESS}`,
    `url=${encodeURIComponent(targetUrl)}`,
    `full_page=true`,
    `full_page_max_height=5000`,
    `format=jpg`,
    `image_quality=70`,
    `viewport_width=1280`,
    `viewport_height=800`,
    `delay=3`,
    `block_ads=true`,
    `block_cookie_banners=true`,
  ].join('&');
  const signature = crypto.createHmac('sha256', SSO_SECRET).update(params).digest('hex');
  const ssoUrl = `https://api.screenshotone.com/take?${params}&signature=${signature}`;

  const resp = await fetch(ssoUrl);
  if (!resp.ok) throw new Error('ScreenshotOne failed: ' + resp.status);
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > 4800000) throw new Error('Screenshot too large (' + Math.round(buffer.length / 1024 / 1024) + 'MB). Try a shorter page.');
  return buffer.toString('base64');
}

// --- Metadata ---
async function fetchMetadata(targetUrl) {
  try {
    const resp = await fetch(targetUrl, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const html = await resp.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)/i) || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description/i) || [])[1] || '';
    const headings = [...html.matchAll(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi)].map(m => m[1].trim()).slice(0, 15);
    return { title: title.trim(), description: desc.trim(), headings };
  } catch {
    return { title: '', description: '', headings: [] };
  }
}

// --- Claude Vision ---
async function analyzeWithClaude(base64Image, metadata, userPrompt) {
  const systemPrompt = `You are an expert at creating annotated tutorial image carousels. You will receive a full-page screenshot and must break it into 3-5 carousel slides.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "title": "Overall carousel title (max 8 words)",
  "subtitle": "One-line description",
  "colorScheme": { "primary": "#hex", "secondary": "#hex", "accent": "#hex", "text": "#hex" },
  "slides": [
    {
      "slideNumber": 1,
      "title": "Slide title",
      "cropRegion": { "y_start": 0, "y_end": 25 },
      "annotations": [
        { "type": "highlight", "region": { "x": 10, "y": 20, "width": 30, "height": 15 }, "label": "Callout", "color": "#hex" },
        { "type": "arrow", "from": { "x": 50, "y": 30 }, "to": { "x": 70, "y": 50 }, "label": "Points to", "color": "#hex" },
        { "type": "callout", "position": { "x": 40, "y": 60 }, "text": "Explanation", "number": 1, "color": "#hex" }
      ]
    }
  ]
}

RULES:
- cropRegion y_start/y_end: percentages (0-100) of full page height
- Annotation coordinates: percentages (0-100) RELATIVE TO THE CROP REGION, not the full page
- Slide 1 = HOOK (hero/striking part), middle = KEY FEATURES/STEPS, last = RESULT/CTA
- 2-5 annotations per slide, consistent color scheme
- Crop regions should NOT overlap — cover different sections of the page
- 3-5 slides depending on content density`;

  const userText = `This is a full-page screenshot of ${metadata.url}.

Page context:
- Title: ${metadata.title}
- Description: ${metadata.description}
- Key sections: ${JSON.stringify(metadata.headings)}
${userPrompt ? '\nUser instructions: ' + userPrompt : ''}

Analyze this page and create the carousel annotation plan.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: userText },
      ],
    }],
    system: systemPrompt,
  });

  const text = response.content[0].text;
  const cleaned = text.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

// --- Main endpoint ---
app.post('/api/annotate', async (req, res) => {
  let { url, image, formats, prompt } = req.body;

  if (!url && !image) return res.status(400).json({ error: 'URL or image is required' });

  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/\//, '');

  const formatList = formats || ['4:5'];

  try {
    // Step 1: Get screenshot + metadata in parallel
    let base64Image, metadata;
    if (image) {
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('Invalid image data');
      base64Image = match[2];
      metadata = { url: 'uploaded-image', title: 'Uploaded Image', description: '', headings: [] };
    } else {
      console.log('[1/3] Screenshot + metadata...');
      const [screenshot, meta] = await Promise.all([
        takeScreenshot(url),
        fetchMetadata(url),
      ]);
      base64Image = screenshot;
      metadata = { ...meta, url };
    }

    // Step 2: Claude Vision analysis
    console.log('[2/3] Claude Vision analysis...');
    const carousel = await analyzeWithClaude(base64Image, metadata, prompt);
    console.log(`  → ${carousel.slides.length} slides, "${carousel.title}"`);

    // Step 3: Send to n8n for rendering
    console.log('[3/3] Rendering slides...');
    const renderPayload = {
      carousel,
      base64Image,
      mimeType: 'image/jpeg',
      formats: formatList,
      url: metadata.url,
    };

    const renderResp = await fetch(N8N_RENDER_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(renderPayload),
    });

    if (!renderResp.ok) {
      const errText = await renderResp.text();
      throw new Error('Render failed: ' + errText.substring(0, 200));
    }

    const renderData = await renderResp.json();

    res.json({
      success: true,
      mode: 'carousel',
      title: carousel.title,
      subtitle: carousel.subtitle,
      url: metadata.url,
      formats: formatList,
      slideCount: renderData.slideCount || carousel.slides.length,
      slides: renderData.slides,
    });

  } catch (err) {
    console.error('Generation failed:', err.message);
    res.status(500).json({ error: 'Generation failed', details: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', render: N8N_RENDER_WEBHOOK });
});

app.listen(PORT, () => {
  console.log(`Scrapes app running on port ${PORT}`);
  console.log(`Render webhook: ${N8N_RENDER_WEBHOOK}`);
});
