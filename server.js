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

// --- Claude Vision (4-type slide system) ---
async function analyzeWithClaude(base64Image, metadata, userPrompt) {
  const systemPrompt = `You are an expert at creating tutorial image carousels from webpage screenshots. You produce 4 types of slides:

SLIDE TYPES:
1. "opener" — Pure text title card. Establishes what this page/tool/article is about. Always slide 1.
2. "scene" — Screenshot crop with annotations. Shows a specific section of the page with highlights, arrows, and callouts. The workhorse — most slides are this type.
3. "insight" — Pure text slide for key takeaways, stats, comparisons, or quotes that are cleaner as text than as a screenshot crop. OPTIONAL — only include when the content has a clear takeaway worth pulling out.
4. "closer" — Contextual ending. Adapts to content type: "Try it" for tools, "Key steps" recap for tutorials, "TL;DR" for articles. Always the last slide.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "title": "Overall carousel title (max 8 words)",
  "subtitle": "One-line description",
  "pageType": "docs|blog|landing|portfolio|tool|news|tutorial|other",
  "colorScheme": { "primary": "#hex", "secondary": "#hex", "accent": "#hex", "text": "#ffffff" },
  "slides": [
    {
      "slideNumber": 1,
      "type": "opener",
      "title": "Big headline for the opener",
      "subtitle": "One supporting line",
      "badge": "SHORT LABEL"
    },
    {
      "slideNumber": 2,
      "type": "scene",
      "title": "What this section shows",
      "cropRegion": { "y_start": 0, "y_end": 25 },
      "annotations": [
        { "type": "highlight", "region": { "x": 10, "y": 20, "width": 30, "height": 15 }, "label": "Callout", "color": "#hex" },
        { "type": "arrow", "from": { "x": 50, "y": 30 }, "to": { "x": 70, "y": 50 }, "label": "Points to", "color": "#hex" },
        { "type": "callout", "position": { "x": 40, "y": 60 }, "text": "Explanation", "number": 1, "color": "#hex" }
      ]
    },
    {
      "slideNumber": 3,
      "type": "insight",
      "title": "Key Insight Title",
      "bullets": ["First point here", "Second point here", "Third point here"],
      "icon": "lightbulb|chart|quote|list|star|check"
    },
    {
      "slideNumber": 4,
      "type": "closer",
      "title": "Try it yourself",
      "body": "Short closing line or recap",
      "cta": "Visit example.com"
    }
  ]
}

RULES:
- ALWAYS start with an opener (slide 1) and end with a closer (last slide)

CRITICAL SCENE RULES — ANNOTATION QUALITY:
- cropRegion: y_start/y_end are percentages (0-100) of full page height. Each crop MUST span 8-18% of the page height. NEVER more than 20%. Tight crops = readable annotations. Wide crops = unreadable tiny text. If a section is large, pick ONE focused sub-section.
- Annotation coordinates: percentages (0-100) RELATIVE TO THE CROP REGION, not the full page.
- 3-5 annotations per scene slide. Use ALL three types (highlight, arrow, callout) in most slides for visual variety.
- Annotations should point to SPECIFIC UI elements, buttons, text, or features — not vague regions.
- Highlight regions: width 15-40%, height 5-15%. Big enough to be visible. Small highlights are useless.
- Callout text: max 30 characters. Short and punchy. "Sign up CTA" not "This is where users can sign up for the service".
- Arrow labels: max 20 characters.

COLOR RULES:
- colorScheme.primary: Pick the page's most VIBRANT brand color — never use dark/black colors (#0F0F0F, #1C1C1E, #111, etc.) as primary. If the page is dark-themed, find the accent color (buttons, links, highlights) and use THAT as primary.
- colorScheme.accent: Must contrast against dark backgrounds. Bright blues, greens, purples, oranges. Never gray or near-black.
- Annotation colors: Use bright, high-contrast colors that pop on the screenshot. Prefer the page's CTA button color.

OTHER RULES:
- Crop regions should NOT overlap — cover different sections of the page
- Insight slides are OPTIONAL. Only include when there's a genuine takeaway worth pulling out as text. Don't force them.
- Total slides: 3-6 depending on content density.
- Adapt the closer to the page type. Tools/products: "Try it" + URL. Tutorials: recap steps. Articles: TL;DR.
- badge on opener: a short category label like "TOOL", "TUTORIAL", "BLOG", "DOCS", "PORTFOLIO" etc.`;

  const userText = `This is a full-page screenshot of ${metadata.url}.

Page context:
- Title: ${metadata.title}
- Description: ${metadata.description}
- Key sections: ${JSON.stringify(metadata.headings)}
${userPrompt ? '\nUser instructions: ' + userPrompt : ''}

Analyze this page and create the carousel slide plan using the 4-type system.`;

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
  const parsed = JSON.parse(cleaned);
  // Log full Claude response for debugging annotation quality
  console.log('[CLAUDE PLAN]', JSON.stringify(parsed, null, 2));
  return parsed;
}

