const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const Grid = require('gridfs-stream');
const path = require('path');

// ---------- Конфигурация ----------
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/krista';
const JWT_SECRET = process.env.JWT_SECRET || 'krista-secret-key';
const PORT = process.env.PORT || 3000;

// ---------- Подключение MongoDB ----------
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected'));
const conn = mongoose.connection;
let gfs;
conn.once('open', () => {
  gfs = Grid(conn.db, mongoose.mongo);
  gfs.collection('uploads');
});

// ---------- Модели ----------
const userSchema = new mongoose.Schema({
  name: String,
  nickname: { type: String, unique: true, required: true },
  password: String,
  bio: { type: String, default: '' },
  showChannel: { type: Boolean, default: true }
});
const User = mongoose.model('User', userSchema);

const chatSchema = new mongoose.Schema({
  chatId: { type: String, unique: true, required: true },
  name: String,
  nick: String,
  description: { type: String, default: '' },
  public: { type: Boolean, default: false },
  isChannel: { type: Boolean, default: false },
  pagerEnabled: { type: Boolean, default: false },
  creator: String // userId
});
const Chat = mongoose.model('Chat', chatSchema);

const messageSchema = new mongoose.Schema({
  chatId: String,
  sender: String,
  text: String,
  timestamp: { type: Date, default: Date.now },
  type: { type: String, enum: ['chat', 'pager'], default: 'chat' },
  system: { type: Boolean, default: false }
});
const Message = mongoose.model('Message', messageSchema);

const subscriptionSchema = new mongoose.Schema({
  userId: String,
  chatId: String
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

const adminSchema = new mongoose.Schema({
  chatId: String,
  userId: String
});
const Admin = mongoose.model('Admin', adminSchema);

// ---------- Express ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- WebSocket сервер ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map(); // userId -> ws

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        const token = data.token;
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          clients.set(decoded.userId, ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
        }
      }
    } catch (e) {}
  });
  ws.on('close', () => {
    for (let [userId, client] of clients) {
      if (client === ws) {
        clients.delete(userId);
        break;
      }
    }
  });
});

function broadcast(chatId, message) {
  // Рассылаем всем подписчикам чата (в реальности надо найти их userId и отправить через ws)
  Subscription.find({ chatId }).then(subs => {
    subs.forEach(sub => {
      const ws = clients.get(sub.userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
  });
}

// ---------- Middleware аутентификации ----------
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- Системные чаты ----------
async function ensureSystemChats() {
  const general = await Chat.findOne({ chatId: 'general' });
  if (!general) {
    await Chat.create({ chatId: 'general', name: 'Общий', nick: 'general', public: true, isChannel: false, creator: 'system' });
  }
  const catalog = await Chat.findOne({ chatId: 'catalog' });
  if (!catalog) {
    await Chat.create({ chatId: 'catalog', name: 'Каталог', nick: 'catalog', public: true, isChannel: true, creator: 'system' });
  }
  // Избранное создается при регистрации пользователя
}
ensureSystemChats();

// ---------- Роуты ----------

// Регистрация
app.post('/api/register', async (req, res) => {
  const { name, nickname, password } = req.body;
  if (!name || !nickname || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) return res.status(400).json({ error: 'Никнейм только из латинских букв, цифр и подчеркивания' });
  const exists = await User.findOne({ nickname });
  if (exists) return res.status(400).json({ error: 'Никнейм занят' });
  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, nickname, password: hash });
  // Создаем избранное для пользователя
  const favId = `fav_${user._id}`;
  await Chat.create({ chatId: favId, name: 'Избранное', nick: '', public: false, isChannel: false, creator: user._id.toString() });
  // Подписываем на общий и каталог
  await Subscription.insertMany([
    { userId: user._id.toString(), chatId: 'general' },
    { userId: user._id.toString(), chatId: 'catalog' },
    { userId: user._id.toString(), chatId: favId }
  ]);
  res.json({ success: true });
});

// Вход
app.post('/api/login', async (req, res) => {
  const { nickname, password } = req.body;
  const user = await User.findOne({ nickname });
  if (!user) return res.status(401).json({ error: 'Неверный никнейм или пароль' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Неверный никнейм или пароль' });
  const token = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user._id, name: user.name, nickname: user.nickname, bio: user.bio } });
});

// Профиль
app.get('/api/profile', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ name: user.name, nickname: user.nickname, bio: user.bio });
});

