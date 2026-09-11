// ============================================================
// КРИСТА.МЕССЕНДЖЕР v0.11 — СЕРВЕР
// Переход: UIN → логин. Светлые темы теперь светлые.
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'krista';
const COMMON_CHAT_ID = 'common';
const COMMON_CHAT_PUBLIC_ID = '000000001';
const COMMON_CHAT_NAME = 'ОБЩИЙ ЧАТ';
const EDIT_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const LOGIN_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

if (!MONGO_URI) { console.error('❌ MONGO_URI не задан.'); process.exit(1); }

// ==== MongoDB ====
let usersCol, chatsCol, messagesCol;
const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
  socketTimeoutMS: 45000
});

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

      await usersCol.createIndex({ login: 1 }, { unique: true, sparse: true });
      await usersCol.createIndex({ nickname: 1 });
      await chatsCol.createIndex({ members: 1 });
      await chatsCol.createIndex({ publicId: 1 }, { sparse: true });
      await messagesCol.createIndex({ chatId: 1, timestamp: 1 });

      console.log('✅ MongoDB подключена');
      await ensureCommonChat();
      return;
    } catch (err) {
      console.error(`❌ ${err.message}`);
      if (attempt >= 5) process.exit(1);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function ensureCommonChat() {
  const existing = await chatsCol.findOne({ _id: COMMON_CHAT_ID });
  if (existing) return;
  const now = new Date().toISOString();
  await chatsCol.insertOne({
    _id: COMMON_CHAT_ID, type: 'group', name: COMMON_CHAT_NAME,
    publicId: COMMON_CHAT_PUBLIC_ID, members: [], admins: [], owner: null,
    isPrivate: false, isChannel: false, isCommon: true, updatedAt: now
  });
  console.log('✅ Общий чат создан');
}

// ==== ХЕЛПЕРЫ ====
const generateToken = (login) => jwt.sign({ login }, JWT_SECRET, { expiresIn: '30d' });
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
const generateChatId = () => String(Math.floor(100000000 + Math.random() * 900000000));

const STATUS_COLORS = {
  online: '#7ee0a0', away: '#ffcc55',
  dnd: '#ff6a8a', custom: '#a89ab0'
};

// Валидация логина: 3-32 символа, [a-zA-Z0-9_-], начинается с буквы или цифры
function validateLogin(login) {
  if (typeof login !== 'string') return 'Логин обязателен';
  if (login.length < 3 || login.length > 32) return 'Логин: 3-32 символа';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) {
    return 'Логин: только буквы, цифры, _ и -, начинается с буквы/цифры';
  }
  return null;
}

function publicUser(doc) {
  if (!doc) return null;
  return {
    login: doc.login,
    nickname: doc.nickname || doc.login,
    theme: doc.theme || 'rose',
    nicknameColor: doc.nicknameColor || '#f0e8ee',
    status: doc.status || 'online',
    statusText: doc.statusText || '',
    statusColor: doc.statusColor || STATUS_COLORS.online,
    avatarType: doc.avatarType || 'initial',
    avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#ffb3d1',
    loginChangeableAt: doc.loginChangeableAt || null,
    createdAt: doc.createdAt,
    lastSeen: doc.lastSeen
  };
}

function publicUserShort(doc) {
  if (!doc) return null;
  return {
    login: doc.login,
    nickname: doc.nickname || doc.login,
    nicknameColor: doc.nicknameColor || '#f0e8ee',
    status: doc.status || 'online',
    statusText: doc.statusText || '',
    statusColor: doc.statusColor || STATUS_COLORS.online,
    avatarType: doc.avatarType || 'initial',
    avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#ffb3d1'
  };
}

function publicChat(doc) {
  if (!doc) return null;
  return {
    id: doc._id, type: doc.type || 'dialog',
    members: doc.members, admins: doc.admins || [],
    owner: doc.owner || null, name: doc.name || null,
    publicId: doc.publicId || null,
    isPrivate: !!doc.isPrivate, isChannel: !!doc.isChannel,
    isCommon: !!doc.isCommon, updatedAt: doc.updatedAt
  };
}

function publicMessage(doc) {
  if (!doc) return null;
  return {
    id: doc._id, clientId: doc.clientId || null, chatId: doc.chatId,
    sender: doc.sender, senderName: doc.senderName,
    text: doc.text, timestamp: doc.timestamp,
    replyTo: doc.replyTo || null,
    deleted: doc.deleted ? 1 : 0,
    editedAt: doc.editedAt || null,
    reactions: doc.reactions || []
  };
}

