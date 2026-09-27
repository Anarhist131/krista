// ============================================================
//  КРИСТА.ФРИРУНЕТ · music.js v5.0
//  Полноценный музыкальный плеер
// ============================================================
(function() {
  'use strict';

  // ============================================================
  //  СОСТОЯНИЕ
  // ============================================================
  let musicTab = 'songs';
  let musicSongs = [], musicAlbums = [], musicArtists = [], musicPlaylists = [];
  let currentAlbum = null, currentArtist = null, currentPlaylist = null;
  let playlistTrackIds = new Set();
  let pendingMusicToken = null;
  let pickerTrackId = null;

  const audio = new Audio();
  audio.preload = 'metadata';

  let currentTrack = null;
  let currentQueue = [];
  let originalQueue = [];
  let currentQueueIndex = -1;
  let currentBlobUrl = null;

  let shuffleOn = localStorage.getItem('krista_music_shuffle') === '1';
  let repeatMode = localStorage.getItem('krista_music_repeat') || 'off';
  let playbackSpeed = parseFloat(localStorage.getItem('krista_music_speed')) || 1;
  let savedVolume = parseFloat(localStorage.getItem('krista_music_volume'));
  if (isNaN(savedVolume)) savedVolume = 1;
  audio.volume = savedVolume;

  let wakeLock = null;
  let progressDragging = false;

  // ============================================================
  //  УТИЛИТЫ
  // ============================================================
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function fmtTime(s) { if (!isFinite(s)) return '0:00'; const m = Math.floor(s/60), ss = Math.floor(s%60); return m + ':' + String(ss).padStart(2,'0'); }
  function fmtSize(n) { if (!n) return '0 Б'; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n/1024).toFixed(1) + ' КБ'; return (n/1048576).toFixed(2) + ' МБ'; }
  function plural(n, one, few, many) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return one; if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few; return many; }
  function authHdr() { return window.token ? { Authorization: 'Bearer ' + window.token } : {}; }
  function shuffleArr(a) { const c = a.slice(); for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; }
  function musicUrl(id) { return id ? `/api/music/file/${encodeURIComponent(id)}?token=${encodeURIComponent(window.token || '')}` : ''; }

  function mimeByFilename(name) {
    const f = (name || '').toLowerCase();
    if (f.endsWith('.mp3')) return 'audio/mpeg';
    if (f.endsWith('.ogg') || f.endsWith('.oga')) return 'audio/ogg';
    if (f.endsWith('.m4a')) return 'audio/mp4';
    if (f.endsWith('.wav')) return 'audio/wav';
    if (f.endsWith('.flac')) return 'audio/flac';
    if (f.endsWith('.aac')) return 'audio/aac';
    if (f.endsWith('.opus')) return 'audio/opus';
    return 'audio/mpeg';
  }

  async function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, authHdr(), opts.headers || {});
    const r = await fetch(url, opts);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Ошибка');
    return d;
  }

  function toast(t) { if (window.toast) window.toast(t); }
  function closeModal(id) { if (window.closeModal) window.closeModal(id); }

  // ============================================================
  //  ПОСТРОЕНИЕ UI (динамически)
  // ============================================================
  function buildMusicUI() {
    const el = $('musicContainer');
    if (!el || el._built) return;
    el._built = true;

    el.innerHTML = `
      <div style="display:flex;gap:4px;padding:8px 10px;overflow-x:auto;flex-shrink:0;border-bottom:1px solid var(--glass-border);background:var(--glass);scrollbar-width:none" id="musicTabs">
        <button style="flex-shrink:0;background:linear-gradient(135deg,var(--accent),var(--accent-2));border:none;color:var(--on-accent);padding:7px 14px;border-radius:14px;font-family:var(--font-head);font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap" id="musicAddBtn">＋ Песня</button>
        <div class="music-tab active" data-t="songs">Песни</div>
        <div class="music-tab" data-t="albums">Альбомы</div>
        <div class="music-tab" data-t="artists">Исполнители</div>
        <div class="music-tab" data-t="playlists">Плейлисты</div>
      </div>
      <div style="flex:1;overflow-y:auto;min-height:0;padding:8px 0 12px" id="musicBody"></div>
      <div id="musicMiniPlayer" style="display:none;flex-shrink:0;margin:0 10px 10px;padding:10px;background:var(--glass-2);backdrop-filter:blur(var(--blur));border:1px solid var(--glass-border);border-radius:var(--rad);flex-direction:column;gap:8px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px">
          <div id="miniThumb" style="width:36px;height:36px;flex-shrink:0;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-size:16px;font-weight:700;text-transform:uppercase">♪</div>
          <div style="flex:1;min-width:0;overflow:hidden;position:relative;height:36px">
            <div style="position:absolute;top:0;left:0;right:0;font-family:var(--font-head);font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="miniTitle">—</div>
            <div style="position:absolute;bottom:0;left:0;right:0;font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="miniArtist">—</div>
          </div>
          <button class="music-mini-btn" id="miniPlay">▶</button>
          <button class="music-mini-btn" id="miniClose" title="Стоп">✕</button>
        </div>
      </div>
    `;

    // Стили
    if (!$('musicStyles')) {
      const st = document.createElement('style');
      st.id = 'musicStyles';
      st.textContent = `
        .music-tab{flex-shrink:0;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text-2);padding:7px 14px;border-radius:14px;font-family:var(--font-body);font-size:12px;cursor:pointer;white-space:nowrap;transition:all .15s}
        .music-tab.active{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent);border-color:transparent;font-weight:700;font-family:var(--font-head)}
        .music-item{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--glass);border:1px solid var(--glass-border);border-radius:var(--rad);margin:0 10px 6px;cursor:pointer;transition:all .15s}
        .music-item:active{background:var(--glass-2)}
        .music-item.playing{border-color:var(--accent);background:var(--accent-soft)}
        .music-item-icon{width:40px;height:40px;flex-shrink:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-family:var(--font-head)}
        .music-item-body{flex:1;min-width:0}
        .music-item-title{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-head)}
        .music-item-meta{font-size:11px;color:var(--text-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .music-item-actions{display:flex;gap:4px;flex-shrink:0}
        .music-item-btn{width:32px;height:32px;flex-shrink:0;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--accent);border-radius:50%;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-weight:700;padding:0}
        .music-item-btn.on{background:var(--accent);color:var(--on-accent);border-color:transparent}
        .music-item-btn.dl{color:var(--text-2);font-size:12px}
        .music-group-item{display:flex;align-items:center;gap:12px;padding:12px;background:var(--glass);border:1px solid var(--glass-border);border-radius:var(--rad);margin:0 10px 6px;cursor:pointer}
        .music-group-item:active{background:var(--glass-2)}
        .music-group-icon{width:46px;height:46px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
        .music-group-body{flex:1;min-width:0}
        .music-group-name{font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-head)}
        .music-group-meta{font-size:11px;color:var(--text-3);margin-top:2px}
        .music-group-arrow{color:var(--text-3);font-size:18px;flex-shrink:0}
        .music-back{padding:8px 14px;font-size:12px;color:var(--accent);cursor:pointer;font-family:var(--font-head);font-weight:600;display:inline-flex;align-items:center;gap:6px}
        .music-empty{color:var(--text-3);text-align:center;padding:40px 20px;font-size:12px;font-style:italic}
        .music-loading{color:var(--text-3);text-align:center;padding:30px 20px;font-size:12px;font-style:italic}
        .music-mini-btn{background:var(--glass-2);border:1px solid var(--glass-border);color:var(--accent);width:34px;height:34px;border-radius:50%;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;font-family:var(--font-head)}
        .music-mini-btn:active{background:var(--accent);color:var(--on-accent)}

        /* ПОЛНЫЙ ПЛЕЕР */
        #musicFullPlayer{position:fixed;inset:0;z-index:400;background:linear-gradient(180deg,var(--bg-2),var(--bg-1));display:none;flex-direction:column;padding:16px;padding-top:calc(16px + env(safe-area-inset-top,0));padding-bottom:calc(16px + env(safe-area-inset-bottom,0));overflow:hidden}
        #musicFullPlayer.show{display:flex;animation:musicFullIn .3s cubic-bezier(.32,.72,0,1)}
        @keyframes musicFullIn{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}

        .full-top{display:flex;align-items:center;gap:12px;flex-shrink:0;margin-bottom:16px}
        .full-close{width:44px;height:44px;border-radius:50%;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text);font-size:18px;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;font-family:var(--font-head)}
        .full-close:active{background:var(--glass-3)}
        .full-label{flex:1;text-align:center;font-size:11px;font-weight:700;color:var(--text-3);letter-spacing:2px;text-transform:uppercase;font-family:var(--font-head)}
        .full-menu{width:44px;height:44px;border-radius:50%;background:transparent;border:none;color:var(--text-3);font-size:20px;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}

        .full-cover{width:min(72vw,320px);aspect-ratio:1;border-radius:24px;margin:0 auto;display:flex;align-items:center;justify-content:center;font-size:100px;color:rgba(255,255,255,.35);flex-shrink:0;position:relative;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);background:linear-gradient(135deg,var(--accent),var(--accent-2))}
        .full-cover.spin{animation:coverFloat 6s ease-in-out infinite}
        @keyframes coverFloat{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-6px) scale(1.01)}}
        .full-cover .cover-emoji{font-size:110px;opacity:.45;filter:drop-shadow(0 4px 20px rgba(0,0,0,.4))}

        .full-meta{text-align:center;margin-top:24px;padding:0 12px;flex-shrink:0}
        .full-title{font-size:20px;font-weight:800;color:var(--text);line-height:1.25;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin-bottom:6px;font-family:var(--font-head)}
        .full-artist{font-size:14px;color:var(--text-2);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .full-album{font-size:12px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic}

        .full-progress{margin-top:auto;padding-top:20px;flex-shrink:0}
        .full-bar{height:6px;background:rgba(255,255,255,.1);border-radius:3px;position:relative;cursor:pointer;touch-action:none}
        .full-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),#7ac0f0);border-radius:3px;position:relative;width:0%;box-shadow:0 0 12px var(--accent-glow);pointer-events:none}
        .full-bar-fill::after{content:'';position:absolute;right:-7px;top:50%;transform:translateY(-50%);width:16px;height:16px;background:#fff;border-radius:50%;box-shadow:0 0 8px var(--accent-glow),0 2px 4px rgba(0,0,0,.4)}
        .full-times{display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-top:8px;font-variant-numeric:tabular-nums;font-weight:600;font-family:var(--font-head)}

        .full-controls{display:flex;align-items:center;justify-content:space-between;margin-top:18px;padding:0 8px;flex-shrink:0}
        .full-ctrl{width:52px;height:52px;border-radius:50%;background:transparent;border:none;color:var(--text-2);font-size:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-family:inherit;transition:all .15s}
        .full-ctrl:active{transform:scale(.9);background:var(--glass-2)}
        .full-ctrl.on{color:var(--accent)}
        .full-ctrl-main{width:76px;height:76px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent);font-size:30px;box-shadow:0 8px 28px var(--accent-glow)}
        .full-ctrl-main:active{transform:scale(.92)}

        .full-extras{display:flex;align-items:center;gap:12px;margin-top:16px;padding:0 8px;flex-shrink:0;justify-content:space-between}
        .full-extra-btn{background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text-2);font-size:12px;font-family:var(--font-head);font-weight:700;padding:8px 12px;border-radius:12px;cursor:pointer;flex-shrink:0;min-width:44px;text-align:center}
        .full-extra-btn:active{background:var(--glass-3)}
        .full-extra-btn.on{background:var(--accent);color:var(--on-accent);border-color:transparent}
        .full-volume{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
        .full-volume .vicon{font-size:16px;flex-shrink:0}
        .vol-slider{flex:1;height:5px;background:rgba(255,255,255,.1);border-radius:3px;position:relative;cursor:pointer;touch-action:none;min-width:0}
        .vol-fill{height:100%;background:var(--accent);border-radius:3px;width:100%;position:relative;pointer-events:none}
        .vol-fill::after{content:'';position:absolute;right:-6px;top:50%;transform:translateY(-50%);width:12px;height:12px;background:#fff;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,.4)}
      `;
      document.head.appendChild(st);
    }

    // Отдельный плеер
    if (!$('musicFullPlayer')) {
      const fp = document.createElement('div');
      fp.id = 'musicFullPlayer';
      fp.innerHTML = `
        <div class="full-top">
          <button class="full-close" id="fullDown">⌄</button>
          <div class="full-label">Сейчас играет</div>
          <div class="full-menu"></div>
        </div>
        <div class="full-cover" id="fullCover"><span class="cover-emoji">♪</span></div>
        <div class="full-meta">
          <div class="full-title" id="fullTitle">—</div>
          <div class="full-artist" id="fullArtist">—</div>
          <div class="full-album" id="fullAlbum"></div>
        </div>
        <div class="full-progress">
          <div class="full-bar" id="fullBar"><div class="full-bar-fill" id="fullBarFill"></div></div>
          <div class="full-times"><span id="fullTimeCur">0:00</span><span id="fullTimeDur">0:00</span></div>
        </div>
        <div class="full-controls">
          <button class="full-ctrl" id="fullShuffle" title="Перемешать">🔀</button>
          <button class="full-ctrl" id="fullPrev">⏮</button>
          <button class="full-ctrl full-ctrl-main" id="fullPlay">▶</button>
          <button class="full-ctrl" id="fullNext">⏭</button>
          <button class="full-ctrl" id="fullRepeat" title="Повтор">🔁</button>
        </div>
        <div class="full-extras">
          <button class="full-extra-btn" id="fullQueue" title="Очередь">📋</button>
          <div class="full-volume">
            <span class="vicon" id="fullVolIcon">🔊</span>
            <div class="vol-slider" id="fullVolBar"><div class="vol-fill" id="fullVolFill"></div></div>
          </div>
          <button class="full-extra-btn" id="fullSpeed" title="Скорость">1×</button>
        </div>
      `;
      document.body.appendChild(fp);
    }

    // Модалка добавления песни
    if (!$('musicAddModal2')) {
      const am = document.createElement('div');
      am.className = 'ov';
      am.id = 'musicAddModal2';
      am.innerHTML = `
        <div class="mod">
          <h3>ДОБАВИТЬ ПЕСНЮ</h3>
          <div class="err" id="musicAddErr2"></div>
          <input type="file" id="musicFileInput2" accept="audio/*" style="padding:8px 4px">
          <input type="text" id="musicArtist2" placeholder="Исполнитель" maxlength="80">
          <input type="text" id="musicAlbum2" placeholder="Альбом (Сингл)" maxlength="80">
          <input type="text" id="musicTitle2" placeholder="Название" maxlength="120">
          <input type="number" id="musicTrackNum2" placeholder="Номер трека" min="1" value="1">
          <div id="musicFileNamePreview2" style="font-size:11px;color:var(--text-3);font-style:italic;padding:4px 6px 10px"></div>
          <div class="row">
            <button onclick="closeModal('musicAddModal2')">[ ОТМЕНА ]</button>
            <button class="primary" onclick="window.musicStageAndPublish()">[ ОПУБЛИКОВАТЬ ]</button>
          </div>
        </div>`;
      document.body.appendChild(am);
      am.addEventListener('click', e => { if (e.target === am) am.classList.remove('active'); });
    }

    // Модалка плейлиста
    if (!$('playlistPickerModal2')) {
      const pm = document.createElement('div');
      pm.className = 'ov';
      pm.id = 'playlistPickerModal2';
      pm.innerHTML = `
        <div class="mod">
          <h3>ВЫБРАТЬ ПЛЕЙЛИСТ</h3>
          <div id="playlistPickerList2" style="max-height:280px;overflow-y:auto"></div>
          <input type="text" id="newPlaylistName2" placeholder="Новый плейлист..." maxlength="60" style="margin-top:8px">
          <div class="row" style="margin-top:8px">
            <button class="primary" onclick="window.musicCreatePlaylist()">[ СОЗДАТЬ ]</button>
            <button onclick="closeModal('playlistPickerModal2')">[ ОТМЕНА ]</button>
          </div>
        </div>`;
      document.body.appendChild(pm);
      pm.addEventListener('click', e => { if (e.target === pm) pm.classList.remove('active'); });
    }

    // Модалка очереди
    if (!$('queueModal2')) {
      const qm = document.createElement('div');
      qm.className = 'ov';
      qm.id = 'queueModal2';
      qm.innerHTML = `
        <div class="mod">
          <h3>ОЧЕРЕДЬ</h3>
          <div id="queueList2" style="max-height:60vh;overflow-y:auto"></div>
          <div class="row" style="margin-top:14px"><button onclick="closeModal('queueModal2')">[ ЗАКРЫТЬ ]</button></div>
        </div>`;
      document.body.appendChild(qm);
      qm.addEventListener('click', e => { if (e.target === qm) qm.classList.remove('active'); });
    }

    // Привязки
    $('musicAddBtn').onclick = openAddMusicModal;
    document.querySelectorAll('#musicTabs .music-tab').forEach(t => {
      t.onclick = () => {
        musicTab = t.dataset.t;
        document.querySelectorAll('#musicTabs .music-tab').forEach(x => x.classList.toggle('active', x === t));
        currentAlbum = null; currentArtist = null; currentPlaylist = null;
        loadMusicTab();
      };
    });

    bindPlayerEvents();
    bindFullPlayer();
    applyPlayerState();
  }

  // ============================================================
  //  ЗАГРУЗКА ТАБОВ
  // ============================================================
  window.initMusic = async function() {
    buildMusicUI();
    await loadMusicTab();
  };

  async function loadMusicTab() {
    const body = $('musicBody');
    if (!body) return;
    body.innerHTML = '<div class="music-loading">Загрузка...</div>';
    try {
      if (musicTab === 'songs') {
        musicSongs = await api('/api/music/songs');
        renderSongsList(musicSongs, null, false);
      } else if (musicTab === 'albums') {
        if (currentAlbum) {
          const s = await api('/api/music/albums/' + encodeURIComponent(currentAlbum.album));
          renderSongsList(s, 'Альбом: ' + currentAlbum.album, false);
        } else {
          musicAlbums = await api('/api/music/albums');
          renderAlbums();
        }
      } else if (musicTab === 'artists') {
        if (currentArtist) {
          const s = await api('/api/music/artists/' + encodeURIComponent(currentArtist));
          renderSongsList(s, 'Исполнитель: ' + currentArtist, false);
        } else {
          musicArtists = await api('/api/music/artists');
          renderArtists();
        }
      } else if (musicTab === 'playlists') {
        if (currentPlaylist) {
          const d = await api('/api/music/playlists/' + currentPlaylist.id + '/tracks');
          playlistTrackIds = new Set(d.tracks.map(t => t.id));
          renderSongsList(d.tracks, 'Плейлист: ' + d.name, true);
        } else {
          musicPlaylists = await api('/api/music/playlists');
          renderPlaylists();
        }
      }
    } catch (e) { body.innerHTML = `<div class="music-empty">${esc(e.message)}</div>`; }
  }

  function renderSongsList(songs, header, fromPlaylist) {
    const body = $('musicBody');
    const queue = songs.map(s => ({ id: s.id, tgFileId: s.tgFileId || s.fileId, title: s.title, artist: s.artist, album: s.album, filename: s.filename }));
    let html = '';
    if (header) html += `<div class="music-back" id="musicBack">‹ Назад</div>`;
    if (!songs.length) {
      html += `<div class="music-empty">Пусто<br><button onclick="window.openAddMusicModal()" style="margin-top:14px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent);border:none;padding:10px 22px;border-radius:14px;font-family:var(--font-head);font-weight:700;font-size:12px;cursor:pointer">Добавить песню</button></div>`;
      body.innerHTML = html;
      if (header) $('musicBack').onclick = () => { currentAlbum = null; currentArtist = null; currentPlaylist = null; loadMusicTab(); };
      return;
    }
    html += '<div>';
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
          <button class="music-item-btn ${inPl?'on':''}" data-add="${i}" title="В плейлист">${inPl?'✓':'＋'}</button>
        </div>
      </div>`;
    });
    html += '</div>';
    body.innerHTML = html;
    if (header) $('musicBack').onclick = () => { currentAlbum = null; currentArtist = null; currentPlaylist = null; loadMusicTab(); };
    body.querySelectorAll('[data-play]').forEach(el => el.onclick = () => playTrack(songs[+el.dataset.play], queue, +el.dataset.play));
    body.querySelectorAll('[data-dl]').forEach(el => el.onclick = e => { e.stopPropagation(); downloadTrack(songs[+el.dataset.dl], e.currentTarget); });
    body.querySelectorAll('[data-add]').forEach(el => el.onclick = e => { e.stopPropagation(); pickerTrackId = songs[+el.dataset.add].id; openPlaylistPicker(songs[+el.dataset.add].id, fromPlaylist); });
  }

  function renderAlbums() {
    const body = $('musicBody');
    if (!musicAlbums.length) { body.innerHTML = `<div class="music-empty">Нет альбомов</div>`; return; }
    body.innerHTML = musicAlbums.map((a, i) => `<div class="music-group-item" data-i="${i}"><div class="music-group-icon">💿</div><div class="music-group-body"><div class="music-group-name">${esc(a.album)}</div><div class="music-group-meta">${esc(a.artist)} · ${a.count} ${plural(a.count,'песня','песни','песен')}</div></div><div class="music-group-arrow">›</div></div>`).join('');
    body.querySelectorAll('.music-group-item').forEach(el => el.onclick = () => { currentAlbum = musicAlbums[+el.dataset.i]; loadMusicTab(); });
  }

  function renderArtists() {
    const body = $('musicBody');
    if (!musicArtists.length) { body.innerHTML = `<div class="music-empty">Нет исполнителей</div>`; return; }
    body.innerHTML = musicArtists.map((a, i) => `<div class="music-group-item" data-i="${i}"><div class="music-group-icon">🎤</div><div class="music-group-body"><div class="music-group-name">${esc(a.artist)}</div><div class="music-group-meta">${a.count} ${plural(a.count,'песня','песни','песен')}</div></div><div class="music-group-arrow">›</div></div>`).join('');
    body.querySelectorAll('.music-group-item').forEach(el => el.onclick = () => { currentArtist = musicArtists[+el.dataset.i].artist; loadMusicTab(); });
  }

  function renderPlaylists() {
    const body = $('musicBody');
    let html = `<div class="music-group-item" id="plCreateNew" style="border-style:dashed"><div class="music-group-icon">＋</div><div class="music-group-body"><div class="music-group-name">Новый плейлист</div></div></div>`;
    musicPlaylists.forEach((p, i) => { html += `<div class="music-group-item" data-i="${i}"><div class="music-group-icon">📁</div><div class="music-group-body"><div class="music-group-name">${esc(p.name)}</div><div class="music-group-meta">${p.count} ${plural(p.count,'песня','песни','песен')}</div></div><div class="music-group-arrow">›</div></div>`; });
    body.innerHTML = html;
    $('plCreateNew').onclick = async () => {
      const name = prompt('Название плейлиста:');
      if (!name || !name.trim()) return;
      try { await api('/api/music/playlists', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); loadMusicTab(); } catch (e) { toast(e.message); }
    };
    body.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { currentPlaylist = musicPlaylists[+el.dataset.i]; loadMusicTab(); });
  }

  // ============================================================
  //  ВОСПРОИЗВЕДЕНИЕ
  // ============================================================
  async function playTrack(track, queue, index) {
    try {
      if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
      const realId = track.tgFileId || track.fileId;
      if (!realId) throw new Error('Файл недоступен');

      // Показываем мини-плеер с лоадером
      $('musicMiniPlayer').style.display = 'flex';
      $('miniTitle').textContent = track.title || '—';
      $('miniArtist').textContent = track.artist || '';
      $('miniPlay').textContent = '⏳';

      const res = await fetch(musicUrl(realId), { headers: authHdr() });
      if (!res.ok) throw new Error('Файл недоступен (возможно, >20 МБ)');
      const blob = await res.blob();
      const mime = mimeByFilename(track.filename);
      const ab = new Blob([blob], { type: mime });
      currentBlobUrl = URL.createObjectURL(ab);
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
      updateMiniPlayer();
      updateFullPlayer();
      setupMediaSession();
      updatePlayingHighlight();
    } catch (e) { toast(e.message || 'Ошибка воспроизведения'); $('miniPlay').textContent = '▶'; }
  }

  function updateMiniPlayer() {
    if (!currentTrack) return;
    const mp = $('musicMiniPlayer');
    if (mp) mp.style.display = 'flex';
    if ($('miniTitle')) $('miniTitle').textContent = currentTrack.title || '—';
    if ($('miniArtist')) $('miniArtist').textContent = currentTrack.artist || '';
    if ($('miniPlay')) $('miniPlay').textContent = audio.paused ? '▶' : '⏸';
    if ($('miniThumb')) $('miniThumb').textContent = (currentTrack.artist || '♪').trim()[0] || '♪';
  }

  function updateFullPlayer() {
    if (!currentTrack) return;
    if ($('fullCover')) $('fullCover').innerHTML = `<span class="cover-emoji">${(currentTrack.artist || '♪').trim()[0] || '♪'}</span>`;
    if ($('fullTitle')) $('fullTitle').textContent = currentTrack.title || '—';
    if ($('fullArtist')) $('fullArtist').textContent = currentTrack.artist || '';
    if ($('fullAlbum')) $('fullAlbum').textContent = currentTrack.album || '';
    if ($('fullPlay')) $('fullPlay').textContent = audio.paused ? '▶' : '⏸';
    if ($('fullShuffle')) $('fullShuffle').classList.toggle('on', shuffleOn);
    if ($('fullRepeat')) {
      $('fullRepeat').classList.toggle('on', repeatMode !== 'off');
      $('fullRepeat').textContent = repeatMode === 'one' ? '🔂' : '🔁';
    }
    if ($('fullCover')) $('fullCover').classList.toggle('spin', !audio.paused);
  }

  function updatePlayingHighlight() {
    document.querySelectorAll('.music-item').forEach(el => el.classList.remove('playing'));
    if (!currentTrack || !musicSongs) return;
    const idx = musicSongs.findIndex(s => s.id === currentTrack.id);
    if (idx >= 0) {
      const el = document.querySelector(`.music-item[data-i="${idx}"]`);
      if (el) el.classList.add('playing');
    }
  }

  function updateProgressUI() {
    const cur = audio.currentTime || 0;
    const dur = audio.duration || 0;
    const pct = dur ? (cur / dur * 100) : 0;
    if ($('fullBarFill')) $('fullBarFill').style.width = pct + '%';
    if ($('fullTimeCur')) $('fullTimeCur').textContent = fmtTime(cur);
    if ($('fullTimeDur')) $('fullTimeDur').textContent = fmtTime(dur);
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && dur) {
      try { navigator.mediaSession.setPositionState({ duration: dur, playbackRate: audio.playbackRate, position: cur }); } catch {}
    }
  }

  // ============================================================
  //  НАВИГАЦИЯ
  // ============================================================
  function nextTrack(auto) {
    if (!currentQueue.length) return;
    if (repeatMode === 'one' && auto) { audio.currentTime = 0; audio.play().catch(()=>{}); return; }
    if (currentQueueIndex < currentQueue.length - 1) { playTrack(currentQueue[currentQueueIndex + 1], currentQueue, currentQueueIndex + 1); }
    else if (repeatMode === 'all') { playTrack(currentQueue[0], currentQueue, 0); }
    else if (!auto) { playTrack(currentQueue[0], currentQueue, 0); }
    else { audio.pause(); }
  }

  function prevTrack() {
    if (!currentQueue.length) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (currentQueueIndex > 0) { playTrack(currentQueue[currentQueueIndex - 1], currentQueue, currentQueueIndex - 1); }
    else if (repeatMode === 'all') { playTrack(currentQueue[currentQueue.length - 1], currentQueue, currentQueue.length - 1); }
  }

  function onTrackEnded() {
    if (repeatMode === 'one') { audio.currentTime = 0; audio.play().catch(()=>{}); return; }
    if (currentQueue.length && currentQueueIndex >= 0 && currentQueueIndex < currentQueue.length - 1) {
      playTrack(currentQueue[currentQueueIndex + 1], currentQueue, currentQueueIndex + 1);
      return;
    }
    if (repeatMode === 'all' && currentQueue.length > 1) { playTrack(currentQueue[0], currentQueue, 0); return; }
    audio.pause();
    updateMiniPlayer();
    updateFullPlayer();
  }

  // ============================================================
  //  СОБЫТИЯ AUDIO
  // ============================================================
  function bindPlayerEvents() {
    audio.addEventListener('timeupdate', updateProgressUI);
    audio.addEventListener('loadedmetadata', updateProgressUI);
    audio.addEventListener('ended', onTrackEnded);
    audio.addEventListener('play', () => { updateMiniPlayer(); updateFullPlayer(); requestWakeLock(); });
    audio.addEventListener('pause', () => { updateMiniPlayer(); updateFullPlayer(); releaseWakeLock(); });
    audio.addEventListener('error', () => { toast('Ошибка воспроизведения'); updateMiniPlayer(); });
  }

  // ============================================================
  //  МИНИ-ПЛЕЕР
  // ============================================================
  window.musicMiniToggle = function() { if (audio.paused) audio.play().catch(()=>{}); else audio.pause(); };
  window.musicMiniOpen = function() {
    if (!currentTrack) return;
    const fp = $('musicFullPlayer');
    fp.classList.add('show');
    updateFullPlayer();
  };

  function bindFullPlayer() {
    $('miniPlay').onclick = e => { e.stopPropagation(); window.musicMiniToggle(); };
    $('miniClose').onclick = e => { e.stopPropagation(); window.stopMusicPlayer(); };
    $('musicMiniPlayer').onclick = e => {
      if (e.target.closest('button')) return;
      window.musicMiniOpen();
    };

    $('fullDown').onclick = () => $('musicFullPlayer').classList.remove('show');
    $('fullPlay').onclick = () => window.musicMiniToggle();
    $('fullPrev').onclick = () => prevTrack();
    $('fullNext').onclick = () => nextTrack(false);
    $('fullShuffle').onclick = () => {
      shuffleOn = !shuffleOn;
      localStorage.setItem('krista_music_shuffle', shuffleOn ? '1' : '0');
      if (shuffleOn && currentQueue.length > 1) {
        const cur = currentQueue[currentQueueIndex];
        const rest = currentQueue.filter((_, i) => i !== currentQueueIndex);
        const mixed = shuffleArr(rest);
        currentQueue = cur ? [cur, ...mixed] : mixed;
        currentQueueIndex = cur ? 0 : -1;
      } else if (!shuffleOn && originalQueue.length) {
        currentQueue = originalQueue.slice();
        currentQueueIndex = currentTrack ? currentQueue.findIndex(t => t.id === currentTrack.id) : -1;
      }
      applyPlayerState();
      updateFullPlayer();
      toast(shuffleOn ? '🔀 Перемешать вкл' : '🔀 Перемешать выкл');
    };
    $('fullRepeat').onclick = () => {
      repeatMode = repeatMode === 'off' ? 'all' : (repeatMode === 'all' ? 'one' : 'off');
      localStorage.setItem('krista_music_repeat', repeatMode);
      audio.loop = repeatMode === 'one';
      updateFullPlayer();
      toast(repeatMode === 'off' ? 'Повтор выкл' : (repeatMode === 'all' ? 'Повтор всех' : 'Повтор одного'));
    };
    $('fullQueue').onclick = () => { openQueueModal(); };
    $('fullSpeed').onclick = () => {
      const speeds = [0.75, 1, 1.25, 1.5, 2];
      const idx = speeds.indexOf(playbackSpeed);
      playbackSpeed = speeds[(idx + 1) % speeds.length];
      audio.playbackRate = playbackSpeed;
      localStorage.setItem('krista_music_speed', String(playbackSpeed));
      applyPlayerState();
      toast('Скорость ' + playbackSpeed + '×');
    };

    bindSeekBar($('fullBar'), (pct) => { if (audio.duration) audio.currentTime = pct * audio.duration; });
    bindVolumeBar($('fullVolBar'), (pct) => {
      savedVolume = pct;
      audio.volume = savedVolume;
      localStorage.setItem('krista_music_volume', String(savedVolume));
      applyPlayerState();
    });
  }

  function bindSeekBar(bar, cb) {
    if (!bar) return;
    const getPct = e => {
      const r = bar.getBoundingClientRect();
      const x = e.touches ? e.touches[0].clientX : (e.changedTouches ? e.changedTouches[0].clientX : e.clientX);
      return Math.max(0, Math.min(1, (x - r.left) / r.width));
    };
    bar.addEventListener('click', e => cb(getPct(e)));
    bar.addEventListener('touchstart', e => { e.preventDefault(); cb(getPct(e)); }, { passive: false });
    let dragging = false;
    bar.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); cb(getPct(e)); } }, { passive: false });
    bar.addEventListener('touchend', () => { dragging = false; });
  }

  function bindVolumeBar(bar, cb) {
    if (!bar) return;
    const getPct = e => {
      const r = bar.getBoundingClientRect();
      const x = e.touches ? e.touches[0].clientX : (e.changedTouches ? e.changedTouches[0].clientX : e.clientX);
      return Math.max(0, Math.min(1, (x - r.left) / r.width));
    };
    bar.addEventListener('click', e => cb(getPct(e)));
    let dragging = false;
    bar.addEventListener('touchstart', e => { dragging = true; e.preventDefault(); cb(getPct(e)); }, { passive: false });
    bar.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); cb(getPct(e)); } }, { passive: false });
    bar.addEventListener('touchend', () => { dragging = false; });
  }

  function applyPlayerState() {
    if ($('fullShuffle')) $('fullShuffle').classList.toggle('on', shuffleOn);
    if ($('fullRepeat')) {
      $('fullRepeat').classList.remove('on');
      if (repeatMode === 'off') $('fullRepeat').textContent = '🔁';
      else if (repeatMode === 'all') { $('fullRepeat').classList.add('on'); $('fullRepeat').textContent = '🔁'; }
      else { $('fullRepeat').classList.add('on'); $('fullRepeat').textContent = '🔂'; }
    }
    if ($('fullSpeed')) {
      $('fullSpeed').textContent = playbackSpeed + '×';
      $('fullSpeed').classList.toggle('on', playbackSpeed !== 1);
    }
    if ($('fullVolFill')) $('fullVolFill').style.width = (savedVolume * 100) + '%';
    if ($('fullVolIcon')) $('fullVolIcon').textContent = savedVolume === 0 ? '🔇' : savedVolume < 0.5 ? '🔉' : '🔊';
    audio.playbackRate = playbackSpeed;
  }

  window.stopMusicPlayer = function() {
    try { audio.pause(); audio.src = ''; } catch {}
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
    currentTrack = null;
    currentQueue = [];
    originalQueue = [];
    currentQueueIndex = -1;
    if ($('musicMiniPlayer')) $('musicMiniPlayer').style.display = 'none';
    if ($('musicFullPlayer')) $('musicFullPlayer').classList.remove('show');
    if (navigator.mediaSession) navigator.mediaSession.metadata = null;
    releaseWakeLock();
    updatePlayingHighlight();
  };

  // ============================================================
  //  MEDIA SESSION
  // ============================================================
  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title, artist: currentTrack.artist, album: currentTrack.album || ''
    });
    try {
      navigator.mediaSession.setActionHandler('play', () => audio.play().catch(()=>{}));
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
      navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
      navigator.mediaSession.setActionHandler('stop', () => window.stopMusicPlayer());
    } catch {}
  }

  // ============================================================
  //  WAKE LOCK
  // ============================================================
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { if (wakeLock) return; wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
  }
  function releaseWakeLock() { if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && currentTrack && !audio.paused) requestWakeLock(); });

  // ============================================================
  //  ОЧЕРЕДЬ
  // ============================================================
  function openQueueModal() {
    const list = $('queueList2');
    if (!list) return;
    if (!currentQueue.length) list.innerHTML = '<div class="music-empty">Очередь пуста</div>';
    else {
      list.innerHTML = currentQueue.map((t, i) => {
        const playing = currentTrack && t.id === currentTrack.id;
        return `<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:10px;margin-bottom:5px;cursor:pointer;${playing ? 'border-color:var(--accent)' : ''}" data-qi="${i}"><div style="width:24px;text-align:center;font-family:var(--font-head);font-size:11px;color:${playing ? 'var(--accent)' : 'var(--text-3)'};flex-shrink:0">${playing ? '▶' : (i + 1)}</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-head)">${esc(t.title)}</div><div style="font-size:11px;color:var(--text-3);margin-top:1px">${esc(t.artist)}</div></div></div>`;
      }).join('');
      list.querySelectorAll('[data-qi]').forEach(el => el.onclick = () => { playTrack(currentQueue[+el.dataset.qi], currentQueue, +el.dataset.qi); closeModal('queueModal2'); });
    }
    $('queueModal2').classList.add('active');
  }

  // ============================================================
  //  ДОБАВЛЕНИЕ МУЗЫКИ
  // ============================================================
  window.openAddMusicModal = function() {
    const err = $('musicAddErr2');
    if (!err) return;
    err.textContent = '';
    $('musicFileInput2').value = '';
    $('musicArtist2').value = '';
    $('musicAlbum2').value = '';
    $('musicTitle2').value = '';
    $('musicTrackNum2').value = '1';
    $('musicFileNamePreview2').textContent = '';
    pendingMusicToken = null;
    $('musicAddModal2').classList.add('active');
  };

  function sanitizeName(s) { return String(s || '').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120); }

  window.musicStageAndPublish = async function() {
    const err = $('musicAddErr2');
    err.textContent = '';
    const file = $('musicFileInput2').files && $('musicFileInput2').files[0];
    const artist = $('musicArtist2').value.trim();
    const album = $('musicAlbum2').value.trim() || 'Сингл';
    const title = $('musicTitle2').value.trim();
    const trackNum = parseInt($('musicTrackNum2').value) || 1;
    if (!file) return err.textContent = 'Выбери файл';
    if (file.size > 20 * 1024 * 1024) return err.textContent = 'Файл больше 20 МБ';
    if (!artist) return err.textContent = 'Укажи исполнителя';
    if (!title) return err.textContent = 'Укажи название';

    const btn = document.querySelector('#musicAddModal2 .row button.primary');
    btn.disabled = true;
    btn.textContent = 'Загрузка...';
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('artist', artist);
      form.append('album', album);
      form.append('trackTitle', title);
      form.append('trackNumber', String(trackNum));
      const r = await fetch('/api/music/stage', { method: 'POST', headers: authHdr(), body: form });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
      await api('/api/music/publish', { method: 'POST', body: JSON.stringify({ token: data.token }) });
      toast('🌸 Опубликовано');
      closeModal('musicAddModal2');
      loadMusicTab();
    } catch (e) { err.textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = '[ ОПУБЛИКОВАТЬ ]'; }
  };

  // Автозаполнение имени файла
  document.addEventListener('input', e => {
    if (e.target.id === 'musicArtist2' || e.target.id === 'musicTitle2') {
      const a = $('musicArtist2')?.value.trim();
      const t = $('musicTitle2')?.value.trim();
      const el = $('musicFileNamePreview2');
      if (!el) return;
      if (a && t) el.textContent = `Будет сохранено как: ${sanitizeName(a)}-${sanitizeName(t)}.<формат>`;
      else el.textContent = '';
    }
  });

  // ============================================================
  //  ПЛЕЙЛИСТЫ
  // ============================================================
  window.openPlaylistPicker = async function(trackId, fromPlaylist) {
    pickerTrackId = trackId;
    $('playlistPickerModal2').classList.add('active');
    const list = $('playlistPickerList2');
    list.innerHTML = '<div class="music-loading">Загрузка...</div>';
    try {
      const pls = await api('/api/music/playlists');
      const details = await Promise.all(pls.map(p => api('/api/music/playlists/' + p.id + '/tracks').catch(() => ({ tracks: [] }))));
      if (!pls.length) { list.innerHTML = '<div class="music-empty" style="padding:20px">Нет плейлистов. Создай первый ниже.</div>'; return; }
      list.innerHTML = pls.map((p, i) => {
        const inPl = (details[i].tracks || []).some(t => t.id === trackId);
        return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:12px;margin-bottom:6px;cursor:pointer;${inPl ? 'border-color:var(--accent)' : ''}" data-pid="${p.id}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-head)">${esc(p.name)}</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px">${p.count} ${plural(p.count, 'песня', 'песни', 'песен')}</div>
          </div>
          <div style="font-size:16px;color:var(--accent);flex-shrink:0">${inPl ? '✓' : '＋'}</div>
          <button data-del="${p.id}" style="background:none;border:none;color:var(--danger);font-size:15px;padding:4px 8px;cursor:pointer;flex-shrink:0">✕</button>
        </div>`;
      }).join('');
      list.querySelectorAll('[data-pid]').forEach(el => el.onclick = async e => {
        if (e.target.closest('[data-del]')) return;
        try { await api('/api/music/playlists/' + el.dataset.pid + '/tracks', { method: 'POST', body: JSON.stringify({ trackId }) }); openPlaylistPicker(trackId, fromPlaylist); if (fromPlaylist && currentPlaylist) loadMusicTab(); } catch (err) { toast(err.message); }
      });
      list.querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
        e.stopPropagation();
        if (!confirm('Удалить плейлист?')) return;
        try { await api('/api/music/playlists/' + b.dataset.del, { method: 'DELETE' }); openPlaylistPicker(trackId, fromPlaylist); } catch (err) { toast(err.message); }
      });
    } catch (e) { list.innerHTML = `<div class="music-empty">${esc(e.message)}</div>`; }
  };

  window.musicCreatePlaylist = async function() {
    const name = $('newPlaylistName2').value.trim();
    if (!name) return;
    try {
      const p = await api('/api/music/playlists', { method: 'POST', body: JSON.stringify({ name }) });
      $('newPlaylistName2').value = '';
      if (pickerTrackId) { await api('/api/music/playlists/' + p.id + '/tracks', { method: 'POST', body: JSON.stringify({ trackId: pickerTrackId }) }); openPlaylistPicker(pickerTrackId, false); }
      else loadMusicTab();
    } catch (e) { toast(e.message); }
  };

  // ============================================================
  //  СКАЧИВАНИЕ
  // ============================================================
  async function downloadTrack(track, btn) {
    try {
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      const realId = track.tgFileId || track.fileId;
      if (!realId) throw new Error('Файл недоступен');
      const res = await fetch(musicUrl(realId), { headers: authHdr() });
      if (!res.ok) throw new Error('Файл недоступен');
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: mimeByFilename(track.filename) }));
      const a = document.createElement('a');
      a.href = url;
      a.download = track.filename || `${track.artist} - ${track.title}.mp3`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('⬇ Скачано: ' + (track.title || 'файл'));
    } catch (e) { toast(e.message || 'Ошибка скачивания'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '⬇'; } }
  }

  // ============================================================
  //  WS-ХУК
  // ============================================================
  window.musicOnWsEvent = function(type, payload) {
    if (typeof currentView !== 'undefined' && currentView === 'music') loadMusicTab();
  };

  console.log('[Music] v5.0 loaded 🌸');
})();
