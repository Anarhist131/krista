// ============================================================
// КРИСТА.МЕССЕНДЖЕР v0.10 — СЕРВЕР
// Express + WebSocket + MongoDB
// Новое: профиль (ник/цвет/статус/аватар), реакции, печатает,
// редактирование, фикс ack/error, HTTP-фолбэк отправки
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
const EDIT_WINDOW_MS = 5 * 24 * 60 * 60 * 1000; // 5 дней

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

      await usersCol.createIndex({ username: 1 }, { unique: true });
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
const generateToken = (uin) => jwt.sign({ uin }, JWT_SECRET, { expiresIn: '30d' });
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
const generateUIN = () => String(Math.floor(10000000 + Math.random() * 90000000));
const generateChatId = () => String(Math.floor(100000000 + Math.random() * 900000000));

const STATUS_COLORS = {
  online: '#7ee0a0',
  away: '#ffcc55',
  dnd: '#ff6a8a',
  custom: '#a89ab0'
};

function publicUser(doc) {
  if (!doc) return null;
  return {
    uin: doc._id,
    username: doc.username,
    theme: doc.theme || 'neon-rose',
    nicknameColor: doc.nicknameColor || '#f0e8ee',
    status: doc.status || 'online',
    statusText: doc.statusText || '',
    statusColor: doc.statusColor || STATUS_COLORS.online,
    avatarType: doc.avatarType || 'initial',
    avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#ff9ec4',
    createdAt: doc.createdAt,
    lastSeen: doc.lastSeen
  };
}

// Публичный профиль для других (короткая версия)
function publicUserShort(doc) {
  if (!doc) return null;
  return {
    uin: doc._id,
    username: doc.username,
    nicknameColor: doc.nicknameColor || '#f0e8ee',
    status: doc.status || 'online',
    statusText: doc.statusText || '',
    statusColor: doc.statusColor || STATUS_COLORS.online,
    avatarType: doc.avatarType || 'initial',
    avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#ff9ec4'
  };
}

function publicChat(doc) {
  if (!doc) return null;
  return {
    id: doc._id, type: doc.type || 'dialog', members: doc.members,
    admins: doc.admins || [], owner: doc.owner || null, name: doc.name || null,
    publicId: doc.publicId || null, isPrivate: !!doc.isPrivate,
    isChannel: !!doc.isChannel, isCommon: !!doc.isCommon, updatedAt: doc.updatedAt
  };
}

