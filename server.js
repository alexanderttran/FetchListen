/* ============================================================
   DownloadYes — Node.js Backend Server
   Uses yt-dlp to fetch video info and serve download URLs.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const url = require('url');

const PORT = process.env.PORT || 3000;
const YTDLP = path.join(__dirname, 'yt-dlp.exe');

// ── MIME Types ─────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── Serve Static Files ─────────────────────────────────────
function serveStatic(reqPath, res) {
  let filePath = reqPath === '/' ? '/index.html' : reqPath;
  filePath = path.join(__dirname, filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── yt-dlp info fetcher ────────────────────────────────────
function getVideoInfo(videoId) {
  return new Promise((resolve, reject) => {
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      '--dump-json',
      '--no-warnings',
      '--no-playlist',
      '--skip-download',
      ytUrl,
    ];

    execFile(YTDLP, args, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('yt-dlp error:', err.message);
        reject(new Error('Failed to fetch video info. Make sure yt-dlp is installed.'));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        resolve(info);
      } catch (e) {
        reject(new Error('Failed to parse video info'));
      }
    });
  });
}

// ── Build format list from yt-dlp output ───────────────────
function buildFormats(info) {
  const audioFormats = [];
  const videoFormats = [];
  const seen = new Set();

  // Predefined audio output options (will be converted by yt-dlp on download)
  const audioOptions = [
    { ext: 'mp3',  label: 'MP3 — 320kbps',  bitrate: '320 kbps', codec: 'MP3',  quality: 'best' },
    { ext: 'mp3',  label: 'MP3 — 192kbps',  bitrate: '192 kbps', codec: 'MP3',  quality: '192' },
    { ext: 'mp3',  label: 'MP3 — 128kbps',  bitrate: '128 kbps', codec: 'MP3',  quality: '128' },
    { ext: 'wav',  label: 'WAV — Lossless',  bitrate: 'Lossless', codec: 'PCM',  quality: 'best' },
    { ext: 'flac', label: 'FLAC — Lossless', bitrate: 'Lossless', codec: 'FLAC', quality: 'best' },
    { ext: 'aac',  label: 'AAC — Best',      bitrate: 'Best',     codec: 'AAC',  quality: 'best' },
    { ext: 'ogg',  label: 'OGG — Vorbis',    bitrate: 'Best',     codec: 'Vorbis', quality: 'best' },
    { ext: 'm4a',  label: 'M4A — Best',      bitrate: 'Best',     codec: 'AAC',  quality: 'best' },
  ];

  audioOptions.forEach((opt) => {
    audioFormats.push({
      ext: opt.ext.toUpperCase(),
      label: opt.label,
      bitrate: opt.bitrate,
      codec: opt.codec,
      downloadUrl: `/api/download?v=${info.id}&format=audio&ext=${opt.ext}&quality=${opt.quality}`,
    });
  });

  // Video formats — pick best per resolution
  const resolutions = ['2160', '1440', '1080', '720', '480', '360', '240', '144'];
  const formats = info.formats || [];

  resolutions.forEach((res) => {
    // Find best video+audio format at this resolution, or best video-only
    const matching = formats.filter(
      (f) => f.height && String(f.height) === res && f.vcodec !== 'none'
    );
    if (matching.length === 0) return;

    const best = matching.reduce((a, b) => {
      const aSize = a.filesize || a.filesize_approx || 0;
      const bSize = b.filesize || b.filesize_approx || 0;
      return bSize > aSize ? b : a;
    });

    const key = `${res}p`;
    if (seen.has(key)) return;
    seen.add(key);

    const filesize = best.filesize || best.filesize_approx || null;
    const ext = best.ext || 'mp4';
    let codecLabel = '';
    if (best.vcodec) {
      const vc = best.vcodec.split('.')[0];
      codecLabel = vc.startsWith('avc') ? 'H.264' : vc.startsWith('vp') ? vc.toUpperCase() : vc.startsWith('av01') ? 'AV1' : vc;
    }

    videoFormats.push({
      ext: 'MP4',
      label: `${key} ${parseInt(res) >= 1080 ? '— HD' : parseInt(res) >= 2160 ? '— 4K' : ''}`.trim(),
      size: filesize ? formatSize(filesize) : '',
      codec: codecLabel,
      downloadUrl: `/api/download?v=${info.id}&format=video&height=${res}`,
    });
  });

  return { audioFormats, videoFormats };
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// ── Download handler ───────────────────────────────────────
function handleDownload(query, res) {
  const videoId = query.v;
  const format = query.format; // 'audio' or 'video'
  const ext = query.ext || 'mp3';
  const quality = query.quality || 'best';
  const height = query.height || '720';

  if (!videoId || !format) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing parameters' }));
    return;
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let args = [];

  if (format === 'audio') {
    args = [
      '-x',
      '--audio-format', ext,
      '--audio-quality', quality === 'best' ? '0' : quality,
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      ytUrl,
    ];
  } else {
    args = [
      '-f', `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
      '--merge-output-format', 'mp4',
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      ytUrl,
    ];
  }

  // Determine content type
  const mimeMap = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };

  const outExt = format === 'audio' ? ext : 'mp4';
  const contentType = mimeMap[outExt] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="download.${outExt}"`,
    'Transfer-Encoding': 'chunked',
  });

  const proc = spawn(YTDLP, args);

  proc.stdout.pipe(res);

  proc.stderr.on('data', (data) => {
    console.error('yt-dlp download stderr:', data.toString());
  });

  proc.on('error', (err) => {
    console.error('yt-dlp spawn error:', err.message);
    if (!res.writableEnded) {
      res.end();
    }
  });

  proc.on('close', (code) => {
    if (!res.writableEnded) {
      res.end();
    }
  });

  // Kill yt-dlp if client disconnects
  res.on('close', () => {
    proc.kill('SIGTERM');
  });
}

// ── HTTP Server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // API: Get video info
  if (pathname === '/api/info' && req.method === 'GET') {
    const videoId = parsed.query.v;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid video ID' }));
      return;
    }

    try {
      const info = await getVideoInfo(videoId);
      const { audioFormats, videoFormats } = buildFormats(info);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: info.id,
        title: info.title || 'Untitled',
        channel: info.channel || info.uploader || '',
        duration: info.duration || 0,
        thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        audioFormats,
        videoFormats,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Download
  if (pathname === '/api/download' && req.method === 'GET') {
    handleDownload(parsed.query, res);
    return;
  }

  // Static files
  serveStatic(pathname, res);
});

server.listen(PORT, () => {
  console.log(`\n  ✦  DownloadYes is running at http://localhost:${PORT}\n`);
});
