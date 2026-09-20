// КРИСТА.ФРИНЕТ · music.js v3.35
(function(){
  'use strict';

  let musicTab='songs';
  let musicSongs=[],musicAlbums=[],musicArtists=[],musicPlaylists=[];
  let currentAlbum=null,currentArtist=null,currentPlaylist=null;
  let playlistTrackIds=new Set();
  let pickerTrackId=null,pendingMusicToken=null;

  const audio=new Audio();audio.preload='metadata';
  let currentTrack=null,currentQueue=[],originalQueue=[],currentQueueIndex=-1,currentBlobUrl=null;

  let shuffleOn=localStorage.getItem('krista_music_shuffle')==='1';
  let repeatMode=localStorage.getItem('krista_music_repeat')||'off';
  let playbackSpeed=parseFloat(localStorage.getItem('krista_music_speed'))||1;
  let savedVolume=parseFloat(localStorage.getItem('krista_music_volume'));
  if(isNaN(savedVolume))savedVolume=1;
  audio.volume=savedVolume;
  let wakeLock=null,progressDragging=false;

  function $(id){return document.getElementById(id);}
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
  function fmtTime(s){if(!isFinite(s))return'0:00';const m=Math.floor(s/60),ss=Math.floor(s%60);return m+':'+String(ss).padStart(2,'0');}
  function fmtSize(n){if(!n)return'0 Б';if(n<1024)return n+' Б';if(n<1048576)return(n/1024).toFixed(1)+' КБ';return(n/1048576).toFixed(2)+' МБ';}
  function plural(n,one,few,many){const m10=n%10,m100=n%100;if(m10===1&&m100!==11)return one;if(m10>=2&&m10<=4&&(m100<10||m100>=20))return few;return many;}
  function authHdr(){return window.token?{Authorization:'Bearer '+window.token}:{};}
  function shuffleArr(a){const c=a.slice();for(let i=c.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[c[i],c[j]]=[c[j],c[i]];}return c;}
  function musicUrl(id){return id?`/api/music/file/${encodeURIComponent(id)}?token=${encodeURIComponent(window.token||'')}`:'';}
  function mimeByFilename(name){
    const f=(name||'').toLowerCase();
    if(f.endsWith('.mp3'))return'audio/mpeg';
    if(f.endsWith('.ogg')||f.endsWith('.oga'))return'audio/ogg';
    if(f.endsWith('.m4a'))return'audio/mp4';
    if(f.endsWith('.wav'))return'audio/wav';
    if(f.endsWith('.flac'))return'audio/flac';
    if(f.endsWith('.aac'))return'audio/aac';
    if(f.endsWith('.opus'))return'audio/opus';
    return'audio/mpeg';
  }

  async function api(url,opts){
    opts=opts||{};
    opts.headers=Object.assign({'Content-Type':'application/json'},authHdr(),opts.headers||{});
    const r=await fetch(url,opts);
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Ошибка');
    return d;
  }

  // ==== ИНИЦИАЛИЗАЦИЯ ====
  window.initMusic=function(){
    const el=$('musicContainer');if(!el)return;
    if(!el.innerHTML.trim()){
      el.innerHTML=`
        <div style="display:flex;gap:4px;padding:8px 10px;overflow-x:auto;flex-shrink:0;border-bottom:1px solid var(--glass-border);background:var(--glass);scrollbar-width:none" id="musicTabs">
          <button style="flex-shrink:0;background:linear-gradient(135deg,var(--accent),var(--accent-2));border:none;color:var(--on-accent);padding:7px 14px;border-radius:14px;font-family:var(--font-head);font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap" id="musicAddTabBtn">＋ Песня</button>
          <div class="music-tab active" data-t="songs" style="flex-shrink:0;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text2);padding:7px 14px;border-radius:14px;font-family:var(--font-body);font-size:12px;cursor:pointer;white-space:nowrap">Песни</div>
          <div class="music-tab" data-t="albums" style="flex-shrink:0;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text2);padding:7px 14px;border-radius:14px;font-family:var(--font-body);font-size:12px;cursor:pointer;white-space:nowrap">Альбомы</div>
          <div class="music-tab" data-t="artists" style="flex-shrink:0;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text2);padding:7px 14px;border-radius:14px;font-family:var(--font-body);font-size:12px;cursor:pointer;white-space:nowrap">Исполнители</div>
          <div class="music-tab" data-t="playlists" style="flex-shrink:0;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text2);padding:7px 14px;border-radius:14px;font-family:var(--font-body);font-size:12px;cursor:pointer;white-space:nowrap">Плейлисты</div>
        </div>
        <div style="flex:1;overflow-y:auto;min-height:0;padding:8px 0 12px" id="musicBody"></div>
        <div class="music-player" id="musicPlayer" style="display:none;flex-shrink:0;margin:0 10px 10px;padding:10px;background:var(--glass-2);backdrop-filter:blur(var(--blur));-webkit-backdrop-filter:blur(var(--blur));border:1px solid var(--glass-border);border-radius:var(--rad);flex-direction:column;gap:8px;position:relative">
          <button class="music-ctrl-sm" id="mpClose" title="Закрыть" style="position:absolute;top:8px;right:8px;z-index:2;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text3);width:26px;height:26px;border-radius:50%;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer">✕</button>
          <div style="display:flex;align-items:center;gap:8px;padding-right:32px">
            <div id="mpThumb" style="width:36px;height:36px;flex-shrink:0;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-size:16px;font-weight:700;text-transform:uppercase">♪</div>
            <div style="flex:1;min-width:0;overflow:hidden;position:relative;height:18px" id="mptText"><div style="position:absolute;white-space:nowrap;font-family:var(--font-head);font-size:13px;font-weight:600;color:var(--text);top:0;line-height:18px;left:0" id="mptTrack"></div></div>
            <button class="music-player-btn" id="mpAdd" style="background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text2);width:32px;height:32px;flex-shrink:0;border-radius:10px;font-size:15px;cursor:pointer;padding:0" title="В плейлист">＋</button>
            <button class="music-player-btn" id="mpShare" style="background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text2);width:32px;height:32px;flex-shrink:0;border-radius:10px;font-size:15px;cursor:pointer;padding:0" title="Поделиться">⤴</button>
          </div>
          <div style="height:10px;background:var(--glass-2);border-radius:5px;overflow:hidden;cursor:pointer;position:relative;touch-action:none" id="mpProgress"><div style="height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-2));border-radius:5px;pointer-events:none;width:0" id="mpProgressFill"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text3);font-family:var(--font-head);font-weight:600;margin-top:-4px"><span id="mpTimeCur">0:00</span><span id="mpTimeDur">0:00</span></div>
          <div style="display:flex;justify-content:center;align-items:center;gap:8px">
            <button class="music-ctrl" id="mpShuffle">🔀</button>
            <button class="music-ctrl" id="mpPrev">⏮️</button>
            <button class="music-ctrl main" id="mpPlay">▶️</button>
            <button class="music-ctrl" id="mpNext">⏭️</button>
            <button class="music-ctrl" id="mpRepeat">🔁</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;justify-content:space-between">
            <button class="music-ctrl-sm" id="mpQueue" title="Очередь">📋</button>
            <span style="flex:1;display:flex;align-items:center;gap:6px;min-width:0"><span id="mpVolIcon" style="font-size:14px">🔊</span><input type="range" min="0" max="100" value="${Math.round(savedVolume*100)}" id="mpVol" style="flex:1;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:var(--glass-2);outline:none;min-width:0" /></span>
            <button class="music-ctrl-sm" id="mpSpeed">${playbackSpeed}×</button>
            <button class="music-ctrl-sm" id="mpStop">⏹️</button>
          </div>
        </div>
      `;
      if(!$('musicStyles')){
        const st=document.createElement('style');st.id='musicStyles';
        st.textContent=`
          .music-tab.active{background:linear-gradient(135deg,var(--accent),var(--accent-2))!important;color:var(--on-accent)!important;border-color:transparent!important;font-weight:600}
          .music-ctrl{background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text);width:42px;height:42px;border-radius:14px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;font-family:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif}
          .music-ctrl.main{width:52px;height:52px;font-size:20px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent);border:none}
          .music-ctrl.active{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
          .music-ctrl.dim{opacity:.35}
          .music-ctrl-sm{background:var(--glass-2);border:1px solid var(--glass-border);color:var(--text2);height:30px;min-width:34px;padding:0 8px;border-radius:10px;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-weight:700;flex-shrink:0}
          .music-ctrl-sm.active{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
          .music-item{display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:var(--rad);margin:0 10px 6px}
          .music-item.playing{border-color:var(--accent);background:var(--glass-2)}
          .music-item-icon{width:38px;height:38px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
          .music-item-body{flex:1;min-width:0;cursor:pointer}
          .music-item-title{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-head)}
          .music-item-meta{font-size:11px;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          .music-item-actions{display:flex;gap:4px;flex-shrink:0}
          .music-item-btn{width:30px;height:30px;flex-shrink:0;background:var(--glass-2);border:1px solid var(--glass-border);color:var(--accent);border-radius:50%;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-weight:700;padding:0}
          .music-item-btn.on{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
          .music-item-btn.dl{color:var(--text2)}
          .music-group-item{display:flex;align-items:center;gap:12px;padding:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:var(--rad);margin:0 10px 6px;cursor:pointer}
          .music-group-icon{width:46px;height:46px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
          .music-group-body{flex:1;min-width:0}
          .music-group-name{font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-head)}
          .music-group-meta{font-size:11px;color:var(--text3);margin-top:2px}
          .music-group-arrow{color:var(--text3);font-size:18px;flex-shrink:0}
          .music-back{padding:8px 14px;font-size:12px;color:var(--accent);cursor:pointer;font-family:var(--font-head);font-weight:600;display:inline-flex;align-items:center;gap:6px}
          .music-empty{color:var(--text3);text-align:center;padding:40px 20px;font-size:12px;font-style:italic}
          .music-loading{color:var(--text3);text-align:center;padding:30px 20px;font-size:12px;font-style:italic}
          #mptTrack.scrolling{animation:music-scroll 14s linear infinite}
          @keyframes music-scroll{0%{transform:translateX(0)}8%{transform:translateX(0)}92%{transform:translateX(var(--scroll-dist))}100%{transform:translateX(var(--scroll-dist))}}
        `;
        document.head.appendChild(st);
      }
      $('musicAddTabBtn').onclick=openAddMusicModal;
      $('musicTabs').querySelectorAll('.music-tab').forEach(t=>t.onclick=()=>{
        musicTab=t.dataset.t;
        $('musicTabs').querySelectorAll('.music-tab').forEach(x=>x.classList.toggle('active',x===t));
        currentAlbum=null;currentArtist=null;currentPlaylist=null;
        loadMusicTab();
      });
      ensureQueueModal();
      bindPlayer();
      applyPlayerState();
    }
    loadMusicTab();
  };

  function ensureQueueModal(){
    if($('queueModal'))return;
    const ov=document.createElement('div');
    ov.className='ov';ov.id='queueModal';
    ov.innerHTML=`<div class="mod"><h3>ОЧЕРЕДЬ</h3><div id="queueList" style="max-height:60vh;overflow-y:auto"></div><div class="row" style="margin-top:14px"><button onclick="closeModal('queueModal')">[ ЗАКРЫТЬ ]</button></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click',e=>{if(e.target===ov)ov.classList.remove('active');});
  }

  function applyPlayerState(){
    const shuf=$('mpShuffle');if(shuf)shuf.classList.toggle('active',shuffleOn);
    const rep=$('mpRepeat');
    if(rep){rep.classList.remove('active','dim');if(repeatMode==='off'){rep.classList.add('dim');rep.textContent='🔁';}else if(repeatMode==='all'){rep.classList.add('active');rep.textContent='🔁';}else{rep.classList.add('active');rep.textContent='🔂';}}
    const sp=$('mpSpeed');if(sp){sp.textContent=playbackSpeed+'×';sp.classList.toggle('active',playbackSpeed!==1);}
    const vol=$('mpVol');if(vol)vol.value=Math.round(savedVolume*100);
    const vi=$('mpVolIcon');if(vi)vi.textContent=savedVolume===0?'🔇':savedVolume<0.5?'🔉':'🔊';
    audio.playbackRate=playbackSpeed;
  }

  async function loadMusicTab(){
    const body=$('musicBody');if(!body)return;
    body.innerHTML=`<div class="music-loading">Загрузка...</div>`;
    try{
      if(musicTab==='songs'){musicSongs=await api('/api/music/songs');renderSongsList(musicSongs,null,false);}
      else if(musicTab==='albums'){
        if(currentAlbum){const s=await api('/api/music/albums/'+encodeURIComponent(currentAlbum.album));renderSongsList(s,`Альбом: ${currentAlbum.album}`,false);}
        else{musicAlbums=await api('/api/music/albums');renderAlbums();}
      }else if(musicTab==='artists'){
        if(currentArtist){const s=await api('/api/music/artists/'+encodeURIComponent(currentArtist));renderSongsList(s,`Исполнитель: ${currentArtist}`,false);}
        else{musicArtists=await api('/api/music/artists');renderArtists();}
      }else if(musicTab==='playlists'){
        if(currentPlaylist){const d=await api('/api/music/playlists/'+currentPlaylist.id+'/tracks');playlistTrackIds=new Set(d.tracks.map(t=>t.id));renderSongsList(d.tracks,`Плейлист: ${d.name}`,true);}
        else{musicPlaylists=await api('/api/music/playlists');renderPlaylists();}
      }
    }catch(e){body.innerHTML=`<div class="music-empty">${esc(e.message)}</div>`;}
  }

  function renderSongsList(songs,header,fromPlaylist){
    const body=$('musicBody');
    const queue=songs.map(s=>({id:s.id,tgFileId:s.tgFileId||s.fileId,title:s.title,artist:s.artist,album:s.album,filename:s.filename}));
    let html='';
    if(header)html+=`<div class="music-back" id="musicBack">‹ Назад</div>`;
    if(!songs.length){
      html+=`<div class="music-empty">Пусто<br><button onclick="openAddMusicModal()" style="margin-top:14px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent);border:none;padding:10px 22px;border-radius:14px;font-family:var(--font-head);font-weight:700;font-size:12px;cursor:pointer">Добавить песню</button></div>`;
      body.innerHTML=html;
      if(header)$('musicBack').onclick=()=>{currentAlbum=null;currentArtist=null;currentPlaylist=null;loadMusicTab();};
      return;
    }
    html+='<div>';
    songs.forEach((s,i)=>{
      const playing=currentTrack&&currentTrack.id===s.id;
      const inPl=fromPlaylist?true:playlistTrackIds.has(s.id);
      html+=`<div class="music-item ${playing?'playing':''}" data-i="${i}"><div class="music-item-icon">🎵</div><div class="music-item-body" data-play="${i}"><div class="music-item-title">${esc(s.title)}</div><div class="music-item-meta">${esc(s.artist)} · ${esc(s.album||'Сингл')} · ${fmtSize(s.size)}</div></div><div class="music-item-actions"><button class="music-item-btn dl" data-dl="${i}" title="Скачать">⬇</button><button class="music-item-btn ${inPl?'on':''}" data-add="${i}" title="В плейлист">${inPl?'✓':'＋'}</button></div></div>`;
    });
    html+='</div>';
    body.innerHTML=html;
    if(header)$('musicBack').onclick=()=>{currentAlbum=null;currentArtist=null;currentPlaylist=null;loadMusicTab();};
    body.querySelectorAll('[data-play]').forEach(el=>el.onclick=()=>playTrack(songs[+el.dataset.play],queue,+el.dataset.play));
    body.querySelectorAll('[data-dl]').forEach(el=>el.onclick=e=>{e.stopPropagation();downloadTrack(songs[+el.dataset.dl],e.currentTarget);});
    body.querySelectorAll('[data-add]').forEach(el=>el.onclick=e=>{e.stopPropagation();pickerTrackId=songs[+el.dataset.add].id;openPlaylistPicker(songs[+el.dataset.add].id,fromPlaylist);});
  }

  async function downloadTrack(track,btn){
    try{
      if(btn){btn.disabled=true;btn.textContent='…';}
      const realId=track.tgFileId||track.fileId;
      if(!realId)throw new Error('Файл недоступен');
      const res=await fetch(musicUrl(realId),{headers:authHdr()});
      if(!res.ok)throw new Error('Файл недоступен');
      const blob=await res.blob();
      const mime=mimeByFilename(track.filename);
      const ab=new Blob([blob],{type:mime});
      const url=URL.createObjectURL(ab);
      const a=document.createElement('a');
      a.href=url;a.download=track.filename||`${track.artist} - ${track.title}.mp3`;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),5000);
      window.toast&&window.toast('Скачано: '+(track.title||'файл'));
    }catch(e){window.toast&&window.toast(e.message||'Ошибка скачивания');}
    finally{if(btn){btn.disabled=false;btn.textContent='⬇';}}
  }

  function renderAlbums(){
    const body=$('musicBody');
    if(!musicAlbums.length){body.innerHTML=`<div class="music-empty">Нет альбомов</div>`;return;}
    body.innerHTML=musicAlbums.map((a,i)=>`<div class="music-group-item" data-i="${i}"><div class="music-group-icon">💿</div><div class="music-group-body"><div class="music-group-name">${esc(a.album)}</div><div class="music-group-meta">${esc(a.artist)} · ${a.count} ${plural(a.count,'песня','песни','песен')}</div></div><div class="music-group-arrow">›</div></div>`).join('');
    body.querySelectorAll('.music-group-item').forEach(el=>el.onclick=()=>{currentAlbum=musicAlbums[+el.dataset.i];loadMusicTab();});
  }
  function renderArtists(){
    const body=$('musicBody');
    if(!musicArtists.length){body.innerHTML=`<div class="music-empty">Нет исполнителей</div>`;return;}
    body.innerHTML=musicArtists.map((a,i)=>`<div class="music-group-item" data-i="${i}"><div class="music-group-icon">🎤</div><div class="music-group-body"><div class="music-group-name">${esc(a.artist)}</div><div class="music-group-meta">${a.count} ${plural(a.count,'песня','песни','песен')}</div></div><div class="music-group-arrow">›</div></div>`).join('');
    body.querySelectorAll('.music-group-item').forEach(el=>el.onclick=()=>{currentArtist=musicArtists[+el.dataset.i].artist;loadMusicTab();});
  }
  function renderPlaylists(){
    const body=$('musicBody');
    let html=`<div class="music-group-item" id="plCreateNew" style="border-style:dashed"><div class="music-group-icon">＋</div><div class="music-group-body"><div class="music-group-name">Новый плейлист</div></div></div>`;
    musicPlaylists.forEach((p,i)=>{html+=`<div class="music-group-item" data-i="${i}"><div class="music-group-icon">📁</div><div class="music-group-body"><div class="music-group-name">${esc(p.name)}</div><div class="music-group-meta">${p.count} ${plural(p.count,'песня','песни','песен')}</div></div><div class="music-group-arrow">›</div></div>`;});
    body.innerHTML=html;
    $('plCreateNew').onclick=async()=>{
      const name=prompt('Название плейлиста:');
      if(!name?.trim())return;
      try{await api('/api/music/playlists',{method:'POST',body:JSON.stringify({name:name.trim()})});loadMusicTab();}catch(e){window.toast&&window.toast(e.message);}
    };
    body.querySelectorAll('[data-i]').forEach(el=>el.onclick=()=>{currentPlaylist=musicPlaylists[+el.dataset.i];loadMusicTab();});
  }

  function bindPlayer(){
    audio.addEventListener('timeupdate',()=>{
      if(!audio.duration)return;
      const pct=(audio.currentTime/audio.duration)*100;
      $('mpProgressFill').style.width=pct+'%';
      $('mpTimeCur').textContent=fmtTime(audio.currentTime);
      if(navigator.mediaSession&&navigator.mediaSession.setPositionState&&isFinite(audio.duration)){
        try{navigator.mediaSession.setPositionState({duration:audio.duration,playbackRate:audio.playbackRate,position:audio.currentTime});}catch{}
      }
    });
    audio.addEventListener('loadedmetadata',()=>{$('mpTimeDur').textContent=fmtTime(audio.duration);});
    audio.addEventListener('ended',onTrackEnded);
    audio.addEventListener('play',()=>{$('mpPlay').textContent='⏸️';requestWakeLock();syncMiniPlayer();});
    audio.addEventListener('pause',()=>{$('mpPlay').textContent='▶️';releaseWakeLock();syncMiniPlayer();});
    $('mpPlay').onclick=()=>{if(audio.paused)audio.play().catch(()=>{});else audio.pause();};
    $('mpStop').onclick=()=>window.stopMusicPlayer();
    $('mpClose').onclick=()=>window.stopMusicPlayer();
    $('mpPrev').onclick=prevTrack;
    $('mpNext').onclick=nextTrack;
    $('mpShuffle').onclick=()=>{
      shuffleOn=!shuffleOn;localStorage.setItem('krista_music_shuffle',shuffleOn?'1':'0');applyPlayerState();
      if(shuffleOn){if(currentQueue.length>1){const cur=currentQueue[currentQueueIndex];const rest=currentQueue.filter((_,i)=>i!==currentQueueIndex);const mixed=shuffleArr(rest);currentQueue=cur?[cur,...mixed]:mixed;currentQueueIndex=cur?0:-1;}}
      else if(originalQueue.length){currentQueue=originalQueue.slice();currentQueueIndex=currentTrack?currentQueue.findIndex(t=>t.id===currentTrack.id):-1;}
      window.toast&&window.toast(shuffleOn?'Перемешать: вкл':'Перемешать: выкл');
    };
    $('mpRepeat').onclick=()=>{
      repeatMode=repeatMode==='off'?'all':(repeatMode==='all'?'one':'off');
      localStorage.setItem('krista_music_repeat',repeatMode);audio.loop=(repeatMode==='one');applyPlayerState();
      window.toast&&window.toast(repeatMode==='off'?'Выкл':(repeatMode==='all'?'Повтор плейлиста':'Повтор одного'));
    };
    const prog=$('mpProgress');
    function pctFromEvent(e){const rect=prog.getBoundingClientRect();const x=(e.touches&&e.touches[0])?e.touches[0].clientX:(e.changedTouches&&e.changedTouches[0]?e.changedTouches[0].clientX:e.clientX);return Math.max(0,Math.min(1,(x-rect.left)/rect.width));}
    prog.addEventListener('click',e=>{if(!audio.duration)return;audio.currentTime=pctFromEvent(e)*audio.duration;});
    prog.addEventListener('touchstart',e=>{if(!audio.duration)return;progressDragging=true;e.preventDefault();const p=pctFromEvent(e);audio.currentTime=p*audio.duration;$('mpProgressFill').style.width=(p*100)+'%';$('mpTimeCur').textContent=fmtTime(audio.currentTime);},{passive:false});
    prog.addEventListener('touchmove',e=>{if(!progressDragging||!audio.duration)return;e.preventDefault();const p=pctFromEvent(e);audio.currentTime=p*audio.duration;$('mpProgressFill').style.width=(p*100)+'%';$('mpTimeCur').textContent=fmtTime(audio.currentTime);},{passive:false});
    prog.addEventListener('touchend',()=>{progressDragging=false;});
    $('mpVol').oninput=e=>{savedVolume=parseInt(e.target.value)/100;audio.volume=savedVolume;localStorage.setItem('krista_music_volume',String(savedVolume));$('mpVolIcon').textContent=savedVolume===0?'🔇':savedVolume<0.5?'🔉':'🔊';};
    $('mpSpeed').onclick=()=>{const speeds=[0.75,1,1.25,1.5,2];const idx=speeds.indexOf(playbackSpeed);playbackSpeed=speeds[(idx+1)%speeds.length];audio.playbackRate=playbackSpeed;localStorage.setItem('krista_music_speed',String(playbackSpeed));applyPlayerState();};
    $('mpQueue').onclick=openQueueModal;
    $('mpAdd').onclick=()=>{if(currentTrack)openPlaylistPicker(currentTrack.id,false);};
    $('mpShare').onclick=()=>{if(!currentTrack)return;const txt=`${currentTrack.artist} — ${currentTrack.title}`;if(navigator.share)navigator.share({title:txt,text:txt}).catch(()=>{});else{navigator.clipboard?.writeText(txt);window.toast&&window.toast('Скопировано');}};
  }

  function syncMiniPlayer(){
    if(typeof window.updateMiniPlayer==='function'){
      window.updateMiniPlayer({
        track:currentTrack?{artist:currentTrack.artist,title:currentTrack.title}:null,
        playing:!audio.paused
      });
    }
  }
  window.miniPlayerTogglePlay=function(){if(audio.paused)audio.play().catch(()=>{});else audio.pause();};

  async function playTrack(track,queue,index){
    try{
      if(currentBlobUrl){URL.revokeObjectURL(currentBlobUrl);currentBlobUrl=null;}
      const realId=track.tgFileId||track.fileId;
      if(!realId)throw new Error('Файл недоступен');
      const res=await fetch(musicUrl(realId),{headers:authHdr()});
      if(!res.ok)throw new Error('Файл недоступен');
      const blob=await res.blob();
      const mime=mimeByFilename(track.filename);
      const ab=new Blob([blob],{type:mime});
      currentBlobUrl=URL.createObjectURL(ab);
      audio.src=currentBlobUrl;
      audio.playbackRate=playbackSpeed;
      currentTrack=track;
      originalQueue=queue?queue.slice():[];
      if(queue){currentQueue=queue.slice();currentQueueIndex=index!=null?index:0;if(shuffleOn&&currentQueue.length>1){const cur=currentQueue[currentQueueIndex];const rest=currentQueue.filter((_,i)=>i!==currentQueueIndex);const mixed=shuffleArr(rest);currentQueue=cur?[cur,...mixed]:mixed;currentQueueIndex=cur?0:-1;}}
      await audio.play();
      updatePlayerUI();
      setupMediaSession();
      updatePlayingHighlight();
    }catch(e){window.toast&&window.toast(e.message||'Ошибка воспроизведения');}
  }

  function updatePlayerUI(){
    if(!currentTrack)return;
    $('musicPlayer').style.display='flex';
    const txt=`${currentTrack.artist} — ${currentTrack.title}`;
    const el=$('mptTrack'),wrap=$('mptText');
    el.textContent=txt;el.classList.remove('scrolling');el.style.transform='';
    $('mpThumb').textContent=(currentTrack.artist||'♪').trim()[0]||'♪';
    requestAnimationFrame(()=>{const w=el.scrollWidth,cw=wrap.clientWidth;if(w>cw+4){el.style.setProperty('--scroll-dist',(cw-w-8)+'px');el.classList.add('scrolling');}});
    syncMiniPlayer();
  }
  function updatePlayingHighlight(){
    document.querySelectorAll('.music-item').forEach(el=>el.classList.remove('playing'));
    if(!currentTrack||!musicSongs)return;
    const idx=musicSongs.findIndex(s=>s.id===currentTrack.id);
    if(idx>=0){const el=document.querySelector(`.music-item[data-i="${idx}"]`);if(el)el.classList.add('playing');}
  }
  function onTrackEnded(){
    if(repeatMode==='one'){audio.currentTime=0;audio.play().catch(()=>{});return;}
    if(currentQueue.length&&currentQueueIndex>=0&&currentQueueIndex<currentQueue.length-1){const i=currentQueueIndex+1;playTrack(currentQueue[i],currentQueue,i);return;}
    if(repeatMode==='all'&&currentQueue.length>1){playTrack(currentQueue[0],currentQueue,0);return;}
    audio.pause();
  }
  function nextTrack(){
    if(repeatMode==='one'&&audio.currentTime>3){audio.currentTime=0;audio.play().catch(()=>{});return;}
    if(currentQueue.length&&currentQueueIndex>=0&&currentQueueIndex<currentQueue.length-1){const i=currentQueueIndex+1;playTrack(currentQueue[i],currentQueue,i);}
    else if(repeatMode==='all'&&currentQueue.length){playTrack(currentQueue[0],currentQueue,0);}
    else{audio.pause();}
  }
  function prevTrack(){
    if(audio.currentTime>3){audio.currentTime=0;return;}
    if(currentQueue.length&&currentQueueIndex>0){const i=currentQueueIndex-1;playTrack(currentQueue[i],currentQueue,i);}
  }

  window.stopMusicPlayer=function(){
    try{audio.pause();audio.src='';}catch{}
    if(currentBlobUrl){URL.revokeObjectURL(currentBlobUrl);currentBlobUrl=null;}
    currentTrack=null;currentQueue=[];originalQueue=[];currentQueueIndex=-1;
    const p=$('musicPlayer');if(p)p.style.display='none';
    if(navigator.mediaSession)navigator.mediaSession.metadata=null;
    releaseWakeLock();updatePlayingHighlight();syncMiniPlayer();
  };

  function setupMediaSession(){
    if(!('mediaSession'in navigator)||!currentTrack)return;
    navigator.mediaSession.metadata=new MediaMetadata({title:currentTrack.title,artist:currentTrack.artist,album:currentTrack.album||''});
    try{
      navigator.mediaSession.setActionHandler('play',()=>audio.play().catch(()=>{}));
      navigator.mediaSession.setActionHandler('pause',()=>audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack',prevTrack);
      navigator.mediaSession.setActionHandler('nexttrack',nextTrack);
      navigator.mediaSession.setActionHandler('stop',()=>window.stopMusicPlayer());
    }catch{}
  }

  async function requestWakeLock(){if(!('wakeLock'in navigator))return;try{if(wakeLock)return;wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}catch{}}
  function releaseWakeLock(){if(wakeLock){try{wakeLock.release();}catch{}wakeLock=null;}}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&currentTrack&&!audio.paused)requestWakeLock();});

  function openQueueModal(){
    ensureQueueModal();
    const list=$('queueList');
    if(!currentQueue.length)list.innerHTML=`<div class="music-empty">Очередь пуста</div>`;
    else{
      list.innerHTML=currentQueue.map((t,i)=>{
        const playing=currentTrack&&t.id===currentTrack.id;
        return`<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:10px;margin-bottom:5px;cursor:pointer;${playing?'border-color:var(--accent)':''}" data-i="${i}"><div style="width:24px;text-align:center;font-family:var(--font-head);font-size:11px;color:${playing?'var(--accent)':'var(--text3)'};flex-shrink:0">${playing?'▶':(i+1)}</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--font-head)">${esc(t.title)}</div><div style="font-size:11px;color:var(--text3);margin-top:1px">${esc(t.artist)}</div></div></div>`;
      }).join('');
      list.querySelectorAll('[data-i]').forEach(el=>el.onclick=()=>{const i=+el.dataset.i;playTrack(currentQueue[i],currentQueue,i);closeModal('queueModal');});
    }
    $('queueModal').classList.add('active');
  }

  window.openAddMusicModal=function(){
    const err=$('musicAddErr');if(!err)return;
    err.textContent='';
    $('musicFileInput').value='';$('musicArtist').value='';$('musicAlbum').value='';$('musicTitle').value='';$('musicTrackNum').value='1';$('musicFileNamePreview').textContent='';
    pendingMusicToken=null;
    $('musicAddModal').classList.add('active');
  };

  function sanitizeName(s){return String(s||'').replace(/[\/\\:*?"<>|]/g,'_').slice(0,120);}
  function updateFileNamePreview(){
    const a=$('musicArtist').value.trim(),t=$('musicTitle').value.trim();
    if(a&&t)$('musicFileNamePreview').textContent=`Будет сохранено как: ${sanitizeName(a)}-${sanitizeName(t)}.<формат>`;
    else $('musicFileNamePreview').textContent='';
  }
  ['musicArtist','musicTitle'].forEach(id=>document.addEventListener('input',e=>{if(e.target.id===id)updateFileNamePreview();}));

  window.stageAndPublishMusic=async function(){
    const err=$('musicAddErr');err.textContent='';
    const fileInput=$('musicFileInput');
    const file=fileInput.files&&fileInput.files[0];
    const artist=$('musicArtist').value.trim();
    const album=$('musicAlbum').value.trim()||'Сингл';
    const title=$('musicTitle').value.trim();
    const trackNum=parseInt($('musicTrackNum').value)||1;
    if(!file)return err.textContent='Выбери файл';
    if(file.size>20*1024*1024)return err.textContent='Отправлять файл не более 20 мб';
    if(!artist)return err.textContent='Укажи исполнителя';
    if(!title)return err.textContent='Укажи название';
    const btn=document.querySelector('#musicAddModal .row button.primary');
    btn.disabled=true;btn.textContent='Загрузка...';
    try{
      const form=new FormData();
      form.append('file',file);form.append('artist',artist);form.append('album',album);form.append('trackTitle',title);form.append('trackNumber',String(trackNum));
      const r=await fetch('/api/music/stage',{method:'POST',headers:authHdr(),body:form});
      const data=await r.json();
      if(!r.ok)throw new Error(data.error||'Ошибка');
      pendingMusicToken=data.token;
      await api('/api/music/publish',{method:'POST',body:JSON.stringify({token:pendingMusicToken})});
      window.toast&&window.toast('Опубликовано');
      closeModal('musicAddModal');
      loadMusicTab();
    }catch(e){err.textContent=e.message;}
    finally{btn.disabled=false;btn.textContent='[ ОПУБЛИКОВАТЬ ]';}
  };

  window.openPlaylistPicker=async function(trackId,fromPlaylist){
    pickerTrackId=trackId;
    $('playlistPickerModal').classList.add('active');
    const list=$('playlistPickerList');
    list.innerHTML=`<div class="music-loading">Загрузка...</div>`;
    try{
      const pls=await api('/api/music/playlists');
      const details=await Promise.all(pls.map(p=>api('/api/music/playlists/'+p.id+'/tracks').catch(()=>({tracks:[]}))));
      if(!pls.length){list.innerHTML=`<div class="music-empty" style="padding:20px">Нет плейлистов. Создай первый ниже.</div>`;return;}
      list.innerHTML=pls.map((p,i)=>{
        const inPl=(details[i].tracks||[]).some(t=>t.id===trackId);
        return`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:12px;margin-bottom:6px;cursor:pointer;${inPl?'border-color:var(--accent)':''}" data-id="${p.id}"><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div><div style="font-size:11px;color:var(--text3);margin-top:2px">${p.count} ${plural(p.count,'песня','песни','песен')}</div></div><div style="font-size:16px;color:var(--accent);flex-shrink:0">${inPl?'✓':'＋'}</div><button data-del="${p.id}" style="background:none;border:none;color:var(--danger);font-size:15px;padding:4px 8px;cursor:pointer;flex-shrink:0">✕</button></div>`;
      }).join('');
      list.querySelectorAll('[data-id]').forEach(el=>el.onclick=async e=>{
        if(e.target.closest('[data-del]'))return;
        const id=el.dataset.id;
        try{await api('/api/music/playlists/'+id+'/tracks',{method:'POST',body:JSON.stringify({trackId})});if(fromPlaylist&&currentPlaylist)loadMusicTab();openPlaylistPicker(trackId,fromPlaylist);}catch(err){window.toast&&window.toast(err.message);}
      });
      list.querySelectorAll('[data-del]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const id=b.dataset.del;if(!confirm('Удалить плейлист?'))return;try{await api('/api/music/playlists/'+id,{method:'DELETE'});openPlaylistPicker(trackId,fromPlaylist);}catch(err){window.toast&&window.toast(err.message);}});
    }catch(e){list.innerHTML=`<div class="music-empty">${esc(e.message)}</div>`;}
  };

  window.createNewPlaylist=async function(){
    const name=$('newPlaylistName').value.trim();
    if(!name)return;
    try{
      const p=await api('/api/music/playlists',{method:'POST',body:JSON.stringify({name})});
      $('newPlaylistName').value='';
      if(pickerTrackId){await api('/api/music/playlists/'+p.id+'/tracks',{method:'POST',body:JSON.stringify({trackId:pickerTrackId})});openPlaylistPicker(pickerTrackId,false);}
      else loadMusicTab();
    }catch(e){window.toast&&window.toast(e.message);}
  };

  window.musicOnWsEvent=function(type,payload){if(typeof currentTab!=='undefined'&&currentTab==='Music')loadMusicTab();};

  setTimeout(applyPlayerState,500);
  console.log('[Music] v3.35 loaded');
})();