function publicMessage(doc) {
  if (!doc) return null;
  return {
    id: doc._id, clientId: doc.clientId || null, chatId: doc.chatId,
    sender: doc.sender, senderName: doc.senderName, text: doc.text,
    timestamp: doc.timestamp, replyTo: doc.replyTo || null,
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
  req.userUin = decoded.uin;
  next();
}

// ============================================================
//  AUTH
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, confirmPassword } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Имя: 3-30' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль: мин. 6' });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ error: 'Пароли не совпадают' });

    if (await usersCol.findOne({ username })) return res.status(400).json({ error: 'Имя занято' });

    let uin = null;
    for (let i = 0; i < 20; i++) {
      const c = generateUIN();
      if (!(await usersCol.findOne({ _id: c }))) { uin = c; break; }
    }
    if (!uin) return res.status(500).json({ error: 'Не удалось создать UIN' });

    const hashed = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    await usersCol.insertOne({
      _id: uin, username, password: hashed,
      theme: 'neon-rose',
      nicknameColor: '#f0e8ee',
      status: 'online', statusText: '', statusColor: STATUS_COLORS.online,
      avatarType: 'initial', avatarEmoji: '', avatarBgColor: '#ff9ec4',
      createdAt: now, lastSeen: now
    });

    await chatsCol.updateOne({ _id: COMMON_CHAT_ID }, { $addToSet: { members: uin }, $set: { updatedAt: now } });

    const token = generateToken(uin);
    res.status(201).json({ success: true, uin, username, token });
  } catch (err) {
    console.error('Register:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { uin, password } = req.body || {};
    if (!uin || !password) return res.status(400).json({ error: 'Заполните поля' });
    if (!/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'UIN: 8 цифр' });

    const user = await usersCol.findOne({ _id: uin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверный пароль' });

    await usersCol.updateOne({ _id: uin }, { $set: { lastSeen: new Date().toISOString() } });
    await chatsCol.updateOne({ _id: COMMON_CHAT_ID }, { $addToSet: { members: uin } });

    const token = generateToken(uin);
    res.json({ success: true, uin, username: user.username, token });
  } catch (err) {
    console.error('Login:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: req.userUin });
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json(publicUser(user));
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const user = await usersCol.findOne({ _id: req.userUin });
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const updates = {};

    if (b.username !== undefined) {
      if (b.username.length < 3 || b.username.length > 30) return res.status(400).json({ error: 'Имя: 3-30' });
      if (await usersCol.findOne({ username: b.username, _id: { $ne: req.userUin } })) {
        return res.status(400).json({ error: 'Имя занято' });
      }
      updates.username = b.username;
    }

    if (b.newPassword) {
      if (!b.password) return res.status(400).json({ error: 'Введите текущий пароль' });
      if (!(await bcrypt.compare(b.password, user.password))) return res.status(401).json({ error: 'Неверный пароль' });
      if (b.newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль: мин. 6' });
      updates.password = await bcrypt.hash(b.newPassword, 10);
    }

    if (b.theme !== undefined) {
      const allowed = ['neon-rose','neon-cyan','neon-lime','neon-purple','light-rose','light-cyan','rose-void','blossom'];
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
      if (!['initial','emoji'].includes(b.avatarType)) return res.status(400).json({ error: 'Неверный тип аватара' });
      updates.avatarType = b.avatarType;
    }
    if (b.avatarEmoji !== undefined) updates.avatarEmoji = String(b.avatarEmoji).slice(0, 8);
    if (b.avatarBgColor !== undefined) updates.avatarBgColor = String(b.avatarBgColor).slice(0, 20);

    if (Object.keys(updates).length === 0) return res.json({ success: true });
    await usersCol.updateOne({ _id: req.userUin }, { $set: updates });

    // Оповещаем всех об изменении профиля
    const fresh = await usersCol.findOne({ _id: req.userUin });
    broadcast({ type: 'userUpdated', payload: publicUserShort(fresh) });

    res.json({ success: true });
  } catch (err) {
    console.error('Update me:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/me', authMiddleware, async (req, res) => {
  try {
    const uin = req.userUin;
    const chats = await chatsCol.find({ members: uin }).toArray();
    for (const chat of chats) {
      if (chat.isCommon) {
        await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: uin } });
      } else {
        await messagesCol.deleteMany({ chatId: chat._id });
        await chatsCol.deleteOne({ _id: chat._id });
      }
    }
    await usersCol.deleteOne({ _id: uin });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  SEARCH
// ============================================================
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [], chats: [] });

    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(esc, 'i');

    const users = await usersCol.find({
      _id: { $ne: req.userUin },
      $or: [{ _id: regex }, { username: regex }]
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
        isMember: g.members.includes(req.userUin)
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
    if (chat.isPrivate && !chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Приватный' });
    res.json({
      id: chat._id, publicId: chat.publicId, name: chat.name,
      membersCount: chat.members.length, isPrivate: !!chat.isPrivate,
      isChannel: !!chat.isChannel, isCommon: !!chat.isCommon,
      isMember: chat.members.includes(req.userUin)
    });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// ============================================================
//  CHATS
// ============================================================
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = await usersCol.findOne({ _id: req.userUin });
    if (!me) return res.status(404).json({ error: 'Не найден' });

    const myChats = await chatsCol.find({ members: req.userUin }).toArray();
    const result = [];

    for (const chat of myChats) {
      const isGroup = chat.type === 'group';
      let title, subtitle, otherUin = null, otherUser = null;

      if (isGroup) {
        title = chat.name;
        subtitle = chat.isCommon
          ? `${chat.members.length} участ. · общий`
          : `${chat.members.length} участ.${chat.isChannel ? ' · канал' : ''}`;
      } else {
        otherUin = chat.members.find(u => u !== req.userUin);
        otherUser = otherUin ? await usersCol.findOne({ _id: otherUin }) : null;
        title = otherUser?.username || '???';
        subtitle = otherUser ? (otherUser.statusText || statusLabel(otherUser.status)) : '—';
      }

      const lastMsg = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } })
        .sort({ timestamp: -1 }).limit(1).next();

      let unread = 0;
      if (me.lastSeen) {
        unread = await messagesCol.countDocuments({
          chatId: chat._id, sender: { $ne: req.userUin },
          timestamp: { $gt: me.lastSeen }, deleted: { $ne: true }
        });
      }

      result.push({
        id: chat._id, type: chat.type || 'dialog', isGroup,
        isPrivate: !!chat.isPrivate, isChannel: !!chat.isChannel,
        isCommon: !!chat.isCommon,
        isAdmin: (chat.admins || []).includes(req.userUin) || chat.owner === req.userUin,
        name: title, subtitle,
        publicId: chat.publicId || null, membersCount: chat.members.length,
        otherUin,
        otherUser: otherUser ? publicUserShort(otherUser) : null,
        lastMessage: lastMsg ? publicMessage(lastMsg) : null,
        unreadCount: unread, updatedAt: chat.updatedAt,
        online: otherUin ? clients.has(otherUin) : false
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
    const { uin } = req.body || {};
    if (!uin || !/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'Неверный UIN' });
    if (uin === req.userUin) return res.status(400).json({ error: 'Нельзя добавить себя' });
    if (!(await usersCol.findOne({ _id: uin }))) return res.status(404).json({ error: 'Не найден' });

    const existing = await chatsCol.findOne({
      type: { $in: ['dialog', null] },
      members: { $all: [req.userUin, uin], $size: 2 }
    });
    if (existing) return res.json({ success: true, chatId: existing._id, existing: true });

    const chatId = uuidv4();
    const now = new Date().toISOString();
    await chatsCol.insertOne({
      _id: chatId, type: 'dialog', members: [req.userUin, uin],
      admins: [], owner: null, updatedAt: now
    });

    const c = clients.get(uin);
    if (c && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'chatCreated', payload: { chatId } }));

    res.status(201).json({ success: true, chatId });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, members, isPrivate, isChannel } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'Название: 1-60' });
    const arr = Array.isArray(members) ? members : [];
    const uniq = [...new Set(arr.filter(u => /^\d{8}$/.test(u)))];
    for (const u of uniq) {
      if (!(await usersCol.findOne({ _id: u }))) return res.status(404).json({ error: `UIN ${u} не найден` });
    }

    let publicId = null;
    for (let i = 0; i < 20; i++) {
      const c = generateChatId();
      if (!(await chatsCol.findOne({ publicId: c }))) { publicId = c; break; }
    }
    if (!publicId) return res.status(500).json({ error: 'Не удалось создать ID' });

    const chatId = uuidv4();
    const now = new Date().toISOString();
    const allMembers = [...new Set([req.userUin, ...uniq])];

    await chatsCol.insertOne({
      _id: chatId, type: 'group', name: name.trim(), publicId,
      members: allMembers, admins: [req.userUin], owner: req.userUin,
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
    if (chat.members.includes(req.userUin)) return res.json({ success: true, already: true });
    if (chat.isPrivate && !chat.isCommon) return res.status(403).json({ error: 'Приватный' });

    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: req.userUin }, $set: { updatedAt: new Date().toISOString() } });

    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, uin: req.userUin } });
    [...chat.members, req.userUin].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats/:chatId/leave', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Из общего нельзя выйти' });
    if (!chat.members.includes(req.userUin)) return res.json({ success: true });
    if (chat.owner === req.userUin) return res.status(400).json({ error: 'Владелец не может выйти' });

    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: req.userUin, admins: req.userUin }, $set: { updatedAt: new Date().toISOString() } });

    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, uin: req.userUin } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Общий нельзя удалить' });
    if (!chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });
    if (chat.type === 'group' && chat.owner !== req.userUin) return res.status(403).json({ error: 'Только владелец' });

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
    if (!chat.members.includes(req.userUin) && chat.isPrivate) return res.status(403).json({ error: 'Нет доступа' });

    const membersInfo = [];
    for (const uin of chat.members) {
      const u = await usersCol.findOne({ _id: uin });
      membersInfo.push({
        ...publicUserShort(u),
        isAdmin: (chat.admins || []).includes(uin),
        isOwner: chat.owner === uin,
        online: clients.has(uin)
      });
    }

    res.json({
      ...publicChat(chat), membersInfo,
      isMember: chat.members.includes(req.userUin),
      isAdmin: (chat.admins || []).includes(req.userUin) || chat.owner === req.userUin
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
    if (!(chat.admins || []).includes(req.userUin)) return res.status(403).json({ error: 'Только админ' });

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
    if (chat.owner !== req.userUin) return res.status(403).json({ error: 'Только владелец' });

    const up = { updatedAt: new Date().toISOString() };
    if (isPrivate !== undefined) up.isPrivate = !!isPrivate;
    if (isChannel !== undefined) up.isChannel = !!isChannel;
    await chatsCol.updateOne({ _id: chat._id }, { $set: up });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.delete('/api/chats/:chatId/members/:uin', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'Из общего нельзя' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userUin)) return res.status(403).json({ error: 'Только админ' });

    const target = req.params.uin;
    if (target === chat.owner) return res.status(400).json({ error: 'Владельца нельзя' });
    if (!chat.members.includes(target)) return res.status(404).json({ error: 'Не участник' });

    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: target, admins: target }, $set: { updatedAt: new Date().toISOString() } });

    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, uin: target } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/chats/:chatId/members', authMiddleware, async (req, res) => {
  try {
    const { uin } = req.body || {};
    if (!uin || !/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'Неверный UIN' });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.isCommon) return res.status(400).json({ error: 'В общий автоматом' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userUin)) return res.status(403).json({ error: 'Только админ' });
    if (chat.members.includes(uin)) return res.status(400).json({ error: 'Уже участник' });
    const user = await usersCol.findOne({ _id: uin });
    if (!user) return res.status(404).json({ error: 'Не найден' });

    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: uin }, $set: { updatedAt: new Date().toISOString() } });

    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, uin, username: user.username } });
    [...chat.members, uin].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
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
    if (!chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });

    const msgs = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } })
      .sort({ timestamp: 1 }).limit(500).toArray();

    await usersCol.updateOne({ _id: req.userUin }, { $set: { lastSeen: new Date().toISOString() } });
    res.json(msgs.map(publicMessage));
  } catch (err) { res.status(500).json({ error: 'Ошибка' }); }
});

