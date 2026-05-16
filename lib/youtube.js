/* ============================================================
   DownloadYes — YouTube Logic (youtube-dl-exec)
   MP3 download only.
   ============================================================ */

const youtubedl = require('youtube-dl-exec');
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

// Ensure yt-dlp is executable
try {
  const ytdlpPath = path.join(__dirname, '..', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
  if (fs.existsSync(ytdlpPath)) fs.chmodSync(ytdlpPath, 0o755);
} catch (e) {}

// ── Cookie Helper ──────────────────────────────────────────
// Priority: caller-supplied content > YOUTUBE_COOKIES env var > nothing.
function resolveCookiesFile(cookiesContent) {
  const content = cookiesContent || process.env.YOUTUBE_COOKIES || null;
  if (!content) return null;

  const tmpFile = path.join(os.tmpdir(), 'yt_cookies.txt');
  try {
    fs.writeFileSync(tmpFile, content, 'utf-8');
    return tmpFile;
  } catch (e) {
    console.warn('[DownloadYes] Failed to write cookies file:', e.message);
    return null;
  }
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId, cookiesContent) {
  const cookiesFile = resolveCookiesFile(cookiesContent);

  const ytdlOptions = {
    dumpSingleJson: true,
    noWarnings: true,
  };
  if (cookiesFile) ytdlOptions.cookies = cookiesFile;

  const info = await youtubedl(videoId, ytdlOptions);

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
async function getDownloadStream(videoId, options = {}, cookiesContent) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  if (options.type !== 'mp3') throw new Error('Only MP3 downloads are supported');

  const cookiesFile = resolveCookiesFile(cookiesContent);
  const quality = options.quality || '192k';

  // Step 1: Fetch the full format list — same call that already works in /api/info.
  // This sidesteps the broken download-phase format selector entirely.
  const infoOpts = { dumpSingleJson: true, noWarnings: true };
  if (cookiesFile) infoOpts.cookies = cookiesFile;

  const info = await youtubedl(videoId, infoOpts);
  const formats = info.formats || [];

  // Step 2: Find the best audio-only format by bitrate.
  const audioOnly = formats
    .filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url)
    .sort((a, b) => (b.abr || 0) - (a.abr || 0));

  // Fall back to best overall format if no audio-only stream exists.
  const best = audioOnly[0] || formats.filter(f => f.url).pop();
  if (!best || !best.url) throw new Error('No downloadable audio format found for this video');

  // Step 3: Build HTTP headers from the format object (yt-dlp pre-computes these).
  const httpHeaders = best.http_headers || {};
  const headerArgs = Object.entries(httpHeaders).flatMap(([k, v]) => [
    '-headers', `${k}: ${v}\r\n`,
  ]);

  // Step 4: Pipe the direct stream URL through ffmpeg → MP3.
  const ffmpeg = spawn(ffmpegPath, [
    ...headerArgs,
    '-i', best.url,
    '-vn',
    '-acodec', 'libmp3lame',
    '-b:a', quality,
    '-f', 'mp3',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpeg.stderr.on('data', () => {}); // Suppress ffmpeg progress noise
  ffmpeg.stdin.on('error', () => {});

  return {
    stream: ffmpeg.stdout,
    contentType: 'audio/mpeg',
    filename: 'audio.mp3',
  };
}

module.exports = { getVideoInfo, getDownloadStream };