// Обновление профиля
app.put('/api/profile', authMiddleware, async (req, res) => {
  const { name, nickname, bio } = req.body;
  const user = await User.findById(req.userId);
  if (nickname && nickname !== user.nickname) {
    const exists = await User.findOne({ nickname });
    if (exists) return res.status(400).json({ error: 'Никнейм занят' });
    user.nickname = nickname;
  }
  if (name) user.name = name;
  if (bio !== undefined) user.bio = bio;
  await user.save();
  res.json({ success: true });
});

// Удаление аккаунта
app.delete('/api/account', authMiddleware, async (req, res) => {
  const { password } = req.body;
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
  // Удаляем подписки, админов, чаты, созданные пользователем
  const userId = req.userId;
  const chats = await Chat.find({ creator: userId });
  const chatIds = chats.map(c => c.chatId);
  await Chat.deleteMany({ creator: userId });
  await Message.deleteMany({ chatId: { $in: chatIds } });
  await Subscription.deleteMany({ userId });
  await Admin.deleteMany({ $or: [{ userId }, { chatId: { $in: chatIds } }] });
  await User.deleteOne({ _id: userId });
  // Обновить каталог (пересоздадим системное сообщение)
  updateCatalog();
  res.json({ success: true });
});

// Получить список чатов пользователя
app.get('/api/chats', authMiddleware, async (req, res) => {
  const subs = await Subscription.find({ userId: req.userId });
  const chatIds = subs.map(s => s.chatId);
  const chats = await Chat.find({ chatId: { $in: chatIds } });
  res.json(chats);
});

// Создать чат/канал
app.post('/api/chats', authMiddleware, async (req, res) => {
  const { name, nick, description, public: isPublic, isChannel, pagerEnabled } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  const chatId = Date.now().toString();
  const chat = await Chat.create({
    chatId, name, nick, description, public: isPublic, isChannel, pagerEnabled, creator: req.userId
  });
  await Subscription.create({ userId: req.userId, chatId });
  if (isPublic) updateCatalog();
  res.json(chat);
});

// Редактировать чат/канал
app.put('/api/chats/:chatId', authMiddleware, async (req, res) => {
  const chat = await Chat.findOne({ chatId: req.params.chatId });
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  if (chat.creator !== req.userId) return res.status(403).json({ error: 'Только создатель может редактировать' });
  const { name, nick, description, public: isPublic, pagerEnabled } = req.body;
  if (name) chat.name = name;
  if (nick !== undefined) chat.nick = nick;
  if (description !== undefined) chat.description = description;
  if (isPublic !== undefined) chat.public = isPublic;
  if (pagerEnabled !== undefined) chat.pagerEnabled = pagerEnabled;
  await chat.save();
  if (chat.public || isPublic) updateCatalog();
  res.json(chat);
});

// Удалить чат/канал (владелец или чит-код)
app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  const chat = await Chat.findOne({ chatId: req.params.chatId });
  if (!chat) return res.status(404).json({ error: 'Не найден' });
  if (chat.creator !== req.userId && req.query.cheat !== '52526767') {
    return res.status(403).json({ error: 'Недостаточно прав' });
  }
  await Message.deleteMany({ chatId: chat.chatId });
  await Subscription.deleteMany({ chatId: chat.chatId });
  await Admin.deleteMany({ chatId: chat.chatId });
  await Chat.deleteOne({ chatId: chat.chatId });
  updateCatalog();
  res.json({ success: true });
});

// Подписка/отписка
app.post('/api/subscribe/:chatId', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  const chat = await Chat.findOne({ chatId });
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const sub = await Subscription.findOne({ userId: req.userId, chatId });
  if (sub) {
    await Subscription.deleteOne({ _id: sub._id });
    res.json({ subscribed: false });
  } else {
    await Subscription.create({ userId: req.userId, chatId });
    res.json({ subscribed: true });
  }
});

// Сообщения чата (пагинация пока без)
app.get('/api/messages/:chatId', authMiddleware, async (req, res) => {
  const msgs = await Message.find({ chatId: req.params.chatId, type: 'chat' }).sort('timestamp');
  res.json(msgs);
});

// Отправить сообщение
app.post('/api/messages', authMiddleware, async (req, res) => {
  const { chatId, text, type = 'chat' } = req.body;
  const chat = await Chat.findOne({ chatId });
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  // Проверка прав: для канала только админы/создатель
  if (chat.isChannel) {
    const isAdmin = (chat.creator === req.userId) || (await Admin.exists({ chatId, userId: req.userId }));
    if (!isAdmin) return res.status(403).json({ error: 'Только админы могут писать в канал' });
  }
  const msg = await Message.create({ chatId, sender: req.userId, text, type });
  // Обновляем каталог, если сообщение в каталог (системное)
  if (chatId === 'catalog') updateCatalog();
  broadcast(chatId, { type: 'new_message', message: msg });
  res.json(msg);
});

