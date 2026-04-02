const express = require('express');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3100;
const N8N_RENDER_WEBHOOK = process.env.N8N_RENDER_WEBHOOK || 'https://n8n.felaniam.cloud/webhook/scrapes-render';

// Urlbox credentials
const URLBOX_KEY = process.env.URLBOX_API_KEY;
const URLBOX_SECRET = process.env.URLBOX_SECRET_KEY;

// Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Image compression for Claude (5MB base64 limit) ---
const MAX_CLAUDE_BYTES = 4_800_000; // stay under 5MB with margin

async function compressForClaude(base64Data, inputMimeType) {
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length <= MAX_CLAUDE_BYTES) return { base64: base64Data, mimeType: inputMimeType };

  // Convert to JPEG at decreasing quality until under limit
  for (const quality of [85, 70, 50]) {
    const compressed = await sharp(buf).jpeg({ quality }).toBuffer();
    if (compressed.length <= MAX_CLAUDE_BYTES) {
      console.log(`  Compressed ${(buf.length/1024/1024).toFixed(1)}MB → ${(compressed.length/1024/1024).toFixed(1)}MB (JPEG q${quality})`);
      return { base64: compressed.toString('base64'), mimeType: 'image/jpeg' };
    }
  }

  // Last resort: resize down + low quality
  const resized = await sharp(buf).resize(1920, null, { withoutEnlargement: true }).jpeg({ quality: 50 }).toBuffer();
  console.log(`  Resized+compressed ${(buf.length/1024/1024).toFixed(1)}MB → ${(resized.length/1024/1024).toFixed(1)}MB`);
  return { base64: resized.toString('base64'), mimeType: 'image/jpeg' };
}

// --- Screenshot via Urlbox render link ---
function buildUrlboxUrl(targetUrl, format, width, height) {
  const params = new URLSearchParams({
    url: targetUrl,
    width: String(width),
    height: String(height),
    full_page: 'true',
    block_ads: 'true',
    hide_cookie_banners: 'true',
    retina: 'true',
    format: format,
    quality: '80',
    delay: '3000',
  });
  const token = crypto.createHmac('sha256', URLBOX_SECRET).update(params.toString()).digest('hex');
  return `https://api.urlbox.com/v1/${URLBOX_KEY}/${token}/${format}?${params.toString()}`;
}

