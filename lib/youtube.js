/* ============================================================
   FetchListen — YouTube Logic
   Uses youtubei.js + ffmpeg-static for pure JS deciphering and streaming.
   ============================================================ */

const { spawn } = require('child_process');
const fs = require('fs');

// ffmpeg-static
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
} catch (e) {
  ffmpegPath = null;
  console.warn('[FetchListen] ffmpeg-static not found');
}

// Cached Innertube instance helper to speed up subsequent requests
let cachedYt = null;

async function getInnertube(cookiesContent) {
  const { Innertube, UniversalCache, Platform } = await import('youtubei.js');
  
  // Custom Platform shim evaluation using Function constructor to solve ciphers in pure JS
  Platform.shim.eval = async (data) => {
    return new Function(data.output)();
  };

  const cookie = cookiesContent || process.env.YOUTUBE_COOKIES || '';

  // If custom cookies are supplied, we create a fresh session for privacy/bot bypass
  if (cookie) {
    return await Innertube.create({
      cookie,
      generate_session_locally: true,
      retrieve_player: true,
      cache: new UniversalCache(false),
    });
  }

  // Otherwise, reuse the cached default session
  if (!cachedYt) {
    cachedYt = await Innertube.create({
      generate_session_locally: true,
      retrieve_player: true,
      cache: new UniversalCache(false),
    });
  }
  return cachedYt;
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId, cookiesContent) {
  try {
    const yt = await getInnertube(cookiesContent);
    const details = await yt.getInfo(videoId);
    const basic = details.basic_info;

    // Check if progressive format (itag 18) is available
    const formats = details.streaming_data?.formats || [];
    const itag18 = formats.find(f => f.itag === 18);
    if (!itag18) {
      throw new Error('This video does not support progressive playback (itag 18 missing).');
    }

    // Configured output MP3 profiles we support
    const audioFormats = [];
    if (ffmpegPath) {
      [
        { bitrate: '320 kbps', quality: '320k', label: 'MP3 — 320kbps' },
        { bitrate: '192 kbps', quality: '192k', label: 'MP3 — 192kbps' },
        { bitrate: '128 kbps', quality: '128k', label: 'MP3 — 128kbps' },
      ].forEach(t => audioFormats.push({ ext: 'MP3', label: t.label, bitrate: t.bitrate, codec: 'LAME', quality: t.quality }));
    }

    let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    if (basic.thumbnail && basic.thumbnail.length > 0) {
      thumbnail = basic.thumbnail[basic.thumbnail.length - 1].url;
    }

    return {
      id: basic.id || videoId,
      title: basic.title || 'Untitled',
      channel: basic.author || (basic.channel && basic.channel.name) || '',
      duration: basic.duration || 0,
      thumbnail,
      audioFormats,
    };
  } catch (err) {
    console.error('[getVideoInfo] Failed:', err.message);
    throw new Error(`Failed to retrieve video metadata: ${err.message}`);
  }
}

// ── Download Stream (Transcoded MP3) ───────────────────────
async function getDownloadStream(videoId, options = {}, cookiesContent) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  if (options.type !== 'mp3') throw new Error('Only MP3 downloads are supported');

  const quality = options.quality || '192k';

  try {
    const yt = await getInnertube(cookiesContent);
    const details = await yt.getInfo(videoId);
    const formats = details.streaming_data?.formats || [];
    const itag18 = formats.find(f => f.itag === 18);

    if (!itag18) {
      throw new Error('This video does not support progressive playback (itag 18 missing).');
    }

    // Decipher the ciphered URL
    const streamUrl = await itag18.decipher(yt.session.player);
    if (!streamUrl) {
      throw new Error('Could not decipher progressive format stream URL.');
    }

    // Spawn ffmpeg process to transcode the progressive MP4 stream to MP3 on-the-fly
    const ffmpeg = spawn(ffmpegPath, [
      '-i', streamUrl,
      '-vn',                   // disable video recording/processing
      '-acodec', 'libmp3lame', // convert audio to MP3 using LAME encoder
      '-b:a', quality,         // set audio bitrate (e.g. 128k, 192k, 320k)
      '-f', 'mp3',             // output format mp3
      'pipe:1',                // write to stdout
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Silence stderr output to prevent buffer overflow and server noise
    ffmpeg.stderr.on('data', () => {});

    // Clean title for filename header
    const cleanTitle = (details.basic_info.title || 'audio')
      .replace(/[\\/:*?"<>|]/g, '')
      .substring(0, 100);

    return {
      stream: ffmpeg.stdout,
      contentType: 'audio/mpeg',
      filename: `${cleanTitle}.mp3`,
    };
  } catch (err) {
    console.error('[getDownloadStream] Failed:', err.message);
    throw new Error(`Failed to stream video audio: ${err.message}`);
  }
}

module.exports = { getVideoInfo, getDownloadStream };
