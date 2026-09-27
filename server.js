<script>
// ============================================================
//  КРИСТА.ФРИРУНЕТ v4.40 — JS
// ============================================================
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// ============================================================
//  🟡 КОЛОБКИ — только 20 реальных
// ============================================================
const KOLOBKI_LIST = [
  'yes','yes2','yes3','yes4','victory','yahoo','yu',
  'umnik','umnik2','to_clue',
  'whistle','whistle2','whistle3',
  'wink3','tongue','sarcasm','facepalm',
  'sorry2','cray2','to_take_umbrage'
];
const KOLOBOK_ALIAS = {
  yes:'yes', yes2:'yes2', yes3:'yes3', yes4:'yes4', victory:'victory', yahoo:'yahoo', yu:'yu',
  umnik:'umnik', umnik2:'umnik2', to_clue:'to_clue',
  whistle:'whistle', whistle2:'whistle2', whistle3:'whistle3',
  wink3:'wink3', tongue:'tongue', sarcasm:'sarcasm', facepalm:'facepalm',
  sorry2:'sorry2', cray2:'cray2', to_take_umbrage:'to_take_umbrage'
};
function kolobokUrl(alias) {
  const real = KOLOBOK_ALIAS[alias] || alias;
  return `/api/kolobok/${real}`;
}
function hasKolobok(alias) { return !!KOLOBOK_ALIAS[alias]; }

const EMOJI_LIST = ['😀','😁','😂','🤣','😊','😇','🙂','🙃','😉','😍','🥰','😘','😗','😙','😚','😋','😜','🤪','😝','😛','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','💋','💌','💘','💝','💖','💗','💓','💞','💕','❣️','❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💯','💢','💥','💫','💦','💨','💬','💭','🔥','⭐','🌟','✨','⚡','☀️','🌤️','⛅','☁️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌈','☂️','☔','💧','🌊'];
const REACTIONS = ['yahoo','victory','tongue','sarcasm','cray2','facepalm'];

function renderKolobki(text) {
  let s = esc(text);
  s = s.replace(/\[([a-z0-9_]+)\]/g, (m, k) => KOLOBOK_ALIAS[k] ? `\u0001${k}\u0001` : m);
  s = s.replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi, match => {
    const u = match.startsWith('www.') ? 'http://' + match : match;
    return `<span class="link" data-url="${esc(u)}">${esc(match)}</span>`;
  });
  s = s.replace(/@([a-zA-Z0-9_-]{3,32})/g, (_, n) => `<span class="mention" data-user="${esc(n)}">@${esc(n)}</span>`);
  s = s.replace(/(^|\s)(#[\wа-яА-ЯёЁ]{2,40})/g, (_, pre, tag) => `${pre}<span class="hashtag">${esc(tag)}</span>`);
  s = s.replace(/\u0001([a-z0-9_]+)\u0001/g, (_, k) => `<img class="kolobok" src="${kolobokUrl(k)}" alt="${k}" onerror="this.style.opacity=.3">`);
  return s;
}

const SMILE_AUTOREPLACE = [
  [/\(y\)/i, 'yes'],
  [/\(n\)/i, 'yes2'],
  [/\^_\^/, 'yahoo'],
  [/:-?D/i, 'victory'],
  [/;-?P/i, 'tongue'],
  [/;-?\)/, 'wink3'],
  [/:-?\(\(/, 'cray2'],
  [/:-?\(/, 'sorry2'],
  [/:-?\//, 'sarcasm'],
  [/:-?\|/, 'facepalm'],
  [/:-?O/i, 'to_clue'],
];
function autoReplaceSmiles(text) {
  let s = text;
  for (const [re, key] of SMILE_AUTOREPLACE) s = s.replace(re, `[${key}]`);
  return s;
}

// ============================================================
//  ШРИФТЫ
// ============================================================
const FONTS = {
  classic: { head:'Comfortaa', body:'Inter', label:'Классика' },
  tech: { head:'Unbounded', body:'Manrope', label:'Техно' },
  warm: { head:'Raleway', body:'Nunito', label:'Тёплый' },
  book: { head:'Playfair Display', body:'Open Sans', label:'Книжный' },
  mono: { head:'JetBrains Mono', body:'JetBrains Mono', label:'Моно' },
  caveat: { head:'Caveat', body:'Caveat', label:'Рукописный' },
  marck: { head:'Marck Script', body:'Marck Script', label:'Каллиграфия' },
  bad: { head:'Bad Script', body:'Bad Script', label:'Лёгкий' },
  neucha: { head:'Neucha', body:'Neucha', label:'Небрежный' },
  philosopher: { head:'Philosopher', body:'Philosopher', label:'Антиква' },
  cormorant: { head:'Cormorant', body:'Cormorant', label:'Элегантный' },
  bitter: { head:'Bitter', body:'Bitter', label:'Сериф' },
  ptserif: { head:'PT Serif', body:'PT Serif', label:'PT Сериф' },
  montserrat: { head:'Montserrat', body:'Montserrat', label:'Геометрия' },
  rubik: { head:'Rubik', body:'Rubik', label:'Округлый' },
  oswald: { head:'Oswald', body:'Oswald', label:'Конденсат' },
  merriweather: { head:'Merriweather', body:'Merriweather', label:'Классика 2' }
};

// ============================================================
//  СОСТОЯНИЕ
// ============================================================
let token = localStorage.getItem('krista_token') || null;
let currentUser = JSON.parse(localStorage.getItem('krista_user') || 'null');
let ws = null, wsState = 'offline', lastPongAt = 0, pingInt = null, wdInt = null;
let chats = [], currentChatId = null, currentChatMeta = null;
let messages = {}, onlineStatus = {};
let folders = [], editingFolderId = null, folderDraftChatIds = [];
let sendQueue = [], reconnectTimer = null;
let drafts = JSON.parse(localStorage.getItem('krista_drafts') || '{}');
let firstUnreadId = null, replyToMsg = null;
let currentView = 'chats';
let ui = JSON.parse(localStorage.getItem('krista_ui') || '{}');
ui.accent = ui.accent || '#f0a0c8';
ui.blur = ui.blur !== undefined ? ui.blur : 18;
ui.msgInOpacity = ui.msgInOpacity !== undefined ? ui.msgInOpacity : 1;
ui.msgOutOpacity = ui.msgOutOpacity !== undefined ? ui.msgOutOpacity : 1;
ui.viewPC = ui.viewPC || false;
ui.chatWallpaper = ui.chatWallpaper || null;
ui.appWallpaper = ui.appWallpaper || null;
ui.font = ui.font || 'classic';
let profile = { emoji:'🌸', name:'ЛесГем', login:'' };
let authMode = 'login';
let typingTimer = null;
let fileBlobCache = new Map();
let emojiPack = 'kolobok';
let activeMsgForReminder = null;
let remindersCache = [], favoritesCache = [], searchHistoryCache = [], systemThemesCache = [];
let aliasEditingChatId = null;
let accounts = JSON.parse(localStorage.getItem('krista_accounts') || '[]');
let wakingTimer = null, wakingTimeout = null;

const $ = id => document.getElementById(id);
const $$ = s => document.querySelectorAll(s);
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
const fmtSize = b => !b && b !== 0 ? '' : b < 1024 ? b + ' Б' : b < 1048576 ? (b/1024).toFixed(1) + ' КБ' : (b/1048576).toFixed(2) + ' МБ';
const fTime = iso => { try { return new Date(iso).toTimeString().slice(0,5); } catch { return ''; } };
const fDateTime = iso => { try { return new Date(iso).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); } catch { return ''; } };
const fDate = iso => { try { const d = new Date(iso), m = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']; return `${d.getDate()} ${m[d.getMonth()]}`; } catch { return ''; } };
const shade = (hex, pct) => { try { const n = parseInt(hex.replace('#',''),16), r = Math.max(0,Math.min(255,(n>>16)+pct)), g = Math.max(0,Math.min(255,((n>>8)&0xff)+pct)), b = Math.max(0,Math.min(255,(n&0xff)+pct)); return '#'+((r<<16)|(g<<8)|b).toString(16).padStart(6,'0'); } catch { return hex; } };
const hexRgb = hex => { try { const n = parseInt(hex.replace('#',''),16); return [(n>>16)&255,(n>>8)&255,n&255].join(','); } catch { return '240,160,200'; } };
const getPalette = () => ['#f0a0c8','#8ee0a8','#ff6a6a','#6aa0ff','#6ad4ff','#c9a8ff'];
const getAvatarUrl = id => id ? `/api/file/${id}?token=${encodeURIComponent(token||'')}` : '';
const avatarInner = u => { if (!u) return '<span>?</span>'; if (u.avatarFileId) return `<img src="${getAvatarUrl(u.avatarFileId)}" alt="">`; return esc(((u.nickname||u.login||'?')[0]||'?').toUpperCase()); };
const timeAgo = iso => { try { const diff = (Date.now()-new Date(iso).getTime())/1000; if (diff<60) return 'только что'; if (diff<3600) return `${Math.floor(diff/60)} мин назад`; if (diff<86400) return `${Math.floor(diff/3600)} ч назад`; return `${Math.floor(diff/86400)} дн назад`; } catch { return ''; } };

function applyUI() {
  document.body.style.setProperty('--accent', ui.accent);
  document.body.style.setProperty('--accent-2', shade(ui.accent, -25));
  document.body.style.setProperty('--accent-soft', `rgba(${hexRgb(ui.accent)},.18)`);
  document.body.style.setProperty('--accent-glow', `rgba(${hexRgb(ui.accent)},.35)`);
  document.body.style.setProperty('--blur', ui.blur + 'px');
  document.body.style.setProperty('--msg-in-opacity', String(ui.msgInOpacity));
  document.body.style.setProperty('--msg-out-opacity', String(ui.msgOutOpacity));
  document.body.style.setProperty('--chat-wallpaper', ui.chatWallpaper ? `url('${getAvatarUrl(ui.chatWallpaper.fileId)}')` : 'none');
  document.body.style.setProperty('--app-wallpaper', ui.appWallpaper ? `url('${getAvatarUrl(ui.appWallpaper.fileId)}')` : 'none');
  const f = FONTS[ui.font] || FONTS.classic;
  document.body.style.setProperty('--font-head', `'${f.head}',sans-serif`);
  document.body.style.setProperty('--font-body', `'${f.body}',sans-serif`);
  document.body.classList.toggle('view-pc', !!ui.viewPC);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', ui.accent);
  localStorage.setItem('krista_ui', JSON.stringify(ui));
}

// ============================================================
//  API с баннером "сервер просыпается"
// ============================================================
function showWaking() {
  const el = $('wakingBar');
  if (!el) return;
  el.classList.add('show');
  clearTimeout(wakingTimeout);
  wakingTimeout = setTimeout(() => el.classList.remove('show'), 60000);
}
function hideWaking() {
  const el = $('wakingBar');
  if (el) el.classList.remove('show');
  clearTimeout(wakingTimeout);
}

async function api(url, opts = {}) {
  const h = { 'Content-Type':'application/json', ...(opts.headers||{}) };
  if (token) h.Authorization = 'Bearer ' + token;
  clearTimeout(wakingTimer);
  wakingTimer = setTimeout(showWaking, 4000);
  try {
    const r = await fetch(url, { ...opts, headers: h });
    clearTimeout(wakingTimer);
    hideWaking();
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || 'Ошибка'); e.status = r.status; throw e; }
    return d;
  } catch (e) {
    clearTimeout(wakingTimer);
    hideWaking();
    throw e;
  }
}

function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200); }
window.toast = toast;
function closeModal(id) { $(id)?.classList.remove('open'); if (id === 'imgViewerModal') $('imgViewerImg').src = ''; }
window.closeModal = closeModal;
document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }));

// ============================================================
//  WEBSOCKET
// ============================================================
function connectWS() {
  if (!token || !navigator.onLine) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { if (ws) ws.close(); } catch {}
  wsState = 'connecting'; updateWsDot();
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type:'auth', payload:{ token } }));
    lastPongAt = Date.now();
    wsState = 'online'; updateWsDot();
    startHeartbeat(); flushQueue();
    if (currentChatId) sendWS({ type:'activeChat', payload:{ chatId: currentChatId } });
  };
  ws.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'pong') { lastPongAt = Date.now(); return; }
      if (d.type === 'ping') { try { ws.send(JSON.stringify({ type:'pong' })); } catch {} return; }
      handleWS(d);
    } catch {}
  };
  ws.onclose = () => {
    ws = null; stopHeartbeat(); wsState = 'offline'; updateWsDot();
    if (token) { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connectWS, 2000); }
  };
  ws.onerror = () => {};
}
function startHeartbeat() {
  stopHeartbeat();
  pingInt = setInterval(() => { if (ws?.readyState === 1) try { ws.send(JSON.stringify({ type:'ping' })); } catch {} }, 5000);
  wdInt = setInterval(() => { if (ws?.readyState === 1 && Date.now() - lastPongAt > 35000) { try { ws.close(); } catch {} } }, 6000);
}
function stopHeartbeat() { if (pingInt) clearInterval(pingInt), pingInt = null; if (wdInt) clearInterval(wdInt), wdInt = null; }
function flushQueue() { if (!sendQueue.length || !ws || ws.readyState !== 1) return; const q = [...sendQueue]; sendQueue = []; q.forEach(p => { try { ws.send(JSON.stringify({ type:'newMessage', payload:p })); } catch { sendQueue.push(p); } }); }
function sendWS(o) { if (ws && ws.readyState === 1) try { ws.send(JSON.stringify(o)); return true; } catch {} return false; }
window.sendWS = sendWS;
function updateWsDot() { const d = $('wsDot'); if (!d) return; d.classList.toggle('on', wsState === 'online'); }

