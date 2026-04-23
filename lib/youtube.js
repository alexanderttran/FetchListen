/* ============================================================
   DownloadYes — YouTube Logic (youtubei.js)
   Pure JavaScript YouTube engine — no binary dependencies.
   ============================================================ */

const { Innertube } = require('youtubei.js');
const { Readable, PassThrough } = require('stream');
const { spawn } = require('child_process');
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch {
  ffmpegPath = null;
}

// ── Singleton Innertube client ─────────────────────────────
let _yt = null;
let _ytCreatedAt = 0;
const CLIENT_TTL = 30 * 60 * 1000; // Refresh client every 30 min

async function getClient() {
  const now = Date.now();
  if (!_yt || now - _ytCreatedAt > CLIENT_TTL) {
    _yt = await Innertube.create({
      lang: 'en',
      location: 'US',
      retrieve_player: true,
    });
    _ytCreatedAt = now;
  }
  return _yt;
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId) {
  const yt = await getClient();
  const info = await yt.getInfo(videoId);
  const basic = info.basic_info;
  const { audioFormats, videoFormats } = buildFormats(info);

  return {
    id: basic.id,
    title: basic.title || 'Untitled',
    channel: basic.channel?.name || basic.author || '',
    duration: basic.duration || 0,
    thumbnail:
      (basic.thumbnail && basic.thumbnail[0] && basic.thumbnail[0].url) ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audioFormats,
    videoFormats,
  };
}

// ── Build Format Lists ─────────────────────────────────────
function buildFormats(info) {
  const audioFormats = [];
  const videoFormats = [];

  const sd = info.streaming_data;
  if (!sd) return { audioFormats, videoFormats };

  const adaptive = sd.adaptive_formats || [];
  const muxed = sd.formats || [];

  // ── Audio ────────────────────────────────────────────────
  const audioStreams = adaptive.filter(
    (f) => f.has_audio && !f.has_video
  );

  for (const f of audioStreams) {
    const container = extractContainer(f.mime_type, 'audio');
    const codec = extractCodecLabel(f.mime_type);
    const bitrateKbps = Math.round((f.bitrate || 0) / 1000);
    const size = f.content_length
      ? formatSize(Number(f.content_length))
      : '';

    let extLabel = container.toUpperCase();
    if (container === 'mp4') extLabel = 'M4A';

    audioFormats.push({
      itag: f.itag,
      ext: extLabel,
      label: `${codec} — ${bitrateKbps}kbps`,
      bitrate: `${bitrateKbps} kbps`,
      codec,
      size,
      downloadUrl: `/api/download?v=${info.basic_info.id}&itag=${f.itag}`,
    });
  }

  // Sort audio by bitrate descending
  audioFormats.sort(
    (a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0)
  );

  // ── Synthetic MP3 options (converted server-side via ffmpeg) ──
  if (ffmpegPath) {
    const mp3Options = [
      { quality: '320', label: 'MP3 — 320kbps', bitrate: '320 kbps' },
      { quality: '192', label: 'MP3 — 192kbps', bitrate: '192 kbps' },
      { quality: '128', label: 'MP3 — 128kbps', bitrate: '128 kbps' },
    ];
    const mp3Entries = mp3Options.map((opt) => ({
      ext: 'MP3',
      label: opt.label,
      bitrate: opt.bitrate,
      codec: 'LAME',
      size: '',
      downloadUrl: `/api/download?v=${info.basic_info.id}&type=mp3&quality=${opt.quality}`,
    }));
    audioFormats.unshift(...mp3Entries);
  }

  // ── Video ────────────────────────────────────────────────
  const seenHeights = new Set();

  // Adaptive video-only (higher quality, will be muxed with audio)
  const videoStreams = adaptive
    .filter((f) => f.has_video && !f.has_audio)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  for (const f of videoStreams) {
    const h = f.height;
    if (!h || seenHeights.has(h)) continue;
    seenHeights.add(h);

    const codec = extractCodecLabel(f.mime_type);
    const size = f.content_length
      ? formatSize(Number(f.content_length))
      : '';

    let tag = '';
    if (h >= 2160) tag = ' — 4K';
    else if (h >= 1440) tag = ' — QHD';
    else if (h >= 1080) tag = ' — HD';

    videoFormats.push({
      height: h,
      ext: 'MP4',
      label: `${h}p${tag}`,
      size,
      codec,
      downloadUrl: `/api/download?v=${info.basic_info.id}&type=video&quality=${h}`,
    });
  }

  // Pre-muxed fallbacks (360p, 720p)
  for (const f of muxed) {
    const h = f.height;
    if (!h || seenHeights.has(h)) continue;
    seenHeights.add(h);

    const size = f.content_length
      ? formatSize(Number(f.content_length))
      : '';

    videoFormats.push({
      height: h,
      ext: 'MP4',
      label: `${h}p`,
      size,
      codec: 'H.264',
      downloadUrl: `/api/download?v=${info.basic_info.id}&itag=${f.itag}`,
    });
  }

  // Sort video by height descending
  videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

  return { audioFormats, videoFormats };
}

