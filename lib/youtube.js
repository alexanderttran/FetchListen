/* ============================================================
   FetchListen — YouTube Logic
   Uses youtube-dl-exec (yt-dlp) for robust stream and metadata extraction.
   ============================================================ */

const youtubeDl = require('youtube-dl-exec');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
// Writes cookies to a temporary file for yt-dlp to read
function getTempCookiesFile(cookiesContent) {
  const raw = cookiesContent || process.env.YOUTUBE_COOKIES || null;
  if (!raw) return null;
  
  const tempDir = os.tmpdir();
  const filename = `cookies-${crypto.randomBytes(8).toString('hex')}.txt`;
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, raw, 'utf8');
  return filePath;
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId, cookiesContent) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookiesFile = getTempCookiesFile(cookiesContent);
  
  try {
    const opts = { dumpJson: true };
    if (cookiesFile) {
      opts.cookies = cookiesFile;
    }
    
    const metadata = await youtubeDl(videoUrl, opts);
    
    const audioFormats = [];
    if (ffmpegPath) {
      [
        { bitrate: '320 kbps', quality: '320k', label: 'MP3 — 320kbps' },
        { bitrate: '192 kbps', quality: '192k', label: 'MP3 — 192kbps' },
        { bitrate: '128 kbps', quality: '128k', label: 'MP3 — 128kbps' },
      ].forEach(t => audioFormats.push({ ext: 'MP3', label: t.label, bitrate: t.bitrate, codec: 'LAME', quality: t.quality }));
    }

    return {
      id: metadata.id || videoId,
      title: metadata.title || 'Untitled',
      channel: metadata.uploader || metadata.channel || '',
      duration: metadata.duration || 0,
      thumbnail: metadata.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      audioFormats,
    };
  } finally {
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      try { fs.unlinkSync(cookiesFile); } catch (e) {}
    }
  }
}

// ── Download Stream (MP3 only) ─────────────────────────────
async function getDownloadStream(videoId, options = {}, cookiesContent) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  if (options.type !== 'mp3') throw new Error('Only MP3 downloads are supported');

  const quality = options.quality || '192k';
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookiesFile = getTempCookiesFile(cookiesContent);

  let streamUrl;
  try {
    const opts = { getUrl: true, format: 'bestaudio' };
    if (cookiesFile) {
      opts.cookies = cookiesFile;
    }
    streamUrl = await youtubeDl(videoUrl, opts);
    if (streamUrl) {
      streamUrl = streamUrl.trim();
    }
  } finally {
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      try { fs.unlinkSync(cookiesFile); } catch (e) {}
    }
  }

  if (!streamUrl) throw new Error('Failed to resolve stream URL for this video');

  const ffmpeg = spawn(ffmpegPath, [
    '-i', streamUrl,
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