// ==== EXPRESS ====
const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '256kb' }));
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
    if (!nickname || nickname.length < 1 || nickname.length > 30) {
      return res.status(400).json({ error: 'Ник: 1-30 символов' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Пароли не совпадают' });
    }

    // Проверка уникальности логина (регистронезависимо)
    const existing = await usersCol.findOne({
      login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') }
    });
    if (existing) return res.status(400).json({ error: 'Логин занят' });

    const hashed = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    const doc = {
      login, password: hashed,
      nickname: nickname.trim(),
      theme: 'rose',
      nicknameColor: '#ffb3d1',
      status: 'online', statusText: '', statusColor: STATUS_COLORS.online,
      avatarType: 'initial', avatarEmoji: '', avatarBgColor: '#ffb3d1',
      loginChangeableAt: null,
      createdAt: now, lastSeen: now
    };
    await usersCol.insertOne(doc);

    await chatsCol.updateOne(
      { _id: COMMON_CHAT_ID },
      { $addToSet: { members: login }, $set: { updatedAt: now } }
    );

    const token = generateToken(login);
    res.status(201).json({ success: true, login, nickname: doc.nickname, token });
  } catch (err) {
    console.error('Register:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ error: 'Заполните поля' });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(login)) {
      return res.status(400).json({ error: 'Неверный формат логина' });
    }

    const user = await usersCol.findOne({
      login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') }
    });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    await usersCol.updateOne({ login: user.login }, { $set: { lastSeen: new Date().toISOString() } });
    await chatsCol.updateOne({ _id: COMMON_CHAT_ID }, { $addToSet: { members: user.login } });

    const token = generateToken(user.login);
    res.json({ success: true, login: user.login, nickname: user.nickname, token });
  } catch (err) {
    console.error('Login:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json(publicUser(user));
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const updates = {};
    let newLogin = null;

    // Смена логина
    if (b.newLogin !== undefined && b.newLogin !== user.login) {
      const loginErr = validateLogin(b.newLogin);
      if (loginErr) return res.status(400).json({ error: loginErr });

      // Проверка кулдауна
      if (user.loginChangeableAt) {
        const nextChange = new Date(user.loginChangeableAt).getTime();
        if (Date.now() < nextChange) {
          const hours = Math.ceil((nextChange - Date.now()) / 3600000);
          return res.status(429).json({ error: `Логин можно менять раз в день. Осталось: ${hours} ч.` });
        }
      }

      // Проверка уникальности
      const dup = await usersCol.findOne({
        login: { $regex: new RegExp('^' + escapeRegex(b.newLogin) + '$', 'i') }
      });
      if (dup) return res.status(400).json({ error: 'Логин занят' });

      newLogin = b.newLogin;
      updates.login = b.newLogin;
      updates.loginChangeableAt = new Date(Date.now() + LOGIN_CHANGE_COOLDOWN_MS).toISOString();
    }

    if (b.nickname !== undefined) {
      if (b.nickname.length < 1 || b.nickname.length > 30) {
        return res.status(400).json({ error: 'Ник: 1-30' });
      }
      updates.nickname = b.nickname.trim();
    }

    if (b.newPassword) {
      if (!b.password) return res.status(400).json({ error: 'Введите текущий пароль' });
      if (!(await bcrypt.compare(b.password, user.password))) return res.status(401).json({ error: 'Неверный пароль' });
      if (b.newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль: мин. 6' });
      updates.password = await bcrypt.hash(b.newPassword, 10);
    }

    if (b.theme !== undefined) {
      const allowed = ['rose','lavender','sakura','cream','night','grape','caramel','blossom'];
      if (!allowed.includes(b.theme)) return res.status(400).json({ error: 'Неверная тема' });
      updates.theme = b.theme;
    }

    if (b.nicknameColor !== undefined) updates.nicknameColor = String(b.nicknameColor).slice(0, 20);
    if (b.status !== undefined) {
      const allowed = ['online','away','dnd','custom'];
      if (!allowed.includes(b.status)) return res.status(400).json({ error: 'Неверный статус' });
      updates.status = b.status;
      if (b.status !== 'custom') updates.statusColor = STATUS_COLORS[b.status];
    }
    if (b.statusText !== undefined) updates.statusText = String(b.statusText).slice(0, 60);
    if (b.statusColor !== undefined) updates.statusColor = String(b.statusColor).slice(0, 20);
    if (b.avatarType !== undefined) {
      if (!['initial','emoji'].includes(b.avatarType)) return res.status(400).json({ error: 'Неверный тип' });
      updates.avatarType = b.avatarType;
    }
    if (b.avatarEmoji !== undefined) updates.avatarEmoji = String(b.avatarEmoji).slice(0, 8);
    if (b.avatarBgColor !== undefined) updates.avatarBgColor = String(b.avatarBgColor).slice(0, 20);

    if (Object.keys(updates).length === 0) return res.json({ success: true });
    await usersCol.updateOne({ login: req.userLogin }, { $set: updates });

    // Если логин сменился — надо обновить все чаты/сообщения
    if (newLogin) {
      // Обновляем членство в чатах
      await chatsCol.updateMany({ members: req.userLogin }, { $set: { 'members.$[el]': newLogin } }, { arrayFilters: [{ el: req.userLogin }] });
      await chatsCol.updateMany({ admins: req.userLogin }, { $set: { 'admins.$[el]': newLogin } }, { arrayFilters: [{ el: req.userLogin }] });
      await chatsCol.updateMany({ owner: req.userLogin }, { $set: { owner: newLogin } });
      await messagesCol.updateMany({ sender: req.userLogin }, { $set: { sender: newLogin } });
      // Обновляем токен
      const newToken = generateToken(newLogin);
      // Меняем req.userLogin для дальнейшей логики
      const oldLogin = req.userLogin;
      req.userLogin = newLogin;
      // Оповещаем всех
      const fresh = await usersCol.findOne({ login: newLogin });
      broadcast({ type: 'userUpdated', payload: publicUserShort(fresh) });
      return res.json({ success: true, newLogin, newToken });
    }

    const fresh = await usersCol.findOne({ login: req.userLogin });
    broadcast({ type: 'userUpdated', payload: publicUserShort(fresh) });
    res.json({ success: true });
  } catch (err) {
    console.error('Update me:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/me', authMiddleware, async (req, res) => {
  try {
    const login = req.userLogin;
    const chats = await chatsCol.find({ members: login }).toArray();
    for (const chat of chats) {
      if (chat.isCommon) {
        await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: login } });
      } else {
        await messagesCol.deleteMany({ chatId: chat._id });
        await chatsCol.deleteOne({ _id: chat._id });
      }
    }
    await usersCol.deleteOne({ login });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  SEARCH
// ============================================================
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    if (q.length < 2) return res.json({ users: [], chats: [] });

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const users = await usersCol.find({
      login: { $ne: req.userLogin },
      $or: [{ login: regex }, { nickname: regex }]
    }).limit(15).toArray();

    const groups = await chatsCol.find({
      type: 'group', isCommon: { $ne: true },
      $or: [{ publicId: regex }, { name: regex }]
    }).limit(10).toArray();

    res.json({
      users: users.map(publicUserShort),
      chats: groups.map(g => ({
        id: g._id, publicId: g.publicId, name: g.name,
        membersCount: g.members.length, isPrivate: !!g.isPrivate,
        isMember: g.members.includes(req.userLogin)
      }))
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/chats/find/:publicId', authMiddleware, async (req, res) => {
  try {
    const publicId = String(req.params.publicId || '').trim();
    if (!/^\d{9}$/.test(publicId)) return res.status(400).json({ error: 'ID: 9 цифр' });
    const chat = await chatsCol.findOne({ publicId, type: 'group' });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.isPrivate && !chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Приватный' });
    res.json({
      id: chat._id, publicId: chat.publicId, name: chat.name,
      membersCount: chat.members.length, isPrivate: !!chat.isPrivate,
      isChannel: !!chat.isChannel, isCommon: !!chat.isCommon,
      isMember: chat.members.includes(req.userLogin)
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  CHATS
// ============================================================
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = await usersCol.findOne({ login: req.userLogin });
    if (!me) return res.status(404).json({ error: 'Не найден' });

    const myChats = await chatsCol.find({ members: req.userLogin }).toArray();
    const result = [];

    for (const chat of myChats) {
      const isGroup = chat.type === 'group';
      let title, subtitle, otherLogin = null, otherUser = null;

      if (isGroup) {
        title = chat.name;
        subtitle = chat.isCommon
          ? `${chat.members.length} участ. · общий`
          : `${chat.members.length} участ.${chat.isChannel ? ' · канал' : ''}`;
      } else {
        otherLogin = chat.members.find(u => u !== req.userLogin);
        otherUser = otherLogin ? await usersCol.findOne({ login: otherLogin }) : null;
        title = otherUser?.nickname || otherUser?.login || '???';
        subtitle = otherUser ? (otherUser.statusText || statusLabel(otherUser.status)) : '—';
      }

      const lastMsg = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } })
        .sort({ timestamp: -1 }).limit(1).next();

      let unread = 0;
      if (me.lastSeen) {
        unread = await messagesCol.countDocuments({
          chatId: chat._id, sender: { $ne: req.userLogin },
          timestamp: { $gt: me.lastSeen }, deleted: { $ne: true }
        });
      }

      result.push({
        id: chat._id, type: chat.type || 'dialog', isGroup,
        isPrivate: !!chat.isPrivate, isChannel: !!chat.isChannel,
        isCommon: !!chat.isCommon,
        isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
        name: title, subtitle,
        publicId: chat.publicId || null, membersCount: chat.members.length,
        otherLogin,
        otherUser: otherUser ? publicUserShort(otherUser) : null,
        lastMessage: lastMsg ? publicMessage(lastMsg) : null,
        unreadCount: unread, updatedAt: chat.updatedAt,
        online: otherLogin ? clients.has(otherLogin) : false
      });
    }

    res.json(result);
  } catch (err) {
    console.error('Chats:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

function statusLabel(s) {
  return { online: 'в сети', away: 'отошёл', dnd: 'не беспокоить', custom: '' }[s] || 'в сети';
}

app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login || typeof login !== 'string') return res.status(400).json({ error: 'Неверный логин' });
    if (login.toLowerCase() === req.userLogin.toLowerCase()) return res.status(400).json({ error: 'Нельзя добавить себя' });
    const other = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!other) return res.status(404).json({ error: 'Не найден' });

    const existing = await chatsCol.findOne({
      type: { $in: ['dialog', null] },
      members: { $all: [req.userLogin, other.login], $size: 2 }
    });
    if (existing) return res.json({ success: true, chatId: existing._id, existing: true });

    const chatId = uuidv4();
    const now = new Date().toISOString();
    await chatsCol.insertOne({
      _id: chatId, type: 'dialog', members: [req.userLogin, other.login],
      admins: [], owner: null, updatedAt: now
    });

    const c = clients.get(other.login);
    if (c && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'chatCreated', payload: { chatId } }));

    res.status(201).json({ success: true, chatId });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, members, isPrivate, isChannel } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) {
      return res.status(400).json({ error: 'Название: 1-60' });
    }
    const arr = Array.isArray(members) ? members : [];
    const uniq = [...new Set(arr.filter(u => typeof u === 'string' && u.length > 0))];
    for (const u of uniq) {
      if (!(await usersCol.findOne({ login: u }))) {
        return res.status(404).json({ error: `Логин ${u} не найден` });
      }
    }

    let publicId = null;
    for (let i = 0; i < 20; i++) {
      const c = generateChatId();
      if (!(await chatsCol.findOne({ publicId: c }))) { publicId = c; break; }
    }
    if (!publicId) return res.status(500).json({ error: 'Не удалось создать ID' });

    const chatId = uuidv4();
    const now = new Date().toISOString();
    const allMembers = [...new Set([req.userLogin, ...uniq])];

    await chatsCol.insertOne({
      _id: chatId, type: 'group', name: name.trim(), publicId,
      members: allMembers, admins: [req.userLogin], owner: req.userLogin,
      isPrivate: !!isPrivate, isChannel: !!isChannel, isCommon: false, updatedAt: now
    });

    const payload = JSON.stringify({ type: 'chatCreated', payload: { chatId } });
    allMembers.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(payload); });

    res.status(201).json({ success: true, chatId, publicId });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats/:chatId/join', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (chat.members.includes(req.userLogin)) return res.json({ success: true, already: true });
    if (chat.isPrivate && !chat.isCommon) return res.status(403).json({ error: 'Приватный' });

    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, login: req.userLogin } });
    [...chat.members, req.userLogin].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats/:chatId/leave', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Из общего нельзя выйти' });
    if (!chat.members.includes(req.userLogin)) return res.json({ success: true });
    if (chat.owner === req.userLogin) return res.status(400).json({ error: 'Владелец не может выйти' });

    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: req.userLogin, admins: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, login: req.userLogin } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Общий нельзя удалить' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });
    if (chat.type === 'group' && chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });

    await messagesCol.deleteMany({ chatId: chat._id });
    await chatsCol.deleteOne({ _id: chat._id });
    const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId: chat._id } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/chats/:chatId/info', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (!chat.members.includes(req.userLogin) && chat.isPrivate) return res.status(403).json({ error: 'Нет доступа' });

    const membersInfo = [];
    for (const login of chat.members) {
      const u = await usersCol.findOne({ login });
      if (u) membersInfo.push({
        ...publicUserShort(u),
        isAdmin: (chat.admins || []).includes(login),
        isOwner: chat.owner === login,
        online: clients.has(login)
      });
    }

    res.json({
      ...publicChat(chat), membersInfo,
      isMember: chat.members.includes(req.userLogin),
      isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/chats/:chatId/name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: '1-60' });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Общий нельзя' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });

    await chatsCol.updateOne({ _id: chat._id }, { $set: { name: name.trim(), updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'chatRenamed', payload: { chatId: chat._id, name: name.trim() } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/chats/:chatId/flags', authMiddleware, async (req, res) => {
  try {
    const { isPrivate, isChannel } = req.body || {};
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Общий нельзя' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (chat.owner !== req.userLogin) return res.status(403).json({ error: 'Только владелец' });

    const up = { updatedAt: new Date().toISOString() };
    if (isPrivate !== undefined) up.isPrivate = !!isPrivate;
    if (isChannel !== undefined) up.isChannel = !!isChannel;
    await chatsCol.updateOne({ _id: chat._id }, { $set: up });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/chats/:chatId/members/:login', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Из общего нельзя' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });

    const target = req.params.login;
    if (target === chat.owner) return res.status(400).json({ error: 'Владельца нельзя' });
    if (!chat.members.includes(target)) return res.status(404).json({ error: 'Не участник' });

    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: target, admins: target }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, login: target } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats/:chatId/members', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ error: 'Неверный логин' });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'В общий автоматом' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'Только админ' });
    if (chat.members.includes(login)) return res.status(400).json({ error: 'Уже участник' });
    const user = await usersCol.findOne({ login });
    if (!user) return res.status(404).json({ error: 'Не найден' });

    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: login }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, login, nickname: user.nickname } });
    [...chat.members, login].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  MESSAGES