async function handleWS(data) {
  const { type, payload } = data;
  if (type === 'newMessage') {
    if (!messages[payload.chatId]) messages[payload.chatId] = [];
    if (messages[payload.chatId].some(m => m.id === payload.id || (payload.clientId && m.clientId === payload.clientId))) {
      const i = messages[payload.chatId].findIndex(m => m.clientId && m.clientId === payload.clientId);
      if (i !== -1) messages[payload.chatId][i] = payload;
      if (currentChatId === payload.chatId) renderMessages();
      return;
    }
    messages[payload.chatId].push(payload);
    if (currentChatId === payload.chatId) { renderMessages(); sendWS({ type:'delivered', payload:{ messageId: payload.id } }); }
    loadChats();
  }
  else if (type === 'messageAck') {
    if (payload.clientId && messages[currentChatId]) {
      const i = messages[currentChatId].findIndex(m => m.clientId === payload.clientId);
      if (i !== -1) { messages[currentChatId][i].pending = false; messages[currentChatId][i].id = payload.id; renderMessages(); }
    }
  }
  else if (type === 'messageReaction') {
    if (messages[payload.chatId]) {
      const i = messages[payload.chatId].findIndex(m => m.id === payload.id);
      if (i !== -1) { messages[payload.chatId][i].reactions = payload.reactions; if (currentChatId === payload.chatId) renderMessages(); }
    }
  }
  else if (type === 'messagesRead') {
    const arr = messages[payload.chatId];
    if (arr) {
      payload.messageIds.forEach(id => { const m = arr.find(x => x.id === id); if (m) m.readBy = [...(m.readBy||[]), payload.byLogin]; });
      if (currentChatId === payload.chatId) renderMessages();
    }
  }
  else if (type === 'deleteMessage') {
    if (messages[payload.chatId]) {
      const i = messages[payload.chatId].findIndex(m => m.id === payload.messageId);
      if (i !== -1) messages[payload.chatId][i].deleted = 1;
      if (currentChatId === payload.chatId) renderMessages();
    }
    loadChats();
  }
  else if (type === 'chatCleared') {
    if (messages[payload.chatId]) messages[payload.chatId] = [];
    if (currentChatId === payload.chatId) renderMessages();
    loadChats();
  }
  else if (type === 'chatDeleted') {
    chats = chats.filter(c => c.id !== payload.chatId);
    delete messages[payload.chatId];
    if (currentChatId === payload.chatId) { currentChatId = null; currentChatMeta = null; $('chatScreen').classList.remove('open'); }
    renderFolders();
  }
  else if (type === 'status') {
    onlineStatus[payload.login] = payload.status === 'online';
    renderFolders();
    if (currentChatMeta && !currentChatMeta.isGroup) updateChatHeader(currentChatMeta);
  }
  else if (type === 'userUpdated') {
    if (currentChatMeta?.otherLogin === payload.login) { currentChatMeta.otherUser = payload; updateChatHeader(currentChatMeta); }
    renderFolders();
  }
  else if (type === 'typing') {
    if (payload.chatId === currentChatId) {
      const bar = $('typingBar');
      $('typingText').textContent = payload.nickname + ' печатает';
      const live = $('typingLiveText');
      if (payload.text && payload.text.length > 0) { live.setAttribute('data-text', payload.text); live.style.display = ''; }
      else live.style.display = 'none';
      bar.classList.add('vis');
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => bar.classList.remove('vis'), 4000);
    }
  }
  else if (type === 'chatThemeChanged') { if (currentChatId === payload.chatId) applyChatTheme(payload.theme); }
  else if (type === 'reminderDue') {
    playReminderSound();
    toast('⏰ Напоминание: ' + (payload.text || '').slice(0, 60));
    if (payload.chatId && chats.find(c => c.id === payload.chatId)) openChat(payload.chatId);
  }
  else if (['chatCreated','chatRenamed','memberAdded','memberRemoved','adminChanged'].includes(type)) { loadChats(); }
  else if (type === 'error') {
    if (payload?.clientId) {
      const arr = messages[currentChatId];
      if (arr) { const i = arr.findIndex(m => m.clientId === payload.clientId); if (i !== -1) { arr[i].pending = false; arr[i].failed = true; renderMessages(); } }
    }
    if (payload?.error) toast(payload.error);
  }
  else if (type === 'musicAdded' || type === 'musicRemoved') {
    if (window.musicOnWsEvent) window.musicOnWsEvent(type, payload);
  }
}

function playReminderSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.6);
    setTimeout(() => {
      const o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.connect(g2); g2.connect(ctx.destination);
      o2.frequency.value = 1200;
      g2.gain.setValueAtTime(0.001, ctx.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
      g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      o2.start(ctx.currentTime); o2.stop(ctx.currentTime + 0.6);
    }, 300);
  } catch {}
}

// ============================================================
//  CHATS + FOLDERS
// ============================================================
async function loadChats() {
  if (!token || !navigator.onLine) return;
  try { const fresh = await api('/api/chats'); chats = fresh; renderFolders(); updateChatsBadge(); }
  catch (e) { if (e.status === 401) logout(); }
}
async function loadFolders() {
  if (!token) return;
  try { folders = await api('/api/folders'); renderFolders(); }
  catch {}
}
function updateChatsBadge() {
  const total = chats.reduce((s, c) => s + (c.unreadCount || 0), 0);
  const b = $('sbChatsBadge');
  if (total > 0) { b.textContent = total > 99 ? '99+' : total; b.style.display = 'flex'; }
  else b.style.display = 'none';
}

function getChatsForFolder(f) {
  const active = chats.filter(c => !c.archived);
  const archived = chats.filter(c => c.archived);
  if (f.system) {
    switch (f.filter) {
      case 'unread': return active.filter(c => c.unreadCount > 0);
      case 'online': return active.filter(c => !c.isGroup && (c.otherUser?.online || onlineStatus[c.otherLogin]));
      case 'all': return active;
    }
    return [];
  }
  if (f.id === '__archive') return archived;
  return (f.chatIds || []).map(id => chats.find(c => c.id === id)).filter(Boolean);
}
function folderCount(f) {
  if (f.system && f.filter === 'unread') return getChatsForFolder(f).reduce((s, c) => s + (c.unreadCount || 0), 0);
  if (f.id === '__archive') return chats.filter(c => c.archived).length;
  return getChatsForFolder(f).length;
}

function renderFolders() {
  const area = $('foldersArea');
  if (!area) return;
  if (!folders.length) {
    area.innerHTML = `<div class="empty"><div class="big">🌸 Криста<small>ФриРунет</small></div>Пока нет папок.<br>Нажми «📁 Управление папками» снизу.</div>`;
    return;
  }
  const sorted = [...folders].sort((a, b) => (a.order || 0) - (b.order || 0));
  let html = '';
  sorted.forEach(f => {
    const cnt = folderCount(f);
    const list = getChatsForFolder(f);
    html += `<div class="folder ${f.open?'open':''}" data-fid="${f.id}">
      <div class="folder-header" data-fid="${f.id}">
        <div class="folder-chevron">▶</div>
        <div class="folder-icon">${esc(f.icon)}</div>
        <div class="folder-name">${esc(f.name)}</div>
        <div class="folder-count">${cnt}</div>
        <button class="folder-menu-btn" data-menu="1" data-fid="${f.id}" title="Меню">⋮</button>
      </div>
      <div class="folder-body">
        ${list.length ? list.map(renderChatRow).join('') : '<div class="folder-empty">— пусто —</div>'}
      </div>
    </div>`;
  });
  const archCount = chats.filter(c => c.archived).length;
  if (archCount > 0) {
    const archOpen = localStorage.getItem('krista_archive_open') === '1';
    const archList = chats.filter(c => c.archived);
    html += `<div class="folder archived ${archOpen?'open':''}" data-fid="__archive">
      <div class="folder-header" data-fid="__archive">
        <div class="folder-chevron">▶</div>
        <div class="folder-icon">📦</div>
        <div class="folder-name">Архив</div>
        <div class="folder-count">${archCount}</div>
      </div>
      <div class="folder-body">${archList.map(renderChatRow).join('')}</div>
    </div>`;
  }
  area.innerHTML = html;
  bindFolderEvents();
  bindChatRows();
}

function bindFolderEvents() {
  const area = $('foldersArea');
  area.querySelectorAll('.folder').forEach(folder => {
    const fid = folder.dataset.fid;
    const header = folder.querySelector('.folder-header');
    const menuBtn = folder.querySelector('[data-menu]');
    const isArchive = fid === '__archive';

    header.addEventListener('click', e => {
      if (e.target.closest('[data-menu]')) return;
      if (isArchive) {
        const isOpen = folder.classList.toggle('open');
        localStorage.setItem('krista_archive_open', isOpen ? '1' : '0');
        return;
      }
      toggleFolder(fid);
    });

    if (!isArchive) {
      let touchTimer;
      header.addEventListener('touchstart', e => {
        const t = e.touches[0];
        touchTimer = setTimeout(() => openFolderCtx({ clientX: t.clientX, clientY: t.clientY }, fid), 600);
      });
      header.addEventListener('touchend', () => clearTimeout(touchTimer));
      header.addEventListener('touchmove', () => clearTimeout(touchTimer));
      header.addEventListener('contextmenu', e => { e.preventDefault(); openFolderCtx(e, fid); });
    }

    if (menuBtn && !isArchive) {
      menuBtn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        const rect = menuBtn.getBoundingClientRect();
        openFolderCtx({ clientX: rect.left, clientY: rect.bottom + 4 }, fid);
      });
    }
  });
}

function renderChatRow(c) {
  const isOn = c.isGroup ? false : (c.otherUser?.online || onlineStatus[c.otherLogin]);
  const u = c.isGroup ? null : c.otherUser;
  const av = c.isGroup ? (c.avatarFileId ? `<img src="${getAvatarUrl(c.avatarFileId)}" alt="">` : '<span style="color:#fff">#</span>') : avatarInner(u);
  const emoji = u?.nicknameEmoji ? `<span class="chat-emoji">${esc(u.nicknameEmoji)}</span>` : '';
  const origName = c.isGroup ? c.name : (u?.nickname || c.otherLogin || '?');
  const displayName = c.alias || origName;
  const aliasMark = c.alias ? `<span class="chat-alias-mark" title="Псевдоним">🏷</span>` : '';
  let preview = 'нет сообщений';
  if (c.lastMessage) {
    if (c.lastMessage.type === 'file' && c.lastMessage.file) {
      const f = c.lastMessage.file;
      preview = f.kind === 'image' ? '🖼 Фото' : '📎 ' + (f.name || 'файл');
    } else preview = (c.lastMessage.text || '').replace(/\[[a-z0-9_]+\]/g, '🙂').slice(0, 40);
  }
  const draft = drafts[c.id]?.text;
  const previewHtml = draft ? `<span class="draft-label">Черновик:</span> <span class="draft">${esc(draft.slice(0,30))}</span>` : esc(preview);
  const unreadClass = c.unreadCount > 0 ? 'unread-strong' : '';
  return `<div class="chat-row ${unreadClass}" data-cid="${c.id}">
    <div class="chat-avatar ${isOn?'online':''}">${av}</div>
    <div class="chat-info">
      <div class="chat-name">${emoji}<span>${esc(displayName)}</span>${aliasMark}</div>
      <div class="chat-preview">${previewHtml}</div>
    </div>
    <div class="chat-right">
      <div class="chat-time">${c.lastMessage ? fTime(c.lastMessage.timestamp) : ''}</div>
      ${c.unreadCount > 0 ? `<div class="chat-badge">${c.unreadCount}</div>` : ''}
    </div>
  </div>`;
}

function bindChatRows() {
  const area = $('foldersArea');
  if (!area) return;
  area.querySelectorAll('.chat-row').forEach(row => {
    const cid = row.dataset.cid;
    let clickTimer = null, lastTap = 0;
    row.addEventListener('click', e => {
      const now = Date.now();
      if (now - lastTap < 300) {
        if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
        lastTap = 0;
        markAsRead(cid);
        return;
      }
      lastTap = now;
      clickTimer = setTimeout(() => { clickTimer = null; openChat(cid); }, 250);
    });
    row.oncontextmenu = e => { e.preventDefault(); openChatCtx(e, cid); };
    let touchTimer;
    row.addEventListener('touchstart', e => {
      const t = e.touches[0];
      touchTimer = setTimeout(() => openChatCtx({ clientX: t.clientX, clientY: t.clientY }, cid), 550);
    });
    row.addEventListener('touchend', () => clearTimeout(touchTimer));
    row.addEventListener('touchmove', () => clearTimeout(touchTimer));
  });
}

function toggleFolder(id) {
  const f = folders.find(x => x.id === id);
  if (!f) return;
  f.open = !f.open;
  renderFolders();
  api('/api/folders/' + id, { method:'PUT', body:JSON.stringify({ open: f.open }) }).catch(()=>{});
}
window.toggleFolder = toggleFolder;

// ============================================================
//  CONTEXT MENUS
// ============================================================
let ctxFolderId = null, ctxChatId = null;

function openFolderCtx(event, id) {
  event.stopPropagation?.();
  ctxFolderId = id;
  const f = folders.find(x => x.id === id);
  if (!f) return;
  const menu = $('ctxMenu');
  let items = '';
  if (!f.system) items += `<div class="ctx-item" data-act="edit"><span class="ci">✎</span><span class="cl">Переименовать</span></div>`;
  if (!f.system) items += `<div class="ctx-sep"></div><div class="ctx-item danger" data-act="del"><span class="ci">✕</span><span class="cl">Удалить папку</span></div>`;
  if (!items) items = `<div class="ctx-item" data-act="close"><span class="ci">ℹ</span><span class="cl">Системная папка</span></div>`;
  menu.innerHTML = items;
  menu.classList.add('open');
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.onclick = () => {
      const act = el.dataset.act;
      menu.classList.remove('open');
      if (act === 'edit') editFolder(id);
      else if (act === 'del') deleteFolder(id);
    };
  });
  positionCtxMenu(menu, event);
}
window.openFolderCtx = openFolderCtx;

function openChatCtx(event, id) {
  event.stopPropagation?.();
  ctxChatId = id;
  const c = chats.find(x => x.id === id);
  if (!c) return;
  const menu = $('ctxMenu');
  let items = '';
  items += `<div class="ctx-item primary" data-act="read"><span class="ci">✓</span><span class="cl">Прочитано</span></div>`;
  items += `<div class="ctx-item" data-act="alias"><span class="ci">🏷</span><span class="cl">${c.alias?'Изменить псевдоним':'Псевдоним'}</span></div>`;
  items += `<div class="ctx-item" data-act="archive"><span class="ci">📦</span><span class="cl">${c.archived?'Из архива':'В архив'}</span></div>`;
  if (c.isGroup && c.isAdmin) items += `<div class="ctx-item" data-act="settings"><span class="ci">⚙</span><span class="cl">Настройки группы</span></div>`;
  if (c.isGroup && !c.isAdmin) items += `<div class="ctx-item danger" data-act="leave"><span class="ci">↩</span><span class="cl">Покинуть</span></div>`;
  const canDel = !c.isGroup || c.isAdmin;
  if (canDel) items += `<div class="ctx-sep"></div><div class="ctx-item danger" data-act="delete"><span class="ci">🗑</span><span class="cl">Удалить</span></div>`;
  menu.innerHTML = items;
  menu.classList.add('open');
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.onclick = () => {
      const act = el.dataset.act;
      menu.classList.remove('open');
      if (act === 'read') markAsRead(id);
      else if (act === 'alias') openAliasEdit(id);
      else if (act === 'archive') archiveChat(id, !c.archived);
      else if (act === 'settings') { currentChatMeta = c; openGroupSettings(); }
      else if (act === 'leave') { gsChatId = id; leaveGroup(); }
      else if (act === 'delete') deleteChatConfirm(id);
    };
  });
  positionCtxMenu(menu, event);
}
window.openChatCtx = openChatCtx;

function positionCtxMenu(menu, event) {
  const x = event.clientX || 100, y = event.clientY || 100;
  const w = menu.offsetWidth || 220, h = menu.offsetHeight || 220;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
}
document.addEventListener('click', e => { if (!e.target.closest('#ctxMenu')) $('ctxMenu').classList.remove('open'); });

async function markAsRead(id) {
  try { await api('/api/chats/' + id + '/messages'); toast('✓ Прочитано'); loadChats(); } catch {}
}
window.markAsRead = markAsRead;

async function archiveChat(id, arch) {
  try { await api('/api/chats/' + id + '/archive', { method:'POST', body:JSON.stringify({ archived: arch }) }); toast(arch ? '📦 В архиве' : 'Извлечено'); loadChats(); }
  catch (e) { toast(e.message); }
}
window.archiveChat = archiveChat;

function openAliasEdit(id) {
  const c = chats.find(x => x.id === id);
  if (!c) return;
  aliasEditingChatId = id;
  $('aliasInput').value = c.alias || '';
  $('aliasModal').classList.add('open');
  setTimeout(() => $('aliasInput').focus(), 150);
}
window.openAliasEdit = openAliasEdit;

