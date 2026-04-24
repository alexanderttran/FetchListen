/* ============================================================
   DownloadYes — YouTube Logic (youtubei.js)
   Pure JavaScript YouTube engine — no binary dependencies.
   ============================================================ */

const { Innertube } = require('youtubei.js');
const { Readable, PassThrough } = require('stream');
const { spawn } = require('child_process');

// Try to load ffmpeg-static for MP3 conversion
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
} catch {
  ffmpegPath = null;
  console.warn('[DownloadYes] ffmpeg-static not found — MP3 conversion disabled');
}

// ── InnerTube Client (cached + refreshed) ──────────────────
let _yt = null;
let _ytCreatedAt = 0;
const CLIENT_TTL = 30 * 60 * 1000; // 30 minutes

async function getClient() {
  const now = Date.now();
  if (!_yt || now - _ytCreatedAt > CLIENT_TTL) {
    _yt = await Innertube.create({
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
    id: basic.id || videoId,
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
        downloadUrl: `/api/download?v=${info.basic_info.id}&type=mp3&quality=${tier.quality}`,
      });
    });
  }

  // --- Native audio formats from YouTube ---
  const streaming = info.streaming_data;
  if (streaming && streaming.adaptive_formats) {
    const audioStreams = streaming.adaptive_formats.filter(
      (f) => f.has_audio && !f.has_video
    );
    // Sort by bitrate descending
    audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    // Deduplicate by codec + approximate bitrate
    const seen = new Set();
    audioStreams.forEach((f) => {
      const codec = parseAudioCodec(f);
      const br = f.bitrate ? Math.round(f.bitrate / 1000) : 0;
      const key = `${codec}-${br}`;
      if (seen.has(key)) return;
      seen.add(key);

      const ext = f.mime_type?.includes('mp4') ? 'M4A' : 'WEBM';
      audioFormats.push({
        ext,
        label: `${codec} — ${br}kbps`,
        bitrate: `${br} kbps`,
        codec,
        downloadUrl: `/api/download?v=${info.basic_info.id}&itag=${f.itag}`,
      });
    });
  }

  // --- Video formats ---
  if (streaming && streaming.adaptive_formats) {
    const videoStreams = streaming.adaptive_formats.filter(
      (f) => f.has_video && !f.has_audio
    );
    // Sort by height descending
    videoStreams.sort((a, b) => (b.height || 0) - (a.height || 0));

    const seenRes = new Set();
    videoStreams.forEach((f) => {
      const h = f.height;
      if (!h || seenRes.has(h)) return;
      seenRes.add(h);

      const codec = parseVideoCodec(f);
      const size = f.content_length ? formatSize(Number(f.content_length)) : '';
      const qualityTag =
        h >= 2160 ? '— 4K' : h >= 1440 ? '— QHD' : h >= 1080 ? '— HD' : '';

      videoFormats.push({
        ext: 'MP4',
        label: `${h}p ${qualityTag}`.trim(),
        size,
        codec,
        downloadUrl: `/api/download?v=${info.basic_info.id}&itag=${f.itag}`,
      });
    });
  }

  // --- Also add progressive (video+audio combined) formats ---
  if (streaming && streaming.formats) {
    const seenProgRes = new Set(videoFormats.map((v) => parseInt(v.label)));
    streaming.formats.forEach((f) => {
      const h = f.height;
      if (!h || seenProgRes.has(h)) return;
      seenProgRes.add(h);

      const codec = parseVideoCodec(f);
      const size = f.content_length ? formatSize(Number(f.content_length)) : '';

      videoFormats.push({
        ext: 'MP4',
        label: `${h}p`,
        size,
        codec: codec + ' + Audio',
        downloadUrl: `/api/download?v=${info.basic_info.id}&itag=${f.itag}`,
      });
    });

    // Re-sort by resolution
    videoFormats.sort((a, b) => {
      const aH = parseInt(a.label) || 0;
      const bH = parseInt(b.label) || 0;
      return bH - aH;
    });
  }

  return { audioFormats, videoFormats };
}

