// ============================================================
// КРИСТА.МЕССЕНДЖЕР v0.4 — СЕРВЕР (MongoDB)
// Express + WebSocket + MongoDB Atlas
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

// ==== КОНФИГ (из переменных окружения Render) ====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me_please_1234567890';
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'krista';

if (!MONGO_URI) {
  console.error('❌ MONGO_URI не задан. Добавь переменную окружения на Render.');
  process.exit(1);
}

// ==== MONGODB ====
let usersCol, chatsCol, messagesCol;

const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
  socketTimeoutMS: 45000
});

async function connectDB() {
  let attempt = 0;
  const maxAttempts = 5;
  while (attempt < maxAttempts) {
    try {
      attempt++;
      console.log(`🔌 MongoDB: попытка ${attempt}/${maxAttempts}...`);
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      usersCol = db.collection('users');
      chatsCol = db.collection('chats');
      messagesCol = db.collection('messages');

      // Индексы
      await usersCol.createIndex({ username: 1 }, { unique: true });
      await messagesCol.createIndex({ chatId: 1, timestamp: 1 });
      await chatsCol.createIndex({ members: 1 });

      console.log('✅ MongoDB подключена, база:', DB_NAME);
      return;
    } catch (err) {
      console.error(`❌ MongoDB ошибка: ${err.message}`);
      if (attempt >= maxAttempts) {
        console.error('💥 Не удалось подключиться к MongoDB. Выход.');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ==== ХЕЛПЕРЫ ====
function generateToken(uin) {
  return jwt.sign({ uin }, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function generateUIN() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

// Преобразование документа пользователя в публичный вид
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

// Преобразование чата
function publicChat(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    members: doc.members,
    updatedAt: doc.updatedAt
  };
}

// Преобразование сообщения
function publicMessage(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
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

// ==== AUTH MIDDLEWARE ====
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  const token = auth.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Неверный токен' });
  req.userUin = decoded.uin;
  next();
}

// ============================================================
//  API
// ============================================================

// --- РЕГИСТРАЦИЯ ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, confirmPassword } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Заполните все поля' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Имя: от 3 до 30 символов' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Пароли не совпадают' });
    }

    // Проверка имени
    const existingName = await usersCol.findOne({ username });
    if (existingName) return res.status(400).json({ error: 'Имя уже занято' });

    // Генерация уникального UIN
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
      _id: uin,
      username,
      password: hashed,
      theme: 'neon',
      background: '',
      buttonsOnTop: true,
      createdAt: now,
      lastSeen: now
    });

    const token = generateToken(uin);
    res.status(201).json({ success: true, uin, username, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- ВХОД ---
app.post('/api/login', async (req, res) => {
  try {
    const { uin, password } = req.body || {};
    if (!uin || !password) return res.status(400).json({ error: 'Заполните поля' });
    if (!/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'UIN: 8 цифр' });

    const user = await usersCol.findOne({ _id: uin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверный пароль' });

    await usersCol.updateOne(
      { _id: uin },
      { $set: { lastSeen: new Date().toISOString() } }
    );

    const token = generateToken(uin);
    res.json({ success: true, uin, username: user.username, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- ПРОФИЛЬ ---
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await usersCol.findOne({ _id: req.userUin });
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json(publicUser(user));
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- ОБНОВИТЬ ПРОФИЛЬ ---
app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const { username, password, newPassword, theme, background, buttonsOnTop } = req.body || {};
    const user = await usersCol.findOne({ _id: req.userUin });
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const updates = {};

    if (username !== undefined) {
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Имя: от 3 до 30 символов' });
      }
      const existing = await usersCol.findOne({ username, _id: { $ne: req.userUin } });
      if (existing) return res.status(400).json({ error: 'Имя занято' });
      updates.username = username;
    }

    if (newPassword) {
      if (!password) return res.status(400).json({ error: 'Введите текущий пароль' });
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Неверный текущий пароль' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль: мин. 6 символов' });
      updates.password = await bcrypt.hash(newPassword, 10);
    }

    if (theme !== undefined) {
      const allowed = ['neon', 'rose-void', 'light', 'blossom'];
      if (!allowed.includes(theme)) return res.status(400).json({ error: 'Неверная тема' });
      updates.theme = theme;
    }

    if (background !== undefined) {
      updates.background = String(background).slice(0, 500);
    }

    if (buttonsOnTop !== undefined) {
      updates.buttonsOnTop = !!buttonsOnTop;
    }

    if (Object.keys(updates).length === 0) return res.json({ success: true });

    await usersCol.updateOne({ _id: req.userUin }, { $set: updates });
    res.json({ success: true });
  } catch (err) {
    console.error('Update me error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- УДАЛИТЬ АККАУНТ ---
app.delete('/api/me', authMiddleware, async (req, res) => {
  try {
    const uin = req.userUin;
    // Находим все чаты пользователя
    const chats = await chatsCol.find({ members: uin }).toArray();
    for (const chat of chats) {
      await messagesCol.deleteMany({ chatId: chat._id });
      await chatsCol.deleteOne({ _id: chat._id });
    }
    await usersCol.deleteOne({ _id: uin });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- ПОИСК ПОЛЬЗОВАТЕЛЕЙ ---
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const rows = await usersCol.find({
      _id: { $ne: req.userUin },
      $or: [{ _id: regex }, { username: regex }]
    }).limit(20).project({ username: 1 }).toArray();
    res.json(rows.map(r => ({ uin: r._id, username: r.username })));
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- СПИСОК ЧАТОВ ---
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = await usersCol.findOne({ _id: req.userUin });
    if (!me) return res.status(404).json({ error: 'Не найден' });

    const myChats = await chatsCol.find({ members: req.userUin }).toArray();

    const result = [];
    for (const chat of myChats) {
      const otherUin = chat.members.find(u => u !== req.userUin);
      let other = null;
      if (otherUin) {
        other = await usersCol.findOne({ _id: otherUin }, { projection: { username: 1 } });
      }

      // Последнее сообщение
      const lastMsg = await messagesCol
        .find({ chatId: chat._id, deleted: { $ne: true } })
        .sort({ timestamp: -1 })
        .limit(1)
        .next();

      // Непрочитанные
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
        otherUin: otherUin || null,
        otherUsername: other?.username || '???',
        lastMessage: lastMsg ? publicMessage(lastMsg) : null,
        unreadCount: unread,
        updatedAt: chat.updatedAt,
        online: otherUin ? clients.has(otherUin) : false
      });
    }

    // Сортировка: новые вверх
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

// --- СОЗДАТЬ ЧАТ ---
app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { uin } = req.body || {};
    if (!uin || !/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'Неверный UIN' });
    if (uin === req.userUin) return res.status(400).json({ error: 'Нельзя добавить себя' });

    const other = await usersCol.findOne({ _id: uin }, { projection: { username: 1 } });
    if (!other) return res.status(404).json({ error: 'Пользователь не найден' });

    // Проверяем, есть ли уже чат между ними
    const existing = await chatsCol.findOne({
      members: { $all: [req.userUin, uin] }
    });
    if (existing) {
      return res.json({ success: true, chatId: existing._id, existing: true });
    }

    const chatId = uuidv4();
    const now = new Date().toISOString();

    await chatsCol.insertOne({
      _id: chatId,
      members: [req.userUin, uin],
      updatedAt: now
    });

    // Уведомляем второго
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

// --- УДАЛИТЬ ЧАТ ---
app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });

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
    console.error('Delete chat error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- СООБЩЕНИЯ ---
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });

    const msgs = await messagesCol
      .find({ chatId: chat._id, deleted: { $ne: true } })
      .sort({ timestamp: 1 })
      .limit(500)
      .toArray();

    // Обновляем lastSeen
    await usersCol.updateOne(
      { _id: req.userUin },
      { $set: { lastSeen: new Date().toISOString() } }
    );

    res.json(msgs.map(publicMessage));
  } catch (err) {
    console.error('Messages error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==== SPA FALLBACK ====
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
  const window = 3000;
  const limit = 8;
  const cur = wsRate.get(uin);
  if (!cur || now - cur.first > window) {
    wsRate.set(uin, { count: 1, first: now });
    return true;
  }
  if (cur.count >= limit) return false;
  cur.count++;
  return true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.uin = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch { return ws.send(JSON.stringify({ type: 'error', payload: 'Неверный формат' })); }

    const { type, payload } = data;

    // ==== AUTH ====
    if (type === 'auth') {
      const decoded = verifyToken(payload?.token);
      if (!decoded) {
        ws.send(JSON.stringify({ type: 'error', payload: 'Неверный токен' }));
        return ws.close();
      }
      // Проверяем, что пользователь существует
      const user = await usersCol.findOne({ _id: decoded.uin });
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', payload: 'Пользователь не найден' }));
        return ws.close();
      }
      ws.uin = decoded.uin;
      clients.set(ws.uin, ws);
      broadcast({ type: 'status', payload: { uin: ws.uin, status: 'online' } });
      return;
    }

    if (!ws.uin) {
      return ws.send(JSON.stringify({ type: 'error', payload: 'Не авторизован' }));
    }

    if (!checkRate(ws.uin)) {
      return ws.send(JSON.stringify({ type: 'error', payload: 'Слишком быстро' }));
    }

    // ==== НОВОЕ СООБЩЕНИЕ ====
    if (type === 'newMessage') {
      try {
        const { chatId, text, replyTo } = payload || {};
        if (!chatId || typeof text !== 'string') return;
        const trimmed = text.trim();
        if (!trimmed) return;
        if (trimmed.length > 200) {
          return ws.send(JSON.stringify({ type: 'error', payload: 'Максимум 200 символов' }));
        }

        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.uin)) return;

        const user = await usersCol.findOne({ _id: ws.uin }, { projection: { username: 1 } });
        if (!user) return;

        // Проверка replyTo
        let validReply = null;
        if (replyTo) {
          const parent = await messagesCol.findOne({
            _id: replyTo,
            chatId,
            deleted: { $ne: true }
          });
          if (parent) validReply = parent._id;
        }

        const msgId = uuidv4();
        const timestamp = new Date().toISOString();

        const msgDoc = {
          _id: msgId,
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
      } catch (err) {
        console.error('newMessage error:', err);
      }
      return;
    }

    // ==== УДАЛИТЬ СООБЩЕНИЕ ====
    if (type === 'deleteMessage') {
      try {
        const { messageId } = payload || {};
        if (!messageId) return;
        const msg = await messagesCol.findOne({ _id: messageId });
        if (!msg || msg.deleted) return;
        if (msg.sender !== ws.uin) {
          return ws.send(JSON.stringify({ type: 'error', payload: 'Можно удалять только свои' }));
        }
        const chat = await chatsCol.findOne({ _id: msg.chatId });
        if (!chat) return;

        await messagesCol.updateOne({ _id: messageId }, { $set: { deleted: true } });

        const out = JSON.stringify({
          type: 'deleteMessage',
          payload: { messageId, chatId: msg.chatId }
        });
        chat.members.forEach(uin => {
          const c = clients.get(uin);
          if (c && c.readyState === WebSocket.OPEN) c.send(out);
        });
      } catch (err) {
        console.error('deleteMessage error:', err);
      }
      return;
    }

    // ==== УДАЛИТЬ ЧАТ ====
    if (type === 'deleteChat') {
      try {
        const { chatId } = payload || {};
        if (!chatId) return;
        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.uin)) return;

        await messagesCol.deleteMany({ chatId });
        await chatsCol.deleteOne({ _id: chatId });

        const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
        chat.members.forEach(uin => {
          const c = clients.get(uin);
          if (c && c.readyState === WebSocket.OPEN) c.send(out);
        });
      } catch (err) {
        console.error('deleteChat error:', err);
      }
      return;
    }
  });

  ws.on('close', () => {
    if (ws.uin) {
      clients.delete(ws.uin);
      broadcast({ type: 'status', payload: { uin: ws.uin, status: 'offline' } });
    }
  });

  ws.on('error', (err) => console.error('WS error:', err));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, c] of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

// Heartbeat
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
//  СТАРТ
// ============================================================
(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🚀 Криста.Мессенджер v0.4 запущен на порту ${PORT}`);
    console.log(`📦 База данных: MongoDB Atlas / ${DB_NAME}`);
  });
})();
