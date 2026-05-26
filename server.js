// server.js – Krista v0.20
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
const multer = require('multer');
const { GridFsStorage } = require('multer-gridfs-storage');
const Grid = require('gridfs-stream');
const { getAudioDurationInSeconds } = require('get-audio-duration');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'krista-secret-2024';
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
      connectSrc: ["'self'", "wss:", "ws:"],
      mediaSrc: ["'self'"]
    }
  }
}));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 200 }));

// --- MongoDB connection ---
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(console.error);

// --- GridFS ---
let gfs;
mongoose.connection.once('open', () => {
  gfs = Grid(mongoose.connection.db, mongoose.mongo);
  gfs.collection('uploads');
  console.log('GridFS ready');
});

// --- Models ---
const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true },
  nickname: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  color: { type: String, default: '#007aff' },
  showOnline: { type: Boolean, default: true },
  showTyping: { type: Boolean, default: true },
  notifications: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
}).pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  next();
}));

const Chat = mongoose.model('Chat', new mongoose.Schema({
  name: String,
  nick: String,
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  isChannel: { type: Boolean, default: false },
  subscribers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
}));

const Message = mongoose.model('Message', new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: String,
  edited: Boolean,
  timestamp: { type: Date, default: Date.now, index: true }
}));

const Song = mongoose.model('Song', new mongoose.Schema({
  title: String,
  artist: { type: String, default: '' },
  album: { type: String, default: '' },
  fileId: mongoose.Schema.Types.ObjectId,
  duration: Number,
  createdAt: { type: Date, default: Date.now }
}));

// --- Multer storage ---
const storage = new GridFsStorage({
  url: MONGO_URI,
  file: (req, file) => ({
    filename: Date.now() + '-' + file.originalname,
    bucketName: 'uploads'
  })
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// --- Auth middleware ---
function softAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
      req.userId = decoded.userId;
    } catch { req.userId = null; }
  } else {
    req.userId = null;
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
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        try {
          userId = jwt.verify(data.token, JWT_SECRET).userId;
          ws.userId = userId;
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } catch { ws.close(); }
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
            text: message.text
          }
        };
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN && c.userId && chat.subscribers.includes(c.userId))
            c.send(JSON.stringify(payload));
        });
      }
    } catch (e) { console.error('WS error:', e); }
  });
  ws.on('close', () => {});
});
setInterval(() => wss.clients.forEach(ws => {
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false;
  ws.ping();
}), 30000);

// --- API routes ---
app.use('/api/*', softAuth);

// Auth
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, nickname, password } = req.body;
    if (!name || !nickname || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) return res.status(400).json({ error: 'Никнейм: латиница, цифры, подчёркивание' });
    if (await User.findOne({ nickname })) return res.status(400).json({ error: 'Никнейм занят' });
    const user = await new User({ name, nickname, password }).save();
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    // auto-subscribe to system chats
    const catalog = await Chat.findOne({ name: 'Каталог' });
    const general = await Chat.findOne({ name: 'Общий' });
    if (catalog) { catalog.subscribers.push(user._id); await catalog.save(); }
    if (general) { general.subscribers.push(user._id); await general.save(); }
    res.json({ token, user: { id: user._id, name, nickname, color: user.color, notifications: true, showOnline: true, showTyping: true } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    const user = await User.findOne({ nickname });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверные данные' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, nickname: user.nickname, color: user.color, notifications: user.notifications, showOnline: user.showOnline, showTyping: user.showTyping } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/user/me', (req, res) => {
  if (!req.userId) return res.json(null);
  User.findById(req.userId).select('-password').then(user => res.json(user));
});

app.put('/api/user/me', requireAuth, async (req, res) => {
  const { name, nickname, color, notifications, showOnline, showTyping } = req.body;
  const user = await User.findById(req.userId);
  if (name) user.name = name;
  if (nickname) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) return res.status(400).json({ error: 'Формат ника' });
    if (await User.findOne({ nickname, _id: { $ne: user._id } })) return res.status(400).json({ error: 'Никнейм занят' });
    user.nickname = nickname;
  }
  if (color) user.color = color;
  if (notifications !== undefined) user.notifications = notifications;
  if (showOnline !== undefined) user.showOnline = showOnline;
  if (showTyping !== undefined) user.showTyping = showTyping;
  await user.save();
  res.json(user);
});

app.delete('/api/user/me', requireAuth, async (req, res) => {
  await Promise.all([
    Message.deleteMany({ sender: req.userId }),
    Chat.deleteMany({ creator: req.userId }),
  ]);
  await User.findByIdAndDelete(req.userId);
  res.json({ success: true });
});

// Chats
app.post('/api/chat', requireAuth, async (req, res) => {
  const { name, nick, isChannel } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  const chat = await new Chat({
    name,
    nick: nick || '',
    creator: req.userId,
    isChannel: isChannel || false,
    subscribers: [req.userId]
  }).save();
  updateCatalog();
  res.json(chat);
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
  updateCatalog();
  res.json(chat);
});

app.delete('/api/chat/:id', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Не найден' });
  if (chat.creator.toString() === req.userId) {
    await Message.deleteMany({ chatId: chat._id });
    await Chat.findByIdAndDelete(chat._id);
    updateCatalog();
    return res.json({ success: true });
  }
  res.status(403).json({ error: 'Нет прав' });
});

