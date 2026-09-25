// КРИСТА.ФРИНЕТ · server.js v4.37
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
const MAX_MSG_LEN = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const BASE_URL = process.env.BASE_URL || 'https://krista-4.onrender.com';
const SUPPORT_TG = 'prikin_1';
const MUSIC_PER_PAGE = 25;
const STATS_TOP = 10;

if (!MONGO_URI) { console.error('❌ MONGO_URI не задан.'); process.exit(1); }

let usersCol, chatsCol, messagesCol, filesCol, countersCol;
let themesCol, chatThemesCol, playlistsCol, musicCol, tgLinksCol, botSessionsCol;
let foldersCol, remindersCol;

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

    tgBot.on('message', async (msg) => {
      try {
        if (msg.chat.type === 'private') { await handleBotPrivateMessage(msg); return; }
        if (String(msg.chat.id) !== TG_CHAT_ID) return;
        const audio = msg.audio || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('audio/') ? msg.document : null);
        if (!audio || !audio.file_id) return;

        const rawFilename = (audio.file_name || '').replace(/\.[^.]+$/, '');
        let artist = (audio.performer || '').trim();
        let title = (audio.title || '').trim();
        if (!artist && rawFilename) {
          const parts = rawFilename.split(/\s*[-–—_]\s*/);
          if (parts.length >= 2) { artist = parts[0].trim(); if (!title) title = parts.slice(1).join(' — ').trim(); }
        }
        if (!title && rawFilename) title = rawFilename;
        if (!artist) artist = 'Без исполнителя';
        if (!title) title = 'Без названия';

        const uploadedBy = msg.from?.username || msg.from?.first_name || 'telegram';
        const filename = `${sanitize(artist)}-${sanitize(title)}.mp3`;
        const num = await nextNum();
        const id = uuidv4();

        await musicCol.insertOne({
          _id: id, number: num, tgFileId: audio.file_id, filename,
          artist: artist.slice(0, 80), album: 'Сингл', title: title.slice(0, 120),
          trackNumber: 1, size: audio.file_size || 0, mime: audio.mime_type || 'audio/mpeg',
          uploadedBy, uploadedAt: new Date().toISOString(), source: 'telegram'
        });
        broadcast({ type: 'musicAdded', payload: { id } });
        console.log(`🎵 TG импорт: ${artist} — ${title}`);
      } catch (e) { console.warn('TG msg:', e.message); }
    });

    tgBot.on('callback_query', async (cb) => {
      try { await handleCallback(cb); }
      catch (e) { console.warn('TG cb:', e.message); try { tgBot.answerCallbackQuery(cb.id); } catch {} }
    });
  } catch (e) { console.error('❌ Telegram:', e.message); }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });
const pendingMusic = new Map();

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
      playlistsCol = db.collection('playlists');
      musicCol = db.collection('music');
      tgLinksCol = db.collection('tg_links');
      botSessionsCol = db.collection('bot_sessions');
      foldersCol = db.collection('folders');
      remindersCol = db.collection('reminders');

      await usersCol.createIndex({ login: 1 }, { unique: true, sparse: true }).catch(() => {});
      await usersCol.createIndex({ tgChatId: 1 }, { sparse: true }).catch(() => {});
      await chatsCol.createIndex({ login: 1 }, { unique: true, sparse: true }).catch(() => {});
      await chatsCol.createIndex({ members: 1 }).catch(() => {});
      await chatsCol.createIndex({ published: 1 }).catch(() => {});
      await messagesCol.createIndex({ chatId: 1, timestamp: 1 }).catch(() => {});
      await messagesCol.createIndex({ sender: 1 }).catch(() => {});
      await messagesCol.createIndex({ text: 'text' }).catch(() => {});
      await filesCol.createIndex({ uploader: 1 }).catch(() => {});
      await musicCol.createIndex({ title: 1 }).catch(() => {});
      await musicCol.createIndex({ artist: 1 }).catch(() => {});
      await playlistsCol.createIndex({ owner: 1 }).catch(() => {});
      await foldersCol.createIndex({ owner: 1 }).catch(() => {});
      await remindersCol.createIndex({ dueAt: 1 }).catch(() => {});
      await remindersCol.createIndex({ owner: 1 }).catch(() => {});
      await tgLinksCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
      await botSessionsCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});

      console.log('✅ MongoDB подключена');
      await migrateV3();
      startReminderScheduler();
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
    const fixedMusic = await countersCol.findOne({ _id: 'fixed_music_tg' });
    if (!fixedMusic) {
      try {
        const r = await db.collection('music').updateMany(
          { tgFileId: { $exists: false }, fileId: { $exists: true } },
          [{ $set: { tgFileId: "$fileId" } }]
        );
        if (r.modifiedCount) console.log(`🔧 Музыка: обновлено ${r.modifiedCount}`);
      } catch (e) {}
      await countersCol.updateOne({ _id: 'fixed_music_tg' }, { $set: { value: 1 } }, { upsert: true });
    }

    const fixedChannels = await countersCol.findOne({ _id: 'fixed_channels' });
    if (!fixedChannels) {
      try {
        const broken = await chatsCol.find({ isChannel: true, $or: [{ members: { $size: 0 } }, { members: { $exists: false } }] }).toArray();
        for (const c of broken) {
          const owner = c.owner || c.login;
          if (owner) await chatsCol.updateOne({ _id: c._id }, { $set: { members: [owner], admins: [owner] } });
        }
      } catch (e) {}
      await countersCol.updateOne({ _id: 'fixed_channels' }, { $set: { value: 1 } }, { upsert: true });
    }

    const fixedUsers = await countersCol.findOne({ _id: 'fixed_users_v437' });
    if (!fixedUsers) {
      await usersCol.updateMany({}, { $set: { archivedChats: [], chatAliases: {}, stickers: [], favorites: [] } });
      await usersCol.updateMany({ archivedChats: { $exists: false } }, { $set: { archivedChats: [] } });
      await countersCol.updateOne({ _id: 'fixed_users_v437' }, { $set: { value: 1 } }, { upsert: true });
      console.log('🔧 Пользователи: добавлены поля v4.37');
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) return 'Логин: буквы, цифры, _ и -';
  return null;
}