// --- HTML Template Builders for Pure Slides ---

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');`;

const ICON_SVG = {
  lightbulb: `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>`,
  chart: `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  quote: `<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>`,
  list: `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  star: `<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  check: `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function buildOpenerHtml(slide, carousel, W, H, totalSlides) {
  const cs = carousel.colorScheme;
  const badge = escHtml(slide.badge || carousel.pageType || '');
  const title = escHtml(slide.title || carousel.title || '');
  const subtitle = escHtml(slide.subtitle || carousel.subtitle || '');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0a0a0a; font-family: 'Inter', system-ui, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: ${Math.round(W * 0.08)}px; position: relative; }
body::before { content: ''; position: absolute; top: -40%; left: -20%; width: 140%; height: 100%; background: radial-gradient(ellipse at 30% 20%, ${cs.primary}22, transparent 60%), radial-gradient(ellipse at 70% 80%, ${cs.secondary}18, transparent 50%); pointer-events: none; }
.badge { display: inline-block; background: ${cs.primary}; color: white; font-size: ${Math.round(W * 0.018)}px; font-weight: 700; letter-spacing: 0.12em; padding: ${Math.round(H * 0.008)}px ${Math.round(W * 0.025)}px; border-radius: 6px; margin-bottom: ${Math.round(H * 0.025)}px; text-transform: uppercase; position: relative; z-index: 1; }
.title { font-size: ${Math.round(W * 0.065)}px; font-weight: 800; color: #f0f0f0; line-height: 1.1; letter-spacing: -0.03em; margin-bottom: ${Math.round(H * 0.02)}px; max-width: 90%; position: relative; z-index: 1; }
.subtitle { font-size: ${Math.round(W * 0.026)}px; font-weight: 400; color: rgba(255,255,255,0.55); line-height: 1.5; max-width: 80%; position: relative; z-index: 1; }
.accent-line { width: ${Math.round(W * 0.08)}px; height: 4px; background: ${cs.primary}; border-radius: 2px; margin: ${Math.round(H * 0.025)}px auto; position: relative; z-index: 1; }
.counter { position: absolute; bottom: ${Math.round(H * 0.03)}px; right: ${Math.round(W * 0.04)}px; font-size: ${Math.round(W * 0.018)}px; color: rgba(255,255,255,0.25); font-weight: 600; }
</style></head><body>
<div class="badge">${badge}</div>
<div class="title">${title}</div>
<div class="accent-line"></div>
<div class="subtitle">${subtitle}</div>
<div class="counter">${slide.slideNumber}/${totalSlides}</div>
</body></html>`;
}

function buildInsightHtml(slide, carousel, W, H, totalSlides) {
  const cs = carousel.colorScheme;
  const title = escHtml(slide.title || 'Key Takeaway');
  const bullets = slide.bullets || [];
  const iconKey = slide.icon || 'lightbulb';
  const iconSvg = ICON_SVG[iconKey] || ICON_SVG.lightbulb;

  const bulletHtml = bullets.map((b, i) => `
    <div class="bullet">
      <div class="bullet-num">${i + 1}</div>
      <div class="bullet-text">${escHtml(b)}</div>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0a0a0a; font-family: 'Inter', system-ui, sans-serif; display: flex; flex-direction: column; padding: ${Math.round(W * 0.08)}px; position: relative; }
body::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: radial-gradient(ellipse at 50% 0%, ${cs.primary}15, transparent 60%); pointer-events: none; }
.icon { color: ${cs.primary}; margin-bottom: ${Math.round(H * 0.02)}px; position: relative; z-index: 1; }
.title { font-size: ${Math.round(W * 0.045)}px; font-weight: 800; color: #f0f0f0; line-height: 1.15; letter-spacing: -0.02em; margin-bottom: ${Math.round(H * 0.04)}px; position: relative; z-index: 1; }
.bullets { display: flex; flex-direction: column; gap: ${Math.round(H * 0.025)}px; position: relative; z-index: 1; flex: 1; justify-content: center; }
.bullet { display: flex; align-items: flex-start; gap: ${Math.round(W * 0.03)}px; }
.bullet-num { width: ${Math.round(W * 0.045)}px; height: ${Math.round(W * 0.045)}px; min-width: ${Math.round(W * 0.045)}px; background: ${cs.primary}25; color: ${cs.primary}; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: ${Math.round(W * 0.022)}px; font-weight: 700; margin-top: 2px; }
.bullet-text { font-size: ${Math.round(W * 0.028)}px; color: rgba(255,255,255,0.85); line-height: 1.5; font-weight: 400; }
.counter { position: absolute; bottom: ${Math.round(H * 0.03)}px; right: ${Math.round(W * 0.04)}px; font-size: ${Math.round(W * 0.018)}px; color: rgba(255,255,255,0.25); font-weight: 600; }
</style></head><body>
<div class="icon">${iconSvg}</div>
<div class="title">${title}</div>
<div class="bullets">${bulletHtml}</div>
<div class="counter">${slide.slideNumber}/${totalSlides}</div>
</body></html>`;
}

function buildCloserHtml(slide, carousel, W, H, totalSlides) {
  const cs = carousel.colorScheme;
  const title = escHtml(slide.title || 'Explore');
  const body = escHtml(slide.body || '');
  const cta = escHtml(slide.cta || '');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0a0a0a; font-family: 'Inter', system-ui, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: ${Math.round(W * 0.08)}px; position: relative; }
body::before { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 60%; background: linear-gradient(to top, ${cs.primary}12, transparent); pointer-events: none; }
.title { font-size: ${Math.round(W * 0.055)}px; font-weight: 800; color: #f0f0f0; line-height: 1.15; letter-spacing: -0.02em; margin-bottom: ${Math.round(H * 0.02)}px; position: relative; z-index: 1; }
.body { font-size: ${Math.round(W * 0.025)}px; color: rgba(255,255,255,0.55); line-height: 1.6; max-width: 85%; margin-bottom: ${Math.round(H * 0.035)}px; position: relative; z-index: 1; }
.cta { display: inline-block; background: ${cs.primary}; color: white; font-size: ${Math.round(W * 0.024)}px; font-weight: 700; padding: ${Math.round(H * 0.015)}px ${Math.round(W * 0.06)}px; border-radius: 12px; position: relative; z-index: 1; letter-spacing: 0.01em; }
.counter { position: absolute; bottom: ${Math.round(H * 0.03)}px; right: ${Math.round(W * 0.04)}px; font-size: ${Math.round(W * 0.018)}px; color: rgba(255,255,255,0.25); font-weight: 600; }
.arrow { font-size: ${Math.round(W * 0.04)}px; color: ${cs.primary}; margin-bottom: ${Math.round(H * 0.025)}px; position: relative; z-index: 1; }
</style></head><body>
<div class="arrow">&#x2192;</div>
<div class="title">${title}</div>
<div class="body">${body}</div>
${cta ? `<div class="cta">${cta}</div>` : ''}
<div class="counter">${slide.slideNumber}/${totalSlides}</div>
</body></html>`;
}

