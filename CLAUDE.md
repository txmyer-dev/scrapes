# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Scrapes turns any URL into a 5-slide annotated carousel for social media. User pastes a URL, the app screenshots it via Urlbox, sends the screenshot to Claude Vision for analysis, and renders annotated slides via an n8n workflow backed by Browserless.

## Commands

```bash
npm start          # Run server on port 3100 (or PORT env var)
npm run dev         # Same as npm start (no hot-reload)
docker build -t scrapes . && docker run -p 3100:3100 scrapes  # Docker
```

No tests, no linter, no build step. The app is a single `server.js` + `public/index.html`.

## Required Environment Variables

- `ANTHROPIC_API_KEY` — Claude API key for vision analysis
- `URLBOX_API_KEY` / `URLBOX_SECRET_KEY` — Screenshot capture service (HMAC-signed URLs)
- `N8N_RENDER_WEBHOOK` — n8n webhook URL that receives the carousel payload and returns rendered PNGs (defaults to `https://n8n.felaniam.cloud/webhook/scrapes-render`)

## Architecture

**Single-file server** (`server.js`, ~460 lines) handles everything:

1. **Screenshot capture** — Builds HMAC-signed Urlbox render URLs for retina (2x) **fixed-viewport** screenshots (1080x1350, no full-page scroll) + full-page markdown extraction for text context
2. **Image compression** — Uses `sharp` to downscale retina images for Claude's 5MB/8000px limits while preserving full-res for rendering
3. **Claude Vision analysis** — Sends screenshot + page metadata to Claude Sonnet 4.6 with a detailed system prompt. Returns structured JSON: color scheme, 5 slides (1 opener + 3 scenes + 1 closer), percentage-based annotation coordinates
4. **HTML template builders** — `buildOpenerHtml()` and `buildCloserHtml()` generate self-contained HTML documents for non-scene slides, sized to exact pixel dimensions per format ratio
5. **n8n handoff** — POSTs the full carousel plan + base64 image to the n8n render webhook. n8n handles: cropping scene regions, overlaying SVG annotations onto screenshots, rendering HTML slides via Browserless, returning final PNGs

**Frontend** (`public/index.html`) is a single SPA with Tailwind CSS (CDN), Material Design 3 color tokens, and glassmorphism styling. Handles URL/image input, format selection (3:4, 4:5, 9:16), prompt input, and carousel display.

### Key Design Decisions

- **Analyze once, render many** — Claude runs once per URL. Annotations use percentage-based coordinates so the same plan renders to any aspect ratio without re-running the AI (~$0.03/generation regardless of format count)
- **3-type, 5-slide system** — Always exactly: opener (slide 1) → scene (slides 2-4) → closer (slide 5). Scene slides are screenshot crops with annotations; opener/closer are pure HTML rendered by Browserless
- **Fixed viewport, not full-page scroll** — Screenshots capture a 1080x1350 viewport (above-the-fold only). This makes Claude's percentage-based crop regions and annotation coordinates deterministic. Markdown is still extracted full-page for text context
- **No database, no auth, no state** — Stateless request/response. Each generation is independent

### API

- `POST /api/annotate` — Main endpoint. Body: `{ url?, image?, formats?, prompt? }`. Returns rendered slide images
- `GET /api/health` — Health check

## Deployment

Deployed via Docker on Coolify (Hostinger VPS) behind Traefik reverse proxy. `deploy.sh` handles the container lifecycle with Traefik labels for HTTPS/Let's Encrypt. Domain: `scrapes.felaniam.cloud`.
