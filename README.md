# Scrapes

**Paste a URL or upload a screenshot. Get a ready-to-post tutorial carousel.**

Scrapes turns any webpage into a multi-slide annotated carousel — the kind you see on Instagram, LinkedIn, and TikTok. It screenshots the page, uses Claude Vision to build a structured slide plan, and renders each slide as a polished PNG at your chosen aspect ratio.

No Canva. No design skills. One click.

**Live at [scrapes.felaniam.cloud](https://scrapes.felaniam.cloud)**

---

## How It Works

```
Input (URL or image) → Claude Vision Analysis → Slide Plan → Browserless Render → Carousel PNGs
```

### The Pipeline

1. **Capture** — If a URL is provided, ScreenshotOne takes a full-page screenshot (HMAC-signed). If an image is uploaded, it's used directly.
2. **Metadata** — Parallel HTML fetch extracts the page title, description, and headings for context.
3. **Claude Vision** — The screenshot + metadata go to Claude Sonnet 4.6, which returns a structured JSON slide plan with crop regions, annotations, and a color scheme — all in percentage-based coordinates.
4. **HTML Build** — Express builds complete HTML pages for text-only slides (opener, insight, closer) at each requested output resolution.
5. **Render** — An n8n workflow receives the plan and renders every slide via Browserless (headless Chromium). Scene slides composite the cropped screenshot with SVG annotations directly at output resolution. Text slides render the pre-built HTML.
6. **Serve** — The frontend displays the carousel with per-slide previews, a lightbox viewer, and batch download.

### The 4-Type Slide System

Every carousel is composed of four slide types, selected by Claude based on the page content:

| Type | Purpose | Rendering |
|------|---------|-----------|
| **Opener** | Title card — establishes what the page is about | Pure HTML (dark background, badge, headline) |
| **Scene** | Screenshot crop with annotations (highlights, arrows, callouts) | Cropped screenshot + SVG overlay |
| **Insight** | Key takeaways, stats, or quotes that read better as text | Pure HTML (numbered bullets, icon) |
| **Closer** | Contextual ending — "Try it" for tools, recap for tutorials, TL;DR for articles | Pure HTML (CTA button, summary) |

Claude decides how many slides to generate (3–6) and which types to use based on the page. A documentation page might get 4 scenes. A landing page might get an opener, 2 scenes, an insight, and a closer.

### Key Design Decision: Separate Analysis from Rendering

Claude Vision is the expensive, creative step — understanding the page and deciding what to highlight. Rendering is mechanical — compositing SVGs onto screenshots at specific pixel dimensions.

By separating these:

- **Claude runs once**, regardless of how many output formats or slides you need
- The same annotation plan (percentage-based coordinates) renders at any resolution
- 1 format or 3 formats = same ~$0.03 Claude API cost
- Adding formats only adds seconds of Browserless compute, not additional vision API calls

### Direct-to-Output Rendering

Scene slides render directly at the final output resolution — no intermediate "master" image. For a 4:5 slide (1080x1350), the screenshot crop and annotations fill the entire content area (1080x1294, minus a 56px title bar). This eliminates dead space and reduces Browserless calls.

## Features

- **Two input modes** — Paste a URL or drag-and-drop / upload a screenshot
- **3 output formats** — 3:4 (1080x1440), 4:5 (1080x1350), 9:16 (1080x1920)
- **Multi-select** — Generate multiple formats from a single analysis pass
- **User prompt** — Guide Claude's focus: "Highlight the pricing section" or "Focus on the API endpoints"
- **Smart color extraction** — Claude picks the page's brand colors for annotations and slide accents
- **"Teach, don't name" annotations** — Labels explain *why* something matters, not just what it is
- **Per-slide download** — Click any slide to preview, download individually or batch download all
- **Dark UI** — Clean, minimal interface

## Architecture

```
[Browser]
    │
    ├── URL mode: paste a URL
    │   └── Express server
    │       ├── ScreenshotOne API (full-page JPEG, HMAC-signed)
    │       └── HTML fetch (title, description, headings)
    │
    └── Upload mode: drag-and-drop image
        └── Express server (base64 extraction)

[Express Server — Claude Vision]
    │
    ├── Sends screenshot + metadata to Claude Sonnet 4.6
    ├── Receives structured JSON: slide plan, crop regions, annotations, colors
    ├── Builds HTML for text-only slides (opener, insight, closer) per format
    └── POSTs everything to n8n webhook

[n8n — Render Only Workflow]
    │
    ├── Pure slides: renders pre-built HTML via Browserless
    ├── Scene slides: composites crop + SVG annotations via Browserless
    └── Returns base64 PNGs per slide per format

[Browser]
    └── Displays carousel with lightbox, download buttons
```

| Component | Role | Hosting |
|-----------|------|---------|
| Express Server | Frontend, Claude Vision, HTML template builder | Docker on Hostinger VPS |
| n8n Workflow | Render orchestration (2 nodes: webhook + code) | Coolify on Hostinger VPS |
| Browserless | Headless Chromium for HTML/SVG to PNG | Docker on Hostinger VPS |
| ScreenshotOne | Full-page screenshot capture (URL mode) | SaaS |
| Claude Sonnet 4.6 | Vision analysis and slide planning | Anthropic API |
| Traefik | HTTPS termination and routing | Coolify on Hostinger VPS |

## Cost Per Generation

| Step | Cost | Notes |
|------|------|-------|
| ScreenshotOne | ~$0.01 | Per screenshot (URL mode only) |
| Claude Vision | ~$0.03 | One call per generation, regardless of format count |
| Browserless | $0.00 | Self-hosted, no per-call cost |
| **Total** | **~$0.03–0.04** | Per carousel (3–6 slides, any number of formats) |

## Running Locally

```bash
git clone https://github.com/your-repo/scrapes.git
cd scrapes
npm install

# Required environment variables
export ANTHROPIC_API_KEY=sk-ant-...
export SSO_ACCESS_KEY=your-screenshotone-access-key    # only needed for URL mode
export SSO_SECRET_KEY=your-screenshotone-secret-key    # only needed for URL mode
export N8N_RENDER_WEBHOOK=https://your-n8n/webhook/scrapes-render

npm start
```

The app runs on port 3100. You'll need:
- A running **n8n** instance with the "Scrapes — Render Only" workflow
- A running **Browserless** instance accessible from n8n
- An **Anthropic API key** with access to Claude Sonnet

## Docker

```bash
docker build -t scrapes .
docker run -d \
  --name scrapes \
  --env-file .env \
  -p 3100:3100 \
  scrapes
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key for Claude Vision |
| `SSO_ACCESS_KEY` | URL mode | — | ScreenshotOne access key |
| `SSO_SECRET_KEY` | URL mode | — | ScreenshotOne secret key |
| `N8N_RENDER_WEBHOOK` | Yes | `https://n8n.felaniam.cloud/webhook/scrapes-render` | n8n render workflow webhook URL |
| `PORT` | No | `3100` | Server port |

## Stack

- **Claude Sonnet 4.6** — Vision analysis, slide planning, annotation strategy
- **ScreenshotOne** — Full-page screenshot capture with HMAC signing
- **Browserless** — Self-hosted headless Chromium for HTML/SVG to PNG rendering
- **n8n** — Workflow automation for render orchestration
- **Node.js / Express** — Server, Claude Vision integration, HTML template engine
- **Hostinger VPS** — All infrastructure via Coolify + Docker

## License

MIT