// ============================================================
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'Нет доступа' });

    const msgs = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } })
      .sort({ timestamp: 1 }).limit(500).toArray();

    await usersCol.updateOne({ login: req.userLogin }, { $set: { lastSeen: new Date().toISOString() } });
    res.json(msgs.map(publicMessage));
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const { text, clientId, replyTo } = req.body || {};
    const result = await processNewMessage(req.params.chatId, req.userLogin, text, clientId, replyTo);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.status(201).json(result.message);
  } catch (err) {
    console.error('HTTP send:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

async function processNewMessage(chatId, senderLogin, text, clientId, replyTo) {
  if (!chatId || typeof text !== 'string') return { error: 'Неверные данные', code: 400 };
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Пустое', code: 400 };
  if (trimmed.length > 200) return { error: 'Максимум 200', code: 400 };

  const chat = await chatsCol.findOne({ _id: chatId });
  if (!chat) return { error: 'Чат не найден', code: 404 };
  if (!chat.members.includes(senderLogin)) return { error: 'Вы не участник', code: 403 };
  if (chat.isChannel && !(chat.admins || []).includes(senderLogin) && chat.owner !== senderLogin) {
    return { error: 'В канале пишут админы', code: 403 };
  }

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
    text: trimmed, timestamp, replyTo: validReply, deleted: false,
    editedAt: null, reactions: []
  };

  await messagesCol.insertOne(msgDoc);
  await chatsCol.updateOne({ _id: chatId }, { $set: { updatedAt: timestamp } });
  await usersCol.updateOne({ login: senderLogin }, { $set: { lastSeen: timestamp } });

  const publicMsg = publicMessage(msgDoc);
  const out = JSON.stringify({ type: 'newMessage', payload: publicMsg });
  chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });

  return { message: publicMsg };
}

