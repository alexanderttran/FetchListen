/* ============================================================
   FetchListen — YouTube Logic
   Uses youtubei.js + ffmpeg-static for pure JS deciphering and caching.
   ============================================================ */

const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

// ffmpeg-static
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  try { fs.chmodSync(ffmpegPath, 0o755); } catch (e) {}
} catch (e) {
  ffmpegPath = null;
  console.warn('[FetchListen] ffmpeg-static not found');
}

// Active transcoding promises to prevent duplicate processes
const activeTranscodes = {};

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

// Helper to serve files supporting HTTP range requests for HTML5 media elements
function sendFileWithRanges(req, res, filePath, contentType, filename) {
  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  
  const range = req.headers['range'];
  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    
    if (start >= totalSize || end >= totalSize) {
      res.setHeader('Content-Range', `bytes */${totalSize}`);
      res.writeHead(416, 'Requested Range Not Satisfiable');
      return res.end();
    }
    
    const chunksize = (end - start) + 1;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', chunksize);
    res.writeHead(206, 'Partial Content');
    
    const stream = fs.createReadStream(filePath, { start, end });
    stream.pipe(res);
    res.on('close', () => {
      stream.destroy();
    });
  } else {
    res.setHeader('Content-Length', totalSize);
    if (filename) {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    }
    res.writeHead(200, 'OK');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    res.on('close', () => {
      stream.destroy();
    });
  }
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

    const formats = details.streaming_data?.formats || [];
    const itag18 = formats.find(f => f.itag === 18);
    if (!itag18) {
      throw new Error('This video does not support progressive playback (itag 18 missing).');
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

// ── Download/Stream Handler (MP3 Transcoding with Range Request Support) ───
async function getDownloadStream(videoId, options = {}, cookiesContent, req, res) {
  if (!ffmpegPath) throw new Error('MP3 conversion unavailable — ffmpeg not found');
  const quality = options.quality || '192k';
  const tempPath = path.join(os.tmpdir(), `fetchlisten-${videoId}-${quality}.mp3`);
  const partialPath = `${tempPath}.tmp`;
  const key = `${videoId}-${quality}`;

  let finalCookies = cookiesContent;
  if (!finalCookies && req && req.headers && req.headers.cookie) {
    const match = req.headers.cookie.match(/yt_cookies=([^;]+)/);
    if (match) {
      finalCookies = decodeURIComponent(match[1]);
    }
  }

  try {
    // Check if the transcoded MP3 already exists in cache
    const fileExists = fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0;
    
    if (!fileExists) {
      // Fetch URL and transcode if not already cached
      if (!activeTranscodes[key]) {
        activeTranscodes[key] = (async () => {
          try {
            const yt = await getInnertube(finalCookies);
            const details = await yt.getInfo(videoId);

            // Transcode progressive stream to temp MP3 file
            await new Promise((resolve, reject) => {
              (async () => {
                try {
                  const webStream = await details.download({ itag: 18 });
                  const nodeStream = require('stream').Readable.fromWeb(webStream);
                  
                  const ffmpeg = spawn(ffmpegPath, [
                    '-i', 'pipe:0', // Read from stdin
                    '-vn',
                    '-acodec', 'libmp3lame',
                    '-b:a', quality,
                    '-f', 'mp3',
                    '-y',
                    partialPath
                  ], { stdio: ['pipe', 'ignore', 'pipe'] });
                  
                  nodeStream.pipe(ffmpeg.stdin);
                  
                  let stderrData = '';
                  if (ffmpeg.stderr) {
                    ffmpeg.stderr.on('data', (chunk) => {
                      stderrData += chunk.toString();
                    });
                  }
                  
                  ffmpeg.on('close', (code) => {
                    if (code === 0) {
                      try {
                        fs.renameSync(partialPath, tempPath);
                        resolve();
                      } catch (err) {
                        reject(new Error(`Failed to rename temp file: ${err.message}`));
                      }
                    } else {
                      try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch (e) {}
                      console.error(`[FFmpeg Error] Exit code: ${code}\nStderr: ${stderrData}`);
                      reject(new Error(`FFmpeg exited with code ${code}`));
                    }
                  });
                  
                  ffmpeg.on('error', (err) => {
                    try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch (e) {}
                    reject(err);
                  });
                  
                  nodeStream.on('error', (err) => {
                    try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch (e) {}
                    try { ffmpeg.kill(); } catch (e) {}
                    reject(err);
                  });
                } catch (err) {
                  reject(err);
                }
              })();
            });
          } catch (err) {
            delete activeTranscodes[key];
            throw err;
          }
        })();
      }
      
      try {
        await activeTranscodes[key];
      } catch (err) {
        delete activeTranscodes[key];
        throw err;
      }
    }

    if (req && res) {
      // Determine if it is a download attachment request or inline player stream
      const isDownload = req.method === 'POST' || req.query.download === 'true';
      let cleanFilename = null;
      if (isDownload) {
        try {
          const yt = await getInnertube(finalCookies);
          const details = await yt.getInfo(videoId);
          cleanFilename = `${(details.basic_info.title || 'audio').replace(/[\\/:*?"<>|]/g, '').substring(0, 100)}.mp3`;
        } catch (e) {
          cleanFilename = 'audio.mp3';
        }
      }

      sendFileWithRanges(req, res, tempPath, 'audio/mpeg', cleanFilename);
      return { handled: true };
    }

    // Fallback for legacy calls
    return {
      stream: fs.createReadStream(tempPath),
      contentType: 'audio/mpeg',
      filename: 'audio.mp3'
    };
  } catch (err) {
    console.error('[getDownloadStream] Failed:', err.message);
    throw new Error(`Failed to stream video audio: ${err.message}`);
  }
}

// Periodically clean up old temp MP3 files to preserve disk space
function startCleanupTask() {
  setInterval(() => {
    const tempDir = os.tmpdir();
    fs.readdir(tempDir, (err, files) => {
      if (err) return;
      const now = Date.now();
      for (const file of files) {
        if (file.startsWith('fetchlisten-') && file.endsWith('.mp3')) {
          const filePath = path.join(tempDir, file);
          fs.stat(filePath, (err, stats) => {
            if (err) return;
            if (now - stats.mtimeMs > 3600000) { // 1 hour
              fs.unlink(filePath, () => {});
            }
          });
        }
      }
    });
  }, 1800000); // 30 minutes
}
startCleanupTask();

module.exports = { getVideoInfo, getDownloadStream };
