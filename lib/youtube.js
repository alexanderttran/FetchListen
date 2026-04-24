/* ============================================================
   DownloadYes — YouTube Logic (youtube-dl-exec)
   Uses yt-dlp under the hood for rock-solid extraction, works on Vercel.
   ============================================================ */

const youtubedl = require('youtube-dl-exec');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');

// Try to load ffmpeg-static for MP3 conversion
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  // Attempt to ensure it's executable on Vercel
  try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
} catch {
  ffmpegPath = null;
  console.warn('[DownloadYes] ffmpeg-static not found — MP3 conversion disabled');
}

// Attempt to ensure yt-dlp is executable on Vercel
try {
  const ytdlpPath = require('path').join(__dirname, '..', 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
  if (fs.existsSync(ytdlpPath)) fs.chmodSync(ytdlpPath, 0o755);
} catch (e) {}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId) {
  const info = await youtubedl(videoId, {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    preferFreeFormats: true,
    youtubeSkipDashManifest: true
  });
  
  const audioFormats = [];
  const videoFormats = [];

  // --- Synthetic MP3 entries (only if ffmpeg is available) ---
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

  const formats = info.formats || [];

  // --- Native audio formats ---
  const audioStreams = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none');
  audioStreams.sort((a, b) => (b.abr || 0) - (a.abr || 0));

  const seenAudio = new Set();
  audioStreams.forEach((f) => {
    const codec = f.acodec ? f.acodec.split('.')[0].toUpperCase() : 'UNKNOWN';
    const br = f.abr ? Math.round(f.abr) : 0;
    const key = `${codec}-${br}`;
    if (seenAudio.has(key)) return;
    seenAudio.add(key);

    audioFormats.push({
      ext: f.ext ? f.ext.toUpperCase() : 'M4A',
      label: `${codec} — ${br}kbps`,
      bitrate: `${br} kbps`,
      codec,
      downloadUrl: `/api/download?v=${videoId}&itag=${f.format_id}`,
    });
  });

  // --- Video formats (Video Only) ---
  const videoStreams = formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none' && f.height);
  videoStreams.sort((a, b) => (b.height || 0) - (a.height || 0));

  const seenRes = new Set();
  videoStreams.forEach((f) => {
    const h = f.height;
    if (!h || seenRes.has(h)) return;
    seenRes.add(h);

    const codec = f.vcodec ? f.vcodec.split('.')[0].toUpperCase() : 'UNKNOWN';
    const size = f.filesize ? formatSize(f.filesize) : (f.filesize_approx ? formatSize(f.filesize_approx) : '');
    const qualityTag = h >= 2160 ? '— 4K' : h >= 1440 ? '— QHD' : h >= 1080 ? '— HD' : '';

    videoFormats.push({
      ext: f.ext ? f.ext.toUpperCase() : 'MP4',
      label: `${h}p ${qualityTag}`.trim(),
      size,
      codec,
      downloadUrl: `/api/download?v=${videoId}&itag=${f.format_id}`,
    });
  });

  // --- Video formats (Video + Audio combined) ---
  const mixedStreams = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.height);
  const seenMixedRes = new Set(videoFormats.map((v) => parseInt(v.label)));
  
  mixedStreams.forEach((f) => {
    const h = f.height;
    if (!h || seenMixedRes.has(h)) return;
    seenMixedRes.add(h);

    const codec = f.vcodec ? f.vcodec.split('.')[0].toUpperCase() : 'UNKNOWN';
    const size = f.filesize ? formatSize(f.filesize) : (f.filesize_approx ? formatSize(f.filesize_approx) : '');

    videoFormats.push({
      ext: f.ext ? f.ext.toUpperCase() : 'MP4',
      label: `${h}p`,
      size,
      codec: codec + ' + Audio',
      downloadUrl: `/api/download?v=${videoId}&itag=${f.format_id}`,
    });
  });

  videoFormats.sort((a, b) => parseInt(b.label || 0) - parseInt(a.label || 0));

  return {
    id: info.id || videoId,
    title: info.title || 'Untitled',
    channel: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audioFormats,
    videoFormats,
  };
}

// ── Download Stream ────────────────────────────────────────
async function getDownloadStream(videoId, options = {}) {
  // Use youtube-dl-exec to stream the download
  if (options.type === 'mp3') {
    if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
    const quality = options.quality || '192k';

    // Best audio format
    const ytdlProcess = youtubedl.exec(videoId, {
      f: 'bestaudio/best',
      o: '-', // stream to stdout
      noWarnings: true
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

  // --- Direct stream path ---
  const itag = options.itag;
  if (!itag) throw new Error('Invalid itag');

  const info = await youtubedl(videoId, { dumpSingleJson: true, noWarnings: true });
  const format = info.formats.find(f => f.format_id === itag);
  if (!format) throw new Error(`Format ${itag} not found`);

  const ytdlProcess = youtubedl.exec(videoId, {
    f: itag,
    o: '-',
    noWarnings: true
  });

  const isVideo = format.vcodec !== 'none';
  const ext = format.ext || (isVideo ? 'mp4' : 'm4a');
  const contentType = isVideo ? `video/${ext}` : `audio/${ext}`;

  return {
    stream: ytdlProcess.stdout,
    contentType,
    filename: `${isVideo ? 'video' : 'audio'}.${ext}`,
  };
}

// ── Helpers ────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

module.exports = { getVideoInfo, getDownloadStream };