async function saveAlias() {
  if (!aliasEditingChatId) return;
  const alias = $('aliasInput').value.trim();
  try {
    await api('/api/chats/' + aliasEditingChatId + '/alias', { method:'PUT', body:JSON.stringify({ alias }) });
    const c = chats.find(x => x.id === aliasEditingChatId);
    if (c) c.alias = alias || null;
    closeModal('aliasModal');
    renderFolders();
    toast(alias ? '🏷 Сохранено' : 'Псевдоним убран');
  } catch (e) { toast(e.message); }
}
window.saveAlias = saveAlias;

// ============================================================
//  FOLDERS MANAGER
// ============================================================
function openFoldersManager() {
  renderFoldersManager();
  $('foldersManagerModal').classList.add('open');
}
window.openFoldersManager = openFoldersManager;

function renderFoldersManager() {
  const el = $('foldersManagerList');
  if (!el) return;
  const sorted = [...folders].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!sorted.length) { el.innerHTML = '<div class="empty">Нет папок</div>'; return; }
  el.innerHTML = sorted.map(f => {
    const cnt = folderCount(f);
    const sys = f.system ? `<span class="fm-badge">СИСТЕМНАЯ</span>` : '';
    const actions = f.system ? '' : `<div class="fm-actions"><button data-edit="${f.id}" title="Изменить">✎</button><button class="del" data-del="${f.id}" title="Удалить">✕</button></div>`;
    return `<div class="fm-row"><div class="fm-icon">${esc(f.icon)}</div><div class="fm-body"><div class="fm-name">${esc(f.name)}${sys}</div><div class="fm-sub">${cnt} чат(ов)</div></div>${actions}</div>`;
  }).join('');
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { closeModal('foldersManagerModal'); editFolder(b.dataset.edit); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Удалить папку?')) return;
    try { await api('/api/folders/' + b.dataset.del, { method:'DELETE' }); folders = folders.filter(x => x.id !== b.dataset.del); renderFolders(); renderFoldersManager(); toast('Удалено'); }
    catch (e) { toast(e.message); }
  });
}

function createFolder() {
  editingFolderId = null;
  folderDraftChatIds = [];
  $('folderModalTitle').textContent = 'Новая папка';
  $('folderNameInput').value = '';
  $('folderIconInput').value = '📁';
  $('folderModalSave').textContent = 'Создать';
  renderFolderChatsPicker();
  closeModal('foldersManagerModal');
  $('folderModal').classList.add('open');
  setTimeout(() => $('folderNameInput').focus(), 150);
}
window.createFolder = createFolder;

function editFolder(id) {
  const f = folders.find(x => x.id === id);
  if (!f) return;
  if (f.system) return toast('Системную папку нельзя изменить');
  editingFolderId = id;
  folderDraftChatIds = [...(f.chatIds || [])];
  $('folderModalTitle').textContent = 'Редактировать папку';
  $('folderNameInput').value = f.name;
  $('folderIconInput').value = f.icon;
  $('folderModalSave').textContent = 'Сохранить';
  renderFolderChatsPicker();
  closeModal('foldersManagerModal');
  $('folderModal').classList.add('open');
}
window.editFolder = editFolder;

async function deleteFolder(id) {
  if (!confirm('Удалить папку?')) return;
  try { await api('/api/folders/' + id, { method:'DELETE' }); folders = folders.filter(f => f.id !== id); renderFolders(); toast('Удалено'); }
  catch (e) { toast(e.message); }
}
window.deleteFolder = deleteFolder;

function renderFolderChatsPicker() {
  const el = $('folderChatsPicker');
  if (!el) return;
  const active = chats.filter(c => !c.archived);
  el.innerHTML = active.map(c => {
    const checked = folderDraftChatIds.includes(c.id);
    const name = c.alias || (c.isGroup ? c.name : (c.otherUser?.nickname || c.otherLogin || '?'));
    return `<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--glass-2);border:1px solid ${checked?'var(--accent)':'var(--glass-border)'};border-radius:10px;margin-bottom:6px;cursor:pointer;font-size:12px;color:var(--text)">
      <input type="checkbox" ${checked?'checked':''} data-cid="${c.id}" style="width:18px;height:18px;margin:0;padding:0;accent-color:var(--accent)">
      <span>${esc(name)}</span>
    </label>`;
  }).join('') || '<div class="empty">Нет чатов</div>';
  el.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.onchange = () => toggleFolderChat(cb.dataset.cid, cb.checked); });
}
function toggleFolderChat(id, on) {
  if (on && !folderDraftChatIds.includes(id)) folderDraftChatIds.push(id);
  else if (!on) folderDraftChatIds = folderDraftChatIds.filter(x => x !== id);
}
window.toggleFolderChat = toggleFolderChat;

async function saveFolder() {
  const name = $('folderNameInput').value.trim();
  const icon = $('folderIconInput').value.trim() || '📁';
  if (!name) return toast('Введите название');
  try {
    if (editingFolderId) {
      await api('/api/folders/' + editingFolderId, { method:'PUT', body:JSON.stringify({ name, icon }) });
      const current = folders.find(x => x.id === editingFolderId);
      const toAdd = folderDraftChatIds.filter(id => !(current.chatIds||[]).includes(id));
      const toRemove = (current.chatIds||[]).filter(id => !folderDraftChatIds.includes(id));
      for (const id of toAdd) await api('/api/folders/' + editingFolderId + '/chats', { method:'POST', body:JSON.stringify({ chatId:id }) }).catch(()=>{});
      for (const id of toRemove) await api('/api/folders/' + editingFolderId + '/chats/' + id, { method:'DELETE' }).catch(()=>{});
    } else {
      const f = await api('/api/folders', { method:'POST', body:JSON.stringify({ name, icon }) });
      for (const id of folderDraftChatIds) await api('/api/folders/' + f.id + '/chats', { method:'POST', body:JSON.stringify({ chatId:id }) }).catch(()=>{});
    }
    closeModal('folderModal');
    await loadFolders();
    toast(editingFolderId ? 'Сохранено' : 'Папка создана');
  } catch (e) { toast(e.message); }
}
window.saveFolder = saveFolder;

// ============================================================
//  CHAT OPEN / CLOSE
// ============================================================
async function openChat(id) {
  const c = chats.find(x => x.id === id);
  if (!c) return;
  currentChatId = id; currentChatMeta = c; firstUnreadId = null;
  const u = c.isGroup ? null : c.otherUser;
  const av = $('chAvatar');
  av.innerHTML = c.isGroup ? (c.avatarFileId ? `<img src="${getAvatarUrl(c.avatarFileId)}" alt="">` : '<span style="color:#fff">#</span>') : avatarInner(u);
  av.className = 'ch-avatar' + (!c.isGroup && (u?.online || onlineStatus[c.otherLogin]) ? ' online' : '');
  $('chName').textContent = c.alias || (c.isGroup ? c.name : (u?.nickname || c.otherLogin || '?'));
  $('chSub').textContent = c.isGroup ? `${c.membersCount} участ.${c.isChannel ? ' · канал' : ''} · @${c.login || ''}` : '@' + c.otherLogin;
  $('chSub').className = 'ch-sub';
  $('chatScreen').classList.add('open');
  sendWS({ type:'activeChat', payload:{ chatId: id } });
  const d = drafts[id];
  $('msgInput').value = d?.text || '';
  replyToMsg = d?.replyTo || null;
  $('msgInput').placeholder = replyToMsg ? '↪ ответ...' : 'Сообщение...';
  $('messagesArea').innerHTML = '<div class="empty">Загрузка...</div>';
  try {
    const fresh = await api('/api/chats/' + id + '/messages');
    const firstUnread = fresh.find(m => m.sender !== currentUser.login && !(m.readBy||[]).includes(currentUser.login));
    firstUnreadId = firstUnread ? firstUnread.id : null;
    messages[id] = fresh;
    renderMessages();
    loadChats();
    try { const t = await api('/api/chats/' + id + '/theme'); applyChatTheme(t?.theme); } catch { applyChatTheme(null); }
  } catch (e) { $('messagesArea').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.openChat = openChat;

function closeChat() {
  $('chatScreen').classList.remove('open');
  if (currentChatId) setDraft(currentChatId, $('msgInput').value, replyToMsg);
  currentChatId = null; currentChatMeta = null;
  $('emojiPanel').classList.remove('active');
  sendWS({ type:'activeChat', payload:{ chatId: null } });
  applyChatTheme(null);
}
window.closeChat = closeChat;

function setDraft(id, t, r) {
  if (t && t.trim()) drafts[id] = { text: t, replyTo: r || null };
  else delete drafts[id];
  localStorage.setItem('krista_drafts', JSON.stringify(drafts));
}

function applyChatTheme(theme) {
  const el = $('chatScreen');
  el.classList.remove('themed');
  if (!theme && !ui.chatWallpaper) return;
  el.classList.add('themed');
}

function updateChatHeader(c) {
  if (!c) return;
  const isG = c.isGroup, u = c.otherUser;
  $('chName').textContent = c.alias || (isG ? c.name : (u?.nickname || c.otherLogin || '?'));
  $('chSub').textContent = isG ? `${c.membersCount} участ.${c.isChannel ? ' · канал' : ''} · @${c.login || ''}` : '@' + c.otherLogin;
  const av = $('chAvatar');
  av.innerHTML = isG ? (c.avatarFileId ? `<img src="${getAvatarUrl(c.avatarFileId)}" alt="">` : '<span style="color:#fff">#</span>') : avatarInner(u);
  av.className = 'ch-avatar' + (!isG && (u?.online || onlineStatus[c.otherLogin]) ? ' online' : '');
}

// ============================================================
//  MESSAGES
// ============================================================
function renderMessages() {
  const arr = messages[currentChatId] || [];
  const area = $('messagesArea');
  if (!arr.length) {
    const meta = currentChatMeta;
    area.innerHTML = `<div class="empty">${meta?.isGroup ? 'Тут пока пусто. Напиши первое сообщение!' : 'Начни общение!'}</div>`;
    updateScrollDownBtn();
    return;
  }
  const wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  const prevHeight = area.scrollHeight, prevScrollTop = area.scrollTop;
  let html = '', lastDate = null, unreadInserted = false;
  for (const m of arr) {
    if (m.deleted) continue;
    if (!unreadInserted && firstUnreadId && m.id === firstUnreadId && m.sender !== currentUser.login) {
      html += `<div class="unread-sep">НЕПРОЧИТАННЫЕ</div>`;
      unreadInserted = true;
    }
    const d = fDate(m.timestamp);
    if (d !== lastDate) { html += `<div class="date-sep-wrap"><span class="date-sep">${esc(d.toUpperCase())}</span></div>`; lastDate = d; }
    html += renderMsg(m, arr);
  }
  area.innerHTML = html;
  if (wasAtBottom) area.scrollTop = area.scrollHeight;
  else { const diff = area.scrollHeight - prevHeight; area.scrollTop = prevScrollTop + diff; }
  bindMsgEvents(arr);
  loadVisibleFiles(arr);
  updateScrollDownBtn();
  firstUnreadId = null;
}

function renderFileContent(m) {
  const f = m.file;
  if (!f) return '';
  const fid = f.id || f._id;
  if (f.local && m.pending) return `<div class="file-loading">⏳ Загрузка...</div>`;
  if (f.kind === 'image') return `<div class="file-image" data-file-load="${m.id}" data-file-id="${fid}"><div class="file-loading">🖼 Загрузка...</div></div>`;
  if (f.kind === 'audio') return `<div class="file-audio-player" data-file-load="${m.id}" data-file-id="${fid}"><div class="file-audio-head"><div class="file-icon">🎵</div><div class="file-info"><div class="file-name">${esc(f.name)}</div><div class="file-size">${fmtSize(f.size)}</div></div></div><div class="file-loading">Загрузка...</div></div>`;
  if (f.kind === 'video') return `<div class="file-audio-player" data-file-load="${m.id}" data-file-id="${fid}"><div class="file-audio-head"><div class="file-icon">🎬</div><div class="file-info"><div class="file-name">${esc(f.name)}</div><div class="file-size">${fmtSize(f.size)}</div></div></div><div class="file-loading">Загрузка...</div></div>`;
  return `<div class="file-doc" data-file-load="${m.id}" data-file-id="${fid}"><div class="file-icon">📎</div><div class="file-info"><div class="file-name">${esc(f.name)}</div><div class="file-size">${fmtSize(f.size)}</div></div></div>`;
}

function renderMsg(m, arr) {
  const isOut = m.sender === currentUser.login;
  let replyHtml = '';
  if (m.replyTo) {
    const p = arr.find(x => x.id === m.replyTo);
    if (p && !p.deleted) {
      const short = p.type === 'file' && p.file ? '📎 ' + (p.file.name || '') : ((p.text || '').replace(/\[[a-z0-9_]+\]/g, '🙂').slice(0, 22));
      replyHtml = `<div class="rq" data-jump="${p.id}">↪ ${esc(p.senderName)}: ${esc(short)}</div>`;
    } else replyHtml = `<div class="rq">↪ [—]</div>`;
  }
  const fwdHtml = m.forwardFrom ? `<div class="fwd">↪ Переслано от ${esc(m.forwardFrom.name)}</div>` : '';
  const reminderHtml = m.reminder ? `<div class="reminder-mark">⏰ ${esc(fDateTime(m.reminder))}</div>` : '';
  let body = '';
  if (m.type === 'file' && m.file) body += renderFileContent(m);
  let state = '';
  if (m.pending) state = '<span class="stt">⏳</span>';
  else if (m.failed) state = `<span class="stt" data-retry="${m.clientId}">↻</span>`;
  if (m.text && m.text.trim()) {
    const t = renderKolobki(m.text);
    body += `<div class="txt">${t}${state}</div>`;
  } else if (state && !m.file) body += `<div class="txt">${state}</div>`;
  let rxHtml = '';
  const rxs = m.reactions || [];
  if (rxs.length) {
    rxHtml = '<div class="rxs">' + rxs.map(r => {
      const mine = r.logins.includes(currentUser.login);
      const uri = hasKolobok(r.emoji) ? kolobokUrl(r.emoji) : '';
      const img = uri ? `<img src="${uri}" class="kolobok-sm">` : r.emoji;
      return `<span class="rx ${mine?'mine':''}" data-react="${esc(r.emoji)}" data-msg="${m.id}">${img} ${r.logins.length}</span>`;
    }).join('') + '</div>';
  }
  let chk = '';
  if (isOut && currentChatMeta && !currentChatMeta.isGroup) {
    const read = (m.readBy || []).includes(currentChatMeta.otherLogin);
    chk = `<span class="chk ${read?'read':''}">${read?'✓✓':'✓'}</span>`;
  }
  const msgId = m.id || m.clientId;
  const avInner = isOut ? avatarInner(currentUser) : avatarInner({ login: m.sender, nickname: m.senderName, avatarFileId: m.senderAvatarFileId });
  const senderEmj = !isOut && m.senderEmoji ? `<span class="chat-emoji">${esc(m.senderEmoji)}</span>` : '';
  return `<div class="msg ${isOut?'out':''} ${m.pending?'pending':''} ${m.failed?'failed':''}" data-id="${msgId}" data-client="${m.clientId||''}" data-sender="${m.sender}">
    <div class="mav" data-user="${m.sender}">${avInner}</div>
    <div class="bub">
      ${!isOut && currentChatMeta?.isGroup ? `<div class="hd"><span class="nm" data-user="${m.sender}">${senderEmj}${esc(m.senderName)}</span><span>${fTime(m.timestamp)}</span>${chk}</div>` : `<div class="hd"><span style="margin-left:auto">${fTime(m.timestamp)}${chk}</span></div>`}
      ${fwdHtml}${reminderHtml}${replyHtml}${body}${rxHtml}
    </div>
  </div>`;
}

function bindMsgEvents(arr) {
  $('messagesArea').querySelectorAll('.rq[data-jump]').forEach(el => el.addEventListener('click', e => {
    e.stopPropagation();
    const t = $('messagesArea').querySelector(`.msg[data-id="${el.dataset.jump}"]`);
    if (t) { t.scrollIntoView({ behavior:'smooth', block:'center' }); t.querySelector('.bub')?.style.setProperty('box-shadow','0 0 0 3px var(--accent)'); setTimeout(()=>t.querySelector('.bub')?.style.removeProperty('box-shadow'),1800); }
  }));
  $('messagesArea').querySelectorAll('.link').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); window.open(el.dataset.url,'_blank','noopener'); }));
  $('messagesArea').querySelectorAll('.mention').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); openInfoUser(el.dataset.user); }));
  $('messagesArea').querySelectorAll('.hashtag').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); const tag = el.textContent.replace(/^#/,''); if (tag) { switchView('search'); $('globalSearchInput').value = tag; doGlobalSearch(tag); } }));
  $('messagesArea').querySelectorAll('[data-retry]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); retryMsg(el.dataset.retry); }));
  $('messagesArea').querySelectorAll('.rx').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); toggleReaction(el.dataset.msg, el.dataset.react); }));
  $('messagesArea').querySelectorAll('[data-user]').forEach(el => {
    if (el.classList.contains('msg')) return;
    el.addEventListener('click', e => { e.stopPropagation(); const l = el.dataset.user; if (l && l !== currentUser.login) openInfoUser(l); });
  });
  $('messagesArea').querySelectorAll('.msg').forEach(el => {
    let t = null, moved = false, startX = 0;
    el.addEventListener('touchstart', e => { moved = false; startX = e.touches[0].clientX; t = setTimeout(() => { if (!moved) showMsgActions(el); }, 450); }, { passive:true });
    el.addEventListener('touchmove', e => { const dx = e.touches[0].clientX - startX; if (Math.abs(dx) > 8) { moved = true; if (t) clearTimeout(t); } });
    el.addEventListener('touchend', () => { if (t) clearTimeout(t); });
    el.addEventListener('contextmenu', e => { e.preventDefault(); showMsgActions(el); });
    el.addEventListener('click', e => {
      if (e.target.closest('.link')||e.target.closest('.rq')||e.target.closest('[data-retry]')||e.target.closest('[data-user]')||e.target.closest('[data-file-load]')||e.target.closest('.rx')||e.target.closest('.hashtag')||e.target.closest('.mention')||e.target.closest('video')||e.target.closest('audio')) return;
      showMsgActions(el);
    });
  });
}

