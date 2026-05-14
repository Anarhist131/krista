// server.js — Krista v0.16 Backend
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const Grid = require('gridfs-stream');
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

// MongoDB connection
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin@cluster0.sotwveu.mongodb.net/krista?appName=Cluster0';
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

let gfs;
const conn = mongoose.connection;
conn.once('open', () => {
  gfs = Grid(conn.db, mongoose.mongo);
  gfs.collection('uploads');
  console.log('GridFS ready');
});

// ===================== МОДЕЛИ =====================
const userSchema = new mongoose.Schema({
  name: String,
  nickname: { type: String, unique: true, required: true },
  password: String,
  bio: { type: String, default: '' },
  showChannel: { type: Boolean, default: true },
  online: { type: Boolean, default: false },
  lastSeen: Date,
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const chatSchema = new mongoose.Schema({
  name: String,
  nick: String,
  description: String,
  public: { type: Boolean, default: false },
  isChannel: { type: Boolean, default: false },
  pagerEnabled: { type: Boolean, default: false },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', chatSchema);

const messageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: String,
  type: { type: String, enum: ['chat', 'pager'], default: 'chat' },
  timestamp: { type: Date, default: Date.now },
  system: { type: Boolean, default: false }
});
const Message = mongoose.model('Message', messageSchema);

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
  subscribed: { type: Boolean, default: true }
});
subscriptionSchema.index({ userId: 1, chatId: 1 }, { unique: true });
const Subscription = mongoose.model('Subscription', subscriptionSchema);

const adminSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isAdmin: { type: Boolean, default: true }
});
adminSchema.index({ chatId: 1, userId: 1 }, { unique: true });
const Admin = mongoose.model('Admin', adminSchema);

// ===================== MULTER + GRIDFS =====================
const storage = new GridFsStorage({
  url: MONGO_URI,
  file: (req, file) => {
    return {
      filename: Date.now() + '-' + file.originalname,
      bucketName: 'uploads'
    };
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ===================== WEBSOCKET =====================
wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        userId = data.userId;
        ws.userId = userId;
        // Помечаем пользователя онлайн
        await User.findByIdAndUpdate(userId, { online: true, lastSeen: new Date() });
        broadcastUserStatus(userId, true);
      } else if (data.type === 'message') {
        // Сохраняем и рассылаем
        const message = await new Message({
          chatId: data.chatId,
          sender: userId,
          text: data.text,
          type: data.messageType || 'chat'
        }).save();
        const sender = await User.findById(userId);
        const payload = {
          type: 'newMessage',
          message: {
            id: message._id,
            chatId: message.chatId,
            sender: { id: userId, nickname: sender.nickname },
            text: message.text,
            type: message.type,
            timestamp: message.timestamp
          }
        };
        // Отправляем всем подписчикам чата (или участникам)
        const subs = await Subscription.find({ chatId: data.chatId });
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.userId) {
            const isSub = subs.some(s => s.userId.toString() === client.userId.toString());
            if (isSub || client.userId.toString() === userId.toString()) {
              client.send(JSON.stringify(payload));
            }
          }
        });
      }
    } catch (e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', async () => {
    if (userId) {
      await User.findByIdAndUpdate(userId, { online: false, lastSeen: new Date() });
      broadcastUserStatus(userId, false);
    }
  });
});

function broadcastUserStatus(userId, online) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'userStatus',
        userId,
        online
      }));
    }
  });
}

