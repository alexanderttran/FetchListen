/* ============================================================
   FetchListen — YouTube Logic
   Uses youtubei.js (Innertube) with local PO token generation.
   ============================================================ */

const { Innertube, UniversalCache } = require('youtubei.js');
const { spawn } = require('child_process');
const fs = require('fs');

// ffmpeg-static
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
} catch {
  ffmpegPath = null;
  console.warn('[FetchListen] ffmpeg-static not found');
}

// ── Cookie Helper ──────────────────────────────────────────
// Converts Netscape cookies.txt → semicolon-separated cookie header
function netscapeToCookieString(raw) {
  if (!raw) return null;
  return raw
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => {
      const p = l.split('\t');
      return p.length >= 7 ? `${p[5]}=${p[6]}` : null;
    })
    .filter(Boolean)
    .join('; ') || null;
}

// ── Create Innertube Client ────────────────────────────────
// generate_session_locally creates a valid visitor_data + PO token
// in pure JS — no browser needed — bypassing datacenter bot detection.
async function createClient(cookiesContent) {
  const raw = cookiesContent || process.env.YOUTUBE_COOKIES || null;
  const cookie = netscapeToCookieString(raw);
  return Innertube.create({
    generate_session_locally: true,
    retrieve_player: true,
    cache: new UniversalCache(false),
    ...(cookie ? { cookie } : {}),
  });
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId, cookiesContent) {
  const yt = await createClient(cookiesContent);
  const info = await yt.getInfo(videoId);
  const d = info.basic_info;

  const audioFormats = [];
  if (ffmpegPath) {
    [
      { bitrate: '320 kbps', quality: '320k', label: 'MP3 — 320kbps' },
      { bitrate: '192 kbps', quality: '192k', label: 'MP3 — 192kbps' },
      { bitrate: '128 kbps', quality: '128k', label: 'MP3 — 128kbps' },
    ].forEach(t => audioFormats.push({ ext: 'MP3', label: t.label, bitrate: t.bitrate, codec: 'LAME', quality: t.quality }));
  }

  return {
    id: d.id || videoId,
    title: d.title || 'Untitled',
    channel: d.channel?.name || d.author || '',
    duration: d.duration || 0,
    thumbnail: d.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audioFormats,
  };
}

// ── Download Stream (MP3 only) ─────────────────────────────
async function getDownloadStream(videoId, options = {}, cookiesContent) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  if (options.type !== 'mp3') throw new Error('Only MP3 downloads are supported');

  const quality = options.quality || '192k';
  const yt = await createClient(cookiesContent);
  const info = await yt.getInfo(videoId);

  // Pick best audio-only format and decipher its URL
  const formats = info.streaming_data?.adaptive_formats || [];
  const best = formats
    .filter(f => f.has_audio && !f.has_video)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  if (!best) throw new Error('No audio format found for this video');

  const url = best.decipher(yt.session.player);

  const ffmpeg = spawn(ffmpegPath, [
    '-i', url,
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', quality,
    '-f', 'mp3',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpeg.stderr.on('data', () => {});

  return {
    stream: ffmpeg.stdout,
    contentType: 'audio/mpeg',
    filename: 'audio.mp3',
  };
}

module.exports = { getVideoInfo, getDownloadStream };
