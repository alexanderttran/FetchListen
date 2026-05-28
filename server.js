/* ============================================================
   FetchListen — Express Server (Local Dev)
   Works for local development and traditional Node.js hosting.
   On Vercel, the api/ functions + public/ folder are used instead.
   ============================================================ */

const express = require('express');
const path = require('path');
const { getVideoInfo, getDownloadStream } = require('./lib/youtube');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── API: Get Video Info ───────────────────────────────────
// POST { videoId, cookies? }
app.post('/api/info', async (req, res) => {
  const { videoId, cookies } = req.body || {};
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const data = await getVideoInfo(videoId, cookies || null);
    res.json(data);
  } catch (err) {
    console.error('[/api/info] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch video info' });
  }
});

// ── API: Download MP3 ─────────────────────────────────────
// Accepts POST (JSON) or GET (Query parameters)
app.all('/api/download', async (req, res) => {
  let videoId, quality, cookies;
  if (req.method === 'POST') {
    ({ videoId, quality, cookies } = req.body || {});
  } else {
    videoId = req.query.v;
    quality = req.query.quality || '128k';
    cookies = req.query.cookies || null;
  }

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const options = { type: 'mp3', quality: quality || '192k' };
    const result = await getDownloadStream(videoId, options, cookies || null, req, res);

    if (result && result.handled) {
      return;
    }

    res.setHeader('Content-Type', result.contentType);
    
    // Only force attachment download for POST requests or explicit download query
    if (req.method === 'POST' || req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
    }

    result.stream.pipe(res);

    result.stream.on('error', (err) => {
      console.error('[/api/download] Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Download stream failed' });
    });

    res.on('close', () => {
      if (result.stream && result.stream.destroy) result.stream.destroy();
    });
  } catch (err) {
    console.error('[/api/download] Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed' });
  }
});

// ── Start Server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦  FetchListen is running at http://localhost:${PORT}\n`);
});

module.exports = app;
