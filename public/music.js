// КРИСТА · МУЗЫКА v1.25
(function(){
  'use strict';

  let musicTab = 'songs';
  let musicSongs = [];
  let musicAlbums = [];
  let musicArtists = [];
  let musicPlaylists = [];
  let currentAlbum = null; // { album, artist }
  let currentArtist = null;
  let currentPlaylist = null; // { id, name }
  let playlistTrackIds = new Set();

  let pendingMusicToken = null;
  let pickerTrackId = null;

  const audio = new Audio();
  audio.preload = 'metadata';
  let currentTrack = null;
  let currentPlaylistQueue = [];
  let currentQueueIndex = -1;
  let currentBlobUrl = null;

  const $ = id => document.getElementById(id);
  function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function fmtTime(sec) {
    if (!isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtSize(n) { if (!n) return '0 Б'; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n/1024).toFixed(1) + ' КБ'; return (n/1048576).toFixed(2) + ' МБ'; }

  function authHdr() { return window.token ? { Authorization: 'Bearer ' + window.token } : {}; }

  async function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, authHdr(), opts.headers || {});
    const r = await fetch(url, opts);
    const d = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(d.error || 'Ошибка');
    return d;
  }

  // ============ INIT ============
  window.initMusic = function() {
    const el = $('musicContainer');
    if (!el) return;
    if (!el.innerHTML.trim()) {
      el.innerHTML = `
        <div class="music-hdr">
          <div class="music-hdr-title">КРИСТА.МУЗЫКА</div>
          <button class="music-hdr-btn" id="musicAddBtn">[+ М]</button>
        </div>
        <div class="music-tabs" id="musicTabs">
          <div class="music-tab active" data-t="songs">Песни</div>
          <div class="music-tab" data-t="albums">Альбомы</div>
          <div class="music-tab" data-t="artists">Исполнители</div>
          <div class="music-tab" data-t="playlists">Плейлисты</div>
        </div>
        <div class="music-body" id="musicBody"></div>
        <div class="music-player" id="musicPlayer" style="display:none">
          <div class="music-player-info">
            <div class="music-player-text" id="mptText"><div class="music-player-text-track" id="mptTrack"></div></div>
            <button class="music-player-btn" id="mpAdd" title="В плейлист">+</button>
            <button class="music-player-btn" id="mpShare" title="Поделиться">⤴</button>
          </div>
          <div class="music-progress" id="mpProgress"><div class="music-progress-fill" id="mpProgressFill"></div></div>
          <div class="music-progress-times"><span id="mpTimeCur">0:00</span><span id="mpTimeDur">0:00</span></div>
          <div class="music-controls">
            <button class="music-ctrl" id="mpPrev">⏮️</button>
            <button class="music-ctrl main" id="mpPlay">▶️</button>
            <button class="music-ctrl" id="mpNext">⏭️</button>
            <button class="music-ctrl" id="mpStop">⏹️</button>
          </div>
        </div>
      `;
      $('musicAddBtn').onclick = openAddMusicModal;
      $('musicTabs').querySelectorAll('.music-tab').forEach(t => t.onclick = () => {
        musicTab = t.dataset.t;
        $('musicTabs').querySelectorAll('.music-tab').forEach(x => x.classList.toggle('active', x === t));
        currentAlbum = null; currentArtist = null; currentPlaylist = null;
        renderMusicTab();
      });
      bindPlayer();
    }
    loadMusicTab();
  };

  async function loadMusicTab() {
    const body = $('musicBody');
    body.innerHTML = `<div class="music-loading">Загрузка...</div>`;
    try {
      if (musicTab === 'songs') {
        musicSongs = await api('/api/music/songs');
        renderSongsList(musicSongs);
      } else if (musicTab === 'albums') {
        if (currentAlbum) {
          const songs = await api('/api/music/albums/' + encodeURIComponent(currentAlbum.album));
          renderSongsList(songs, `Альбом: ${currentAlbum.album}`);
        } else {
          musicAlbums = await api('/api/music/albums');
          renderAlbums();
        }
      } else if (musicTab === 'artists') {
        if (currentArtist) {
          const songs = await api('/api/music/artists/' + encodeURIComponent(currentArtist));
          renderSongsList(songs, `Исполнитель: ${currentArtist}`);
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

  function renderMusicTab() { loadMusicTab(); }

  function renderSongsList(songs, header, fromPlaylist) {
    const body = $('musicBody');
    const baseQueue = songs.map(s => ({ id: s.id, title: s.title, artist: s.artist, fileId: s.fileId }));
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
        <button class="music-item-add ${inPl?'on':''}" data-add="${i}" title="В плейлист">${inPl ? '✓' : '+'}</button>
      </div>`;
    });
    html += `</div>`;
    body.innerHTML = html;
    if (header) $('musicBack').onclick = () => { currentAlbum = null; currentArtist = null; currentPlaylist = null; loadMusicTab(); };
    body.querySelectorAll('[data-play]').forEach(el => el.onclick = () => {
      const i = +el.dataset.play;
      playTrack(songs[i], baseQueue, i);
    });
    body.querySelectorAll('[data-add]').forEach(el => el.onclick = (e) => {
      e.stopPropagation();
      const i = +el.dataset.add;
      pickerTrackId = songs[i].id;
      openPlaylistPicker(songs[i].id, fromPlaylist);
    });
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
      <div class="music-group-icon">+</div>
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

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // ============ PLAYER ============
  function bindPlayer() {
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      $('mpProgressFill').style.width = pct + '%';
      $('mpTimeCur').textContent = fmtTime(audio.currentTime);
    });
    audio.addEventListener('loadedmetadata', () => {
      $('mpTimeDur').textContent = fmtTime(audio.duration);
    });
    audio.addEventListener('ended', () => { nextTrack(); });
    audio.addEventListener('play', () => { $('mpPlay').textContent = '⏸️'; });
    audio.addEventListener('pause', () => { $('mpPlay').textContent = '▶️'; });
    $('mpPlay').onclick = () => { if (audio.paused) audio.play().catch(()=>{}); else audio.pause(); };
    $('mpStop').onclick = () => { audio.pause(); audio.currentTime = 0; currentTrack = null; $('musicPlayer').style.display = 'none'; if (navigator.mediaSession) navigator.mediaSession.metadata = null; };
    $('mpPrev').onclick = () => prevTrack();
    $('mpNext').onclick = () => nextTrack();
    $('mpProgress').onclick = (e) => {
      if (!audio.duration) return;
      const rect = $('mpProgress').getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      audio.currentTime = pct * audio.duration;
    };
    $('mpAdd').onclick = () => { if (currentTrack) openPlaylistPicker(currentTrack.id, false); };
    $('mpShare').onclick = () => {
      if (!currentTrack) return;
      const url = `https://t.me/Krista_server_bot`; // или ссылка на трек
      if (navigator.share) navigator.share({ title: `${currentTrack.artist} — ${currentTrack.title}`, text: `${currentTrack.artist} — ${currentTrack.title}` }).catch(()=>{});
      else { navigator.clipboard?.writeText(`${currentTrack.artist} — ${currentTrack.title}`); window.toast && window.toast('', 'Скопировано'); }
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
      currentTrack = track;
      currentPlaylistQueue = queue || [];
      currentQueueIndex = index != null ? index : -1;
      await audio.play();
      updatePlayerUI();
      setupMediaSession();
      // подсветка в списке
      document.querySelectorAll('.music-item').forEach(el => el.classList.remove('playing'));
      const idx = musicSongs.findIndex(s => s.id === track.id);
      if (idx >= 0) { const el = document.querySelector(`.music-item[data-i="${idx}"]`); if (el) el.classList.add('playing'); }
    } catch (e) {
      window.toast && window.toast('', e.message || 'Ошибка воспроизведения');
    }
  }

  function updatePlayerUI() {
    if (!currentTrack) return;
    $('musicPlayer').style.display = 'flex';
    const txt = `${currentTrack.artist} — ${currentTrack.title}`;
    $('mptTrack').textContent = txt;
    $('mptTrack').classList.remove('scrolling');
    // определяем, надо ли скроллить
    setTimeout(() => {
      const el = $('mptTrack'), wrap = $('mptText');
      if (el.scrollWidth > wrap.clientWidth) {
        const dist = wrap.clientWidth - el.scrollWidth - 10;
        el.style.setProperty('--scroll-dist', dist + 'px');
        el.classList.add('scrolling');
      }
    }, 50);
  }

  function nextTrack() {
    if (currentPlaylistQueue.length && currentQueueIndex >= 0 && currentQueueIndex < currentPlaylistQueue.length - 1) {
      const i = currentQueueIndex + 1;
      playTrack(currentPlaylistQueue[i], currentPlaylistQueue, i);
    } else { audio.pause(); }
  }
  function prevTrack() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (currentPlaylistQueue.length && currentQueueIndex > 0) {
      const i = currentQueueIndex - 1;
      playTrack(currentPlaylistQueue[i], currentPlaylistQueue, i);
    }
  }
  window.stopMusicPlayer = function() {
    try { audio.pause(); audio.src = ''; } catch {}
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
    currentTrack = null; currentPlaylistQueue = []; currentQueueIndex = -1;
    const p = $('musicPlayer'); if (p) p.style.display = 'none';
    if (navigator.mediaSession) navigator.mediaSession.metadata = null;
  };

  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist,
      album: currentTrack.album || ''
    });
    navigator.mediaSession.setActionHandler('play', () => audio.play().catch(()=>{}));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('stop', () => window.stopMusicPlayer());
  }

  // ============ ADD MUSIC ============
  window.openAddMusicModal = function() {
    $('musicAddErr').textContent = '';
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
      // публикация
      const pub = await api('/api/music/publish', { method:'POST', body: JSON.stringify({ token: pendingMusicToken }) });
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
      // получить содержимое каждого плейлиста — для проверки вхождения
      // (упрощённо: запрашиваем все сразу)
      const details = await Promise.all(pls.map(p => api('/api/music/playlists/' + p.id + '/tracks').catch(()=>({tracks:[]}))));
      if (!pls.length) { list.innerHTML = `<div class="music-empty" style="padding:20px">Нет плейлистов. Создай первый ниже.</div>`; return; }
      list.innerHTML = pls.map((p, i) => {
        const inPl = (details[i].tracks || []).some(t => t.id === trackId);
        return `<div class="plp-item ${inPl?'in':''}" data-id="${p.id}">
          <div class="plp-body"><div class="plp-name">${esc(p.name)}</div><div class="plp-count">${p.count} ${plural(p.count,'песня','песни','песен')}</div></div>
          <div class="plp-check">${inPl ? '✓' : '+'}</div>
          <button class="plp-del" data-del="${p.id}" title="Удалить">✕</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.plp-item').forEach(el => el.onclick = async (e) => {
        if (e.target.closest('[data-del]')) return;
        const id = el.dataset.id;
        try { await api('/api/music/playlists/' + id + '/tracks', { method:'POST', body: JSON.stringify({ trackId }) });
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
    if (currentTab === 'Music') loadMusicTab();
  };

  console.log('[Music] v1.25 loaded');
})();
