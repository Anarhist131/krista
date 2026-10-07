// КРИСТА.NET · server.js v4.45
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'krista';
const LOGIN_COOLDOWN = 24 * 60 * 60 * 1000;
const MAX_MSG_LEN = 2000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
const BASE_URL = process.env.BASE_URL || 'https://krista-4.onrender.com';
const SUPPORT_TG = 'prikin_1';
const ALLOWED_THEMES = ['sunset', 'neon', 'frutiger', 'oldbrother'];
const VERSION = '4.45';

if (!MONGO_URI) consolele.error('❌ MONGO_URI не задан.'); process.exit(1); }

let usersCol, chatsCol, messagesCol, filesCol, countersCol;
let themesCol, chatThemesCol, tgLinksCol, botSessionsCol, foldersCol;

const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, socketTimeoutMS: 45000
});

// ============================================================
//  TELEGRAM BOT
// ============================================================
const TG_CHAT_ID = (process.env.TG_CHAT_ID || '').trim();
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
let tgBot = null;

if (TG_BOT_TOKEN && TG_CHAT_ID) {
  try {
    tgBot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
    tgBot.getMe().then(me => console.log(`📨 Бот: @${me.username}`)).catch(e => console.error('❌ getMe:', e.message));
    tgBot.on('polling_error', e => console.warn('TG:', e.message));
    tgBot.on('message', async msg => {
      try {
        if (msg.chat.type === 'private') { await handleBotPrivateMessage(msg); return; }
      } catch (e) { console.warn('TG msg:', e.message); }
    });
    tgBot.on('callback_query', async cb => {
      try { await handleCallback(cb); }
      catch (e) { console.warn('TG cb:', e.message); try { tgBot.answerCallbackQuery(cb.id); } catch {} }
    });
  } catch (e) { console.error('❌ Telegram:', e.message); }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

// ============================================================
//  MONGODB
// ============================================================
async function connectDB() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`🔌 MongoDB: ${attempt}/5...`);
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      usersCol = db.collection('users');
      chatsCol = db.collection('chats');
      messagesCol = db.collection('messages');
      filesCol = db.collection('files');
      countersCol = db.collection('counters');
      themesCol = db.collection('themes');
      chatThemesCol = db.collection('chat_themes');
      tgLinksCol = db.collection('tg_links');
      botSessionsCol = db.collection('bot_sessions');
      foldersCol = db.collection('folders');

      await usersCol.createIndex({ login: 1 }, { unique: true, sparse: true }).catch(() => {});
      await usersCol.createIndex({ tgChatId: 1 }, { sparse: true }).catch(() => {});
      await chatsCol.createIndex({ login: 1 }, { unique: true, sparse: true }).catch(() => {});
      await chatsCol.createIndex({ members: 1 }).catch(() => {});
      await chatsCol.createIndex({ published: 1 }).catch(() => {});
      await messagesCol.createIndex({ chatId: 1, timestamp: 1 }).catch(() => {});
      await messagesCol.createIndex({ sender: 1 }).catch(() => {});
      await messagesCol.createIndex({ text: 'text' }).catch(() => {});
      await messagesCol.createIndex({ chatId: 1, readBy: 1 }).catch(() => {});
      await filesCol.createIndex({ uploader: 1 }).catch(() => {});
      await foldersCol.createIndex({ owner: 1 }).catch(() => {});
      // М3: уникальный индекс для системных папок
      await foldersCol.createIndex({ owner: 1, system: 1, filter: 1 }, { unique: true, partialFilterExpression: { system: true } }).catch(() => {});
      await tgLinksCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
      await botSessionsCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});

      console.log('✅ MongoDB подключена');
      await migrateV3();
      return;
    } catch (err) {
      console.error(`❌ ${err.message}`);
      if (attempt >= 5) process.exit(1);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ============================================================
//  МИГРАЦИЯ
// ============================================================
async function migrateV3() {
  const db = mongoClient.db(DB_NAME);
  try {
    const fixedUsers = await countersCol.findOne({ _id: 'fixed_users_v440' });
    if (!fixedUsers) {
      await usersCol.updateMany({}, { $set: { archivedChats: [], chatAliases: {}, favorites: [], searchHistory: [] } });
      await usersCol.updateMany({}, { $unset: { stickers: '' } });
      await countersCol.updateOne({ _id: 'fixed_users_v440' }, { $set: { value: 1 } }, { upsert: true });
    }

    const fixedUsersV442 = await countersCol.findOne({ _id: 'fixed_users_v442' });
    if (!fixedUsersV442) {
      await usersCol.updateMany({ theme: { $exists: false } }, { $set: { theme: 'sunset' } });
      await countersCol.updateOne({ _id: 'fixed_users_v442' }, { $set: { value: 1 } }, { upsert: true });
    }

    const done = await countersCol.findOne({ _id: 'migrated_v3' });
    if (done) return;
    console.log('🔧 Миграция v3');

    const channels = await db.collection('channels').find({}).toArray().catch(() => []);
    for (const c of channels) {
      if (await chatsCol.findOne({ _id: c._id })) continue;
      await chatsCol.insertOne({
        _id: c._id, type: 'group', isChannel: true,
        name: c.name, login: c.login, owner: c.owner,
        admins: [c.owner], members: c.subscribers || [c.owner],
        isPrivate: !!c.isPrivate, published: !!c.published,
        avatarFileId: c.avatarFileId || null,
        updatedAt: c.createdAt || new Date().toISOString()
      });
    }

    const posts = await db.collection('posts').find({ 'wall.type': 'channel' }).toArray().catch(() => []);
    for (const p of posts) {
      if (await messagesCol.findOne({ _id: p._id })) continue;
      const firstFile = (p.files || [])[0];
      let fileId = null;
      if (firstFile && firstFile.fileId) {
        const f = await filesCol.findOne({ _id: firstFile.fileId });
        if (f) fileId = f._id;
      }
      await messagesCol.insertOne({
        _id: p._id, chatId: p.wall.id, sender: p.author, senderName: p.authorName,
        type: firstFile ? 'file' : 'text', text: p.text || '', fileId,
        reactions: (p.likes || []).length ? [{ emoji: 'heart', logins: p.likes }] : [],
        deliveredTo: [], readBy: [], timestamp: p.timestamp, replyTo: null, deleted: false
      });
    }

    await db.collection('channels').drop().catch(() => {});
    await db.collection('posts').drop().catch(() => {});
    await db.collection('comments').drop().catch(() => {});
    await usersCol.updateMany({}, { $unset: { subscriptions: '', wallPrivacy: '' } });
    await countersCol.updateOne({ _id: 'migrated_v3' }, { $set: { value: 1, date: new Date().toISOString() } }, { upsert: true });
    console.log('✅ Миграция v3 завершена');
  } catch (e) { console.error('❌ Миграция:', e); }
}

// ============================================================
//  УТИЛИТЫ
// ============================================================
const generateToken = login => jwt.sign({ login }, JWT_SECRET, { expiresIn: '30d' });
const verifyToken = t => { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } };
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sanitize = s => String(s || '').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120);
const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function validateLogin(login) {
  if (typeof login !== 'string') return 'Логин обязателен';
  if (login.length < 3 || login.length > 32) return 'Логин: 3-32 символа';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) return 'Логин: только латиница, цифры, _ и -';
  return null;
}

// М4: валидация массивов в PUT /api/me
function sanitizeStringArray(arr, maxItems = 500, maxLen = 64) {
  if (!Array.isArray(arr)) return null;
  return arr.filter(x => typeof x === 'string' && x.length > 0 && x.length <= maxLen).slice(0, maxItems);
}

async function nextNum() {
  const r = await countersCol.findOneAndUpdate({ _id: 'file_number' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
  return r.value;
}

// ============================================================
//  PUBLIC
// ============================================================
function pubUser(doc) {
  if (!doc) return null;
  return {
    login: doc.login, nickname: doc.nickname || doc.login,
    accentColor: doc.accentColor || '#ff8844',
    nicknameColor: doc.nicknameColor || '#ff8844',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#ff8844',
    avatarFileId: doc.avatarFileId || null,
    loginChangeableAt: doc.loginChangeableAt || null,
    tgChatId: !!doc.tgChatId,
    theme: doc.theme || 'sunset',
    pinnedChats: doc.pinnedChats || [],
    archivedChats: doc.archivedChats || [],
    // Р: favorites и chatAliases убраны (мёртвый код)
    searchHistory: doc.searchHistory || [],
    createdAt: doc.createdAt, lastSeen: doc.lastSeen
  };
}
function pubUserShort(doc) {
  if (!doc) return null;
  return {
    login: doc.login, nickname: doc.nickname || doc.login,
    nicknameColor: doc.nicknameColor || '#ff8844',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#ff8844',
    avatarFileId: doc.avatarFileId || null,
    online: clients.has(doc.login)
  };
}
function pubMessage(doc, filesMap, avatarMap) {
  if (!doc) return null;
  let file = null;
  if (doc.fileId && filesMap && filesMap[doc.fileId]) file = filesMap[doc.fileId];
  else if (doc.file) file = doc.file;
  return {
    id: doc._id, clientId: doc.clientId || null, chatId: doc.chatId,
    sender: doc.sender, senderName: doc.senderName,
    senderAvatarFileId: (avatarMap && avatarMap[doc.sender]) || null,
    senderEmoji: doc.senderEmoji || '',
    senderEmojiColor: doc.senderEmojiColor || '',
    type: doc.type || 'text', text: doc.text, file,
    reactions: doc.reactions || [],
    deliveredTo: doc.deliveredTo || [],
    readBy: doc.readBy || [],
    timestamp: doc.timestamp,
    editedAt: doc.editedAt || null,
    replyTo: doc.replyTo || null,
    forwardFrom: doc.forwardFrom || null,
    deleted: doc.deleted ? 1 : 0
  };
}
async function getFilesMap(fileIds) {
  const ids = fileIds.filter(Boolean);
  if (!ids.length) return {};
  const files = await filesCol.find({ _id: { $in: ids } }).toArray();
  const map = {}; files.forEach(f => { map[f._id] = f; }); return map;
}
async function getAvatarMap(logins) {
  const uniq = [...new Set(logins.filter(Boolean))];
  if (!uniq.length) return {};
  const users = await usersCol.find({ login: { $in: uniq } }).toArray();
  const map = {}; users.forEach(u => { map[u.login] = u.avatarFileId || null; }); return map;
}
async function pubMessagesList(msgs) {
  const ids = msgs.map(m => m.fileId).filter(Boolean);
  const senders = msgs.map(m => m.sender);
  const [filesMap, avatarMap] = await Promise.all([getFilesMap(ids), getAvatarMap(senders)]);
  return msgs.map(m => pubMessage(m, filesMap, avatarMap));
}

// ============================================================
//  EXPRESS
// ============================================================
const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (!p.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=3600'); }
}));

