// КРИСТА.МЕССЕНДЖЕР v1.25 — СЕРВЕР
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
const LOGIN_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const BASE_URL = process.env.BASE_URL || 'https://krista-4.onrender.com';

if (!MONGO_URI) { console.error('❌ MONGO_URI не задан.'); process.exit(1); }

let usersCol, chatsCol, messagesCol, countersCol, themesCol, chatThemesCol, playlistsCol, musicCol, tgLinksCol;
const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, socketTimeoutMS: 45000 });

const TG_CHAT_ID = (process.env.TG_CHAT_ID || '').trim();
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
let tgBot = null;

if (TG_BOT_TOKEN && TG_CHAT_ID) {
  try {
    tgBot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
    console.log('📨 Telegram bot подключён');
    tgBot.getMe().then(me => console.log(`📨 Бот: @${me.username}`)).catch(e => console.error('❌ getMe:', e.message));

    // /start <code> — привязка уведомлений
    tgBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const code = (match[1] || '').trim();
      if (!code) {
        return tgBot.sendMessage(chatId, '👋 Привет! Это бот Криста.Мессенджер.\n\nЧтобы получать уведомления о новых сообщениях, открой настройки в приложении и нажми «Привязать Telegram».');
      }
      try {
        const link = await tgLinksCol.findOne({ code, expiresAt: { $gt: new Date().toISOString() } });
        if (!link) return tgBot.sendMessage(chatId, '❌ Код недействителен или истёк. Сгенерируй новый в приложении.');
        await usersCol.updateOne({ login: link.login }, { $set: { tgChatId: chatId } });
        await tgLinksCol.deleteOne({ _id: link._id });
        tgBot.sendMessage(chatId, `✅ Готово! Теперь уведомления для <b>@${link.login}</b> будут приходить сюда.`, { parse_mode: 'HTML' });
      } catch (e) {
        console.error('TG link:', e);
        tgBot.sendMessage(chatId, '❌ Ошибка привязки');
      }
    });

    tgBot.on('polling_error', e => console.warn('TG polling:', e.message));
    tgBot.getChat(TG_CHAT_ID).then(c => console.log(`📨 Канал: ${c.title || c.username || c.id}`)).catch(e => console.error('❌ getChat:', e.response?.body?.description || e.message));
  } catch (e) { console.error('❌ Ошибка Telegram:', e.message); }
} else {
  console.warn('⚠️  TG_BOT_TOKEN или TG_CHAT_ID не заданы');
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });
const pendingMusic = new Map(); // token -> {buffer, meta, login, expiresAt}

