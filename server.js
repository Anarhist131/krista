// K.Мессенджер 2.0 — серверная часть
// Используем Express, MongoDB (Mongoose), WebSocket (ws), JWT, bcrypt
// Переменные окружения встроены прямо в код (для простоты). В реальном проекте выносите в .env!

const EXPRESS = require('express');
const HTTP = require('http');
const WS = require('ws');
const MONGOOSE = require('mongoose');
const BCRYPT = require('bcrypt');
const JWT = require('jsonwebtoken');
const PATH = require('path');

// ---------- НАСТРОЙКИ (встроенные переменные окружения) ----------
const MONGODB_URI = 'mongodb+srv://admin:admin@cluster0.sotwveu.mongodb.net/kmessenger?appName=Cluster0';
const JWT_SECRET = 'f8a7d9c3b1e4f6a0d2c5e7f9b3a1d6c8e0f2a4b6d8c0e1f3a5b7d9';
const MASTER_PASSWORD = '52526767';
const PORT = process.env.PORT || 3000;

// ---------- МОДЕЛИ БД ----------
MONGOOSE.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB подключена'))
  .catch(err => console.error('Ошибка подключения к MongoDB:', err));

// Схема пользователя
const userSchema = new MONGOOSE.Schema({
  uin: { type: String, unique: true, required: true },         // 8 цифр
  nickname: { type: String, unique: true, required: true },
  displayName: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  nicknameColor: { type: String, default: '#00cc66' },
  showUin: { type: Boolean, default: true },                   // показывать UIN рядом с ником
  subscribedChannels: [{ type: String }],                      // массив UIN каналов
  joinedChats: [{ type: String }],                             // UIN чатов, в которых участвует
  readStatus: { type: Map, of: Date, default: {} }             // chatUin -> дата последнего прочтения
});

// Схема чата
const chatSchema = new MONGOOSE.Schema({
  uin: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['private', 'group', 'channel', 'general'], required: true },
  creator: { type: String },            // UIN создателя
  participants: [{ type: String }],     // для private/group/general
  subscribers: [{ type: String }],      // для channel
  createdAt: { type: Date, default: Date.now }
});

// Схема сообщения
const messageSchema = new MONGOOSE.Schema({
  chatUin: { type: String, required: true, index: true },
  senderUin: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const User = MONGOOSE.model('User', userSchema);
const Chat = MONGOOSE.model('Chat', chatSchema);
const Message = MONGOOSE.model('Message', messageSchema);

// ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------
// Генерация уникального 8-значного UIN
async function generateUniqueUin() {
  let uin;
  let exists = true;
  while (exists) {
    uin = String(Math.floor(10000000 + Math.random() * 90000000));
    // проверяем уникальность в обеих коллекциях
    const userWithUin = await User.findOne({ uin });
    const chatWithUin = await Chat.findOne({ uin });
    if (!userWithUin && !chatWithUin) exists = false;
  }
  return uin;
}

// Middleware для проверки JWT (авторизация)
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется токен' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = JWT.verify(token, JWT_SECRET);
    req.user = decoded;  // { uin, nickname, isAdmin }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

// Middleware для админа
function adminMiddleware(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
}

// ---------- ИНИЦИАЛИЗАЦИЯ ОБЩЕГО ЧАТА ----------
async function ensureGeneralChat() {
  const existing = await Chat.findOne({ uin: '00000000' });
  if (!existing) {
    await new Chat({
      uin: '00000000',
      name: 'Общий чат',
      type: 'general',
      participants: []
    }).save();
    console.log('Общий чат создан');
  }
}
// Добавим всех пользователей в общий чат при регистрации
async function addUserToGeneralChat(userUin) {
  await Chat.updateOne(
    { uin: '00000000' },
    { $addToSet: { participants: userUin } }
  );
  await User.updateOne(
    { uin: userUin },
    { $addToSet: { joinedChats: '00000000' } }
  );
}

// ---------- EXPRESS + HTTP + WS ----------
const app = EXPRESS();
const server = HTTP.createServer(app);
const wss = new WS.Server({ server });

// Хранилище активных соединений: Map<userUin, WebSocket>
const clients = new Map();

// Настройка WebSocket
wss.on('connection', (ws, req) => {
  let userUin = null;

  // Пинг/понг для поддержания соединения
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) { return; }

    // Обработка аутентификации через WebSocket
    if (msg.type === 'auth') {
      const token = msg.token;
      try {
        const decoded = JWT.verify(token, JWT_SECRET);
        userUin = decoded.uin;
        clients.set(userUin, ws);
        ws.send(JSON.stringify({ type: 'auth_success', uin: userUin }));
        console.log(`WS: пользователь ${userUin} подключён`);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'auth_error', error: 'Неверный токен' }));
      }
    }
    // Гость не может отправлять сообщения, но может слушать
  });

  ws.on('close', () => {
    if (userUin) {
      clients.delete(userUin);
      console.log(`WS: пользователь ${userUin} отключён`);
    }
  });
});