function authMw(req, res, next) {
  let auth = req.headers.authorization;
  if ((!auth || !auth.startsWith('Bearer ')) && req.query.token) auth = 'Bearer ' + req.query.token;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Требуется авторизация' });
  const dec = verifyToken(auth.slice(7));
  if (!dec) return res.status(401).json({ error: 'Неверный токен' });
  req.userLogin = dec.login;
  next();
}
async function requireChatMember(req, res, next) {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
    req.chat = chat; next();
  } catch { res.status(500).json({ error: 'Ошибка сервера' }); }
}
function requireChatAdmin(req, res, next) {
  const isAdmin = (req.chat.admins || []).includes(req.userLogin) || req.chat.owner === req.userLogin;
  if (!isAdmin) return res.status(403).json({ error: 'Только админ' });
  next();
}

// ============================================================
//  🎨 КОЛОБКИ PROXY
// ============================================================
const KOLOBOK_CACHE = new Map();
const KOLOBOK_TTL = 24 * 60 * 60 * 1000;

app.get('/api/kolobok/:name', async (req, res) => {
  try {
    const name = String(req.params.name || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40);
    if (!name) return res.status(400).send('bad name');
    const now = Date.now();
    const cached = KOLOBOK_CACHE.get(name);
    if (cached && now - cached.at < KOLOBOK_TTL) {
      res.setHeader('Content-Type', cached.type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buf);
    }
    const url = `https://kolobok.us/smiles/standart/${name}.gif`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://kolobok.us/',
        'Accept': 'image/*,*/*'
      }
    });
    if (!r.ok) return res.status(404).send('not found');
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'image/gif';
    KOLOBOK_CACHE.set(name, { buf, type, at: now });
    if (KOLOBOK_CACHE.size > 300) {
      const firstKey = KOLOBOK_CACHE.keys().next().value;
      KOLOBOK_CACHE.delete(firstKey);
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch { res.status(500).send('error'); }
});

// ============================================================
//  AUTH
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { login, nickname, password, confirmPassword } = req.body || {};
    const err = validateLogin(login);
    if (err) return res.status(400).json({ error: err });
    if (!nickname || nickname.length < 1 || nickname.length > 30) return res.status(400).json({ error: 'Ник: 1-30 символов' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6' });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ error: 'Пароли не совпадают' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    if (await chatsCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    const now = new Date().toISOString();
    await usersCol.insertOne({
      login, password: await bcrypt.hash(password, 10), nickname: nickname.trim(),
      accentColor: '#ff8844', nicknameColor: '#ff8844',
      nicknameEmoji: '', nicknameEmojiColor: '#ff8844',
      avatarFileId: null, tgChatId: null, loginChangeableAt: null,
      mutedUntil: null, dailyDigest: true,
      theme: 'sunset',
      pinnedChats: [], archivedChats: [], searchHistory: [],
      createdAt: now, lastSeen: now
    });
    res.status(201).json({ success: true, login, nickname: nickname.trim(), token: generateToken(login) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ error: 'Заполните поля' });
    const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } });
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден. Проверь логин или зарегистрируйся.' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверный пароль' });
    await usersCol.updateOne({ login: user.login }, { $set: { lastSeen: new Date().toISOString() } });
    res.json({ success: true, login: user.login, nickname: user.nickname, token: generateToken(user.login) });
  } catch { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/me', authMw, async (req, res) => {
  const user = await usersCol.findOne({ login: req.userLogin });
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(pubUser(user));
});

