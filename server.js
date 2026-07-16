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

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'x7G9mK2pQ5wR8vZ4nL1hT6jY3cB0sW4eR7tY8uI0oP2lA9sD3fG5hJ7kL9zX5cV8bN4mQ2wE6rT9yU3';
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== Работа с JSON =====
function readData() {
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        const initial = { users: [], chats: [], messages: [], nextId: 1 };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ===== Вспомогательные =====
function generateUIN(data) {
    let uin;
    let exists = true;
    while (exists) {
        uin = String(Math.floor(10000000 + Math.random() * 90000000));
        exists = data.users.some(u => u.uin === uin);
    }
    return uin;
}

async function hashPassword(pw) { return await bcrypt.hash(pw, 10); }
async function verifyPassword(pw, hash) { return await bcrypt.compare(pw, hash); }
function generateToken(uin) { return jwt.sign({ uin }, JWT_SECRET, { expiresIn: '30d' }); }

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userUin = decoded.uin;
        next();
    } catch {
        return res.status(401).json({ error: 'Неверный токен' });
    }
}

// ===== WebSocket =====
const clients = new Map();

wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const { type, payload } = data;

            if (type === 'auth') {
                const token = payload.token;
                try {
                    const decoded = jwt.verify(token, JWT_SECRET);
                    ws.uin = decoded.uin;
                    clients.set(ws.uin, ws);
                    broadcast({ type: 'status', payload: { uin: ws.uin, status: 'online' } });
                } catch {
                    ws.send(JSON.stringify({ type: 'error', payload: 'Неверный токен' }));
                }
            }

            if (type === 'newMessage') {
                const { chatId, text, sender } = payload;
                const dataFile = readData();
                const chat = dataFile.chats.find(c => c.id === chatId);
                if (!chat || !chat.members.includes(sender)) return;

                const user = dataFile.users.find(u => u.uin === sender);
                const senderName = user ? user.username : sender;

                const newMsg = {
                    id: String(dataFile.nextId++),
                    chatId,
                    sender,
                    senderName,
                    text,
                    timestamp: new Date().toISOString(),
                    isPinned: false,
                    deleted: false
                };
                dataFile.messages.push(newMsg);
                chat.updatedAt = new Date().toISOString();
                writeData(dataFile);

                const msgPayload = { type: 'newMessage', payload: newMsg };
                chat.members.forEach(uin => {
                    const client = clients.get(uin);
                    if (client && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(msgPayload));
                    }
                });
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
                if (!isAuthor && !isAdmin) return;
                msg.deleted = true;
                writeData(dataFile);
                chat.members.forEach(uin => {
                    const client = clients.get(uin);
                    if (client && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'deleteMessage', payload: { messageId, chatId: msg.chatId } }));
                    }
                });
            }

        } catch (err) {
            console.error('WS error:', err);
        }
    });

    ws.on('close', () => {
        if (ws.uin) {
            clients.delete(ws.uin);
            broadcast({ type: 'status', payload: { uin: ws.uin, status: 'offline' } });
        }
    });
});

function broadcast(data) {
    const msg = JSON.stringify(data);
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

// ===== API =====

// Регистрация
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });
        const data = readData();
        const uin = generateUIN(data);
        const hashed = await hashPassword(password);
        data.users.push({
            uin,
            username,
            password: hashed,
            color: '#b33a3a',
            theme: 'dark-red',
            pinnedChats: [],
            createdAt: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        });
        writeData(data);
        const token = generateToken(uin);
        res.status(201).json({ success: true, uin, username, token });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка регистрации' });
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    try {
        const { uin, password } = req.body;
        const data = readData();
        const user = data.users.find(u => u.uin === uin);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        const valid = await verifyPassword(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
        user.lastSeen = new Date().toISOString();
        writeData(data);
        const token = generateToken(uin);
        res.json({ success: true, uin: user.uin, username: user.username, token });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка входа' });
    }
});

// Получить профиль
app.get('/api/me', authMiddleware, (req, res) => {
    const data = readData();
    const user = data.users.find(u => u.uin === req.userUin);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const { password, ...safeUser } = user;
    res.json(safeUser);
});

// Обновить профиль
app.put('/api/me', authMiddleware, (req, res) => {
    const { username, color, theme } = req.body;
    const data = readData();
    const user = data.users.find(u => u.uin === req.userUin);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (username) user.username = username;
    if (color) user.color = color;
    if (theme) user.theme = theme;
    writeData(data);
    res.json({ success: true });
});

