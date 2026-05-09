/* ============================================================
   /api/info — Vercel Serverless Function
   Returns video metadata + available download formats.
   ============================================================ */

const { getVideoInfo } = require('../lib/youtube');

module.exports = async function handler(req, res) {
  // CORS headers for cross-origin requests
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
    const data = await getVideoInfo(videoId);
    res.status(200).json(data);
  } catch (err) {
    console.error('[/api/info] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch video info' });
  }
};