async function showMsgActions(el) {
  const msgId = el.dataset.id, sender = el.dataset.sender;
  const arr = messages[currentChatId] || [];
  const m = arr.find(x => x.id === msgId || x.clientId === msgId);
  if (!m) return;
  const isMine = sender === currentUser.login;
  const isAdmin = currentChatMeta?.isAdmin;
  const canDel = isMine || isAdmin;

  const rxRow = $('rxRow'); rxRow.innerHTML = '';
  REACTIONS.forEach(r => {
    const b = document.createElement('button');
    b.className = 'rx-btn';
    b.innerHTML = `<img src="${kolobokUrl(r)}" onerror="this.style.opacity=.3">`;
    b.onclick = e => { e.stopPropagation(); toggleReaction(m.id, r); hideMsgActions(); };
    rxRow.appendChild(b);
  });

  const actRow = $('actRow'); actRow.innerHTML = '';
  const add = (icon, label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'act-btn' + (cls ? ' ' + cls : '');
    b.innerHTML = `<span class="ai">${icon}</span><span class="al">${label}</span>`;
    b.onclick = e => { e.stopPropagation(); fn(); hideMsgActions(); };
    actRow.appendChild(b);
  };
  const hasText = m.text && m.text.trim();
  if (hasText) add('📋', 'Копировать', '', () => navigator.clipboard?.writeText(m.text).then(() => toast('Скопировано')));
  add('↩', 'Ответить', '', () => { replyToMsg = m.id; $('msgInput').placeholder = `↪ ${m.senderName}: _`; $('msgInput').focus(); });
  add('↪', 'Переслать', '', () => openForward(m.id));
  add('⭐', 'В избранное', '', () => addToFavorites(m));
  add('⏰', 'Напомнить', '', () => openReminderDialog(m));
  if (m.type === 'file' && m.file && !m.pending && !m.failed) add('⬇', 'Скачать', '', async () => { try { const e = await loadFileBlob(m.id); downloadBlob(e.url, m.file.name); } catch { toast('Ошибка'); } });
  if (canDel) add('🗑', 'Удалить', 'danger', () => { if (confirm('Удалить?')) sendWS({ type:'deleteMessage', payload:{ messageId: m.id } }); });

  const r = el.getBoundingClientRect();
  $('msgActions').classList.add('active');
  const w = $('msgActions').offsetWidth || 240, h = $('msgActions').offsetHeight || 300;
  let l = r.left + r.width/2 - w/2, t = r.top - h - 8;
  if (l < 8) l = 8; if (l + w > window.innerWidth - 8) l = window.innerWidth - w - 8;
  if (t < 8) t = r.bottom + 8;
  if (t + h > window.innerHeight - 8) t = window.innerHeight - h - 8;
  $('msgActions').style.left = l + 'px';
  $('msgActions').style.top = t + 'px';
}
function hideMsgActions() { $('msgActions').classList.remove('active'); }
document.addEventListener('click', e => { if (!$('msgActions').contains(e.target)) hideMsgActions(); });
function toggleReaction(id, emoji) { sendWS({ type:'toggleReaction', payload:{ messageId:id, emoji } }); }
window.toggleReaction = toggleReaction;

// ============================================================
//  FAVORITES / REMINDERS
// ============================================================
async function addToFavorites(m) {
  try {
    await api('/api/favorites', { method:'POST', body:JSON.stringify({ messageId: m.id, chatId: m.chatId, text: m.text || (m.file ? '📎 ' + m.file.name : ''), senderName: m.senderName, sender: m.sender, timestamp: m.timestamp }) });
    toast('⭐ Сохранено');
  } catch (e) { toast(e.message); }
}
window.addToFavorites = addToFavorites;

async function openFavorites() {
  closeModal('settingsModal');
  $('favoritesContent').innerHTML = '<div class="empty">Загрузка...</div>';
  $('favoritesModal').classList.add('open');
  try {
    const list = await api('/api/favorites');
    favoritesCache = list;
    if (!list.length) { $('favoritesContent').innerHTML = '<div class="empty">Пусто. Долгий тап по сообщению → ⭐</div>'; return; }
    $('favoritesContent').innerHTML = list.map(f => `<div class="fav-item" data-fid="${f.id}"><button class="fav-del" data-del="${f.id}">✕</button><div class="fav-from">${esc(f.senderName || f.sender)}</div><div class="fav-text">${esc(f.text)}</div><div class="fav-time">${esc(fDateTime(f.timestamp))}</div></div>`).join('');
    $('favoritesContent').querySelectorAll('.fav-del').forEach(b => b.onclick = async e => { e.stopPropagation(); try { await api('/api/favorites/' + b.dataset.del, { method:'DELETE' }); b.closest('.fav-item').remove(); toast('Удалено'); } catch {} });
    $('favoritesContent').querySelectorAll('.fav-item').forEach(el => el.onclick = async () => {
      const f = favoritesCache.find(x => x.id === el.dataset.fid);
      if (f?.chatId && chats.find(c => c.id === f.chatId)) { closeModal('favoritesModal'); setTimeout(() => openChat(f.chatId), 150); }
    });
  } catch (e) { $('favoritesContent').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.openFavorites = openFavorites;

function openReminderDialog(m) {
  activeMsgForReminder = m;
  const preview = (m.text || (m.file ? '📎 ' + m.file.name : '')).slice(0, 120);
  $('reminderMsgPreview').textContent = preview || '—';
  $('reminderCustomTime').value = '';
  $('reminderModal').classList.add('open');
}
window.openReminderDialog = openReminderDialog;
function setReminderDelay(min) { createReminder(new Date(Date.now() + min * 60000).toISOString()); }
window.setReminderDelay = setReminderDelay;
function setReminderMorning() { const now = new Date(); const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0); createReminder(t.toISOString()); }
window.setReminderMorning = setReminderMorning;
async function saveReminder() { const v = $('reminderCustomTime').value; if (!v) return toast('Укажи время'); createReminder(new Date(v).toISOString()); }
window.saveReminder = saveReminder;
async function createReminder(iso) {
  if (!activeMsgForReminder) return;
  const m = activeMsgForReminder;
  const text = m.text || (m.file ? '📎 ' + m.file.name : '(сообщение)');
  try { await api('/api/reminders', { method:'POST', body:JSON.stringify({ messageId: m.id, chatId: m.chatId, text, dueAt: iso }) }); closeModal('reminderModal'); toast('⏰ Напоминание создано'); }
  catch (e) { toast(e.message); }
}
async function openReminders() {
  closeModal('settingsModal');
  $('remindersListContent').innerHTML = '<div class="empty">Загрузка...</div>';
  $('remindersListModal').classList.add('open');
  try {
    const list = await api('/api/reminders');
    remindersCache = list;
    const active = list.filter(r => !r.done);
    if (!active.length) { $('remindersListContent').innerHTML = '<div class="empty">Нет напоминаний.<br>Долгий тап по сообщению → ⏰</div>'; return; }
    $('remindersListContent').innerHTML = active.map(r => `<div class="reminder-item"><div class="rem-icon">⏰</div><div class="rem-body"><div class="rem-text">${esc(r.text)}</div><div class="rem-time">${esc(fDateTime(r.dueAt))}</div></div><button class="rem-del" data-rid="${r.id}">✕</button></div>`).join('');
    $('remindersListContent').querySelectorAll('.rem-del').forEach(b => b.onclick = async () => { try { await api('/api/reminders/' + b.dataset.rid, { method:'DELETE' }); openReminders(); } catch {} });
  } catch (e) { $('remindersListContent').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.openReminders = openReminders;

// ============================================================
//  FORWARD
// ============================================================
let forwardMsgId = null;
function openForward(msgId) { forwardMsgId = msgId; $('forwardSearchInput').value = ''; renderForwardList(''); $('forwardModal').classList.add('open'); setTimeout(() => $('forwardSearchInput').focus(), 200); }
window.openForward = openForward;
$('forwardSearchInput')?.addEventListener('input', () => renderForwardList($('forwardSearchInput').value.trim().toLowerCase()));

function renderForwardList(q) {
  const list = chats.filter(c => !c.archived).filter(c => {
    if (!q) return true;
    const name = c.alias || (c.isGroup ? c.name : (c.otherUser?.nickname || c.otherLogin || ''));
    return name.toLowerCase().includes(q) || (c.otherLogin||'').toLowerCase().includes(q);
  });
  if (!list.length) { $('forwardChatsList').innerHTML = `<div class="empty">Ничего не найдено</div>`; return; }
  $('forwardChatsList').innerHTML = list.map(c => {
    const av = c.isGroup ? (c.avatarFileId ? `<img src="${getAvatarUrl(c.avatarFileId)}">` : '#') : avatarInner(c.otherUser);
    const name = c.alias || (c.isGroup ? c.name : (c.otherUser?.nickname || c.otherLogin || ''));
    return `<div class="member-row" data-id="${c.id}"><div class="mav2">${av}</div><div class="mtxt"><div class="mname">${esc(name)}</div></div></div>`;
  }).join('');
  $('forwardChatsList').querySelectorAll('.member-row').forEach(el => el.onclick = () => doForward(el.dataset.id));
}

async function doForward(targetChatId) {
  if (!forwardMsgId || !currentChatId) return;
  const arr = messages[currentChatId] || [];
  const m = arr.find(x => x.id === forwardMsgId);
  if (!m) { toast('Сообщение не найдено'); return; }
  const fwd = { login: m.sender, name: m.senderName, messageId: m.id };
  const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
  const payload = { chatId: targetChatId, text: m.text || '', clientId, forwardFrom: fwd };
  if (m.file && (m.file.id || m.file._id)) payload.fileId = m.file.id || m.file._id;
  const opt = { id:null, clientId, chatId: targetChatId, sender: currentUser.login, senderName: currentUser.nickname, type: m.file ? 'file' : 'text', text: m.text || '', file: m.file || null, timestamp: new Date().toISOString(), forwardFrom: fwd, pending:true };
  if (!messages[targetChatId]) messages[targetChatId] = [];
  messages[targetChatId].push(opt);
  if (!sendWS({ type:'newMessage', payload })) sendQueue.push(payload);
  closeModal('forwardModal');
  toast('Переслано');
  if (targetChatId === currentChatId) renderMessages();
}

// ============================================================
//  FILES
// ============================================================
async function loadFileBlob(messageId) {
  if (fileBlobCache.has(messageId)) return fileBlobCache.get(messageId);
  const res = await fetch('/api/file/' + messageId, { headers: token ? { Authorization:'Bearer '+token } : {} });
  if (!res.ok) throw new Error('Не удалось');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const entry = { url, blob };
  fileBlobCache.set(messageId, entry);
  return entry;
}
function downloadBlob(url, name) { const a = document.createElement('a'); a.href = url; a.download = name || 'file'; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
function openImageViewer(url) { $('imgViewerImg').src = url; $('imgViewerModal').classList.add('open'); }
window.openImageViewer = openImageViewer;

async function fetchWithTimeout(url, ms = 35000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(t); return r; } catch (e) { clearTimeout(t); throw e; }
}

async function loadVisibleFiles(arr) {
  const cs = $('messagesArea').querySelectorAll('[data-file-load]');
  for (const el of cs) {
    const id = el.dataset.fileId;
    const m = arr.find(x => x.id === id || (x.file && (x.file.id === id || x.file._id === id)));
    if (!m || !m.file || m.pending || m.failed) continue;
    const fileId = m.file.id || m.file._id;
    if (!fileId) continue;
    try {
      const url = getAvatarUrl(fileId);
      const res = await fetchWithTimeout(url, 35000);
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || ('HTTP ' + res.status)); }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      if (!document.body.contains(el)) continue;
      const f = m.file;
      if (f.kind === 'image') { el.innerHTML = `<img class="file-img" src="${objUrl}">`; el.querySelector('img').onclick = e => { e.stopPropagation(); openImageViewer(objUrl); }; }
      else if (f.kind === 'audio') { el.innerHTML = `<div class="file-audio-head"><div class="file-icon">🎵</div><div class="file-info"><div class="file-name">${esc(f.name)}</div><div class="file-size">${fmtSize(f.size)}</div></div></div><audio controls preload="metadata" src="${objUrl}"></audio>`; el.querySelectorAll('audio').forEach(a => a.addEventListener('click', ev => ev.stopPropagation())); }
      else if (f.kind === 'video') { el.innerHTML = `<div class="file-audio-head"><div class="file-icon">🎬</div><div class="file-info"><div class="file-name">${esc(f.name)}</div><div class="file-size">${fmtSize(f.size)}</div></div></div><video controls preload="metadata" src="${objUrl}" playsinline></video>`; el.querySelectorAll('video').forEach(v => v.addEventListener('click', ev => ev.stopPropagation())); }
      else { el.onclick = e => { e.stopPropagation(); downloadBlob(objUrl, f.name); }; }
    } catch (e) {
      if (document.body.contains(el)) { const msg = e.message && e.message !== 'Failed to fetch' ? e.message : 'Файл недоступен'; el.innerHTML = `<div class="file-error">⚠️ ${esc(msg)}</div>`; }
    }
  }
}

$('fileInput')?.addEventListener('change', e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !currentChatId) return;
  uploadFile(file);
});

