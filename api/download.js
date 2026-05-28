/* ============================================================
   /api/download — Vercel Serverless Function
   Streams MP3 audio to the client.
   Accepts POST with { videoId, quality, cookies } in body.
   ============================================================ */

const { getDownloadStream } = require('../lib/youtube');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Support both POST (with cookies) and GET (env-var-only)
  let videoId, quality, cookies;
  if (req.method === 'POST') {
    let body = req.body;
    if (!body || typeof body !== 'object') {
      try {
        const raw = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => (data += chunk));
          req.on('end', () => resolve(data));
          req.on('error', reject);
        });
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
    }
    videoId = body.videoId;
    quality = body.quality || '192k';
    cookies = body.cookies || null;
  } else {
    videoId = req.query.v;
    quality = req.query.quality || '192k';
  }

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' });
    return;
  }

  try {
    const options = { type: 'mp3', quality };
    const { stream, contentType, filename } = await getDownloadStream(videoId, options, cookies);

    res.setHeader('Content-Type', contentType);
    if (req.method === 'POST' || req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.setHeader('Transfer-Encoding', 'chunked');

    stream.pipe(res);

    stream.on('error', (err) => {
      console.error('[/api/download] Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download stream failed' });
      } else {
        res.end();
      }
    });

    res.on('close', () => {
      if (stream.destroy) stream.destroy();
    });
  } catch (err) {
    console.error('[/api/download] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Download failed' });
    }
  }
};