async function nextNum() {
  const r = await countersCol.findOneAndUpdate(
    { _id: 'file_number' }, { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return r.value;
}

// ============================================================
//  PUBLIC
// ============================================================
function pubUser(doc) {
  if (!doc) return null;
  return {
    login: doc.login, nickname: doc.nickname || doc.login,
    accentColor: doc.accentColor || '#f0a0c8',
    nicknameColor: doc.nicknameColor || '#f0a0c8',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#f0a0c8',
    avatarFileId: doc.avatarFileId || null,
    loginChangeableAt: doc.loginChangeableAt || null,
    tgChatId: !!doc.tgChatId,
    pinnedChats: doc.pinnedChats || [],
    archivedChats: doc.archivedChats || [],
    chatAliases: doc.chatAliases || {},
    stickers: doc.stickers || [],
    favorites: doc.favorites || [],
    createdAt: doc.createdAt, lastSeen: doc.lastSeen
  };
}

function pubUserShort(doc) {
  if (!doc) return null;
  return {
    login: doc.login, nickname: doc.nickname || doc.login,
    nicknameColor: doc.nicknameColor || '#f0a0c8',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#f0a0c8',
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
    timestamp: doc.timestamp, replyTo: doc.replyTo || null,
    forwardFrom: doc.forwardFrom || null,
    reminder: doc.reminder || null,
    deleted: doc.deleted ? 1 : 0
  };
}

async function getFilesMap(fileIds) {
  const ids = fileIds.filter(Boolean);
  if (!ids.length) return {};
  const files = await filesCol.find({ _id: { $in: ids } }).toArray();
  const map = {};
  files.forEach(f => { map[f._id] = f; });
  return map;
}

async function getAvatarMap(logins) {
  const uniq = [...new Set(logins.filter(Boolean))];
  if (!uniq.length) return {};
  const users = await usersCol.find({ login: { $in: uniq } }).toArray();
  const map = {};
  users.forEach(u => { map[u.login] = u.avatarFileId || null; });
  return map;
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
    req.chat = chat;
    next();
  } catch { res.status(500).json({ error: 'Ошибка сервера' }); }
}

function requireChatAdmin(req, res, next) {
  const isAdmin = (req.chat.admins || []).includes(req.userLogin) || req.chat.owner === req.userLogin;
  if (!isAdmin) return res.status(403).json({ error: 'Только админ' });
  next();
}

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
      accentColor: '#f0a0c8', nicknameColor: '#f0a0c8',
      nicknameEmoji: '', nicknameEmojiColor: '#f0a0c8',
      avatarFileId: null, tgChatId: null, loginChangeableAt: null,
      mutedUntil: null, dailyDigest: true,
      pinnedChats: [], archivedChats: [], chatAliases: {}, stickers: [], favorites: [],
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
    if (!user) return res.status(404).json({ error: 'Не найден' });
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
    ['accentColor','nicknameColor','nicknameEmoji','nicknameEmojiColor','avatarFileId','tgChatId','dailyDigest','pinnedChats','archivedChats','chatAliases','stickers','favorites'].forEach(k => {
      if (b[k] !== undefined) up[k] = b[k];
    });

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
    await remindersCol.deleteMany({ owner: login });
    await usersCol.deleteOne({ login });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  USERS + SEARCH + CATALOG
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

app.get('/api/catalog', authMw, async (req, res) => {
  const list = await chatsCol.find({ type: 'group', published: true, isPrivate: { $ne: true } }).toArray();
  list.sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0));
  res.json(list.map((g, i) => ({
    rank: i + 1, id: g._id, login: g.login, name: g.name,
    isChannel: !!g.isChannel, avatarFileId: g.avatarFileId || null,
    membersCount: g.members.length, isMember: g.members.includes(req.userLogin)
  })));
});

app.get('/api/stats', authMw, async (req, res) => {
  const [accounts, chats] = await Promise.all([
    usersCol.countDocuments({}), chatsCol.countDocuments({ type: 'group' })
  ]);
  res.json({ accounts, chats, online: clients.size });
});

// ============================================================
//  📁 ПАПКИ
// ============================================================
const DEFAULT_FOLDERS = [
  { name: 'Непрочитанные', icon: '🔴', system: true,  filter: 'unread',  pinned: true,  open: true,  order: 0 },
  { name: 'Онлайн',        icon: '🟢', system: true,  filter: 'online',  pinned: true,  open: true,  order: 1 },
  { name: 'Оффлайн',       icon: '⚪', system: true,  filter: 'offline', pinned: false, open: false, order: 2 },
  { name: 'Все чаты',      icon: '🌸', system: true,  filter: 'all',     pinned: false, open: false, order: 99 },
];

async function ensureDefaultFolders(login) {
  const exists = await foldersCol.findOne({ owner: login });
  if (exists) return;
  const docs = DEFAULT_FOLDERS.map(f => ({
    _id: uuidv4(), owner: login, name: f.name, icon: f.icon,
    system: !!f.system, filter: f.filter || null,
    pinned: !!f.pinned, open: !!f.open, order: f.order || 50,
    chatIds: [], createdAt: new Date().toISOString()
  }));
  try { await foldersCol.insertMany(docs); } catch {}
}

function pubFolder(f) {
  if (!f) return null;
  return {
    id: f._id, name: f.name, icon: f.icon,
    system: !!f.system, filter: f.filter || null,
    pinned: !!f.pinned, open: !!f.open, order: f.order || 0,
    chatIds: f.chatIds || []
  };
}