// Интервал проверки живости соединений (пинг каждые 30 сек)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Функция рассылки сообщения всем участникам чата (через WS)
async function broadcastMessage(chatUin, message) {
  // Определяем, кому рассылать: участники чата или подписчики канала
  const chat = await Chat.findOne({ uin: chatUin });
  if (!chat) return;
  let recipients = [];
  if (chat.type === 'channel') {
    recipients = chat.subscribers;
  } else {
    recipients = chat.participants;
  }
  // Также добавим отправителя, если он участник
  // Рассылаем всем получателям, которые онлайн
  for (const uin of recipients) {
    const ws = clients.get(uin);
    if (ws && ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify({ type: 'new_message', message }));
    }
  }
  // Также отправим гостевым слушателям? Нет, гость не имеет uin.
  // Для гостей мы не можем определить, какой чат они смотрят.
  // Поэтому гость получит новые сообщения только при REST-запросе (polling не делаем).
  // В реальном приложении можно добавить "комнату" для гостей.
}

// ---------- API МАРШРУТЫ ----------
app.use(EXPRESS.json());

// Раздача статики из папки public
app.use(EXPRESS.static(PATH.join(__dirname, 'public')));

// Отключаем заголовки, разрешаем CSP (Content-Security-Policy)
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:;");
  next();
});

