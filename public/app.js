/* ============================================================
   DownloadYes — Client-Side Application
   ============================================================ */

(function () {
  'use strict';

  // ── DOM References ───────────────────────────────────────
  const urlInput        = document.getElementById('url-input');
  const fetchBtn        = document.getElementById('fetch-btn');
  const inputHint       = document.getElementById('input-hint');
  const heroSection     = document.getElementById('hero-section');
  const loadingSection  = document.getElementById('loading-section');
  const resultsSection  = document.getElementById('results-section');
  const errorSection    = document.getElementById('error-section');
  const errorText       = document.getElementById('error-text');
  const retryBtn        = document.getElementById('retry-btn');
  const backBtn         = document.getElementById('back-btn');

  const videoThumbnail  = document.getElementById('video-thumbnail');
  const videoDuration   = document.getElementById('video-duration');
  const videoTitle      = document.getElementById('video-title');
  const videoChannel    = document.getElementById('video-channel');
  const audioCards      = document.getElementById('audio-cards');

  // Cookies UI
  const cookiesToggle      = document.getElementById('cookies-toggle');
  const cookiesToggleLabel = document.getElementById('cookies-toggle-label');
  const cookiesModal       = document.getElementById('cookies-modal');
  const cookiesModalClose  = document.getElementById('cookies-modal-close');
  const cookiesTextarea    = document.getElementById('cookies-textarea');
  const cookiesSaveBtn     = document.getElementById('cookies-save-btn');
  const cookiesClearBtn    = document.getElementById('cookies-clear-btn');

  // ── State ────────────────────────────────────────────────
  let currentVideoId    = '';
  let currentVideoTitle = '';

  // ── Cookies Management ───────────────────────────────────
  const COOKIES_KEY = 'yt_cookies';

  function getCookies() {
    return localStorage.getItem(COOKIES_KEY) || null;
  }

  function updateCookiesToggle() {
    const hasCookies = !!getCookies();
    cookiesToggleLabel.textContent = hasCookies
      ? '✓ Cookies saved — click to update'
      : 'Add cookies to bypass bot detection';
    cookiesToggle.classList.toggle('has-cookies', hasCookies);
  }

  function openCookiesModal() {
    cookiesTextarea.value = getCookies() || '';
    cookiesModal.classList.remove('hidden');
    cookiesTextarea.focus();
  }

  function closeCookiesModal() {
    cookiesModal.classList.add('hidden');
  }

  cookiesToggle.addEventListener('click', openCookiesModal);
  cookiesModalClose.addEventListener('click', closeCookiesModal);

  cookiesModal.addEventListener('click', (e) => {
    if (e.target === cookiesModal) closeCookiesModal();
  });

  cookiesSaveBtn.addEventListener('click', () => {
    const val = cookiesTextarea.value.trim();
    if (val) {
      localStorage.setItem(COOKIES_KEY, val);
    } else {
      localStorage.removeItem(COOKIES_KEY);
    }
    updateCookiesToggle();
    closeCookiesModal();
  });

  cookiesClearBtn.addEventListener('click', () => {
    cookiesTextarea.value = '';
    localStorage.removeItem(COOKIES_KEY);
    updateCookiesToggle();
    closeCookiesModal();
  });

  // ── YouTube URL Validation ───────────────────────────────
  function extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  // ── Section Visibility ───────────────────────────────────
  function showSection(section) {
    [loadingSection, resultsSection, errorSection].forEach(s => s.classList.add('hidden'));
    if (section) section.classList.remove('hidden');
  }

  function showHome() {
    heroSection.classList.remove('hidden');
    showSection(null);
    urlInput.value = '';
    urlInput.focus();
    inputHint.textContent = 'Supports youtube.com and youtu.be links';
    inputHint.classList.remove('error');
  }

  // ── Format Duration ──────────────────────────────────────
  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m}:${s.toString().padStart(2,'0')}`;
  }

  // ── Blob Download Helper ─────────────────────────────────
  async function triggerBlobDownload(videoId, quality, title) {
    const btn = document.querySelector(`[data-quality="${quality}"]`);
    if (btn) {
      btn.classList.add('downloading');
      btn.querySelector('.format-quality').textContent = 'Downloading…';
    }

    try {
      const resp = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, quality, cookies: getCookies() }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Server error (${resp.status})`);
      }

      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${title || 'audio'} (${quality}).mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      alert(`Download failed: ${err.message}`);
    } finally {
      if (btn) {
        btn.classList.remove('downloading');
        btn.querySelector('.format-quality').textContent = btn.dataset.label;
      }
    }
  }

  // ── Create Format Card ───────────────────────────────────
  function createFormatCard(format, videoId, videoTitle) {
    const card = document.createElement('button');
    card.className = 'format-card';
    card.type = 'button';
    card.setAttribute('title', `Download ${format.label}`);
    card.dataset.quality = format.quality;
    card.dataset.label   = format.label;

    const meta = [];
    if (format.bitrate) meta.push(format.bitrate);
    if (format.codec)   meta.push(format.codec);

    card.innerHTML = `
      <div class="format-card-left">
        <span class="format-badge">${format.ext}</span>
        <div class="format-detail">
          <span class="format-quality">${format.label}</span>
          ${meta.length ? `<span class="format-meta">${meta.join(' · ')}</span>` : ''}
        </div>
      </div>
      <svg class="format-download-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;

    card.addEventListener('click', () => {
      triggerBlobDownload(videoId, format.quality, videoTitle);
    });

    return card;
  }

  // ── Fetch Video Info via Backend API ─────────────────────
  async function fetchVideoInfo(videoId) {
    const resp = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, cookies: getCookies() }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Server error (${resp.status})`);
    }
    return resp.json();
  }

  // ── Render Results ───────────────────────────────────────
  function renderResults(data) {
    videoThumbnail.src        = data.thumbnail || `https://i.ytimg.com/vi/${currentVideoId}/hqdefault.jpg`;
    videoThumbnail.alt        = data.title || 'Video thumbnail';
    videoDuration.textContent = formatDuration(data.duration);
    videoTitle.textContent    = data.title || 'Untitled Video';
    videoChannel.textContent  = data.channel || '';
    currentVideoTitle         = data.title || 'audio';

    audioCards.innerHTML = '';

    if (data.audioFormats && data.audioFormats.length) {
      data.audioFormats.forEach(f => audioCards.appendChild(createFormatCard(f, currentVideoId, currentVideoTitle)));
      document.getElementById('audio-formats').classList.remove('hidden');
    } else {
      document.getElementById('audio-formats').classList.add('hidden');
    }

    heroSection.classList.add('hidden');
    showSection(resultsSection);
  }

  // ── Main Fetch Handler ───────────────────────────────────
  async function handleFetch() {
    const url = urlInput.value.trim();
    if (!url) {
      inputHint.textContent = 'Please enter a YouTube URL';
      inputHint.classList.add('error');
      urlInput.focus();
      return;
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      inputHint.textContent = 'Invalid YouTube URL. Please check and try again.';
      inputHint.classList.add('error');
      return;
    }

    inputHint.textContent = 'Supports youtube.com and youtu.be links';
    inputHint.classList.remove('error');
    currentVideoId = videoId;
    fetchBtn.disabled = true;

    heroSection.classList.add('hidden');
    showSection(loadingSection);

    try {
      const data = await fetchVideoInfo(videoId);
      renderResults(data);
    } catch (err) {
      errorText.textContent = err.message || 'Something went wrong. Please try again.';
      heroSection.classList.add('hidden');
      showSection(errorSection);
    } finally {
      fetchBtn.disabled = false;
    }
  }

  // ── Event Listeners ──────────────────────────────────────
  fetchBtn.addEventListener('click', handleFetch);

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleFetch();
    }
  });

  urlInput.addEventListener('input', () => {
    if (inputHint.classList.contains('error')) {
      inputHint.textContent = 'Supports youtube.com and youtu.be links';
      inputHint.classList.remove('error');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCookiesModal();
  });

  retryBtn.addEventListener('click', showHome);
  backBtn.addEventListener('click', showHome);

  // ── Init ─────────────────────────────────────────────────
  updateCookiesToggle();
  urlInput.focus();
})();