app.put('/api/me', authMw, async (req, res) => {
  try {
    const b = req.body || {};
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Не найден' });
    const up = {};
    let newLogin = null;

    if (b.newLogin && b.newLogin !== user.login) {
      const err = validateLogin(b.newLogin);
      if (err) return res.status(400).json({ error: err });
      if (user.loginChangeableAt && Date.now() < new Date(user.loginChangeableAt).getTime()) return res.status(429).json({ error: 'Логин можно менять раз в день' });
      if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(b.newLogin) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
      if (await chatsCol.findOne({ login: { $regex: new RegExp('^' + escRe(b.newLogin) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
      newLogin = b.newLogin;
      up.login = b.newLogin;
      up.loginChangeableAt = new Date(Date.now() + LOGIN_COOLDOWN).toISOString();
    }
    if (b.nickname !== undefined) {
      if (!b.nickname || b.nickname.length > 30) return res.status(400).json({ error: 'Ник: 1-30' });
      up.nickname = b.nickname.trim();
    }
    if (b.newPassword) {
      if (!b.password || !(await bcrypt.compare(b.password, user.password))) return res.status(401).json({ error: 'Неверный пароль' });
      if (b.newPassword.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6' });
      up.password = await bcrypt.hash(b.newPassword, 10);
    }
    ['accentColor','nicknameColor','nicknameEmoji','nicknameEmojiColor','avatarFileId','tgChatId','dailyDigest'].forEach(k => {
      if (b[k] !== undefined) up[k] = b[k];
    });
    // М4: массивы — с валидацией
    if (b.pinnedChats !== undefined) { const v = sanitizeStringArray(b.pinnedChats); if (v) up.pinnedChats = v; }
    if (b.archivedChats !== undefined) { const v = sanitizeStringArray(b.archivedChats); if (v) up.archivedChats = v; }
    // Р: chatAliases и favorites больше не принимаем
    if (b.theme !== undefined && ALLOWED_THEMES.includes(b.theme)) up.theme = b.theme;

    if (!Object.keys(up).length) return res.json({ success: true });
    await usersCol.updateOne({ login: req.userLogin }, { $set: up });

    if (newLogin) {
      const old = req.userLogin;
      await chatsCol.updateMany({ members: old }, { $set: { 'members.$[el]': newLogin } }, { arrayFilters: [{ el: old }] });
      await chatsCol.updateMany({ admins: old }, { $set: { 'admins.$[el]': newLogin } }, { arrayFilters: [{ el: old }] });
      await chatsCol.updateMany({ owner: old }, { $set: { owner: newLogin } });
      await messagesCol.updateMany({ sender: old }, { $set: { sender: newLogin } });
      await foldersCol.updateMany({ owner: old }, { $set: { owner: newLogin } });
      const fresh = await usersCol.findOne({ login: newLogin });
      broadcast({ type: 'userUpdated', payload: pubUserShort(fresh) });
      return res.json({ success: true, newLogin, newToken: generateToken(newLogin) });
    }
    const fresh = await usersCol.findOne({ login: req.userLogin });
    broadcast({ type: 'userUpdated', payload: pubUserShort(fresh) });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/me', authMw, async (req, res) => {
  try {
    const login = req.userLogin;
    const chats = await chatsCol.find({ members: login }).toArray();
    for (const chat of chats) {
      if (chat.type === 'group' && chat.owner === login) {
        await messagesCol.deleteMany({ chatId: chat._id });
        await chatsCol.deleteOne({ _id: chat._id });
        await chatThemesCol.deleteOne({ chatId: chat._id });
      } else if (chat.type === 'group') {
        await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: login, admins: login } });
      } else {
        await messagesCol.deleteMany({ chatId: chat._id });
        await chatsCol.deleteOne({ _id: chat._id });
      }
    }
    await foldersCol.deleteMany({ owner: login });
    await usersCol.deleteOne({ login });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  USERS + SEARCH
// ============================================================
app.get('/api/users/:login', authMw, async (req, res) => {
  const login = String(req.params.login || '').trim();
  if (!login) return res.status(400).json({ error: 'Логин обязателен' });
  const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } });
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({ ...pubUserShort(user), online: clients.has(user.login) });
});

app.get('/api/search', authMw, async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '');
  if (!q) return res.json({ users: [], chats: [] });
  const regex = new RegExp(escRe(q), 'i');
  const [users, groups] = await Promise.all([
    usersCol.find({ login: { $ne: req.userLogin }, $or: [{ login: regex }, { nickname: regex }] }).limit(15).toArray(),
    chatsCol.find({ type: 'group', $or: [{ login: regex }, { name: regex }], isPrivate: { $ne: true } }).limit(15).toArray()
  ]);
  res.json({
    users: users.map(pubUserShort),
    chats: groups.map(g => ({
      id: g._id, login: g.login, name: g.name, isChannel: !!g.isChannel,
      membersCount: g.members.length, isPrivate: !!g.isPrivate,
      isMember: g.members.includes(req.userLogin),
      avatarFileId: g.avatarFileId || null
    }))
  });
});

// ============================================================
//  📜 ИСТОРИЯ ПОИСКА
// ============================================================
app.get('/api/search-history', authMw, async (req, res) => {
  const u = await usersCol.findOne({ login: req.userLogin });
  res.json((u?.searchHistory || []).slice(0, 30));
});

app.post('/api/search-history', authMw, async (req, res) => {
  try {
    const { query, type, login, name, chatId } = req.body || {};
    const item = {
      query: String(query || '').slice(0, 100),
      type: String(type || '').slice(0, 20),
      login: String(login || '').slice(0, 32),
      name: String(name || '').slice(0, 80),
      chatId: chatId || null,
      at: new Date().toISOString()
    };
    const u = await usersCol.findOne({ login: req.userLogin });
    let hist = u?.searchHistory || [];
    hist = hist.filter(h => !(h.login === item.login && h.chatId === item.chatId && h.query === item.query));
    hist.unshift(item); hist = hist.slice(0, 30);
    await usersCol.updateOne({ login: req.userLogin }, { $set: { searchHistory: hist } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/search-history', authMw, async (req, res) => {
  await usersCol.updateOne({ login: req.userLogin }, { $set: { searchHistory: [] } });
  res.json({ success: true });
});

app.delete('/api/search-history/:index', authMw, async (req, res) => {
  const idx = parseInt(req.params.index);
  const u = await usersCol.findOne({ login: req.userLogin });
  const hist = [...(u?.searchHistory || [])];
  if (idx >= 0 && idx < hist.length) hist.splice(idx, 1);
  await usersCol.updateOne({ login: req.userLogin }, { $set: { searchHistory: hist } });
  res.json({ success: true });
});

// ============================================================
//  📰 ЛЕНТА
// ============================================================
app.get('/api/feed', authMw, async (req, res) => {
  try {
    const channels = await chatsCol.find({ isChannel: true, members: req.userLogin }).toArray();
    if (!channels.length) return res.json([]);
    const ids = channels.map(c => c._id);
    const msgs = await messagesCol.find({ chatId: { $in: ids }, deleted: { $ne: true } }).sort({ timestamp: -1 }).limit(50).toArray();
    const chatMap = {}; channels.forEach(c => { chatMap[c._id] = c; });
    const result = await Promise.all(msgs.map(async m => {
      const chat = chatMap[m.chatId];
      const filesMap = await getFilesMap([m.fileId]);
      const avatarMap = await getAvatarMap([m.sender]);
      return { ...pubMessage(m, filesMap, avatarMap), channel: chat ? { id: chat._id, name: chat.name, login: chat.login, avatarFileId: chat.avatarFileId || null } : null };
    }));
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/stats', authMw, async (req, res) => {
  const [accounts, chats] = await Promise.all([usersCol.countDocuments({}), chatsCol.countDocuments({ type: 'group' })]);
  res.json({ accounts, chats, online: clients.size });
});

// ============================================================
//  📁 ПАПКИ
// ============================================================
const DEFAULT_FOLDERS = [
  { name: 'Непрочитанные', icon: '🔴', system: true, filter: 'unread', open: true, order: 0 },
  { name: 'Онлайн',        icon: '🟢', system: true, filter: 'online', open: true, order: 1 },
  { name: 'Все чаты',      icon: '🌸', system: true, filter: 'all',    open: false, order: 99 }
];
// М3: race-safe через upsert + uniqueIndex (owner+system+filter)
async function ensureDefaultFolders(login) {
  for (const f of DEFAULT_FOLDERS) {
    try {
      await foldersCol.updateOne(
        { owner: login, system: true, filter: f.filter },
        {
          $setOnInsert: {
            _id: uuidv4(), owner: login, name: f.name, icon: f.icon,
            system: true, filter: f.filter, open: !!f.open, order: f.order || 50,
            chatIds: [], createdAt: new Date().toISOString()
          }
        },
        { upsert: true }
      );
    } catch (e) {
      // duplicate key — уже создана параллельным запросом, ок
      if (e.code !== 11000) console.warn('ensureDefaultFolders:', e.message);
    }
  }
}
function pubFolder(f) {
  if (!f) return null;
  return { id: f._id, name: f.name, icon: f.icon, system: !!f.system, filter: f.filter || null, open: !!f.open, order: f.order || 0, chatIds: f.chatIds || [] };
}

app.get('/api/folders', authMw, async (req, res) => {
  try {
    await ensureDefaultFolders(req.userLogin);
    const list = await foldersCol.find({ owner: req.userLogin }).sort({ order: 1, createdAt: 1 }).toArray();
    res.json(list.map(pubFolder));
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/folders', authMw, async (req, res) => {
  try {
    const { name, icon } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Введите название' });
    const maxOrder = await foldersCol.find({ owner: req.userLogin, system: { $ne: true } }).sort({ order: -1 }).limit(1).toArray();
    const nextOrder = (maxOrder[0]?.order || 10) + 1;
    const doc = { _id: uuidv4(), owner: req.userLogin, name: name.trim().slice(0, 30), icon: (icon || '📁').trim().slice(0, 4), system: false, filter: null, open: true, order: nextOrder, chatIds: [], createdAt: new Date().toISOString() };
    await foldersCol.insertOne(doc);
    res.status(201).json(pubFolder(doc));
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});
app.put('/api/folders/:id', authMw, async (req, res) => {
  try {
    const f = await foldersCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!f) return res.status(404).json({ error: 'Папка не найдена' });
    const up = {}; const b = req.body || {};
    if (b.name !== undefined) up.name = String(b.name).trim().slice(0, 30);
    if (b.icon !== undefined) up.icon = String(b.icon).trim().slice(0, 4);
    if (b.open !== undefined) up.open = !!b.open;
    if (b.order !== undefined) up.order = parseInt(b.order) || 0;
    if (Object.keys(up).length) await foldersCol.updateOne({ _id: f._id }, { $set: up });
    const fresh = await foldersCol.findOne({ _id: f._id });
    res.json(pubFolder(fresh));
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});
app.delete('/api/folders/:id', authMw, async (req, res) => {
  try {
    const f = await foldersCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!f) return res.status(404).json({ error: 'Не найдена' });
    if (f.system) return res.status(400).json({ error: 'Системную папку нельзя удалить' });
    await foldersCol.deleteOne({ _id: f._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/folders/:id/chats', authMw, async (req, res) => {
  try {
    const { chatId } = req.body || {};
    if (!chatId) return res.status(400).json({ error: 'chatId обязателен' });
    const f = await foldersCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!f) return res.status(404).json({ error: 'Папка не найдена' });
    if (f.system) return res.status(400).json({ error: 'В системную нельзя' });
    await foldersCol.updateOne({ _id: f._id }, { $addToSet: { chatIds: chatId } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});
app.delete('/api/folders/:id/chats/:chatId', authMw, async (req, res) => {
  try {
    const f = await foldersCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!f) return res.status(404).json({ error: 'Папка не найдена' });
    await foldersCol.updateOne({ _id: f._id }, { $pull: { chatIds: req.params.chatId } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  📦 АРХИВ
// ============================================================
app.post('/api/chats/:chatId/archive', authMw, async (req, res) => {
  try {
    const { archived } = req.body || {};
    if (archived) await usersCol.updateOne({ login: req.userLogin }, { $addToSet: { archivedChats: req.params.chatId } });
    else await usersCol.updateOne({ login: req.userLogin }, { $pull: { archivedChats: req.params.chatId } });
    res.json({ success: true, archived: !!archived });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  CHATS — М2: батчинг вместо N+1
// ============================================================
app.get('/api/chats', authMw, async (req, res) => {
  try {
    const me = await usersCol.findOne({ login: req.userLogin });
    if (!me) return res.status(404).json({ error: 'Не найден' });
    const myChats = await chatsCol.find({ members: req.userLogin }).toArray();
    const archived = me.archivedChats || [];
    const pinned = me.pinnedChats || [];

    const chatIds = myChats.map(c => c._id);
    // Б2: считаем непрочитанные через readBy, а не lastSeen
    const [lastMsgs, unreadCounts] = await Promise.all([
      // по одному последнему сообщению на чат — через агрегацию
      messagesCol.aggregate([
        { $match: { chatId: { $in: chatIds }, deleted: { $ne: true } } },
        { $sort: { timestamp: -1 } },
        { $group: { _id: '$chatId', doc: { $first: '$$ROOT' } } }
      ]).toArray(),
      // счётчики непрочитанных через readBy
      messagesCol.aggregate([
        { $match: { chatId: { $in: chatIds }, sender: { $ne: req.userLogin }, deleted: { $ne: true }, readBy: { $ne: req.userLogin } } },
        { $group: { _id: '$chatId', count: { $sum: 1 } } }
      ]).toArray()
    ]);

    const lastByChat = {}; lastMsgs.forEach(x => { lastByChat[x._id] = x.doc; });
    const unreadByChat = {}; unreadCounts.forEach(x => { unreadByChat[x._id] = x.count; });

    // батч файлов и аватаров
    const fileIds = Object.values(lastByChat).map(m => m.fileId).filter(Boolean);
    const senderLogins = Object.values(lastByChat).map(m => m.sender);
    const dialogOtherLogins = myChats.filter(c => c.type !== 'group').map(c => c.members.find(u => u !== req.userLogin)).filter(Boolean);

    const [filesMap, avatarMap, dialogUsers] = await Promise.all([
      getFilesMap(fileIds),
      getAvatarMap(senderLogins),
      usersCol.find({ login: { $in: dialogOtherLogins } }).toArray()
    ]);
    const userByLogin = {}; dialogUsers.forEach(u => { userByLogin[u.login] = u; });

    const result = myChats.map(chat => {
      const isGroup = chat.type === 'group';
      let title = chat.name, otherLogin = null, otherUser = null;
      if (!isGroup) {
        otherLogin = chat.members.find(u => u !== req.userLogin);
        otherUser = otherLogin ? userByLogin[otherLogin] : null;
        title = otherUser?.nickname || otherUser?.login || '???';
      }
      const lastMsg = lastByChat[chat._id] || null;
      return {
        id: chat._id, type: chat.type || 'dialog', isGroup,
        isChannel: !!chat.isChannel, isPrivate: !!chat.isPrivate,
        isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
        name: title, login: chat.login || null,
        alias: null, // Р: chatAliases убраны
        avatarFileId: chat.avatarFileId || null,
        membersCount: chat.members.length, otherLogin,
        otherUser: otherUser ? pubUserShort(otherUser) : null,
        lastMessage: lastMsg ? pubMessage(lastMsg, filesMap, avatarMap) : null,
        unreadCount: unreadByChat[chat._id] || 0,
        pinned: pinned.includes(chat._id),
        archived: archived.includes(chat._id),
        updatedAt: chat.updatedAt || (lastMsg ? lastMsg.timestamp : chat._id)
      };
    });
    result.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats', authMw, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ error: 'Неверный логин' });
    if (login.toLowerCase() === req.userLogin.toLowerCase()) return res.status(400).json({ error: 'Нельзя добавить себя' });
    const other = await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } });
    if (!other) return res.status(404).json({ error: 'Не найден' });
    const ex = await chatsCol.findOne({ type: 'dialog', members: { $all: [req.userLogin, other.login], $size: 2 } });
    if (ex) return res.json({ success: true, chatId: ex._id, existing: true });
    const id = uuidv4();
    await chatsCol.insertOne({ _id: id, type: 'dialog', members: [req.userLogin, other.login], admins: [], owner: null, updatedAt: new Date().toISOString() });
    const c = clients.get(other.login);
    if (c?.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'chatCreated', payload: { chatId: id } }));
    res.status(201).json({ success: true, chatId: id });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/groups', authMw, async (req, res) => {
  try {
    const { name, login, members, isPrivate, published, isChannel } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60' });
    const err = validateLogin(login);
    if (err) return res.status(400).json({ error: err });
    if (await chatsCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    const arr = Array.isArray(members) ? members : [];
    const uniq = [...new Set(arr.filter(u => typeof u === 'string' && u))];
    for (const u of uniq) if (!(await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(u) + '$', 'i') } }))) return res.status(404).json({ error: `Пользователь ${u} не найден` });
    const id = uuidv4();
    const allMembers = [...new Set([req.userLogin, ...uniq])];
    await chatsCol.insertOne({ _id: id, type: 'group', isChannel: !!isChannel, name: name.trim(), login, members: allMembers, admins: [req.userLogin], owner: req.userLogin, isPrivate: !!isPrivate, published: !!published, updatedAt: new Date().toISOString() });
    const payload = JSON.stringify({ type: 'chatCreated', payload: { chatId: id } });
    allMembers.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(payload); });
    res.status(201).json({ success: true, chatId: id, login });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/chats/find/:login', authMw, async (req, res) => {
  const login = String(req.params.login || '').trim();
  const chat = await chatsCol.findOne({ type: 'group', login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } });
  if (!chat) return res.status(404).json({ error: 'Не найдено' });
  if (chat.isPrivate && !chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Приватный' });
  res.json({ id: chat._id, login: chat.login, name: chat.name, isChannel: !!chat.isChannel, membersCount: chat.members.length, isPrivate: !!chat.isPrivate, isMember: chat.members.includes(req.userLogin), published: !!chat.published, avatarFileId: chat.avatarFileId || null });
});

app.post('/api/chats/:chatId/join', authMw, async (req, res) => {
  const chat = await chatsCol.findOne({ _id: req.params.chatId });
  if (!chat) return res.status(404).json({ error: 'Не найдено' });
  if (chat.members.includes(req.userLogin)) return res.json({ success: true });
  if (chat.isPrivate) return res.status(403).json({ error: 'Приватный' });
  await chatsCol.updateOne({ _id: chat._id }, { $push: { members: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
  const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, login: req.userLogin } });
  [...chat.members, req.userLogin].forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

app.post('/api/chats/:chatId/leave', authMw, async (req, res) => {
  const chat = await chatsCol.findOne({ _id: req.params.chatId });
  if (!chat) return res.status(404).json({ error: 'Не найдено' });
  if (chat.owner === req.userLogin) return res.status(400).json({ error: 'Владелец не может выйти' });
  await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: req.userLogin, admins: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
  const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, login: req.userLogin } });
  chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

// М5: при удалении чата — чистим filesCol
app.delete('/api/chats/:chatId', authMw, async (req, res) => {
  const chat = await chatsCol.findOne({ _id: req.params.chatId });
  if (!chat) return res.status(404).json({ error: 'Не найдено' });
  if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
  if (chat.type === 'group' && chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });
  const msgs = await messagesCol.find({ chatId: chat._id }, { projection: { fileId: 1 } }).toArray();
  const fileIds = msgs.map(m => m.fileId).filter(Boolean);
  if (fileIds.length) await filesCol.deleteMany({ _id: { $in: fileIds }, purpose: 'file' });
  await messagesCol.deleteMany({ chatId: chat._id });
  await chatsCol.deleteOne({ _id: chat._id });
  await chatThemesCol.deleteOne({ chatId: chat._id });
  await foldersCol.updateMany({ owner: req.userLogin }, { $pull: { chatIds: chat._id } });
  const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId: chat._id } });
  chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

app.delete('/api/chats/:chatId/messages', authMw, requireChatMember, async (req, res) => {
  const isAdmin = (req.chat.admins || []).includes(req.userLogin) || req.chat.owner === req.userLogin;
  const isDialog = req.chat.type === 'dialog';
  if (!isDialog && !isAdmin) return res.status(403).json({ error: 'Только админ' });
  const msgs = await messagesCol.find({ chatId: req.chat._id }, { projection: { fileId: 1 } }).toArray();
  const fileIds = msgs.map(m => m.fileId).filter(Boolean);
  if (fileIds.length) await filesCol.deleteMany({ _id: { $in: fileIds }, purpose: 'file' });
  await messagesCol.deleteMany({ chatId: req.chat._id });
  await chatsCol.updateOne({ _id: req.chat._id }, { $set: { updatedAt: new Date().toISOString() } });
  const out = JSON.stringify({ type: 'chatCleared', payload: { chatId: req.chat._id } });
  req.chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

app.get('/api/chats/:chatId/search', authMw, requireChatMember, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    const regex = new RegExp(escRe(q), 'i');
    const msgs = await messagesCol.find({ chatId: req.chat._id, deleted: { $ne: true }, text: regex }).sort({ timestamp: -1 }).limit(100).toArray();
    res.json(await pubMessagesList(msgs));
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/chats/:chatId/info', authMw, requireChatMember, async (req, res) => {
  const chat = req.chat;
  const members = await Promise.all(chat.members.map(async l => {
    const u = await usersCol.findOne({ login: l });
    return u ? { ...pubUserShort(u), isAdmin: (chat.admins || []).includes(l), isOwner: chat.owner === l, online: clients.has(l) } : null;
  }));
  res.json({
    id: chat._id, type: chat.type || 'dialog', isChannel: !!chat.isChannel,
    members: chat.members, admins: chat.admins || [], owner: chat.owner || null,
    name: chat.name || null, login: chat.login || null, avatarFileId: chat.avatarFileId || null,
    isPrivate: !!chat.isPrivate, published: !!chat.published,
    membersInfo: members.filter(Boolean),
    isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
    isOwner: chat.owner === req.userLogin
  });
});

app.put('/api/chats/:chatId/name', authMw, requireChatMember, requireChatAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60' });
  await chatsCol.updateOne({ _id: req.chat._id }, { $set: { name: name.trim(), updatedAt: new Date().toISOString() } });
  const out = JSON.stringify({ type: 'chatRenamed', payload: { chatId: req.chat._id, name: name.trim() } });
  req.chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

app.put('/api/chats/:chatId/login', authMw, requireChatMember, requireChatAdmin, async (req, res) => {
  const { login } = req.body || {};
  const err = validateLogin(login);
  if (err) return res.status(400).json({ error: err });
  if (await chatsCol.findOne({ _id: { $ne: req.chat._id }, login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
  if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
  await chatsCol.updateOne({ _id: req.chat._id }, { $set: { login, updatedAt: new Date().toISOString() } });
  res.json({ success: true, login });
});

app.put('/api/chats/:chatId/flags', authMw, requireChatMember, async (req, res) => {
  if (req.chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });
  const { isPrivate, published } = req.body || {};
  const up = { updatedAt: new Date().toISOString() };
  if (isPrivate !== undefined) up.isPrivate = !!isPrivate;
  if (published !== undefined) up.published = !!published;
  await chatsCol.updateOne({ _id: req.chat._id }, { $set: up });
  res.json({ success: true });
});

app.delete('/api/chats/:chatId/members/:login', authMw, requireChatMember, requireChatAdmin, async (req, res) => {
  const target = req.params.login;
  if (target === req.chat.owner) return res.status(400).json({ error: 'Владельца нельзя' });
  await chatsCol.updateOne({ _id: req.chat._id }, { $pull: { members: target, admins: target }, $set: { updatedAt: new Date().toISOString() } });
  const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: req.chat._id, login: target } });
  req.chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

app.post('/api/chats/:chatId/members', authMw, requireChatMember, requireChatAdmin, async (req, res) => {
  const { login } = req.body || {};
  if (!login) return res.status(400).json({ error: 'Неверный логин' });
  if (req.chat.members.includes(login)) return res.status(400).json({ error: 'Уже участник' });
  const user = await usersCol.findOne({ login });
  if (!user) return res.status(404).json({ error: 'Не найден' });
  await chatsCol.updateOne({ _id: req.chat._id }, { $push: { members: login }, $set: { updatedAt: new Date().toISOString() } });
  const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: req.chat._id, login, nickname: user.nickname } });
  [...req.chat.members, login].forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

app.put('/api/chats/:chatId/members/:login/admin', authMw, requireChatMember, requireChatAdmin, async (req, res) => {
  const target = req.params.login;
  if (target === req.chat.owner) return res.status(400).json({ error: 'Владельца нельзя снять' });
  const isAdmin = (req.chat.admins || []).includes(target);
  if (isAdmin) await chatsCol.updateOne({ _id: req.chat._id }, { $pull: { admins: target } });
  else await chatsCol.updateOne({ _id: req.chat._id }, { $addToSet: { admins: target } });
  const out = JSON.stringify({ type: 'adminChanged', payload: { chatId: req.chat._id, login: target, isAdmin: !isAdmin } });
  req.chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true, isAdmin: !isAdmin });
});

app.get('/api/chats/:chatId/theme', authMw, requireChatMember, async (req, res) => {
  const t = await chatThemesCol.findOne({ chatId: req.params.chatId });
  res.json(t || null);
});

app.put('/api/chats/:chatId/theme', authMw, requireChatMember, requireChatAdmin, async (req, res) => {
  const theme = req.body || {};
  await chatThemesCol.updateOne({ chatId: req.params.chatId }, { $set: { chatId: req.params.chatId, theme, updatedAt: new Date().toISOString() } }, { upsert: true });
  const out = JSON.stringify({ type: 'chatThemeChanged', payload: { chatId: req.params.chatId, theme } });
  req.chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});

app.delete('/api/chats/:chatId/theme', authMw, requireChatMember, requireChatAdmin, async (req, res) => {
  await chatThemesCol.deleteOne({ chatId: req.params.chatId });
  const out = JSON.stringify({ type: 'chatThemeChanged', payload: { chatId: req.params.chatId, theme: null } });
  req.chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  res.json({ success: true });
});
// ============================================================
//  MESSAGES
// ============================================================
app.get('/api/chats/:chatId/messages', authMw, requireChatMember, async (req, res) => {
  const msgs = await messagesCol.find({ chatId: req.chat._id, deleted: { $ne: true } }).sort({ timestamp: 1 }).limit(500).toArray();
  await usersCol.updateOne({ login: req.userLogin }, { $set: { lastSeen: new Date().toISOString() } });
  await markReadForUser(req.chat._id, req.userLogin, msgs);
  res.json(await pubMessagesList(msgs));
});

async function markReadForUser(chatId, login, msgs) {
  try {
    const toUpdate = msgs.filter(m => m.sender !== login && !(m.readBy || []).includes(login));
    if (!toUpdate.length) return;
    const ids = toUpdate.map(m => m._id);
    await messagesCol.updateMany({ _id: { $in: ids } }, { $addToSet: { readBy: login, deliveredTo: login } });
    const bySender = {};
    toUpdate.forEach(m => { bySender[m.sender] = bySender[m.sender] || []; bySender[m.sender].push(m._id); });
    for (const sender in bySender) {
      const ws = clients.get(sender);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'messagesRead', payload: { chatId, byLogin: login, messageIds: bySender[sender] } }));
    }
  } catch (e) { console.warn('markRead:', e); }
}

app.post('/api/chats/:chatId/messages', authMw, async (req, res) => {
  const { text, clientId, replyTo, fileId, forwardFrom } = req.body || {};
  const r = await processNewMessage(req.params.chatId, req.userLogin, text, clientId, replyTo, fileId, forwardFrom);
  if (r.error) return res.status(r.code || 400).json({ error: r.error });
  res.status(201).json(r.message);
});

// GET сообщения по ID (для deep-link)
app.get('/api/messages/:id', authMw, async (req, res) => {
  try {
    const msg = await messagesCol.findOne({ _id: req.params.id });
    if (!msg || msg.deleted) return res.status(404).json({ error: 'Сообщение не найдено' });
    const chat = await chatsCol.findOne({ _id: msg.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    const isMember = chat.members.includes(req.userLogin);
    const filesMap = await getFilesMap([msg.fileId]);
    const avatarMap = await getAvatarMap([msg.sender]);
    res.json({
      chatId: msg.chatId,
      chatName: chat.type === 'group' ? chat.name : null,
      chatLogin: chat.login || null,
      isGroup: chat.type === 'group',
      isChannel: !!chat.isChannel,
      isPrivate: !!chat.isPrivate,
      published: !!chat.published,
      isMember,
      message: isMember ? pubMessage(msg, filesMap, avatarMap) : null,
      preview: (msg.text || '').slice(0, 200),
      sender: msg.sender,
      senderName: msg.senderName,
      timestamp: msg.timestamp
    });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

// PUT — редактирование (текст + файл, 48ч, только автор)
app.put('/api/messages/:id', authMw, async (req, res) => {
  try {
    const msg = await messagesCol.findOne({ _id: req.params.id });
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.deleted) return res.status(400).json({ error: 'Сообщение удалено' });
    if (msg.sender !== req.userLogin) return res.status(403).json({ error: 'Только автор может редактировать' });
    const age = Date.now() - new Date(msg.timestamp).getTime();
    if (age > EDIT_WINDOW_MS) return res.status(403).json({ error: 'Прошло больше 48 часов — редактирование недоступно' });
    if (msg.forwardFrom && msg.forwardFrom.login) return res.status(400).json({ error: 'Нельзя редактировать пересланные' });

    const b = req.body || {};
    const up = { editedAt: new Date().toISOString() };

    if (b.text !== undefined) {
      const t = String(b.text || '').trim();
      if (t.length > MAX_MSG_LEN) return res.status(400).json({ error: 'Слишком длинное сообщение' });
      up.text = t;
    }
    if (b.removeFile === true) {
      // М5-стиль: старый файл удаляем из filesCol (purpose:'file')
      if (msg.fileId) await filesCol.deleteOne({ _id: msg.fileId, purpose: 'file' }).catch(() => {});
      up.fileId = null;
      up.type = 'text';
    } else if (b.fileId) {
      const f = await filesCol.findOne({ _id: b.fileId });
      if (!f) return res.status(404).json({ error: 'Файл не найден' });
      if (f.uploader !== req.userLogin) return res.status(403).json({ error: 'Можно прикрепить только свой файл' });
      // Если заменяем — старый удаляем
      if (msg.fileId && msg.fileId !== b.fileId) await filesCol.deleteOne({ _id: msg.fileId, purpose: 'file' }).catch(() => {});
      up.fileId = b.fileId;
      up.type = 'file';
    }
    const finalText = up.text !== undefined ? up.text : (msg.text || '');
    const finalFileId = up.fileId !== undefined ? up.fileId : msg.fileId;
    if (!finalText && !finalFileId) return res.status(400).json({ error: 'Сообщение пустое' });

    await messagesCol.updateOne({ _id: msg._id }, { $set: up });

    const fresh = await messagesCol.findOne({ _id: msg._id });
    const filesMap = await getFilesMap([fresh.fileId]);
    const avatarMap = await getAvatarMap([fresh.sender]);
    const pub = pubMessage(fresh, filesMap, avatarMap);

    const chat = await chatsCol.findOne({ _id: fresh.chatId });
    if (chat) {
      const out = JSON.stringify({ type: 'messageEdited', payload: { messageId: fresh._id, chatId: fresh.chatId, text: fresh.text, file: pub.file, editedAt: fresh.editedAt } });
      chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
    }
    res.json({ success: true, message: pub, editedAt: fresh.editedAt });
  } catch (e) { console.error('edit:', e); res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  PROCESS NEW MESSAGE
// ============================================================
async function processNewMessage(chatId, sender, text, clientId, replyTo, fileId, forwardFrom) {
  if (!chatId || (!text && !fileId)) return { error: 'Пустое', code: 400 };
  const t = (text || '').trim();
  if (t.length > MAX_MSG_LEN) return { error: 'Слишком длинное', code: 400 };
  const chat = await chatsCol.findOne({ _id: chatId });
  if (!chat) return { error: 'Чат не найден', code: 404 };
  if (!chat.members.includes(sender)) return { error: 'Вы не участник', code: 403 };
  if (chat.isChannel && !(chat.admins || []).includes(sender) && chat.owner !== sender) return { error: 'В канале пишут только админы', code: 403 };
  const user = await usersCol.findOne({ login: sender });
  if (!user) return { error: 'Не найден', code: 404 };

  const msgId = clientId || uuidv4();
  if (clientId) {
    const dup = await messagesCol.findOne({ _id: msgId });
    if (dup) return { message: pubMessage(dup, await getFilesMap([dup.fileId]), await getAvatarMap([dup.sender])), duplicate: true };
  }

  let validReply = null;
  if (replyTo) {
    const p = await messagesCol.findOne({ _id: replyTo, chatId, deleted: { $ne: true } });
    if (p) validReply = p._id;
  }

  let validForward = null;
  if (forwardFrom && forwardFrom.login) {
    validForward = {
      login: String(forwardFrom.login).slice(0, 64),
      name: String(forwardFrom.name || forwardFrom.login).slice(0, 64),
      messageId: forwardFrom.messageId ? String(forwardFrom.messageId).slice(0, 64) : null
    };
  }

  const deliveredTo = chat.members.filter(u => u !== sender && clients.has(u));
  const timestamp = new Date().toISOString();
  const doc = {
    _id: msgId, clientId: clientId || null, chatId,
    sender, senderName: user.nickname || user.login,
    senderEmoji: user.nicknameEmoji || '', senderEmojiColor: user.nicknameEmojiColor || '',
    type: fileId ? 'file' : 'text',
    text: t, fileId: fileId || null,
    reactions: [], deliveredTo, readBy: [],
    timestamp, replyTo: validReply, forwardFrom: validForward,
    editedAt: null, deleted: false
  };
  await messagesCol.insertOne(doc);
  await chatsCol.updateOne({ _id: chatId }, { $set: { updatedAt: timestamp } });
  await usersCol.updateOne({ login: sender }, { $set: { lastSeen: timestamp } });

  const filesMap = await getFilesMap([fileId]);
  const avatarMap = { [sender]: user.avatarFileId || null };
  const pub = pubMessage(doc, filesMap, avatarMap);
  const out = JSON.stringify({ type: 'newMessage', payload: pub });
  chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  notifyChat(chat, sender, pub);
  return { message: pub };
}

const ALLOWED_REACTIONS = ['yahoo','victory','tongue','sarcasm','cray2','facepalm'];

async function toggleReaction(messageId, emoji, login) {
  if (!ALLOWED_REACTIONS.includes(emoji)) return { error: 'Недопустимая' };
  const msg = await messagesCol.findOne({ _id: messageId, deleted: { $ne: true } });
  if (!msg) return { error: 'Не найдено' };
  const chat = await chatsCol.findOne({ _id: msg.chatId });
  if (!chat || !chat.members.includes(login)) return { error: 'Нет доступа' };

  const reactions = (msg.reactions || []).map(r => ({ emoji: r.emoji, logins: [...r.logins] }));
  let idx = reactions.findIndex(r => r.emoji === emoji);
  if (idx === -1) reactions.push({ emoji, logins: [login] });
  else {
    const l = reactions[idx].logins;
    if (l.includes(login)) { reactions[idx].logins = l.filter(x => x !== login); if (!reactions[idx].logins.length) reactions.splice(idx, 1); }
    else reactions[idx].logins.push(login);
  }
  await messagesCol.updateOne({ _id: messageId }, { $set: { reactions } });
  const filesMap = await getFilesMap([msg.fileId]);
  const avatarMap = await getAvatarMap([msg.sender]);
  const fresh = await messagesCol.findOne({ _id: messageId });
  const pub = pubMessage(fresh, filesMap, avatarMap);
  const out = JSON.stringify({ type: 'messageReaction', payload: pub });
  chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  return { success: true };
}

// ============================================================
//  FILES
// ============================================================
function guessKind(mime) {
  if (!mime) return 'doc';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'doc';
}
function buildCaption({ num, cat, uploader, nick, chatName, size, mime, filename }) {
  const lines = [`#${String(num).padStart(4, '0')} · #${cat}`];
  lines.push(`👤 @${uploader}${nick && nick !== uploader ? ' · ' + nick : ''}`);
  if (chatName) lines.push(`💬 ${chatName}`);
  const s = !size ? '0 Б' : size < 1024 ? size + ' Б' : size < 1048576 ? (size / 1024).toFixed(1) + ' КБ' : (size / 1048576).toFixed(2) + ' МБ';
  lines.push(`📦 ${s} · ${mime || 'unknown'}`);
  lines.push(`📁 ${filename}`);
  return lines.join('\n');
}
async function sendTG(buffer, filename, mimetype, caption) {
  const stream = Readable.from(buffer);
  const msg = await tgBot.sendDocument(TG_CHAT_ID, stream, { caption }, { filename, contentType: mimetype || 'application/octet-stream' });
  const fileId = msg.document?.file_id || msg.video?.file_id || msg.audio?.file_id || msg.voice?.file_id || msg.animation?.file_id || (msg.photo?.[msg.photo.length - 1]?.file_id);
  if (!fileId) throw new Error('Telegram без file_id');
  return fileId;
}

app.post('/api/upload', authMw, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Отправлять файл не более 20 мб' });
      return res.status(400).json({ error: 'Ошибка загрузки' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Загрузка недоступна' });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const { chatId, clientId, replyTo, purpose } = req.body || {};
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const { originalname, mimetype, size, buffer } = req.file;
    const num = await nextNum();

    if (purpose === 'avatar') {
      const filename = `avatar-${req.userLogin}.jpg`;
      const cap = buildCaption({ num, cat: 'avatar', uploader: req.userLogin, nick: user.nickname, size, mime: mimetype, filename });
      const tgFileId = await sendTG(buffer, filename, mimetype, cap);
      const fileId = uuidv4();
      await filesCol.insertOne({ _id: fileId, tgFileId, name: filename, size, mime: mimetype, kind: 'image', uploader: req.userLogin, purpose: 'avatar', uploadedAt: new Date().toISOString() });
      // Старые аватары чистим (кроме последнего)
      if (user.avatarFileId && user.avatarFileId !== fileId) {
        await filesCol.deleteOne({ _id: user.avatarFileId, purpose: 'avatar' }).catch(() => {});
      }
      await usersCol.updateOne({ login: req.userLogin }, { $set: { avatarFileId: fileId } });
      return res.json({ success: true, fileId });
    }

    if (purpose === 'wallpaper') {
      const filename = originalname || `wallpaper-${num}.jpg`;
      const cap = buildCaption({ num, cat: 'wallpaper', uploader: req.userLogin, nick: user.nickname, size, mime: mimetype, filename });
      const tgFileId = await sendTG(buffer, filename, mimetype, cap);
      const fileId = uuidv4();
      await filesCol.insertOne({ _id: fileId, tgFileId, name: filename, size, mime: mimetype, kind: 'image', uploader: req.userLogin, purpose, uploadedAt: new Date().toISOString() });
      return res.json({ success: true, fileId, name: filename });
    }

    if (purpose === 'edit_file') {
      const filename = originalname || `edit-${num}`;
      const cap = buildCaption({ num, cat: 'file', uploader: req.userLogin, nick: user.nickname, size, mime: mimetype, filename });
      let tgFileId;
      try { tgFileId = await sendTG(buffer, filename, mimetype, cap); }
      catch (e) { return res.status(502).json({ error: 'Telegram: ' + (e.response?.body?.description || e.message) }); }
      const fileId = uuidv4();
      const kind = guessKind(mimetype);
      await filesCol.insertOne({ _id: fileId, tgFileId, name: filename, size, mime: mimetype, kind, uploader: req.userLogin, purpose: 'file', uploadedAt: new Date().toISOString() });
      return res.json({ success: true, fileId, name: filename, size, mime: mimetype, kind });
    }

    if (!chatId) return res.status(400).json({ error: 'Не указан чат' });
    const chat = await chatsCol.findOne({ _id: chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });

    const chatName = chat.type === 'group' ? (chat.name + (chat.login ? ' · @' + chat.login : '')) : null;
    const cap = buildCaption({ num, cat: 'file', uploader: req.userLogin, nick: user.nickname, chatName, size, mime: mimetype, filename: originalname });

    let tgFileId;
    try { tgFileId = await sendTG(buffer, originalname, mimetype, cap); }
    catch (e) { return res.status(502).json({ error: 'Telegram: ' + (e.response?.body?.description || e.message) }); }

    const fileId = uuidv4();
    const kind = guessKind(mimetype);
    await filesCol.insertOne({ _id: fileId, tgFileId, name: originalname, size, mime: mimetype, kind, uploader: req.userLogin, purpose: 'file', uploadedAt: new Date().toISOString() });

    const r = await processNewMessage(chatId, req.userLogin, '', clientId, replyTo, fileId, null);
    if (r.error) return res.status(500).json({ error: r.error });
    res.status(201).json(r.message);
  } catch (e) { console.error('upload:', e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// М1: убран fallback на сырой tgFileId — только через _id из filesCol
app.get('/api/file/:fileId', authMw, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Недоступно' });
    const idParam = req.params.fileId;
    const f = await filesCol.findOne({ _id: idParam });
    if (!f) return res.status(404).json({ error: 'Файл не найден' });

    // Проверка доступа: если это файл сообщения — только участники чата
    if (f.purpose === 'file') {
      const msg = await messagesCol.findOne({ fileId: f._id });
      if (msg) {
        const chat = await chatsCol.findOne({ _id: msg.chatId });
        if (!chat?.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
      }
    }
    // Аватар/обои — публичные (для отображения в списках)

    let url;
    try { url = await tgBot.getFileLink(f.tgFileId); }
    catch { return res.status(404).json({ error: 'Файл недоступен в TG' }); }
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Telegram недоступен' });
    const ct = r.headers.get('content-type') || f.mime || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`);
    const cl = r.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  THEMES (личные)
// ============================================================
app.get('/api/themes', authMw, async (req, res) => {
  const list = await themesCol.find({ owner: req.userLogin }).sort({ createdAt: -1 }).toArray();
  res.json(list);
});
app.post('/api/themes', authMw, async (req, res) => {
  const { name, data } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Введи название' });
  const doc = { _id: uuidv4(), owner: req.userLogin, name: name.trim().slice(0, 60), data: data || {}, createdAt: new Date().toISOString() };
  await themesCol.insertOne(doc);
  res.json(doc);
});
app.delete('/api/themes/:id', authMw, async (req, res) => {
  await themesCol.deleteOne({ _id: req.params.id, owner: req.userLogin });
  res.json({ success: true });
});

// ============================================================
//  TG LINK
// ============================================================
app.post('/api/tg/link', authMw, async (req, res) => {
  if (!tgBot) return res.status(503).json({ error: 'Telegram недоступен' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await tgLinksCol.deleteMany({ login: req.userLogin });
  await tgLinksCol.insertOne({ login: req.userLogin, code, expiresAt, createdAt: new Date().toISOString() });
  const botInfo = await tgBot.getMe();
  res.json({ success: true, code, botUsername: botInfo.username, expiresAt });
});
app.post('/api/tg/unlink', authMw, async (req, res) => {
  await usersCol.updateOne({ login: req.userLogin }, { $set: { tgChatId: null } });
  res.json({ success: true });
});

// ============================================================
//  NOTIFY CHAT
// ============================================================
function notifyChat(chat, senderLogin, msg) {
  if (!tgBot) return;
  (async () => {
    try {
      let preview = msg.text || '';
      if (msg.type === 'file' && msg.file) preview = '📎 ' + msg.file.name;
      if (preview.length > 200) preview = preview.slice(0, 197) + '…';
      const chatName = chat.type === 'group' ? chat.name : null;
      for (const u of chat.members) {
        if (u === senderLogin) continue;
        const recipient = await usersCol.findOne({ login: u });
        if (!recipient?.tgChatId) continue;
        if (recipient.mutedUntil && new Date(recipient.mutedUntil).getTime() > Date.now()) continue;
        const ws = clients.get(u);
        if (ws?.currentChatId === chat._id) continue;
        const title = chatName ? `${chatName} · @${senderLogin}` : `@${senderLogin}`;
        const link = `${BASE_URL}/?chat=${chat._id}`;
        try {
          await tgBot.sendMessage(recipient.tgChatId, `💬 <b>${escHtml(title)}</b>\n\n<blockquote>${escHtml(preview)}</blockquote>\n\n<i><u><a href="${link}">Открыть</a></u></i>`, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (e) {
          if (e.response?.body?.error_code === 403) await usersCol.updateOne({ login: u }, { $set: { tgChatId: null } });
        }
      }
    } catch (e) { console.warn('notify:', e.message); }
  })();
}

// ============================================================
//  BOT COMMANDS
// ============================================================
async function findUserByTg(chatId) { return await usersCol.findOne({ tgChatId: chatId }); }

async function handleBotPrivateMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const startMatch = text.match(/^\/start(?:\s+(.+))?/);
  if (startMatch) {
    const code = (startMatch[1] || '').trim();
    if (code) {
      try {
        const link = await tgLinksCol.findOne({ code, expiresAt: { $gt: new Date().toISOString() } });
        if (!link) { await tgBot.sendMessage(chatId, '❌ Ссылка устарела.'); return; }
        await usersCol.updateOne({ login: link.login }, { $set: { tgChatId: chatId } });
        await tgLinksCol.deleteOne({ _id: link._id });
        await tgBot.sendMessage(chatId, `✅ Готово! Аккаунт <b>@${link.login}</b> привязан.`, { parse_mode: 'HTML' });
        return;
      } catch { await tgBot.sendMessage(chatId, '❌ Ошибка привязки'); return; }
    }
    await sendMainMenu(chatId);
    return;
  }
  if (msg.document || msg.photo || msg.video || msg.audio || msg.voice || msg.video_note) {
    const user = await findUserByTg(chatId);
    if (!user) { await tgBot.sendMessage(chatId, '❌ Сначала привяжи аккаунт.'); return; }
    await handleBotFile(chatId, msg, user);
    return;
  }
  if (!text) return;
  if (text.startsWith('/help')) { await sendMainMenu(chatId); return; }
  if (text === '/mute') { const user = await findUserByTg(chatId); if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.'); await usersCol.updateOne({ login: user.login }, { $set: { mutedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() } }); return tgBot.sendMessage(chatId, '🔕 Уведомления отключены на 24 часа.'); }
  if (text === '/unmute') { const user = await findUserByTg(chatId); if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.'); await usersCol.updateOne({ login: user.login }, { $set: { mutedUntil: null } }); return tgBot.sendMessage(chatId, '🔔 Уведомления включены.'); }
  if (text.startsWith('/find')) { const q = text.replace(/^\/find\s*/, '').trim().replace(/^@/, ''); if (!q) return tgBot.sendMessage(chatId, 'Использование: /find логин'); return cmdFind(chatId, q); }
  if (text === '/stats') { const user = await findUserByTg(chatId); if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.'); return cmdStats(chatId); }
  if (text.startsWith('/post')) { const user = await findUserByTg(chatId); if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.'); const m = text.match(/^\/post\s+\[([^\]]+)\]\s*([\s\S]+)/); if (!m) return tgBot.sendMessage(chatId, 'Использование: /post [Канал] Текст'); return cmdPost(chatId, user.login, m[1].trim(), m[2].trim()); }
}

async function sendMainMenu(chatId) {
  const user = await findUserByTg(chatId);
  const greeting = user ? `Привет, <b>@${user.login}</b>!` : 'Привет!';
  const text = `🌸 <b>Криста.Net</b>\n\n${greeting}\n\n📊 /stats — статистика\n🔍 /find логин — найти юзера\n📢 /post [Канал] Текст\n🔔 /mute · /unmute\n\n📎 Отправь файл — прилетит в чат\n\n💬 @${SUPPORT_TG}`;
  const kb = { inline_keyboard: [[{ text: '📊 Статистика', callback_data: 'stats' }], [{ text: '💬 Поддержка', url: `https://t.me/${SUPPORT_TG}` }]] };
  await tgBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
}

async function cmdFind(chatId, login) {
  const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escRe(login) + '$', 'i') } });
  if (!user) return tgBot.sendMessage(chatId, `❌ @${login} не найден.`);
  const isOnline = clients.has(user.login);
  const status = isOnline ? '🟢 онлайн' : `⚪ ${timeAgo(user.lastSeen) || 'офлайн'}`;
  const nick = user.nicknameEmoji ? `${user.nicknameEmoji} ${user.nickname}` : user.nickname;
  const caption = `<b>${escHtml(nick)}</b>\n@${escHtml(user.login)}\n\n${status}`;
  const kb = { inline_keyboard: [[{ text: '🔗 Открыть', url: `${BASE_URL}/?user=${user.login}` }]] };
  if (user.avatarFileId) {
    try {
      const f = await filesCol.findOne({ _id: user.avatarFileId });
      const link = f ? await tgBot.getFileLink(f.tgFileId) : null;
      if (link) return tgBot.sendPhoto(chatId, link, { caption, parse_mode: 'HTML', reply_markup: kb });
    } catch {}
  }
  await tgBot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: kb });
}

function timeAgo(iso) {
  try {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'только что';
    if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
    return `${Math.floor(diff / 86400)} дн назад`;
  } catch { return ''; }
}

async function cmdStats(chatId) {
  try {
    const [accounts, messagesTotal, channels, chats] = await Promise.all([
      usersCol.countDocuments({}),
      messagesCol.countDocuments({ deleted: { $ne: true } }),
      chatsCol.countDocuments({ type: 'group', isChannel: true, published: true, isPrivate: { $ne: true } }),
      chatsCol.countDocuments({ type: 'group', isChannel: { $ne: true }, published: true, isPrivate: { $ne: true } })
    ]);
    const text = `📊 <b>Статистика</b>\n\n👥 Юзеров: <b>${accounts}</b>\n💬 Сообщений: <b>${messagesTotal}</b>\n📢 Каналов: <b>${channels}</b>\n💬 Чатов: <b>${chats}</b>\n🟢 Онлайн: <b>${clients.size}</b>`;
    await tgBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch { await tgBot.sendMessage(chatId, '❌ Ошибка статистики.'); }
}

async function cmdPost(chatId, login, channelName, text) {
  const channels = await chatsCol.find({ owner: login, isChannel: true }).toArray();
  if (!channels.length) return tgBot.sendMessage(chatId, '❌ У тебя нет своих каналов.');
  const channel = channels.find(c => c.name.toLowerCase() === channelName.toLowerCase());
  if (!channel) { const list = channels.map(c => `• ${c.name}`).join('\n'); return tgBot.sendMessage(chatId, `❌ Канал «${channelName}» не найден.\n\n${list}`); }
  const user = await usersCol.findOne({ login });
  const timestamp = new Date().toISOString();
  const doc = { _id: uuidv4(), chatId: channel._id, sender: login, senderName: user.nickname || login, senderEmoji: user.nicknameEmoji || '', senderEmojiColor: user.nicknameEmojiColor || '', type: 'text', text: text.slice(0, MAX_MSG_LEN), fileId: null, reactions: [], deliveredTo: [], readBy: [], timestamp, replyTo: null, editedAt: null, deleted: false, fromBot: true };
  await messagesCol.insertOne(doc);
  await chatsCol.updateOne({ _id: channel._id }, { $set: { updatedAt: timestamp } });
  const pub = pubMessage(doc, {}, { [login]: user.avatarFileId || null });
  const out = JSON.stringify({ type: 'newMessage', payload: pub });
  channel.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
  await tgBot.sendMessage(chatId, `✅ Опубликовано в <b>${escHtml(channel.name)}</b>`, { parse_mode: 'HTML' });
  notifyChat(channel, login, pub);
}

async function handleBotFile(chatId, msg, user) {
  try {
    const file = msg.document || msg.video || msg.audio || (msg.photo ? msg.photo[msg.photo.length - 1] : null) || msg.voice || msg.video_note;
    if (!file) return;
    if (file.file_size && file.file_size > MAX_FILE_SIZE) return tgBot.sendMessage(chatId, `❌ Файл больше 20 МБ.`);
    const chats = await chatsCol.find({ members: user.login, isChannel: { $ne: true } }).limit(10).toArray();
    if (!chats.length) return tgBot.sendMessage(chatId, '❌ У тебя нет чатов.');
    const sess = { _id: 'tg:' + chatId, action: 'upload_file', data: { fileId: file.file_id, fileUniqueId: file.file_unique_id, fileName: file.file_name || 'file', mimeType: file.mime_type || 'application/octet-stream', fileSize: file.file_size || 0 }, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
    await botSessionsCol.updateOne({ _id: sess._id }, { $set: sess }, { upsert: true });
    const kb = { inline_keyboard: [] };
    for (const c of chats.slice(0, 8)) {
      const otherLogin = c.type === 'dialog' ? c.members.find(u => u !== user.login) : null;
      const otherUser = otherLogin ? await usersCol.findOne({ login: otherLogin }) : null;
      const name = c.type === 'group' ? c.name : (otherUser?.nickname || otherLogin || '?');
      kb.inline_keyboard.push([{ text: `💬 ${name}`.slice(0, 60), callback_data: `chat_select_${c._id}` }]);
    }
    kb.inline_keyboard.push([{ text: '✕ Отмена', callback_data: 'cancel' }]);
    await tgBot.sendMessage(chatId, `📎 Куда отправить <b>${escHtml(file.file_name || 'файл')}</b>?`, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) { console.warn('handleBotFile:', e); }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data || '';
  if (data === 'menu') { try { await tgBot.answerCallbackQuery(cb.id); } catch {} await sendMainMenu(chatId); return; }
  if (data === 'stats') { try { await tgBot.answerCallbackQuery(cb.id); } catch {} return cmdStats(chatId); }
  let m = data.match(/^chat_select_(.+)$/);
  if (m) {
    const targetChatId = m[1];
    try { await tgBot.answerCallbackQuery(cb.id, { text: 'Загружаю...' }); } catch {}
    const sess = await botSessionsCol.findOne({ _id: 'tg:' + chatId, action: 'upload_file' });
    if (!sess) return tgBot.sendMessage(chatId, '❌ Сессия истекла.');
    const user = await findUserByTg(chatId);
    if (!user) { await botSessionsCol.deleteOne({ _id: sess._id }); return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.'); }
    const chat = await chatsCol.findOne({ _id: targetChatId });
    if (!chat || !chat.members.includes(user.login)) { await botSessionsCol.deleteOne({ _id: sess._id }); return tgBot.sendMessage(chatId, '❌ Нет доступа.'); }
    try {
      let link; try { link = await tgBot.getFileLink(sess.data.fileId); } catch { throw new Error('Файл недоступен (возможно, >20 МБ)'); }
      const r = await fetch(link); if (!r.ok) throw new Error('Telegram недоступен');
      const buffer = Buffer.from(await r.arrayBuffer());
      const num = await nextNum();
      const filename = sess.data.fileName || `file-${num}`;
      const chatName = chat.type === 'group' ? (chat.name + (chat.login ? ' · @' + chat.login : '')) : null;
      const cap = buildCaption({ num, cat: 'file', uploader: user.login, nick: user.nickname, chatName, size: sess.data.fileSize, mime: sess.data.mimeType, filename });
      const tgFileId = await sendTG(buffer, filename, sess.data.mimeType, cap);
      const fileId = uuidv4();
      const kind = guessKind(sess.data.mimeType);
      await filesCol.insertOne({ _id: fileId, tgFileId, name: filename, size: sess.data.fileSize || buffer.length, mime: sess.data.mimeType, kind, uploader: user.login, purpose: 'file', uploadedAt: new Date().toISOString() });
      const r2 = await processNewMessage(targetChatId, user.login, '', null, null, fileId, null);
      await botSessionsCol.deleteOne({ _id: sess._id });
      if (r2.error) throw new Error(r2.error);
      await tgBot.sendMessage(chatId, `✅ Отправлено в <b>${escHtml(chat.name || targetChatId)}</b>`, { parse_mode: 'HTML' });
    } catch (e) { await botSessionsCol.deleteOne({ _id: sess._id }); await tgBot.sendMessage(chatId, `❌ ${e.message || 'Ошибка загрузки'}`); }
    return;
  }
  if (data === 'cancel') { try { await tgBot.answerCallbackQuery(cb.id, { text: 'Отменено' }); } catch {} await botSessionsCol.deleteOne({ _id: 'tg:' + chatId }); return; }
  try { await tgBot.answerCallbackQuery(cb.id); } catch {}
}

// Ежедневная сводка 9:00 МСК
setInterval(async () => {
  if (!tgBot) return;
  try {
    const now = new Date();
    const moscowHour = (now.getUTCHours() + 3) % 24;
    if (moscowHour !== 9) return;
    const key = now.toISOString().slice(0, 10);
    if (await countersCol.findOne({ _id: 'digest_' + key })) return;
    await countersCol.insertOne({ _id: 'digest_' + key, sentAt: now.toISOString() });
    const [accounts, messagesTotal, channelsCount, chatsCount] = await Promise.all([
      usersCol.countDocuments({}),
      messagesCol.countDocuments({ deleted: { $ne: true } }),
      chatsCol.countDocuments({ type: 'group', isChannel: true, published: true, isPrivate: { $ne: true } }),
      chatsCol.countDocuments({ type: 'group', isChannel: { $ne: true }, published: true, isPrivate: { $ne: true } })
    ]);
    const users = await usersCol.find({ tgChatId: { $ne: null }, dailyDigest: { $ne: false } }).toArray();
    for (const u of users) {
      const text = `🌸 <b>Криста.Net — сводка</b>\n\n👥 Юзеров: <b>${accounts}</b>\n💬 Сообщений: <b>${messagesTotal}</b>\n📢 Каналов: <b>${channelsCount}</b>\n💬 Чатов: <b>${chatsCount}</b>\n🟢 Онлайн: <b>${clients.size}</b>\n\n💬 @${SUPPORT_TG}`;
      try { await tgBot.sendMessage(u.tgChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }); } catch (e) { if (e.response?.body?.error_code === 403) await usersCol.updateOne({ login: u.login }, { $set: { tgChatId: null } }); }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) { console.warn('digest:', e.message); }
}, 60 * 1000);

// ============================================================
//  WEBSOCKET
// ============================================================
const wss = new WebSocket.Server({ server });
const clients = new Map();
const wsRate = new Map();

function checkRate(login) {
  const now = Date.now();
  const cur = wsRate.get(login);
  if (!cur || now - cur.first > 3000) { wsRate.set(login, { count: 1, first: now }); return true; }
  if (cur.count >= 20) return false;
  cur.count++;
  return true;
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.login = null; ws.currentChatId = null; ws.lastPong = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async raw => {
    let data; try { data = JSON.parse(raw); } catch { return; }
    const { type, payload } = data;
    if (type === 'pong') { ws.lastPong = Date.now(); return; }
    if (type === 'auth') {
      const dec = verifyToken(payload?.token);
      if (!dec) { ws.close(); return; }
      const user = await usersCol.findOne({ login: dec.login });
      if (!user) { ws.close(); return; }
      ws.login = dec.login;
      clients.set(ws.login, ws);
      broadcast({ type: 'status', payload: { login: ws.login, status: 'online' } });
      ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } }));
      return;
    }
    if (!ws.login) return;
    if (!checkRate(ws.login)) { ws.send(JSON.stringify({ type: 'error', payload: 'Слишком быстро' })); return; }
    if (type === 'ping') { ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } })); return; }
    if (type === 'activeChat') {
      ws.currentChatId = payload?.chatId || null;
      if (ws.currentChatId) {
        const msgs = await messagesCol.find({ chatId: ws.currentChatId, sender: { $ne: ws.login }, deleted: { $ne: true } }).toArray();
        await markReadForUser(ws.currentChatId, ws.login, msgs);
      }
      return;
    }
    if (type === 'delivered') {
      const { messageId } = payload || {};
      if (!messageId) return;
      await messagesCol.updateOne({ _id: messageId }, { $addToSet: { deliveredTo: ws.login } });
      return;
    }
    if (type === 'newMessage') {
      const { chatId, text, replyTo, clientId, fileId, forwardFrom } = payload || {};
      const r = await processNewMessage(chatId, ws.login, text, clientId, replyTo, fileId, forwardFrom);
      if (r.error) { ws.send(JSON.stringify({ type: 'error', payload: { clientId, error: r.error } })); return; }
      if (r.duplicate) ws.send(JSON.stringify({ type: 'messageAck', payload: { clientId, id: r.message.id } }));
      return;
    }
    if (type === 'deleteMessage') {
      const { messageId } = payload || {};
      const msg = await messagesCol.findOne({ _id: messageId });
      if (!msg || msg.deleted) return;
      const chat = await chatsCol.findOne({ _id: msg.chatId });
      if (!chat) return;
      const isAuthor = msg.sender === ws.login;
      const isAdmin = chat.type === 'group' && ((chat.admins || []).includes(ws.login) || chat.owner === ws.login);
      if (!isAuthor && !isAdmin) return;
      await messagesCol.updateOne({ _id: messageId }, { $set: { deleted: true } });
      const out = JSON.stringify({ type: 'deleteMessage', payload: { messageId, chatId: msg.chatId } });
      chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
      return;
    }
    if (type === 'toggleReaction') {
      const { messageId, emoji } = payload || {};
      const r = await toggleReaction(messageId, emoji, ws.login);
      if (r.error) ws.send(JSON.stringify({ type: 'error', payload: { error: r.error } }));
      return;
    }
    if (type === 'typing') {
      const { chatId, text } = payload || {};
      if (!chatId) return;
      const chat = await chatsCol.findOne({ _id: chatId });
      if (!chat || !chat.members.includes(ws.login)) return;
      const user = await usersCol.findOne({ login: ws.login }, { projection: { nickname: 1, login: 1 } });
      if (!user) return;
      const out = JSON.stringify({ type: 'typing', payload: { chatId, login: ws.login, nickname: user.nickname || user.login, text: String(text || '').slice(0, 200) } });
      chat.members.forEach(u => { if (u === ws.login) return; const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
      return;
    }
    if (type === 'deleteChat') {
      const { chatId } = payload || {};
      const chat = await chatsCol.findOne({ _id: chatId });
      if (!chat || !chat.members.includes(ws.login)) return;
      if (chat.type === 'group' && chat.owner !== ws.login) return;
      // М5: чистим filesCol
      const msgs = await messagesCol.find({ chatId }, { projection: { fileId: 1 } }).toArray();
      const fileIds = msgs.map(m => m.fileId).filter(Boolean);
      if (fileIds.length) await filesCol.deleteMany({ _id: { $in: fileIds }, purpose: 'file' });
      await messagesCol.deleteMany({ chatId });
      await chatsCol.deleteOne({ _id: chatId });
      await chatThemesCol.deleteOne({ chatId });
      await foldersCol.updateMany({ owner: ws.login }, { $pull: { chatIds: chatId } });
      const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
      chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
      return;
    }
  });
  ws.on('close', () => {
    if (ws.login) { clients.delete(ws.login); broadcast({ type: 'status', payload: { login: ws.login, status: 'offline' } }); }
  });
  ws.on('error', () => {});
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, c] of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

// Heartbeat: ping клиенту каждые 8 сек, terminate если нет ответа >45 сек
setInterval(() => {
  const now = Date.now();
  for (const [login, ws] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (now - ws.lastPong > 45000) { try { ws.terminate(); } catch {} clients.delete(login); continue; }
    try { ws.send(JSON.stringify({ type: 'ping', payload: { t: now } })); } catch {}
  }
}, 8000);

setInterval(() => {
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

// ============================================================
//  SPA FALLBACK — все GET отдают index.html
// ============================================================
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
//  ЗАПУСК
// ============================================================
(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🌸 Криста.Net v${VERSION} · порт ${PORT}`);
    console.log(`📦 MongoDB / ${DB_NAME}`);
    console.log(`📨 Файлы: ${tgBot ? 'ON' : 'OFF'}`);
  });
})();