app.put('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Пустое' });
    if (text.trim().length > 200) return res.status(400).json({ error: 'Максимум 200' });

    const msg = await messagesCol.findOne({ _id: req.params.id });
    if (!msg || msg.deleted) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.sender !== req.userLogin) return res.status(403).json({ error: 'Только свои' });

    const age = Date.now() - new Date(msg.timestamp).getTime();
    if (age > EDIT_WINDOW_MS) return res.status(403).json({ error: 'Прошло больше 5 дней' });

    const editedAt = new Date().toISOString();
    await messagesCol.updateOne({ _id: msg._id }, { $set: { text: text.trim(), editedAt } });

    const fresh = await messagesCol.findOne({ _id: msg._id });
    const chat = await chatsCol.findOne({ _id: msg.chatId });
    const out = JSON.stringify({ type: 'messageEdited', payload: publicMessage(fresh) });
    if (chat) chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
      console.log(`[WS] ${ws.login} → online: ${clients.size}`);
      return;
    }

    if (!ws.login) return;
    if (!checkRate(ws.login)) { ws.send(JSON.stringify({ type: 'error', payload: 'Слишком быстро' })); return; }

    if (type === 'ping') { ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } })); return; }

    if (type === 'newMessage') {
      try {
        const { chatId, text, replyTo, clientId } = payload || {};
        const result = await processNewMessage(chatId, ws.login, text, clientId, replyTo);
        if (result.error) {
          ws.send(JSON.stringify({ type: 'error', payload: { clientId, error: result.error } }));
          return;
        }
        if (result.duplicate) {
          ws.send(JSON.stringify({ type: 'messageAck', payload: { clientId, id: result.message.id } }));
        }
      } catch (err) { console.error('WS newMessage:', err); }
      return;
    }

    if (type === 'editMessage') {
      try {
        const { messageId, text } = payload || {};
        if (!messageId || !text || !text.trim() || text.length > 200) return;
        const msg = await messagesCol.findOne({ _id: messageId });
        if (!msg || msg.deleted || msg.sender !== ws.login) return;
        const age = Date.now() - new Date(msg.timestamp).getTime();
        if (age > EDIT_WINDOW_MS) return;

        const editedAt = new Date().toISOString();
        await messagesCol.updateOne({ _id: messageId }, { $set: { text: text.trim(), editedAt } });
        const fresh = await messagesCol.findOne({ _id: messageId });
        const chat = await chatsCol.findOne({ _id: msg.chatId });
        if (!chat) return;
        const out = JSON.stringify({ type: 'messageEdited', payload: publicMessage(fresh) });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) { console.error('editMessage:', err); }
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
      } catch (err) { console.error('deleteMessage:', err); }
      return;
    }

    if (type === 'toggleReaction') {
      try {
        const { messageId, emoji } = payload || {};
        if (!messageId || !emoji || emoji.length > 8) return;
        const msg = await messagesCol.findOne({ _id: messageId });
        if (!msg || msg.deleted) return;
        const chat = await chatsCol.findOne({ _id: msg.chatId });
        if (!chat || !chat.members.includes(ws.login)) return;

        const reactions = msg.reactions || [];
        const idx = reactions.findIndex(r => r.emoji === emoji);
        if (idx === -1) {
          reactions.push({ emoji, logins: [ws.login] });
        } else {
          const logins = reactions[idx].logins || [];
          if (logins.includes(ws.login)) {
            reactions[idx].logins = logins.filter(l => l !== ws.login);
            if (reactions[idx].logins.length === 0) reactions.splice(idx, 1);
          } else {
            reactions[idx].logins.push(ws.login);
          }
        }
        await messagesCol.updateOne({ _id: messageId }, { $set: { reactions } });
        const fresh = await messagesCol.findOne({ _id: messageId });
        const out = JSON.stringify({ type: 'messageReaction', payload: publicMessage(fresh) });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) { console.error('toggleReaction:', err); }
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
        chat.members.forEach(u => {
          if (u === ws.login) return;
          const c = clients.get(u);
          if (c && c.readyState === WebSocket.OPEN) c.send(out);
        });
      } catch (err) {}
      return;
    }

    if (type === 'deleteChat') {
      try {
        const { chatId } = payload || {};
        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.login) || chat.isCommon) return;
        if (chat.type === 'group' && chat.owner !== ws.login) return;

        await messagesCol.deleteMany({ chatId });
        await chatsCol.deleteOne({ _id: chatId });
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
      console.log(`[WS] ${ws.login} → offline: ${clients.size}`);
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
    if (now - ws.lastPong > 60000) { try { ws.terminate(); } catch {} clients.delete(login); continue; }
    try { ws.send(JSON.stringify({ type: 'ping', payload: { t: now } })); } catch {}
  }
}, 20000);

setInterval(() => {
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

// ==== СТАРТ ====
(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🚀 Криста.Мессенджер v0.11 на порту ${PORT}`);
    console.log(`📦 MongoDB / ${DB_NAME}`);
  });
})();
