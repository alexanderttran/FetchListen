/* ============================================================
   /api/info — Vercel Serverless Function
   Returns video metadata + available download formats.
   ============================================================ */

const { getVideoInfo } = require('../lib/youtube');

module.exports = async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const videoId = req.query.v;

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' });
    return;
  }

  try {
    const data = await getVideoInfo(videoId);
    res.status(200).json(data);
  } catch (err) {
    console.error('Info error:', err.message);
    res.status(500).json({
      error: err.message || 'Failed to fetch video info',
    });
  }
};