// ===================== API =====================
// Регистрация
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, nickname, password } = req.body;
    if (!name || !nickname || !password) return res.status(400).json({ error: 'Все поля обязательны' });
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) return res.status(400).json({ error: 'Никнейм только из английских букв, цифр и подчёркивания' });
    const existing = await User.findOne({ nickname });
    if (existing) return res.status(400).json({ error: 'Никнейм занят' });
    const user = await new User({ name, nickname, password, bio: '' }).save();
    // Автоподписка на общий и каталог
    const general = await Chat.findOne({ name: 'Общий', isChannel: false });
    const catalog = await Chat.findOne({ name: 'Каталог', isChannel: true });
    if (general) await new Subscription({ userId: user._id, chatId: general._id }).save();
    if (catalog) await new Subscription({ userId: user._id, chatId: catalog._id }).save();
    // Персональное избранное
    await new Chat({
      name: 'Избранное',
      nick: '',
      description: '',
      public: false,
      isChannel: false,
      pagerEnabled: false,
      creator: user._id
    }).save();
    res.json({ success: true, userId: user._id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Вход
app.post('/api/auth/login', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    const user = await User.findOne({ nickname, password });
    if (!user) return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    res.json({ userId: user._id, name: user.name, nickname: user.nickname });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить данные пользователя
app.get('/api/user/:id', async (req, res) => {
  const user = await User.findById(req.params.id).select('-password');
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(user);
});

// Обновить профиль
app.put('/api/user/:id', async (req, res) => {
  try {
    const { name, nickname, bio, showChannel } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    if (name) user.name = name;
    if (nickname) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) return res.status(400).json({ error: 'Неверный формат никнейма' });
      const conflict = await User.findOne({ nickname, _id: { $ne: user._id } });
      if (conflict) return res.status(400).json({ error: 'Никнейм занят' });
      user.nickname = nickname;
    }
    if (bio !== undefined) user.bio = bio;
    if (showChannel !== undefined) user.showChannel = showChannel;
    await user.save();
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удаление аккаунта
app.delete('/api/user/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    // Удалить подписки, админства, чаты пользователя (каналы и личные), сообщения
    const chats = await Chat.find({ creator: user._id });
    for (let chat of chats) {
      await Message.deleteMany({ chatId: chat._id });
      await Subscription.deleteMany({ chatId: chat._id });
      await Admin.deleteMany({ chatId: chat._id });
      await Chat.findByIdAndDelete(chat._id);
    }
    await Subscription.deleteMany({ userId: user._id });
    await Admin.deleteMany({ userId: user._id });
    await User.findByIdAndDelete(user._id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Поиск
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  const users = await User.find({ nickname: { $regex: q, $options: 'i' } }).select('name nickname');
  const chats = await Chat.find({ nick: { $regex: q, $options: 'i' }, name: { $ne: 'Избранное' } }).select('name nick isChannel');
  res.json({ users, chats });
});

// Создать чат/канал
app.post('/api/chat', async (req, res) => {
  try {
    const { name, nick, description, isPublic, isChannel, pagerEnabled, creatorId } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });
    const chat = await new Chat({
      name,
      nick: nick || '',
      description: description || '',
      public: isPublic,
      isChannel: isChannel || false,
      pagerEnabled: pagerEnabled || false,
      creator: creatorId
    }).save();
    // Создатель подписывается автоматически
    await new Subscription({ userId: creatorId, chatId: chat._id }).save();
    res.json(chat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Редактировать чат/канал (только создатель)
app.put('/api/chat/:id', async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (chat.creator.toString() !== req.body.userId) return res.status(403).json({ error: 'Только создатель может редактировать' });
    if (req.body.name) chat.name = req.body.name;
    if (req.body.nick !== undefined) chat.nick = req.body.nick;
    if (req.body.description !== undefined) chat.description = req.body.description;
    if (req.body.public !== undefined) chat.public = req.body.public;
    if (chat.isChannel && req.body.pagerEnabled !== undefined) chat.pagerEnabled = req.body.pagerEnabled;
    await chat.save();
    res.json(chat);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Удалить чат/канал (только создатель или чит-код)
app.delete('/api/chat/:id', async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (req.body.cheatCode === '52526767' || chat.creator.toString() === req.body.userId) {
      await Message.deleteMany({ chatId: chat._id });
      await Subscription.deleteMany({ chatId: chat._id });
      await Admin.deleteMany({ chatId: chat._id });
      await Chat.findByIdAndDelete(chat._id);
      res.json({ success: true });
    } else {
      res.status(403).json({ error: 'Нет прав' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Получить список чатов пользователя
app.get('/api/chats/:userId', async (req, res) => {
  const subs = await Subscription.find({ userId: req.params.userId });
  const chatIds = subs.map(s => s.chatId);
  const chats = await Chat.find({ _id: { $in: chatIds } }).populate('creator', 'nickname');
  res.json(chats);
});

// Подписаться/отписаться
app.post('/api/subscribe', async (req, res) => {
  const { userId, chatId } = req.body;
  const sub = await Subscription.findOne({ userId, chatId });
  if (sub) {
    await Subscription.deleteOne({ _id: sub._id });
    res.json({ subscribed: false });
  } else {
    await new Subscription({ userId, chatId }).save();
    res.json({ subscribed: true });
  }
});

// Проверить подписку
app.get('/api/subscription/:userId/:chatId', async (req, res) => {
  const sub = await Subscription.findOne({ userId: req.params.userId, chatId: req.params.chatId });
  res.json({ subscribed: !!sub });
});

// Админы
app.get('/api/admins/:chatId', async (req, res) => {
  const admins = await Admin.find({ chatId: req.params.chatId }).populate('userId', 'nickname name');
  res.json(admins);
});

app.post('/api/admin/toggle', async (req, res) => {
  const { chatId, userId, operatorId } = req.body;
  const chat = await Chat.findById(chatId);
  if (chat.creator.toString() !== operatorId) return res.status(403).json({ error: 'Только создатель' });
  const existing = await Admin.findOne({ chatId, userId });
  if (existing) {
    await Admin.deleteOne({ _id: existing._id });
    res.json({ admin: false });
  } else {
    await new Admin({ chatId, userId }).save();
    res.json({ admin: true });
  }
});

// Сообщения чата (без пейджера)
app.get('/api/messages/:chatId', async (req, res) => {
  const { type } = req.query;
  const filter = { chatId: req.params.chatId };
  if (type) filter.type = type;
  const msgs = await Message.find(filter).sort({ timestamp: 1 }).populate('sender', 'nickname');
  res.json(msgs);
});

// Экспорт истории в TXT
app.get('/api/export/:chatId', async (req, res) => {
  const chat = await Chat.findById(req.params.chatId);
  if (!chat) return res.status(404).send('Чат не найден');
  const msgs = await Message.find({ chatId: req.params.chatId, type: 'chat' }).sort({ timestamp: 1 }).populate('sender', 'nickname');
  let result = '';
  let currentDate = '';
  msgs.forEach(m => {
    const d = new Date(m.timestamp);
    const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    if (dateStr !== currentDate) {
      result += `=== ${dateStr} ===\n`;
      currentDate = dateStr;
    }
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const nick = m.sender ? m.sender.nickname : 'Система';
    result += `[${time}] ${nick}: ${m.text}\n`;
  });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${chat.name}_${new Date().toISOString().slice(0,10)}.txt"`);
  res.send(result);
});

// Загрузка файла
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  const msg = await new Message({
    chatId: req.body.chatId,
    sender: req.body.userId,
    text: `📎 Файл: ${req.file.originalname} (${(req.file.size/1024).toFixed(1)} КБ)`,
    type: 'chat'
  }).save();
  res.json({ fileId: req.file.id, message: msg });
});

// Получить файл
app.get('/api/file/:id', async (req, res) => {
  try {
    const file = await gfs.files.findOne({ _id: new mongoose.Types.ObjectId(req.params.id) });
    if (!file) return res.status(404).send('Файл не найден');
    const readStream = gfs.createReadStream({ _id: file._id });
    res.set('Content-Type', file.contentType);
    readStream.pipe(res);
  } catch (e) {
    res.status(500).send('Ошибка получения файла');
  }
});

// Системные чаты (создаются один раз при старте)
(async () => {
  const general = await Chat.findOne({ name: 'Общий' });
  if (!general) await new Chat({ name: 'Общий', nick: 'general', public: true, isChannel: false, pagerEnabled: false, creator: null }).save();
  const catalog = await Chat.findOne({ name: 'Каталог' });
  if (!catalog) await new Chat({ name: 'Каталог', nick: 'catalog', public: true, isChannel: true, pagerEnabled: false, creator: null }).save();
})();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Krista server running on port ${PORT}`));
