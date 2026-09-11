// ============================================================
// КРИСТА.МЕССЕНДЖЕР v0.7 — СЕРВЕР
// Express + WebSocket + MongoDB Atlas
// Личные диалоги + групповые чаты
// Новое: heartbeat, идемпотентность, флаги групп
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

if (!MONGO_URI) {
  console.error('❌ MONGO_URI не задан.');
  process.exit(1);
}

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

      console.log('✅ MongoDB подключена, база:', DB_NAME);
      return;
    } catch (err) {
      console.error(`❌ MongoDB ошибка: ${err.message}`);
      if (attempt >= 5) { console.error('💥 Выход'); process.exit(1); }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ==== ХЕЛПЕРЫ ====
const generateToken = (uin) => jwt.sign({ uin }, JWT_SECRET, { expiresIn: '30d' });
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
const generateUIN = () => String(Math.floor(10000000 + Math.random() * 90000000));
const generateChatId = () => String(Math.floor(100000000 + Math.random() * 900000000));

function publicUser(doc) {
  if (!doc) return null;
  return {
    uin: doc._id,
    username: doc.username,
    theme: doc.theme || 'neon',
    background: doc.background || '',
    buttonsOnTop: doc.buttonsOnTop !== false,
    createdAt: doc.createdAt,
    lastSeen: doc.lastSeen
  };
}

function publicChat(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    type: doc.type || 'dialog',
    members: doc.members,
    admins: doc.admins || [],
    owner: doc.owner || null,
    name: doc.name || null,
    publicId: doc.publicId || null,
    isPrivate: !!doc.isPrivate,
    isChannel: !!doc.isChannel,
    updatedAt: doc.updatedAt
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
    text: doc.text,
    timestamp: doc.timestamp,
    replyTo: doc.replyTo || null,
    deleted: doc.deleted ? 1 : 0
  };
}

// ==== EXPRESS ====
const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==== AUTH ====
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) return res.status(401).json({ error: 'Неверный токен' });
  req.userUin = decoded.uin;
  next();
}

