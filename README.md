# ⚡ Scrapes

### Paste a URL. Get tutorial-ready carousel images. No design skills needed.

> **"What if turning any webpage into a polished Instagram carousel took 15 seconds instead of 45 minutes in Canva?"**

Built for the **Scrapes.ai x Hostinger Hackathon 2026** · Live at **[scrapes.felaniam.cloud](https://scrapes.felaniam.cloud)**

---

## 🎯 The Problem

Every day, creators, educators, and marketers see web content they want to share — a tool launch, a tutorial, a landing page breakdown. But turning that into engaging visual content means:

- Screenshotting manually and cropping sections
- Opening Canva/Figma and placing elements one by one
- Writing callouts, drawing arrows, picking colors
- Resizing everything for each platform (IG Feed ≠ TikTok ≠ Pinterest)
- Repeating the entire process per format

**A 5-minute insight becomes a 45-minute design task.** Most people just don't bother — and the content never gets made.

---

## 💡 The Solution

**Scrapes** eliminates the entire design step. Give it a URL, pick your platforms, and it delivers annotated carousel images — with intelligent highlights, arrows, callouts, and a cohesive color scheme — rendered and ready to post.

No templates. No drag-and-drop. No design decisions. Claude Vision *sees* the page, *understands* what matters, and *builds* the carousel for you.

```
URL  →  Screenshot  →  AI Analysis  →  Annotated Carousel  →  Download & Post
```

---

## ✨ Features

- **4-Type Slide System** — Opener → Scene → Insight → Closer. Each carousel tells a story, not just a screenshot dump
- **5 Platform Formats** — Instagram Feed (4:5), IG Stories (9:16), TikTok (9:16), Pinterest (2:3), Snapchat (9:16)
- **One-Pass Intelligence** — Claude Vision analyzes once, renders to any ratio. 1 format or 5 = same ~$0.03 API cost
- **Smart Ratio Deduplication** — IG Stories, TikTok, and Snapchat share 9:16? Rendered once, served three ways
- **User-Guided Focus** — Tell it what to highlight: *"Focus on the pricing table"* or *"Annotate the signup flow"*
- **Auto Color Extraction** — Pulls the page's brand palette for cohesive, on-brand annotations
- **Batch Download** — One click to grab every generated image
- **Image Upload Support** — Don't have a URL? Drop in a screenshot directly
- **Dark, Minimal UI** — Clean interface that stays out of your way

---

## 🎬 Demo

| Step | What Happens |
|------|-------------|
| **1. Paste** | Drop any URL into the input field |
| **2. Select** | Check the platforms you want (multi-select) |
| **3. Guide** *(optional)* | Add a prompt to steer what Claude focuses on |
| **4. Generate** | Hit go — results appear in ~15 seconds |
| **5. Download** | Grab individual images or batch download all |

🔗 **Try it live:** [scrapes.felaniam.cloud](https://scrapes.felaniam.cloud)

<p align="center">
  <img src="assets/demo-ui.png" alt="Scrapes UI" width="2560" />
</p>

<details>
<summary>📱 Mobile view</summary>
<p align="center">
  <img src="assets/demo-ui-mobile.png" alt="Scrapes Mobile UI" width="320" />
</p>
</details>

---

## 🏗️ How It Works

Scrapes separates **annotation** (the expensive, creative AI step) from **rendering** (the mechanical compositing step). This is the key architectural decision:

```
┌──────────┐     ┌────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Browser  │────▶│  Express Server │────▶│  Claude Vision    │────▶│  n8n Pipeline   │
│           │     │  (proxy + API)  │     │  (analyze once)   │     │  (render N fmt) │
└──────────┘     └────────────────┘     └──────────────────┘     └────────────────┘
                        │                        │                        │
                        ▼                        ▼                        ▼
                 ScreenshotOne            Structured JSON           Browserless
                 (capture page)           annotation plan          (HTML → PNG)
```

**The 4-type slide system:**

| Slide Type | Purpose | Example |
|-----------|---------|---------|
| **Opener** | Pure text title card — sets context | "How Stripe's Pricing Page Converts" |
| **Scene** | Screenshot crop + annotations — the workhorse | Highlighted CTA with arrow pointing to social proof |
| **Insight** | Text-only takeaway slide (optional) | "3 things this landing page gets right" |
| **Closer** | Contextual ending — adapts to content type | "Try it → stripe.com" or "TL;DR: 3 key steps" |

Claude returns all annotations in **percentage-based coordinates**, so the same plan scales naturally to 4:5, 9:16, 2:3 — or any future ratio — without re-running the AI.

---

## 🛠️ Tech Stack

| Technology | Role | Why This |
|-----------|------|----------|
| **Node.js + Express** | Server & API proxy | Minimal, fast, handles the single `/api/annotate` endpoint cleanly |
| **Claude Sonnet** | Vision analysis + annotation planning | Best-in-class vision understanding — sees UI elements, not just pixels |
| **ScreenshotOne** | Page capture | HMAC-signed requests, ad/cookie blocking, full-page capture up to 5000px |
| **Browserless** | HTML → PNG rendering | Self-hosted headless Chrome — renders SVG overlays onto screenshots at exact pixel dimensions |
| **n8n** | Workflow orchestration | Visual pipeline that connects screenshot → analysis → rendering in 9 nodes |
| **Coolify** | Deployment platform | One-click Docker deploys on Hostinger VPS — the entire stack self-hosted |

**Total dependencies:** 2 (`express` + `@anthropic-ai/sdk`). That's it.

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- Running [n8n](https://n8n.io) instance with the Scrapes render workflow
- [Browserless](https://browserless.io) instance (self-hosted or cloud)
- [ScreenshotOne](https://screenshotone.com) API credentials
- [Anthropic](https://anthropic.com) API key

### Local Setup

```bash
# Clone
git clone https://github.com/txmyer-dev/scrapes.git
cd scrapes

# Install (just 2 dependencies)
npm install

# Configure
export ANTHROPIC_API_KEY=sk-ant-...
export SSO_ACCESS_KEY=your-screenshotone-access-key
export SSO_SECRET_KEY=your-screenshotone-secret-key
export N8N_RENDER_WEBHOOK=https://your-n8n/webhook/scrapes-render

# Run
npm start
```

App runs on `http://localhost:3100`

### Docker

```bash
docker build -t scrapes .
docker run -p 3100:3100 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e SSO_ACCESS_KEY=... \
  -e SSO_SECRET_KEY=... \
  -e N8N_RENDER_WEBHOOK=https://your-n8n/webhook/scrapes-render \
  scrapes
```

---

## 🔮 Future Improvements

- **Horizontal formats** — YouTube thumbnails (16:9), Twitter/X cards, LinkedIn banners
- **Carousel editing** — Drag to reorder slides, edit callout text before downloading
- **Batch URLs** — Drop 10 URLs, get 10 carousels
- **Template system** — Save and reuse annotation styles across URLs
- **Auto-posting** — Direct publish to Instagram, TikTok, Pinterest via their APIs
- **Video output** — Animate the carousel as a short-form video with slide transitions
- **Chrome extension** — Right-click any page → "Generate carousel with Scrapes"

---

## 📐 Architecture Details

```
scrapes/
├── server.js           # Express server, Claude Vision integration, HTML template builders
├── public/
│   └── index.html      # Single-page frontend (vanilla HTML/CSS/JS)
├── Dockerfile          # Alpine Node 22 container
├── docker-compose.yaml # Full stack compose
└── deploy.sh           # Deployment script
```

**Cost per generation:** ~$0.03 (one Claude Sonnet vision call) + negligible compute for rendering. Generating 5 platform formats from one URL costs the same as generating 1.

---

## 📜 License

MIT

---

<p align="center">
  Built with frustration toward Canva and respect for Claude's vision capabilities.<br/>
  <strong>Scrapes.ai x Hostinger Hackathon 2026</strong>
</p>