// HTTP фолбэк для отправки сообщения
app.post('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const { text, clientId, replyTo } = req.body || {};
    const result = await processNewMessage(req.params.chatId, req.userUin, text, clientId, replyTo);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.status(201).json(result.message);
  } catch (err) {
    console.error('HTTP send:', err);
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Общая логика отправки — используется WS и HTTP
async function processNewMessage(chatId, senderUin, text, clientId, replyTo) {
  if (!chatId || typeof text !== 'string') return { error: 'Неверные данные', code: 400 };
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Пустое', code: 400 };
  if (trimmed.length > 200) return { error: 'Максимум 200', code: 400 };

  const chat = await chatsCol.findOne({ _id: chatId });
  if (!chat) return { error: 'Чат не найден', code: 404 };
  if (!chat.members.includes(senderUin)) return { error: 'Вы не участник', code: 403 };
  if (chat.isChannel && !(chat.admins || []).includes(senderUin) && chat.owner !== senderUin) {
    return { error: 'В канале пишут админы', code: 403 };
  }

  const user = await usersCol.findOne({ _id: senderUin });
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
    sender: senderUin, senderName: user.username,
    text: trimmed, timestamp, replyTo: validReply, deleted: false,
    editedAt: null, reactions: []
  };

  await messagesCol.insertOne(msgDoc);
  await chatsCol.updateOne({ _id: chatId }, { $set: { updatedAt: timestamp } });
  await usersCol.updateOne({ _id: senderUin }, { $set: { lastSeen: timestamp } });

  const publicMsg = publicMessage(msgDoc);
  const out = JSON.stringify({ type: 'newMessage', payload: publicMsg });
  chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });

  return { message: publicMsg };
}