// ── Download Stream ────────────────────────────────────────
// Always returns a Node.js Readable stream (handles Web→Node conversion internally)
async function getDownloadStream(videoId, options = {}) {
  const yt = await getClient();
  const info = await yt.getInfo(videoId);

  // Determine content info for headers
  const contentInfo = getContentInfo(info, options);

  // ── MP3 conversion path ──────────────────────────────────
  if (options.type === 'mp3') {
    if (!ffmpegPath) {
      throw new Error('MP3 conversion unavailable — ffmpeg not found');
    }

    const webStream = await info.download({ type: 'audio', quality: 'best' });
    const audioNode = Readable.fromWeb(webStream);
    const bitrate = options.quality || '192';

    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-vn',
      '-codec:a', 'libmp3lame',
      '-b:a', `${bitrate}k`,
      '-f', 'mp3',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });

    audioNode.pipe(ffmpeg.stdin);
    audioNode.on('error', () => ffmpeg.stdin.destroy());
    ffmpeg.stdin.on('error', () => {});

    return { stream: ffmpeg.stdout, contentInfo };
  }

  // ── Standard download path ───────────────────────────────
  let downloadOpts = {};

  if (options.itag) {
    const allFormats = [
      ...(info.streaming_data?.formats || []),
      ...(info.streaming_data?.adaptive_formats || []),
    ];
    const target = allFormats.find(
      (f) => String(f.itag) === String(options.itag)
    );

    if (!target) {
      throw new Error(`Format itag ${options.itag} not found`);
    }

    if (target.has_audio && !target.has_video) {
      downloadOpts.type = 'audio';
      downloadOpts.quality = 'best';
    } else {
      downloadOpts.type = 'video+audio';
      downloadOpts.quality = 'best';
    }
  } else if (options.type === 'video') {
    downloadOpts.type = 'video+audio';
    downloadOpts.quality = options.quality || 'best';
    downloadOpts.format = 'mp4';
  } else if (options.type === 'audio') {
    downloadOpts.type = 'audio';
    downloadOpts.quality = 'best';
  } else {
    downloadOpts.type = 'video+audio';
    downloadOpts.quality = 'best';
  }

  const webStream = await info.download(downloadOpts);
  const nodeStream = Readable.fromWeb(webStream);

  return { stream: nodeStream, contentInfo };
}

// ── Content Info for Headers ───────────────────────────────
function getContentInfo(info, options) {
  const allFormats = [
    ...(info.streaming_data?.formats || []),
    ...(info.streaming_data?.adaptive_formats || []),
  ];

  let mimeType = 'application/octet-stream';
  let ext = 'mp4';

  if (options.itag) {
    const target = allFormats.find(
      (f) => String(f.itag) === String(options.itag)
    );
    if (target) {
      const rawMime = target.mime_type || '';
      mimeType = rawMime.split(';')[0].trim() || mimeType;
      const container = extractContainer(rawMime, target.has_video ? 'video' : 'audio');
      if (target.has_audio && !target.has_video) {
        ext = container === 'mp4' ? 'm4a' : container;
      } else {
        ext = container;
      }
    }
  } else if (options.type === 'mp3') {
    mimeType = 'audio/mpeg';
    ext = 'mp3';
  } else if (options.type === 'video') {
    mimeType = 'video/mp4';
    ext = 'mp4';
  } else if (options.type === 'audio') {
    mimeType = 'audio/mp4';
    ext = 'm4a';
  }

  const safeTitle = (info.basic_info.title || 'download')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .slice(0, 100);

  return { mimeType, ext, filename: `${safeTitle}.${ext}` };
}

// ── Helpers ────────────────────────────────────────────────
function extractContainer(mimeType, kind) {
  const re = kind === 'audio' ? /audio\/(\w+)/ : /video\/(\w+)/;
  const m = (mimeType || '').match(re);
  return m ? m[1] : 'mp4';
}

function extractCodecLabel(mimeType) {
  const m = (mimeType || '').match(/codecs="([^"]+)"/);
  if (!m) return '';
  const raw = m[1].split('.')[0];
  if (raw.startsWith('mp4a')) return 'AAC';
  if (raw === 'opus') return 'Opus';
  if (raw === 'vorbis') return 'Vorbis';
  if (raw.startsWith('avc')) return 'H.264';
  if (raw.startsWith('vp9') || raw.startsWith('vp09')) return 'VP9';
  if (raw.startsWith('av01')) return 'AV1';
  return raw;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

module.exports = { getVideoInfo, getDownloadStream, getClient };
