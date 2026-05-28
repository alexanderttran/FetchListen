/* ============================================================
   FetchListen — YouTube Logic
   Uses youtubei.js + ffmpeg-static for pure JS deciphering.
   ============================================================ */

const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

// ffmpeg-static
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
} catch (e) {
  ffmpegPath = null;
  console.warn('[FetchListen] ffmpeg-static not found');
}

// Helper to parse Netscape cookie file content and convert to standard HTTP Cookie header
function parseCookies(cookieInput) {
  if (!cookieInput) return '';
  const content = cookieInput.trim();
  
  if (content.startsWith('#') || content.includes('\t')) {
    const lines = content.split(/\r?\n/);
    const parsed = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        const name = parts[5];
        const value = parts[6];
        parsed.push(`${name}=${value}`);
      }
    }
    return parsed.join('; ');
  }
  
  return content;
}

// Cached Innertube instance helper to speed up subsequent requests
let cachedYt = null;

async function getInnertube(cookiesContent) {
  const { Innertube, UniversalCache, Platform } = await import('youtubei.js');
  
  Platform.shim.eval = async (data) => {
    return new Function(data.output)();
  };

  const rawCookie = cookiesContent || process.env.YOUTUBE_COOKIES || '';
  const cookie = parseCookies(rawCookie);

  if (cookie) {
    return await Innertube.create({
      cookie,
      generate_session_locally: true,
      retrieve_player: true,
      cache: new UniversalCache(false),
    });
  }

  if (!cachedYt) {
    cachedYt = await Innertube.create({
      generate_session_locally: true,
      retrieve_player: true,
      cache: new UniversalCache(false),
    });
  }
  return cachedYt;
}

// ── Pick best available audio format ──────────────────────
// Priority: itag 18 (progressive MP4) → 140 (M4A AAC) → 251 (Opus) → any audio-only
function getBestAudioFormat(streamingData) {
  const formats         = streamingData?.formats          || [];
  const adaptiveFormats = streamingData?.adaptive_formats || [];

  // 1. Prefer itag 18 (progressive — easiest, no muxing needed)
  const itag18 = formats.find(f => f.itag === 18);
  if (itag18) return { format: itag18, itag: 18, mimeType: 'audio/mp4' };

  // 2. itag 140 — M4A AAC 128kbps (very widely available)
  const itag140 = adaptiveFormats.find(f => f.itag === 140);
  if (itag140) return { format: itag140, itag: 140, mimeType: 'audio/mp4' };

  // 3. itag 251 — Opus WebM ~160kbps
  const itag251 = adaptiveFormats.find(f => f.itag === 251);
  if (itag251) return { format: itag251, itag: 251, mimeType: 'audio/webm' };

  // 4. Any audio-only adaptive format
  const anyAudio = adaptiveFormats.find(f => f.has_audio && !f.has_video);
  if (anyAudio) {
    const mime = anyAudio.mime_type?.includes('webm') ? 'audio/webm' : 'audio/mp4';
    return { format: anyAudio, itag: anyAudio.itag, mimeType: mime };
  }

  return null;
}