// Редактирование
app.put('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Пустое' });
    if (text.trim().length > 200) return res.status(400).json({ error: 'Максимум 200' });

    const msg = await messagesCol.findOne({ _id: req.params.id });
    if (!msg || msg.deleted) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.sender !== req.userUin) return res.status(403).json({ error: 'Только свои' });

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

function checkRate(uin) {
  const now = Date.now();
  const cur = wsRate.get(uin);
  if (!cur || now - cur.first > 3000) { wsRate.set(uin, { count: 1, first: now }); return true; }
  if (cur.count >= 15) return false;
  cur.count++;
  return true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.uin = null;
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
      const user = await usersCol.findOne({ _id: dec.uin });
      if (!user) { ws.close(); return; }
      ws.uin = dec.uin;
      clients.set(ws.uin, ws);
      broadcast({ type: 'status', payload: { uin: ws.uin, status: 'online' } });
      ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } }));
      console.log(`[WS] ${ws.uin} (${user.username}) → online: ${clients.size}`);
      return;
    }

    if (!ws.uin) return;
    if (!checkRate(ws.uin)) { ws.send(JSON.stringify({ type: 'error', payload: 'Слишком быстро' })); return; }

    if (type === 'ping') { ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } })); return; }

    if (type === 'newMessage') {
      try {
        const { chatId, text, replyTo, clientId } = payload || {};
        const result = await processNewMessage(chatId, ws.uin, text, clientId, replyTo);
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
        if (!msg || msg.deleted || msg.sender !== ws.uin) return;
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
        const isAuthor = msg.sender === ws.uin;
        const isAdmin = chat.type === 'group' && ((chat.admins || []).includes(ws.uin) || chat.owner === ws.uin);
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
        if (!chat || !chat.members.includes(ws.uin)) return;

        const reactions = msg.reactions || [];
        const idx = reactions.findIndex(r => r.emoji === emoji);
        if (idx === -1) {
          reactions.push({ emoji, uins: [ws.uin] });
        } else {
          const uins = reactions[idx].uins || [];
          if (uins.includes(ws.uin)) {
            reactions[idx].uins = uins.filter(u => u !== ws.uin);
            if (reactions[idx].uins.length === 0) reactions.splice(idx, 1);
          } else {
            reactions[idx].uins.push(ws.uin);
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
        if (!chat || !chat.members.includes(ws.uin)) return;
        const user = await usersCol.findOne({ _id: ws.uin }, { projection: { username: 1 } });
        if (!user) return;

        const out = JSON.stringify({ type: 'typing', payload: { chatId, uin: ws.uin, username: user.username } });
        chat.members.forEach(u => {
          if (u === ws.uin) return;
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
        if (!chat || !chat.members.includes(ws.uin) || chat.isCommon) return;
        if (chat.type === 'group' && chat.owner !== ws.uin) return;

        await messagesCol.deleteMany({ chatId });
        await chatsCol.deleteOne({ _id: chatId });
        const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }
  });

  ws.on('close', () => {
    if (ws.uin) {
      clients.delete(ws.uin);
      broadcast({ type: 'status', payload: { uin: ws.uin, status: 'offline' } });
      console.log(`[WS] ${ws.uin} → offline: ${clients.size}`);
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
  for (const [uin, ws] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (now - ws.lastPong > 60000) { try { ws.terminate(); } catch {} clients.delete(uin); continue; }
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
    console.log(`🚀 Криста.Мессенджер v0.10 на порту ${PORT}`);
    console.log(`📦 MongoDB / ${DB_NAME}`);
  });
})();
