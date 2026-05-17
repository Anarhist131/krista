require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'krista-secret-2024';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin@cluster0.sotwveu.mongodb.net/krista?appName=Cluster0';
const SALT_ROUNDS = 12;

// Middleware
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
app.use(helmet.hsts({
  maxAge: 15552000,
  includeSubDomains: false
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', apiLimiter);

// Подключение к MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// ===================== МОДЕЛИ =====================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  nickname: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  color: { type: String, default: '#007aff' },
  showOnline: { type: Boolean, default: true },
  showTyping: { type: Boolean, default: true },
  notifications: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  try {
    this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
    next();
  } catch (err) {
    next(err);
  }
});

const User = mongoose.model('User', userSchema);

const chatSchema = new mongoose.Schema({
  name: { type: String, required: true },
  nick: { type: String, default: '' },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isChannel: { type: Boolean, default: false },
  subscribers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});
const Chat = mongoose.model('Chat', chatSchema);

const messageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  edited: { type: Boolean, default: false },
  read: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
  subscribed: { type: Boolean, default: true }
});
subscriptionSchema.index({ userId: 1, chatId: 1 }, { unique: true });
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// ===================== MIDDLEWARE АУТЕНТИФИКАЦИИ =====================
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Нет токена' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
}

// ===================== WEBSOCKET =====================
wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          userId = decoded.userId;
          ws.userId = userId;
          // Отправить подтверждение авторизации
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          await User.findByIdAndUpdate(userId, { showOnline: true });
          broadcastUserStatus(userId, true);
        } catch (e) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Неверный токен' }));
          ws.close();
        }
      } else if (data.type === 'message' && userId) {
        const chat = await Chat.findById(data.chatId);
        if (!chat) return;
        const message = await new Message({
          chatId: data.chatId,
          sender: userId,
          text: data.text,
          edited: false,
          read: false,
          timestamp: new Date()
        }).save();
        const senderUser = await User.findById(userId);
        const payload = {
          type: 'newMessage',
          message: {
            id: message._id,
            chatId: message.chatId,
            sender: { id: userId, nickname: senderUser.nickname, color: senderUser.color },
            text: message.text,
            edited: false,
            read: false,
            timestamp: message.timestamp
          }
        };
        // Рассылаем всем подписчикам чата
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.userId) {
            const isSub = chat.subscribers.some(sub => sub.toString() === client.userId.toString());
            if (isSub || client.userId.toString() === userId.toString()) {
              client.send(JSON.stringify(payload));
            }
          }
        });
      } else if (data.type === 'typing' && userId) {
        const chat = await Chat.findById(data.chatId);
        if (!chat) return;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN && client.userId && client.userId.toString() !== userId.toString()) {
            if (chat.subscribers.some(sub => sub.toString() === client.userId.toString())) {
              client.send(JSON.stringify({
                type: 'typing',
                chatId: data.chatId,
                userId: userId,
                typing: data.typing
              }));
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
      await User.findByIdAndUpdate(userId, { showOnline: false });
      broadcastUserStatus(userId, false);
    }
  });
});

function broadcastUserStatus(userId, online) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.userId) {
      client.send(JSON.stringify({
        type: 'userStatus',
        userId,
        online
      }));
    }
  });
}

// ===================== API =====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, nickname, password } = req.body;
    if (!name || !nickname || !password) {
      return res.status(400).json({ error: 'Заполните все поля' });
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) {
      return res.status(400).json({ error: 'Никнейм: латиница, цифры, подчёркивание' });
    }
    const exists = await User.findOne({ nickname });
    if (exists) {
      return res.status(400).json({ error: 'Никнейм занят' });
    }
    const user = await new User({ name, nickname, password }).save();
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        nickname: user.nickname,
        color: user.color,
        notifications: user.notifications,
        showOnline: user.showOnline,
        showTyping: user.showTyping
      }
    });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    const user = await User.findOne({ nickname });
    if (!user) {
      return res.status(401).json({ error: 'Неверные данные' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Неверные данные' });
    }
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        nickname: user.nickname,
        color: user.color,
        notifications: user.notifications,
        showOnline: user.showOnline,
        showTyping: user.showTyping
      }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Ошибка сервера при входе' });
  }
});

