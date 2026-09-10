// ============================================================
// КРИСТА.МЕССЕНДЖЕР v0.4 — СЕРВЕР
// Express + WebSocket + SQLite. Всё в одном файле.
// ============================================================

// ==== КОНФИГ (вместо .env) ====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'krista_v04_2aF9kL3mN7pQ5wR8vZ4nL1hT6jY3cB0sW4eR7tY8uI0oP2lA9sD3fG5hJ7';
const DATABASE_PATH = process.env.DATABASE_PATH || './data/krista.sqlite';

// ==== ИМПОРТЫ ====
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();

// ==== БАЗА ДАННЫХ ====
const DB_DIR = path.dirname(DATABASE_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new sqlite3.Database(DATABASE_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      uin TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      theme TEXT DEFAULT 'neon',
      background TEXT DEFAULT '',
      buttonsOnTop INTEGER DEFAULT 1,
      createdAt TEXT,
      lastSeen TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      members TEXT NOT NULL,
      updatedAt TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL,
      sender TEXT NOT NULL,
      senderName TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      replyTo TEXT,
      deleted INTEGER DEFAULT 0
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId)');
  db.run('CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)');
});

// ==== ХЕЛПЕРЫ ДЛЯ БД (Promise-обёртки) ====
const dbGet = (sql, params = []) => new Promise((res, rej) =>
  db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) =>
  db.run(sql, params, function(err) { err ? rej(err) : res(this); }));

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
function sanitize(text) {
  if (typeof text !== 'string') return '';
  return text.slice(0, 200); // обрезаем по лимиту
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
//  API МАРШРУТЫ
// ============================================================

// --- РЕГИСТРАЦИЯ ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, confirmPassword } = req.body;
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
    const existingName = await dbGet('SELECT uin FROM users WHERE username = ?', [username]);
    if (existingName) return res.status(400).json({ error: 'Имя уже занято' });

    // Генерация уникального UIN
    let uin;
    for (let i = 0; i < 20; i++) {
      uin = generateUIN();
      const exists = await dbGet('SELECT uin FROM users WHERE uin = ?', [uin]);
      if (!exists) break;
      uin = null;
    }
    if (!uin) return res.status(500).json({ error: 'Не удалось создать UIN' });

    const hashed = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    await dbRun(
      `INSERT INTO users (uin, username, password, theme, background, buttonsOnTop, createdAt, lastSeen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uin, username, hashed, 'neon', '', 1, now, now]
    );
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
    const { uin, password } = req.body;
    if (!uin || !password) return res.status(400).json({ error: 'Заполните поля' });
    if (!/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'UIN: 8 цифр' });

    const user = await dbGet('SELECT * FROM users WHERE uin = ?', [uin]);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверный пароль' });

    await dbRun('UPDATE users SET lastSeen = ? WHERE uin = ?', [new Date().toISOString(), uin]);
    const token = generateToken(uin);
    res.json({ success: true, uin, username: user.username, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- ПОЛУЧИТЬ ПРОФИЛЬ ---
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE uin = ?', [req.userUin]);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json({
      uin: user.uin,
      username: user.username,
      theme: user.theme || 'neon',
      background: user.background || '',
      buttonsOnTop: user.buttonsOnTop === 1
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- ОБНОВИТЬ ПРОФИЛЬ ---
app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const { username, password, newPassword, theme, background, buttonsOnTop } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE uin = ?', [req.userUin]);
    if (!user) return res.status(404).json({ error: 'Не найден' });

    const updates = [];
    const params = [];

    if (username !== undefined) {
      if (username.length < 3 || username.length > 30) {
        return res.status(400).json({ error: 'Имя: от 3 до 30 символов' });
      }
      const existing = await dbGet('SELECT uin FROM users WHERE username = ? AND uin != ?', [username, req.userUin]);
      if (existing) return res.status(400).json({ error: 'Имя занято' });
      updates.push('username = ?');
      params.push(username);
    }

    if (newPassword) {
      if (!password) return res.status(400).json({ error: 'Введите текущий пароль' });
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Неверный текущий пароль' });
      if (newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль: мин. 6 символов' });
      const hashed = await bcrypt.hash(newPassword, 10);
      updates.push('password = ?');
      params.push(hashed);
    }

    if (theme !== undefined) {
      const allowed = ['neon', 'rose-void', 'light', 'blossom'];
      if (!allowed.includes(theme)) return res.status(400).json({ error: 'Неверная тема' });
      updates.push('theme = ?');
      params.push(theme);
    }

    if (background !== undefined) {
      updates.push('background = ?');
      params.push(String(background).slice(0, 500));
    }

    if (buttonsOnTop !== undefined) {
      updates.push('buttonsOnTop = ?');
      params.push(buttonsOnTop ? 1 : 0);
    }

    if (updates.length === 0) return res.json({ success: true });

    params.push(req.userUin);
    await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE uin = ?`, params);
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
    const chats = (await dbAll('SELECT * FROM chats')).filter(c => {
      try { return JSON.parse(c.members).includes(uin); } catch { return false; }
    });
    for (const chat of chats) {
      await dbRun('DELETE FROM messages WHERE chatId = ?', [chat.id]);
      await dbRun('DELETE FROM chats WHERE id = ?', [chat.id]);
    }
    await dbRun('DELETE FROM users WHERE uin = ?', [uin]);
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
    const pattern = `%${q}%`;
    const rows = await dbAll(
      `SELECT uin, username FROM users WHERE (uin LIKE ? OR username LIKE ?) AND uin != ? LIMIT 20`,
      [pattern, pattern, req.userUin]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- СПИСОК ЧАТОВ ---
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = await dbGet('SELECT * FROM users WHERE uin = ?', [req.userUin]);
    const allChats = await dbAll('SELECT * FROM chats');
    const myChats = allChats.filter(c => {
      try { return JSON.parse(c.members).includes(req.userUin); } catch { return false; }
    });

    const result = [];
    for (const chat of myChats) {
      const members = JSON.parse(chat.members);
      const otherUin = members.find(u => u !== req.userUin);
      const other = otherUin ? await dbGet('SELECT uin, username, lastSeen FROM users WHERE uin = ?', [otherUin]) : null;

      // Последнее сообщение
      const lastMsg = await dbGet(
        `SELECT * FROM messages WHERE chatId = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 1`,
        [chat.id]
      );

      // Непрочитанные: все после lastSeen пользователя
      let unread = 0;
      if (me && me.lastSeen) {
        const unreadRow = await dbGet(
          `SELECT COUNT(*) as cnt FROM messages 
           WHERE chatId = ? AND sender != ? AND timestamp > ? AND deleted = 0`,
          [chat.id, req.userUin, me.lastSeen]
        );
        unread = unreadRow?.cnt || 0;
      }

      result.push({
        id: chat.id,
        otherUin: otherUin || null,
        otherUsername: other?.username || '???',
        lastMessage: lastMsg || null,
        unreadCount: unread,
        updatedAt: chat.updatedAt,
        online: otherUin ? clients.has(otherUin) : false
      });
    }

    // Сортировка: новые сообщения — вверх
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

// --- СОЗДАТЬ ЧАТ (ДОБАВИТЬ КОНТАКТ) ---
app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { uin } = req.body;
    if (!uin || !/^\d{8}$/.test(uin)) return res.status(400).json({ error: 'Неверный UIN' });
    if (uin === req.userUin) return res.status(400).json({ error: 'Нельзя добавить себя' });

    const other = await dbGet('SELECT uin FROM users WHERE uin = ?', [uin]);
    if (!other) return res.status(404).json({ error: 'Пользователь не найден' });

    // Проверяем, есть ли уже чат
    const allChats = await dbAll('SELECT * FROM chats');
    const existing = allChats.find(c => {
      try {
        const m = JSON.parse(c.members);
        return m.includes(req.userUin) && m.includes(uin);
      } catch { return false; }
    });
    if (existing) {
      return res.json({ success: true, chatId: existing.id, existing: true });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    await dbRun(
      `INSERT INTO chats (id, members, updatedAt) VALUES (?, ?, ?)`,
      [id, JSON.stringify([req.userUin, uin]), now]
    );

    // Уведомляем второго пользователя
    const client = clients.get(uin);
    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'chatCreated', payload: { chatId: id } }));
    }

    res.status(201).json({ success: true, chatId: id });
  } catch (err) {
    console.error('Create chat error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- УДАЛИТЬ ЧАТ ---
app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await dbGet('SELECT * FROM chats WHERE id = ?', [req.params.chatId]);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    const members = JSON.parse(chat.members);
    if (!members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });

    await dbRun('DELETE FROM messages WHERE chatId = ?', [chat.id]);
    await dbRun('DELETE FROM chats WHERE id = ?', [chat.id]);

    // Уведомляем обоих
    members.forEach(uin => {
      const c = clients.get(uin);
      if (c && c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify({ type: 'chatDeleted', payload: { chatId: chat.id } }));
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete chat error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// --- СООБЩЕНИЯ ЧАТА ---
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await dbGet('SELECT * FROM chats WHERE id = ?', [req.params.chatId]);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    const members = JSON.parse(chat.members);
    if (!members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });

    const msgs = await dbAll(
      `SELECT * FROM messages WHERE chatId = ? AND deleted = 0 ORDER BY timestamp ASC LIMIT 500`,
      [chat.id]
    );

    // Обновляем lastSeen пользователя (после того как сообщения прочитаны)
    await dbRun('UPDATE users SET lastSeen = ? WHERE uin = ?', [new Date().toISOString(), req.userUin]);

    res.json(msgs);
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
const clients = new Map(); // uin -> ws

// Rate limiting
const wsRate = new Map(); // uin -> { count, first }
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

// Heartbeat
const HEARTBEAT_INTERVAL = 30000;

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.uin = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return ws.send(JSON.stringify({ type: 'error', payload: 'Неверный формат' }));
    }

    const { type, payload } = data;

    // ==== AUTH ====
    if (type === 'auth') {
      const decoded = verifyToken(payload?.token);
      if (!decoded) {
        ws.send(JSON.stringify({ type: 'error', payload: 'Неверный токен' }));
        return ws.close();
      }
      ws.uin = decoded.uin;
      clients.set(ws.uin, ws);
      // Оповещаем всех о статусе
      broadcast({ type: 'status', payload: { uin: ws.uin, status: 'online' } });
      return;
    }

    // Всё остальное требует авторизации
    if (!ws.uin) {
      return ws.send(JSON.stringify({ type: 'error', payload: 'Не авторизован' }));
    }

    // Rate limit
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

        const chat = await dbGet('SELECT * FROM chats WHERE id = ?', [chatId]);
        if (!chat) return;
        const members = JSON.parse(chat.members);
        if (!members.includes(ws.uin)) return;

        const user = await dbGet('SELECT username FROM users WHERE uin = ?', [ws.uin]);
        if (!user) return;

        // replyTo — проверяем, что сообщение существует в этом чате
        let validReply = null;
        if (replyTo) {
          const parent = await dbGet('SELECT id FROM messages WHERE id = ? AND chatId = ? AND deleted = 0', [replyTo, chatId]);
          if (parent) validReply = parent.id;
        }

        const msg = {
          id: uuidv4(),
          chatId,
          sender: ws.uin,
          senderName: user.username,
          text: trimmed,
          timestamp: new Date().toISOString(),
          replyTo: validReply,
          deleted: 0
        };

        await dbRun(
          `INSERT INTO messages (id, chatId, sender, senderName, text, timestamp, replyTo, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [msg.id, msg.chatId, msg.sender, msg.senderName, msg.text, msg.timestamp, msg.replyTo, 0]
        );
        await dbRun('UPDATE chats SET updatedAt = ? WHERE id = ?', [msg.timestamp, chatId]);
        await dbRun('UPDATE users SET lastSeen = ? WHERE uin = ?', [msg.timestamp, ws.uin]);

        // Рассылаем обоим
        const out = JSON.stringify({ type: 'newMessage', payload: msg });
        members.forEach(uin => {
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
        const msg = await dbGet('SELECT * FROM messages WHERE id = ?', [messageId]);
        if (!msg || msg.deleted === 1) return;
        if (msg.sender !== ws.uin) {
          return ws.send(JSON.stringify({ type: 'error', payload: 'Можно удалять только свои' }));
        }
        const chat = await dbGet('SELECT * FROM chats WHERE id = ?', [msg.chatId]);
        if (!chat) return;
        const members = JSON.parse(chat.members);

        await dbRun('UPDATE messages SET deleted = 1 WHERE id = ?', [messageId]);

        const out = JSON.stringify({ type: 'deleteMessage', payload: { messageId, chatId: msg.chatId } });
        members.forEach(uin => {
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
        const chat = await dbGet('SELECT * FROM chats WHERE id = ?', [chatId]);
        if (!chat) return;
        const members = JSON.parse(chat.members);
        if (!members.includes(ws.uin)) return;

        await dbRun('DELETE FROM messages WHERE chatId = ?', [chatId]);
        await dbRun('DELETE FROM chats WHERE id = ?', [chatId]);

        const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
        members.forEach(uin => {
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
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, HEARTBEAT_INTERVAL);

// ==== СТАРТ ====
server.listen(PORT, () => {
  console.log(`🚀 Криста.Мессенджер v0.4 запущен на http://localhost:${PORT}`);
  console.log(`📦 БД: ${DATABASE_PATH}`);
});