// ============================================================
//  AUTH ROUTES
// ============================================================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, confirmPassword } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Имя: 3-30 символов' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ error: 'Пароли не совпадают' });

    const existingName = await usersCol.findOne({ username });
    if (existingName) return res.status(400).json({ error: 'Имя уже занято' });

    let uin = null;
    for (let i = 0; i < 20; i++) {
      const candidate = generateUIN();
      const exists = await usersCol.findOne({ _id: candidate });
      if (!exists) { uin = candidate; break; }
    }
    if (!uin) return res.status(500).json({ error: 'Не удалось создать UIN' });

    const hashed = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    await usersCol.insertOne({
      _id: uin, username, password: hashed,
      theme: 'neon', background: '', buttonsOnTop: false,
      createdAt: now, lastSeen: now
    });

    const token = generateToken(uin);
    res.status(201).json({ success: true, uin, username, token });
  } catch (err) {
    console.error('Register error:', err);
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
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверный пароль' });

    await usersCol.updateOne({ _id: uin }, { $set: { lastSeen: new Date().toISOString() } });
    const token = generateToken(uin);
    res.json({ success: true, uin, username: user.username, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: req.userUin });
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json(publicUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const { username, password, newPassword, theme, background, buttonsOnTop } = req.body || {};
    const user = await usersCol.findOne({ _id: req.userUin });
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const updates = {};
    if (username !== undefined) {
      if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Имя: 3-30 символов' });
      const ex = await usersCol.findOne({ username, _id: { $ne: req.userUin } });
      if (ex) return res.status(400).json({ error: 'Имя занято' });
      updates.username = username;
    }
    if (newPassword) {
      if (!password) return res.status(400).json({ error: 'Введите текущий пароль' });
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ error: 'Неверный текущий пароль' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль: мин. 6 символов' });
      updates.password = await bcrypt.hash(newPassword, 10);
    }
    if (theme !== undefined) {
      const allowed = ['neon', 'rose-void', 'light', 'blossom'];
      if (!allowed.includes(theme)) return res.status(400).json({ error: 'Неверная тема' });
      updates.theme = theme;
    }
    if (background !== undefined) updates.background = String(background).slice(0, 500);
    if (buttonsOnTop !== undefined) updates.buttonsOnTop = !!buttonsOnTop;

    if (Object.keys(updates).length === 0) return res.json({ success: true });
    await usersCol.updateOne({ _id: req.userUin }, { $set: updates });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/me', authMiddleware, async (req, res) => {
  try {
    const uin = req.userUin;
    const chats = await chatsCol.find({ members: uin }).toArray();
    for (const chat of chats) {
      await messagesCol.deleteMany({ chatId: chat._id });
      await chatsCol.deleteOne({ _id: chat._id });
    }
    await usersCol.deleteOne({ _id: uin });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
//  USERS
// ============================================================
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ users: [], chats: [] });

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const users = await usersCol.find({
      _id: { $ne: req.userUin },
      $or: [{ _id: regex }, { username: regex }]
    }).limit(15).toArray();

    const groups = await chatsCol.find({
      type: 'group',
      $or: [{ publicId: regex }, { name: regex }]
    }).limit(10).toArray();

    res.json({
      users: users.map(u => ({ uin: u._id, username: u.username })),
      chats: groups.map(g => ({
        id: g._id,
        publicId: g.publicId,
        name: g.name,
        membersCount: g.members.length,
        isPrivate: !!g.isPrivate,
        isMember: g.members.includes(req.userUin)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Поиск чата по ID
app.get('/api/chats/find/:publicId', authMiddleware, async (req, res) => {
  try {
    const publicId = String(req.params.publicId || '').trim();
    if (!/^\d{9}$/.test(publicId)) return res.status(400).json({ error: 'ID: 9 цифр' });

    const chat = await chatsCol.findOne({ publicId, type: 'group' });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.isPrivate && !chat.members.includes(req.userUin)) {
      return res.status(403).json({ error: 'Приватный чат. Нужно приглашение' });
    }

    res.json({
      id: chat._id,
      publicId: chat.publicId,
      name: chat.name,
      membersCount: chat.members.length,
      isPrivate: !!chat.isPrivate,
      isChannel: !!chat.isChannel,
      isMember: chat.members.includes(req.userUin)
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
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
      let title, subtitle, otherUin = null;

      if (isGroup) {
        title = chat.name;
        subtitle = `${chat.members.length} участ.${chat.isChannel ? ' · канал' : ''}`;
      } else {
        otherUin = chat.members.find(u => u !== req.userUin);
        const other = otherUin ? await usersCol.findOne({ _id: otherUin }, { projection: { username: 1 } }) : null;
        title = other?.username || '???';
        subtitle = `UIN: ${otherUin || '—'}`;
      }

      const lastMsg = await messagesCol
        .find({ chatId: chat._id, deleted: { $ne: true } })
        .sort({ timestamp: -1 }).limit(1).next();

      let unread = 0;
      if (me.lastSeen) {
        unread = await messagesCol.countDocuments({
          chatId: chat._id,
          sender: { $ne: req.userUin },
          timestamp: { $gt: me.lastSeen },
          deleted: { $ne: true }
        });
      }

      result.push({
        id: chat._id,
        type: chat.type || 'dialog',
        isGroup,
        isPrivate: !!chat.isPrivate,
        isChannel: !!chat.isChannel,
        isAdmin: (chat.admins || []).includes(req.userUin) || chat.owner === req.userUin,
        name: title,
        subtitle,
        publicId: chat.publicId || null,
        membersCount: chat.members.length,
        otherUin,
        lastMessage: lastMsg ? publicMessage(lastMsg) : null,
        unreadCount: unread,
        updatedAt: chat.updatedAt,
        online: otherUin ? clients.has(otherUin) : false
      });
    }

    result.sort((a, b) => {
      const at = a.lastMessage ? new Date(a.lastMessage.timestamp) : new Date(a.updatedAt);
      const bt = b.lastMessage ? new Date(b.lastMessage.timestamp) : new Date(b.updatedAt);
      return bt - at;
    });

    res.json(result);
  } catch (err) {
    console.error('Chats error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать личный диалог
app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { uin } = req.body || {};
    if (!uin || !/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'Неверный UIN' });
    if (uin === req.userUin) return res.status(400).json({ error: 'Нельзя добавить себя' });

    const other = await usersCol.findOne({ _id: uin });
    if (!other) return res.status(404).json({ error: 'Пользователь не найден' });

    const existing = await chatsCol.findOne({
      type: { $in: ['dialog', null] },
      members: { $all: [req.userUin, uin], $size: 2 }
    });
    if (existing) return res.json({ success: true, chatId: existing._id, existing: true });

    const chatId = uuidv4();
    const now = new Date().toISOString();

    await chatsCol.insertOne({
      _id: chatId,
      type: 'dialog',
      members: [req.userUin, uin],
      admins: [],
      owner: null,
      updatedAt: now
    });

    const client = clients.get(uin);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'chatCreated', payload: { chatId } }));
    }

    res.status(201).json({ success: true, chatId });
  } catch (err) {
    console.error('Create chat error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать группу / канал
app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, members, isPrivate, isChannel } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) {
      return res.status(400).json({ error: 'Название: 1-60 символов' });
    }
    const membersArr = Array.isArray(members) ? members : [];

    // Проверяем всех участников
    const uniqueMembers = [...new Set(membersArr.filter(u => /^\d{8}$/.test(u)))];
    for (const u of uniqueMembers) {
      const exists = await usersCol.findOne({ _id: u });
      if (!exists) return res.status(404).json({ error: `Пользователь ${u} не найден` });
    }

    // Генерация 9-значного publicId
    let publicId = null;
    for (let i = 0; i < 20; i++) {
      const candidate = generateChatId();
      const ex = await chatsCol.findOne({ publicId: candidate });
      if (!ex) { publicId = candidate; break; }
    }
    if (!publicId) return res.status(500).json({ error: 'Не удалось создать ID' });

    const chatId = uuidv4();
    const now = new Date().toISOString();
    const allMembers = [...new Set([req.userUin, ...uniqueMembers])];

    await chatsCol.insertOne({
      _id: chatId,
      type: 'group',
      name: name.trim(),
      publicId,
      members: allMembers,
      admins: [req.userUin],
      owner: req.userUin,
      isPrivate: !!isPrivate,
      isChannel: !!isChannel,
      updatedAt: now
    });

    const payload = { type: 'chatCreated', payload: { chatId } };
    allMembers.forEach(uin => {
      const c = clients.get(uin);
      if (c && c.readyState === WebSocket.OPEN) c.send(JSON.stringify(payload));
    });

    res.status(201).json({ success: true, chatId, publicId });
  } catch (err) {
    console.error('Create group error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вступить в группу
app.post('/api/chats/:chatId/join', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (chat.members.includes(req.userUin)) return res.json({ success: true, already: true });
    if (chat.isPrivate) return res.status(403).json({ error: 'Приватный чат. Нужно приглашение' });

    await chatsCol.updateOne(
      { _id: chat._id },
      { $push: { members: req.userUin }, $set: { updatedAt: new Date().toISOString() } }
    );

    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, uin: req.userUin } });
    [...chat.members, req.userUin].forEach(m => {
      const c = clients.get(m);
      if (c && c.readyState === WebSocket.OPEN) c.send(out);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Покинуть группу
app.post('/api/chats/:chatId/leave', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userUin)) return res.json({ success: true });
    if (chat.owner === req.userUin) return res.status(400).json({ error: 'Владелец не может выйти — удали чат' });

    await chatsCol.updateOne(
      { _id: chat._id },
      {
        $pull: { members: req.userUin, admins: req.userUin },
        $set: { updatedAt: new Date().toISOString() }
      }
    );

    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, uin: req.userUin } });
    chat.members.forEach(uin => {
      const c = clients.get(uin);
      if (c && c.readyState === WebSocket.OPEN) c.send(out);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить чат
app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });

    if (chat.type === 'group' && chat.owner !== req.userUin) {
      return res.status(403).json({ error: 'Только владелец может удалить группу' });
    }

    await messagesCol.deleteMany({ chatId: chat._id });
    await chatsCol.deleteOne({ _id: chat._id });

    chat.members.forEach(uin => {
      const c = clients.get(uin);
      if (c && c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify({ type: 'chatDeleted', payload: { chatId: chat._id } }));
      }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Информация о чате
app.get('/api/chats/:chatId/info', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userUin) && !chat.isPrivate) {
      // Можно смотреть инфо не-приватной группы
    } else if (!chat.members.includes(req.userUin)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const membersInfo = [];
    for (const uin of chat.members) {
      const u = await usersCol.findOne({ _id: uin }, { projection: { username: 1 } });
      membersInfo.push({
        uin,
        username: u?.username || '???',
        isAdmin: (chat.admins || []).includes(uin),
        isOwner: chat.owner === uin
      });
    }

    res.json({
      ...publicChat(chat),
      membersInfo,
      isMember: chat.members.includes(req.userUin),
      isAdmin: (chat.admins || []).includes(req.userUin) || chat.owner === req.userUin
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Переименовать
app.put('/api/chats/:chatId/name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) {
      return res.status(400).json({ error: 'Название: 1-60 символов' });
    }
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userUin)) return res.status(403).json({ error: 'Только админ' });

    await chatsCol.updateOne({ _id: chat._id }, { $set: { name: name.trim(), updatedAt: new Date().toISOString() } });

    const out = JSON.stringify({ type: 'chatRenamed', payload: { chatId: chat._id, name: name.trim() } });
    chat.members.forEach(uin => {
      const c = clients.get(uin);
      if (c && c.readyState === WebSocket.OPEN) c.send(out);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Переключить флаги
app.put('/api/chats/:chatId/flags', authMiddleware, async (req, res) => {
  try {
    const { isPrivate, isChannel } = req.body || {};
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (chat.owner !== req.userUin) return res.status(403).json({ error: 'Только владелец' });

    const updates = {};
    if (isPrivate !== undefined) updates.isPrivate = !!isPrivate;
    if (isChannel !== undefined) updates.isChannel = !!isChannel;
    updates.updatedAt = new Date().toISOString();

    await chatsCol.updateOne({ _id: chat._id }, { $set: updates });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить участника
app.delete('/api/chats/:chatId/members/:uin', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userUin)) return res.status(403).json({ error: 'Только админ' });

    const targetUin = req.params.uin;
    if (targetUin === chat.owner) return res.status(400).json({ error: 'Нельзя удалить владельца' });
    if (!chat.members.includes(targetUin)) return res.status(404).json({ error: 'Не участник' });

    await chatsCol.updateOne(
      { _id: chat._id },
      {
        $pull: { members: targetUin, admins: targetUin },
        $set: { updatedAt: new Date().toISOString() }
      }
    );

    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, uin: targetUin } });
    chat.members.forEach(uin => {
      const c = clients.get(uin);
      if (c && c.readyState === WebSocket.OPEN) c.send(out);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавить участника
app.post('/api/chats/:chatId/members', authMiddleware, async (req, res) => {
  try {
    const { uin } = req.body || {};
    if (!uin || !/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'Неверный UIN' });

    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'Не группа' });
    if (!(chat.admins || []).includes(req.userUin)) return res.status(403).json({ error: 'Только админ' });
    if (chat.members.includes(uin)) return res.status(400).json({ error: 'Уже участник' });

    const user = await usersCol.findOne({ _id: uin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    await chatsCol.updateOne(
      { _id: chat._id },
      { $push: { members: uin }, $set: { updatedAt: new Date().toISOString() } }
    );

    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, uin, username: user.username } });
    [...chat.members, uin].forEach(m => {
      const c = clients.get(m);
      if (c && c.readyState === WebSocket.OPEN) c.send(out);
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Сообщения
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });

    const msgs = await messagesCol
      .find({ chatId: chat._id, deleted: { $ne: true } })
      .sort({ timestamp: 1 }).limit(500).toArray();

    await usersCol.updateOne({ _id: req.userUin }, { $set: { lastSeen: new Date().toISOString() } });

    res.json(msgs.map(publicMessage));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
  if (cur.count >= 12) return false;
  cur.count++;
  return true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.uin = null;
  ws.lastPongFromClient = Date.now();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const { type, payload } = data;

    // ==== PONG от клиента ====
    if (type === 'pong') {
      ws.lastPongFromClient = Date.now();
      return;
    }

    if (type === 'auth') {
      const decoded = verifyToken(payload?.token);
      if (!decoded) { ws.close(); return; }
      const user = await usersCol.findOne({ _id: decoded.uin });
      if (!user) { ws.close(); return; }
      ws.uin = decoded.uin;
      clients.set(ws.uin, ws);
      broadcast({ type: 'status', payload: { uin: ws.uin, status: 'online' } });
      // Сразу шлём pong, чтобы клиент понял, что связь есть
      ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } }));
      return;
    }

    if (!ws.uin) return;
    if (!checkRate(ws.uin)) {
      ws.send(JSON.stringify({ type: 'error', payload: 'Слишком часто' }));
      return;
    }

    // ==== PING от клиента (для проверки живости) ====
    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } }));
      return;
    }

    // ==== НОВОЕ СООБЩЕНИЕ ====
    if (type === 'newMessage') {
      try {
        const { chatId, text, replyTo, clientId } = payload || {};
        if (!chatId || typeof text !== 'string') return;
        const trimmed = text.trim();
        if (!trimmed || trimmed.length > 200) return;

        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.uin)) return;

        // Канал — пишут только админы
        if (chat.isChannel && !(chat.admins || []).includes(ws.uin) && chat.owner !== ws.uin) {
          ws.send(JSON.stringify({ type: 'error', payload: 'В канале пишут только админы' }));
          return;
        }

        const user = await usersCol.findOne({ _id: ws.uin }, { projection: { username: 1 } });
        if (!user) return;

        // Идемпотентность: если клиент прислал clientId и такое сообщение уже есть — не дублируем
        const msgId = clientId || uuidv4();
        if (clientId) {
          const existing = await messagesCol.findOne({ _id: msgId });
          if (existing) {
            // Уже сохранили — просто подтверждаем
            ws.send(JSON.stringify({ type: 'messageAck', payload: { clientId, id: msgId } }));
            return;
          }
        }

        let validReply = null;
        if (replyTo) {
          const parent = await messagesCol.findOne({ _id: replyTo, chatId, deleted: { $ne: true } });
          if (parent) validReply = parent._id;
        }

        const timestamp = new Date().toISOString();
        const msgDoc = {
          _id: msgId,
          clientId: clientId || null,
          chatId,
          sender: ws.uin,
          senderName: user.username,
          text: trimmed,
          timestamp,
          replyTo: validReply,
          deleted: false
        };

        await messagesCol.insertOne(msgDoc);
        await chatsCol.updateOne({ _id: chatId }, { $set: { updatedAt: timestamp } });
        await usersCol.updateOne({ _id: ws.uin }, { $set: { lastSeen: timestamp } });

        const out = JSON.stringify({ type: 'newMessage', payload: publicMessage(msgDoc) });
        chat.members.forEach(uin => {
          const c = clients.get(uin);
          if (c && c.readyState === WebSocket.OPEN) c.send(out);
        });
      } catch (err) { console.error('newMessage:', err); }
      return;
    }

    // ==== УДАЛИТЬ СООБЩЕНИЕ ====
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
        chat.members.forEach(uin => {
          const c = clients.get(uin);
          if (c && c.readyState === WebSocket.OPEN) c.send(out);
        });
      } catch (err) { console.error('deleteMessage:', err); }
      return;
    }

    // ==== УДАЛИТЬ ЧАТ ====
    if (type === 'deleteChat') {
      try {
        const { chatId } = payload || {};
        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.uin)) return;
        if (chat.type === 'group' && chat.owner !== ws.uin) return;

        await messagesCol.deleteMany({ chatId });
        await chatsCol.deleteOne({ _id: chatId });

        const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
        chat.members.forEach(uin => {
          const c = clients.get(uin);
          if (c && c.readyState === WebSocket.OPEN) c.send(out);
        });
      } catch (err) { console.error('deleteChat:', err); }
      return;
    }
  });

  ws.on('close', () => {
    if (ws.uin) {
      clients.delete(ws.uin);
      broadcast({ type: 'status', payload: { uin: ws.uin, status: 'offline' } });
    }
  });
  ws.on('error', (err) => console.error('WS:', err));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, c] of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

// Server → client ping (проверка живости)
setInterval(() => {
  const now = Date.now();
  for (const [uin, ws] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    // Если клиент давно не отвечал — рвём
    if (now - ws.lastPongFromClient > 45000) {
      try { ws.terminate(); } catch {}
      clients.delete(uin);
      broadcast({ type: 'status', payload: { uin, status: 'offline' } });
      continue;
    }
    try {
      ws.send(JSON.stringify({ type: 'ping', payload: { t: now } }));
    } catch {}
  }
}, 15000);

// Нативный ws.ping (низкоуровневый)
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
    console.log(`🚀 Криста.Мессенджер v0.7 запущен на порту ${PORT}`);
    console.log(`📦 База данных: MongoDB Atlas / ${DB_NAME}`);
  });
})();