function uploadFile(file) {
  if (!currentChatId) return;
  if (file.size > MAX_FILE_SIZE) return toast('Отправлять файл не более 20 мб');
  const chatId = currentChatId;
  const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'doc';
  const opt = { id: clientId, clientId, chatId, sender: currentUser.login, senderName: currentUser.nickname, type:'file', text:'', file: { name: file.name, size: file.size, mime: file.type, kind, local:true }, timestamp: new Date().toISOString(), replyTo: replyToMsg || null, pending:true };
  if (!messages[chatId]) messages[chatId] = [];
  messages[chatId].push(opt);
  renderMessages();
  const captureReply = replyToMsg;
  const form = new FormData();
  form.append('file', file); form.append('chatId', chatId); form.append('clientId', clientId);
  if (captureReply) form.append('replyTo', captureReply);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const msg = JSON.parse(xhr.responseText);
        const arr = messages[chatId] || [];
        const i = arr.findIndex(m => m.clientId === clientId);
        if (i !== -1) arr[i] = msg;
        if (currentChatId === chatId) renderMessages();
        loadChats();
      } catch {}
    } else {
      opt.pending = false; opt.failed = true;
      if (currentChatId === chatId) renderMessages();
      let err = 'Ошибка'; try { err = JSON.parse(xhr.responseText).error || err; } catch {}
      toast(err);
    }
  };
  xhr.onerror = () => { opt.pending = false; opt.failed = true; if (currentChatId === chatId) renderMessages(); toast('Ошибка сети'); };
  xhr.send(form);
  replyToMsg = null;
  $('msgInput').placeholder = 'Сообщение...';
}

// ============================================================
//  SEND
// ============================================================
$('msgInput')?.addEventListener('input', () => {
  const val = $('msgInput').value;
  if (currentChatId) {
    setDraft(currentChatId, val, replyToMsg);
    const now = Date.now();
    if (now - (window._lastTyping || 0) > 800) {
      window._lastTyping = now;
      sendWS({ type:'typing', payload:{ chatId: currentChatId, text: val.slice(-40) } });
    }
  }
});
$('msgInput')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

function sendMsg() {
  const raw = $('msgInput').value.trim();
  if (!raw || !currentChatId) return;
  const text = autoReplaceSmiles(raw);
  const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
  const opt = { id:null, clientId, chatId: currentChatId, sender: currentUser.login, senderName: currentUser.nickname, senderEmoji: currentUser.nicknameEmoji || '', senderAvatarFileId: currentUser.avatarFileId || null, type:'text', text, timestamp: new Date().toISOString(), replyTo: replyToMsg || null, pending:true };
  if (!messages[currentChatId]) messages[currentChatId] = [];
  messages[currentChatId].push(opt);
  renderMessages();
  const payload = { chatId: currentChatId, text, clientId };
  if (replyToMsg) payload.replyTo = replyToMsg;
  $('msgInput').value = '';
  setDraft(currentChatId, '', null);
  replyToMsg = null;
  $('msgInput').placeholder = 'Сообщение...';
  if (!sendWS({ type:'newMessage', payload })) sendQueue.push(payload);
  setTimeout(() => { if (opt.pending) { opt.pending = false; opt.failed = !navigator.onLine; if (currentChatId === opt.chatId) renderMessages(); } }, 8000);
}
window.sendMsg = sendMsg;

function retryMsg(clientId) {
  const arr = messages[currentChatId];
  if (!arr) return;
  const m = arr.find(x => x.clientId === clientId);
  if (!m) return;
  m.failed = false; m.pending = true;
  const p = { chatId: currentChatId, text: m.text, clientId };
  if (m.replyTo) p.replyTo = m.replyTo;
  if (!sendWS({ type:'newMessage', payload: p })) sendQueue.push(p);
  renderMessages();
}

function updateScrollDownBtn() {
  const area = $('messagesArea'), btn = $('scrollDownBtn');
  if (!area || !btn) return;
  const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
  if (dist > 200) btn.classList.add('show'); else btn.classList.remove('show');
}
$('messagesArea')?.addEventListener('scroll', updateScrollDownBtn);
$('scrollDownBtn')?.addEventListener('click', () => { const a = $('messagesArea'); a.scrollTo({ top: a.scrollHeight, behavior:'smooth' }); });

// ============================================================
//  EMOJI PANEL
// ============================================================
function toggleEmoji() {
  const panel = $('emojiPanel');
  panel.classList.toggle('active');
  $('emojiToggleBtn').classList.toggle('active', panel.classList.contains('active'));
  if (panel.classList.contains('active')) renderEmojiGrid();
}
window.toggleEmoji = toggleEmoji;