// Поиск пользователей
app.get('/api/search', authMiddleware, (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const data = readData();
    const users = data.users.filter(u =>
        u.uin.includes(q) || u.username.toLowerCase().includes(q.toLowerCase())
    ).slice(0, 20);
    res.json(users.map(u => ({ uin: u.uin, username: u.username, color: u.color })));
});

// Список чатов
app.get('/api/chats', authMiddleware, (req, res) => {
    const data = readData();
    const user = data.users.find(u => u.uin === req.userUin);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    let chats = data.chats.filter(c => c.members.includes(req.userUin));
    chats = chats.map(chat => {
        const messages = data.messages.filter(m => m.chatId === chat.id && !m.deleted);
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        const unreadCount = messages.filter(m => m.sender !== req.userUin && new Date(m.timestamp) > new Date(user.lastSeen)).length;
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

// Создать чат
app.post('/api/chats', authMiddleware, (req, res) => {
    const { type, name, members, admins, colorScheme, background } = req.body;
    if (!type || !['group', 'channel'].includes(type)) return res.status(400).json({ error: 'Неверный тип' });
    if (!name || name.trim() === '') return res.status(400).json({ error: 'Название обязательно' });
    if (!members || !Array.isArray(members) || members.length === 0) return res.status(400).json({ error: 'Нужны участники' });
    const data = readData();
    const newChat = {
        id: String(data.nextId++),
        type,
        name: name.trim(),
        members: members,
        admins: admins || [members[0]],
        owner: members[0],
        colorScheme: colorScheme || 'default',
        background: background || '',
        pinnedMessages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    data.chats.push(newChat);
    writeData(data);
    const chatPayload = { type: 'newChat', payload: newChat };
    newChat.members.forEach(uin => {
        const client = clients.get(uin);
        if (client && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(chatPayload));
    });
    res.status(201).json({ success: true, chatId: newChat.id });
});

// Получить сообщения чата
app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
    const { chatId } = req.params;
    const data = readData();
    const chat = data.chats.find(c => c.id === chatId);
    if (!chat || !chat.members.includes(req.userUin)) return res.status(403).json({ error: 'Нет доступа' });
    const messages = data.messages.filter(m => m.chatId === chatId && !m.deleted).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(messages);
});

// Закрепить чат
app.post('/api/chats/:chatId/pin', authMiddleware, (req, res) => {
    const { chatId } = req.params;
    const data = readData();
    const user = data.users.find(u => u.uin === req.userUin);
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

// Удалить чат (только владелец)
app.delete('/api/chats/:chatId', authMiddleware, (req, res) => {
    const { chatId } = req.params;
    const data = readData();
    const chat = data.chats.find(c => c.id === chatId);
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (chat.owner !== req.userUin) return res.status(403).json({ error: 'Только владелец может удалить чат' });
    // Удаляем все сообщения
    data.messages = data.messages.filter(m => m.chatId !== chatId);
    // Удаляем сам чат
    data.chats = data.chats.filter(c => c.id !== chatId);
    writeData(data);
    // Оповещаем участников
    chat.members.forEach(uin => {
        const client = clients.get(uin);
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'chatDeleted', payload: { chatId } }));
        }
    });
    res.json({ success: true });
});

// Удалить аккаунт (каскадно)
app.delete('/api/me', authMiddleware, (req, res) => {
    const data = readData();
    const userIndex = data.users.findIndex(u => u.uin === req.userUin);
    if (userIndex === -1) return res.status(404).json({ error: 'Пользователь не найден' });
    const user = data.users[userIndex];
    // Удаляем все чаты, где пользователь является владельцем
    const ownedChats = data.chats.filter(c => c.owner === user.uin);
    ownedChats.forEach(chat => {
        data.messages = data.messages.filter(m => m.chatId !== chat.id);
    });
    data.chats = data.chats.filter(c => c.owner !== user.uin);
    // Удаляем пользователя из остальных чатов
    data.chats.forEach(chat => {
        chat.members = chat.members.filter(m => m !== user.uin);
        chat.admins = chat.admins.filter(a => a !== user.uin);
        if (chat.members.length === 0) {
            // Если чат опустел — удаляем его
            data.chats = data.chats.filter(c => c.id !== chat.id);
            data.messages = data.messages.filter(m => m.chatId !== chat.id);
        }
    });
    // Удаляем сообщения пользователя в оставшихся чатах
    data.messages = data.messages.filter(m => m.sender !== user.uin);
    // Удаляем пользователя
    data.users.splice(userIndex, 1);
    writeData(data);
    res.json({ success: true });
});

// Корень
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📦 Данные в ${DATA_FILE}`);
});