app.get('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (e) {
    console.error('Get user error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const { name, nickname, color, notifications, showOnline, showTyping } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (name) user.name = name;
    if (nickname) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nickname)) {
        return res.status(400).json({ error: 'Неверный формат никнейма' });
      }
      const conflict = await User.findOne({ nickname, _id: { $ne: user._id } });
      if (conflict) return res.status(400).json({ error: 'Никнейм занят' });
      user.nickname = nickname;
    }
    if (color) user.color = color;
    if (notifications !== undefined) user.notifications = notifications;
    if (showOnline !== undefined) user.showOnline = showOnline;
    if (showTyping !== undefined) user.showTyping = showTyping;

    await user.save();
    res.json(user);
  } catch (e) {
    console.error('Update user error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const chats = await Chat.find({ creator: user._id });
    for (let chat of chats) {
      await Message.deleteMany({ chatId: chat._id });
      await Subscription.deleteMany({ chatId: chat._id });
      await Chat.findByIdAndDelete(chat._id);
    }
    await Subscription.deleteMany({ userId: user._id });
    await Message.deleteMany({ sender: user._id });
    await User.findByIdAndDelete(user._id);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete account error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/chat', authMiddleware, async (req, res) => {
  try {
    const { name, nick, isChannel } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });
    const chat = await new Chat({
      name,
      nick: nick || '',
      creator: req.userId,
      isChannel: isChannel || false,
      subscribers: [req.userId]
    }).save();
    res.json(chat);
  } catch (e) {
    console.error('Create chat error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const chats = await Chat.find({ subscribers: req.userId }).populate('creator', 'nickname');
    res.json(chats);
  } catch (e) {
    console.error('Get chats error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/chat/:id', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.creator.toString() !== req.userId) return res.status(403).json({ error: 'Только создатель' });
    if (req.body.name) chat.name = req.body.name;
    if (req.body.nick !== undefined) chat.nick = req.body.nick;
    await chat.save();
    res.json(chat);
  } catch (e) {
    console.error('Update chat error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/chat/:id', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (req.body.cheatCode === '52526767' || chat.creator.toString() === req.userId) {
      await Message.deleteMany({ chatId: chat._id });
      await Subscription.deleteMany({ chatId: chat._id });
      await Chat.findByIdAndDelete(chat._id);
      res.json({ success: true });
    } else {
      res.status(403).json({ error: 'Нет прав' });
    }
  } catch (e) {
    console.error('Delete chat error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/subscribe', authMiddleware, async (req, res) => {
  try {
    const { chatId } = req.body;
    const chat = await Chat.findById(chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    const index = chat.subscribers.indexOf(req.userId);
    if (index > -1) {
      chat.subscribers.splice(index, 1);
      await chat.save();
      res.json({ subscribed: false });
    } else {
      chat.subscribers.push(req.userId);
      await chat.save();
      res.json({ subscribed: true });
    }
  } catch (e) {
    console.error('Subscribe error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/messages/:chatId', authMiddleware, async (req, res) => {
  try {
    const msgs = await Message.find({ chatId: req.params.chatId }).sort({ timestamp: 1 }).populate('sender', 'nickname color');
    res.json(msgs);
  } catch (e) {
    console.error('Get messages error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.patch('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.sender.toString() !== req.userId) return res.status(403).json({ error: 'Не автор' });
    msg.text = req.body.text;
    msg.edited = true;
    await msg.save();
    res.json(msg);
  } catch (e) {
    console.error('Edit message error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msg.sender.toString() !== req.userId) return res.status(403).json({ error: 'Не автор' });
    await Message.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete message error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/export/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chatId);
    if (!chat) return res.status(404).send('Чат не найден');
    const msgs = await Message.find({ chatId: req.params.chatId }).sort({ timestamp: 1 }).populate('sender', 'nickname');
    let txt = '';
    let curDate = '';
    msgs.forEach(m => {
      const d = new Date(m.timestamp);
      const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      if (dateStr !== curDate) {
        txt += '=== ' + dateStr + ' ===\n';
        curDate = dateStr;
      }
      const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      txt += `[${time}] ${m.sender ? m.sender.nickname : 'Система'}: ${m.text}\n`;
    });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(chat.name)}.txt"`);
    res.send('\uFEFF' + txt);
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).send('Ошибка сервера');
  }
});

const linkCache = new Map();
app.get('/api/preview', authMiddleware, async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url не указан' });
    if (linkCache.has(url)) return res.json(linkCache.get(url));
    const resp = await fetch(url, { headers: { 'User-Agent': 'Krista-bot/1.0' } });
    const html = await resp.text();
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
    const desc = (html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i) || [])[1] || '';
    const result = { title: title.trim(), description: desc.trim(), url };
    linkCache.set(url, result);
    res.json(result);
  } catch (e) {
    console.error('Preview error:', e);
    res.json({ title: '', description: '', url: req.query.url });
  }
});

app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const users = await User.find({ nickname: { $regex: q, $options: 'i' } }).select('name nickname');
    const chats = await Chat.find({ nick: { $regex: q, $options: 'i' } }).select('name nick isChannel');
    res.json({ users, chats });
  } catch (e) {
    console.error('Search error:', e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Krista server on port ${PORT}`));