$$('.emoji-tab').forEach(tab => tab.onclick = () => {
  $$('.emoji-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  emojiPack = tab.dataset.pack;
  renderEmojiGrid();
});

function renderEmojiGrid() {
  const grid = $('emojiGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (emojiPack === 'kolobok') {
    KOLOBKI_LIST.forEach(k => {
      if (!hasKolobok(k)) return;
      const btn = document.createElement('button');
      btn.innerHTML = `<img src="${kolobokUrl(k)}" alt="${k}" loading="lazy" onerror="this.style.opacity=.3">`;
      btn.onclick = () => insertToken(`[${k}]`);
      grid.appendChild(btn);
    });
  } else {
    EMOJI_LIST.forEach(e => {
      const btn = document.createElement('button');
      btn.innerHTML = `<span class="emoji-char">${e}</span>`;
      btn.onclick = () => insertToken(e);
      grid.appendChild(btn);
    });
  }
}

function insertToken(t) {
  const inp = $('msgInput');
  const start = inp.selectionStart ?? inp.value.length;
  const end = inp.selectionEnd ?? start;
  inp.value = inp.value.slice(0, start) + t + inp.value.slice(end);
  inp.setSelectionRange(start + t.length, start + t.length);
  inp.focus();
  if (currentChatId) setDraft(currentChatId, inp.value, replyToMsg);
}

// ============================================================
//  INFO USER / CHAT
// ============================================================
async function openInfoUser(login) {
  if (!login || login === currentUser.login) return;
  try {
    const u = await api('/api/users/' + encodeURIComponent(login));
    $('infoUserContent').innerHTML = `<div class="pp2"><div class="pa">${avatarInner(u)}</div><div class="pn">${u.nicknameEmoji ? u.nicknameEmoji + ' ' : ''}${esc(u.nickname)}</div><div class="pl">@${esc(u.login)}</div></div><div style="text-align:center;font-size:13px;color:var(--text-3);margin-bottom:14px;font-style:italic">${u.online ? '● онлайн' : '○ ' + (timeAgo(u.lastSeen) || 'офлайн')}</div><button class="list-btn primary" onclick="writeToUser('${esc(u.login)}')"><span class="ico">✉</span><span class="lbl">Написать</span></button>`;
    $('infoUserModal').classList.add('open');
  } catch (e) { toast(e.message); }
}
window.openInfoUser = openInfoUser;

async function writeToUser(login) {
  try {
    const d = await api('/api/chats', { method:'POST', body:JSON.stringify({ login }) });
    closeModal('infoUserModal');
    await loadChats();
    if (d.chatId) setTimeout(() => openChat(d.chatId), 150);
  } catch (e) { toast(e.message); }
}
window.writeToUser = writeToUser;

async function openInfoChat() {
  if (!currentChatMeta) return;
  if (currentChatMeta.isGroup) {
    try {
      const info = await api('/api/chats/' + currentChatMeta.id + '/info');
      const admins = info.membersInfo.filter(m => m.isAdmin || m.isOwner);
      const others = info.membersInfo.filter(m => !m.isAdmin && !m.isOwner);
      let html = `<div class="pp2"><div class="pa">${info.avatarFileId ? `<img src="${getAvatarUrl(info.avatarFileId)}">` : '#'}</div><div class="pn">${esc(currentChatMeta.alias || info.name)}</div>${info.login ? `<div class="pl">@${esc(info.login)}</div>` : ''}</div>`;
      html += `<div style="text-align:center;font-size:12px;color:var(--text-3);margin-bottom:14px;font-style:italic">${info.members.length} участников</div>`;
      if (info.isAdmin) html += `<button class="list-btn" onclick="closeModal('infoChatModal');openGroupSettings()"><span class="ico">⚙</span><span class="lbl">Настройки группы</span></button>`;
      if (admins.length) html += `<div class="info-section-title">Админы</div>` + admins.map(renderMemberRow).join('');
      if (others.length) html += `<div class="info-section-title">Участники</div>` + others.map(renderMemberRow).join('');
      $('infoChatContent').innerHTML = html;
      $('infoChatTitle').textContent = info.isChannel ? 'О канале' : 'О группе';
      $('infoChatModal').classList.add('open');
    } catch (e) { toast(e.message); }
  } else if (currentChatMeta.otherLogin) { openInfoUser(currentChatMeta.otherLogin); }
}
window.openInfoChat = openInfoChat;

function renderMemberRow(m) {
  const tag = m.isOwner ? '<span class="mtag">OWNER</span>' : m.isAdmin ? '<span class="mtag">ADMIN</span>' : '';
  return `<div class="member-row" onclick="openInfoUser('${esc(m.login)}')"><div class="mav2">${avatarInner(m)}</div><div class="mtxt"><div class="mname">${esc(m.nickname)} ${tag}</div><div class="mlogin">@${esc(m.login)}</div></div></div>`;
}

// ============================================================
//  GROUP SETTINGS
// ============================================================
let gsChatId = null;
async function openGroupSettings() {
  if (!currentChatMeta) return;
  gsChatId = currentChatMeta.id;
  try {
    const info = await api('/api/chats/' + gsChatId + '/info');
    $('gsErr').textContent = '';
    $('gsNameInput').value = info.name || '';
    $('gsLoginInput').value = info.login || '';
    $('gsAddInput').value = '';
    $('gsFlagPrivate').checked = !!info.isPrivate;
    $('gsFlagPublish').checked = !!info.published;
    const canEdit = info.isAdmin, isOwner = info.isOwner;
    $('gsRowName').style.display = canEdit ? 'flex' : 'none';
    $('gsRowLogin').style.display = canEdit ? 'flex' : 'none';
    $('gsRowPublish').style.display = isOwner ? 'flex' : 'none';
    $('gsRowPrivate').style.display = isOwner ? 'flex' : 'none';
    $('gsDeleteBtn').style.display = isOwner ? 'flex' : 'none';
    $('gsLeaveBtn').style.display = (!isOwner && info.members.includes(currentUser.login)) ? 'flex' : 'none';
    $('gsClearBtn').style.display = canEdit ? 'flex' : 'none';
    $('gsMembersList').innerHTML = info.membersInfo.map(m => {
      const showKick = canEdit && !m.isOwner && m.login !== currentUser.login;
      const showAdmToggle = canEdit && !m.isOwner;
      const admBtn = showAdmToggle ? `<button class="admtoggle ${m.isAdmin?'on':''}" data-admin="${esc(m.login)}">${m.isAdmin?'АДМИН':'+ АДМ'}</button>` : '';
      return `<div class="member-row"><div class="mav2">${avatarInner(m)}</div><div class="mtxt"><div class="mname">${esc(m.nickname)} ${m.isOwner?'<span class="mtag">OWNER</span>':m.isAdmin?'<span class="mtag">ADMIN</span>':''}</div><div class="mlogin">@${esc(m.login)}</div></div><div style="display:flex;gap:4px;flex-shrink:0">${admBtn}${showKick?`<button class="kick" data-login="${esc(m.login)}">✕</button>`:''}</div></div>`;
    }).join('');
    $('gsMembersList').querySelectorAll('.kick').forEach(b => b.onclick = async () => { if (!confirm('Удалить?')) return; try { await api('/api/chats/' + gsChatId + '/members/' + encodeURIComponent(b.dataset.login), { method:'DELETE' }); openGroupSettings(); loadChats(); } catch (e) { $('gsErr').textContent = e.message; } });
    $('gsMembersList').querySelectorAll('[data-admin]').forEach(b => b.onclick = async () => { try { await api('/api/chats/' + gsChatId + '/members/' + encodeURIComponent(b.dataset.admin) + '/admin', { method:'PUT' }); openGroupSettings(); } catch (e) { $('gsErr').textContent = e.message; } });
    const saveFlags = async () => { try { await api('/api/chats/' + gsChatId + '/flags', { method:'PUT', body:JSON.stringify({ isPrivate: $('gsFlagPrivate').checked, published: $('gsFlagPublish').checked }) }); loadChats(); } catch (e) { $('gsErr').textContent = e.message; } };
    $('gsFlagPrivate').onchange = $('gsFlagPublish').onchange = saveFlags;
    $('groupSettingsModal').classList.add('open');
  } catch (e) { toast(e.message); }
}
window.openGroupSettings = openGroupSettings;
async function renameGroup() { const n = $('gsNameInput').value.trim(); if (!n) return; try { await api('/api/chats/' + gsChatId + '/name', { method:'PUT', body:JSON.stringify({ name: n }) }); loadChats(); } catch (e) { $('gsErr').textContent = e.message; } }
window.renameGroup = renameGroup;
async function changeGroupLogin() { const l = $('gsLoginInput').value.trim(); if (!l) return; try { await api('/api/chats/' + gsChatId + '/login', { method:'PUT', body:JSON.stringify({ login: l }) }); loadChats(); } catch (e) { $('gsErr').textContent = e.message; } }
window.changeGroupLogin = changeGroupLogin;
async function addMemberToGroup() { const login = $('gsAddInput').value.trim().replace(/^@/,''); if (!login) return; try { await api('/api/chats/' + gsChatId + '/members', { method:'POST', body:JSON.stringify({ login }) }); $('gsAddInput').value = ''; openGroupSettings(); loadChats(); } catch (e) { $('gsErr').textContent = e.message; } }
window.addMemberToGroup = addMemberToGroup;
async function leaveGroup() { if (!confirm('Покинуть?')) return; try { await api('/api/chats/' + gsChatId + '/leave', { method:'POST' }); closeModal('groupSettingsModal'); if (currentChatId === gsChatId) closeChat(); loadChats(); } catch (e) { $('gsErr').textContent = e.message; } }
window.leaveGroup = leaveGroup;
async function clearChat() { if (!gsChatId) return; if (!confirm('Очистить всю переписку у всех?')) return; try { await api('/api/chats/' + gsChatId + '/messages', { method:'DELETE' }); toast('Очищено'); messages[gsChatId] = []; if (currentChatId === gsChatId) renderMessages(); loadChats(); closeModal('groupSettingsModal'); } catch (e) { $('gsErr').textContent = e.message; } }
window.clearChat = clearChat;
async function deleteGroup() { if (!confirm('Удалить?')) return; if (!sendWS({ type:'deleteChat', payload:{ chatId: gsChatId } })) { try { await api('/api/chats/' + gsChatId, { method:'DELETE' }); } catch (e) { return $('gsErr').textContent = e.message; } } closeModal('groupSettingsModal'); if (currentChatId === gsChatId) closeChat(); loadChats(); }
window.deleteGroup = deleteGroup;
async function deleteChatConfirm(id) { if (!confirm('Удалить чат?')) return; if (!sendWS({ type:'deleteChat', payload:{ chatId: id } })) { try { await api('/api/chats/' + id, { method:'DELETE' }); } catch (e) { return toast(e.message); } } if (currentChatId === id) closeChat(); loadChats(); }
window.deleteChatConfirm = deleteChatConfirm;

// ============================================================
//  CREATE GROUP / CHANNEL
// ============================================================
let groupDraft = [], groupKind = 'group';
function openGroupCreate() { closeModal('createModal'); groupKind = 'group'; openGroupModal('Новая группа'); }
function openChannelCreate() { closeModal('createModal'); groupKind = 'channel'; openGroupModal('Новый канал'); }
function openGroupModal(title) { $('groupModalTitle').textContent = title; $('groupNameInput').value = ''; $('groupLoginInput').value = ''; $('groupMemberInput').value = ''; $('groupErr').textContent = ''; $('groupPublish').checked = false; groupDraft = []; renderGroupDraft(); $('groupModal').classList.add('open'); }
window.openGroupCreate = openGroupCreate; window.openChannelCreate = openChannelCreate;
function renderGroupDraft() { const el = $('groupMembersList'); if (!groupDraft.length) { el.innerHTML = ''; return; } el.innerHTML = groupDraft.map((m, i) => `<div class="member-row"><div class="mav2">${esc((m.nickname||'?')[0])}</div><div class="mtxt"><div class="mname">${esc(m.nickname)}</div><div class="mlogin">@${esc(m.login)}</div></div><button class="kick" data-i="${i}">✕</button></div>`).join(''); el.querySelectorAll('.kick').forEach(b => b.onclick = () => { groupDraft.splice(+b.dataset.i, 1); renderGroupDraft(); }); }
async function addGroupMember() { const login = $('groupMemberInput').value.trim().replace(/^@/,''); const err = $('groupErr'); err.textContent = ''; if (!login) return err.textContent = 'Введите логин'; if (login.toLowerCase() === currentUser.login.toLowerCase()) return err.textContent = 'Это вы'; if (groupDraft.find(m => m.login.toLowerCase() === login.toLowerCase())) return err.textContent = 'Уже добавлен'; try { const r = await api('/api/search?q=' + encodeURIComponent(login)); const u = r.users.find(x => x.login.toLowerCase() === login.toLowerCase()); if (!u) return err.textContent = 'Не найден'; groupDraft.push({ login: u.login, nickname: u.nickname || u.login }); $('groupMemberInput').value = ''; renderGroupDraft(); } catch (e) { err.textContent = e.message; } }
window.addGroupMember = addGroupMember;
async function createGroup() { const name = $('groupNameInput').value.trim(); const login = $('groupLoginInput').value.trim(); const published = $('groupPublish').checked; const err = $('groupErr'); err.textContent = ''; if (!name) return err.textContent = 'Введите название'; if (!login) return err.textContent = 'Введите логин'; try { const d = await api('/api/groups', { method:'POST', body:JSON.stringify({ name, login, members: groupDraft.map(m => m.login), isPrivate: false, published, isChannel: groupKind === 'channel' }) }); closeModal('groupModal'); await loadChats(); if (d.chatId) setTimeout(() => openChat(d.chatId), 100); } catch (e) { err.textContent = e.message; } }
window.createGroup = createGroup;

// ============================================================
//  VIEWS
// ============================================================
function switchView(v) {
  currentView = v;
  $$('.view').forEach(x => x.classList.remove('active'));
  const el = $('view' + v.charAt(0).toUpperCase() + v.slice(1));
  if (el) el.classList.add('active');
  $$('.sb-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'catalog') loadCatalog();
  else if (v === 'music') { if (window.initMusic) window.initMusic(); }
  else if (v === 'feed') loadFeed();
  else if (v === 'search') { $('globalSearchInput').focus(); loadSearchHistory(); }
}
window.switchView = switchView;

// ============================================================
//  FEED
// ============================================================
async function loadFeed() {
  const el = $('feedArea');
  el.innerHTML = '<div class="empty">Загрузка...</div>';
  try {
    const list = await api('/api/feed');
    if (!list.length) { el.innerHTML = '<div class="empty">Пусто.<br>Подпишись на каналы — тут появятся их посты.</div>'; return; }
    el.innerHTML = list.map(m => {
      let text = (m.text || '');
      text = renderKolobki(text);
      let fileHtml = '';
      if (m.file) {
        const fileUrl = `/api/file/${m.file.id || m.file._id}?token=${encodeURIComponent(token)}`;
        if (m.file.kind === 'image') fileHtml = `<div class="feed-file"><img src="${fileUrl}" onclick="event.stopPropagation();openImageViewer('${fileUrl}')"></div>`;
        else if (m.file.kind === 'audio') fileHtml = `<div class="feed-file"><audio controls src="${fileUrl}"></audio></div>`;
        else if (m.file.kind === 'video') fileHtml = `<div class="feed-file"><video controls src="${fileUrl}"></video></div>`;
        else fileHtml = `<div class="feed-file"><a href="${fileUrl}" target="_blank" style="color:var(--accent)">📎 ${esc(m.file.name)}</a></div>`;
      }
      const fwd = m.forwardFrom ? `<div class="feed-fwd">↪ Переслано от ${esc(m.forwardFrom.name)}</div>` : '';
      const av = m.channel?.avatarFileId ? `<img src="${getAvatarUrl(m.channel.avatarFileId)}">` : (m.channel?.name?.[0] || '#').toUpperCase();
      return `<div class="feed-item" data-cid="${m.chatId}">
        <div class="feed-head">
          <div class="feed-av">${av}</div>
          <div class="feed-ch">
            <div class="feed-ch-name">${esc(m.channel?.name || 'Канал')}</div>
            <div class="feed-ch-time">${esc(fDateTime(m.timestamp))}</div>
          </div>
        </div>
        ${fwd}
        <div class="feed-text">${text}</div>
        ${fileHtml}
      </div>`;
    }).join('');
    el.querySelectorAll('.feed-item').forEach(item => item.onclick = e => {
      if (e.target.closest('audio') || e.target.closest('video') || e.target.closest('a') || e.target.closest('img')) return;
      openChat(item.dataset.cid);
    });
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.loadFeed = loadFeed;

// ============================================================
//  CATALOG
// ============================================================
async function loadCatalog() {
  const el = $('catalogArea');
  el.innerHTML = '<div class="empty">Загрузка...</div>';
  try {
    const list = await api('/api/catalog');
    if (!list.length) { el.innerHTML = '<div class="empty">Пусто. Опубликуй свой чат!</div>'; return; }
    el.innerHTML = list.map(c => `<div class="catalog-item" data-id="${c.id}" data-login="${esc(c.login||'')}"><div class="catalog-rank">${c.rank}</div><div class="catalog-av">${c.avatarFileId ? `<img src="${getAvatarUrl(c.avatarFileId)}">` : (c.isChannel ? '📢' : '#')}</div><div class="catalog-info"><div class="catalog-name">${esc(c.name)}</div><div class="catalog-meta">@${esc(c.login||'')} · ${c.membersCount} участ.${c.isMember ? ' · ✓' : ''}</div></div></div>`).join('');
    el.querySelectorAll('.catalog-item').forEach(m => m.onclick = () => joinAndOpen(m.dataset.id, m.dataset.login));
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.loadCatalog = loadCatalog;
async function joinAndOpen(id, login) {
  const found = chats.find(c => c.id === id);
  if (found) { switchView('chats'); openChat(id); return; }
  try { const c = await api('/api/chats/find/' + encodeURIComponent(login)); await api('/api/chats/' + c.id + '/join', { method:'POST' }); await loadChats(); switchView('chats'); setTimeout(() => openChat(c.id), 150); }
  catch (e) { toast(e.message); }
}
window.joinAndOpen = joinAndOpen;

// ============================================================
//  SEARCH + HISTORY
// ============================================================
let globalSearchTimer = null;
$('globalSearchInput')?.addEventListener('input', () => {
  clearTimeout(globalSearchTimer);
  const q = $('globalSearchInput').value.trim();
  if (!q) { loadSearchHistory(); return; }
  globalSearchTimer = setTimeout(() => doGlobalSearch(q), 300);
});

async function loadSearchHistory() {
  const el = $('globalSearchResults');
  try {
    const list = await api('/api/search-history');
    searchHistoryCache = list;
    if (!list.length) { el.innerHTML = '<div class="empty">Введи запрос...</div>'; return; }
    let html = `<div class="info-section-title" style="padding-left:14px">История</div>`;
    html += list.map((h, i) => {
      const icon = h.type === 'user' ? '👤' : h.type === 'channel' ? '📢' : '👥';
      return `<div class="history-item"><span class="history-icon">${icon}</span><div class="history-body" data-idx="${i}"><div class="history-name">${esc(h.name || h.login || h.query)}</div><div class="history-sub">${h.login ? '@' + esc(h.login) : esc(h.query)}</div></div><button class="history-del" data-idx="${i}">✕</button></div>`;
    }).join('');
    html += `<button class="list-btn danger" style="margin-top:8px" onclick="clearSearchHistory()"><span class="ico">🗑</span><span class="lbl">Очистить историю</span></button>`;
    el.innerHTML = html;
    el.querySelectorAll('.history-body').forEach(b => b.onclick = () => {
      const h = searchHistoryCache[+b.dataset.idx];
      if (!h) return;
      if (h.type === 'user') openInfoUser(h.login);
      else if (h.chatId) joinAndOpen(h.chatId, h.login);
      else if (h.login) joinAndOpen(null, h.login);
    });
    el.querySelectorAll('.history-del').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      try { await api('/api/search-history/' + b.dataset.idx, { method:'DELETE' }); loadSearchHistory(); } catch {}
    });
  } catch { el.innerHTML = '<div class="empty">Введи запрос...</div>'; }
}
window.loadSearchHistory = loadSearchHistory;
async function clearSearchHistory() {
  if (!confirm('Очистить историю поиска?')) return;
  try { await api('/api/search-history', { method:'DELETE' }); loadSearchHistory(); toast('История очищена'); } catch {}
}
window.clearSearchHistory = clearSearchHistory;

async function doGlobalSearch(q) {
  const el = $('globalSearchResults');
  if (!q || q.length < 2) { loadSearchHistory(); return; }
  el.innerHTML = '<div class="empty">Поиск...</div>';
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    let html = '';
    if (r.users.length) {
      html += '<div class="info-section-title" style="padding-left:14px">Люди</div>';
      html += r.users.map(u => `<div class="member-row" style="margin:0 10px 6px" onclick="saveSearchItem('user','${esc(u.login)}','${esc(u.nickname)}',null);openInfoUser('${esc(u.login)}')"><div class="mav2">${avatarInner(u)}</div><div class="mtxt"><div class="mname">${esc(u.nickname)}</div><div class="mlogin">@${esc(u.login)}</div></div></div>`).join('');
    }
    if (r.chats.length) {
      html += '<div class="info-section-title" style="padding-left:14px">Группы и каналы</div>';
      html += r.chats.map(g => `<div class="member-row" style="margin:0 10px 6px" onclick="saveSearchItem('${g.isChannel?'channel':'group'}','${esc(g.login||'')}','${esc(g.name)}','${g.id}');joinAndOpen('${g.id}','${esc(g.login||'')}')"><div class="mav2">${g.avatarFileId ? `<img src="${getAvatarUrl(g.avatarFileId)}">` : (g.isChannel ? '📢' : '#')}</div><div class="mtxt"><div class="mname">${esc(g.name)}</div><div class="mlogin">@${esc(g.login||'')} · ${g.membersCount} участ.</div></div></div>`).join('');
    }
    if (!html) html = '<div class="empty">Ничего не найдено</div>';
    el.innerHTML = html;
  } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.doGlobalSearch = doGlobalSearch;

async function saveSearchItem(type, login, name, chatId) {
  try { await api('/api/search-history', { method:'POST', body:JSON.stringify({ query: login, type, login, name, chatId }) }); } catch {}
}
window.saveSearchItem = saveSearchItem;

// ============================================================
//  PROFILE
// ============================================================
function openProfileEdit() {
  $('profileEmoji').value = profile.emoji;
  $('profileName').value = profile.name;
  $('profileAvatarBig').innerHTML = currentUser?.avatarFileId ? `<img src="${getAvatarUrl(currentUser.avatarFileId)}">` : (profile.name[0] || '?').toUpperCase();
  renderNickPalette();
  $('profileModal').classList.add('open');
}
window.openProfileEdit = openProfileEdit;

function renderNickPalette() {
  const el = $('nickColorGrid'); el.innerHTML = '';
  const colors = getPalette();
  const current = currentUser?.nicknameColor || ui.accent;
  colors.forEach(c => { const sw = document.createElement('div'); sw.className = 'accent-sw' + (c === current ? ' active' : ''); sw.style.background = c; sw.onclick = async () => { await api('/api/me', { method:'PUT', body:JSON.stringify({ nicknameColor: c }) }).catch(()=>{}); currentUser.nicknameColor = c; localStorage.setItem('krista_user', JSON.stringify(currentUser)); renderNickPalette(); }; el.appendChild(sw); });
  const custom = document.createElement('label'); custom.className = 'accent-sw custom'; custom.textContent = '+';
  const inp = document.createElement('input'); inp.type = 'color'; inp.value = current; custom.appendChild(inp);
  inp.addEventListener('input', async e => { await api('/api/me', { method:'PUT', body:JSON.stringify({ nicknameColor: e.target.value }) }).catch(()=>{}); currentUser.nicknameColor = e.target.value; localStorage.setItem('krista_user', JSON.stringify(currentUser)); });
  el.appendChild(custom);
}
async function saveProfile() {
  profile.emoji = $('profileEmoji').value.trim() || '🌸';
  profile.name = $('profileName').value.trim() || 'Без ника';
  updateProfileView();
  try { await api('/api/me', { method:'PUT', body:JSON.stringify({ nickname: profile.name, nicknameEmoji: profile.emoji }) }); } catch {}
  closeModal('profileModal');
  toast('Профиль обновлён');
}
window.saveProfile = saveProfile;

function updateProfileView() {
  const av = $('ppAvatar');
  av.innerHTML = currentUser?.avatarFileId ? `<img src="${getAvatarUrl(currentUser.avatarFileId)}" alt="">` : (profile.name[0] || '?').toUpperCase();
  av.classList.add('online');
  $('ppName').innerHTML = `<span>${esc(profile.emoji)} ${esc(profile.name)}</span>`;
  $('ppLogin').textContent = '@' + profile.login;
}

$('avatarFileInput')?.addEventListener('change', async e => {
  const file = e.target.files?.[0]; e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Только картинки');
  const compressed = await compressImage(file, 512, 0.9);
  const form = new FormData();
  form.append('file', compressed, 'avatar.jpg'); form.append('purpose', 'avatar');
  try {
    const r = await fetch('/api/upload', { method:'POST', headers:{ Authorization:'Bearer '+token }, body: form });
    const d = await r.json();
    if (!r.ok) return toast(d.error || 'Ошибка');
    currentUser.avatarFileId = d.fileId;
    localStorage.setItem('krista_user', JSON.stringify(currentUser));
    $('profileAvatarBig').innerHTML = `<img src="${getAvatarUrl(d.fileId)}">`;
    updateProfileView();
    toast('Аватар обновлён');
  } catch { toast('Ошибка сети'); }
});
function compressImage(file, maxSide, quality) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxSide || h > maxSide) { if (w > h) { h = Math.round(h * maxSide / w); w = maxSide; } else { w = Math.round(w * maxSide / h); h = maxSide; } }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => b ? res(b) : rej(new Error('compress')), 'image/jpeg', quality);
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

// ============================================================
//  THEMES
// ============================================================
function renderAccentPalette() {
  const el = $('accentGrid'); el.innerHTML = '';
  const colors = getPalette();
  colors.forEach(c => { const sw = document.createElement('div'); sw.className = 'accent-sw' + (c === ui.accent ? ' active' : ''); sw.style.background = c; sw.onclick = () => { ui.accent = c; applyUI(); api('/api/me', { method:'PUT', body:JSON.stringify({ accentColor: c }) }).catch(()=>{}); renderAccentPalette(); }; el.appendChild(sw); });
  const custom = document.createElement('label'); custom.className = 'accent-sw custom'; custom.textContent = '+';
  const inp = document.createElement('input'); inp.type = 'color'; inp.value = ui.accent; custom.appendChild(inp);
  inp.addEventListener('input', e => { ui.accent = e.target.value; applyUI(); });
  inp.addEventListener('change', e => { api('/api/me', { method:'PUT', body:JSON.stringify({ accentColor: e.target.value }) }).catch(()=>{}); });
  el.appendChild(custom);
}
function renderFontList() {
  const el = $('fontList'); if (!el) return;
  el.innerHTML = Object.keys(FONTS).map(k => { const f = FONTS[k]; return `<div class="font-tile ${ui.font === k ? 'active' : ''}" data-font="${k}"><div class="fh" style="font-family:'${f.head}',sans-serif">${f.label}</div><div class="fb" style="font-family:'${f.body}',sans-serif">Aa Бб 123</div></div>`; }).join('');
  el.querySelectorAll('.font-tile').forEach(tile => { tile.onclick = () => { ui.font = tile.dataset.font; applyUI(); renderFontList(); toast(FONTS[ui.font].label); }; });
}
function setBlur(v) { ui.blur = parseInt(v); applyUI(); }
window.setBlur = setBlur;
function setMsgOpacity(type, v) { if (type === 'in') ui.msgInOpacity = parseInt(v)/100; else ui.msgOutOpacity = parseInt(v)/100; applyUI(); }
window.setMsgOpacity = setMsgOpacity;
function togglePC() { ui.viewPC = !ui.viewPC; applyUI(); $('pcToggle').textContent = ui.viewPC ? 'ВКЛ' : 'ВЫКЛ'; $('pcToggle').classList.toggle('on', ui.viewPC); }
window.togglePC = togglePC;

$('appWallFileInput')?.addEventListener('change', async e => {
  const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
  const compressed = await compressImage(file, 1920, 0.9);
  const form = new FormData(); form.append('file', compressed, 'appwall.jpg'); form.append('purpose', 'app_wallpaper');
  try { const r = await fetch('/api/upload', { method:'POST', headers:{ Authorization:'Bearer '+token }, body: form }); const d = await r.json(); if (!r.ok) return toast(d.error); ui.appWallpaper = { fileId: d.fileId, name: d.name }; applyUI(); toast('Обои интерфейса установлены'); } catch { toast('Ошибка'); }
});
$('wallFileInput')?.addEventListener('change', async e => {
  const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
  const compressed = await compressImage(file, 1920, 0.9);
  const form = new FormData(); form.append('file', compressed, 'wall.jpg'); form.append('purpose', 'wallpaper');
  try { const r = await fetch('/api/upload', { method:'POST', headers:{ Authorization:'Bearer '+token }, body: form }); const d = await r.json(); if (!r.ok) return toast(d.error); ui.chatWallpaper = { fileId: d.fileId, name: d.name }; applyUI(); toast('Обои чата установлены'); } catch { toast('Ошибка'); }
});
function clearWallpapers() { ui.chatWallpaper = null; ui.appWallpaper = null; applyUI(); toast('Обои убраны'); }
window.clearWallpapers = clearWallpapers;

// ---- SYSTEM THEMES ----
async function openSystemThemes() {
  closeModal('settingsModal');
  $('themesModalTitle').textContent = 'Системные темы';
  $('themesModalBody').innerHTML = '<div class="empty">Загрузка...</div>';
  $('themesModal').classList.add('open');
  try {
    const list = await api('/api/themes/system');
    systemThemesCache = list;
    if (!list.length) {
      $('themesModalBody').innerHTML = '<div class="empty">Нет системных тем.<br>Положи .json файлы в public/themes/</div>';
      return;
    }
    $('themesModalBody').innerHTML = list.map((t, i) => {
      const bg = t.data?.accentColor || '#f0a0c8';
      return `<div class="theme-tile" data-idx="${i}">
        <div class="tt-preview" style="background:linear-gradient(135deg,${bg},${shade(bg,-25)})">${esc(t.icon || '🎨')}</div>
        <div class="tt-info">
          <div class="tt-name">${esc(t.name)}</div>
          <div class="tt-author">${esc(t.author || 'Криста')} · v${t.version || 1}</div>
        </div>
        <div class="tt-actions">
          <button class="tt-btn" data-apply="${i}" title="Применить">✓</button>
        </div>
      </div>`;
    }).join('');
    $('themesModalBody').querySelectorAll('[data-apply]').forEach(b => b.onclick = () => {
      applyTheme(systemThemesCache[+b.dataset.apply].data);
      closeModal('themesModal');
    });
  } catch (e) { $('themesModalBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.openSystemThemes = openSystemThemes;

async function openMyThemes() {
  closeModal('settingsModal');
  $('themesModalTitle').textContent = 'Мои темы';
  $('themesModalBody').innerHTML = '<div class="empty">Загрузка...</div>';
  $('themesModal').classList.add('open');
  try {
    const list = await api('/api/themes');
    if (!list.length) {
      $('themesModalBody').innerHTML = `
        <div class="empty">Нет сохранённых тем</div>
        <button class="list-btn primary" onclick="saveCurrentAsTheme()" style="margin-top:14px"><span class="ico">💾</span><span class="lbl">Сохранить текущие настройки</span></button>
        <button class="list-btn" onclick="openImportTheme()" style="margin-top:8px"><span class="ico">📥</span><span class="lbl">Импорт темы</span></button>
      `;
      return;
    }
    $('themesModalBody').innerHTML = `
      ${list.map((t, i) => {
        const bg = t.data?.accentColor || '#f0a0c8';
        return `<div class="theme-tile" data-idx="${i}">
          <div class="tt-preview" style="background:linear-gradient(135deg,${bg},${shade(bg,-25)})">🎨</div>
          <div class="tt-info">
            <div class="tt-name">${esc(t.name)}</div>
            <div class="tt-author">сохранено ${esc(fDateTime(t.createdAt))}</div>
          </div>
          <div class="tt-actions">
            <button class="tt-btn" data-apply="${i}" title="Применить">✓</button>
            <button class="tt-btn" data-export="${i}" title="Экспорт">📤</button>
            <button class="tt-btn del" data-del="${i}" title="Удалить">✕</button>
          </div>
        </div>`;
      }).join('')}
      <button class="list-btn primary" onclick="saveCurrentAsTheme()" style="margin-top:14px"><span class="ico">💾</span><span class="lbl">Сохранить текущие</span></button>
      <button class="list-btn" onclick="openImportTheme()" style="margin-top:8px"><span class="ico">📥</span><span class="lbl">Импорт темы</span></button>
    `;
    $('themesModalBody').querySelectorAll('[data-apply]').forEach(b => b.onclick = () => { applyTheme(list[+b.dataset.apply].data); closeModal('themesModal'); });
    $('themesModalBody').querySelectorAll('[data-export]').forEach(b => b.onclick = e => { e.stopPropagation(); exportTheme(list[+b.dataset.export]); });
    $('themesModalBody').querySelectorAll('[data-del]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      if (!confirm('Удалить тему?')) return;
      try { await api('/api/themes/' + list[+b.dataset.del]._id, { method:'DELETE' }); openMyThemes(); } catch (err) { toast(err.message); }
    });
  } catch (e) { $('themesModalBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.openMyThemes = openMyThemes;

function applyTheme(data) {
  if (!data) return;
  if (data.accentColor) ui.accent = data.accentColor;
  if (data.font && FONTS[data.font]) ui.font = data.font;
  if (data.blur !== undefined) ui.blur = data.blur;
  if (data.msgInOpacity !== undefined) ui.msgInOpacity = data.msgInOpacity;
  if (data.msgOutOpacity !== undefined) ui.msgOutOpacity = data.msgOutOpacity;
  if (data.chatWallpaperFileId) ui.chatWallpaper = { fileId: data.chatWallpaperFileId, name: 'тема' };
  if (data.appWallpaperFileId) ui.appWallpaper = { fileId: data.appWallpaperFileId, name: 'тема' };
  if (data.chatWallpaper === null) ui.chatWallpaper = null;
  if (data.appWallpaper === null) ui.appWallpaper = null;
  saveUIApply();
  toast('🎨 Тема применена');
}
function saveUIApply() { applyUI(); localStorage.setItem('krista_ui', JSON.stringify(ui)); }
window.applyTheme = applyTheme;

async function saveCurrentAsTheme() {
  const name = prompt('Название темы:', 'Моя тема');
  if (!name || !name.trim()) return;
  const data = {
    id: 'custom-' + Date.now(),
    name: name.trim(),
    author: currentUser?.login || 'аноним',
    version: 1,
    accentColor: ui.accent,
    font: ui.font,
    blur: ui.blur,
    msgInOpacity: ui.msgInOpacity,
    msgOutOpacity: ui.msgOutOpacity,
    chatWallpaperFileId: ui.chatWallpaper?.fileId || null,
    appWallpaperFileId: ui.appWallpaper?.fileId || null
  };
  try { await api('/api/themes', { method:'POST', body:JSON.stringify({ name: name.trim(), data }) }); toast('💾 Сохранено'); openMyThemes(); }
  catch (e) { toast(e.message); }
}
window.saveCurrentAsTheme = saveCurrentAsTheme;

function exportCurrentTheme() {
  closeModal('settingsModal');
  const name = prompt('Название файла темы:', 'my-theme');
  if (!name) return;
  const data = {
    id: name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(),
    name: name,
    author: currentUser?.login || 'аноним',
    version: 1,
    accentColor: ui.accent,
    font: ui.font,
    blur: ui.blur,
    msgInOpacity: ui.msgInOpacity,
    msgOutOpacity: ui.msgOutOpacity,
    chatWallpaperFileId: ui.chatWallpaper?.fileId || null,
    appWallpaperFileId: ui.appWallpaper?.fileId || null
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = data.id + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('📤 Тема экспортирована');
}
window.exportCurrentTheme = exportCurrentTheme;

function exportTheme(t) {
  if (!t) return;
  const data = Object.assign({ id: t._id, name: t.name, author: currentUser?.login || 'аноним', version: 1 }, t.data || {});
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (t.name || 'theme').replace(/[^\wа-яА-ЯёЁ-]/g, '_') + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('📤 Тема скачана');
}

function openImportTheme() {
  closeModal('settingsModal');
  $('importThemeUrl').value = '';
  $('importThemeModal').classList.add('open');
}
window.openImportTheme = openImportTheme;

async function importThemeFromUrl() {
  const url = $('importThemeUrl').value.trim();
  if (!url) return toast('Вставь URL');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Не удалось загрузить');
    const data = await r.json();
    if (!data || !data.accentColor) throw new Error('Неверный формат');
    applyTheme(data);
    await api('/api/themes', { method:'POST', body:JSON.stringify({ name: data.name || 'Импорт', data }) }).catch(()=>{});
    closeModal('importThemeModal');
    toast('📥 Тема загружена');
  } catch (e) { toast(e.message); }
}
window.importThemeFromUrl = importThemeFromUrl;

$('themeFileInput')?.addEventListener('change', async e => {
  const file = e.target.files?.[0]; e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !data.accentColor) throw new Error('Неверный формат');
    applyTheme(data);
    await api('/api/themes', { method:'POST', body:JSON.stringify({ name: data.name || 'Импорт', data }) }).catch(()=>{});
    closeModal('importThemeModal');
    toast('📥 Тема загружена');
  } catch (e) { toast('Ошибка чтения файла'); }
});

// ============================================================
//  ACCOUNTS (5)
// ============================================================
function openAccounts() {
  closeModal('settingsModal');
  renderAccounts();
  $('accountsModal').classList.add('open');
}
window.openAccounts = openAccounts;

function renderAccounts() {
  const el = $('accountsList');
  if (!el) return;
  if (!accounts.length) el.innerHTML = '<div class="empty">Нет сохранённых</div>';
  else el.innerHTML = accounts.map((a, i) => {
    const active = currentUser && a.login === currentUser.login;
    const av = (a.nickname || a.login || '?')[0].toUpperCase();
    return `<div class="acc-row ${active ? 'active' : ''}">
      <div class="ainfo">
        <div class="acc-av">${esc(av)}</div>
        <div class="acc-meta">
          <div class="aname">${esc(a.nickname || a.login)}</div>
          <div class="alogin">@${esc(a.login)}</div>
        </div>
      </div>
      <div class="acc-btns">
        ${active ? '<button class="on" disabled>●</button>' : `<button data-sw="${i}">ВОЙТИ</button>`}
        <button class="del" data-del="${i}">✕</button>
      </div>
    </div>`;
  }).join('') + `<div style="text-align:center;font-size:11px;color:var(--text-3);font-style:italic;margin-top:6px">${accounts.length}/5 аккаунтов</div>`;
  el.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => switchAccount(+b.dataset.sw));
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (!confirm('Убрать аккаунт из списка?')) return;
    accounts.splice(+b.dataset.del, 1);
    saveAccList();
    renderAccounts();
  });
  updateAccCount();
}
function updateAccCount() {
  const el = $('accCountLabel');
  if (el) el.textContent = accounts.length + '/5';
}

function saveAccount(a) {
  accounts = accounts.filter(x => x.login !== a.login);
  accounts.unshift(a);
  if (accounts.length > 5) accounts = accounts.slice(0, 5);
  saveAccList();
  updateAccCount();
}
function saveAccList() { localStorage.setItem('krista_accounts', JSON.stringify(accounts)); }
window.saveAccList = saveAccList;

async function switchAccount(i) {
  const a = accounts[i];
  if (!a) return;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  stopHeartbeat();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stopGlobalPolling();
  if (window.stopMusicPlayer) try { window.stopMusicPlayer(); } catch {}
  token = a.token;
  window.token = token;
  localStorage.setItem('krista_token', token);
  currentUser = { login: a.login, nickname: a.nickname || a.login };
  localStorage.setItem('krista_user', JSON.stringify(currentUser));
  messages = {}; chats = []; currentChatId = null; currentChatMeta = null; onlineStatus = {}; sendQueue = [];
  for (const [, e] of fileBlobCache) { try { URL.revokeObjectURL(e.url); } catch {} }
  fileBlobCache.clear();
  $('chatScreen').classList.remove('open');
  $('chatScreen').classList.add('no-chat');
  closeModal('accountsModal');
  toast('@' + a.login);
  try {
    const me = await api('/api/me');
    currentUser = me;
    localStorage.setItem('krista_user', JSON.stringify(me));
    profile = { emoji: me.nicknameEmoji || '🌸', name: me.nickname, login: me.login };
    if (me.accentColor) { ui.accent = me.accentColor; applyUI(); }
    updateProfileView();
    renderAccentPalette();
    await loadFolders();
    connectWS();
    await loadChats();
    startGlobalPolling();
  } catch (e) { if (e.status === 401) toast('Токен истёк, войди заново'); }
}
window.switchAccount = switchAccount;

function addAccount() {
  if (accounts.length >= 5) return toast('Максимум 5 аккаунтов');
  closeAllOverlays();
  // Не удаляем текущий токен — сохраняем его в accounts
  logout(true);
}
window.addAccount = addAccount;

// ============================================================
//  AUTH
// ============================================================
function switchAuthTab(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  $('tabLoginBtn').classList.toggle('active', isLogin);
  $('tabRegBtn').classList.toggle('active', !isLogin);
  $('lblNick').style.display = isLogin ? 'none' : 'block';
  $('authNickname').style.display = isLogin ? 'none' : 'block';
  $('authConfirm').style.display = isLogin ? 'none' : 'block';
  $('authSubmitBtn').textContent = isLogin ? 'ВОЙТИ' : 'СОЗДАТЬ';
  $('authError').textContent = '';
}
window.switchAuthTab = switchAuthTab;
$('tabLoginBtn').onclick = () => switchAuthTab('login');
$('tabRegBtn').onclick = () => switchAuthTab('reg');

$('authSubmitBtn').onclick = async () => {
  const err = $('authError'); err.textContent = '';
  const login = $('authLogin').value.trim();
  const pass = $('authPassword').value;
  try {
    $('authSubmitBtn').disabled = true;
    let d;
    if (authMode === 'login') {
      if (!login || !pass) { err.textContent = 'Заполните поля'; return; }
      d = await api('/api/login', { method:'POST', body:JSON.stringify({ login, password: pass }) });
    } else {
      const nick = $('authNickname').value.trim();
      const conf = $('authConfirm').value;
      if (!login || !nick || !pass) { err.textContent = 'Заполните все поля'; return; }
      if (pass !== conf) { err.textContent = 'Пароли не совпадают'; return; }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) { err.textContent = 'Логин: только латиница, цифры, _ и -'; return; }
      if (login.length < 3) { err.textContent = 'Логин: минимум 3 символа'; return; }
      if (nick.length > 30) { err.textContent = 'Ник: до 30 символов'; return; }
      if (pass.length < 6) { err.textContent = 'Пароль: минимум 6 символов'; return; }
      d = await api('/api/register', { method:'POST', body:JSON.stringify({ login, nickname: nick, password: pass, confirmPassword: conf }) });
    }
    token = d.token;
    currentUser = { login: d.login, nickname: d.nickname };
    localStorage.setItem('krista_token', token);
    localStorage.setItem('krista_user', JSON.stringify(currentUser));
    saveAccount({ login: d.login, nickname: d.nickname, token });
    await afterLogin();
  } catch (e) { err.textContent = e.message; }
  finally { $('authSubmitBtn').disabled = false; }
};

async function afterLogin() {
  try {
    const me = await api('/api/me');
    currentUser = me;
    localStorage.setItem('krista_user', JSON.stringify(me));
    profile = { emoji: me.nicknameEmoji || '🌸', name: me.nickname, login: me.login };
    if (me.accentColor) { ui.accent = me.accentColor; applyUI(); }
    $('loginScreen').classList.remove('active');
    $('app').style.display = 'flex';
    updateProfileView();
    renderEmojiGrid(); renderAccentPalette();
    await loadFolders();
    connectWS();
    await loadChats();
    updateStats();
    startGlobalPolling();
    handleDeepLink();
    updateAccCount();
  } catch (e) { if (e.status === 401) logout(); }
}

function logout(skipRedirect) {
  if (!skipRedirect && currentUser && token) {
    saveAccount({ login: currentUser.login, nickname: currentUser.nickname, token });
  }
  token = null; currentUser = null;
  localStorage.removeItem('krista_token');
  localStorage.removeItem('krista_user');
  if (ws) try { ws.close(); } catch {}
  stopHeartbeat(); closeAllOverlays();
  stopGlobalPolling();
  if (window.stopMusicPlayer) try { window.stopMusicPlayer(); } catch {}
  $('app').style.display = 'none';
  $('loginScreen').classList.add('active');
  switchAuthTab('login');
  $('authLogin').value = '';
  $('authPassword').value = '';
}
function closeAllOverlays() { $$('.modal-overlay').forEach(o => o.classList.remove('open')); }
window.logout = logout;

async function deleteAccount() {
  if (!confirm('Удалить аккаунт навсегда?')) return;
  try {
    await api('/api/me', { method:'DELETE' });
    accounts = accounts.filter(a => a.login !== currentUser.login);
    saveAccList();
    logout();
  } catch (e) { toast(e.message); }
}
window.deleteAccount = deleteAccount;

// ============================================================
//  SETTINGS
// ============================================================
function openSettings() {
  renderAccentPalette(); renderFontList();
  $('blurRange').value = ui.blur;
  $('opInRange').value = Math.round(ui.msgInOpacity * 100);
  $('opOutRange').value = Math.round(ui.msgOutOpacity * 100);
  $('pcToggle').textContent = ui.viewPC ? 'ВКЛ' : 'ВЫКЛ';
  $('pcToggle').classList.toggle('on', !!ui.viewPC);
  $('tgLinkBtn').style.display = currentUser?.tgChatId ? 'none' : 'flex';
  $('tgUnlinkBtn').style.display = currentUser?.tgChatId ? 'flex' : 'none';
  updateAccCount();
  $('settingsModal').classList.add('open');
  updateStats();
}
window.openSettings = openSettings;

async function updateStats() { try { const s = await api('/api/stats'); $('statInfo').textContent = `Аккаунтов: ${s.accounts} · Чатов: ${s.chats} · Онлайн: ${s.online}`; } catch {} }

async function linkTelegram() { try { const r = await api('/api/tg/link', { method:'POST' }); window.open(`https://t.me/${r.botUsername}?start=${r.code}`, '_blank'); toast('Открой бота и нажми START'); } catch (e) { toast(e.message); } }
window.linkTelegram = linkTelegram;
async function unlinkTelegram() { try { await api('/api/tg/unlink', { method:'POST' }); currentUser.tgChatId = false; toast('Отвязано'); } catch (e) { toast(e.message); } }
window.unlinkTelegram = unlinkTelegram;

function openDiag() {
  const items = [
    ['Версия', '4.40'],
    ['WebSocket', wsState === 'online' ? 'ONLINE' : wsState.toUpperCase()],
    ['Online', navigator.onLine ? 'yes' : 'no'],
    ['Queue', sendQueue.length],
    ['Login', currentUser?.login || '—'],
    ['Chats', chats.length],
    ['Folders', folders.length],
    ['Reminders', remindersCache.length],
    ['Аккаунтов', accounts.length + '/5'],
    ['TG linked', currentUser?.tgChatId ? 'yes' : 'no']
  ];
  $('diagList').innerHTML = items.map(([k, v]) => `<div style="display:flex;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--glass-border);font-size:12px"><span style="color:var(--text-3)">${k}</span><span style="color:var(--accent);font-weight:600">${esc(String(v))}</span></div>`).join('');
  $('diagModal').classList.add('open');
}
window.openDiag = openDiag;
function copyDiagnostics() { navigator.clipboard?.writeText($('diagList').innerText).then(() => toast('Скопировано')); }
window.copyDiagnostics = copyDiagnostics;

// ============================================================
//  SIDEBAR
// ============================================================
$$('.sb-btn').forEach(btn => {
  btn.onclick = () => {
    const v = btn.dataset.view;
    if (v === 'settings') { openSettings(); return; }
    if (v === 'new') { $('createModal').classList.add('open'); return; }
    switchView(v);
  };
});
$('logoBtn')?.addEventListener('click', () => openDiag());

// ============================================================
//  CHAT SEARCH
// ============================================================
let chatSearchTimer = null;
$('chatSearchBtn')?.addEventListener('click', () => {
  if (!currentChatId) return;
  $('chatSearchInput').value = '';
  $('chatSearchResults').innerHTML = '<div class="empty">Введи запрос...</div>';
  $('chatSearchModal').classList.add('open');
  setTimeout(() => $('chatSearchInput').focus(), 150);
});
$('chatSearchInput')?.addEventListener('input', () => {
  clearTimeout(chatSearchTimer);
  const q = $('chatSearchInput').value.trim();
  if (q.length < 2) { $('chatSearchResults').innerHTML = '<div class="empty">Введи хотя бы 2 символа...</div>'; return; }
  chatSearchTimer = setTimeout(() => doChatSearch(q), 300);
});
async function doChatSearch(q) {
  if (!currentChatId) return;
  $('chatSearchResults').innerHTML = '<div class="empty">Поиск...</div>';
  try {
    const res = await api('/api/chats/' + currentChatId + '/search?q=' + encodeURIComponent(q));
    if (!res.length) { $('chatSearchResults').innerHTML = '<div class="empty">Ничего не найдено</div>'; return; }
    $('chatSearchResults').innerHTML = res.map(m => `<div class="member-row" data-mid="${esc(m.id)}"><div class="mtxt"><div class="mname">${esc(m.senderName)}</div><div class="mlogin" style="font-style:normal;font-size:12px;white-space:normal;margin-top:3px">${esc((m.text||'').replace(/\[[a-z0-9_]+\]/g, '🙂').slice(0,80))}</div><div class="mlogin" style="margin-top:3px">${esc(fDate(m.timestamp))} ${esc(fTime(m.timestamp))}</div></div></div>`).join('');
    $('chatSearchResults').querySelectorAll('.member-row').forEach(el => el.onclick = () => {
      const mid = el.dataset.mid;
      closeModal('chatSearchModal');
      const t = $('messagesArea').querySelector(`.msg[data-id="${mid}"]`);
      if (t) { t.scrollIntoView({ behavior:'smooth', block:'center' }); t.querySelector('.bub')?.style.setProperty('box-shadow','0 0 0 3px var(--accent)'); setTimeout(() => t.querySelector('.bub')?.style.removeProperty('box-shadow'), 1800); }
    });
  } catch (e) { $('chatSearchResults').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ============================================================
//  CHAT MENU
// ============================================================
$('chatMenuBtn')?.addEventListener('click', e => {
  e.stopPropagation();
  if (!currentChatMeta) return;
  const menu = $('ctxMenu');
  let items = '';
  if (currentChatMeta.isGroup) {
    items += `<div class="ctx-item" data-act="info"><span class="ci">ℹ</span><span class="cl">О чате</span></div>`;
    if (currentChatMeta.isAdmin) items += `<div class="ctx-item" data-act="settings"><span class="ci">⚙</span><span class="cl">Настройки</span></div>`;
    if (currentChatMeta.isAdmin) items += `<div class="ctx-item danger" data-act="clear"><span class="ci">🧹</span><span class="cl">Очистить</span></div>`;
    if (!currentChatMeta.isAdmin) items += `<div class="ctx-item danger" data-act="leave"><span class="ci">↩</span><span class="cl">Покинуть</span></div>`;
  } else {
    items += `<div class="ctx-item" data-act="info"><span class="ci">ℹ</span><span class="cl">Профиль</span></div>`;
  }
  items += `<div class="ctx-item" data-act="alias"><span class="ci">🏷</span><span class="cl">${currentChatMeta.alias?'Изменить псевдоним':'Псевдоним'}</span></div>`;
  items += `<div class="ctx-item" data-act="archive"><span class="ci">📦</span><span class="cl">${currentChatMeta.archived?'Из архива':'В архив'}</span></div>`;
  menu.innerHTML = items;
  menu.classList.add('open');
  menu.querySelectorAll('.ctx-item').forEach(el => {
    el.onclick = () => {
      const act = el.dataset.act;
      menu.classList.remove('open');
      if (act === 'info') openInfoChat();
      else if (act === 'settings') openGroupSettings();
      else if (act === 'clear') { gsChatId = currentChatId; clearChat(); }
      else if (act === 'leave') { gsChatId = currentChatId; leaveGroup(); }
      else if (act === 'alias') openAliasEdit(currentChatId);
      else if (act === 'archive') archiveChat(currentChatId, !currentChatMeta.archived);
    };
  });
  positionCtxMenu(menu, e);
});

// ============================================================
//  PWA / ONLINE / POLLING / DEEP LINKS
// ============================================================
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; if (localStorage.getItem('krista_install_closed') !== '1') setTimeout(() => $('installBanner').classList.add('show'), 3000); });
$('installBtn')?.addEventListener('click', async () => { if (!deferredPrompt) { $('installBanner').classList.remove('show'); return; } try { deferredPrompt.prompt(); const { outcome } = await deferredPrompt.userChoice; if (outcome === 'accepted') toast('Установлено!'); deferredPrompt = null; $('installBanner').classList.remove('show'); } catch {} });
$('installClose')?.addEventListener('click', () => { localStorage.setItem('krista_install_closed', '1'); $('installBanner').classList.remove('show'); });
window.addEventListener('appinstalled', () => { $('installBanner').classList.remove('show'); deferredPrompt = null; toast('Спасибо за установку! 🌸'); });

function updateOnlineStatus() { const bar = $('offlineBar'); if (!navigator.onLine && token) bar.classList.add('show'); else bar.classList.remove('show'); }
window.addEventListener('online', () => { updateOnlineStatus(); if (token && (!ws || ws.readyState !== 1)) connectWS(); loadChats(); });
window.addEventListener('offline', updateOnlineStatus);
function retryConnection() { updateOnlineStatus(); if (!navigator.onLine) return toast('Всё ещё нет соединения'); if (!ws || ws.readyState !== 1) connectWS(); loadChats(); toast('Переподключение...'); }
window.retryConnection = retryConnection;

let globalPollTimer = null;
function startGlobalPolling() { stopGlobalPolling(); globalPollTimer = setInterval(() => { if (!token || !navigator.onLine) return; if (document.visibilityState !== 'visible') return; loadChats(); }, 30000); }
function stopGlobalPolling() { if (globalPollTimer) clearInterval(globalPollTimer); globalPollTimer = null; }

function handleDeepLink() {
  try {
    const p = new URLSearchParams(location.search);
    const chatId = p.get('chat'), userLogin = p.get('user');
    if (chatId) { history.replaceState({}, '', location.pathname); const f = chats.find(c => c.id === chatId); if (f) setTimeout(() => openChat(chatId), 300); }
    else if (userLogin) { history.replaceState({}, '', location.pathname); setTimeout(() => openInfoUser(userLogin), 400); }
  } catch {}
}

// ============================================================
//  INIT
// ============================================================
(async function init() {
  applyUI();
  renderEmojiGrid();
  updateOnlineStatus();
  updateAccCount();

  if (token && currentUser) {
    try {
      $('app').style.display = 'flex';
      const me = await api('/api/me');
      currentUser = me;
      localStorage.setItem('krista_user', JSON.stringify(me));
      profile = { emoji: me.nicknameEmoji || '🌸', name: me.nickname, login: me.login };
      if (me.accentColor) { ui.accent = me.accentColor; applyUI(); }
      saveAccount({ login: me.login, nickname: me.nickname, token });
      updateProfileView();
      renderAccentPalette();
      await loadFolders();
      connectWS();
      await loadChats();
      updateStats();
      startGlobalPolling();
      handleDeepLink();
    } catch (e) {
      if (e.status === 401) logout();
      else $('app').style.display = 'flex';
    }
  } else {
    $('loginScreen').classList.add('active');
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
console.log('%c🌸 Криста.ФриРунет v4.40', 'color:#f0a0c8;font-family:monospace;font-size:14px');
</script>
<script src="/music.js"></script>
</body>
</html>
