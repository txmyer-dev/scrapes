const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3100;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || 'https://n8n.felaniam.cloud/webhook/scrapes';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint — calls n8n webhook, returns carousel slides
app.post('/api/annotate', async (req, res) => {
  let { url, image, formats, prompt, logo } = req.body;

  if (!url && !image) {
    return res.status(400).json({ error: 'URL or image is required' });
  }

  if (url && !/^https?:\/\//i.test(url)) {
    url = 'https://' + url.replace(/^\/\//, '');
  }

  const formatList = formats || ['4:5'];

  try {
    const payload = { formats: formatList, prompt: prompt || '', logo: logo || '' };
    if (image) {
      payload.image = image;
    } else {
      payload.url = url;
    }

    const response = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'n8n webhook failed');
    }

    const data = await response.json();

    // Carousel response from Scrapes workflow
    if (data.slides) {
      res.json({
        success: true,
        mode: 'carousel',
        title: data.title,
        subtitle: data.subtitle,
        url: data.url || url,
        formats: data.formats || formatList,
        slideCount: data.slideCount || data.slides.length,
        slides: data.slides,
      });
    // Legacy single-image fallback (from Annotate workflow)
    } else if (data.images) {
      res.json({
        success: true,
        mode: 'single',
        title: data.title,
        subtitle: data.subtitle,
        url: data.url || url,
        formats: data.formats || formatList,
        slides: [{ slideNumber: 1, title: data.title, images: data.images }],
        slideCount: 1,
      });
    } else {
      res.json({ success: false, error: 'No images returned from pipeline' });
    }
  } catch (err) {
    console.error('Generation failed:', err.message);
    res.status(500).json({ error: 'Generation failed', details: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', webhook: N8N_WEBHOOK });
});

app.listen(PORT, () => {
  console.log(`Scrapes app running on port ${PORT}`);
  console.log(`n8n webhook: ${N8N_WEBHOOK}`);
});