async function connectDB() {
  let attempt = 0;
  while (attempt < 5) {
    try {
      attempt++;
      console.log(`🔌 MongoDB: попытка ${attempt}/5...`);
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      usersCol = db.collection('users');
      chatsCol = db.collection('chats');
      messagesCol = db.collection('messages');
      countersCol = db.collection('counters');
      themesCol = db.collection('themes');
      chatThemesCol = db.collection('chat_themes');
      playlistsCol = db.collection('playlists');
      musicCol = db.collection('music');
      tgLinksCol = db.collection('tg_links');

      try { await usersCol.createIndex({ login: 1 }, { unique: true, sparse: true }); } catch {}
      try { await chatsCol.createIndex({ login: 1 }, { unique: true, sparse: true }); } catch {}
      try { await chatsCol.createIndex({ members: 1 }); } catch {}
      try { await messagesCol.createIndex({ chatId: 1, timestamp: 1 }); } catch {}
      try { await musicCol.createIndex({ title: 1 }); } catch {}
      try { await musicCol.createIndex({ artist: 1 }); } catch {}
      try { await musicCol.createIndex({ album: 1 }); } catch {}
      try { await playlistsCol.createIndex({ owner: 1 }); } catch {}
      try { await tgLinksCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch {}

      console.log('✅ MongoDB подключена');
      return;
    } catch (err) {
      console.error(`❌ ${err.message}`);
      if (attempt >= 5) process.exit(1);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const generateToken = (login) => jwt.sign({ login }, JWT_SECRET, { expiresIn: '30d' });
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function validateLogin(login) {
  if (typeof login !== 'string') return 'Логин обязателен';
  if (login.length < 3 || login.length > 32) return 'Логин: 3-32 символа';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) return 'Логин: буквы, цифры, _ и -, начинается с буквы или цифры';
  return null;
}

async function nextNumber() {
  const r = await countersCol.findOneAndUpdate(
    { _id: 'file_number' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return r.value;
}

function publicUser(doc) {
  if (!doc) return null;
  return {
    login: doc.login,
    nickname: doc.nickname || doc.login,
    theme: doc.theme || 'dark',
    accentColor: doc.accentColor || '#f0a0c8',
    topBarColor: doc.topBarColor || '#f0a0c8',
    nicknameColor: doc.nicknameColor || '#f0a0c8',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#f0a0c8',
    avatarType: doc.avatarType || 'initial',
    avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#f0a0c8',
    avatarFileId: doc.avatarFileId || null,
    loginChangeableAt: doc.loginChangeableAt || null,
    tgChatId: !!doc.tgChatId,
    createdAt: doc.createdAt,
    lastSeen: doc.lastSeen
  };
}

function publicUserShort(doc) {
  if (!doc) return null;
  return {
    login: doc.login,
    nickname: doc.nickname || doc.login,
    nicknameColor: doc.nicknameColor || '#f0a0c8',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#f0a0c8',
    avatarType: doc.avatarType || 'initial',
    avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#f0a0c8',
    avatarFileId: doc.avatarFileId || null,
    online: clients.has(doc.login)
  };
}

function publicMessage(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    clientId: doc.clientId || null,
    chatId: doc.chatId,
    sender: doc.sender,
    senderName: doc.senderName,
    senderEmoji: doc.senderEmoji || '',
    senderEmojiColor: doc.senderEmojiColor || '',
    type: doc.type || 'text',
    text: doc.text,
    file: doc.file || null,
    timestamp: doc.timestamp,
    replyTo: doc.replyTo || null,
    deleted: doc.deleted ? 1 : 0
  };
}

const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Требуется авторизация' });
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) return res.status(401).json({ error: 'Неверный токен' });
  req.userLogin = decoded.login;
  next();
}

// ============================================================
//  AUTH
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { login, nickname, password, confirmPassword } = req.body || {};
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    if (!nickname || nickname.length < 1 || nickname.length > 30) return res.status(400).json({ error: 'Ник: 1-30 символов' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ error: 'Пароли не совпадают' });
    const existing = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (existing) return res.status(400).json({ error: 'Логин занят' });
    const now = new Date().toISOString();
    const doc = {
      login, password: await bcrypt.hash(password, 10), nickname: nickname.trim(),
      theme: 'dark', accentColor: '#f0a0c8', topBarColor: '#f0a0c8',
      nicknameColor: '#f0a0c8', nicknameEmoji: '', nicknameEmojiColor: '#f0a0c8',
      avatarType: 'initial', avatarEmoji: '', avatarBgColor: '#f0a0c8', avatarFileId: null,
      tgChatId: null, loginChangeableAt: null,
      createdAt: now, lastSeen: now
    };
    await usersCol.insertOne(doc);
    res.status(201).json({ success: true, login, nickname: doc.nickname, token: generateToken(login) });
  } catch (err) { console.error('Register:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ error: 'Заполните поля' });
    const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверный пароль' });
    await usersCol.updateOne({ login: user.login }, { $set: { lastSeen: new Date().toISOString() } });
    res.json({ success: true, login: user.login, nickname: user.nickname, token: generateToken(user.login) });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(publicUser(user));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const updates = {};
    let newLogin = null;

    if (b.newLogin !== undefined && b.newLogin !== user.login) {
      const loginErr = validateLogin(b.newLogin);
      if (loginErr) return res.status(400).json({ error: loginErr });
      if (user.loginChangeableAt && Date.now() < new Date(user.loginChangeableAt).getTime()) {
        return res.status(429).json({ error: 'Логин можно менять раз в день' });
      }
      if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(b.newLogin) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
      newLogin = b.newLogin;
      updates.login = b.newLogin;
      updates.loginChangeableAt = new Date(Date.now() + LOGIN_CHANGE_COOLDOWN_MS).toISOString();
    }

    if (b.nickname !== undefined) {
      if (b.nickname.length < 1 || b.nickname.length > 30) return res.status(400).json({ error: 'Ник: 1-30 символов' });
      updates.nickname = b.nickname.trim();
    }
    if (b.newPassword) {
      if (!b.password || !(await bcrypt.compare(b.password, user.password))) return res.status(401).json({ error: 'Неверный пароль' });
      if (b.newPassword.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
      updates.password = await bcrypt.hash(b.newPassword, 10);
    }
    if (b.theme !== undefined && ['dark', 'light'].includes(b.theme)) updates.theme = b.theme;
    if (b.accentColor !== undefined) updates.accentColor = String(b.accentColor).slice(0, 20);
    if (b.topBarColor !== undefined) updates.topBarColor = String(b.topBarColor).slice(0, 20);
    if (b.nicknameColor !== undefined) updates.nicknameColor = String(b.nicknameColor).slice(0, 20);
    if (b.nicknameEmoji !== undefined) updates.nicknameEmoji = String(b.nicknameEmoji).slice(0, 8);
    if (b.nicknameEmojiColor !== undefined) updates.nicknameEmojiColor = String(b.nicknameEmojiColor).slice(0, 20);
    if (b.avatarType !== undefined && ['initial', 'emoji', 'image'].includes(b.avatarType)) updates.avatarType = b.avatarType;
    if (b.avatarEmoji !== undefined) updates.avatarEmoji = String(b.avatarEmoji).slice(0, 8);
    if (b.avatarBgColor !== undefined) updates.avatarBgColor = String(b.avatarBgColor).slice(0, 20);
    if (b.avatarFileId !== undefined) updates.avatarFileId = b.avatarFileId || null;
    if (b.tgChatId !== undefined) updates.tgChatId = b.tgChatId;

    if (Object.keys(updates).length === 0) return res.json({ success: true });
    await usersCol.updateOne({ login: req.userLogin }, { $set: updates });

    if (newLogin) {
      const oldLogin = req.userLogin;
      await chatsCol.updateMany({ members: oldLogin }, { $set: { 'members.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await chatsCol.updateMany({ admins: oldLogin }, { $set: { 'admins.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await chatsCol.updateMany({ owner: oldLogin }, { $set: { owner: newLogin } });
      await messagesCol.updateMany({ sender: oldLogin }, { $set: { sender: newLogin } });
      const newToken = generateToken(newLogin);
      const fresh = await usersCol.findOne({ login: newLogin });
      broadcast({ type: 'userUpdated', payload: publicUserShort(fresh) });
      return res.json({ success: true, newLogin, newToken });
    }

    const fresh = await usersCol.findOne({ login: req.userLogin });
    broadcast({ type: 'userUpdated', payload: publicUserShort(fresh) });
    res.json({ success: true });
  } catch (err) { console.error('Update me:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/me', authMiddleware, async (req, res) => {
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
    await usersCol.deleteOne({ login });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  STATS
// ============================================================
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const accounts = await usersCol.countDocuments({});
    res.json({ accounts, online: clients.size });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  USERS
// ============================================================
app.get('/api/users/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'Логин обязателен' });
    const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ...publicUserShort(user), online: clients.has(user.login) });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    if (q.length < 1) return res.json({ users: [], chats: [] });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await usersCol.find({ login: { $ne: req.userLogin }, $or: [{ login: regex }, { nickname: regex }] }).limit(15).toArray();
    const groups = await chatsCol.find({ type: 'group', $or: [{ login: regex }, { name: regex }] }).limit(15).toArray();
    res.json({
      users: users.map(publicUserShort),
      chats: groups.map(g => ({ id: g._id, login: g.login, name: g.name, membersCount: g.members.length, isPrivate: !!g.isPrivate, isMember: g.members.includes(req.userLogin) }))
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  CATALOG
// ============================================================
app.get('/api/catalog', authMiddleware, async (req, res) => {
  try {
    const list = await chatsCol.find({ type: 'group', published: true }).toArray();
    const sorted = list.sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0));
    res.json(sorted.map((g, i) => ({
      rank: i + 1, id: g._id, login: g.login, name: g.name,
      membersCount: g.members.length, isChannel: !!g.isChannel,
      isMember: g.members.includes(req.userLogin)
    })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/chats/find/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'Логин обязателен' });
    const chat = await chatsCol.findOne({ type: 'group', login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.isPrivate && !chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Приватный чат' });
    res.json({ id: chat._id, login: chat.login, name: chat.name, membersCount: chat.members.length, isPrivate: !!chat.isPrivate, isChannel: !!chat.isChannel, isMember: chat.members.includes(req.userLogin), published: !!chat.published });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  CHATS
// ============================================================
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = await usersCol.findOne({ login: req.userLogin });
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    const myChats = await chatsCol.find({ members: req.userLogin }).toArray();
    const result = [];
    for (const chat of myChats) {
      const isGroup = chat.type === 'group';
      let title, otherLogin = null, otherUser = null;
      if (isGroup) {
        title = chat.name;
      } else {
        otherLogin = chat.members.find(u => u !== req.userLogin);
        otherUser = otherLogin ? await usersCol.findOne({ login: otherLogin }) : null;
        title = otherUser?.nickname || otherUser?.login || '???';
      }
      const lastMsg = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } }).sort({ timestamp: -1 }).limit(1).next();
      let unread = 0;
      if (me.lastSeen) unread = await messagesCol.countDocuments({ chatId: chat._id, sender: { $ne: req.userLogin }, timestamp: { $gt: me.lastSeen }, deleted: { $ne: true } });
      const ct = await chatThemesCol.findOne({ chatId: chat._id });
      result.push({
        id: chat._id, type: chat.type || 'dialog', isGroup,
        isPrivate: !!chat.isPrivate, isChannel: !!chat.isChannel, published: !!chat.published,
        isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
        name: title, login: chat.login || null, membersCount: chat.members.length,
        otherLogin, otherUser: otherUser ? publicUserShort(otherUser) : null,
        lastMessage: lastMsg ? publicMessage(lastMsg) : null,
        unreadCount: unread, updatedAt: chat.updatedAt,
        hasTheme: !!ct
      });
    }
    res.json(result);
  } catch (err) { console.error('Chats:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ error: 'Неверный логин' });
    if (login.toLowerCase() === req.userLogin.toLowerCase()) return res.status(400).json({ error: 'Нельзя добавить себя' });
    const other = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!other) return res.status(404).json({ error: 'Пользователь не найден' });
    const existing = await chatsCol.findOne({ type: { $in: ['dialog', null] }, members: { $all: [req.userLogin, other.login], $size: 2 } });
    if (existing) return res.json({ success: true, chatId: existing._id, existing: true });
    const chatId = uuidv4();
    await chatsCol.insertOne({ _id: chatId, type: 'dialog', members: [req.userLogin, other.login], admins: [], owner: null, updatedAt: new Date().toISOString() });
    const c = clients.get(other.login);
    if (c && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'chatCreated', payload: { chatId } }));
    res.status(201).json({ success: true, chatId });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, login, members, isPrivate, isChannel, published } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60 символов' });
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    if (await chatsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят пользователем' });
    const arr = Array.isArray(members) ? members : [];
    const uniq = [...new Set(arr.filter(u => typeof u === 'string' && u.length > 0))];
    for (const u of uniq) if (!(await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(u) + '$', 'i') } }))) return res.status(404).json({ error: `Пользователь ${u} не найден` });
    const chatId = uuidv4();
    const allMembers = [...new Set([req.userLogin, ...uniq])];
    await chatsCol.insertOne({ _id: chatId, type: 'group', name: name.trim(), login, members: allMembers, admins: [req.userLogin], owner: req.userLogin, isPrivate: !!isPrivate, isChannel: !!isChannel, published: !!published, updatedAt: new Date().toISOString() });
    const payload = JSON.stringify({ type: 'chatCreated', payload: { chatId } });
    allMembers.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(payload); });
    res.status(201).json({ success: true, chatId, login });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/chats/:chatId/join', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.members.includes(req.userLogin)) return res.json({ success: true });
    if (chat.isPrivate) return res.status(403).json({ error: 'Приватный чат' });
    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, login: req.userLogin } });
    [...chat.members, req.userLogin].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/chats/:chatId/leave', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.owner === req.userLogin) return res.status(400).json({ error: 'Владелец не может выйти' });
    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: req.userLogin, admins: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, login: req.userLogin } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
    if (chat.type === 'group' && chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });
    await messagesCol.deleteMany({ chatId: chat._id });
    await chatsCol.deleteOne({ _id: chat._id });
    await chatThemesCol.deleteOne({ chatId: chat._id });
    const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId: chat._id } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/chats/:chatId/info', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin) && chat.isPrivate) return res.status(403).json({ error: 'Нет доступа' });
    const membersInfo = [];
    for (const login of chat.members) {
      const u = await usersCol.findOne({ login });
      if (u) membersInfo.push({ ...publicUserShort(u), isAdmin: (chat.admins || []).includes(login), isOwner: chat.owner === login, online: clients.has(login) });
    }
    res.json({
      id: chat._id, type: chat.type || 'dialog', members: chat.members, admins: chat.admins || [],
      owner: chat.owner || null, name: chat.name || null, login: chat.login || null,
      isPrivate: !!chat.isPrivate, isChannel: !!chat.isChannel, published: !!chat.published,
      updatedAt: chat.updatedAt, membersInfo,
      isMember: chat.members.includes(req.userLogin),
      isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
      isOwner: chat.owner === req.userLogin
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60 символов' });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });
    await chatsCol.updateOne({ _id: chat._id }, { $set: { name: name.trim(), updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'chatRenamed', payload: { chatId: chat._id, name: name.trim() } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/login', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });
    if (await chatsCol.findOne({ _id: { $ne: chat._id }, login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят пользователем' });
    await chatsCol.updateOne({ _id: chat._id }, { $set: { login, updatedAt: new Date().toISOString() } });
    res.json({ success: true, login });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/flags', authMiddleware, async (req, res) => {
  try {
    const { isPrivate, isChannel, published } = req.body || {};
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });
    const up = { updatedAt: new Date().toISOString() };
    if (isPrivate !== undefined) up.isPrivate = !!isPrivate;
    if (isChannel !== undefined) up.isChannel = !!isChannel;
    if (published !== undefined) up.published = !!published;
    await chatsCol.updateOne({ _id: chat._id }, { $set: up });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/chats/:chatId/members/:login', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });
    const target = req.params.login;
    if (target === chat.owner) return res.status(400).json({ error: 'Владельца нельзя' });
    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: target, admins: target }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, login: target } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/chats/:chatId/members', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ error: 'Неверный логин' });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });
    if (chat.members.includes(login)) return res.status(400).json({ error: 'Уже участник' });
    const user = await usersCol.findOne({ login });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: login }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, login, nickname: user.nickname } });
    [...chat.members, login].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/members/:login/admin', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });
    const target = req.params.login;
    if (target === chat.owner) return res.status(400).json({ error: 'Владельца нельзя снять' });
    const isAdmin = (chat.admins || []).includes(target);
    if (isAdmin) await chatsCol.updateOne({ _id: chat._id }, { $pull: { admins: target } });
    else await chatsCol.updateOne({ _id: chat._id }, { $addToSet: { admins: target } });
    const out = JSON.stringify({ type: 'adminChanged', payload: { chatId: chat._id, login: target, isAdmin: !isAdmin } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true, isAdmin: !isAdmin });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  CHAT THEMES
// ============================================================
app.get('/api/chats/:chatId/theme', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat || !chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
    const t = await chatThemesCol.findOne({ chatId: req.params.chatId });
    res.json(t || null);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/theme', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.admins || []).includes(req.userLogin) && chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только админ' });
    const theme = req.body || {};
    await chatThemesCol.updateOne({ chatId: req.params.chatId }, { $set: { chatId: req.params.chatId, theme, updatedAt: new Date().toISOString() } }, { upsert: true });
    const out = JSON.stringify({ type: 'chatThemeChanged', payload: { chatId: req.params.chatId, theme } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/chats/:chatId/theme', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.admins || []).includes(req.userLogin) && chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только админ' });
    await chatThemesCol.deleteOne({ chatId: req.params.chatId });
    const out = JSON.stringify({ type: 'chatThemeChanged', payload: { chatId: req.params.chatId, theme: null } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  MESSAGES
// ============================================================
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
    const msgs = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } }).sort({ timestamp: 1 }).limit(500).toArray();
    await usersCol.updateOne({ login: req.userLogin }, { $set: { lastSeen: new Date().toISOString() } });
    res.json(msgs.map(publicMessage));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const { text, clientId, replyTo } = req.body || {};
    const result = await processNewMessage(req.params.chatId, req.userLogin, text, clientId, replyTo);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.status(201).json(result.message);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