// Build HTML for a pure slide at a specific output format
function buildPureSlideHtml(slide, carousel, ratioStr, totalSlides) {
  const parts = ratioStr.split(':').map(Number);
  const W = 1080;
  const H = Math.round(W * (parts[1] / parts[0]));

  switch (slide.type) {
    case 'opener': return buildOpenerHtml(slide, carousel, W, H, totalSlides);
    case 'insight': return buildInsightHtml(slide, carousel, W, H, totalSlides);
    case 'closer': return buildCloserHtml(slide, carousel, W, H, totalSlides);
    default: return null;
  }
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

    // Step 2: Claude Vision analysis (4-type slide system)
    console.log('[2/3] Claude Vision analysis (4-type slides)...');
    const carousel = await analyzeWithClaude(base64Image, metadata, prompt);
    const totalSlides = carousel.slides.length;
    console.log(`  → ${totalSlides} slides (types: ${carousel.slides.map(s => s.type).join(', ')}), "${carousel.title}"`);

    // Step 3: Build HTML for pure slides, attach to slide objects
    console.log('[3/3] Building HTML + rendering...');
    for (const slide of carousel.slides) {
      if (slide.type !== 'scene') {
        slide.htmlByFormat = {};
        for (const ratioStr of formatList) {
          slide.htmlByFormat[ratioStr] = buildPureSlideHtml(slide, carousel, ratioStr, totalSlides);
        }
      }
    }

    // Step 4: Send to n8n for rendering (scene slides use crop+annotate, pure slides use provided HTML)
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
      pageType: carousel.pageType,
      url: metadata.url,
      formats: formatList,
      slideCount: renderData.slideCount || totalSlides,
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
