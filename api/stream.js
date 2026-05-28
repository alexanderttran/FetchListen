/* ============================================================
   /api/stream — Vercel Serverless Function
   Streams raw YouTube audio (MP4) directly to the client.
   No transcoding — near-instant start, supports range requests.
   Accepts GET with v= and optional c= (base64 cookies) params.
   ============================================================ */

const { getAudioStream } = require('../lib/youtube');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const videoId = req.query.v;
  // Cookies passed as base64-encoded string to avoid URL size limits
  const cookiesB64 = req.query.c || null;
  let cookies = null;
  if (cookiesB64) {
    try {
      cookies = Buffer.from(cookiesB64, 'base64').toString('utf8');
    } catch (e) {
      cookies = null;
    }
  }

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' });
    return;
  }

  try {
    await getAudioStream(videoId, cookies, req, res);
  } catch (err) {
    console.error('[/api/stream] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Stream failed' });
    }
  }
};