// --- Пользователи ---
// Регистрация
app.post('/api/register', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    if (!nickname || !password) return res.status(400).json({ error: 'Никнейм и пароль обязательны' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });

    const existing = await User.findOne({ nickname });
    if (existing) return res.status(400).json({ error: 'Пользователь с таким никнеймом уже существует' });

    const passwordHash = await BCRYPT.hash(password, 10);
    const uin = await generateUniqueUin();

    const user = new User({
      uin,
      nickname,
      displayName: nickname,
      passwordHash,
      nicknameColor: '#00cc66'
    });
    await user.save();

    // Добавляем в общий чат
    await addUserToGeneralChat(uin);

    // Генерируем токен
    const token = JWT.sign({ uin, nickname: user.nickname, isAdmin: false }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { uin: user.uin, nickname: user.nickname, displayName: user.displayName, color: user.nicknameColor, showUin: user.showUin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  try {
    const { nickname, password } = req.body;
    const user = await User.findOne({ nickname });
    if (!user) return res.status(401).json({ error: 'Неверный никнейм или пароль' });

    const valid = await BCRYPT.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Неверный никнейм или пароль' });

    const token = JWT.sign({ uin: user.uin, nickname: user.nickname, isAdmin: false }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { uin: user.uin, nickname: user.nickname, displayName: user.displayName, color: user.nicknameColor, showUin: user.showUin } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вход как гость (без пароля) - не предусмотрено, просто отдаём публичные данные без авторизации

// Получение профиля
app.get('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ uin: req.user.uin });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ uin: user.uin, nickname: user.nickname, displayName: user.displayName, color: user.nicknameColor, showUin: user.showUin, subscribedChannels: user.subscribedChannels });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновление профиля
app.put('/api/user/me', authMiddleware, async (req, res) => {
  try {
    const { displayName, nicknameColor, showUin } = req.body;
    const update = {};
    if (displayName !== undefined) update.displayName = displayName;
    if (nicknameColor !== undefined) update.nicknameColor = nicknameColor;
    if (showUin !== undefined) update.showUin = showUin;

    await User.updateOne({ uin: req.user.uin }, { $set: update });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- Поиск по UIN ---
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json({ users: [], chats: [] });

    // Поиск среди пользователей (частичное совпадение UIN)
    const users = await User.find({ uin: { $regex: q, $options: 'i' } })
      .select('uin nickname displayName nicknameColor showUin')
      .limit(10);
    // Поиск среди чатов/каналов
    const chats = await Chat.find({ uin: { $regex: q, $options: 'i' } })
      .select('uin name type subscribers participants')
      .limit(10);

    res.json({
      users: users.map(u => ({
        uin: u.uin,
        nickname: u.nickname,
        displayName: u.displayName,
        color: u.nicknameColor,
        showUin: u.showUin
      })),
      chats: chats.map(c => ({
        uin: c.uin,
        name: c.name,
        type: c.type,
        subscribersCount: c.subscribers ? c.subscribers.length : 0,
        participantsCount: c.participants ? c.participants.length : 0
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- Чаты и каналы ---
// Создание чата/канала
app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Название и тип обязательны' });
    if (!['group', 'channel'].includes(type)) return res.status(400).json({ error: 'Неверный тип' });

    const uin = await generateUniqueUin();
    const chat = new Chat({
      uin,
      name,
      type,
      creator: req.user.uin,
      participants: type === 'group' ? [req.user.uin] : [],
      subscribers: type === 'channel' ? [req.user.uin] : []
    });
    await chat.save();

    // Добавляем в соответствующий список у создателя
    if (type === 'group') {
      await User.updateOne({ uin: req.user.uin }, { $addToSet: { joinedChats: uin } });
    } else if (type === 'channel') {
      await User.updateOne({ uin: req.user.uin }, { $addToSet: { subscribedChannels: uin } });
    }

    res.json({ uin, name, type });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Подписка на канал
app.post('/api/chats/:uin/subscribe', authMiddleware, async (req, res) => {
  try {
    const chatUin = req.params.uin;
    const chat = await Chat.findOne({ uin: chatUin, type: 'channel' });
    if (!chat) return res.status(404).json({ error: 'Канал не найден' });

    if (chat.subscribers.includes(req.user.uin)) {
      return res.status(400).json({ error: 'Вы уже подписаны' });
    }

    chat.subscribers.push(req.user.uin);
    await chat.save();
    await User.updateOne({ uin: req.user.uin }, { $addToSet: { subscribedChannels: chatUin } });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отписка от канала
app.post('/api/chats/:uin/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const chatUin = req.params.uin;
    const chat = await Chat.findOne({ uin: chatUin, type: 'channel' });
    if (!chat) return res.status(404).json({ error: 'Канал не найден' });

    chat.subscribers = chat.subscribers.filter(u => u !== req.user.uin);
    await chat.save();
    await User.updateOne({ uin: req.user.uin }, { $pull: { subscribedChannels: chatUin } });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить список чатов и каналов для главного экрана
app.get('/api/chats', async (req, res) => {
  try {
    // Если пользователь авторизован — его чаты + каналы (сортировка с непрочитанными)
    // Для гостя — все публичные чаты/каналы
    const authHeader = req.headers.authorization;
    let user = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = JWT.verify(token, JWT_SECRET);
        user = await User.findOne({ uin: decoded.uin });
      } catch (e) { /* гость */ }
    }

    // Топ-3 каналов
    const topChannels = await Chat.aggregate([
      { $match: { type: 'channel' } },
      { $addFields: { subCount: { $size: '$subscribers' } } },
      { $sort: { subCount: -1 } },
      { $limit: 3 },
      { $project: { uin: 1, name: 1, subCount: 1 } }
    ]);

    // Список чатов
    let chatList;
    if (user) {
      // Чаты, в которых участвует пользователь + подписанные каналы
      const relevantUins = [...user.joinedChats, ...user.subscribedChannels];
      // Исключаем дубликаты
      const uniqueUins = [...new Set(relevantUins)];
      const chats = await Chat.find({ uin: { $in: uniqueUins } }).lean();

      // Для каждого чата получаем последнее сообщение и проверяем непрочитанные
      const chatData = await Promise.all(chats.map(async (chat) => {
        const lastMsg = await Message.findOne({ chatUin: chat.uin }).sort({ timestamp: -1 });
        const readTime = user.readStatus ? (user.readStatus.get(chat.uin) || new Date(0)) : new Date(0);
        const hasNew = lastMsg && lastMsg.timestamp > readTime;
        return {
          uin: chat.uin,
          name: chat.name,
          type: chat.type,
          lastMessage: lastMsg ? { text: lastMsg.text, timestamp: lastMsg.timestamp } : null,
          hasNew: !!hasNew
        };
      }));

      // Сортировка: сначала с новыми сообщениями (сортировать по убыванию даты последнего сообщения), потом остальные
      chatData.sort((a, b) => {
        if (a.hasNew && !b.hasNew) return -1;
        if (!a.hasNew && b.hasNew) return 1;
        // Если оба с новыми или оба без — сортируем по дате последнего сообщения
        const dateA = a.lastMessage ? new Date(a.lastMessage.timestamp) : new Date(0);
        const dateB = b.lastMessage ? new Date(b.lastMessage.timestamp) : new Date(0);
        return dateB - dateA;
      });

      res.json({ topChannels, chats: chatData });
    } else {
      // Гость: показываем все групповые чаты, каналы и общий чат (публичные)
      const chats = await Chat.find({ type: { $in: ['group', 'channel', 'general'] } }).lean();
      const chatData = await Promise.all(chats.map(async (chat) => {
        const lastMsg = await Message.findOne({ chatUin: chat.uin }).sort({ timestamp: -1 });
        return {
          uin: chat.uin,
          name: chat.name,
          type: chat.type,
          lastMessage: lastMsg ? { text: lastMsg.text, timestamp: lastMsg.timestamp } : null,
          hasNew: false
        };
      }));
      res.json({ topChannels, chats: chatData });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить сообщения конкретного чата
app.get('/api/chats/:uin/messages', async (req, res) => {
  try {
    const chatUin = req.params.uin;
    // Проверка доступа: если пользователь авторизован, он должен быть участником или подписчиком;
    // гость может видеть только публичные чаты (групповые, каналы, общий)
    const chat = await Chat.findOne({ uin: chatUin });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });

    const authHeader = req.headers.authorization;
    let user = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = JWT.verify(token, JWT_SECRET);
        user = await User.findOne({ uin: decoded.uin });
      } catch (e) { /* гость */ }
    }

    // Проверка доступа
    const isPublic = ['group', 'channel', 'general'].includes(chat.type);
    if (!isPublic && (!user || !chat.participants.includes(user.uin))) {
      return res.status(403).json({ error: 'Нет доступа к этому чату' });
    }

    const messages = await Message.find({ chatUin }).sort({ timestamp: 1 }).limit(50);
    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отправка сообщения
app.post('/api/chats/:uin/messages', authMiddleware, async (req, res) => {
  try {
    const chatUin = req.params.uin;
    const { text } = req.body;
    if (!text || text.trim() === '') return res.status(400).json({ error: 'Текст сообщения пуст' });

    const chat = await Chat.findOne({ uin: chatUin });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });

    // Проверка прав на отправку
    if (chat.type === 'channel') {
      if (chat.creator !== req.user.uin) {
        return res.status(403).json({ error: 'Только создатель канала может писать' });
      }
    } else {
      if (!chat.participants.includes(req.user.uin)) {
        return res.status(403).json({ error: 'Вы не участник этого чата' });
      }
    }

    const message = new Message({
      chatUin,
      senderUin: req.user.uin,
      text: text.trim()
    });
    await message.save();

    // Обновить readStatus отправителя (чтобы не показывало непрочитанным)
    await User.updateOne(
      { uin: req.user.uin },
      { $set: { [`readStatus.${chatUin}`]: message.timestamp } }
    );

    // Рассылка через WebSocket
    broadcastMessage(chatUin, message.toObject());

    res.json(message);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- Администрирование ---
// Получить админ-токен (ввод мастер-пароля)
app.post('/api/admin/token', authMiddleware, (req, res) => {
  const { masterPassword } = req.body;
  if (masterPassword !== MASTER_PASSWORD) {
    return res.status(403).json({ error: 'Неверный мастер-пароль' });
  }
  const adminToken = JWT.sign(
    { uin: req.user.uin, nickname: req.user.nickname, isAdmin: true },
    JWT_SECRET,
    { expiresIn: '5m' }
  );
  res.json({ adminToken });
});

// Удаление любого чата (админ)
app.delete('/api/admin/chats/:uin', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const chatUin = req.params.uin;
    const chat = await Chat.findOne({ uin: chatUin });
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });

    // Удаляем сообщения чата
    await Message.deleteMany({ chatUin });
    // Удаляем чат
    await Chat.deleteOne({ uin: chatUin });
    // Убираем из списков пользователей
    await User.updateMany(
      { $or: [{ joinedChats: chatUin }, { subscribedChannels: chatUin }] },
      { $pull: { joinedChats: chatUin, subscribedChannels: chatUin } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление любого сообщения (админ)
app.delete('/api/admin/messages/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const msgId = req.params.id;
    const msg = await Message.findById(msgId);
    if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
    await Message.deleteOne({ _id: msgId });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- Прочее ---
// Пометить чат прочитанным
app.post('/api/chats/:uin/read', authMiddleware, async (req, res) => {
  try {
    const chatUin = req.params.uin;
    await User.updateOne(
      { uin: req.user.uin },
      { $set: { [`readStatus.${chatUin}`]: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Заглушка для главной (SPA)
app.get('*', (req, res) => {
  res.sendFile(PATH.join(__dirname, 'public', 'index.html'));
});

// ---------- ЗАПУСК СЕРВЕРА ----------
server.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  await ensureGeneralChat();   // убедимся, что общий чат существует
});