async function processNewMessage(chatId, senderLogin, text, clientId, replyTo) {
  if (!chatId || typeof text !== 'string') return { error: 'Неверные данные', code: 400 };
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Пустое сообщение', code: 400 };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { error: 'Слишком длинное', code: 400 };
  const chat = await chatsCol.findOne({ _id: chatId });
  if (!chat) return { error: 'Чат не найден', code: 404 };
  if (!chat.members.includes(senderLogin)) return { error: 'Вы не участник', code: 403 };
  if (chat.isChannel && !(chat.admins || []).includes(senderLogin) && chat.owner !== senderLogin) return { error: 'В канале пишут только админы', code: 403 };
  const user = await usersCol.findOne({ login: senderLogin });
  if (!user) return { error: 'Пользователь не найден', code: 404 };
  const msgId = clientId || uuidv4();
  if (clientId) {
    const exists = await messagesCol.findOne({ _id: msgId });
    if (exists) return { message: publicMessage(exists), duplicate: true };
  }
  let validReply = null;
  if (replyTo) {
    const parent = await messagesCol.findOne({ _id: replyTo, chatId, deleted: { $ne: true } });
    if (parent) validReply = parent._id;
  }
  const timestamp = new Date().toISOString();
  const msgDoc = {
    _id: msgId, clientId: clientId || null, chatId,
    sender: senderLogin, senderName: user.nickname || user.login,
    senderEmoji: user.nicknameEmoji || '', senderEmojiColor: user.nicknameEmojiColor || '',
    type: 'text', text: trimmed, timestamp, replyTo: validReply, deleted: false
  };
  await messagesCol.insertOne(msgDoc);
  await chatsCol.updateOne({ _id: chatId }, { $set: { updatedAt: timestamp } });
  await usersCol.updateOne({ login: senderLogin }, { $set: { lastSeen: timestamp } });
  const publicMsg = publicMessage(msgDoc);
  const out = JSON.stringify({ type: 'newMessage', payload: publicMsg });
  chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });

  // TG-уведомления другим участникам
  sendTelegramNotifications(chat, senderLogin, publicMsg);

  return { message: publicMsg };
}

