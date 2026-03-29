const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3100;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || 'https://n8n.felaniam.cloud/webhook/annotate';

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint — calls n8n webhook with formats + prompt, returns all images
app.post('/api/annotate', async (req, res) => {
  let { url, image, formats, prompt, logo } = req.body;

  if (!url && !image) {
    return res.status(400).json({ error: 'URL or image is required' });
  }

  // Normalize URL: add https:// if no protocol
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

    // New multi-format response from Render All Formats node
    if (data.images) {
      res.json({
        success: true,
        title: data.title,
        subtitle: data.subtitle,
        url: data.url || url,
        formats: data.formats || formatList,
        annotationCount: data.annotationCount || 0,
        images: data.images,
      });
    } else if (data.image) {
      // Legacy single-image fallback
      res.json({
        success: true,
        title: data.title,
        subtitle: data.subtitle,
        url: data.url || url,
        images: { [formatList[0]]: data.image },
      });
    } else {
      res.json({ success: false, error: 'No images returned from pipeline' });
    }
  } catch (err) {
    console.error('Annotation failed:', err.message);
    res.status(500).json({ error: 'Annotation failed', details: err.message });
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
