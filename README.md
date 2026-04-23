# DownloadYes

A sleek, black & white YouTube downloader built with pure JavaScript.  
No binary dependencies — works on **any** hosting platform: Vercel, Railway, Render, VPS, or local.

---

## Quick Start (Local)

```bash
npm install
npm start
# → http://localhost:3000
```

Requires **Node.js 18+** (for Web Streams API support).

---

## Deploy to Vercel

1. Push this repo to GitHub
2. Import in [vercel.com/new](https://vercel.com/new)
3. Deploy — zero config needed

Vercel automatically:
- Serves `public/` as static files (CDN-cached)
- Deploys `api/` as serverless functions

> **Note:** Vercel Hobby (free) has a 10s function timeout. Video info fetching works fine.
> Large downloads may time out on Hobby — upgrade to Pro (60s timeout) for reliable downloads.

---

## Deploy Anywhere Else (Railway, Render, VPS, Docker)

```bash
npm install
npm start
```

The Express server (`server.js`) works on any Node.js hosting platform.  
Set the `PORT` environment variable if needed (defaults to 3000).

### Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Architecture

```
├── public/          Static frontend (HTML, CSS, JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── api/             Vercel serverless functions
│   ├── info.js      GET /api/info?v=VIDEO_ID
│   └── download.js  GET /api/download?v=VIDEO_ID&itag=...
├── lib/
│   └── youtube.js   Shared YouTube logic (youtubei.js)
├── server.js        Express server (local + traditional hosting)
├── vercel.json      Vercel configuration
└── package.json
```

**Engine:** [youtubei.js](https://github.com/LuanRT/YouTube.js) — a pure JavaScript client for YouTube's InnerTube API.

---

## If youtubei.js Stops Working

YouTube periodically changes its internal APIs, which can break third-party libraries.
Here's what to do and what backups are available:

### Step 1: Update the Package

Most breakages are fixed quickly by the library maintainers:

```bash
npm update youtubei.js
# or for the latest:
npm install youtubei.js@latest
```

Then redeploy. This fixes ~90% of issues.

### Step 2: Check for Known Issues

- GitHub Issues: https://github.com/LuanRT/YouTube.js/issues
- Look for issues tagged "bug" or "YouTube changed something"
- Fixes are usually released within 24–72 hours of a YouTube change

### Step 3: Alternative Libraries (Drop-In Replacements)

If youtubei.js is abandoned or permanently broken, swap to one of these in `lib/youtube.js`:

| Library | Type | Notes |
|---------|------|-------|
| **[@ybd-project/ytdl-core](https://www.npmjs.com/package/@ybd-project/ytdl-core)** | Pure JS | Fork of ytdl-core, actively maintained |
| **[play-dl](https://www.npmjs.com/package/play-dl)** | Pure JS | Alternative YouTube API client |
| **[yt-dlp](https://github.com/yt-dlp/yt-dlp) + wrapper** | Binary | Most reliable, but requires binary on server |

To swap libraries, only `lib/youtube.js` needs to change — the API layer (`api/` and `server.js`) and frontend stay the same.

### Step 4: Use yt-dlp as Fallback (Non-Serverless Only)

For traditional hosting (Railway, Render, VPS, Docker), you can fall back to yt-dlp:

1. Install yt-dlp on the server: `apt install yt-dlp` (Linux) or add to Docker image
2. Replace `lib/youtube.js` internals with `child_process.execFile('yt-dlp', ...)`
3. This is the most reliable option but won't work on Vercel/serverless

### Step 5: Self-Hosted API Proxy

Run a separate yt-dlp-based API server and point this app at it:

1. Deploy [cobalt](https://github.com/imputnet/cobalt) or similar on a VPS
2. Update `lib/youtube.js` to call your API instead of using youtubei.js directly
3. Frontend remains unchanged

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `{"error":"Not found"}` on Vercel | Make sure `public/` dir exists with `index.html` |
| 403 errors from YouTube | Run `npm update youtubei.js` — YouTube changed something |
| Downloads timeout on Vercel | Vercel Hobby has 10s limit; use Pro or deploy elsewhere |
| No audio/video formats returned | The video may be geo-restricted or age-restricted |
| `Readable.fromWeb is not a function` | You need Node.js 18+; update your Node version |

---

## License

MIT