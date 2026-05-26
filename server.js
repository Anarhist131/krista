// server.js – Krista v0.21 (исправлен)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // необходимо для express-rate-limit за прокси (Render)
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'krista-secret-2024';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin@cluster0.sotwveu.mongodb.net/krista?appName=Cluster0';
const SALT_ROUNDS = 12;

// --- Middleware ---
app.use(compression());
app.use(express.json());
app.use(express.static('public'));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"]
    }
  }
}));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 200 }));

// --- MongoDB ---
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(err => console.error('MongoDB error:', err));

// --- Models ---
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  nickname: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  color: { type: String, default: '#00cc66' },
  createdAt: { type: Date, default: Date.now }
});
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  next();
});
const User = mongoose.model('User', userSchema);

const chatSchema = new mongoose.Schema({
  name: String,
  nick: String,
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isChannel: { type: Boolean, default: false },
  subscribers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', chatSchema);

const messageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: String,
  timestamp: { type: Date, default: Date.now, index: true }
});
const Message = mongoose.model('Message', messageSchema);

// --- Auth middleware ---
function softAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
      req.userId = decoded.userId;
      req.isAdmin = decoded.isAdmin || false;
    } catch {
      req.userId = null;
      req.isAdmin = false;
    }
  } else {
    req.userId = null;
    req.isAdmin = false;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Требуется авторизация' });
  next();
}

// --- WebSocket ---
wss.on('connection', (ws) => {
  let userId = null;
  let isAdmin = false;
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          userId = decoded.userId;
          isAdmin = decoded.isAdmin || false;
          ws.userId = userId;
          ws.isAdmin = isAdmin;
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } catch (e) { ws.close(); }
      } else if (data.type === 'message' && userId) {
        const chat = await Chat.findById(data.chatId);
        if (!chat || !chat.subscribers.includes(userId)) return;
        const message = await new Message({
          chatId: data.chatId,
          sender: userId,
          text: data.text,
          timestamp: new Date()
        }).save();
        const sender = await User.findById(userId);
        const payload = {
          type: 'newMessage',
          message: {
            id: message._id,
            chatId: message.chatId,
            sender: { id: userId, nickname: sender.nickname, color: sender.color },
            text: message.text,
            timestamp: message.timestamp
          }
        };
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN && c.userId && chat.subscribers.includes(c.userId))
            c.send(JSON.stringify(payload));
        });
      } else if (data.type === 'deleteMessage' && userId && isAdmin) {
        const message = await Message.findById(data.messageId);
        if (message) {
          await Message.findByIdAndDelete(message._id);
          wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'messageDeleted', messageId: data.messageId }));
          });
        }
      } else if (data.type === 'deleteChat' && userId && isAdmin) {
        const chat = await Chat.findById(data.chatId);
        if (chat) {
          await Message.deleteMany({ chatId: chat._id });
          await Chat.findByIdAndDelete(chat._id);
          wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'chatDeleted', chatId: data.chatId }));
          });
        }
      }
    } catch (e) { console.error('WS error:', e); }
  });

  ws.on('close', () => {});
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); } }), 30000);

// --- API routes ---
app.use('/api/*', softAuth);

// Вспомогательная функция для получения или создания общего чата
async function getOrCreateGeneralChat() {
  let general = await Chat.findOne({ name: 'Общий' });
  if (!general) {
    general = new Chat({ name: 'Общий', nick: 'general', creator: null, isChannel: false, subscribers: [] });
    await general.save();
  }
  return general;
}