// ============================================================
//  TELEGRAM NOTIFICATIONS
// ============================================================
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function sendTelegramNotifications(chat, senderLogin, msg) {
  if (!tgBot) return;
  try {
    const chatName = chat.type === 'group' ? chat.name : (chat.login ? '@' + chat.login : 'личный чат');
    let preview = msg.text || '';
    if (msg.type === 'file' && msg.file) preview = '📎 ' + msg.file.name;
    if (preview.length > 200) preview = preview.slice(0, 197) + '…';
    const text = `💬 <b>Новое сообщение от @${escapeHtml(senderLogin)}</b>\n\n<blockquote>${escapeHtml(preview)}</blockquote>\n\n<i><u><a href="${BASE_URL}">Открыть</a></u></i>`;
    for (const u of chat.members) {
      if (u === senderLogin) continue;
      const recipient = await usersCol.findOne({ login: u });
      if (!recipient || !recipient.tgChatId) continue;
      // если получатель сейчас в этом чате онлайн — пропускаем
      const wsCl = clients.get(u);
      if (wsCl && wsCl.currentChatId === chat._id) continue;
      try {
        await tgBot.sendMessage(recipient.tgChatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
      } catch (e) {
        if (e.response?.body?.error_code === 403) {
          await usersCol.updateOne({ login: u }, { $set: { tgChatId: null } });
        }
      }
    }
  } catch (e) { console.warn('TG notif:', e.message); }
}

// ============================================================
//  FILES (via Telegram)
// ============================================================
function guessFileKind(mime) {
  if (!mime) return 'doc';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'doc';
}
function fileIconEmoji(kind) {
  return { image: '🖼', audio: '🎵', video: '🎬', doc: '📎' }[kind] || '📎';
}
function formatBytes(n) {
  if (!n) return '0 Б';
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
  return (n / 1024 / 1024).toFixed(2) + ' МБ';
}

function buildCaption({ number, category, uploader, uploaderNick, chatName, size, mime, filename, extra }) {
  const lines = [`#${String(number).padStart(4, '0')} · #${category}`];
  lines.push(`👤 @${uploader}${uploaderNick && uploaderNick !== uploader ? ' · ' + uploaderNick : ''}`);
  if (chatName) lines.push(`💬 ${chatName}`);
  if (extra) lines.push(extra);
  lines.push(`📦 ${formatBytes(size)} · ${mime || 'application/octet-stream'}`);
  lines.push(`📁 ${filename}`);
  return lines.join('\n');
}

async function sendToTelegram(buffer, filename, mimetype, caption) {
  const stream = Readable.from(buffer);
  const msg = await tgBot.sendDocument(
    TG_CHAT_ID, stream,
    { caption },
    { filename, contentType: mimetype || 'application/octet-stream' }
  );
  const fileId = msg.document?.file_id || msg.video?.file_id || msg.audio?.file_id || msg.voice?.file_id || msg.animation?.file_id || (msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null);
  if (!fileId) throw new Error('Telegram без file_id');
  return fileId;
}

app.post('/api/upload', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Отправлять файл не более 20 мб' });
      return res.status(400).json({ error: 'Ошибка загрузки: ' + (err.message || 'unknown') });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Загрузка временно недоступна' });
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const { chatId, clientId, replyTo, caption, purpose } = req.body || {};
    if (!chatId && purpose !== 'avatar') return res.status(400).json({ error: 'Не указан чат' });

    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // Avatar upload (special case)
    if (purpose === 'avatar') {
      const num = await nextNumber();
      const filename = `avatar-${req.userLogin}.jpg`;
      const cap = buildCaption({ number: num, category: 'avatar', uploader: req.userLogin, uploaderNick: user.nickname, chatName: null, size: req.file.size, mime: req.file.mimetype, filename });
      const fileId = await sendToTelegram(req.file.buffer, filename, req.file.mimetype, cap);
      await usersCol.updateOne({ login: req.userLogin }, { $set: { avatarFileId: fileId, avatarType: 'image' } });
      return res.json({ success: true, fileId });
    }

    const chat = await chatsCol.findOne({ _id: chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Вы не участник' });

    const { originalname, mimetype, size, buffer } = req.file;
    const num = await nextNumber();
    const kind = guessFileKind(mimetype);
    const chatName = chat.type === 'group' ? (chat.name + (chat.login ? ' · @' + chat.login : '')) : null;
    const cap = buildCaption({ number: num, category: 'file', uploader: req.userLogin, uploaderNick: user.nickname, chatName, size, mime: mimetype, filename: originalname });

    let fileId;
    try { fileId = await sendToTelegram(buffer, originalname, mimetype, cap); }
    catch (e) {
      const detail = e.response?.body?.description || e.message;
      console.error('TG upload:', detail);
      return res.status(502).json({ error: 'Telegram: ' + detail });
    }

    const msgId = clientId || uuidv4();
    const timestamp = new Date().toISOString();
    const msgDoc = {
      _id: msgId, clientId: clientId || null, chatId,
      sender: req.userLogin, senderName: user.nickname || user.login,
      senderEmoji: user.nicknameEmoji || '', senderEmojiColor: user.nicknameEmojiColor || '',
      type: 'file', text: (caption || '').toString().slice(0, MAX_MESSAGE_LENGTH),
      file: { number: num, fileId, name: originalname, size, mime: mimetype, kind },
      timestamp, replyTo: null, deleted: false
    };
    if (replyTo) {
      const parent = await messagesCol.findOne({ _id: replyTo, chatId, deleted: { $ne: true } });
      if (parent) msgDoc.replyTo = parent._id;
    }
    await messagesCol.insertOne(msgDoc);
    await chatsCol.updateOne({ _id: chatId }, { $set: { updatedAt: timestamp } });
    await usersCol.updateOne({ login: req.userLogin }, { $set: { lastSeen: timestamp } });

    const pub = publicMessage(msgDoc);
    const out = JSON.stringify({ type: 'newMessage', payload: pub });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    sendTelegramNotifications(chat, req.userLogin, pub);
    res.status(201).json(pub);
  } catch (err) {
    console.error('Upload:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/file/:messageId', authMiddleware, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Недоступно' });
    const msg = await messagesCol.findOne({ _id: req.params.messageId });
    if (!msg || !msg.file || msg.deleted) return res.status(404).json({ error: 'Файл не найден' });
    const chat = await chatsCol.findOne({ _id: msg.chatId });
    if (!chat || !chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
    let url;
    try { url = await tgBot.getFileLink(msg.file.fileId); }
    catch (e) { return res.status(502).json({ error: 'Файл недоступен' }); }
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Telegram недоступен' });
    res.setHeader('Content-Type', msg.file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(msg.file.name || 'file')}`);
    const cl = r.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) { console.error('File proxy:', err); if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Прямой доступ к file_id (для аватаров, музыки, обоев)
app.get('/api/fileById/:fileId', authMiddleware, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Недоступно' });
    const fileId = req.params.fileId;
    let url;
    try { url = await tgBot.getFileLink(fileId); } catch { return res.status(404).json({ error: 'Файл недоступен' }); }
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Telegram недоступен' });
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  MUSIC
// ============================================================
function sanitizeFilename(s) {
  return String(s || '').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120);
}

// 1. Staging (в памяти)
app.post('/api/music/stage', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Отправлять файл не более 20 мб' });
      return res.status(400).json({ error: 'Ошибка загрузки: ' + (err.message || 'unknown') });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const { artist, album, trackTitle, trackNumber } = req.body || {};
    if (!artist || !trackTitle) return res.status(400).json({ error: 'Укажи исполнителя и название' });
    const token = uuidv4();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    pendingMusic.set(token, {
      buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size,
      originalname: req.file.originalname,
      artist: String(artist).slice(0, 80),
      album: String(album || 'Сингл').slice(0, 80),
      trackTitle: String(trackTitle).slice(0, 120),
      trackNumber: parseInt(trackNumber) || 1,
      login: req.userLogin, expiresAt
    });
    res.json({ success: true, token, preview: `${sanitizeFilename(artist)}-${sanitizeFilename(trackTitle)}` });
  } catch (err) { console.error('Music stage:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// 2. Publish
app.post('/api/music/publish', authMiddleware, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Недоступно' });
    const { token } = req.body || {};
    const p = pendingMusic.get(token);
    if (!p || p.expiresAt < Date.now()) { pendingMusic.delete(token); return res.status(404).json({ error: 'Черновик истёк' }); }
    if (p.login !== req.userLogin) return res.status(403).json({ error: 'Нет доступа' });

    const user = await usersCol.findOne({ login: req.userLogin });
    const ext = (p.originalname.match(/\.[a-z0-9]+$/i) || ['.mp3'])[0];
    const filename = `${sanitizeFilename(p.artist)}-${sanitizeFilename(p.trackTitle)}${ext}`;
    const num = await nextNumber();
    const extra = `🎵 ${p.artist} · ${p.trackTitle}\n💿 ${p.album} · #${p.trackNumber}`;
    const cap = buildCaption({ number: num, category: 'music', uploader: p.login, uploaderNick: user?.nickname, chatName: null, size: p.size, mime: p.mimetype, filename, extra });

    let fileId;
    try { fileId = await sendToTelegram(p.buffer, filename, p.mimetype, cap); }
    catch (e) { console.error('TG music:', e.response?.body?.description || e.message); return res.status(502).json({ error: 'Telegram: ' + (e.response?.body?.description || e.message) }); }
    pendingMusic.delete(token);

    const doc = {
      _id: uuidv4(), number: num, fileId, filename,
      artist: p.artist, album: p.album, title: p.trackTitle, trackNumber: p.trackNumber,
      size: p.size, mime: p.mimetype, uploadedBy: p.login, uploadedAt: new Date().toISOString()
    };
    await musicCol.insertOne(doc);
    broadcast({ type: 'musicAdded', payload: { id: doc._id } });
    res.json({ success: true, track: doc });
  } catch (err) { console.error('Music publish:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// cleanup просроченных staging
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingMusic) if (v.expiresAt < now) pendingMusic.delete(k);
}, 60000);

// 3. List songs
app.get('/api/music/songs', authMiddleware, async (req, res) => {
  try {
    const songs = await musicCol.find({}).sort({ title: 1 }).toArray();
    res.json(songs.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, uploadedBy: s.uploadedBy, filename: s.filename })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// 4. Albums
app.get('/api/music/albums', authMiddleware, async (req, res) => {
  try {
    const albums = await musicCol.aggregate([
      { $group: { _id: '$album', artist: { $first: '$artist' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();
    res.json(albums.map(a => ({ album: a._id, artist: a.artist, count: a.count })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/music/albums/:album', authMiddleware, async (req, res) => {
  try {
    const album = decodeURIComponent(req.params.album);
    const songs = await musicCol.find({ album }).sort({ trackNumber: 1 }).toArray();
    res.json(songs.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, uploadedBy: s.uploadedBy, filename: s.filename })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// 5. Artists
app.get('/api/music/artists', authMiddleware, async (req, res) => {
  try {
    const artists = await musicCol.aggregate([
      { $group: { _id: '$artist', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();
    res.json(artists.map(a => ({ artist: a._id, count: a.count })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/music/artists/:artist', authMiddleware, async (req, res) => {
  try {
    const artist = decodeURIComponent(req.params.artist);
    const songs = await musicCol.find({ artist }).sort({ album: 1, trackNumber: 1 }).toArray();
    res.json(songs.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, uploadedBy: s.uploadedBy, filename: s.filename })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// 6. Playlists
app.get('/api/music/playlists', authMiddleware, async (req, res) => {
  try {
    const pls = await playlistsCol.find({ owner: req.userLogin }).sort({ name: 1 }).toArray();
    res.json(pls.map(p => ({ id: p._id, name: p.name, count: (p.trackIds || []).length })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/music/playlists', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Введи название' });
    const doc = { _id: uuidv4(), owner: req.userLogin, name: name.trim().slice(0, 60), trackIds: [], createdAt: new Date().toISOString() };
    await playlistsCol.insertOne(doc);
    res.json({ success: true, id: doc._id, name: doc.name, count: 0 });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/music/playlists/:id', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Введи название' });
    const pl = await playlistsCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!pl) return res.status(404).json({ error: 'Плейлист не найден' });
    await playlistsCol.updateOne({ _id: pl._id }, { $set: { name: name.trim().slice(0, 60) } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/music/playlists/:id', authMiddleware, async (req, res) => {
  try {
    await playlistsCol.deleteOne({ _id: req.params.id, owner: req.userLogin });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/music/playlists/:id/tracks', authMiddleware, async (req, res) => {
  try {
    const pl = await playlistsCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!pl) return res.status(404).json({ error: 'Плейлист не найден' });
    const tracks = await musicCol.find({ _id: { $in: pl.trackIds || [] } }).toArray();
    const ordered = (pl.trackIds || []).map(id => tracks.find(t => t._id === id)).filter(Boolean);
    res.json({ name: pl.name, tracks: ordered.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size })) });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/music/playlists/:id/tracks', authMiddleware, async (req, res) => {
  try {
    const { trackId } = req.body || {};
    const pl = await playlistsCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!pl) return res.status(404).json({ error: 'Плейлист не найден' });
    if ((pl.trackIds || []).includes(trackId)) {
      await playlistsCol.updateOne({ _id: pl._id }, { $pull: { trackIds: trackId } });
      return res.json({ success: true, added: false });
    }
    await playlistsCol.updateOne({ _id: pl._id }, { $push: { trackIds: trackId } });
    res.json({ success: true, added: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/music/playlists/:id/tracks/:trackId', authMiddleware, async (req, res) => {
  try {
    await playlistsCol.updateOne({ _id: req.params.id, owner: req.userLogin }, { $pull: { trackIds: req.params.trackId } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// 7. Delete track (only uploader)
app.delete('/api/music/tracks/:id', authMiddleware, async (req, res) => {
  try {
    const t = await musicCol.findOne({ _id: req.params.id });
    if (!t) return res.status(404).json({ error: 'Трек не найден' });
    if (t.uploadedBy !== req.userLogin) return res.status(403).json({ error: 'Не твой трек' });
    await musicCol.deleteOne({ _id: t._id });
    await playlistsCol.updateMany({ owner: req.userLogin }, { $pull: { trackIds: t._id } });
    broadcast({ type: 'musicRemoved', payload: { id: t._id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  THEMES
// ============================================================
app.get('/api/themes', authMiddleware, async (req, res) => {
  try {
    const list = await themesCol.find({ owner: req.userLogin }).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/themes', authMiddleware, async (req, res) => {
  try {
    const { name, data } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Введи название темы' });
    const doc = { _id: uuidv4(), owner: req.userLogin, name: name.trim().slice(0, 60), data: data || {}, createdAt: new Date().toISOString() };
    await themesCol.insertOne(doc);
    res.json(doc);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/themes/:id', authMiddleware, async (req, res) => {
  try {
    const { name, data } = req.body || {};
    const t = await themesCol.findOne({ _id: req.params.id, owner: req.userLogin });
    if (!t) return res.status(404).json({ error: 'Тема не найдена' });
    const up = {};
    if (name) up.name = name.trim().slice(0, 60);
    if (data) up.data = data;
    await themesCol.updateOne({ _id: t._id }, { $set: up });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/themes/:id', authMiddleware, async (req, res) => {
  try {
    await themesCol.deleteOne({ _id: req.params.id, owner: req.userLogin });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  TG LINK
// ============================================================
app.post('/api/tg/link', authMiddleware, async (req, res) => {
  try {
    if (!tgBot) return res.status(503).json({ error: 'Telegram недоступен' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await tgLinksCol.deleteMany({ login: req.userLogin });
    await tgLinksCol.insertOne({ login: req.userLogin, code, expiresAt, createdAt: new Date().toISOString() });
    const botInfo = await tgBot.getMe();
    res.json({ success: true, code, botUsername: botInfo.username, expiresAt });
  } catch (err) { console.error('TG link:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/tg/unlink', authMiddleware, async (req, res) => {
  try {
    await usersCol.updateOne({ login: req.userLogin }, { $set: { tgChatId: null } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

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
  if (cur.count >= 15) return false;
  cur.count++;
  return true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.login = null;
  ws.currentChatId = null;
  ws.lastPong = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
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
      return;
    }

    if (type === 'newMessage') {
      try {
        const { chatId, text, replyTo, clientId } = payload || {};
        const result = await processNewMessage(chatId, ws.login, text, clientId, replyTo);
        if (result.error) { ws.send(JSON.stringify({ type: 'error', payload: { clientId, error: result.error } })); return; }
        if (result.duplicate) ws.send(JSON.stringify({ type: 'messageAck', payload: { clientId, id: result.message.id } }));
      } catch (err) { console.error('WS newMessage:', err); }
      return;
    }

    if (type === 'deleteMessage') {
      try {
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
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }

    if (type === 'typing') {
      try {
        const { chatId } = payload || {};
        if (!chatId) return;
        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.login)) return;
        const user = await usersCol.findOne({ login: ws.login }, { projection: { nickname: 1, login: 1 } });
        if (!user) return;
        const out = JSON.stringify({ type: 'typing', payload: { chatId, login: ws.login, nickname: user.nickname || user.login } });
        chat.members.forEach(u => { if (u === ws.login) return; const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }

    if (type === 'deleteChat') {
      try {
        const { chatId } = payload || {};
        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.login)) return;
        if (chat.type === 'group' && chat.owner !== ws.login) return;
        await messagesCol.deleteMany({ chatId });
        await chatsCol.deleteOne({ _id: chatId });
        await chatThemesCol.deleteOne({ chatId });
        const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }
  });

  ws.on('close', () => {
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
    if (now - ws.lastPong > 30000) { try { ws.terminate(); } catch {} clients.delete(login); continue; }
    try { ws.send(JSON.stringify({ type: 'ping', payload: { t: now } })); } catch {}
  }
}, 5000);

setInterval(() => {
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🚀 Криста.Мессенджер v1.25 на порту ${PORT}`);
    console.log(`📦 MongoDB / ${DB_NAME}`);
    console.log(`📨 Файлы: ${tgBot ? 'ON' : 'OFF'}`);
  });
})();
