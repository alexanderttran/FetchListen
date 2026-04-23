/* ============================================================
   /api/download — Vercel Serverless Function
   Streams video/audio content to the client.
   ============================================================ */

const { getDownloadStream } = require('../lib/youtube');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { v: videoId, itag, type, quality } = req.query;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' });
    return;
  }

  if (!itag && !type) {
    res.status(400).json({ error: 'Missing format parameter (itag or type)' });
    return;
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

    stream.pipe(res);

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download stream failed' });
      }
    });
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: err.message || 'Download failed',
      });
    }
  }
};
