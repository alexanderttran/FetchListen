/* ============================================================
   DownloadYes — YouTube Logic (youtube-dl-exec)
   MP3 download only.
   ============================================================ */

const youtubedl = require('youtube-dl-exec');
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

// Ensure yt-dlp is executable
try {
  const ytdlpPath = require('path').join(__dirname, '..', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
  if (fs.existsSync(ytdlpPath)) fs.chmodSync(ytdlpPath, 0o755);
} catch (e) {}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId) {
  const info = await youtubedl(videoId, {
    dumpSingleJson: true,
    noWarnings: true,
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
        downloadUrl: `/api/download?v=${videoId}&type=mp3&quality=${tier.quality}`,
      });
    });
  }

  return {
    id: info.id || videoId,
    title: info.title || 'Untitled',
    channel: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audioFormats,
  };
}

// ── Download Stream (MP3 only) ─────────────────────────────
async function getDownloadStream(videoId, options = {}) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  if (options.type !== 'mp3') throw new Error('Only MP3 downloads are supported');

  const quality = options.quality || '192k';

  const ytdlProcess = youtubedl.exec(videoId, {
    f: 'bestaudio/best',
    o: '-',
    noWarnings: true,
  });

  const ffmpeg = spawn(ffmpegPath, [
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', quality,
    '-f', 'mp3',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ytdlProcess.stdout.pipe(ffmpeg.stdin);

  ffmpeg.stderr.on('data', () => {}); // Suppress
  ffmpeg.stdin.on('error', () => {}); // Ignore broken pipe

  return {
    stream: ffmpeg.stdout,
    contentType: 'audio/mpeg',
    filename: `audio.mp3`,
  };
}

module.exports = { getVideoInfo, getDownloadStream };