// Регистрация
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, nickname, password } = req.body;
    if (!name || !nickname || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) return res.status(400).json({ error: 'Никнейм: латиница, цифры, подчёркивание' });
    if (await User.findOne({ nickname })) return res.status(400).json({ error: 'Никнейм занят' });
    const user = await new User({ name, nickname, password }).save();
    const token = jwt.sign({ userId: user._id, isAdmin: false }, JWT_SECRET, { expiresIn: '7d' });
    // Подписываем на общий чат
    const general = await getOrCreateGeneralChat();
    if (!general.subscribers.includes(user._id)) {
      general.subscribers.push(user._id);
      await general.save();
    }
    res.json({ token, user: { id: user._id, name, nickname, color: user.color } });
  } catch (e) { console.error('Register error:', e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Вход
app.post('/api/auth/login', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    const user = await User.findOne({ nickname });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверные данные' });
    const token = jwt.sign({ userId: user._id, isAdmin: false }, JWT_SECRET, { expiresIn: '7d' });
    // Авто-подписка на общий чат
    const general = await getOrCreateGeneralChat();
    if (!general.subscribers.includes(user._id)) {
      general.subscribers.push(user._id);
      await general.save();
    }
    res.json({ token, user: { id: user._id, name: user.name, nickname: user.nickname, color: user.color } });
  } catch (e) { console.error('Login error:', e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Мастер-доступ
app.post('/api/admin/activate', requireAuth, async (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Неверный пароль администратора' });
  const token = jwt.sign({ userId: req.userId, isAdmin: true }, JWT_SECRET, { expiresIn: '30m' });
  res.json({ token });
});

// Профиль
app.get('/api/user/me', (req, res) => {
  if (!req.userId) return res.json(null);
  User.findById(req.userId).select('-password').then(user => res.json(user)).catch(() => res.json(null));
});
app.put('/api/user/me', requireAuth, async (req, res) => {
  try {
    const { name, nickname, color } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (name) user.name = name;
    if (nickname) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) return res.status(400).json({ error: 'Формат ника' });
      const conflict = await User.findOne({ nickname, _id: { $ne: user._id } });
      if (conflict) return res.status(400).json({ error: 'Никнейм занят' });
      user.nickname = nickname;
    }
    if (color) user.color = color;
    await user.save();
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});
app.delete('/api/user/me', requireAuth, async (req, res) => {
  try {
    await Message.deleteMany({ sender: req.userId });
    await Chat.deleteMany({ creator: req.userId });
    await User.findByIdAndDelete(req.userId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Чаты
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { name, nick, isChannel } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });
    const chat = await new Chat({
      name, nick: nick || '', creator: req.userId,
      isChannel: isChannel || false, subscribers: [req.userId]
    }).save();
    res.json(chat);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});
app.get('/api/chats', async (req, res) => {
  const filter = req.userId ? { subscribers: req.userId } : {};
  const chats = await Chat.find(filter).populate('creator', 'nickname');
  res.json(chats);
});
app.put('/api/chat/:id', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.id);
  if (!chat || chat.creator.toString() !== req.userId) return res.status(403).json({ error: 'Нет прав' });
  if (req.body.name) chat.name = req.body.name;
  if (req.body.nick !== undefined) chat.nick = req.body.nick;
  await chat.save();
  res.json(chat);
});
app.delete('/api/chat/:id', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Не найден' });
  if (chat.creator.toString() !== req.userId && !req.isAdmin) return res.status(403).json({ error: 'Нет прав' });
  await Message.deleteMany({ chatId: chat._id });
  await Chat.findByIdAndDelete(chat._id);
  res.json({ success: true });
});

// Подписки
app.post('/api/subscribe', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.body.chatId);
  if (!chat) return res.status(404).json({ error: 'Не найден' });
  const idx = chat.subscribers.indexOf(req.userId);
  if (idx > -1) chat.subscribers.splice(idx, 1); else chat.subscribers.push(req.userId);
  await chat.save();
  res.json({ subscribed: idx === -1 });
});

// Сообщения
app.get('/api/messages/:chatId', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before ? new Date(req.query.before) : new Date();
  const msgs = await Message.find({ chatId: req.params.chatId, timestamp: { $lt: before } })
    .sort({ timestamp: -1 }).limit(limit).populate('sender', 'nickname color');
  res.json({ messages: msgs.reverse(), hasMore: msgs.length === limit });
});

// Популярные каналы (исключаем системные)
app.get('/api/popular-channels', async (req, res) => {
  const channels = await Chat.find({ isChannel: true, name: { $nin: ['Каталог', 'Общий'] } })
    .sort({ subscribers: -1 }).limit(5).select('name nick subscribers');
  res.json(channels);
});

// Поиск
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  const users = await User.find({ nickname: { $regex: q, $options: 'i' } }).select('name nickname');
  const chats = await Chat.find({ nick: { $regex: q, $options: 'i' } }).select('name nick isChannel');
  res.json({ users, chats });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Krista server on port ${PORT}`));
