/* ============================================================
   DownloadYes — Express Server
   Works for local development and traditional Node.js hosting.
   On Vercel, the api/ functions + public/ folder are used instead.
   ============================================================ */

const express = require('express');
const path = require('path');
const { getVideoInfo, getDownloadStream } = require('./lib/youtube');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Serve static files from public/ ────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Video info ────────────────────────────────────────
app.get('/api/info', async (req, res) => {
  const videoId = req.query.v;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  try {
    const data = await getVideoInfo(videoId);
    res.json(data);
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({
      error: err.message || 'Failed to fetch video info',
    });
  }
});

// ── API: Download stream ───────────────────────────────────
app.get('/api/download', async (req, res) => {
  const { v: videoId, itag, type, quality } = req.query;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID' });
  }

  if (!itag && !type) {
    return res
      .status(400)
      .json({ error: 'Missing format parameter (itag or type)' });
  }

  try {
    const { stream, contentInfo } = await getDownloadStream(videoId, {
      itag,
      type,
      quality,
    });

    res.setHeader('Content-Type', contentInfo.mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${contentInfo.filename}"`
    );

    const nodeStream = stream;
    nodeStream.pipe(res);

    nodeStream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download stream failed' });
      }
    });

    // Clean up if client disconnects
    res.on('close', () => {
      nodeStream.destroy();
    });
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: err.message || 'Download failed',
      });
    }
  }
});

// ── Fallback to index.html ─────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server (only when run directly, not imported) ────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ✦  DownloadYes is running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
