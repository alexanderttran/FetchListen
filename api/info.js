/* ============================================================
   /api/info — Vercel Serverless Function
   Returns video metadata + available MP3 download formats.
   Accepts POST with optional { cookies } in body.
   ============================================================ */

const { getVideoInfo } = require('../lib/youtube');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Support both POST (with cookies) and GET (env-var-only)
  let videoId, cookies;
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
    cookies = body.cookies || null;
  } else {
    videoId = req.query.v;
  }

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'Invalid video ID' });
    return;
  }

  try {
    const data = await getVideoInfo(videoId, cookies, req);
    res.status(200).json(data);
  } catch (err) {
    console.error('[/api/info] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch video info' });
  }
};
