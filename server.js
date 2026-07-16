// ============================================================
// КРИСТА.МЕССЕНДЖЕР — ПОЛНЫЙ СЕРВЕР (Express + WebSocket + JSON)
// (БЕЗ PUSH-УВЕДОМЛЕНИЙ)
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== НАСТРОЙКИ =====
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'x7G9mK2pQ5wR8vZ4nL1hT6jY3cB0sW4eR7tY8uI0oP2lA9sD3fG5hJ7kL9zX5cV8bN4mQ2wE6rT9yU3';
const DATA_FILE = path.join(__dirname, 'data.json');

// ===== МИДЛВАРЫ =====
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== РАБОТА С JSON-ФАЙЛОМ =====

function readData() {
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        const initialData = {
            users: [],
            chats: [],
            messages: [],
            nextId: 1
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function generateIUN(data) {
    let iun;
    let exists = true;
    while (exists) {
        iun = String(Math.floor(10000000 + Math.random() * 90000000));
        exists = data.users.some(u => u.iun === iun);
    }
    return iun;
}

async function hashPassword(password) {
    return await bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
}

function generateToken(iun) {
    return jwt.sign({ iun }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userIun = decoded.iun;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Неверный токен' });
    }
}

// ===== ВЕБСОКЕТЫ =====

const clients = new Map();

wss.on('connection', (ws, req) => {
    console.log('🔌 Новое WebSocket-подключение');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const { type, payload } = data;

            if (type === 'auth') {
                const token = payload.token;
                try {
                    const decoded = jwt.verify(token, JWT_SECRET);
                    ws.iun = decoded.iun;
                    clients.set(ws.iun, ws);
                    console.log(`✅ Пользователь ${ws.iun} авторизован`);
                    broadcast({ type: 'status', payload: { iun: ws.iun, status: 'online' } });
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', payload: 'Неверный токен' }));
                }
            }

            if (type === 'newMessage') {
                const { chatId, text, sender } = payload;
                const dataFile = readData();
                const chat = dataFile.chats.find(c => c.id === chatId);
                if (!chat || !chat.members.includes(sender)) {
                    ws.send(JSON.stringify({ type: 'error', payload: 'Нет доступа' }));
                    return;
                }
                const newMsg = {
                    id: String(dataFile.nextId++),
                    chatId,
                    sender,
                    text,
                    timestamp: new Date().toISOString(),
                    reactions: {},
                    isPinned: false,
                    deleted: false
                };
                dataFile.messages.push(newMsg);
                writeData(dataFile);

                // Оповещаем участников чата
                const msgPayload = { type: 'newMessage', payload: newMsg };
                chat.members.forEach(iun => {
                    const client = clients.get(iun);
                    if (client && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msgPayload));
                    }
                });

                chat.updatedAt = new Date().toISOString();
                writeData(dataFile);
            }

            if (type === 'typing') {
                const { chatId, sender } = payload;
                const dataFile = readData();
                const chat = dataFile.chats.find(c => c.id === chatId);
                if (!chat) return;
                chat.members.forEach(iun => {
                    if (iun !== sender) {
                        const client = clients.get(iun);
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'typing', payload: { chatId, sender } }));
                        }
                    }
                });
            }

            if (type === 'reaction') {
                const { messageId, reaction, user } = payload;
                const dataFile = readData();
                const msg = dataFile.messages.find(m => m.id === messageId);
                if (!msg) return;
                if (!msg.reactions) msg.reactions = {};
                if (!msg.reactions[reaction]) msg.reactions[reaction] = [];
                const idx = msg.reactions[reaction].indexOf(user);
                if (idx > -1) msg.reactions[reaction].splice(idx, 1);
                else msg.reactions[reaction].push(user);
                writeData(dataFile);

                const chat = dataFile.chats.find(c => c.id === msg.chatId);
                if (chat) {
                    chat.members.forEach(iun => {
                        const client = clients.get(iun);
                        if (client && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'reaction', payload: { messageId, reaction, user, removed: idx > -1 } }));
                        }
                    });
                }
            }

            if (type === 'deleteMessage') {
                const { messageId, user } = payload;
                const dataFile = readData();
                const msg = dataFile.messages.find(m => m.id === messageId);
                if (!msg) return;
                const chat = dataFile.chats.find(c => c.id === msg.chatId);
                if (!chat) return;
                const isAuthor = msg.sender === user;
                const isAdmin = chat.admins.includes(user);
                const isOwner = chat.owner === user;
                if (!isAuthor && !isAdmin && !isOwner) {
                    ws.send(JSON.stringify({ type: 'error', payload: 'Нет прав' }));
                    return;
                }
                msg.deleted = true;
                writeData(dataFile);
                chat.members.forEach(iun => {
                    const client = clients.get(iun);
                    if (client && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'deleteMessage', payload: { messageId, chatId: msg.chatId } }));
                    }
                });
            }

        } catch (err) {
            console.error('WebSocket ошибка:', err);
            ws.send(JSON.stringify({ type: 'error', payload: 'Ошибка обработки' }));
        }
    });

    ws.on('close', () => {
        if (ws.iun) {
            clients.delete(ws.iun);
            broadcast({ type: 'status', payload: { iun: ws.iun, status: 'offline' } });
            console.log(`❌ Пользователь ${ws.iun} отключился`);
        }
    });
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

