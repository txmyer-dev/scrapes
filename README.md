# Scrapes

**Paste a URL. Get annotated tutorial images. No Canva needed.**

Scrapes takes any URL, screenshots it, uses Claude Vision to identify the most important elements, and renders annotated tutorial images with highlights, arrows, and callouts — ready to post on social media.

Built for the **Scrapes.ai x Hostinger Hackathon 2026**.

**Live at [scrapes.felaniam.cloud](https://scrapes.felaniam.cloud)**

---

## How It Works

```
URL → ScreenshotOne API → Claude Vision Analysis → SVG Overlay → Browserless PNG Render
```

1. **Screenshot** — ScreenshotOne captures a viewport screenshot (HMAC-signed requests)
2. **Metadata** — Parallel HTML fetch extracts title, description, headings, OG image
3. **Claude Vision** — Sends screenshot + metadata to Claude Sonnet. Claude returns a structured JSON annotation plan: highlights, arrows, callouts, color scheme, sections — all in percentage-based coordinates
4. **Render** — Builds an HTML page with the screenshot as background and SVG annotations overlaid. Browserless (headless Chromium) renders it to a final PNG
5. **Serve** — Node.js frontend displays the result with download buttons

## Key Design Decision: Separate Annotation from Rendering

Annotation is the expensive, creative step — it requires Claude Vision to understand the page and decide what to highlight. Rendering is mechanical — it just composites an SVG overlay onto a screenshot at specific pixel dimensions.

By separating these concerns:

- **Claude runs once per URL**, regardless of how many output formats you need
- The same annotation plan (percentage-based coordinates) scales naturally to any aspect ratio
- 1 format or 5 formats = same ~$0.03 Claude API cost
- Rendering N formats only adds a few seconds of Browserless compute, not N expensive vision API calls

## Features

- **5 vertical platforms** — Instagram Feed (4:5), Instagram Stories (9:16), TikTok (9:16), Pinterest (2:3), Snapchat (9:16)
- **Multi-select** — Check multiple platforms, generates all from a single annotation pass
- **User prompt** — Guide what Claude focuses on: "Highlight the pricing section" or "Focus on the signup flow"
- **Ratio deduplication** — Platforms sharing a ratio (IG Stories/TikTok/Snapchat) render once
- **Download All** — Batch download every generated image
- **Dark UI** — Clean, minimal interface

## Architecture

```
[Browser] → [Node.js Express Server] → [n8n Webhook Pipeline]
                                              ├── ScreenshotOne API (screenshot)
                                              ├── HTML fetch (metadata)
                                              ├── Claude Vision API (annotations)
                                              └── Browserless (HTML → PNG per format)
```

| Component | Role | Hosting |
|-----------|------|---------|
| Frontend + Proxy | Express server, static HTML | Coolify on Hostinger VPS |
| n8n Workflow | Orchestration pipeline (9 nodes) | Coolify on Hostinger VPS |
| Browserless | Headless Chromium for HTML→PNG | Docker on Hostinger VPS |
| ScreenshotOne | External screenshot API | SaaS |
| Claude Vision | AI annotation analysis | Anthropic API |

## Stack

- **n8n** — Workflow automation (webhook → pipeline → response)
- **Claude Sonnet** — Vision analysis and annotation planning
- **ScreenshotOne** — Signed screenshot capture
- **Browserless** — Self-hosted headless Chrome for HTML→PNG rendering
- **Node.js / Express** — Frontend proxy server
- **Hostinger VPS** — All infrastructure via Coolify

## Running Locally

```bash
npm install
N8N_WEBHOOK=https://your-n8n-instance/webhook/annotate npm start
```

The app runs on port 3100. You'll need a running n8n instance with the Annotate workflow configured.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `N8N_WEBHOOK` | `https://n8n.felaniam.cloud/webhook/annotate` | n8n webhook URL |

## Docker

```bash
docker build -t scrapes .
docker run -p 3100:3100 -e N8N_WEBHOOK=https://your-n8n/webhook/annotate scrapes
```

## License

MIT
