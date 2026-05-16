/* ============================================================
   DownloadYes — YouTube Logic (youtube-dl-exec)
   MP3 download only.
   ============================================================ */

const youtubedl = require('youtube-dl-exec');
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

  // Use yt-dlp's built-in audio extraction — avoids fragile format selectors.
  // yt-dlp picks the best available audio format automatically, then invokes
  // ffmpeg internally to convert to MP3 and streams the result to stdout.
  const ytdlOptions = {
    extractAudio: true,
    audioFormat: 'mp3',
    audioQuality: quality,       // e.g. '192k', '320k', '128k'
    ffmpegLocation: path.dirname(ffmpegPath),
    o: '-',                      // stream to stdout
    noWarnings: true,
  };
  if (cookiesFile) ytdlOptions.cookies = cookiesFile;

  const ytdlProcess = youtubedl.exec(videoId, ytdlOptions);

  // Suppress stderr noise from yt-dlp/ffmpeg
  ytdlProcess.stderr && ytdlProcess.stderr.on('data', () => {});

  return {
    stream: ytdlProcess.stdout,
    contentType: 'audio/mpeg',
    filename: 'audio.mp3',
  };
}

module.exports = { getVideoInfo, getDownloadStream };