// ── Get Video Info ─────────────────────────────────────────
async function getVideoInfo(videoId, cookiesContent, req) {
  let finalCookies = cookiesContent;
  if (!finalCookies && req && req.headers && req.headers.cookie) {
    const match = req.headers.cookie.match(/yt_cookies=([^;]+)/);
    if (match) {
      finalCookies = decodeURIComponent(match[1]);
    }
  }
  try {
    const yt = await getInnertube(finalCookies);
    const details = await yt.getInfo(videoId);
    const basic = details.basic_info;

    const best = getBestAudioFormat(details.streaming_data);
    if (!best) {
      throw new Error('No playable audio format found for this video.');
    }

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

// ── Raw Audio Stream (no transcoding) ──────────────────────
// Proxies the raw itag 18 MP4 stream to the HTTP response.
// Supports Range requests for seek functionality.
async function getAudioStream(videoId, cookiesContent, req, res) {
  let finalCookies = cookiesContent;
  if (!finalCookies && req && req.headers && req.headers.cookie) {
    const match = req.headers.cookie.match(/yt_cookies=([^;]+)/);
    if (match) {
      finalCookies = decodeURIComponent(match[1]);
    }
  }

  const yt = await getInnertube(finalCookies);
  const details = await yt.getInfo(videoId);

  const best = getBestAudioFormat(details.streaming_data);
  if (!best) {
    throw new Error('No playable audio format found for this video.');
  }

  // Get content length from the format if available
  const contentLength = best.format.content_length ? Number(best.format.content_length) : null;
  const mimeType = best.mimeType;

  const rangeHeader = req.headers['range'];
  let rangeStart = 0;
  let rangeEnd = contentLength ? contentLength - 1 : null;
  let isRangeRequest = false;

  if (rangeHeader && contentLength) {
    isRangeRequest = true;
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    rangeStart = parseInt(parts[0], 10) || 0;
    rangeEnd = parts[1] ? parseInt(parts[1], 10) : contentLength - 1;
    
    if (rangeStart >= contentLength || rangeEnd >= contentLength) {
      res.setHeader('Content-Range', `bytes */${contentLength}`);
      res.writeHead(416, 'Requested Range Not Satisfiable');
      res.end();
      return;
    }
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');

  // Download options — specify byte range if seeking
  const downloadOptions = { itag: best.itag };
  if (isRangeRequest) {
    downloadOptions.range = { start: rangeStart, end: rangeEnd };
  }

  const webStream = await details.download(downloadOptions);
  const nodeStream = Readable.fromWeb(webStream);

  if (isRangeRequest) {
    const chunkSize = rangeEnd - rangeStart + 1;
    res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${contentLength}`);
    res.setHeader('Content-Length', chunkSize);
    res.writeHead(206, 'Partial Content');
  } else {
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    res.writeHead(200, 'OK');
  }

  nodeStream.pipe(res);

  res.on('close', () => {
    nodeStream.destroy();
  });

  nodeStream.on('error', (err) => {
    console.error('[getAudioStream] Stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream error' });
    } else {
      res.end();
    }
  });
}

// ── Download/Stream Handler (MP3 Transcoding, streamed directly) ────
// Streams ffmpeg output directly to the HTTP response — no temp file.
// This avoids Vercel's 512MB /tmp limit and works within timeout limits
// because the response is being written while transcoding (pipeline).
async function getDownloadStream(videoId, options = {}, cookiesContent, req, res) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  const quality = options.quality || '192k';

  let finalCookies = cookiesContent;
  if (!finalCookies && req && req.headers && req.headers.cookie) {
    const match = req.headers.cookie.match(/yt_cookies=([^;]+)/);
    if (match) {
      finalCookies = decodeURIComponent(match[1]);
    }
  }

  try {
    const yt = await getInnertube(finalCookies);
    const details = await yt.getInfo(videoId);

    // Get a clean filename for Content-Disposition
    const cleanTitle = (details.basic_info.title || 'audio')
      .replace(/[\\/:*?"<>|]/g, '')
      .substring(0, 100);
    const filename = `${cleanTitle}.mp3`;

    // Pick best available audio format (itag 18 → 140 → 251 → any audio)
    const best = getBestAudioFormat(details.streaming_data);
    if (!best) throw new Error('No playable audio format found for this video.');

    // Stream the YouTube source to ffmpeg stdin
    const webStream = await details.download({ itag: best.itag });
    const nodeStream = Readable.fromWeb(webStream);

    // Set response headers before spawning ffmpeg
    if (req && res) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
    }

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-i', 'pipe:0',    // Read from stdin
        '-vn',             // Drop video
        '-acodec', 'libmp3lame',
        '-b:a', quality,
        '-f', 'mp3',
        'pipe:1'           // Write to stdout
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      // Pipe YouTube → ffmpeg stdin
      nodeStream.pipe(ffmpeg.stdin);

      // Pipe ffmpeg stdout → HTTP response
      if (req && res) {
        ffmpeg.stdout.pipe(res);
      }

      let stderrData = '';
      if (ffmpeg.stderr) {
        ffmpeg.stderr.on('data', (chunk) => {
          stderrData += chunk.toString();
        });
      }

      ffmpeg.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve({ handled: true });
        } else {
          const last = stderrData.split('\n').slice(-5).join('\n');
          console.error(`[FFmpeg Error] Exit code: ${code}\nStderr (last lines):\n${last}`);
          if (!res.headersSent) {
            reject(new Error(`FFmpeg exited with code ${code}`));
          } else {
            res.end();
            resolve({ handled: true });
          }
        }
      });

      ffmpeg.on('error', (err) => {
        console.error('[FFmpeg spawn error]', err.message);
        reject(err);
      });

      nodeStream.on('error', (err) => {
        console.error('[YouTube stream error]', err.message);
        try { ffmpeg.kill(); } catch (e) {}
        reject(err);
      });

      if (res) {
        res.on('close', () => {
          nodeStream.destroy();
          try { ffmpeg.kill(); } catch (e) {}
        });
      }
    });
  } catch (err) {
    console.error('[getDownloadStream] Failed:', err.message);
    throw new Error(`Failed to stream video audio: ${err.message}`);
  }
}

module.exports = { getVideoInfo, getAudioStream, getDownloadStream };
