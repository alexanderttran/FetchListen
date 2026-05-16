/* ============================================================
   DownloadYes — YouTube Logic
   Uses @distube/ytdl-core (pure Node.js, no binary needed)
   + ffmpeg-static for MP3 conversion.
   ============================================================ */

const ytdl = require('@distube/ytdl-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Try to load ffmpeg-static for MP3 conversion
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
} catch {
  ffmpegPath = null;
  console.warn('[DownloadYes] ffmpeg-static not found — MP3 conversion disabled');
}

// ── Cookie Helper ──────────────────────────────────────────
// Converts Netscape cookie string → ytdl-core cookie array.
function parseCookies(cookiesContent) {
  const raw = cookiesContent || process.env.YOUTUBE_COOKIES || null;
  if (!raw) return [];

  const cookies = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    cookies.push({ name: parts[5], value: parts[6] });
  }
  return cookies;
}

// ── Agent Builder ──────────────────────────────────────────
function buildAgent(cookiesContent) {
  const cookies = parseCookies(cookiesContent);
  if (cookies.length === 0) return ytdl.createAgent();
  return ytdl.createAgent(cookies);
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId, cookiesContent) {
  const agent = buildAgent(cookiesContent);

  const info = await ytdl.getInfo(videoId, { agent });

  const audioFormats = [];

  if (ffmpegPath) {
    const mp3Tiers = [
      { bitrate: '320 kbps', quality: '320k', label: 'MP3 — 320kbps' },
      { bitrate: '192 kbps', quality: '192k', label: 'MP3 — 192kbps' },
      { bitrate: '128 kbps', quality: '128k', label: 'MP3 — 128kbps' },
    ];
    mp3Tiers.forEach((tier) => {
      audioFormats.push({
        ext: 'MP3',
        label: tier.label,
        bitrate: tier.bitrate,
        codec: 'LAME',
        quality: tier.quality,
      });
    });
  }

  const details = info.videoDetails;
  return {
    id: details.videoId || videoId,
    title: details.title || 'Untitled',
    channel: details.author?.name || '',
    duration: parseInt(details.lengthSeconds || '0', 10),
    thumbnail: details.thumbnails?.slice(-1)[0]?.url
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audioFormats,
  };
}

// ── Download Stream (MP3 only) ─────────────────────────────
async function getDownloadStream(videoId, options = {}, cookiesContent) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  if (options.type !== 'mp3') throw new Error('Only MP3 downloads are supported');

  const quality = options.quality || '192k';
  const agent = buildAgent(cookiesContent);

  // Get the best audio-only stream from ytdl-core
  const audioStream = ytdl(videoId, {
    filter: 'audioonly',
    quality: 'highestaudio',
    agent,
  });

  // Pipe through ffmpeg for MP3 conversion
  const ffmpeg = spawn(ffmpegPath, [
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', quality,
    '-f', 'mp3',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  audioStream.pipe(ffmpeg.stdin);

  ffmpeg.stderr.on('data', () => {}); // Suppress ffmpeg noise
  ffmpeg.stdin.on('error', () => {}); // Ignore broken pipe

  audioStream.on('error', (err) => {
    console.error('[ytdl] Stream error:', err.message);
    ffmpeg.stdin.destroy();
  });

  return {
    stream: ffmpeg.stdout,
    contentType: 'audio/mpeg',
    filename: 'audio.mp3',
  };
}

module.exports = { getVideoInfo, getDownloadStream };