app.post('/api/subscribe', requireAuth, async (req, res) => {
  const chat = await Chat.findById(req.body.chatId);
  if (!chat) return res.status(404).json({ error: 'Не найден' });
  const idx = chat.subscribers.indexOf(req.userId);
  if (idx > -1) chat.subscribers.splice(idx, 1); else chat.subscribers.push(req.userId);
  await chat.save();
  res.json({ subscribed: idx === -1 });
});

// Messages
app.get('/api/messages/:chatId', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before ? new Date(req.query.before) : new Date();
  const msgs = await Message.find({ chatId: req.params.chatId, timestamp: { $lt: before } })
    .sort({ timestamp: -1 }).limit(limit).populate('sender', 'nickname color');
  res.json({ messages: msgs.reverse(), hasMore: msgs.length === limit });
});

app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  const msg = await Message.findById(req.params.id);
  if (!msg || msg.sender.toString() !== req.userId) return res.status(403).json({ error: 'Не автор' });
  await Message.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// Popular & new channels
app.get('/api/popular-channels', async (req, res) => {
  const channels = await Chat.find({ isChannel: true, name: { $ne: 'Каталог' } })
    .sort({ subscribers: -1 }).limit(5).select('name subscribers');
  res.json(channels);
});
app.get('/api/new-channels', async (req, res) => {
  const channels = await Chat.find({ isChannel: true, name: { $ne: 'Каталог' } })
    .sort({ createdAt: -1 }).limit(5).select('name subscribers');
  res.json(channels);
});

// Feed
app.get('/api/feed', async (req, res) => {
  if (!req.userId) return res.json([]);
  const since = new Date(Date.now() - 86400000);
  const chatIds = (await Chat.find({ subscribers: req.userId, isChannel: true })).map(c => c._id);
  const msgs = await Message.find({ chatId: { $in: chatIds }, timestamp: { $gte: since } })
    .sort({ timestamp: -1 }).limit(30).populate('chatId', 'name').populate('sender', 'nickname');
  res.json(msgs.reverse());
});

// Search
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  const users = await User.find({ nickname: { $regex: q, $options: 'i' } }).select('name nickname');
  const chats = await Chat.find({ nick: { $regex: q, $options: 'i' } }).select('name nick isChannel');
  res.json({ users, chats });
});

// Music
app.get('/api/songs', async (req, res) => {
  const songs = await Song.find().sort({ createdAt: -1 });
  res.json(songs);
});

app.get('/api/stream/:fileId', async (req, res) => {
  try {
    const file = await gfs.files.findOne({ _id: new mongoose.Types.ObjectId(req.params.fileId) });
    if (!file) return res.status(404).send('Файл не найден');
    res.set('Content-Type', file.contentType || 'audio/ogg');
    const readStream = gfs.createReadStream({ _id: file._id });
    readStream.pipe(res);
  } catch (e) { res.status(500).send('Ошибка стриминга'); }
});

// Admin music routes (protected by hardcoded code)
app.post('/api/admin/song', upload.single('file'), async (req, res) => {
  try {
    const { title, artist, album, code } = req.body;
    if (code !== '52526767') return res.status(403).json({ error: 'Недостаточно прав' });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    let duration = 0;
    try { duration = await getAudioDurationInSeconds(req.file.path); } catch {}
    const song = await new Song({
      title: title || 'Без названия',
      artist: artist || '',
      album: album || '',
      fileId: req.file.id,
      duration: Math.round(duration)
    }).save();
    res.json(song);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/admin/song', async (req, res) => {
  try {
    const { title, code } = req.body;
    if (code !== '52526767') return res.status(403).json({ error: 'Нет прав' });
    const song = await Song.findOne({ title });
    if (!song) return res.status(404).json({ error: 'Песня не найдена' });
    try { await gfs.files.deleteOne({ _id: song.fileId }); } catch {}
    await Song.findByIdAndDelete(song._id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.put('/api/admin/song', async (req, res) => {
  try {
    const { oldTitle, newTitle, code } = req.body;
    if (code !== '52526767') return res.status(403).json({ error: 'Нет прав' });
    const song = await Song.findOne({ title: oldTitle });
    if (!song) return res.status(404).json({ error: 'Песня не найдена' });
    song.title = newTitle;
    await song.save();
    res.json(song);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// --- System chats ---
async function ensureSystemChats() {
  let catalog = await Chat.findOne({ name: 'Каталог' });
  if (!catalog) {
    catalog = await new Chat({ name: 'Каталог', nick: 'catalog', creator: null, isChannel: true, subscribers: [] }).save();
    (await User.find()).forEach(u => catalog.subscribers.push(u._id));
    await catalog.save();
  }
  let general = await Chat.findOne({ name: 'Общий' });
  if (!general) {
    general = await new Chat({ name: 'Общий', nick: 'general', creator: null, isChannel: false, subscribers: [] }).save();
    (await User.find()).forEach(u => general.subscribers.push(u._id));
    await general.save();
  }
}

async function updateCatalog() {
  const catalog = await Chat.findOne({ name: 'Каталог' });
  if (!catalog) return;
  await Message.deleteMany({ chatId: catalog._id, sender: null });
  const chats = await Chat.find({ name: { $ne: 'Каталог' } });
  let text = '<b>Каталог чатов и каналов:</b><br>';
  if (!chats.length) text += 'Список пуст';
  else chats.forEach(c => text += `<span style="cursor:pointer;color:var(--accent);" onclick="openChatById('${c._id}')">${c.name} (${c.isChannel?'канал':'чат'})</span><br>`);
  await new Message({ chatId: catalog._id, sender: null, text }).save();
}

ensureSystemChats().then(updateCatalog);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Krista server on port ${PORT}`));