// ===== API МАРШРУТЫ =====

// ---- Аутентификация ----

app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
        if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
        const data = readData();
        const iun = generateIUN(data);
        const hashed = await hashPassword(password);
        data.users.push({
            iun,
            username,
            password: hashed,
            status: 'Онлайн',
            color: '#b33a3a',
            theme: 'default',
            blocked: [],
            pinnedChats: [],
            createdAt: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        });
        writeData(data);
        const token = generateToken(iun);
        res.status(201).json({ success: true, iun, username, token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка регистрации' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { iun, password } = req.body;
        const data = readData();
        const user = data.users.find(u => u.iun === iun);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        const valid = await verifyPassword(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
        user.lastSeen = new Date().toISOString();
        writeData(data);
        const token = generateToken(iun);
        res.json({ success: true, iun: user.iun, username: user.username, token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка входа' });
    }
});

// ---- Профиль ----

app.get('/api/me', authMiddleware, (req, res) => {
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const { password, ...safeUser } = user;
    res.json(safeUser);
});

app.put('/api/me', authMiddleware, (req, res) => {
    const { username, status, color, theme } = req.body;
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (username) user.username = username;
    if (status) user.status = status;
    if (color) user.color = color;
    if (theme) user.theme = theme;
    writeData(data);
    res.json({ success: true });
});

// ---- Поиск ----

app.get('/api/search', authMiddleware, (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const data = readData();
    const users = data.users.filter(u =>
        u.iun.includes(q) || u.username.toLowerCase().includes(q.toLowerCase())
    ).slice(0, 20);
    res.json(users.map(u => ({ iun: u.iun, username: u.username, status: u.status, color: u.color })));
});

// ---- Чаты ----

app.get('/api/chats', authMiddleware, (req, res) => {
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    let chats = data.chats.filter(c => c.members.includes(req.userIun) && !c.isArchived);
    chats = chats.map(chat => {
        const messages = data.messages.filter(m => m.chatId === chat.id && !m.deleted);
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        const unreadCount = messages.filter(m => m.sender !== req.userIun && new Date(m.timestamp) > new Date(user.lastSeen)).length;
        return { ...chat, lastMessage: lastMsg, unreadCount };
    });
    const pinned = chats.filter(c => user.pinnedChats.includes(c.id));
    const unpinned = chats.filter(c => !user.pinnedChats.includes(c.id));
    const result = [...pinned, ...unpinned].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    res.json(result);
});

app.post('/api/chats', authMiddleware, (req, res) => {
    const { type, name, members, admins, colorScheme, background } = req.body;
    if (!type || !['personal', 'group', 'channel'].includes(type)) return res.status(400).json({ error: 'Неверный тип' });
    if (!name || name.trim() === '') return res.status(400).json({ error: 'Название обязательно' });
    if (!members || !Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'Нужны участники' });
    const data = readData();
    if (type === 'personal') {
        const existing = data.chats.find(c => c.type === 'personal' && c.members.includes(req.userIun) && c.members.includes(members[0]));
        if (existing) return res.status(409).json({ error: 'Чат уже существует', chatId: existing.id });
    }
    const newChat = {
        id: String(data.nextId++),
        type,
        name: name.trim(),
        members: [req.userIun, ...members],
        admins: admins || [req.userIun],
        owner: req.userIun,
        colorScheme: colorScheme || 'default',
        background: background || '',
        pinnedMessages: [],
        isArchived: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    data.chats.push(newChat);
    writeData(data);
    const chatPayload = { type: 'newChat', payload: newChat };
    newChat.members.forEach(iun => {
        const client = clients.get(iun);
        if (client && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(chatPayload));
    });
    res.status(201).json({ success: true, chatId: newChat.id });
});

app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
    const { chatId } = req.params;
    const data = readData();
    const chat = data.chats.find(c => c.id === chatId);
    if (!chat || !chat.members.includes(req.userIun)) return res.status(403).json({ error: 'Нет доступа' });
    const messages = data.messages.filter(m => m.chatId === chatId && !m.deleted).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(messages);
});

