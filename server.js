// КРИСТА.ФРИНЕТ · server.js (1a), v2.30
// ============================================================
//  БАЗА, MONGODB, TELEGRAM, МИГРАЦИЯ, MIDDLEWARE
// ============================================================
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
const MAX_POST_LENGTH = 5000;
const MAX_COMMENT_LENGTH = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_POST_FILES = 10;
const BASE_URL = process.env.BASE_URL || 'https://krista-4.onrender.com';

if (!MONGO_URI) { console.error('❌ MONGO_URI не задан.'); process.exit(1); }

let usersCol, chatsCol, messagesCol, channelsCol, postsCol, commentsCol;
let countersCol, themesCol, chatThemesCol, playlistsCol, musicCol, tgLinksCol;
const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, socketTimeoutMS: 45000 });

// ============================================================
//  TELEGRAM BOT
// ============================================================
const TG_CHAT_ID = (process.env.TG_CHAT_ID || '').trim();
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
let tgBot = null;

if (TG_BOT_TOKEN && TG_CHAT_ID) {
  try {
    tgBot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
    console.log('📨 Telegram bot подключён');
    tgBot.getMe().then(me => console.log(`📨 Бот: @${me.username}`)).catch(e => console.error('❌ getMe:', e.message));

    tgBot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const code = (match[1] || '').trim();
      if (!code) return tgBot.sendMessage(chatId, '👋 Привет! Это бот Криста.Фринет.\n\nЧтобы получать уведомления, открой настройки в приложении и нажми «Привязать».');
      try {
        const link = await tgLinksCol.findOne({ code, expiresAt: { $gt: new Date().toISOString() } });
        if (!link) return tgBot.sendMessage(chatId, '❌ Ссылка устарела. Сгенерируй новую в приложении.');
        await usersCol.updateOne({ login: link.login }, { $set: { tgChatId: chatId } });
        await tgLinksCol.deleteOne({ _id: link._id });
        tgBot.sendMessage(chatId, `✅ Готово! Уведомления для <b>@${link.login}</b> будут приходить сюда.`, { parse_mode: 'HTML' });
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
const pendingMusic = new Map();
const pendingPostFiles = new Map();

// ============================================================
//  MONGODB
// ============================================================
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
      channelsCol = db.collection('channels');
      postsCol = db.collection('posts');
      commentsCol = db.collection('comments');
      countersCol = db.collection('counters');
      themesCol = db.collection('themes');
      chatThemesCol = db.collection('chat_themes');
      playlistsCol = db.collection('playlists');
      musicCol = db.collection('music');
      tgLinksCol = db.collection('tg_links');

      try { await usersCol.createIndex({ login: 1 }, { unique: true, sparse: true }); } catch {}
      try { await usersCol.createIndex({ subscriptions: 1 }); } catch {}
      try { await chatsCol.createIndex({ login: 1 }, { unique: true, sparse: true }); } catch {}
      try { await chatsCol.createIndex({ members: 1 }); } catch {}
      try { await messagesCol.createIndex({ chatId: 1, timestamp: 1 }); } catch {}
      try { await channelsCol.createIndex({ login: 1 }, { unique: true, sparse: true }); } catch {}
      try { await channelsCol.createIndex({ subscribers: 1 }); } catch {}
      try { await channelsCol.createIndex({ published: 1 }); } catch {}
      try { await postsCol.createIndex({ 'wall.type': 1, 'wall.id': 1, timestamp: -1 }); } catch {}
      try { await postsCol.createIndex({ author: 1, timestamp: -1 }); } catch {}
      try { await postsCol.createIndex({ timestamp: -1 }); } catch {}
      try { await commentsCol.createIndex({ postId: 1, timestamp: 1 }); } catch {}
      try { await musicCol.createIndex({ title: 1 }); } catch {}
      try { await musicCol.createIndex({ artist: 1 }); } catch {}
      try { await musicCol.createIndex({ album: 1 }); } catch {}
      try { await playlistsCol.createIndex({ owner: 1 }); } catch {}
      try { await tgLinksCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch {}

      console.log('✅ MongoDB подключена');
      await migrateToV2();
      return;
    } catch (err) {
      console.error(`❌ ${err.message}`);
      if (attempt >= 5) process.exit(1);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ============================================================
//  МИГРАЦИЯ v1.x → v2.x
// ============================================================
async function migrateToV2() {
  try {
    const migrated = await countersCol.findOne({ _id: 'migrated_v2' });
    if (migrated) return;
    console.log('🔧 Миграция v2: начало');

    const oldChannels = await chatsCol.find({ isChannel: true }).toArray();
    console.log(`🔧 Найдено старых каналов: ${oldChannels.length}`);

    for (const c of oldChannels) {
      await channelsCol.updateOne(
        { login: c.login },
        {
          $setOnInsert: {
            _id: c._id,
            owner: c.owner,
            login: c.login,
            name: c.name,
            description: '',
            avatarFileId: null,
            subscribers: c.members || [],
            isPrivate: !!c.isPrivate,
            published: !!c.published,
            createdAt: c.updatedAt || new Date().toISOString(),
            migratedFrom: 'chat'
          }
        },
        { upsert: true }
      );

      const oldMessages = await messagesCol.find({ chatId: c._id, deleted: { $ne: true } }).toArray();
      for (const msg of oldMessages) {
        const postId = 'post_' + msg._id;
        const exists = await postsCol.findOne({ _id: postId });
        if (exists) continue;
        await postsCol.insertOne({
          _id: postId,
          author: msg.sender,
          authorName: msg.senderName || msg.sender,
          wall: { type: 'channel', id: c._id },
          text: msg.text || '',
          files: msg.file ? [{ fileId: msg.file.fileId, name: msg.file.name, size: msg.file.size, mime: msg.file.mime, kind: msg.file.kind }] : [],
          likes: [],
          repostOf: null,
          commentsCount: 0,
          views: 0,
          timestamp: msg.timestamp,
          editedAt: null,
          migratedFrom: 'message'
        });
      }

      await chatsCol.deleteOne({ _id: c._id });
      await messagesCol.deleteMany({ chatId: c._id });
    }

    console.log(`🔧 Каналы перенесены: ${oldChannels.length}`);

    await chatsCol.updateMany({}, { $unset: { isChannel: '', pinnedMessages: '' } });
    await usersCol.updateMany(
      { subscriptions: { $exists: false } },
      { $set: { subscriptions: [], wallPrivacy: 'public' } }
    );
    await messagesCol.updateMany({}, { $unset: { reactions: '' } });

    await countersCol.updateOne(
      { _id: 'migrated_v2' },
      { $set: { value: 1, date: new Date().toISOString() } },
      { upsert: true }
    );

    console.log('✅ Миграция v2 завершена');
  } catch (e) {
    console.error('❌ Миграция:', e);
  }
}

// ============================================================
//  УТИЛИТЫ
// ============================================================
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

// ============================================================
//  PUBLIC ФОРМЫ
// ============================================================
function publicUser(doc) {
  if (!doc) return null;
  return {
    login: doc.login,
    nickname: doc.nickname || doc.login,
    accentColor: doc.accentColor || '#f0a0c8',
    nicknameColor: doc.nicknameColor || '#f0a0c8',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#f0a0c8',
    avatarFileId: doc.avatarFileId || null,
    wallPrivacy: doc.wallPrivacy || 'public',
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

function publicChannel(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    owner: doc.owner,
    login: doc.login,
    name: doc.name,
    description: doc.description || '',
    avatarFileId: doc.avatarFileId || null,
    subscribersCount: (doc.subscribers || []).length,
    isPrivate: !!doc.isPrivate,
    published: !!doc.published,
    createdAt: doc.createdAt
  };
}

function publicPost(doc, me) {
  if (!doc) return null;
  const likes = doc.likes || [];
  return {
    id: doc._id,
    author: doc.author,
    authorName: doc.authorName || doc.author,
    wall: doc.wall,
    wallData: doc.wallData || null,
    text: doc.text || '',
    files: doc.files || [],
    likesCount: likes.length,
    likedByMe: me ? likes.includes(me) : false,
    repostOf: doc.repostOf || null,
    repostData: doc.repostData || null,
    commentsCount: doc.commentsCount || 0,
    views: doc.views || 0,
    timestamp: doc.timestamp,
    editedAt: doc.editedAt || null
  };
}

function publicComment(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    postId: doc.postId,
    author: doc.author,
    authorName: doc.authorName || doc.author,
    text: doc.text,
    replyTo: doc.replyTo || null,
    timestamp: doc.timestamp
  };
}

// ============================================================
//  EXPRESS + MIDDLEWARE
// ============================================================
const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (!p.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

function authMiddleware(req, res, next) {
  let auth = req.headers.authorization;
  if ((!auth || !auth.startsWith('Bearer ')) && req.query.token) auth = 'Bearer ' + String(req.query.token);
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Требуется авторизация' });
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) return res.status(401).json({ error: 'Неверный токен' });
  req.userLogin = decoded.login;
  next();
}

async function requireChatMember(req, res, next) {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
    req.chat = chat;
    next();
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
}

async function requireChatAdmin(req, res, next) {
  if (!req.chat) return res.status(500).json({ error: 'Внутренняя ошибка' });
  const isAdmin = (req.chat.admins || []).includes(req.userLogin) || req.chat.owner === req.userLogin;
  if (!isAdmin) return res.status(403).json({ error: 'Только админ' });
  next();
}

async function requireChannelOwner(req, res, next) {
  try {
    const login = req.params.login || req.body.channelLogin;
    if (!login) return res.status(400).json({ error: 'Не указан канал' });
    const channel = await channelsCol.findOne({ login });
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    if (channel.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец канала' });
    req.channel = channel;
    next();
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
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
    const channelDup = await channelsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (channelDup) return res.status(400).json({ error: 'Логин занят каналом' });
    const now = new Date().toISOString();
    const doc = {
      login, password: await bcrypt.hash(password, 10), nickname: nickname.trim(),
      accentColor: '#f0a0c8',
      nicknameColor: '#f0a0c8', nicknameEmoji: '', nicknameEmojiColor: '#f0a0c8',
      avatarFileId: null,
      subscriptions: [], wallPrivacy: 'public',
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
      if (await channelsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(b.newLogin) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят каналом' });
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
    if (b.accentColor !== undefined) updates.accentColor = String(b.accentColor).slice(0, 20);
    if (b.nicknameColor !== undefined) updates.nicknameColor = String(b.nicknameColor).slice(0, 20);
    if (b.nicknameEmoji !== undefined) updates.nicknameEmoji = String(b.nicknameEmoji).slice(0, 8);
    if (b.nicknameEmojiColor !== undefined) updates.nicknameEmojiColor = String(b.nicknameEmojiColor).slice(0, 20);
    if (b.avatarFileId !== undefined) updates.avatarFileId = b.avatarFileId || null;
    if (b.wallPrivacy !== undefined && ['public', 'subscribers', 'private'].includes(b.wallPrivacy)) updates.wallPrivacy = b.wallPrivacy;
    if (b.tgChatId !== undefined) updates.tgChatId = b.tgChatId;

    if (Object.keys(updates).length === 0) return res.json({ success: true });
    await usersCol.updateOne({ login: req.userLogin }, { $set: updates });

    if (newLogin) {
      const oldLogin = req.userLogin;
      await chatsCol.updateMany({ members: oldLogin }, { $set: { 'members.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await chatsCol.updateMany({ admins: oldLogin }, { $set: { 'admins.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await chatsCol.updateMany({ owner: oldLogin }, { $set: { owner: newLogin } });
      await messagesCol.updateMany({ sender: oldLogin }, { $set: { sender: newLogin } });
      await channelsCol.updateMany({ owner: oldLogin }, { $set: { owner: newLogin } });
      await channelsCol.updateMany({ subscribers: oldLogin }, { $set: { 'subscribers.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await postsCol.updateMany({ author: oldLogin }, { $set: { author: newLogin } });
      await postsCol.updateMany({ likes: oldLogin }, { $set: { 'likes.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await commentsCol.updateMany({ author: oldLogin }, { $set: { author: newLogin } });
      await usersCol.updateMany({ subscriptions: oldLogin }, { $set: { 'subscriptions.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
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
    await channelsCol.updateMany({ owner: login }, { $set: { owner: null, isPrivate: true, published: false } });
    await usersCol.deleteOne({ login });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// STATS + USERS + SEARCH
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const accounts = await usersCol.countDocuments({});
    const channelsCount = await channelsCol.countDocuments({});
    const postsCount = await postsCol.countDocuments({});
    res.json({ accounts, online: clients.size, channels: channelsCount, posts: postsCount });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/users/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'Логин обязателен' });
    const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const me = await usersCol.findOne({ login: req.userLogin });
    const subscribed = me?.subscriptions?.includes(user.login) || false;
    res.json({ ...publicUserShort(user), online: clients.has(user.login), wallPrivacy: user.wallPrivacy || 'public', subscribed });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    if (q.length < 1) return res.json({ users: [], channels: [], chats: [] });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await usersCol.find({ login: { $ne: req.userLogin }, $or: [{ login: regex }, { nickname: regex }] }).limit(15).toArray();
    const channels = await channelsCol.find({ $or: [{ login: regex }, { name: regex }], isPrivate: { $ne: true } }).limit(15).toArray();
    const groups = await chatsCol.find({ type: 'group', $or: [{ login: regex }, { name: regex }] }).limit(15).toArray();
    res.json({
      users: users.map(publicUserShort),
      channels: channels.map(c => ({ ...publicChannel(c), isSubscribed: (c.subscribers || []).includes(req.userLogin) })),
      chats: groups.map(g => ({ id: g._id, login: g.login, name: g.name, membersCount: g.members.length, isPrivate: !!g.isPrivate, isMember: g.members.includes(req.userLogin) }))
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/catalog', authMiddleware, async (req, res) => {
  try {
    const list = await channelsCol.find({ published: true, isPrivate: { $ne: true } }).toArray();
    const sorted = list.sort((a, b) => (b.subscribers?.length || 0) - (a.subscribers?.length || 0));
    res.json(sorted.map((c, i) => ({
      rank: i + 1,
      id: c._id, login: c.login, name: c.name, description: c.description || '',
      avatarFileId: c.avatarFileId || null,
      subscribersCount: (c.subscribers || []).length,
      isSubscribed: (c.subscribers || []).includes(req.userLogin)
    })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  ПРОДОЛЖЕНИЕ В 1b — чаты, каналы, посты, комментарии, feed, wall, files, music, themes, tg, ws
// ============================================================
// КРИСТА.ФРИНЕТ · server.js (1b), v2.30
// ============================================================
//  ЧАТЫ (диалоги и группы)
// ============================================================
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = await usersCol.findOne({ login: req.userLogin });
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    const myChats = await chatsCol.find({ members: req.userLogin }).toArray();

    const result = await Promise.all(myChats.map(async (chat) => {
      const isGroup = chat.type === 'group';
      let title, otherLogin = null, otherUser = null;
      if (isGroup) title = chat.name;
      else {
        otherLogin = chat.members.find(u => u !== req.userLogin);
        otherUser = otherLogin ? await usersCol.findOne({ login: otherLogin }) : null;
        title = otherUser?.nickname || otherUser?.login || '???';
      }
      const [lastMsg, unread, ct] = await Promise.all([
        messagesCol.find({ chatId: chat._id, deleted: { $ne: true } }).sort({ timestamp: -1 }).limit(1).next(),
        me.lastSeen
          ? messagesCol.countDocuments({ chatId: chat._id, sender: { $ne: req.userLogin }, timestamp: { $gt: me.lastSeen }, deleted: { $ne: true } })
          : Promise.resolve(0),
        chatThemesCol.findOne({ chatId: chat._id })
      ]);
      return {
        id: chat._id, type: chat.type || 'dialog', isGroup,
        isPrivate: !!chat.isPrivate,
        isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
        name: title, login: chat.login || null, membersCount: chat.members.length,
        otherLogin, otherUser: otherUser ? publicUserShort(otherUser) : null,
        lastMessage: lastMsg ? publicMessage(lastMsg) : null,
        unreadCount: unread,
        updatedAt: chat.updatedAt || (lastMsg ? lastMsg.timestamp : chat._id),
        hasTheme: !!ct
      };
    }));

    result.sort((a, b) => {
      const ta = new Date(a.updatedAt || 0).getTime();
      const tb = new Date(b.updatedAt || 0).getTime();
      return tb - ta;
    });

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
    const { name, login, members, isPrivate, published } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60 символов' });
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    if (await chatsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят пользователем' });
    if (await channelsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят каналом' });
    const arr = Array.isArray(members) ? members : [];
    const uniq = [...new Set(arr.filter(u => typeof u === 'string' && u.length > 0))];
    for (const u of uniq) if (!(await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(u) + '$', 'i') } }))) return res.status(404).json({ error: `Пользователь ${u} не найден` });
    const chatId = uuidv4();
    const allMembers = [...new Set([req.userLogin, ...uniq])];
    await chatsCol.insertOne({ _id: chatId, type: 'group', name: name.trim(), login, members: allMembers, admins: [req.userLogin], owner: req.userLogin, isPrivate: !!isPrivate, published: !!published, updatedAt: new Date().toISOString() });
    const payload = JSON.stringify({ type: 'chatCreated', payload: { chatId } });
    allMembers.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(payload); });
    res.status(201).json({ success: true, chatId, login });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/chats/find/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'Логин обязателен' });
    const chat = await chatsCol.findOne({ type: 'group', login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!chat) return res.status(404).json({ error: 'Группа не найдена' });
    if (chat.isPrivate && !chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Приватная группа' });
    res.json({ id: chat._id, login: chat.login, name: chat.name, membersCount: chat.members.length, isPrivate: !!chat.isPrivate, isMember: chat.members.includes(req.userLogin), published: !!chat.published });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/chats/:chatId/join', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Группа не найдена' });
    if (chat.members.includes(req.userLogin)) return res.json({ success: true });
    if (chat.isPrivate) return res.status(403).json({ error: 'Приватная группа' });
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

app.get('/api/chats/:chatId/info', authMiddleware, requireChatMember, async (req, res) => {
  try {
    const chat = req.chat;
    const membersInfo = await Promise.all(chat.members.map(async (login) => {
      const u = await usersCol.findOne({ login });
      if (!u) return null;
      return { ...publicUserShort(u), isAdmin: (chat.admins || []).includes(login), isOwner: chat.owner === login, online: clients.has(login) };
    }));
    res.json({
      id: chat._id, type: chat.type || 'dialog', members: chat.members, admins: chat.admins || [],
      owner: chat.owner || null, name: chat.name || null, login: chat.login || null,
      isPrivate: !!chat.isPrivate, published: !!chat.published, updatedAt: chat.updatedAt,
      membersInfo: membersInfo.filter(Boolean),
      isMember: true,
      isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
      isOwner: chat.owner === req.userLogin
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/name', authMiddleware, requireChatMember, requireChatAdmin, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60 символов' });
    await chatsCol.updateOne({ _id: req.chat._id }, { $set: { name: name.trim(), updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'chatRenamed', payload: { chatId: req.chat._id, name: name.trim() } });
    req.chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/login', authMiddleware, requireChatMember, requireChatAdmin, async (req, res) => {
  try {
    const { login } = req.body || {};
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    if (await chatsCol.findOne({ _id: { $ne: req.chat._id }, login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят пользователем' });
    if (await channelsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят каналом' });
    await chatsCol.updateOne({ _id: req.chat._id }, { $set: { login, updatedAt: new Date().toISOString() } });
    res.json({ success: true, login });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/flags', authMiddleware, requireChatMember, async (req, res) => {
  try {
    if (req.chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });
    const { isPrivate, published } = req.body || {};
    const up = { updatedAt: new Date().toISOString() };
    if (isPrivate !== undefined) up.isPrivate = !!isPrivate;
    if (published !== undefined) up.published = !!published;
    await chatsCol.updateOne({ _id: req.chat._id }, { $set: up });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/chats/:chatId/members/:login', authMiddleware, requireChatMember, requireChatAdmin, async (req, res) => {
  try {
    const target = req.params.login;
    if (target === req.chat.owner) return res.status(400).json({ error: 'Владельца нельзя' });
    await chatsCol.updateOne({ _id: req.chat._id }, { $pull: { members: target, admins: target }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: req.chat._id, login: target } });
    req.chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/chats/:chatId/members', authMiddleware, requireChatMember, requireChatAdmin, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ error: 'Неверный логин' });
    if (req.chat.members.includes(login)) return res.status(400).json({ error: 'Уже участник' });
    const user = await usersCol.findOne({ login });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    await chatsCol.updateOne({ _id: req.chat._id }, { $push: { members: login }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: req.chat._id, login, nickname: user.nickname } });
    [...req.chat.members, login].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/members/:login/admin', authMiddleware, requireChatMember, requireChatAdmin, async (req, res) => {
  try {
    const target = req.params.login;
    if (target === req.chat.owner) return res.status(400).json({ error: 'Владельца нельзя снять' });
    const isAdmin = (req.chat.admins || []).includes(target);
    if (isAdmin) await chatsCol.updateOne({ _id: req.chat._id }, { $pull: { admins: target } });
    else await chatsCol.updateOne({ _id: req.chat._id }, { $addToSet: { admins: target } });
    const out = JSON.stringify({ type: 'adminChanged', payload: { chatId: req.chat._id, login: target, isAdmin: !isAdmin } });
    req.chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true, isAdmin: !isAdmin });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// CHAT THEMES
app.get('/api/chats/:chatId/theme', authMiddleware, requireChatMember, async (req, res) => {
  try {
    const t = await chatThemesCol.findOne({ chatId: req.params.chatId });
    res.json(t || null);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/chats/:chatId/theme', authMiddleware, requireChatMember, requireChatAdmin, async (req, res) => {
  try {
    const theme = req.body || {};
    await chatThemesCol.updateOne({ chatId: req.params.chatId }, { $set: { chatId: req.params.chatId, theme, updatedAt: new Date().toISOString() } }, { upsert: true });
    const out = JSON.stringify({ type: 'chatThemeChanged', payload: { chatId: req.params.chatId, theme } });
    req.chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/chats/:chatId/theme', authMiddleware, requireChatMember, requireChatAdmin, async (req, res) => {
  try {
    await chatThemesCol.deleteOne({ chatId: req.params.chatId });
    const out = JSON.stringify({ type: 'chatThemeChanged', payload: { chatId: req.params.chatId, theme: null } });
    req.chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  MESSAGES
// ============================================================
app.get('/api/chats/:chatId/messages', authMiddleware, requireChatMember, async (req, res) => {
  try {
    const msgs = await messagesCol.find({ chatId: req.chat._id, deleted: { $ne: true } }).sort({ timestamp: 1 }).limit(500).toArray();
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
  sendTelegramNotifications(chat, senderLogin, publicMsg, 'message');
  return { message: publicMsg };
}

// ============================================================
//  КАНАЛЫ
// ============================================================
app.post('/api/channels', authMiddleware, async (req, res) => {
  try {
    const { name, login, description, isPrivate, published } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60 символов' });
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    if (await channelsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят пользователем' });
    if (await chatsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'Логин занят группой' });
    const channelId = uuidv4();
    const now = new Date().toISOString();
    await channelsCol.insertOne({
      _id: channelId, owner: req.userLogin, login, name: name.trim(),
      description: (description || '').slice(0, 300),
      avatarFileId: null,
      subscribers: [req.userLogin],
      isPrivate: !!isPrivate, published: !!published,
      createdAt: now
    });
    res.status(201).json({ success: true, channelId, login });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/channels/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    const channel = await channelsCol.findOne({ login });
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    if (channel.isPrivate && !(channel.subscribers || []).includes(req.userLogin) && channel.owner !== req.userLogin) return res.status(403).json({ error: 'Приватный канал' });
    const isSubscribed = (channel.subscribers || []).includes(req.userLogin);
    const isOwner = channel.owner === req.userLogin;
    res.json({ ...publicChannel(channel), isSubscribed, isOwner });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/channels/my/list', authMiddleware, async (req, res) => {
  try {
    const list = await channelsCol.find({ owner: req.userLogin }).sort({ name: 1 }).toArray();
    res.json(list.map(publicChannel));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/channels/subscribed/list', authMiddleware, async (req, res) => {
  try {
    const list = await channelsCol.find({ subscribers: req.userLogin, owner: { $ne: req.userLogin } }).sort({ name: 1 }).toArray();
    res.json(list.map(publicChannel));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/channels/:login', authMiddleware, requireChannelOwner, async (req, res) => {
  try {
    const { name, description, isPrivate, published } = req.body || {};
    const up = { updatedAt: new Date().toISOString() };
    if (name !== undefined) {
      if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60 символов' });
      up.name = name.trim();
    }
    if (description !== undefined) up.description = String(description).slice(0, 300);
    if (isPrivate !== undefined) up.isPrivate = !!isPrivate;
    if (published !== undefined) up.published = !!published;
    await channelsCol.updateOne({ login: req.channel.login }, { $set: up });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/channels/:login/avatar', authMiddleware, requireChannelOwner, async (req, res) => {
  try {
    const { avatarFileId } = req.body || {};
    await channelsCol.updateOne({ login: req.channel.login }, { $set: { avatarFileId: avatarFileId || null } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/channels/:login', authMiddleware, requireChannelOwner, async (req, res) => {
  try {
    await channelsCol.deleteOne({ login: req.channel.login });
    await postsCol.deleteMany({ 'wall.type': 'channel', 'wall.id': req.channel._id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/channels/:login/subscribe', authMiddleware, async (req, res) => {
  try {
    const channel = await channelsCol.findOne({ login: req.params.login });
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    if (channel.isPrivate && !(channel.subscribers || []).includes(req.userLogin) && channel.owner !== req.userLogin) return res.status(403).json({ error: 'Приватный канал' });
    await channelsCol.updateOne({ _id: channel._id }, { $addToSet: { subscribers: req.userLogin } });
    if (channel.owner && channel.owner !== req.userLogin) notifyUser(channel.owner, `🔔 @${req.userLogin} подписался на ваш канал «${channel.name}»`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/channels/:login/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const channel = await channelsCol.findOne({ login: req.params.login });
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    if (channel.owner === req.userLogin) return res.status(400).json({ error: 'Владелец не может отписаться' });
    await channelsCol.updateOne({ _id: channel._id }, { $pull: { subscribers: req.userLogin } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  ПОСТЫ
// ============================================================
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const { text, files, wall, repostOf } = req.body || {};
    const trimmed = (text || '').toString().trim();
    const hasRepost = !!repostOf;
    if (!trimmed && (!files || !files.length) && !hasRepost) return res.status(400).json({ error: 'Пустой пост' });
    if (trimmed.length > MAX_POST_LENGTH) return res.status(400).json({ error: 'Пост слишком длинный' });
    if (!wall || !wall.type || !wall.id) return res.status(400).json({ error: 'Не указана стена' });

    if (wall.type === 'user') {
      if (wall.id !== req.userLogin) return res.status(403).json({ error: 'Только на свою стену' });
    } else if (wall.type === 'channel') {
      const ch = await channelsCol.findOne({ _id: wall.id });
      if (!ch) return res.status(404).json({ error: 'Канал не найден' });
      if (ch.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец канала может постить' });
    } else return res.status(400).json({ error: 'Неверный тип стены' });

    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    let validRepost = null;
    let repostData = null;
    if (repostOf) {
      const orig = await postsCol.findOne({ _id: repostOf });
      if (orig) {
        validRepost = orig._id;
        repostData = {
          author: orig.author, authorName: orig.authorName,
          text: (orig.text || '').slice(0, 500),
          files: (orig.files || []).slice(0, 1),
          timestamp: orig.timestamp
        };
      }
    }

    const postId = uuidv4();
    const timestamp = new Date().toISOString();
    const postDoc = {
      _id: postId,
      author: req.userLogin,
      authorName: user.nickname || req.userLogin,
      wall: { type: wall.type, id: wall.id },
      text: trimmed,
      files: Array.isArray(files) ? files.slice(0, MAX_POST_FILES) : [],
      likes: [],
      repostOf: validRepost,
      repostData,
      commentsCount: 0,
      views: 0,
      timestamp,
      editedAt: null
    };
    await postsCol.insertOne(postDoc);

    if (wall.type === 'channel') {
      const ch = await channelsCol.findOne({ _id: wall.id });
      if (ch && ch.subscribers) {
        for (const sub of ch.subscribers) {
          if (sub !== req.userLogin) notifyUser(sub, `📝 Новый пост в канале «${ch.name}»`);
        }
      }
    }

    const pub = publicPost(postDoc, req.userLogin);
    if (wall.type === 'channel') {
      const ch = await channelsCol.findOne({ _id: wall.id });
      if (ch) pub.wallData = { type: 'channel', id: ch._id, login: ch.login, name: ch.name, avatarFileId: ch.avatarFileId || null };
    }
    broadcast({ type: 'newPost', payload: pub });
    res.status(201).json(pub);
  } catch (err) { console.error('Create post:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const post = await postsCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    postsCol.updateOne({ _id: post._id }, { $inc: { views: 1 } }).catch(() => {});
    const pub = publicPost(post, req.userLogin);
    if (post.wall?.type === 'channel') {
      const ch = await channelsCol.findOne({ _id: post.wall.id });
      if (ch) pub.wallData = { type: 'channel', id: ch._id, login: ch.login, name: ch.name, avatarFileId: ch.avatarFileId || null };
    }
    res.json(pub);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const post = await postsCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    const isOwner = post.author === req.userLogin;
    let isChannelOwner = false;
    if (post.wall && post.wall.type === 'channel') {
      const ch = await channelsCol.findOne({ _id: post.wall.id });
      if (ch && ch.owner === req.userLogin) isChannelOwner = true;
    }
    if (!isOwner && !isChannelOwner) return res.status(403).json({ error: 'Нет доступа' });
    await postsCol.deleteOne({ _id: post._id });
    await commentsCol.deleteMany({ postId: post._id });
    broadcast({ type: 'postDeleted', payload: { postId: post._id } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/posts/:id', authMiddleware, async (req, res) => {
  try {
    const post = await postsCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    if (post.author !== req.userLogin) return res.status(403).json({ error: 'Только автор' });
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустой пост' });
    if (text.trim().length > MAX_POST_LENGTH) return res.status(400).json({ error: 'Слишком длинный' });
    await postsCol.updateOne({ _id: post._id }, { $set: { text: text.trim(), editedAt: new Date().toISOString() } });
    const fresh = await postsCol.findOne({ _id: post._id });
    const pub = publicPost(fresh, req.userLogin);
    if (fresh.wall?.type === 'channel') {
      const ch = await channelsCol.findOne({ _id: fresh.wall.id });
      if (ch) pub.wallData = { type: 'channel', id: ch._id, login: ch.login, name: ch.name, avatarFileId: ch.avatarFileId || null };
    }
    broadcast({ type: 'postUpdated', payload: pub });
    res.json(pub);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/posts/:id/like', authMiddleware, async (req, res) => {
  try {
    const post = await postsCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    const liked = (post.likes || []).includes(req.userLogin);
    if (liked) await postsCol.updateOne({ _id: post._id }, { $pull: { likes: req.userLogin } });
    else await postsCol.updateOne({ _id: post._id }, { $addToSet: { likes: req.userLogin } });
    if (!liked && post.author !== req.userLogin) notifyUser(post.author, `❤️ @${req.userLogin} лайкнул ваш пост`);
    const fresh = await postsCol.findOne({ _id: post._id });
    const pub = publicPost(fresh, req.userLogin);
    if (fresh.wall?.type === 'channel') {
      const ch = await channelsCol.findOne({ _id: fresh.wall.id });
      if (ch) pub.wallData = { type: 'channel', id: ch._id, login: ch.login, name: ch.name, avatarFileId: ch.avatarFileId || null };
    }
    broadcast({ type: 'postUpdated', payload: pub });
    res.json({ liked: !liked, likesCount: (fresh.likes || []).length });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  КОММЕНТАРИИ
// ============================================================
app.get('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  try {
    const post = await postsCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    const list = await commentsCol.find({ postId: req.params.id }).sort({ timestamp: 1 }).toArray();
    res.json(list.map(publicComment));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  try {
    const post = await postsCol.findOne({ _id: req.params.id });
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    const { text, replyTo } = req.body || {};
    const trimmed = (text || '').toString().trim();
    if (!trimmed) return res.status(400).json({ error: 'Пустой комментарий' });
    if (trimmed.length > MAX_COMMENT_LENGTH) return res.status(400).json({ error: 'Слишком длинный' });
    const user = await usersCol.findOne({ login: req.userLogin });
    const commentId = uuidv4();
    const timestamp = new Date().toISOString();
    const doc = {
      _id: commentId, postId: post._id,
      author: req.userLogin, authorName: user?.nickname || req.userLogin,
      text: trimmed, replyTo: replyTo || null, timestamp
    };
    await commentsCol.insertOne(doc);
    await postsCol.updateOne({ _id: post._id }, { $inc: { commentsCount: 1 } });
    if (post.author !== req.userLogin) notifyUser(post.author, `💬 @${req.userLogin} оставил комментарий`);
    broadcast({ type: 'commentAdded', payload: { postId: post._id, comment: publicComment(doc) } });
    res.status(201).json(publicComment(doc));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/comments/:id', authMiddleware, async (req, res) => {
  try {
    const c = await commentsCol.findOne({ _id: req.params.id });
    if (!c) return res.status(404).json({ error: 'Комментарий не найден' });
    const post = await postsCol.findOne({ _id: c.postId });
    const isAuthor = c.author === req.userLogin;
    const isPostAuthor = post && post.author === req.userLogin;
    if (!isAuthor && !isPostAuthor) return res.status(403).json({ error: 'Нет доступа' });
    await commentsCol.deleteOne({ _id: c._id });
    if (post) await postsCol.updateOne({ _id: post._id }, { $inc: { commentsCount: -1 } });
    broadcast({ type: 'commentDeleted', payload: { commentId: c._id, postId: c.postId } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  СТЕНЫ, ЛЕНТА, ПОДПИСКИ
// ============================================================
app.get('/api/wall/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    const target = await usersCol.findOne({ login });
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    const me = await usersCol.findOne({ login: req.userLogin });
    const isSubscribed = (me.subscriptions || []).includes(target.login);
    const isMe = target.login === req.userLogin;
    const privacy = target.wallPrivacy || 'public';
    if (privacy === 'private' && !isMe) return res.status(403).json({ error: 'Стена закрыта' });
    if (privacy === 'subscribers' && !isSubscribed && !isMe) return res.status(403).json({ error: 'Только для подписчиков' });
    const rawPosts = await postsCol.find({ 'wall.type': 'user', 'wall.id': target.login }).sort({ timestamp: -1 }).limit(50).toArray();
    res.json({
      user: { ...publicUserShort(target), wallPrivacy: privacy, subscribed: isSubscribed, isMe },
      posts: rawPosts.map(p => publicPost(p, req.userLogin))
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/wall/channel/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    const channel = await channelsCol.findOne({ login });
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    if (channel.isPrivate && !(channel.subscribers || []).includes(req.userLogin) && channel.owner !== req.userLogin) return res.status(403).json({ error: 'Приватный канал' });
    const rawPosts = await postsCol.find({ 'wall.type': 'channel', 'wall.id': channel._id }).sort({ timestamp: -1 }).limit(50).toArray();
    const wallData = { type: 'channel', id: channel._id, login: channel.login, name: channel.name, avatarFileId: channel.avatarFileId || null };
    res.json({
      channel: { ...publicChannel(channel), isSubscribed: (channel.subscribers || []).includes(req.userLogin), isOwner: channel.owner === req.userLogin },
      posts: rawPosts.map(p => { const pub = publicPost(p, req.userLogin); pub.wallData = wallData; return pub; })
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/feed', authMiddleware, async (req, res) => {
  try {
    const mode = String(req.query.mode || 'subs');
    const me = await usersCol.findOne({ login: req.userLogin });
    const mySubs = me.subscriptions || [];
    const myChannels = await channelsCol.find({ subscribers: req.userLogin }).toArray();
    const channelIds = myChannels.map(c => c._id);

    let rawPosts = [];
    if (mode === 'top') {
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      rawPosts = await postsCol.find({ timestamp: { $gte: weekAgo } }).limit(100).toArray();
      rawPosts.sort((a, b) => (b.likes?.length || 0) - (a.likes?.length || 0));
      rawPosts = rawPosts.slice(0, 50);
    } else if (mode === 'all') {
      rawPosts = await postsCol.find({}).sort({ timestamp: -1 }).limit(50).toArray();
    } else {
      const authors = [req.userLogin, ...mySubs];
      const query = {
        $or: [
          { author: { $in: authors } },
          { 'wall.type': 'channel', 'wall.id': { $in: channelIds } }
        ]
      };
      rawPosts = await postsCol.find(query).sort({ timestamp: -1 }).limit(50).toArray();
    }

    const chIds = [...new Set(rawPosts.filter(p => p.wall?.type === 'channel').map(p => p.wall.id))];
    let channelMap = {};
    if (chIds.length) {
      const chs = await channelsCol.find({ _id: { $in: chIds } }).toArray();
      chs.forEach(c => { channelMap[c._id] = { type: 'channel', id: c._id, login: c.login, name: c.name, avatarFileId: c.avatarFileId || null }; });
    }

    const out = rawPosts.map(p => {
      const pub = publicPost(p, req.userLogin);
      if (p.wall?.type === 'channel' && channelMap[p.wall.id]) {
        pub.wallData = channelMap[p.wall.id];
      }
      return pub;
    });

    res.json({ posts: out });
  } catch (err) { console.error('Feed:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/users/:login/subscribe', authMiddleware, async (req, res) => {
  try {
    const target = await usersCol.findOne({ login: req.params.login });
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.login === req.userLogin) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
    await usersCol.updateOne({ login: req.userLogin }, { $addToSet: { subscriptions: target.login } });
    if (target.tgChatId) notifyUser(target.login, `🔔 @${req.userLogin} подписался на вас`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/users/:login/unsubscribe', authMiddleware, async (req, res) => {
  try {
    await usersCol.updateOne({ login: req.userLogin }, { $pull: { subscriptions: req.params.login } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/subscriptions', authMiddleware, async (req, res) => {
  try {
    const me = await usersCol.findOne({ login: req.userLogin });
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    const subs = await usersCol.find({ login: { $in: me.subscriptions || [] } }).toArray();
    res.json(subs.map(publicUserShort));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  FILES (через Telegram)
// ============================================================
function guessFileKind(mime) {
  if (!mime) return 'doc';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'doc';
}
function formatBytes(n) {
  if (!n) return '0 Б';
  if (n < 1024) return n + ' Б';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ';
  return (n / 1048576).toFixed(2) + ' МБ';
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
  const msg = await tgBot.sendDocument(TG_CHAT_ID, stream, { caption }, { filename, contentType: mimetype || 'application/octet-stream' });
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
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (purpose === 'avatar') {
      const num = await nextNumber();
      const filename = `avatar-${req.userLogin}.jpg`;
      const cap = buildCaption({ number: num, category: 'avatar', uploader: req.userLogin, uploaderNick: user.nickname, chatName: null, size: req.file.size, mime: req.file.mimetype, filename });
      const fileId = await sendToTelegram(req.file.buffer, filename, req.file.mimetype, cap);
      await usersCol.updateOne({ login: req.userLogin }, { $set: { avatarFileId: fileId } });
      return res.json({ success: true, fileId });
    }

    if (purpose === 'wallpaper') {
      const num = await nextNumber();
      const filename = req.file.originalname || `wallpaper-${num}.jpg`;
      const cap = buildCaption({ number: num, category: 'wallpaper', uploader: req.userLogin, uploaderNick: user.nickname, chatName: null, size: req.file.size, mime: req.file.mimetype, filename });
      const fileId = await sendToTelegram(req.file.buffer, filename, req.file.mimetype, cap);
      return res.json({ success: true, fileId, name: req.file.originalname || filename, size: req.file.size });
    }

    if (purpose === 'channel_avatar') {
      const { channelLogin } = req.body;
      if (!channelLogin) return res.status(400).json({ error: 'Не указан канал' });
      const ch = await channelsCol.findOne({ login: channelLogin });
      if (!ch) return res.status(404).json({ error: 'Канал не найден' });
      if (ch.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });
      const num = await nextNumber();
      const filename = `channel-${channelLogin}.jpg`;
      const cap = buildCaption({ number: num, category: 'channel_avatar', uploader: req.userLogin, uploaderNick: user.nickname, chatName: `@${channelLogin}`, size: req.file.size, mime: req.file.mimetype, filename });
      const fileId = await sendToTelegram(req.file.buffer, filename, req.file.mimetype, cap);
      await channelsCol.updateOne({ _id: ch._id }, { $set: { avatarFileId: fileId } });
      return res.json({ success: true, fileId });
    }

    if (purpose === 'post_file') {
      const num = await nextNumber();
      const filename = req.file.originalname || `post-${num}`;
      const cap = buildCaption({ number: num, category: 'post_file', uploader: req.userLogin, uploaderNick: user.nickname, chatName: null, size: req.file.size, mime: req.file.mimetype, filename });
      const fileId = await sendToTelegram(req.file.buffer, filename, req.file.mimetype, cap);
      return res.json({
        success: true,
        file: { fileId, name: filename, size: req.file.size, mime: req.file.mimetype, kind: guessFileKind(req.file.mimetype) }
      });
    }

    if (!chatId) return res.status(400).json({ error: 'Не указан чат' });
    const chat = await chatsCol.findOne({ _id: chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Вы не участник' });

    const { originalname, mimetype, size, buffer } = req.file;
    const num = await nextNumber();
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
      file: { number: num, fileId, name: originalname, size, mime: mimetype, kind: guessFileKind(mimetype) },
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
    sendTelegramNotifications(chat, req.userLogin, pub, 'message');
    res.status(201).json(pub);
  } catch (err) { console.error('Upload:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
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
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' }); }
});

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
function sanitizeFilename(s) { return String(s || '').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120); }

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
    res.json({ success: true, token });
  } catch (err) { console.error('Music stage:', err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

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

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingMusic) if (v.expiresAt < now) pendingMusic.delete(k);
  for (const [k, v] of pendingPostFiles) if (v.expiresAt < now) pendingPostFiles.delete(k);
}, 60000);

app.get('/api/music/songs', authMiddleware, async (req, res) => {
  try {
    const songs = await musicCol.find({}).sort({ title: 1 }).toArray();
    res.json(songs.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, uploadedBy: s.uploadedBy, filename: s.filename, mime: s.mime })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

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
    res.json(songs.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, uploadedBy: s.uploadedBy, filename: s.filename, mime: s.mime })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

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
    res.json(songs.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, uploadedBy: s.uploadedBy, filename: s.filename, mime: s.mime })));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

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
    res.json({ name: pl.name, tracks: ordered.map(s => ({ id: s._id, fileId: s.fileId, title: s.title, artist: s.artist, album: s.album, trackNumber: s.trackNumber, size: s.size, filename: s.filename, mime: s.mime })) });
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

app.delete('/api/themes/:id', authMiddleware, async (req, res) => {
  try {
    await themesCol.deleteOne({ _id: req.params.id, owner: req.userLogin });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ============================================================
//  TG LINK + NOTIFY
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

function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function notifyUser(login, text) {
  if (!tgBot || !login) return;
  try {
    const u = await usersCol.findOne({ login });
    if (!u || !u.tgChatId) return;
    const ws = clients.get(login);
    if (ws && ws.readyState === WebSocket.OPEN && !ws.currentChatId) return;
    await tgBot.sendMessage(u.tgChatId, `<b>${escapeHtml(text)}</b>\n\n<i><u><a href="${BASE_URL}">Открыть</a></u></i>`, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    if (e.response?.body?.error_code === 403) {
      await usersCol.updateOne({ login }, { $set: { tgChatId: null } });
    }
  }
}

function sendTelegramNotifications(chat, senderLogin, msg, kind) {
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
        if (!recipient || !recipient.tgChatId) continue;
        const wsCl = clients.get(u);
        if (wsCl && wsCl.currentChatId === chat._id) continue;
        const title = chatName ? `${chatName} · @${senderLogin}` : `@${senderLogin}`;
        try {
          await tgBot.sendMessage(recipient.tgChatId,
            `💬 <b>${escapeHtml(title)}</b>\n\n<blockquote>${escapeHtml(preview)}</blockquote>\n\n<i><u><a href="${BASE_URL}">Открыть</a></u></i>`,
            { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (e) {
          if (e.response?.body?.error_code === 403) {
            await usersCol.updateOne({ login: u }, { $set: { tgChatId: null } });
          }
        }
      }
    } catch (e) { console.warn('TG notif:', e.message); }
  })();
}

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

    if (type === 'activeChat') { ws.currentChatId = payload?.chatId || null; return; }

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

// ============================================================
//  SPA fallback
// ============================================================
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ============================================================
//  START
// ============================================================
(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🚀 Криста.Фринет v2.30 на порту ${PORT}`);
    console.log(`📦 MongoDB / ${DB_NAME}`);
    console.log(`📨 Файлы: ${tgBot ? 'ON' : 'OFF'}`);
  });
})();
