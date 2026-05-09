/* ============================================================
   DownloadYes — Express Server (Local Dev)
   Works for local development and traditional Node.js hosting.
   On Vercel, the api/ functions + public/ folder are used instead.
   ============================================================ */

const express = require('express');
const path = require('path');
const { getVideoInfo, getDownloadStream } = require('./lib/youtube');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Serve Static Files from public/ ───────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Get Video Info ───────────────────────────────────
app.get('/api/info', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const data = await getVideoInfo(videoId);
    res.json(data);
  } catch (err) {
    console.error('[/api/info] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch video info' });
  }
});

// ── API: Download Stream ──────────────────────────────────
app.get('/api/download', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const options = {};

    if (req.query.type === 'mp3') {
      options.type = 'mp3';
      options.quality = req.query.quality || '192k';
    } else if (req.query.itag) {
      options.itag = req.query.itag;
    } else {
      return res.status(400).json({ error: 'Missing itag or type parameter' });
    }

    const { stream, contentType, filename } = await getDownloadStream(videoId, options);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    stream.pipe(res);

    stream.on('error', (err) => {
      console.error('[/api/download] Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download stream failed' });
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
});

// ── Start Server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✦  DownloadYes is running at http://localhost:${PORT}\n`);
});

module.exports = app;
