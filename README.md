# Scrapes

URL to annotated tutorial image carousels, powered by Claude Vision.

Paste a URL (or upload a screenshot), and Scrapes takes a full-page screenshot, sends it to Claude for analysis, and renders a multi-slide carousel with cropped scenes, annotations, and text slides — ready for social media.

## How It Works

1. **Screenshot** — [ScreenshotOne](https://screenshotone.com) captures a full-page JPG (or you upload your own image)
2. **Analyze** — Claude Vision (Sonnet) examines the page and produces a structured slide plan using a 4-type system:
   - **Opener** — text title card
   - **Scene** — cropped screenshot region with highlight, arrow, and callout annotations
   - **Insight** — optional text slide for key takeaways
   - **Closer** — contextual ending (CTA, recap, or TL;DR)
3. **Render** — pure slides are built as HTML on the server; scene slides are sent to an n8n webhook for crop + annotate rendering

The API returns an array of rendered slide images per output format.

## Stack

| Layer | Tech |
|-------|------|
| Server | Express (Node 22) |
| AI | Anthropic SDK (`claude-sonnet-4-6`) |
| Screenshots | ScreenshotOne API |
| Rendering | n8n webhook (`scrapes-render`) |
| Deploy | Docker + Traefik via Coolify |

## API

### `POST /api/annotate`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | one of url/image | Page URL to screenshot |
| `image` | string | one of url/image | Base64 data URI (`data:image/...;base64,...`) |
| `formats` | string[] | no | Output aspect ratios (default: `["4:5"]`) |
| `prompt` | string | no | Additional instructions for Claude's analysis |

**Response:**

```json
{
  "success": true,
  "mode": "carousel",
  "title": "Carousel title",
  "subtitle": "One-line description",
  "pageType": "docs|blog|landing|tool|...",
  "url": "https://example.com",
  "formats": ["4:5"],
  "slideCount": 4,
  "slides": [...]
}
```

### `GET /api/health`

Returns `{ "status": "ok" }`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: `3100`) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SSO_ACCESS_KEY` | ScreenshotOne access key |
| `SSO_SECRET_KEY` | ScreenshotOne secret key |
| `N8N_RENDER_WEBHOOK` | n8n render webhook URL |

## Run Locally

```bash
npm install
ANTHROPIC_API_KEY=sk-... SSO_ACCESS_KEY=... SSO_SECRET_KEY=... node server.js
```

Open `http://localhost:3100` for the web UI.

## Deploy (Docker)

```bash
docker compose up -d --build
```

The compose file includes Traefik labels for `scrapes.felaniam.cloud`.
