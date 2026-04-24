/* ============================================================
   /api/download — Vercel Serverless Function
   Streams video/audio content to the client.
   ============================================================ */

const { getDownloadStream } = require('../lib/youtube');

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' });
    return;
  }

  try {
    const options = {};

    if (req.query.type === 'mp3') {
      options.type = 'mp3';
      options.quality = req.query.quality || '192k';
    } else if (req.query.itag) {
      options.itag = req.query.itag;
    } else {
      res.status(400).json({ error: 'Missing itag or type parameter' });
      return;
    }

    const { stream, contentType, filename } = await getDownloadStream(videoId, options);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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

    // Clean up if client disconnects
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