async function takeScreenshot(targetUrl, formatList) {
  // Use the tallest selected format as viewport — vertical capture for vertical social output
  const ratios = (formatList || ['4:5']).map(r => {
    const [w, h] = r.split(':').map(Number);
    return { ratio: r, w: 1080, h: Math.round(1080 * (h / w)) };
  });
  const tallest = ratios.reduce((a, b) => a.h > b.h ? a : b);

  // Capture screenshot (retina = 2x resolution for crisp output)
  const imgUrl = buildUrlboxUrl(targetUrl, 'jpg', tallest.w, tallest.h);
  console.log(`  Urlbox: ${tallest.w}x${tallest.h} viewport (retina 2x → ${tallest.w * 2}x${tallest.h * 2} output)`);

  const imgResp = await fetch(imgUrl);
  if (!imgResp.ok) {
    const errText = await imgResp.text().catch(() => '');
    throw new Error('Urlbox screenshot failed: ' + imgResp.status + ' ' + errText.substring(0, 200));
  }
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  // Also fetch markdown for Claude context
  let markdown = '';
  try {
    const mdUrl = buildUrlboxUrl(targetUrl, 'md', 1280, 800);
    const mdResp = await fetch(mdUrl);
    if (mdResp.ok) {
      markdown = await mdResp.text();
      // Trim to first 4000 chars to stay within Claude's context budget
      if (markdown.length > 4000) markdown = markdown.substring(0, 4000) + '\n...(truncated)';
      console.log(`  Markdown extracted: ${markdown.length} chars`);
    }
  } catch (e) {
    console.log('  Markdown extraction failed (non-fatal):', e.message);
  }

  return { base64: buffer.toString('base64'), markdown };
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

// --- Claude Vision (3-type slide system) ---
async function analyzeWithClaude(base64Image, metadata, userPrompt, mimeType = 'image/jpeg') {
  const systemPrompt = `You are an expert at creating tutorial image carousels from webpage screenshots. You produce exactly 5 slides using 3 types:

SLIDE TYPES:
1. "opener" — Text card with title AND key takeaways. Establishes what this page is about AND why it matters. Combines headline + 3 bullet points. Always slide 1.
2. "scene" — Screenshot crop with annotations. Shows a specific section of the page with highlights, arrows, and callouts. The workhorse. Always slides 2, 3, and 4.
3. "closer" — Contextual ending. Adapts to content type: "Try it" for tools, "Key steps" recap for tutorials, "TL;DR" for articles. Always slide 5.

STRUCTURE: Always produce EXACTLY 5 slides: 1 opener + 3 scenes + 1 closer.

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
      "badge": "SHORT LABEL",
      "bullets": ["Key insight or feature #1", "Key insight or feature #2", "Key insight or feature #3"],
      "icon": "lightbulb|chart|quote|list|star|check"
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
      "slideNumber": 5,
      "type": "closer",
      "title": "Try it yourself",
      "body": "Short closing line or recap",
      "cta": "Visit example.com"
    }
  ]
}

RULES:
- ALWAYS produce exactly 5 slides: opener (1) + scene (2) + scene (3) + scene (4) + closer (5)
- The opener MUST include 3 bullets summarizing the page's key value props or takeaways
- NEVER produce "insight" type slides — fold all insights into the opener bullets

CRITICAL SCENE RULES — ANNOTATION QUALITY:
- cropRegion: y_start/y_end are percentages (0-100) of full page height. Each crop MUST span 8-18% of the page height. ABSOLUTELY NEVER more than 20%. If you exceed 20%, the slide will have dead space and look broken.
- NEVER crop into empty/blank/white areas of the page. Every pixel of the crop should contain visible content. If the page is short, use smaller crops focused on dense content areas rather than stretching to cover empty space.
- The rendered slide should be FILLED with content edge to edge. No large blank areas. If a section has padding or whitespace below it, end the crop BEFORE the whitespace.
- Annotation coordinates: percentages (0-100) RELATIVE TO THE CROP REGION, not the full page.
- 2-4 annotations per scene slide. Fewer, precise annotations beat many scattered ones.

ANNOTATION PLACEMENT (CRITICAL — READ CAREFULLY):
- ONLY annotate elements you can clearly SEE and LOCATE in the screenshot. If you cannot identify the exact bounding box of an element, do NOT annotate it.
- Every annotation MUST point to a visually distinct element: a button, a screenshot region, a headline, a sidebar, a card, a form, a logo bar, a navigation item. NOT blank space.
- Before placing a highlight, mentally verify: "Is there actually a visible UI element at these coordinates within the crop?" If no, skip it.
- Before placing an arrow, verify: both the start AND end points touch real elements.
- Callout numbered circles must sit ON TOP of or immediately adjacent to the thing they describe.

ANNOTATION LABELS (CRITICAL):
- Labels must EXPLAIN or TEACH, not just name what's visible. The viewer can already see the element — tell them WHY it matters or what it DOES.
- BAD: "Bold value prop", "Main headline", "Trusted brands", "Feature section"
- GOOD: "Single launcher replaces 12 apps", "AI auto-routes Slack to issues", "One-click deploy from PR"
- Each label should make the viewer think "oh, that's interesting" — not "yes, I can see that."
- Highlight labels: max 25 characters. Explain the insight, not the obvious.
- Callout text: max 35 characters. Describe what the feature DOES.
- Arrow labels: max 20 characters. Show a relationship or flow.

COLOR RULES:
- colorScheme.primary: Pick the page's most VIBRANT brand color — never use dark/black colors (#0F0F0F, #1C1C1E, #111, etc.) as primary. If the page is dark-themed, find the accent color (buttons, links, highlights) and use THAT as primary.
- colorScheme.accent: Must contrast against dark backgrounds. Bright blues, greens, purples, oranges. Never gray or near-black.
- Annotation colors: Use bright, high-contrast colors that pop on the screenshot. Prefer the page's CTA button color.

OTHER RULES:
- Crop regions should NOT overlap — cover different sections of the page
- Total slides: ALWAYS exactly 5. No more, no less.
- Adapt the closer to the page type. Tools/products: "Try it" + URL. Tutorials: recap steps. Articles: TL;DR.
- badge on opener: a short category label like "TOOL", "TUTORIAL", "BLOG", "DOCS", "PORTFOLIO" etc.
- opener bullets: 3 concise points (max 50 chars each) that make the viewer want to swipe. Think "what's interesting about this page?" not "what sections does it have?".`;

  const markdownSection = metadata.markdown
    ? `\nExtracted page content (markdown):\n${metadata.markdown}\n`
    : '';

  const userText = `This is a full-page screenshot of ${metadata.url}.

Page context:
- Title: ${metadata.title}
- Description: ${metadata.description}
- Key sections: ${JSON.stringify(metadata.headings)}
${markdownSection}${userPrompt ? '\nUser instructions: ' + userPrompt : ''}

Analyze this page and create the carousel slide plan using the 4-type system.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
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
  const bullets = slide.bullets || [];
  const iconKey = slide.icon || 'lightbulb';
  const iconSvg = ICON_SVG[iconKey] || ICON_SVG.lightbulb;

  const bulletHtml = bullets.map((b, i) => `
    <div class="bullet">
      <div class="bullet-dot" style="background:${cs.primary}"></div>
      <div class="bullet-text">${escHtml(b)}</div>
    </div>`).join('');

  const hasBullets = bullets.length > 0;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0a0a0a; font-family: 'Inter', system-ui, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: ${Math.round(W * 0.08)}px; position: relative; }
body::before { content: ''; position: absolute; top: -40%; left: -20%; width: 140%; height: 100%; background: radial-gradient(ellipse at 30% 20%, ${cs.primary}22, transparent 60%), radial-gradient(ellipse at 70% 80%, ${cs.secondary}18, transparent 50%); pointer-events: none; }
.badge { display: inline-block; background: ${cs.primary}; color: white; font-size: ${Math.round(W * 0.018)}px; font-weight: 700; letter-spacing: 0.12em; padding: ${Math.round(H * 0.006)}px ${Math.round(W * 0.025)}px; border-radius: 6px; margin-bottom: ${Math.round(H * 0.018)}px; text-transform: uppercase; position: relative; z-index: 1; }
.title { font-size: ${Math.round(W * 0.058)}px; font-weight: 800; color: #f0f0f0; line-height: 1.1; letter-spacing: -0.03em; margin-bottom: ${Math.round(H * 0.012)}px; max-width: 90%; position: relative; z-index: 1; }
.subtitle { font-size: ${Math.round(W * 0.024)}px; font-weight: 400; color: rgba(255,255,255,0.55); line-height: 1.5; max-width: 80%; position: relative; z-index: 1; }
.accent-line { width: ${Math.round(W * 0.08)}px; height: 3px; background: ${cs.primary}; border-radius: 2px; margin: ${Math.round(H * 0.018)}px auto; position: relative; z-index: 1; }
.bullets { display: flex; flex-direction: column; gap: ${Math.round(H * 0.015)}px; position: relative; z-index: 1; margin-top: ${Math.round(H * 0.025)}px; text-align: left; width: 80%; }
.bullet { display: flex; align-items: flex-start; gap: ${Math.round(W * 0.025)}px; }
.bullet-dot { width: 8px; height: 8px; min-width: 8px; border-radius: 50%; margin-top: ${Math.round(W * 0.012)}px; }
.bullet-text { font-size: ${Math.round(W * 0.025)}px; color: rgba(255,255,255,0.8); line-height: 1.5; font-weight: 400; }
.counter { position: absolute; bottom: ${Math.round(H * 0.03)}px; right: ${Math.round(W * 0.04)}px; font-size: ${Math.round(W * 0.018)}px; color: rgba(255,255,255,0.25); font-weight: 600; }
</style></head><body>
<div class="badge">${badge}</div>
<div class="title">${title}</div>
<div class="accent-line"></div>
<div class="subtitle">${subtitle}</div>
${hasBullets ? `<div class="bullets">${bulletHtml}</div>` : ''}
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
    let base64Image, metadata, detectedMimeType, claudeBase64, claudeMimeType;
    if (image) {
      const match = image.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) throw new Error('Invalid image data');
      const rawBase64 = match[2];
      const rawMime = match[1];
      // Compress if needed for Claude's 5MB limit
      const compressed = await compressForClaude(rawBase64, rawMime);
      detectedMimeType = rawMime; // keep original mime for n8n render
      base64Image = rawBase64;    // keep full-res for n8n render
      // Store compressed version for Claude only
      claudeBase64 = compressed.base64;
      claudeMimeType = compressed.mimeType;
      metadata = { url: 'uploaded-image', title: 'Uploaded Image', description: '', headings: [] };
    } else {
      console.log('[1/3] Screenshot + metadata...');
      const [screenshotResult, meta] = await Promise.all([
        takeScreenshot(url, formatList),
        fetchMetadata(url),
      ]);
      base64Image = screenshotResult.base64;
      metadata = { ...meta, url, markdown: screenshotResult.markdown };
      // Retina screenshots can exceed Claude's 8000px limit — downscale for analysis
      const imgBuf = Buffer.from(base64Image, 'base64');
      const sharpMeta = await sharp(imgBuf).metadata();
      if (sharpMeta.width > 7999 || sharpMeta.height > 7999) {
        console.log(`  Retina image ${sharpMeta.width}x${sharpMeta.height} exceeds 8000px, downscaling for Claude...`);
        const scale = Math.min(7999 / sharpMeta.width, 7999 / sharpMeta.height);
        const resized = await sharp(imgBuf)
          .resize(Math.round(sharpMeta.width * scale), Math.round(sharpMeta.height * scale))
          .jpeg({ quality: 75 })
          .toBuffer();
        claudeBase64 = resized.toString('base64');
        claudeMimeType = 'image/jpeg';
        console.log(`  Downscaled to ${Math.round(sharpMeta.width * scale)}x${Math.round(sharpMeta.height * scale)} (${(resized.length/1024/1024).toFixed(1)}MB)`);
      }
    }

    // Step 2: Claude Vision analysis (4-type slide system)
    console.log('[2/3] Claude Vision analysis (4-type slides)...');
    // Use downscaled/compressed image for Claude, full-res retina for n8n rendering
    const claudeImg = claudeBase64 || base64Image;
    const claudeMime = claudeMimeType || detectedMimeType || 'image/jpeg';
    const carousel = await analyzeWithClaude(claudeImg, metadata, prompt, claudeMime);
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
    // Downscale retina image for n8n payload — keep proportions, use high quality
    let renderImage = base64Image;
    if (!image) {
      const renderBuf = Buffer.from(base64Image, 'base64');
      const renderMeta = await sharp(renderBuf).metadata();
      if (renderMeta.width > 1280) {
        const scaled = await sharp(renderBuf).resize(1280).png().toBuffer();
        renderImage = scaled.toString('base64');
        console.log(`  Render image: ${renderMeta.width}x${renderMeta.height} → 1280px wide (${(scaled.length/1024/1024).toFixed(1)}MB)`);
      }
    }
    const renderPayload = {
      carousel,
      base64Image: renderImage,
      mimeType: detectedMimeType || 'image/jpeg',
      formats: formatList,
      url: metadata.url,
      source: image ? 'upload' : 'url',
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