// ── Download Stream ────────────────────────────────────────
async function getDownloadStream(videoId, options = {}) {
  const yt = await getClient();
  const info = await yt.getInfo(videoId);

  // --- MP3 conversion path ---
  if (options.type === 'mp3') {
    if (!ffmpegPath) {
      throw new Error('MP3 conversion unavailable — ffmpeg not found');
    }

    const quality = options.quality || '192k';

    // Pick the best audio format
    const audioFormats = info.streaming_data?.adaptive_formats?.filter(
      (f) => f.has_audio && !f.has_video
    );
    if (!audioFormats || audioFormats.length === 0) {
      throw new Error('No audio streams available for this video');
    }
    audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const bestAudio = audioFormats[0];

    // Get the raw stream from YouTube
    const webStream = await info.download({ type: 'audio', quality: 'best' });
    const inputStream = webStreamToNode(webStream);

    // Pipe through FFmpeg for MP3 conversion
    const ffmpeg = spawn(ffmpegPath, [
      '-i', 'pipe:0',
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', quality,
      '-f', 'mp3',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    inputStream.pipe(ffmpeg.stdin);

    ffmpeg.stderr.on('data', () => {
      // Suppress FFmpeg progress output
    });

    ffmpeg.stdin.on('error', () => {
      // Ignore broken pipe errors (normal when client disconnects)
    });

    return {
      stream: ffmpeg.stdout,
      contentType: 'audio/mpeg',
      filename: `audio.mp3`,
    };
  }

  // --- Direct stream path (native formats via itag) ---
  const itag = parseInt(options.itag);
  if (isNaN(itag)) {
    throw new Error('Invalid itag');
  }

  // Find the format by itag
  const allFormats = [
    ...(info.streaming_data?.adaptive_formats || []),
    ...(info.streaming_data?.formats || []),
  ];
  const format = allFormats.find((f) => f.itag === itag);
  if (!format) {
    throw new Error(`Format with itag ${itag} not found`);
  }

  const webStream = await info.download({ format });
  const nodeStream = webStreamToNode(webStream);

  const contentInfo = getContentInfo(format);

  return {
    stream: nodeStream,
    contentType: contentInfo.mime,
    filename: contentInfo.filename,
  };
}

// ── Helpers ────────────────────────────────────────────────

function webStreamToNode(webStream) {
  // youtubei.js returns a Web ReadableStream; convert to Node stream
  if (webStream && typeof webStream.pipe === 'function') {
    return webStream; // Already a Node stream
  }
  return Readable.fromWeb(webStream);
}

function getContentInfo(format) {
  const isVideo = format.has_video;
  const mimeRaw = format.mime_type || '';

  if (isVideo) {
    const ext = mimeRaw.includes('webm') ? 'webm' : 'mp4';
    return {
      mime: mimeRaw.includes('webm') ? 'video/webm' : 'video/mp4',
      filename: `video.${ext}`,
    };
  }

  const ext = mimeRaw.includes('mp4') ? 'm4a' : 'webm';
  return {
    mime: mimeRaw.includes('mp4') ? 'audio/mp4' : 'audio/webm',
    filename: `audio.${ext}`,
  };
}

function parseAudioCodec(format) {
  const mime = format.mime_type || '';
  const codecMatch = mime.match(/codecs="([^"]+)"/);
  const codec = codecMatch ? codecMatch[1] : '';
  if (codec.startsWith('mp4a')) return 'AAC';
  if (codec.startsWith('opus')) return 'Opus';
  if (codec.startsWith('vorbis')) return 'Vorbis';
  return codec || 'Unknown';
}

function parseVideoCodec(format) {
  const mime = format.mime_type || '';
  const codecMatch = mime.match(/codecs="([^"]+)"/);
  const codec = codecMatch ? codecMatch[1] : '';
  if (codec.startsWith('avc1')) return 'H.264';
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 'VP9';
  if (codec.startsWith('av01')) return 'AV1';
  return codec.split('.')[0] || 'Unknown';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

module.exports = { getVideoInfo, getDownloadStream };
