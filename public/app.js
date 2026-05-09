/* ============================================================
   DownloadYes — Client-Side Application
   ============================================================ */

(function () {
  'use strict';

  // ── DOM References ───────────────────────────────────────
  const urlInput = document.getElementById('url-input');
  const fetchBtn = document.getElementById('fetch-btn');
  const inputHint = document.getElementById('input-hint');
  const inputArea = document.getElementById('input-area');
  const heroSection = document.getElementById('hero-section');
  const loadingSection = document.getElementById('loading-section');
  const resultsSection = document.getElementById('results-section');
  const errorSection = document.getElementById('error-section');
  const errorText = document.getElementById('error-text');
  const retryBtn = document.getElementById('retry-btn');
  const backBtn = document.getElementById('back-btn');

  const videoThumbnail = document.getElementById('video-thumbnail');
  const videoDuration = document.getElementById('video-duration');
  const videoTitle = document.getElementById('video-title');
  const videoChannel = document.getElementById('video-channel');
  const audioCards = document.getElementById('audio-cards');
  const videoCards = document.getElementById('video-cards');

  // ── State ────────────────────────────────────────────────
  let currentVideoId = '';

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

  // ── Format File Size ─────────────────────────────────────
  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
  }

  // ── Create Format Card HTML ──────────────────────────────
  function createFormatCard(format) {
    const card = document.createElement('a');
    card.className = 'format-card';
    card.href = format.downloadUrl || '#';
    card.setAttribute('download', '');
    card.setAttribute('title', `Download ${format.label}`);

    const meta = [];
    if (format.bitrate) meta.push(format.bitrate);
    if (format.size) meta.push(format.size);
    if (format.codec) meta.push(format.codec);

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
    return card;
  }

  // ── Fetch Video Info via Backend API ─────────────────────
  async function fetchVideoInfo(videoId) {
    const resp = await fetch(`/api/info?v=${encodeURIComponent(videoId)}`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Server error (${resp.status})`);
    }
    return resp.json();
  }

  // ── Render Results ───────────────────────────────────────
  function renderResults(data) {
    // Video preview
    videoThumbnail.src = data.thumbnail || `https://i.ytimg.com/vi/${currentVideoId}/hqdefault.jpg`;
    videoThumbnail.alt = data.title || 'Video thumbnail';
    videoDuration.textContent = formatDuration(data.duration);
    videoTitle.textContent = data.title || 'Untitled Video';
    videoChannel.textContent = data.channel || '';

    // Clear old cards
    audioCards.innerHTML = '';
    videoCards.innerHTML = '';

    // Audio formats
    if (data.audioFormats && data.audioFormats.length) {
      data.audioFormats.forEach(f => audioCards.appendChild(createFormatCard(f)));
      document.getElementById('audio-formats').classList.remove('hidden');
    } else {
      document.getElementById('audio-formats').classList.add('hidden');
    }

    // Video formats
    if (data.videoFormats && data.videoFormats.length) {
      data.videoFormats.forEach(f => videoCards.appendChild(createFormatCard(f)));
      document.getElementById('video-formats').classList.remove('hidden');
    } else {
      document.getElementById('video-formats').classList.add('hidden');
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

  retryBtn.addEventListener('click', showHome);
  backBtn.addEventListener('click', showHome);

  // ── Focus input on load ──────────────────────────────────
  urlInput.focus();
})();
