// КРИСТА · МУЗЫКА v1.25.3
(function(){
  'use strict';

  let musicTab = 'songs';
  let musicSongs = [], musicAlbums = [], musicArtists = [], musicPlaylists = [];
  let currentAlbum = null, currentArtist = null, currentPlaylist = null;
  let playlistTrackIds = new Set();
  let pickerTrackId = null;
  let pendingMusicToken = null;

  const audio = new Audio();
  audio.preload = 'metadata';
  let currentTrack = null;
  let currentQueue = [];        // текущая (возможно перемешанная) очередь
  let originalQueue = [];       // оригинальный порядок
  let currentQueueIndex = -1;
  let currentBlobUrl = null;

  // ==== Состояние плеера ====
  let shuffleOn = localStorage.getItem('krista_music_shuffle') === '1';
  let repeatMode = localStorage.getItem('krista_music_repeat') || 'off'; // off | all | one
  let playbackSpeed = parseFloat(localStorage.getItem('krista_music_speed')) || 1;
  let savedVolume = parseFloat(localStorage.getItem('krista_music_volume'));
  if (isNaN(savedVolume)) savedVolume = 1;
  audio.volume = savedVolume;

  let wakeLock = null;
  let progressDragging = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function fmtTime(sec) {
    if (!isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtSize(n) { if (!n) return '0 Б'; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n/1024).toFixed(1) + ' КБ'; return (n/1048576).toFixed(2) + ' МБ'; }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  function authHdr() { return window.token ? { Authorization: 'Bearer ' + window.token } : {}; }
  function shuffleArr(a) { const c = a.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; }

  async function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, authHdr(), opts.headers || {});
    const r = await fetch(url, opts);
    const d = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(d.error || 'Ошибка');
    return d;
  }

  // ==== Инициализация ====
  window.initMusic = function() {
    const el = $('musicContainer');
    if (!el) return;
    if (!el.innerHTML.trim()) {
      el.innerHTML = `
        <div class="music-tabs" id="musicTabs">
          <button class="music-add-tab" id="musicAddTabBtn" title="Добавить песню">＋ Песня</button>
          <div class="music-tab active" data-t="songs">Песни</div>
          <div class="music-tab" data-t="albums">Альбомы</div>
          <div class="music-tab" data-t="artists">Исполнители</div>
          <div class="music-tab" data-t="playlists">Плейлисты</div>
        </div>
        <div class="music-body" id="musicBody"></div>
        <div class="music-player" id="musicPlayer" style="display:none">
          <div class="music-player-info">
            <div class="music-player-thumb" id="mpThumb">♪</div>
            <div class="music-player-text" id="mptText"><div class="music-player-text-track" id="mptTrack"></div></div>
            <button class="music-player-btn" id="mpAdd" title="В плейлист">＋</button>
            <button class="music-player-btn" id="mpShare" title="Поделиться">⤴</button>
          </div>
          <div class="music-progress" id="mpProgress"><div class="music-progress-fill" id="mpProgressFill"></div></div>
          <div class="music-progress-times"><span id="mpTimeCur">0:00</span><span id="mpTimeDur">0:00</span></div>
          <div class="music-controls">
            <button class="music-ctrl" id="mpShuffle" title="Перемешать">🔀</button>
            <button class="music-ctrl" id="mpPrev">⏮️</button>
            <button class="music-ctrl main" id="mpPlay">▶️</button>
            <button class="music-ctrl" id="mpNext">⏭️</button>
            <button class="music-ctrl" id="mpRepeat" title="Повтор">🔁</button>
          </div>
          <div class="music-controls-secondary">
            <button class="music-ctrl-sm" id="mpQueue" title="Очередь">📋</button>
            <span class="music-vol-wrap"><span class="music-vol-icon" id="mpVolIcon">🔊</span><input type="range" min="0" max="100" value="${Math.round(savedVolume*100)}" class="music-vol" id="mpVol" /></span>
            <button class="music-ctrl-sm" id="mpSpeed" title="Скорость">${playbackSpeed}×</button>
            <button class="music-ctrl-sm" id="mpStop" title="Стоп">⏹️</button>
          </div>
        </div>
      `;
      $('musicAddTabBtn').onclick = openAddMusicModal;
      $('musicTabs').querySelectorAll('.music-tab').forEach(t => t.onclick = () => {
        musicTab = t.dataset.t;
        $('musicTabs').querySelectorAll('.music-tab').forEach(x => x.classList.toggle('active', x === t));
        currentAlbum = null; currentArtist = null; currentPlaylist = null;
        loadMusicTab();
      });
      ensureQueueModal();
      bindPlayer();
      applyPlayerState();
    }
    loadMusicTab();
  };

  // ==== Модалка очереди ====
  function ensureQueueModal() {
    if ($('queueModal')) return;
    const ov = document.createElement('div');
    ov.className = 'ov';
    ov.id = 'queueModal';
    ov.innerHTML = `<div class="mod"><h3>ОЧЕРЕДЬ</h3><div id="queueList" style="max-height:60vh;overflow-y:auto"></div><div class="row" style="margin-top:14px"><button onclick="closeModal('queueModal')">[ ЗАКРЫТЬ ]</button></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) ov.classList.remove('active'); });
  }

  // ==== Индикация состояния плеера ====
  function applyPlayerState() {
    const shuf = $('mpShuffle');
    if (shuf) shuf.classList.toggle('active', shuffleOn);
    const rep = $('mpRepeat');
    if (rep) {
      rep.classList.remove('active', 'dim');
      if (repeatMode === 'off') { rep.classList.add('dim'); rep.textContent = '🔁'; }
      else if (repeatMode === 'all') { rep.classList.add('active'); rep.textContent = '🔁'; }
      else { rep.classList.add('active'); rep.textContent = '🔂'; }
    }
    const sp = $('mpSpeed');
    if (sp) { sp.textContent = playbackSpeed + '×'; sp.classList.toggle('active', playbackSpeed !== 1); }
    const vol = $('mpVol');
    if (vol) vol.value = Math.round(savedVolume * 100);
    const vi = $('mpVolIcon');
    if (vi) vi.textContent = savedVolume === 0 ? '🔇' : savedVolume < 0.5 ? '🔉' : '🔊';
    audio.playbackRate = playbackSpeed;
  }

  async function loadMusicTab() {
    const body = $('musicBody');
    if (!body) return;
    body.innerHTML = `<div class="music-loading">Загрузка...</div>`;
    try {
      if (musicTab === 'songs') {
        musicSongs = await api('/api/music/songs');
        renderSongsList(musicSongs, null, false);
      } else if (musicTab === 'albums') {
        if (currentAlbum) {
          const songs = await api('/api/music/albums/' + encodeURIComponent(currentAlbum.album));
          renderSongsList(songs, `Альбом: ${currentAlbum.album}`, false);
        } else {
          musicAlbums = await api('/api/music/albums');
          renderAlbums();
        }
      } else if (musicTab === 'artists') {
        if (currentArtist) {
          const songs = await api('/api/music/artists/' + encodeURIComponent(currentArtist));
          renderSongsList(songs, `Исполнитель: ${currentArtist}`, false);
        } else {
          musicArtists = await api('/api/music/artists');
          renderArtists();
        }
      } else if (musicTab === 'playlists') {
        if (currentPlaylist) {
          const data = await api('/api/music/playlists/' + currentPlaylist.id + '/tracks');
          playlistTrackIds = new Set(data.tracks.map(t => t.id));
          renderSongsList(data.tracks, `Плейлист: ${data.name}`, true);
        } else {
          musicPlaylists = await api('/api/music/playlists');
          renderPlaylists();
        }
      }
    } catch (e) {
      body.innerHTML = `<div class="music-empty">${esc(e.message)}</div>`;
    }
  }

  function renderSongsList(songs, header, fromPlaylist) {
    const body = $('musicBody');
    const queue = songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album, fileId: s.fileId, filename: s.filename, uploadedBy: s.uploadedBy }));
    let html = '';
    if (header) html += `<div class="music-back" id="musicBack">‹ Назад</div>`;
    if (!songs.length) {
      html += `<div class="music-empty">Пусто<br><button onclick="openAddMusicModal()">Добавить песню</button></div>`;
      body.innerHTML = html;
      if (header) $('musicBack').onclick = () => { currentAlbum = null; currentArtist = null; currentPlaylist = null; loadMusicTab(); };
      return;
    }
    html += `<div class="music-list">`;
    songs.forEach((s, i) => {
      const playing = currentTrack && currentTrack.id === s.id;
      const inPl = fromPlaylist ? true : playlistTrackIds.has(s.id);
      html += `<div class="music-item ${playing?'playing':''}" data-i="${i}">
        <div class="music-item-icon">🎵</div>
        <div class="music-item-body" data-play="${i}">
          <div class="music-item-title">${esc(s.title)}</div>
          <div class="music-item-meta">${esc(s.artist)} · ${esc(s.album || 'Сингл')} · ${fmtSize(s.size)}</div>
        </div>
        <div class="music-item-actions">
          <button class="music-item-btn dl" data-dl="${i}" title="Скачать">⬇</button>
          <button class="music-item-btn ${inPl?'on':''}" data-add="${i}" title="В плейлист">${inPl ? '✓' : '＋'}</button>
        </div>
      </div>`;
    });
    html += `</div>`;
    body.innerHTML = html;
    if (header) $('musicBack').onclick = () => { currentAlbum = null; currentArtist = null; currentPlaylist = null; loadMusicTab(); };
    body.querySelectorAll('[data-play]').forEach(el => el.onclick = () => {
      playTrack(songs[+el.dataset.play], queue, +el.dataset.play);
    });
    body.querySelectorAll('[data-dl]').forEach(el => el.onclick = (e) => {
      e.stopPropagation();
      downloadTrack(songs[+el.dataset.dl], e.currentTarget);
    });
    body.querySelectorAll('[data-add]').forEach(el => el.onclick = (e) => {
      e.stopPropagation();
      pickerTrackId = songs[+el.dataset.add].id;
      openPlaylistPicker(songs[+el.dataset.add].id, fromPlaylist);
    });
  }

  async function downloadTrack(track, btn) {
    try {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      const res = await fetch('/api/fileById/' + track.fileId, { headers: authHdr() });
      if (!res.ok) throw new Error('Файл недоступен');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = track.filename || `${track.artist} - ${track.title}.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      window.toast && window.toast('', 'Скачано: ' + (track.title || 'файл'));
    } catch (e) {
      window.toast && window.toast('', e.message || 'Ошибка скачивания');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⬇'; }
    }
  }

  function renderAlbums() {
    const body = $('musicBody');
    if (!musicAlbums.length) { body.innerHTML = `<div class="music-empty">Нет альбомов</div>`; return; }
    body.innerHTML = `<div class="music-list">` + musicAlbums.map((a, i) => `
      <div class="music-group-item" data-i="${i}">
        <div class="music-group-icon">💿</div>
        <div class="music-group-body">
          <div class="music-group-name">${esc(a.album)}</div>
          <div class="music-group-meta">${esc(a.artist)} · ${a.count} ${plural(a.count, 'песня', 'песни', 'песен')}</div>
        </div>
        <div class="music-group-arrow">›</div>
      </div>
    `).join('') + `</div>`;
    body.querySelectorAll('.music-group-item').forEach(el => el.onclick = () => {
      currentAlbum = musicAlbums[+el.dataset.i];
      loadMusicTab();
    });
  }
  function renderArtists() {
    const body = $('musicBody');
    if (!musicArtists.length) { body.innerHTML = `<div class="music-empty">Нет исполнителей</div>`; return; }
    body.innerHTML = `<div class="music-list">` + musicArtists.map((a, i) => `
      <div class="music-group-item" data-i="${i}">
        <div class="music-group-icon">🎤</div>
        <div class="music-group-body">
          <div class="music-group-name">${esc(a.artist)}</div>
          <div class="music-group-meta">${a.count} ${plural(a.count, 'песня', 'песни', 'песен')}</div>
        </div>
        <div class="music-group-arrow">›</div>
      </div>
    `).join('') + `</div>`;
    body.querySelectorAll('.music-group-item').forEach(el => el.onclick = () => {
      currentArtist = musicArtists[+el.dataset.i].artist;
      loadMusicTab();
    });
  }
  function renderPlaylists() {
    const body = $('musicBody');
    let html = `<div class="music-list">`;
    html += `<div class="music-group-item" id="plCreateNew" style="border-style:dashed">
      <div class="music-group-icon">＋</div>
      <div class="music-group-body"><div class="music-group-name">Новый плейлист</div></div>
    </div>`;
    musicPlaylists.forEach((p, i) => {
      html += `<div class="music-group-item" data-i="${i}">
        <div class="music-group-icon">📁</div>
        <div class="music-group-body">
          <div class="music-group-name">${esc(p.name)}</div>
          <div class="music-group-meta">${p.count} ${plural(p.count, 'песня', 'песни', 'песен')}</div>
        </div>
        <div class="music-group-arrow">›</div>
      </div>`;
    });
    html += `</div>`;
    body.innerHTML = html;
    $('plCreateNew').onclick = async () => {
      const name = prompt('Название плейлиста:');
      if (!name || !name.trim()) return;
      try { await api('/api/music/playlists', { method:'POST', body: JSON.stringify({ name: name.trim() }) }); loadMusicTab(); }
      catch (e) { window.toast && window.toast('', e.message); }
    };
    body.querySelectorAll('[data-i]').forEach(el => el.onclick = () => {
      currentPlaylist = musicPlaylists[+el.dataset.i];
      loadMusicTab();
    });
  }

  // ============ PLAYER ============
  function bindPlayer() {
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      $('mpProgressFill').style.width = pct + '%';
      $('mpTimeCur').textContent = fmtTime(audio.currentTime);
      if (navigator.mediaSession && navigator.mediaSession.setPositionState && isFinite(audio.duration)) {
        try {
          navigator.mediaSession.setPositionState({
            duration: audio.duration,
            playbackRate: audio.playbackRate,
            position: audio.currentTime
          });
        } catch {}
      }
    });
    audio.addEventListener('loadedmetadata', () => { $('mpTimeDur').textContent = fmtTime(audio.duration); });
    audio.addEventListener('ended', onTrackEnded);
    audio.addEventListener('play', () => { $('mpPlay').textContent = '⏸️'; requestWakeLock(); });
    audio.addEventListener('pause', () => { $('mpPlay').textContent = '▶️'; releaseWakeLock(); });

    $('mpPlay').onclick = () => { if (audio.paused) audio.play().catch(()=>{}); else audio.pause(); };
    $('mpStop').onclick = () => { window.stopMusicPlayer(); };
    $('mpPrev').onclick = prevTrack;
    $('mpNext').onclick = nextTrack;

    // Shuffle
    $('mpShuffle').onclick = () => {
      shuffleOn = !shuffleOn;
      localStorage.setItem('krista_music_shuffle', shuffleOn ? '1' : '0');
      applyPlayerState();
      if (shuffleOn) {
        if (currentQueue.length > 1) {
          const cur = currentQueue[currentQueueIndex];
          const rest = currentQueue.filter((_, i) => i !== currentQueueIndex);
          const mixed = shuffleArr(rest);
          currentQueue = cur ? [cur, ...mixed] : mixed;
          currentQueueIndex = cur ? 0 : -1;
        }
      } else {
        if (originalQueue.length) {
          currentQueue = originalQueue.slice();
          currentQueueIndex = currentTrack ? currentQueue.findIndex(t => t.id === currentTrack.id) : -1;
        }
      }
      window.toast && window.toast('', shuffleOn ? 'Перемешать: вкл' : 'Перемешать: выкл');
    };

    // Repeat
    $('mpRepeat').onclick = () => {
      repeatMode = repeatMode === 'off' ? 'all' : (repeatMode === 'all' ? 'one' : 'off');
      localStorage.setItem('krista_music_repeat', repeatMode);
      audio.loop = (repeatMode === 'one');
      applyPlayerState();
      const label = repeatMode === 'off' ? 'Выкл' : (repeatMode === 'all' ? 'Повтор плейлиста' : 'Повтор одного');
      window.toast && window.toast('', label);
    };

    // Progress — click + touch
    const prog = $('mpProgress');
    function progressFromEvent(e) {
      const rect = prog.getBoundingClientRect();
      const x = (e.touches && e.touches[0]) ? e.touches[0].clientX : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : e.clientX);
      return Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    }
    prog.addEventListener('click', (e) => {
      if (!audio.duration) return;
      audio.currentTime = progressFromEvent(e) * audio.duration;
    });
    prog.addEventListener('touchstart', (e) => {
      if (!audio.duration) return;
      progressDragging = true;
      e.preventDefault();
      const pct = progressFromEvent(e);
      audio.currentTime = pct * audio.duration;
      $('mpProgressFill').style.width = (pct * 100) + '%';
      $('mpTimeCur').textContent = fmtTime(audio.currentTime);
    }, { passive: false });
    prog.addEventListener('touchmove', (e) => {
      if (!progressDragging || !audio.duration) return;
      e.preventDefault();
      const pct = progressFromEvent(e);
      audio.currentTime = pct * audio.duration;
      $('mpProgressFill').style.width = (pct * 100) + '%';
      $('mpTimeCur').textContent = fmtTime(audio.currentTime);
    }, { passive: false });
    prog.addEventListener('touchend', () => { progressDragging = false; });

    // Volume
    $('mpVol').oninput = (e) => {
      savedVolume = parseInt(e.target.value) / 100;
      audio.volume = savedVolume;
      localStorage.setItem('krista_music_volume', String(savedVolume));
      $('mpVolIcon').textContent = savedVolume === 0 ? '🔇' : savedVolume < 0.5 ? '🔉' : '🔊';
    };

    // Speed
    $('mpSpeed').onclick = () => {
      const speeds = [0.75, 1, 1.25, 1.5, 2];
      const idx = speeds.indexOf(playbackSpeed);
      playbackSpeed = speeds[(idx + 1) % speeds.length];
      audio.playbackRate = playbackSpeed;
      localStorage.setItem('krista_music_speed', String(playbackSpeed));
      applyPlayerState();
    };

    // Queue
    $('mpQueue').onclick = openQueueModal;

    // Add / share
    $('mpAdd').onclick = () => { if (currentTrack) openPlaylistPicker(currentTrack.id, false); };
    $('mpShare').onclick = () => {
      if (!currentTrack) return;
      const txt = `${currentTrack.artist} — ${currentTrack.title}`;
      if (navigator.share) navigator.share({ title: txt, text: txt }).catch(()=>{});
      else { navigator.clipboard?.writeText(txt); window.toast && window.toast('', 'Скопировано'); }
    };
  }

  async function playTrack(track, queue, index) {
    try {
      if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
      const res = await fetch('/api/fileById/' + track.fileId, { headers: authHdr() });
      if (!res.ok) throw new Error('Файл недоступен');
      const blob = await res.blob();
      currentBlobUrl = URL.createObjectURL(blob);
      audio.src = currentBlobUrl;
      audio.playbackRate = playbackSpeed;

      currentTrack = track;
      originalQueue = queue ? queue.slice() : [];
      if (queue) {
        currentQueue = queue.slice();
        currentQueueIndex = index != null ? index : 0;
        if (shuffleOn && currentQueue.length > 1) {
          const cur = currentQueue[currentQueueIndex];
          const rest = currentQueue.filter((_, i) => i !== currentQueueIndex);
          const mixed = shuffleArr(rest);
          currentQueue = cur ? [cur, ...mixed] : mixed;
          currentQueueIndex = cur ? 0 : -1;
        }
      }

      await audio.play();
      updatePlayerUI();
      setupMediaSession();
      updatePlayingHighlight();
    } catch (e) {
      window.toast && window.toast('', e.message || 'Ошибка воспроизведения');
    }
  }

  function updatePlayerUI() {
    if (!currentTrack) return;
    $('musicPlayer').style.display = 'flex';
    const txt = `${currentTrack.artist} — ${currentTrack.title}`;
    const el = $('mptTrack'), wrap = $('mptText');
    el.textContent = txt;
    el.classList.remove('scrolling');
    el.style.transform = '';
    // Иконка — первая буква артиста
    $('mpThumb').textContent = (currentTrack.artist || '♪').trim()[0] || '♪';
    requestAnimationFrame(() => {
      const w = el.scrollWidth, cw = wrap.clientWidth;
      if (w > cw + 4) {
        const dist = cw - w - 8;
        el.style.setProperty('--scroll-dist', dist + 'px');
        el.classList.add('scrolling');
      }
    });
  }

  function updatePlayingHighlight() {
    document.querySelectorAll('.music-item').forEach(el => el.classList.remove('playing'));
    if (!currentTrack) return;
    if (!musicSongs) return;
    const idx = musicSongs.findIndex(s => s.id === currentTrack.id);
    if (idx >= 0) { const el = document.querySelector(`.music-item[data-i="${idx}"]`); if (el) el.classList.add('playing'); }
  }

  function onTrackEnded() {
    if (repeatMode === 'one') { audio.currentTime = 0; audio.play().catch(()=>{}); return; }
    if (currentQueue.length && currentQueueIndex >= 0 && currentQueueIndex < currentQueue.length - 1) {
      const i = currentQueueIndex + 1;
      playTrack(currentQueue[i], currentQueue, i);
      return;
    }
    // Конец очереди
    if (repeatMode === 'all' && currentQueue.length > 1) {
      playTrack(currentQueue[0], currentQueue, 0);
      return;
    }
    audio.pause();
  }
  function nextTrack() {
    if (repeatMode === 'one' && audio.currentTime > 3) { audio.currentTime = 0; audio.play().catch(()=>{}); return; }
    if (currentQueue.length && currentQueueIndex >= 0 && currentQueueIndex < currentQueue.length - 1) {
      const i = currentQueueIndex + 1;
      playTrack(currentQueue[i], currentQueue, i);
    } else if (repeatMode === 'all' && currentQueue.length) {
      playTrack(currentQueue[0], currentQueue, 0);
    } else { audio.pause(); }
  }
  function prevTrack() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (currentQueue.length && currentQueueIndex > 0) {
      const i = currentQueueIndex - 1;
      playTrack(currentQueue[i], currentQueue, i);
    }
  }

  window.stopMusicPlayer = function() {
    try { audio.pause(); audio.src = ''; } catch {}
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
    currentTrack = null; currentQueue = []; originalQueue = []; currentQueueIndex = -1;
    const p = $('musicPlayer'); if (p) p.style.display = 'none';
    if (navigator.mediaSession) navigator.mediaSession.metadata = null;
    releaseWakeLock();
    updatePlayingHighlight();
  };

  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album || ''
    });
    try {
      navigator.mediaSession.setActionHandler('play', () => audio.play().catch(()=>{}));
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
      navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
      navigator.mediaSession.setActionHandler('stop', () => window.stopMusicPlayer());
      if (navigator.mediaSession.setPositionState && isFinite(audio.duration)) {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: audio.currentTime
        });
      }
    } catch {}
  }

  // ==== Wake Lock ====
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      if (wakeLock) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentTrack && !audio.paused) requestWakeLock();
  });

  // ==== Queue Modal ====
  function openQueueModal() {
    ensureQueueModal();
    const list = $('queueList');
    if (!currentQueue.length) {
      list.innerHTML = `<div class="music-empty">Очередь пуста</div>`;
    } else {
      list.innerHTML = currentQueue.map((t, i) => {
        const playing = currentTrack && t.id === currentTrack.id;
        return `<div class="q-item ${playing?'playing':''}" data-i="${i}">
          <div class="q-num">${playing ? '▶' : (i+1)}</div>
          <div class="q-body">
            <div class="q-title">${esc(t.title)}</div>
            <div class="q-artist">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</div>
          </div>
        </div>`;
      }).join('');
      list.querySelectorAll('.q-item').forEach(el => el.onclick = () => {
        const i = +el.dataset.i;
        playTrack(currentQueue[i], currentQueue, i);
        window.closeModal('queueModal');
      });
    }
    $('queueModal').classList.add('active');
  }

  // ============ ADD MUSIC ============
  window.openAddMusicModal = function() {
    const err = $('musicAddErr'); if (!err) return;
    err.textContent = '';
    $('musicFileInput').value = '';
    $('musicArtist').value = '';
    $('musicAlbum').value = '';
    $('musicTitle').value = '';
    $('musicTrackNum').value = '1';
    $('musicFileNamePreview').textContent = '';
    pendingMusicToken = null;
    $('musicAddModal').classList.add('active');
  };

  function sanitizeName(s) { return String(s||'').replace(/[\/\\:*?"<>|]/g, '_').slice(0,120); }
  function updateFileNamePreview() {
    const a = $('musicArtist').value.trim();
    const t = $('musicTitle').value.trim();
    if (a && t) $('musicFileNamePreview').textContent = `Будет сохранено как: ${sanitizeName(a)}-${sanitizeName(t)}.<формат>`;
    else $('musicFileNamePreview').textContent = '';
  }
  ['musicArtist','musicTitle'].forEach(id => {
    document.addEventListener('input', e => { if (e.target.id === id) updateFileNamePreview(); });
  });

  window.stageAndPublishMusic = async function() {
    const err = $('musicAddErr');
    err.textContent = '';
    const fileInput = $('musicFileInput');
    const file = fileInput.files && fileInput.files[0];
    const artist = $('musicArtist').value.trim();
    const album = $('musicAlbum').value.trim() || 'Сингл';
    const title = $('musicTitle').value.trim();
    const trackNum = parseInt($('musicTrackNum').value) || 1;
    if (!file) return err.textContent = 'Выбери файл';
    if (file.size > 20 * 1024 * 1024) return err.textContent = 'Отправлять файл не более 20 мб';
    if (!artist) return err.textContent = 'Укажи исполнителя';
    if (!title) return err.textContent = 'Укажи название';

    const btn = document.querySelector('#musicAddModal .row button.primary');
    btn.disabled = true; btn.textContent = 'Загрузка...';
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('artist', artist);
      form.append('album', album);
      form.append('trackTitle', title);
      form.append('trackNumber', String(trackNum));
      const r = await fetch('/api/music/stage', { method:'POST', headers: authHdr(), body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка');
      pendingMusicToken = data.token;
      await api('/api/music/publish', { method:'POST', body: JSON.stringify({ token: pendingMusicToken }) });
      window.toast && window.toast('', 'Опубликовано');
      window.closeModal('musicAddModal');
      loadMusicTab();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false; btn.textContent = '[ ОПУБЛИКОВАТЬ ]';
    }
  };

  // ============ PLAYLIST PICKER ============
  window.openPlaylistPicker = async function(trackId, fromPlaylist) {
    pickerTrackId = trackId;
    $('playlistPickerModal').classList.add('active');
    const list = $('playlistPickerList');
    list.innerHTML = `<div class="music-loading">Загрузка...</div>`;
    try {
      const pls = await api('/api/music/playlists');
      const details = await Promise.all(pls.map(p => api('/api/music/playlists/' + p.id + '/tracks').catch(()=>({tracks:[]}))));
      if (!pls.length) { list.innerHTML = `<div class="music-empty" style="padding:20px">Нет плейлистов. Создай первый ниже.</div>`; return; }
      list.innerHTML = pls.map((p, i) => {
        const inPl = (details[i].tracks || []).some(t => t.id === trackId);
        return `<div class="plp-item ${inPl?'in':''}" data-id="${p.id}">
          <div class="plp-body"><div class="plp-name">${esc(p.name)}</div><div class="plp-count">${p.count} ${plural(p.count,'песня','песни','песен')}</div></div>
          <div class="plp-check">${inPl ? '✓' : '＋'}</div>
          <button class="plp-del" data-del="${p.id}" title="Удалить">✕</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.plp-item').forEach(el => el.onclick = async (e) => {
        if (e.target.closest('[data-del]')) return;
        const id = el.dataset.id;
        try {
          await api('/api/music/playlists/' + id + '/tracks', { method:'POST', body: JSON.stringify({ trackId }) });
          if (fromPlaylist && currentPlaylist) { loadMusicTab(); }
          openPlaylistPicker(trackId, fromPlaylist);
        } catch (err) { window.toast && window.toast('', err.message); }
      });
      list.querySelectorAll('[data-del]').forEach(b => b.onclick = async (e) => {
        e.stopPropagation();
        const id = b.dataset.del;
        if (!confirm('Удалить плейлист?')) return;
        try { await api('/api/music/playlists/' + id, { method:'DELETE' }); openPlaylistPicker(trackId, fromPlaylist); }
        catch (err) { window.toast && window.toast('', err.message); }
      });
    } catch (e) { list.innerHTML = `<div class="music-empty">${esc(e.message)}</div>`; }
  };

  window.createNewPlaylist = async function() {
    const name = $('newPlaylistName').value.trim();
    if (!name) return;
    try {
      const p = await api('/api/music/playlists', { method:'POST', body: JSON.stringify({ name }) });
      $('newPlaylistName').value = '';
      if (pickerTrackId) {
        await api('/api/music/playlists/' + p.id + '/tracks', { method:'POST', body: JSON.stringify({ trackId: pickerTrackId }) });
        openPlaylistPicker(pickerTrackId, false);
      } else { loadMusicTab(); }
    } catch (e) { window.toast && window.toast('', e.message); }
  };

  // WS-события
  window.musicOnWsEvent = function(type, payload) {
    if (typeof currentTab !== 'undefined' && currentTab === 'Music') loadMusicTab();
  };

  // Инициализация состояния плеера при загрузке
  setTimeout(applyPlayerState, 500);

  console.log('[Music] v1.25.3 loaded');
})();