app.post('/api/chats/:chatId/pin', authMiddleware, (req, res) => {
    const { chatId } = req.params;
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const idx = user.pinnedChats.indexOf(chatId);
    if (idx > -1) user.pinnedChats.splice(idx, 1);
    else {
        if (user.pinnedChats.length >= 10) return res.status(400).json({ error: 'Лимит 10' });
        user.pinnedChats.push(chatId);
    }
    writeData(data);
    res.json({ success: true, pinnedChats: user.pinnedChats });
});

app.post('/api/chats/:chatId/archive', authMiddleware, (req, res) => {
    const { chatId } = req.params;
    const data = readData();
    const chat = data.chats.find(c => c.id === chatId);
    if (!chat || !chat.members.includes(req.userIun)) return res.status(403).json({ error: 'Нет доступа' });
    chat.isArchived = !chat.isArchived;
    writeData(data);
    res.json({ success: true, isArchived: chat.isArchived });
});

// ---- Лента ----

app.get('/api/feed', authMiddleware, (req, res) => {
    const hours = parseInt(req.query.hours) || 24;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const data = readData();
    const channels = data.chats.filter(c => c.type === 'channel' && c.members.includes(req.userIun) && !c.isArchived);
    const channelIds = channels.map(c => c.id);
    const messages = data.messages.filter(m => channelIds.includes(m.chatId) && !m.deleted && new Date(m.timestamp) >= cutoff)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 50);
    const result = messages.map(msg => {
        const channel = channels.find(c => c.id === msg.chatId);
        return { id: msg.id, channelName: channel ? channel.name : 'Неизвестный канал', sender: msg.sender, text: msg.text, timestamp: msg.timestamp, chatId: msg.chatId };
    });
    res.json(result);
});

// ---- Экспорт/Импорт ----

app.get('/api/export/config', authMiddleware, (req, res) => {
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const config = { iun: user.iun, username: user.username, status: user.status, color: user.color, theme: user.theme, pinnedChats: user.pinnedChats, blocked: user.blocked, exportedAt: new Date().toISOString() };
    res.json(config);
});

app.post('/api/import/config', authMiddleware, (req, res) => {
    const { config } = req.body;
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'Неверный формат' });
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (config.username) user.username = config.username;
    if (config.status) user.status = config.status;
    if (config.color) user.color = config.color;
    if (config.theme) user.theme = config.theme;
    if (config.pinnedChats && Array.isArray(config.pinnedChats)) user.pinnedChats = config.pinnedChats.slice(0, 10);
    if (config.blocked && Array.isArray(config.blocked)) user.blocked = config.blocked;
    writeData(data);
    res.json({ success: true });
});

// ---- Режим бога ----

app.post('/api/admin/god', authMiddleware, (req, res) => {
    const { code } = req.body;
    if (code !== '52526767') return res.status(403).json({ error: 'Неверный код' });
    const godToken = jwt.sign({ iun: req.userIun, god: true }, JWT_SECRET, { expiresIn: '5m' });
    res.json({ success: true, token: godToken });
});

app.delete('/api/admin/chats/:iun', authMiddleware, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded.god) return res.status(403).json({ error: 'Требуется режим бога' });
    } catch { return res.status(401).json({ error: 'Неверный токен' }); }
    const { iun } = req.params;
    const data = readData();
    const chat = data.chats.find(c => c.name === iun);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    data.messages = data.messages.filter(m => m.chatId !== chat.id);
    data.chats = data.chats.filter(c => c.id !== chat.id);
    writeData(data);
    chat.members.forEach(iunMember => {
        const client = clients.get(iunMember);
        if (client && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'chatDeleted', payload: { chatId: chat.id } }));
    });
    res.json({ success: true, message: `Чат ${iun} удалён` });
});

// ---- Блокировка ----

app.post('/api/block', authMiddleware, (req, res) => {
    const { iun } = req.body;
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!user.blocked.includes(iun)) { user.blocked.push(iun); writeData(data); }
    res.json({ success: true, blocked: user.blocked });
});

app.post('/api/unblock', authMiddleware, (req, res) => {
    const { iun } = req.body;
    const data = readData();
    const user = data.users.find(u => u.iun === req.userIun);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    user.blocked = user.blocked.filter(b => b !== iun);
    writeData(data);
    res.json({ success: true, blocked: user.blocked });
});

// ---- Корень ----

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== ЗАПУСК =====

server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📡 WebSocket на ws://localhost:${PORT}`);
    console.log(`📦 Данные хранятся в ${DATA_FILE}`);
    console.log(`🔑 Режим бога: код 52526767`);
});