app.get('/api/folders', authMw, async (req, res) => {
  try {
    await ensureDefaultFolders(req.userLogin);
    const list = await foldersCol.find({ owner: req.userLogin }).sort({ order: 1, createdAt: 1 }).toArray();
    res.json(list.map(pubFolder));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/folders', authMw, async (req, res) => {
  try {
    const { name, icon } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Введите название' });
    const maxOrder = await foldersCol.find({ owner: req.userLogin, system: { $ne: true } })
      .sort({ order: -1 }).limit(1).toArray();
    const nextOrder = (maxOrder[0]?.order || 10) + 1;
    const doc = {
      _id: uuidv4(), owner: req.userLogin,
      name: name.trim().slice(0, 30),
      icon: (icon || '📁').trim().slice(0, 4),
      system: false, filter: null, pinned: false, open: true,
      order: nextOrder, chatIds: [], createdAt: new Date().toISOString()
    };
    await foldersCol.insertOne(doc);
    res.status(201).json(pubFolder(doc));
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/folders/:id', authMw, async (req, res) => {
  try {
    const f = await foldersCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!f) return res.status(404).json({ error: 'Папка не найдена' });
    const up = {};
    const b = req.body || {};
    if (b.name !== undefined) up.name = String(b.name).trim().slice(0, 30);
    if (b.icon !== undefined) up.icon = String(b.icon).trim().slice(0, 4);
    if (b.pinned !== undefined) up.pinned = !!b.pinned;
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

app.put('/api/folders/reorder', authMw, async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order должен быть массивом' });
    for (const item of order) {
      if (!item.id) continue;
      await foldersCol.updateOne(
        { _id: item.id, owner: req.userLogin },
        { $set: { order: parseInt(item.order) || 0 } }
      );
    }
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  📦 АРХИВ ЧАТОВ
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
//  🏷 ПСЕВДОНИМЫ
// ============================================================
app.put('/api/chats/:chatId/alias', authMw, async (req, res) => {
  try {
    const { alias } = req.body || {};
    const cleanAlias = String(alias || '').trim().slice(0, 40);
    if (cleanAlias) await usersCol.updateOne({ login: req.userLogin }, { $set: { [`chatAliases.${req.params.chatId}`]: cleanAlias } });
    else await usersCol.updateOne({ login: req.userLogin }, { $unset: { [`chatAliases.${req.params.chatId}`]: '' } });
    res.json({ success: true, alias: cleanAlias });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  ⏰ НАПОМИНАНИЯ
// ============================================================
app.get('/api/reminders', authMw, async (req, res) => {
  const list = await remindersCol.find({ owner: req.userLogin }).sort({ dueAt: 1 }).toArray();
  res.json(list.map(r => ({ id: r._id, messageId: r.messageId, chatId: r.chatId, text: r.text, dueAt: r.dueAt, done: !!r.done })));
});

app.post('/api/reminders', authMw, async (req, res) => {
  try {
    const { messageId, chatId, text, dueAt } = req.body || {};
    if (!dueAt || !text) return res.status(400).json({ error: 'dueAt и text обязательны' });
    const doc = {
      _id: uuidv4(), owner: req.userLogin,
      messageId: messageId || null, chatId: chatId || null,
      text: String(text).slice(0, 500),
      dueAt: new Date(dueAt).toISOString(),
      done: false,
      createdAt: new Date().toISOString()
    };
    await remindersCol.insertOne(doc);
    res.status(201).json({ success: true, reminder: { id: doc._id, dueAt: doc.dueAt, text: doc.text } });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/reminders/:id', authMw, async (req, res) => {
  await remindersCol.deleteOne({ _id: req.params.id, owner: req.userLogin });
  res.json({ success: true });
});

function startReminderScheduler() {
  setInterval(async () => {
    try {
      const due = await remindersCol.find({ dueAt: { $lte: new Date().toISOString() }, done: false }).toArray();
      for (const r of due) {
        const ws = clients.get(r.owner);
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reminderDue', payload: { id: r._id, chatId: r.chatId, messageId: r.messageId, text: r.text } }));
        }
        // TG-уведомление
        if (tgBot) {
          const user = await usersCol.findOne({ login: r.owner });
          if (user?.tgChatId) {
            try { await tgBot.sendMessage(user.tgChatId, `⏰ <b>Напоминание</b>\n\n${escHtml(r.text)}`, { parse_mode: 'HTML' }); } catch {}
          }
        }
        await remindersCol.updateOne({ _id: r._id }, { $set: { done: true } });
      }
    } catch (e) { console.warn('reminders:', e.message); }
  }, 30000);
}

// ============================================================
//  🎨 СТИКЕРЫ
// ============================================================
app.get('/api/stickers', authMw, async (req, res) => {
  const user = await usersCol.findOne({ login: req.userLogin });
  res.json(user?.stickers || []);
});

app.post('/api/stickers', authMw, async (req, res) => {
  try {
    const { pack } = req.body || {};
    if (!pack || !pack.name || !Array.isArray(pack.stickers)) return res.status(400).json({ error: 'Неверный формат пака' });
    const cleanPack = {
      id: uuidv4(),
      name: String(pack.name).slice(0, 40),
      icon: String(pack.icon || '🎨').slice(0, 4),
      stickers: pack.stickers.slice(0, 50).map(s => String(s).slice(0, 300)),
      addedAt: new Date().toISOString()
    };
    await usersCol.updateOne({ login: req.userLogin }, { $push: { stickers: cleanPack } });
    res.status(201).json({ success: true, pack: cleanPack });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/stickers/:packId', authMw, async (req, res) => {
  await usersCol.updateOne({ login: req.userLogin }, { $pull: { stickers: { id: req.params.packId } } });
  res.json({ success: true });
});

// ============================================================
//  ⭐ ИЗБРАННОЕ
// ============================================================
app.get('/api/favorites', authMw, async (req, res) => {
  const user = await usersCol.findOne({ login: req.userLogin });
  res.json(user?.favorites || []);
});

app.post('/api/favorites', authMw, async (req, res) => {
  try {
    const { messageId, chatId, text, senderName, sender, timestamp } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Нет текста' });
    const fav = {
      id: uuidv4(),
      messageId: messageId || null,
      chatId: chatId || null,
      text: String(text).slice(0, 1000),
      senderName: String(senderName || '').slice(0, 60),
      sender: String(sender || '').slice(0, 32),
      timestamp: timestamp || new Date().toISOString(),
      savedAt: new Date().toISOString()
    };
    await usersCol.updateOne({ login: req.userLogin }, { $push: { favorites: { $each: [fav], $position: 0 } } });
    res.status(201).json({ success: true, favorite: fav });
  } catch { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/favorites/:id', authMw, async (req, res) => {
  await usersCol.updateOne({ login: req.userLogin }, { $pull: { favorites: { id: req.params.id } } });
  res.json({ success: true });
});

// ============================================================
//  CHATS
// ============================================================
app.get('/api/chats', authMw, async (req, res) => {
  try {
    const me = await usersCol.findOne({ login: req.userLogin });
    if (!me) return res.status(404).json({ error: 'Не найден' });
    const myChats = await chatsCol.find({ members: req.userLogin }).toArray();
    const archived = me.archivedChats || [];
    const aliases = me.chatAliases || {};

    const result = await Promise.all(myChats.map(async chat => {
      const isGroup = chat.type === 'group';
      let title = chat.name, otherLogin = null, otherUser = null;
      if (!isGroup) {
        otherLogin = chat.members.find(u => u !== req.userLogin);
        otherUser = otherLogin ? await usersCol.findOne({ login: otherLogin }) : null;
        title = otherUser?.nickname || otherUser?.login || '???';
      }
      const [lastMsg, unread] = await Promise.all([
        messagesCol.find({ chatId: chat._id, deleted: { $ne: true } }).sort({ timestamp: -1 }).limit(1).next(),
        me.lastSeen ? messagesCol.countDocuments({
          chatId: chat._id, sender: { $ne: req.userLogin },
          timestamp: { $gt: me.lastSeen }, deleted: { $ne: true }
        }) : Promise.resolve(0)
      ]);
      const fileIds = lastMsg?.fileId ? [lastMsg.fileId] : [];
      const filesMap = await getFilesMap(fileIds);
      const avatarMap = lastMsg ? await getAvatarMap([lastMsg.sender]) : {};
      return {
        id: chat._id, type: chat.type || 'dialog', isGroup,
        isChannel: !!chat.isChannel, isPrivate: !!chat.isPrivate,
        isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
        name: title, login: chat.login || null,
        alias: aliases[chat._id] || null,
        avatarFileId: chat.avatarFileId || null,
        membersCount: chat.members.length, otherLogin,
        otherUser: otherUser ? pubUserShort(otherUser) : null,
        lastMessage: lastMsg ? pubMessage(lastMsg, filesMap, avatarMap) : null,
        unreadCount: unread,
        pinned: (me.pinnedChats || []).includes(chat._id),
        archived: archived.includes(chat._id),
        updatedAt: chat.updatedAt || (lastMsg ? lastMsg.timestamp : chat._id)
      };
    }));

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
    await chatsCol.insertOne({
      _id: id, type: 'group', isChannel: !!isChannel, name: name.trim(), login,
      members: allMembers, admins: [req.userLogin], owner: req.userLogin,
      isPrivate: !!isPrivate, published: !!published, updatedAt: new Date().toISOString()
    });
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

app.delete('/api/chats/:chatId', authMw, async (req, res) => {
  const chat = await chatsCol.findOne({ _id: req.params.chatId });
  if (!chat) return res.status(404).json({ error: 'Не найдено' });
  if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
  if (chat.type === 'group' && chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });
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
    const msgs = await messagesCol.find({
      chatId: req.chat._id, deleted: { $ne: true }, text: regex
    }).sort({ timestamp: -1 }).limit(100).toArray();
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
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'messagesRead', payload: { chatId, byLogin: login, messageIds: bySender[sender] } }));
      }
    }
  } catch (e) { console.warn('markRead:', e); }
}

app.post('/api/chats/:chatId/messages', authMw, async (req, res) => {
  const { text, clientId, replyTo, fileId, forwardFrom } = req.body || {};
  const r = await processNewMessage(req.params.chatId, req.userLogin, text, clientId, replyTo, fileId, forwardFrom);
  if (r.error) return res.status(r.code || 400).json({ error: r.error });
  res.status(201).json(r.message);
});

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
    timestamp, replyTo: validReply, forwardFrom: validForward, deleted: false
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

const ALLOWED_REACTIONS = ['heart','laugh','bigsmile','sad','angry','surprised','smile','cool','wink','cry','love','party'];

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
    if (l.includes(login)) {
      reactions[idx].logins = l.filter(x => x !== login);
      if (!reactions[idx].logins.length) reactions.splice(idx, 1);
    } else reactions[idx].logins.push(login);
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
      await usersCol.updateOne({ login: req.userLogin }, { $set: { avatarFileId: fileId } });
      return res.json({ success: true, fileId });
    }

    if (purpose === 'wallpaper') {
      const filename = originalname || `wallpaper-${num}.jpg`;
      const cap = buildCaption({ num, cat: 'wallpaper', uploader: req.userLogin, nick: user.nickname, size, mime: mimetype, filename });
      const tgFileId = await sendTG(buffer, filename, mimetype, cap);
      const fileId = uuidv4();
      await filesCol.insertOne({ _id: fileId, tgFileId, name: filename, size, mime: mimetype, kind: 'image', uploader: req.userLogin, purpose: 'wallpaper', uploadedAt: new Date().toISOString() });
      return res.json({ success: true, fileId, name: filename });
    }

    if (purpose === 'chat_avatar') {
      if (!chatId) return res.status(400).json({ error: 'Не указан чат' });
      const chat = await chatsCol.findOne({ _id: chatId });
      if (!chat) return res.status(404).json({ error: 'Чат не найден' });
      if (!(chat.admins || []).includes(req.userLogin) && chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только админ' });
      const filename = `chat-${chatId}.jpg`;
      const cap = buildCaption({ num, cat: 'chat_avatar', uploader: req.userLogin, nick: user.nickname, chatName: chat.name, size, mime: mimetype, filename });
      const tgFileId = await sendTG(buffer, filename, mimetype, cap);
      const fileId = uuidv4();
      await filesCol.insertOne({ _id: fileId, tgFileId, name: filename, size, mime: mimetype, kind: 'image', uploader: req.userLogin, purpose: 'chat_avatar', uploadedAt: new Date().toISOString() });
      await chatsCol.updateOne({ _id: chatId }, { $set: { avatarFileId: fileId } });
      return res.json({ success: true, fileId });
    }

    if (!chatId) return res.status(400).json({ error: 'Не указан чат' });
    const chat = await chatsCol.findOne({ _id: chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });

    const chatName = chat.type === 'group' ? (chat.name + (chat.login ? ' · @' + chat.login : '')) : null;
    const cap = buildCaption({ num, cat: 'file', uploader: req.userLogin, nick: user.nickname, chatName, size, mime: mimetype, filename: originalname });

    let tgFileId;
    try { tgFileId = await sendTG(buffer, originalname, mimetype, cap); }
    catch (e) {
      const d = e.response?.body?.description || e.message;
      return res.status(502).json({ error: 'Telegram: ' + d });
    }

    const fileId = uuidv4();
    const kind = guessKind(mimetype);
    await filesCol.insertOne({ _id: fileId, tgFileId, name: originalname, size, mime: mimetype, kind, uploader: req.userLogin, purpose: 'file', uploadedAt: new Date().toISOString() });

    const r = await processNewMessage(chatId, req.userLogin, '', clientId, replyTo, fileId, null);
    if (r.error) return res.status(500).json({ error: r.error });
    res.status(201).json(r.message);
  } catch (e) { console.error('upload:', e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/file/:fileId', authMw, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Недоступно' });
    const idParam = req.params.fileId;
    let f = await filesCol.findOne({ _id: idParam });
    let tgId = null;
    let mime = 'application/octet-stream';
    let name = 'file';
    if (f) {
      tgId = f.tgFileId;
      mime = f.mime || mime;
      name = f.name || name;
      if (f.purpose === 'file') {
        const msg = await messagesCol.findOne({ fileId: f._id });
        if (msg) {
          const chat = await chatsCol.findOne({ _id: msg.chatId });
          if (!chat?.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
        }
      }
    } else {
      tgId = idParam;
    }
    let url;
    try { url = await tgBot.getFileLink(tgId); }
    catch { return res.status(404).json({ error: 'Файл недоступен (возможно, >20 МБ)' }); }
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Telegram недоступен' });
    const ct = r.headers.get('content-type') || mime;
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    const cl = r.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  MUSIC
// ============================================================
app.post('/api/music/stage', authMw, (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл больше 20 мб' });
      return res.status(400).json({ error: 'Ошибка загрузки' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const { artist, album, trackTitle, trackNumber } = req.body || {};
  if (!artist || !trackTitle) return res.status(400).json({ error: 'Укажи исполнителя и название' });
  const token = uuidv4();
  pendingMusic.set(token, {
    buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size,
    originalname: req.file.originalname,
    artist: String(artist).slice(0, 80),
    album: String(album || 'Сингл').slice(0, 80),
    trackTitle: String(trackTitle).slice(0, 120),
    trackNumber: parseInt(trackNumber) || 1,
    login: req.userLogin, expiresAt: Date.now() + 10 * 60 * 1000
  });
  res.json({ success: true, token });
});

app.post('/api/music/publish', authMw, async (req, res) => {
  if (!tgBot) return res.status(503).json({ error: 'Недоступно' });
  const { token } = req.body || {};
  const p = pendingMusic.get(token);
  if (!p || p.expiresAt < Date.now()) { pendingMusic.delete(token); return res.status(404).json({ error: 'Черновик истёк' }); }
  if (p.login !== req.userLogin) return res.status(403).json({ error: 'Нет доступа' });

  const user = await usersCol.findOne({ login: req.userLogin });
  const ext = (p.originalname.match(/\.[a-z0-9]+$/i) || ['.mp3'])[0];
  const filename = `${sanitize(p.artist)}-${sanitize(p.trackTitle)}${ext}`;
  const num = await nextNum();
  const extra = `🎵 ${p.artist} · ${p.trackTitle}\n💿 ${p.album} · #${p.trackNumber}`;
  const cap = buildCaption({ num, cat: 'music', uploader: p.login, nick: user?.nickname, size: p.size, mime: p.mimetype, filename }) + '\n' + extra;

  let tgFileId;
  try { tgFileId = await sendTG(p.buffer, filename, p.mimetype, cap); }
  catch (e) { return res.status(502).json({ error: 'Telegram: ' + (e.response?.body?.description || e.message) }); }
  pendingMusic.delete(token);

  const id = uuidv4();
  await musicCol.insertOne({
    _id: id, number: num, tgFileId, filename,
    artist: p.artist, album: p.album, title: p.trackTitle, trackNumber: p.trackNumber,
    size: p.size, mime: p.mimetype, uploadedBy: p.login, uploadedAt: new Date().toISOString()
  });
  broadcast({ type: 'musicAdded', payload: { id } });
  res.json({ success: true, track: { id, title: p.trackTitle, artist: p.artist, album: p.album } });
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingMusic) if (v.expiresAt < now) pendingMusic.delete(k);
}, 60000);

async function listMusic(filter, sort) {
  const songs = await musicCol.find(filter).sort(sort || { title: 1 }).toArray();
  return songs.map(s => ({
    id: s._id, tgFileId: s.tgFileId || s.fileId || null,
    title: s.title, artist: s.artist, album: s.album,
    trackNumber: s.trackNumber, size: s.size, mime: s.mime, filename: s.filename
  }));
}

app.get('/api/music/songs', authMw, async (req, res) => res.json(await listMusic({})));
app.get('/api/music/albums/:album', authMw, async (req, res) => res.json(await listMusic({ album: decodeURIComponent(req.params.album) }, { trackNumber: 1 })));
app.get('/api/music/artists/:artist', authMw, async (req, res) => res.json(await listMusic({ artist: decodeURIComponent(req.params.artist) }, { album: 1, trackNumber: 1 })));

app.get('/api/music/albums', authMw, async (req, res) => {
  const a = await musicCol.aggregate([{ $group: { _id: '$album', artist: { $first: '$artist' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
  res.json(a.map(x => ({ album: x._id, artist: x.artist, count: x.count })));
});
app.get('/api/music/artists', authMw, async (req, res) => {
  const a = await musicCol.aggregate([{ $group: { _id: '$artist', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
  res.json(a.map(x => ({ artist: x._id, count: x.count })));
});

app.get('/api/music/playlists', authMw, async (req, res) => {
  const pls = await playlistsCol.find({ owner: req.userLogin }).sort({ name: 1 }).toArray();
  res.json(pls.map(p => ({ id: p._id, name: p.name, count: (p.trackIds || []).length })));
});
app.post('/api/music/playlists', authMw, async (req, res) => {
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Введи название' });
  const doc = { _id: uuidv4(), owner: req.userLogin, name: name.trim().slice(0, 60), trackIds: [], createdAt: new Date().toISOString() };
  await playlistsCol.insertOne(doc);
  res.json({ success: true, id: doc._id, name: doc.name, count: 0 });
});
app.delete('/api/music/playlists/:id', authMw, async (req, res) => {
  await playlistsCol.deleteOne({ _id: req.params.id, owner: req.userLogin });
  res.json({ success: true });
});
app.get('/api/music/playlists/:id/tracks', authMw, async (req, res) => {
  const pl = await playlistsCol.findOne({ _id: req.params.id, owner: req.userLogin });
  if (!pl) return res.status(404).json({ error: 'Не найден' });
  const tracks = await musicCol.find({ _id: { $in: pl.trackIds || [] } }).toArray();
  const ordered = (pl.trackIds || []).map(id => tracks.find(t => t._id === id)).filter(Boolean);
  res.json({ name: pl.name, tracks: ordered.map(s => ({ id: s._id, tgFileId: s.tgFileId || s.fileId || null, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, mime: s.mime, filename: s.filename })) });
});
app.post('/api/music/playlists/:id/tracks', authMw, async (req, res) => {
  const { trackId } = req.body || {};
  const pl = await playlistsCol.findOne({ _id: req.params.id, owner: req.userLogin });
  if (!pl) return res.status(404).json({ error: 'Не найден' });
  if ((pl.trackIds || []).includes(trackId)) {
    await playlistsCol.updateOne({ _id: pl._id }, { $pull: { trackIds: trackId } });
    return res.json({ success: true, added: false });
  }
  await playlistsCol.updateOne({ _id: pl._id }, { $push: { trackIds: trackId } });
  res.json({ success: true, added: true });
});
app.delete('/api/music/playlists/:id/tracks/:trackId', authMw, async (req, res) => {
  await playlistsCol.updateOne({ _id: req.params.id, owner: req.userLogin }, { $pull: { trackIds: req.params.trackId } });
  res.json({ success: true });
});
app.delete('/api/music/tracks/:id', authMw, async (req, res) => {
  const t = await musicCol.findOne({ _id: req.params.id });
  if (!t) return res.status(404).json({ error: 'Не найден' });
  if (t.uploadedBy !== req.userLogin) return res.status(403).json({ error: 'Не твой' });
  await musicCol.deleteOne({ _id: t._id });
  await playlistsCol.updateMany({ owner: req.userLogin }, { $pull: { trackIds: t._id } });
  broadcast({ type: 'musicRemoved', payload: { id: t._id } });
  res.json({ success: true });
});

app.get('/api/music/file/:tgFileId', authMw, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Недоступно' });
    const tgFileId = req.params.tgFileId;
    if (!tgFileId || tgFileId === 'undefined' || tgFileId === 'null') return res.status(400).json({ error: 'Неверный ID' });
    let url;
    try { url = await tgBot.getFileLink(tgFileId); }
    catch { return res.status(404).json({ error: 'Файл недоступен' }); }
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Telegram недоступен' });
    res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
    const cl = r.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  THEMES
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
//  NOTIFY
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
          await tgBot.sendMessage(recipient.tgChatId,
            `💬 <b>${escHtml(title)}</b>\n\n<blockquote>${escHtml(preview)}</blockquote>\n\n<i><u><a href="${link}">Открыть</a></u></i>`,
            { parse_mode: 'HTML', disable_web_page_preview: true });
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
async function findUserByTg(chatId) {
  return await usersCol.findOne({ tgChatId: chatId });
}

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
      } catch (e) { await tgBot.sendMessage(chatId, '❌ Ошибка привязки'); return; }
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
  if (text === '/mute') {
    const user = await findUserByTg(chatId);
    if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.');
    await usersCol.updateOne({ login: user.login }, { $set: { mutedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() } });
    return tgBot.sendMessage(chatId, '🔕 Уведомления отключены.');
  }
  if (text === '/unmute') {
    const user = await findUserByTg(chatId);
    if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.');
    await usersCol.updateOne({ login: user.login }, { $set: { mutedUntil: null } });
    return tgBot.sendMessage(chatId, '🔔 Уведомления включены.');
  }
  if (text.startsWith('/find')) {
    const q = text.replace(/^\/find\s*/, '').trim().replace(/^@/, '');
    if (!q) return tgBot.sendMessage(chatId, 'Использование: /find логин');
    return cmdFind(chatId, q);
  }
  if (text === '/stats') {
    const user = await findUserByTg(chatId);
    if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.');
    return cmdStats(chatId, user);
  }
  if (text.startsWith('/post')) {
    const user = await findUserByTg(chatId);
    if (!user) return tgBot.sendMessage(chatId, '❌ Аккаунт не привязан.');
    const m = text.match(/^\/post\s+\[([^\]]+)\]\s*([\s\S]+)/);
    if (!m) return tgBot.sendMessage(chatId, 'Использование: /post [Канал] Текст');
    return cmdPost(chatId, user.login, m[1].trim(), m[2].trim());
  }
  if (text === '/music' || text.startsWith('/music ')) {
    const q = text.replace(/^\/music\s*/, '').trim();
    return cmdMusicMenu(chatId, q);
  }
}

async function sendMainMenu(chatId) {
  const user = await findUserByTg(chatId);
  const greeting = user ? `Привет, <b>@${user.login}</b>!` : 'Привет!';
  const text = `🌸 <b>Криста.Фринет</b>\n\n${greeting}\n\n` +
    `📊 /stats — статистика\n` +
    `🔍 /find логин — найти юзера\n` +
    `🎵 /music — библиотека\n` +
    `🔔 /mute · /unmute — уведомления\n` +
    `📢 /post [Канал] Текст\n\n` +
    `📎 Отправь файл — прилетит в чат\n\n` +
    `💬 Поддержка: @${SUPPORT_TG}`;
  const kb = {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'stats' }, { text: '🎵 Музыка', callback_data: 'music_songs_0' }],
      [{ text: '🔔 Уведомления', callback_data: 'notif_info' }, { text: '💬 Поддержка', url: `https://t.me/${SUPPORT_TG}` }]
    ]
  };
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

async function cmdStats(chatId, user) {
  try {
    const [accounts, messagesTotal, tracks, channels, chats, personalMsgs] = await Promise.all([
      usersCol.countDocuments({}),
      messagesCol.countDocuments({ deleted: { $ne: true } }),
      musicCol.countDocuments({}),
      chatsCol.countDocuments({ type: 'group', isChannel: true, published: true, isPrivate: { $ne: true } }),
      chatsCol.countDocuments({ type: 'group', isChannel: { $ne: true }, published: true, isPrivate: { $ne: true } }),
      chatsCol.find({ members: user.login }).toArray().then(async myChats => {
        const ids = myChats.map(c => c._id);
        return messagesCol.countDocuments({ chatId: { $in: ids }, sender: { $ne: user.login }, deleted: { $ne: true } });
      })
    ]);

    const onlineNow = clients.size;
    const channelList = await chatsCol.find({ type: 'group', isChannel: true, published: true, isPrivate: { $ne: true } }).toArray();
    channelList.sort((a, b) => b.members.length - a.members.length);
    const topChannels = channelList.slice(0, STATS_TOP);

    const chatList = await chatsCol.find({ type: 'group', isChannel: { $ne: true }, published: true, isPrivate: { $ne: true } }).toArray();
    chatList.sort((a, b) => b.members.length - a.members.length);
    const topChats = chatList.slice(0, STATS_TOP);

    let text = `📊 <b>Статистика Криста.Фринет</b>\n\n` +
      `👥 Юзеров: <b>${accounts}</b>\n` +
      `💬 Сообщений: <b>${messagesTotal}</b>\n` +
      `📬 Лично вам: <b>${personalMsgs}</b>\n` +
      `🎵 Треков: <b>${tracks}</b>\n` +
      `📢 Каналов: <b>${channels}</b>\n` +
      `💬 Публичных чатов: <b>${chats}</b>\n` +
      `🟢 Онлайн: <b>${onlineNow}</b>`;

    const kb = { inline_keyboard: [] };
    if (topChannels.length) {
      text += `\n\n📢 <b>Топ каналов:</b>`;
      topChannels.forEach(c => kb.inline_keyboard.push([{ text: `📢 ${c.name} · ${c.members.length}`, url: `${BASE_URL}/?chat=${c._id}` }]));
    }
    if (topChats.length) {
      text += `\n\n💬 <b>Топ чатов:</b>`;
      topChats.forEach(c => kb.inline_keyboard.push([{ text: `💬 ${c.name} · ${c.members.length}`, url: `${BASE_URL}/?chat=${c._id}` }]));
    }

    await tgBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb.inline_keyboard.length ? kb : undefined });
  } catch (e) {
    console.warn('stats:', e);
    await tgBot.sendMessage(chatId, '❌ Ошибка статистики.');
  }
}

async function cmdMusicMenu(chatId, query) {
  if (query) return cmdMusicSearch(chatId, query);
  const kb = {
    inline_keyboard: [
      [{ text: '🎵 Песни', callback_data: 'music_songs_0' }],
      [{ text: '💿 Альбомы', callback_data: 'music_albums_0' }],
      [{ text: '🎤 Исполнители', callback_data: 'music_artists_0' }]
    ]
  };
  await tgBot.sendMessage(chatId, '🎵 <b>Музыка</b>\n\nВыбери раздел:', { parse_mode: 'HTML', reply_markup: kb });
}

async function cmdMusicSearch(chatId, q) {
  const regex = new RegExp(escRe(q), 'i');
  const songs = await musicCol.find({ $or: [{ title: regex }, { artist: regex }] }).limit(MUSIC_PER_PAGE).toArray();
  if (!songs.length) return tgBot.sendMessage(chatId, `❌ По запросу «${q}» ничего не найдено.`);
  let text = `🎵 Найдено по «<b>${escHtml(q)}</b>»:\n\n`;
  const kb = { inline_keyboard: [] };
  songs.forEach((s, i) => {
    text += `${i + 1}. ${escHtml(s.artist)} — ${escHtml(s.title)}\n`;
    kb.inline_keyboard.push([{ text: `▶ ${s.artist} — ${s.title}`.slice(0, 60), callback_data: `music_send_${s._id}` }]);
  });
  await tgBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
}

async function cmdMusicList(chatId, mode, page = 0, filter = null) {
  try {
    let items = [], total = 0;
    if (mode === 'songs') {
      total = await musicCol.countDocuments({});
      items = await musicCol.find({}).sort({ title: 1 }).skip(page * MUSIC_PER_PAGE).limit(MUSIC_PER_PAGE).toArray();
    } else if (mode === 'albums') {
      const all = await musicCol.aggregate([{ $group: { _id: '$album', artist: { $first: '$artist' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
      total = all.length;
      items = all.slice(page * MUSIC_PER_PAGE, (page + 1) * MUSIC_PER_PAGE).map(a => ({ _id: a._id, name: a._id, artist: a.artist, count: a.count }));
    } else if (mode === 'artists') {
      const all = await musicCol.aggregate([{ $group: { _id: '$artist', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
      total = all.length;
      items = all.slice(page * MUSIC_PER_PAGE, (page + 1) * MUSIC_PER_PAGE).map(a => ({ _id: a._id, name: a._id, count: a.count }));
    } else if (mode === 'album_songs') {
      total = await musicCol.countDocuments({ album: filter });
      items = await musicCol.find({ album: filter }).sort({ trackNumber: 1 }).skip(page * MUSIC_PER_PAGE).limit(MUSIC_PER_PAGE).toArray();
    } else if (mode === 'artist_songs') {
      total = await musicCol.countDocuments({ artist: filter });
      items = await musicCol.find({ artist: filter }).sort({ album: 1, trackNumber: 1 }).skip(page * MUSIC_PER_PAGE).limit(MUSIC_PER_PAGE).toArray();
    }

    const totalPages = Math.max(1, Math.ceil(total / MUSIC_PER_PAGE));
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;

    const titles = { songs: '🎵 Песни', albums: '💿 Альбомы', artists: '🎤 Исполнители', album_songs: `💿 ${filter}`, artist_songs: `🎤 ${filter}` };
    let text = `<b>${escHtml(titles[mode] || 'Музыка')}</b> · стр. ${page + 1}/${totalPages}\n\n`;
    const kb = { inline_keyboard: [] };
    if (!items.length) { await tgBot.sendMessage(chatId, '📭 Пусто.'); return; }

    if (mode === 'songs' || mode === 'album_songs' || mode === 'artist_songs') {
      items.forEach((s, i) => {
        text += `${i + 1}. ${escHtml(s.artist)} — ${escHtml(s.title)}\n`;
        kb.inline_keyboard.push([{ text: `▶ ${s.artist} — ${s.title}`.slice(0, 60), callback_data: `music_send_${s._id}` }]);
      });
    } else if (mode === 'albums') {
      items.forEach((a, i) => {
        text += `${i + 1}. ${escHtml(a.name)} · ${a.artist} (${a.count})\n`;
        kb.inline_keyboard.push([{ text: `💿 ${a.name}`.slice(0, 60), callback_data: `music_album_${encodeURIComponent(a.name)}_0` }]);
      });
    } else if (mode === 'artists') {
      items.forEach((a, i) => {
        text += `${i + 1}. ${escHtml(a.name)} (${a.count})\n`;
        kb.inline_keyboard.push([{ text: `🎤 ${a.name}`.slice(0, 60), callback_data: `music_artist_${encodeURIComponent(a.name)}_0` }]);
      });
    }

    const nav = [];
    const prefix = mode === 'album_songs' ? `music_album_${encodeURIComponent(filter)}`
      : mode === 'artist_songs' ? `music_artist_${encodeURIComponent(filter)}`
      : `music_${mode}`;
    if (page > 0) nav.push({ text: '⏮', callback_data: `${prefix}_${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: '⏭', callback_data: `${prefix}_${page + 1}` });
    if (nav.length) kb.inline_keyboard.push(nav);
    kb.inline_keyboard.push([{ text: '🏠 Меню', callback_data: 'menu' }]);

    await tgBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    console.warn('music list:', e);
    await tgBot.sendMessage(chatId, '❌ Ошибка загрузки.');
  }
}

async function cmdPost(chatId, login, channelName, text) {
  const channels = await chatsCol.find({ owner: login, isChannel: true }).toArray();
  if (!channels.length) return tgBot.sendMessage(chatId, '❌ У тебя нет своих каналов.');
  const channel = channels.find(c => c.name.toLowerCase() === channelName.toLowerCase());
  if (!channel) {
    const list = channels.map(c => `• ${c.name}`).join('\n');
    return tgBot.sendMessage(chatId, `❌ Канал «${channelName}» не найден.\n\nТвои каналы:\n${list}`);
  }
  const user = await usersCol.findOne({ login });
  const timestamp = new Date().toISOString();
  const msgId = uuidv4();
  const doc = {
    _id: msgId, chatId: channel._id,
    sender: login, senderName: user.nickname || login,
    senderEmoji: user.nicknameEmoji || '', senderEmojiColor: user.nicknameEmojiColor || '',
    type: 'text', text: text.slice(0, MAX_MSG_LEN), fileId: null,
    reactions: [], deliveredTo: [], readBy: [],
    timestamp, replyTo: null, deleted: false, fromBot: true
  };
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
    if (file.file_size && file.file_size > MAX_FILE_SIZE) {
      return tgBot.sendMessage(chatId, `❌ Файл больше 20 МБ.`);
    }
    const chats = await chatsCol.find({ members: user.login, isChannel: { $ne: true } }).limit(10).toArray();
    if (!chats.length) return tgBot.sendMessage(chatId, '❌ У тебя нет чатов.');
    const sess = {
      _id: 'tg:' + chatId, action: 'upload_file',
      data: {
        fileId: file.file_id, fileUniqueId: file.file_unique_id,
        fileName: file.file_name || 'file',
        mimeType: file.mime_type || 'application/octet-stream',
        fileSize: file.file_size || 0
      },
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    };
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
  if (data === 'stats') {
    try { await tgBot.answerCallbackQuery(cb.id); } catch {}
    const user = await findUserByTg(chatId);
    if (user) await cmdStats(chatId, user);
    return;
  }
  if (data === 'notif_info') {
    try { await tgBot.answerCallbackQuery(cb.id, { text: 'Открой настройки в Кристе', show_alert: true }); } catch {}
    return;
  }

  let m = data.match(/^music_(songs|albums|artists)_(\d+)$/);
  if (m) { try { await tgBot.answerCallbackQuery(cb.id); } catch {} return cmdMusicList(chatId, m[1], parseInt(m[2])); }

  m = data.match(/^music_album_(.+)_(\d+)$/);
  if (m) { try { await tgBot.answerCallbackQuery(cb.id); } catch {} return cmdMusicList(chatId, 'album_songs', parseInt(m[2]), decodeURIComponent(m[1])); }

  m = data.match(/^music_artist_(.+)_(\d+)$/);
  if (m) { try { await tgBot.answerCallbackQuery(cb.id); } catch {} return cmdMusicList(chatId, 'artist_songs', parseInt(m[2]), decodeURIComponent(m[1])); }

  m = data.match(/^music_send_(.+)$/);
  if (m) {
    const id = m[1];
    const song = await musicCol.findOne({ _id: id });
    if (!song) { try { await tgBot.answerCallbackQuery(cb.id, { text: 'Не найдено' }); } catch {} return; }
    try { await tgBot.answerCallbackQuery(cb.id, { text: '🎵 Отправляю...' }); } catch {}
    try {
      await tgBot.sendAudio(chatId, song.tgFileId, {
        title: song.title, performer: song.artist,
        caption: `🎵 <b>${escHtml(song.artist)} — ${escHtml(song.title)}</b>`,
        parse_mode: 'HTML'
      });
    } catch (e) { await tgBot.sendMessage(chatId, `❌ ${e.message}`); }
    return;
  }

  m = data.match(/^chat_select_(.+)$/);
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
      let link;
      try { link = await tgBot.getFileLink(sess.data.fileId); }
      catch { throw new Error('Файл недоступен (возможно, >20 МБ)'); }
      const r = await fetch(link);
      if (!r.ok) throw new Error('Telegram недоступен');
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
    } catch (e) {
      await botSessionsCol.deleteOne({ _id: sess._id });
      await tgBot.sendMessage(chatId, `❌ ${e.message || 'Ошибка загрузки'}`);
    }
    return;
  }

  if (data === 'cancel') {
    try { await tgBot.answerCallbackQuery(cb.id, { text: 'Отменено' }); } catch {}
    await botSessionsCol.deleteOne({ _id: 'tg:' + chatId });
    return;
  }

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

    const [accounts, messagesTotal, tracks, channelsCount, chatsCount] = await Promise.all([
      usersCol.countDocuments({}),
      messagesCol.countDocuments({ deleted: { $ne: true } }),
      musicCol.countDocuments({}),
      chatsCol.countDocuments({ type: 'group', isChannel: true, published: true, isPrivate: { $ne: true } }),
      chatsCol.countDocuments({ type: 'group', isChannel: { $ne: true }, published: true, isPrivate: { $ne: true } })
    ]);
    const onlineNow = clients.size;
    const users = await usersCol.find({ tgChatId: { $ne: null }, dailyDigest: { $ne: false } }).toArray();
    for (const u of users) {
      const text = `🌸 <b>Криста — сводка</b>\n\n👥 Юзеров: <b>${accounts}</b>\n💬 Сообщений: <b>${messagesTotal}</b>\n🎵 Треков: <b>${tracks}</b>\n📢 Каналов: <b>${channelsCount}</b>\n💬 Чатов: <b>${chatsCount}</b>\n🟢 Онлайн: <b>${onlineNow}</b>\n\n💬 @${SUPPORT_TG}`;
      try { await tgBot.sendMessage(u.tgChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true }); } catch (e) {
        if (e.response?.body?.error_code === 403) await usersCol.updateOne({ login: u.login }, { $set: { tgChatId: null } });
      }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`📊 Сводка: ${users.length}`);
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

wss.on('connection', (ws) => {
  ws.isAlive = true; ws.login = null; ws.currentChatId = null; ws.lastPong = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
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
      const out = JSON.stringify({
        type: 'typing',
        payload: {
          chatId,
          login: ws.login,
          nickname: user.nickname || user.login,
          text: String(text || '').slice(0, 200)
        }
      });
      chat.members.forEach(u => { if (u === ws.login) return; const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
      return;
    }

    if (type === 'deleteChat') {
      const { chatId } = payload || {};
      const chat = await chatsCol.findOne({ _id: chatId });
      if (!chat || !chat.members.includes(ws.login)) return;
      if (chat.type === 'group' && chat.owner !== ws.login) return;
      await messagesCol.deleteMany({ chatId });
      await chatsCol.deleteOne({ _id: chatId });
      await chatThemesCol.deleteOne({ chatId });
      await foldersCol.updateMany({ owner: ws.login }, { $pull: { chatIds: chatId } });
      const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
      chat.members.forEach(u => { const c = clients.get(u); if (c?.readyState === WebSocket.OPEN) c.send(out); });
      return;
    }
  });

  ws.on('close', (e) => {
    console.log(`[WS] close code:${e.code}`);
    if (ws.login) {
      clients.delete(ws.login);
      broadcast({ type: 'status', payload: { login: ws.login, status: 'offline' } });
    }
  });
  ws.on('error', () => {});
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, c] of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🌸 Криста.Фринет v4.37 · порт ${PORT}`);
    console.log(`📦 MongoDB / ${DB_NAME}`);
    console.log(`📨 Файлы: ${tgBot ? 'ON' : 'OFF'}`);
  });
})();
