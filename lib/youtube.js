/* ============================================================
   DownloadYes — YouTube Logic
   Uses @distube/ytdl-core (pure Node.js, no binary needed)
   + ffmpeg-static for MP3 conversion.
   ============================================================ */

const ytdl = require('@distube/ytdl-core');
const { spawn } = require('child_process');
const fs = require('fs');

// Try to load ffmpeg-static for MP3 conversion
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
} catch {
  ffmpegPath = null;
  console.warn('[DownloadYes] ffmpeg-static not found — MP3 conversion disabled');
}

// Use mobile clients — they bypass datacenter IP bot detection
// because they use a different API endpoint with no BotGuard challenge.
const PLAYER_CLIENTS = ['ANDROID', 'IOS'];

// ── Cookie Parser ──────────────────────────────────────────
// Converts Netscape-format cookies.txt → ytdl-core cookie array.
function parseCookies(cookiesContent) {
  const raw = cookiesContent || process.env.YOUTUBE_COOKIES || null;
  if (!raw) return [];

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const parts = line.split('\t');
      if (parts.length < 7) return null;
      return { name: parts[5], value: parts[6] };
    })
    .filter(Boolean);
}

function buildAgent(cookiesContent) {
  const cookies = parseCookies(cookiesContent);
  return ytdl.createAgent(cookies.length ? cookies : undefined);
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId, cookiesContent) {
  const agent = buildAgent(cookiesContent);

  const info = await ytdl.getInfo(videoId, {
    agent,
    playerClients: PLAYER_CLIENTS,
  });

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
    thumbnail:
      details.thumbnails?.slice(-1)[0]?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audioFormats,
  };
}

// ── Download Stream (MP3 only) ─────────────────────────────
async function getDownloadStream(videoId, options = {}, cookiesContent) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  if (options.type !== 'mp3') throw new Error('Only MP3 downloads are supported');

  const quality = options.quality || '192k';
  const agent = buildAgent(cookiesContent);

  const audioStream = ytdl(videoId, {
    filter: 'audioonly',
    quality: 'highestaudio',
    agent,
    playerClients: PLAYER_CLIENTS,
  });

  const ffmpeg = spawn(ffmpegPath, [
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', quality,
    '-f', 'mp3',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  audioStream.pipe(ffmpeg.stdin);

  ffmpeg.stderr.on('data', () => {});
  ffmpeg.stdin.on('error', () => {});
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
