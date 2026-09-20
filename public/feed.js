// КРИСТА.ФРИНЕТ · feed.js, v2.30
(function(){
  'use strict';

  let feedMode = 'subs';
  let feedPosts = [];
  let currentPostId = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
  function fTime(iso) { try { return new Date(iso).toTimeString().slice(0,5); } catch { return ''; } }
  function fDate(iso) { try { const d = new Date(iso); const m = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']; return `${d.getDate()} ${m[d.getMonth()]}`; } catch { return ''; } }
  function timeAgoFull(iso) {
    try { const diff = (Date.now() - new Date(iso).getTime()) / 1000;
      if (diff < 60) return 'только что';
      if (diff < 3600) return `${Math.floor(diff / 60)} мин`;
      if (diff < 86400) return `${Math.floor(diff / 3600)} ч`;
      if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} дн`;
      return fDate(iso);
    } catch { return ''; }
  }
  function fmtSize(n) { if (!n) return '0 Б'; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n/1024).toFixed(1) + ' КБ'; return (n/1048576).toFixed(2) + ' МБ'; }
  function fileIcon(f) {
    const mime = (f.mime || '').toLowerCase(); const name = (f.name || '').toLowerCase();
    if (mime.includes('pdf') || name.endsWith('.pdf')) return '📄';
    if (mime.match(/zip|rar|7z/) || name.match(/\.(zip|rar|7z|tar|gz)$/)) return '📦';
    if (mime.includes('word') || name.match(/\.(doc|docx)$/)) return '📝';
    if (mime.includes('excel') || name.match(/\.(xls|xlsx)$/)) return '📊';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.startsWith('audio/')) return '🎵';
    if (mime.startsWith('image/')) return '🖼';
    return '📎';
  }
  function authHdr() { return window.token ? { Authorization: 'Bearer ' + window.token } : {}; }
  function getAvatarUrl(id) { return id ? `/api/fileById/${id}?token=${encodeURIComponent(window.token||'')}` : ''; }

  async function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, authHdr(), opts.headers || {});
    const r = await fetch(url, opts);
    const d = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(d.error || 'Ошибка');
    return d;
  }

  // ==== ИНИЦИАЛИЗАЦИЯ ====
  window.feedInit = function() {
    const el = $('feedBody'); if (!el) return;
    const chips = $('feedChips');
    if (chips && !chips.dataset.bound) {
      chips.dataset.bound = '1';
      chips.querySelectorAll('.feed-chip').forEach(c => c.onclick = () => {
        chips.querySelectorAll('.feed-chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active');
        feedMode = c.dataset.mode;
        loadFeed();
      });
    }
    loadFeed();
  };

  async function loadFeed() {
    const el = $('feedBody'); if (!el) return;
    el.innerHTML = `<div class="empty">Загрузка...</div>`;
    try {
      const r = await api('/api/feed?mode=' + encodeURIComponent(feedMode));
      feedPosts = r.posts || [];
      if (!feedPosts.length) {
        el.innerHTML = `<div class="empty">Постов пока нет<br>Подпишись на каналы или пользователей<br>или опубликуй первый пост</div>`;
        return;
      }
      el.innerHTML = feedPosts.map(p => renderPost(p, { context: 'feed' })).join('');
      bindPostActions(el);
    } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  window.feedRenderPost = function(post, opts) { return renderPost(post, opts || {}); };

  function renderPost(p, opts) {
    const isChannelPost = p.wall && p.wall.type === 'channel';
    const wd = p.wallData;

    // Для постов канала: шапка = канал, автор мелко
    let avatarHtml, nameHtml, metaHtml, headerActionAttr;

    if (isChannelPost && wd) {
      const chAvatar = wd.avatarFileId ? `<img src="${getAvatarUrl(wd.avatarFileId)}" alt="" />` : '📢';
      avatarHtml = chAvatar;
      nameHtml = `📢 ${esc(wd.name)}`;
      const authorLabel = p.author !== wd.owner ? ` · от @${esc(p.author)}` : '';
      metaHtml = `@${esc(wd.login)} · ${esc(timeAgoFull(p.timestamp))}${p.editedAt ? ' · ред.' : ''}<span class="from-author">${authorLabel}</span>${p.views ? ` · 👁 ${p.views}` : ''}`;
      headerActionAttr = `onclick="window.openChannelWall && window.openChannelWall('${esc(wd.login)}')" style="cursor:pointer"`;
    } else {
      avatarHtml = esc((p.authorName || p.author)[0].toUpperCase());
      nameHtml = esc(p.authorName || p.author);
      metaHtml = `@${esc(p.author)} · ${esc(timeAgoFull(p.timestamp))}${p.editedAt ? ' · ред.' : ''}${p.views ? ` · 👁 ${p.views}` : ''}`;
      headerActionAttr = `onclick="window.openUserWall && window.openUserWall('${esc(p.author)}')" style="cursor:pointer"`;
    }

    const files = p.files || [];
    let filesHtml = '';
    if (files.length) {
      const gridClass = files.length === 1 ? '' : files.length === 2 ? ' g2' : files.length === 3 ? ' g3' : ' g4';
      filesHtml = `<div class="post-files${gridClass}">` + files.map((f, i) => {
        if (f.kind === 'image') return `<div class="pfile" data-view-img="${esc(f.fileId)}"><img src="${getAvatarUrl(f.fileId)}" alt="" loading="lazy" /></div>`;
        if (f.kind === 'video') return `<div class="pfile video"><video controls preload="metadata" src="${getAvatarUrl(f.fileId)}" playsinline></video></div>`;
        if (f.kind === 'audio') return `<div class="pfile audio"><span style="font-size:22px">🎵</span><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(f.name)}</div></div><audio controls preload="metadata" src="${getAvatarUrl(f.fileId)}"></audio></div>`;
        return `<div class="pfile doc" data-download="${esc(f.fileId)}" data-fname="${esc(f.name)}"><span class="ficon">${fileIcon(f)}</span><div style="flex:1;min-width:0"><div class="fname">${esc(f.name)}</div><div class="fsize">${fmtSize(f.size)}</div></div></div>`;
      }).join('') + `</div>`;
    }
    let repostHtml = '';
    if (p.repostData) {
      const rd = p.repostData;
      const rf = (rd.files || [])[0];
      repostHtml = `<div class="post-repost"><div class="rp-hdr">🔄 Репост от @${esc(rd.author)}</div>${rd.text ? `<div class="rp-text">${esc(rd.text)}</div>` : ''}${rf && rf.kind === 'image' ? `<div class="rp-file"><img src="${getAvatarUrl(rf.fileId)}" alt="" /></div>` : ''}</div>`;
    }
    let txtHtml = '';
    if (p.text) {
      let t = esc(p.text);
      t = t.replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi, m => { const u = m.startsWith('www.') ? 'http://' + m : m; return `<span class="link" data-url="${esc(u)}">${esc(m)}</span>`; });
      t = t.replace(/@([a-zA-Z0-9_-]{3,32})/g, (_, n) => `<span class="mention" data-mention="${esc(n)}">@${esc(n)}</span>`);
      txtHtml = `<div class="post-text">${t}</div>`;
    }
    return `<div class="post" data-post="${esc(p.id)}">
      <div class="post-hdr" ${headerActionAttr}>
        <div class="pav">${avatarHtml}</div>
        <div class="pinfo">
          <div class="pname">${nameHtml}</div>
          <div class="pmeta"><span>${metaHtml}</span></div>
        </div>
      </div>
      <button class="pmenu" data-menu-post="${esc(p.id)}" onclick="event.stopPropagation()">⋮</button>
      <div class="post-body">
        ${txtHtml}
        ${filesHtml}
        ${repostHtml}
      </div>
      <div class="post-actions">
        <button class="post-act ${p.likedByMe ? 'liked' : ''}" data-like="${esc(p.id)}"><span class="i">${p.likedByMe ? '❤️' : '🤍'}</span><span class="c">${p.likesCount || 0}</span></button>
        <button class="post-act" data-comment="${esc(p.id)}"><span class="i">💬</span><span class="c">${p.commentsCount || 0}</span></button>
        <button class="post-act" data-repost="${esc(p.id)}"><span class="i">🔄</span></button>
      </div>
    </div>`;
  }

  window.feedBindPostActions = function(container) { bindPostActions(container || document); };

  function bindPostActions(container) {
    if (!container) container = document;
    container.querySelectorAll('[data-like]').forEach(b => b.onclick = async (e) => { e.stopPropagation(); await toggleLike(b.dataset.like); });
    container.querySelectorAll('[data-comment]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openPostView(b.dataset.comment); });
    container.querySelectorAll('[data-repost]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openRepost(b.dataset.repost); });
    container.querySelectorAll('[data-menu-post]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openPostMenu(b.dataset.menuPost, e.clientX, e.clientY); });
    container.querySelectorAll('.post-body .link').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); window.open(el.dataset.url, '_blank', 'noopener'); }));
    container.querySelectorAll('.mention').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); if (window.openUserWall) window.openUserWall(el.dataset.mention); }));
    container.querySelectorAll('[data-view-img]').forEach(el => el.onclick = (e) => { e.stopPropagation(); const src = el.querySelector('img').src; if (window.openImageViewer) window.openImageViewer(src, ''); });
    container.querySelectorAll('[data-download]').forEach(el => el.onclick = async (e) => {
      e.stopPropagation();
      const fileId = el.dataset.download;
      const fname = el.dataset.fname || 'file';
      try {
        const res = await fetch('/api/fileById/' + fileId, { headers: authHdr() });
        if (!res.ok) throw new Error('Файл недоступен');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) { window.toast && window.toast(err.message); }
    });
  }

  async function toggleLike(postId) {
    try {
      const r = await api('/api/posts/' + postId + '/like', { method:'POST' });
      const btns = document.querySelectorAll(`[data-like="${postId}"]`);
      btns.forEach(b => { b.classList.toggle('liked', r.liked); b.querySelector('.i').textContent = r.liked ? '❤️' : '🤍'; b.querySelector('.c').textContent = r.likesCount; });
    } catch (e) { window.toast && window.toast(e.message); }
  }

  // ==== ПОСТ: МОДАЛКА ====
  async function openPostView(postId) {
    currentPostId = postId;
    const modal = $('postViewModal');
    const cont = $('postViewContent');
    const comWrap = $('postCommentsWrap');
    cont.innerHTML = `<div class="empty">Загрузка...</div>`;
    comWrap.innerHTML = '';
    modal.classList.add('active');
    try {
      const p = await api('/api/posts/' + postId);
      const isChannelPost = p.wall && p.wall.type === 'channel';
      const wd = p.wallData;
      let filesHtml = '';
      if (p.files && p.files.length) {
        filesHtml = `<div class="post-view-files">` + p.files.map(f => {
          if (f.kind === 'image') return `<div class="pfile" data-view-img="${esc(f.fileId)}" style="margin-bottom:6px"><img src="${getAvatarUrl(f.fileId)}" alt="" /></div>`;
          if (f.kind === 'video') return `<div class="pfile video" style="margin-bottom:6px"><video controls preload="metadata" src="${getAvatarUrl(f.fileId)}" playsinline></video></div>`;
          if (f.kind === 'audio') return `<div class="pfile audio" style="margin-bottom:6px"><span style="font-size:22px">🎵</span><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:600">${esc(f.name)}</div></div><audio controls preload="metadata" src="${getAvatarUrl(f.fileId)}"></audio></div>`;
          return `<div class="pfile doc" style="margin-bottom:6px"><span class="ficon">${fileIcon(f)}</span><div style="flex:1;min-width:0"><div class="fname">${esc(f.name)}</div><div class="fsize">${fmtSize(f.size)}</div></div></div>`;
        }).join('') + `</div>`;
      }
      let repostHtml = '';
      if (p.repostData) { repostHtml = `<div class="post-repost"><div class="rp-hdr">🔄 Репост от @${esc(p.repostData.author)}</div>${p.repostData.text ? `<div class="rp-text">${esc(p.repostData.text)}</div>` : ''}</div>`; }

      // Шапка
      let avatarHtml, nameHtml, metaHtml;
      if (isChannelPost && wd) {
        avatarHtml = wd.avatarFileId ? `<img src="${getAvatarUrl(wd.avatarFileId)}" alt="" />` : '📢';
        nameHtml = `📢 ${esc(wd.name)}`;
        const authorLabel = p.author !== wd.owner ? ` · от @${esc(p.author)}` : '';
        metaHtml = `@${esc(wd.login)} · ${esc(timeAgoFull(p.timestamp))}${authorLabel}`;
      } else {
        avatarHtml = esc((p.authorName || p.author)[0].toUpperCase());
        nameHtml = esc(p.authorName || p.author);
        metaHtml = `@${esc(p.author)} · ${esc(timeAgoFull(p.timestamp))}`;
      }

      cont.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
          <div style="width:40px;height:40px;border-radius:13px;overflow:hidden;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-weight:700;font-size:16px;color:#fff">${avatarHtml}</div>
          <div style="flex:1;min-width:0">
            <div style="font-family:var(--font-head);font-weight:600;font-size:13px;color:var(--text)">${nameHtml}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${metaHtml}</div>
          </div>
        </div>
        ${p.text ? `<div class="post-view-text">${esc(p.text)}</div>` : ''}
        ${filesHtml}
        ${repostHtml}
        <div style="display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--glass-border)">
          <button class="post-act ${p.likedByMe?'liked':''}" data-like="${esc(p.id)}" style="flex:1"><span class="i">${p.likedByMe?'❤️':'🤍'}</span><span class="c">${p.likesCount||0}</span></button>
          <button class="post-act" data-repost="${esc(p.id)}" style="flex:1"><span class="i">🔄</span> Репост</button>
        </div>
      `;
      cont.querySelectorAll('[data-like]').forEach(b => b.onclick = async () => { await toggleLike(b.dataset.like); openPostView(postId); });
      cont.querySelectorAll('[data-repost]').forEach(b => b.onclick = () => openRepost(b.dataset.repost));
      cont.querySelectorAll('[data-view-img]').forEach(el => el.onclick = () => { const src = el.querySelector('img').src; if (window.openImageViewer) window.openImageViewer(src, ''); });

      // Комментарии
      comWrap.innerHTML = `<div class="comments-list" id="commentsListBox"><div class="empty" style="padding:20px">Загрузка комментариев...</div></div>
        <div class="comment-input-wrap"><input id="commentInput" placeholder="Комментарий..." maxlength="1000" /><button onclick="window.feedSubmitComment()">➤</button></div>`;
      loadComments(postId);
      setTimeout(() => { const inp = $('commentInput'); if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') window.feedSubmitComment(); }); }, 100);
    } catch (e) { cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  window.openPostView = openPostView;

  async function loadComments(postId) {
    try {
      const list = await api('/api/posts/' + postId + '/comments');
      const box = $('commentsListBox'); if (!box) return;
      if (!list.length) { box.innerHTML = `<div class="empty" style="padding:16px">Комментариев пока нет</div>`; return; }
      box.innerHTML = list.map(c => renderComment(c)).join('');
      bindCommentActions(box, postId);
    } catch (e) { const box = $('commentsListBox'); if (box) box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  function renderComment(c) {
    const isMine = window.currentUser && c.author === window.currentUser.login;
    return `<div class="comment" data-cid="${esc(c.id)}">
      <div class="cav">${esc((c.authorName || c.author)[0].toUpperCase())}</div>
      <div class="cbody">
        <div class="cname">${esc(c.authorName || c.author)} <span class="ctime">${timeAgoFull(c.timestamp)}</span></div>
        <div class="ctext">${esc(c.text)}</div>
      </div>
      ${isMine ? `<button class="cdel" data-delc="${esc(c.id)}">✕</button>` : ''}
    </div>`;
  }

  function bindCommentActions(box, postId) {
    box.querySelectorAll('[data-delc]').forEach(b => b.onclick = async () => {
      if (!confirm('Удалить комментарий?')) return;
      try { await api('/api/comments/' + b.dataset.delc, { method:'DELETE' }); loadComments(postId); } catch (e) { window.toast && window.toast(e.message); }
    });
  }

  window.feedSubmitComment = async function() {
    if (!currentPostId) return;
    const inp = $('commentInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    try { await api('/api/posts/' + currentPostId + '/comments', { method:'POST', body: JSON.stringify({ text }) }); loadComments(currentPostId); }
    catch (e) { window.toast && window.toast(e.message); }
  };

  // ==== РЕПОСТ ====
  async function openRepost(postId) {
    try {
      const channels = await api('/api/channels/my/list').catch(() => []);
      let wallId = 'user:' + window.currentUser.login;
      if (channels.length) {
        const opts = ['Моя стена', ...channels.map(c => '📢 ' + c.name)];
        const pick = prompt('Куда репостнуть?\n' + opts.map((o, i) => `${i+1}. ${o}`).join('\n'), '1');
        const idx = parseInt(pick) - 1;
        if (isNaN(idx) || idx < 0 || idx >= opts.length) return;
        if (idx > 0) wallId = 'channel:' + channels[idx - 1].id;
      }
      const [wType, wId] = wallId.split(':');
      await api('/api/posts', { method:'POST', body: JSON.stringify({ text: '', files: [], wall: { type: wType, id: wId }, repostOf: postId }) });
      window.toast && window.toast('Репост опубликован');
      if (typeof currentTab !== 'undefined' && currentTab === 'Feed' && window.feedInit) window.feedInit();
      if (typeof currentTab !== 'undefined' && currentTab === 'Wall' && window.renderWall) window.renderWall();
    } catch (e) { window.toast && window.toast(e.message); }
  }
  window.feedRepost = openRepost;

  // ==== МЕНЮ ПОСТА ====
  async function openPostMenu(postId, x, y) {
    const items = [];
    const post = feedPosts.find(p => p.id === postId);
    const isMine = post && window.currentUser && post.author === window.currentUser.login;
    if (isMine) {
      items.push({ label: '✎ Редактировать', fn: async () => { const t = prompt('Новый текст:', post.text); if (t !== null) { try { await api('/api/posts/' + postId, { method:'PUT', body: JSON.stringify({ text: t }) }); window.toast && window.toast('Обновлено'); if (typeof currentTab !== 'undefined' && currentTab === 'Feed') loadFeed(); } catch (e) { window.toast && window.toast(e.message); } } } });
      items.push({ label: '🗑 Удалить', danger:true, fn: async () => { if (!confirm('Удалить пост?')) return; try { await api('/api/posts/' + postId, { method:'DELETE' }); if (typeof currentTab !== 'undefined' && currentTab === 'Feed') loadFeed(); if (typeof currentTab !== 'undefined' && currentTab === 'Wall' && window.renderWall) window.renderWall(); } catch (e) { window.toast && window.toast(e.message); } } });
    }
    items.push({ label: '🔗 Копировать ссылку', fn: () => { navigator.clipboard?.writeText(location.origin + '/?post=' + postId); window.toast && window.toast('Ссылка скопирована'); } });
    if (!items.length) return;
    const ctx = $('ctxMenu');
    ctx.innerHTML = items.map((it, i) => `<button data-i="${i}" class="${it.danger?'danger':''}">${it.label}</button>`).join('');
    ctx.querySelectorAll('button').forEach(b => b.onclick = () => { ctx.classList.remove('active'); items[+b.dataset.i].fn(); });
    ctx.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - 220) + 'px';
    ctx.classList.add('active');
  }

  // ==== WS ====
  window.feedOnWs = function(type, payload) {
    if (typeof currentTab === 'undefined') return;
    if (currentTab !== 'Feed' && currentTab !== 'Wall') return;
    if (type === 'newPost' || type === 'postDeleted' || type === 'postUpdated') {
      if (currentTab === 'Feed') loadFeed();
      if (currentTab === 'Wall' && window.renderWall) window.renderWall();
    }
    if (type === 'commentAdded' || type === 'commentDeleted') { if (currentPostId === payload.postId) loadComments(payload.postId); }
  };

  console.log('[Feed] v2.30 loaded');
})();