// Пейджер-сообщения
app.get('/api/pager/:chatId', authMiddleware, async (req, res) => {
  const msgs = await Message.find({ chatId: req.params.chatId, type: 'pager' }).sort('-timestamp').limit(5);
  res.json(msgs);
});

// Скачать историю в txt
app.get('/api/history/:chatId', authMiddleware, async (req, res) => {
  const chat = await Chat.findOne({ chatId: req.params.chatId });
  if (!chat) return res.status(404).send('Чат не найден');
  const msgs = await Message.find({ chatId: req.params.chatId }).sort('timestamp');
  let txt = '';
  let currentDate = '';
  msgs.forEach(m => {
    const date = new Date(m.timestamp).toLocaleDateString('ru-RU');
    if (date !== currentDate) {
      txt += `=== ${date} ===\n`;
      currentDate = date;
    }
    const time = new Date(m.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const sender = m.sender === 'system' ? 'Система' : (m.senderName || 'Участник');
    txt += `[${time}] ${sender}: ${m.text}\n`;
  });
  res.attachment(`${chat.name}_история.txt`).type('text/plain; charset=utf-8').send(txt);
});

// Чит-удаление (специальный POST с кодом)
app.post('/api/cheat-delete', authMiddleware, async (req, res) => {
  const { code, name } = req.body;
  if (code !== '52526767') return res.status(403).json({ error: 'Неверный код' });
  const chat = await Chat.findOne({ name });
  if (!chat) return res.status(404).json({ error: 'Не найден' });
  if (chat.creator === 'system') return res.status(400).json({ error: 'Системный чат нельзя удалить' });
  await Message.deleteMany({ chatId: chat.chatId });
  await Subscription.deleteMany({ chatId: chat.chatId });
  await Admin.deleteMany({ chatId: chat.chatId });
  await Chat.deleteOne({ chatId: chat.chatId });
  updateCatalog();
  res.json({ success: true });
});

// Поиск
app.get('/api/search', authMiddleware, async (req, res) => {
  const query = req.query.q || '';
  const users = await User.find({ nickname: { $regex: query, $options: 'i' } }).limit(10);
  const chats = await Chat.find({ nick: { $regex: query, $options: 'i' }, public: true }).limit(10);
  res.json({ users: users.map(u => ({ id: u._id, name: u.name, nickname: u.nickname })), chats });
});

// Админы (получить список подписчиков и админов чата)
app.get('/api/admins/:chatId', authMiddleware, async (req, res) => {
  const chat = await Chat.findOne({ chatId: req.params.chatId });
  if (!chat || chat.creator !== req.userId) return res.status(403).json({ error: 'Доступ запрещен' });
  const subs = await Subscription.find({ chatId: req.params.chatId });
  const admins = await Admin.find({ chatId: req.params.chatId });
  res.json({ subscribers: subs.map(s => s.userId), admins: admins.map(a => a.userId) });
});

// Назначить/разжаловать админа
app.post('/api/admins/:chatId', authMiddleware, async (req, res) => {
  const chat = await Chat.findOne({ chatId: req.params.chatId });
  if (!chat || chat.creator !== req.userId) return res.status(403).json({ error: 'Только создатель' });
  const { userId } = req.body;
  const exists = await Admin.findOne({ chatId: req.params.chatId, userId });
  if (exists) {
    await Admin.deleteOne({ _id: exists._id });
    res.json({ admin: false });
  } else {
    await Admin.create({ chatId: req.params.chatId, userId });
    res.json({ admin: true });
  }
});

// Обновление каталога
async function updateCatalog() {
  const publicChats = await Chat.find({ public: true, chatId: { $ne: 'catalog' } });
  let html = '<b>Публичные каналы и чаты:</b><br>';
  publicChats.forEach(c => {
    html += `<span style="cursor:pointer;" onclick="app.openChatById('${c.chatId}')">${c.name} (${c.isChannel?'канал':'чат'})</span><br>`;
  });
  // Удаляем старое системное сообщение каталога и создаем новое
  await Message.deleteMany({ chatId: 'catalog', system: true });
  await Message.create({ chatId: 'catalog', sender: 'system', text: html, system: true, type: 'chat' });
}

// Загрузка файлов (до 10 МБ)
const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/upload/:chatId', authMiddleware, upload.single('file'), async (req, res) => {
  // В реальном проекте сохраняем в GridFS, здесь заглушка
  res.json({ fileId: 'file_' + Date.now() });
});

// Запуск
server.listen(PORT, () => console.log(`Krista server running on port ${PORT}`));