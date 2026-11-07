'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { MongoClient, ObjectId } = require('mongodb');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'krista-dev-secret-change-me';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'krista_v5';
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
const TG_CHAT_ID = (process.env.TG_CHAT_ID || '').trim();

const MAX_MSG_LEN = 2000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const ACHIEVEMENTS = {
    first_message: { icon: '🎯', name: 'Первое слово' },
    chatter_100: { icon: '💬', name: 'Болтун' },
    first_group: { icon: '👥', name: 'Создатель' },
    first_channel: { icon: '📡', name: 'Вещатель' },
    curator: { icon: '📎', name: 'Куратор' }
};

const mongoClient = new MongoClient(MONGO_URI);
let db, users, chats, messages, files, folders;
let tgBot = null;

async function connectDB() {
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    
    // Автоматическая миграция со старой базы
    try {
        const oldDb = mongoClient.db('krista');
        const oldUsers = await oldDb.collection('users').find({}).toArray();
        
        if (oldUsers.length > 0) {
            console.log('⏳ Найдены старые данные. Запускаю автоматическую миграцию...');
            
            // Перенос файлов
            const oldFiles = await oldDb.collection('files').find({}).toArray();
            for (const f of oldFiles) {
                await db.collection('files').updateOne({ _id: f._id }, { $set: {
                    tgFileId: f.tgFileId, name: f.name, mime: f.mime || 'application/octet-stream',
                    size: f.size || 0, uploader: f.uploader, createdAt: new Date(f.uploadedAt || Date.now())
                }}, { upsert: true });
            }

            // Перенос юзеров
            for (const u of oldUsers) {
                let avatarUrl = u.avatarFileId ? `/api/file/${u.avatarFileId}` : null;
                let achs = (u.achievements && Array.isArray(u.achievements)) ? u.achievements.map(a => a.id).filter(Boolean) : [];
                await db.collection('users').updateOne({ _id: u._id }, { $set: {
                    login: u.login, password: u.password, nickname: u.nickname || u.login,
                    theme: u.theme || 'sunset', accent: u.accentColor || '#ff7eb3',
                    avatar: avatarUrl, frame: u.avatarFrame || 'none', achievements: achs,
                    createdAt: new Date(u.createdAt || Date.now())
                }}, { upsert: true });
            }

            // Перенос чатов
            const oldChats = await oldDb.collection('chats').find({}).toArray();
            for (const c of oldChats) {
                let avatarUrl = c.avatarFileId ? `/api/file/${c.avatarFileId}` : null;
                await db.collection('chats').updateOne({ _id: c._id }, { $set: {
                    type: c.type || 'dialog', name: c.name, login: c.login, isChannel: !!c.isChannel,
                    members: c.members, owner: c.owner, avatar: avatarUrl,
                    lastMessage: c.lastMessage ? { text: c.lastMessage.text || '', sender: c.lastMessage.sender, timestamp: new Date(c.lastMessage.timestamp) } : null,
                    updatedAt: new Date(c.updatedAt || Date.now())
                }}, { upsert: true });
            }

            // Перенос сообщений
            const oldMessages = await oldDb.collection('messages').find({}).toArray();
            for (const m of oldMessages) {
                let rxs = (m.reactions && Array.isArray(m.reactions)) ? m.reactions.map(r => ({ emoji: r.emoji, users: r.logins || [] })) : [];
                await db.collection('messages').updateOne({ _id: m._id }, { $set: {
                    clientId: m.clientId || null, chatId: m.chatId, sender: m.sender,
                    text: m.text || '', fileId: m.fileId || null, timestamp: new Date(m.timestamp),
                    reactions: rxs, readBy: m.readBy || [], deleted: !!m.deleted
                }}, { upsert: true });
            }
            console.log('✅ Старые аккаунты и история успешно перенесены в новую базу!');
        }
    } catch (e) {
        console.log('Миграция не требуется или старая база пуста.');
    }

    users = db.collection('users');
    chats = db.collection('chats');
    messages = db.collection('messages');
    files = db.collection('files');
    folders = db.collection('folders');

    await users.createIndex({ login: 1 }, { unique: true });
    await chats.createIndex({ members: 1 });
    await chats.createIndex({ login: 1 }, { unique: true, sparse: true });
    await messages.createIndex({ chatId: 1, timestamp: -1 });
    await messages.createIndex({ chatId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $exists: true } } });
    await folders.createIndex({ owner: 1 });
    console.log('✅ База данных готова к работе');
}

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
    console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' });
});

// СТАРЫЕ ПРАВИЛА (Логин от 3, Пароль от 6)
const validateLogin = (l) => (!l || l.length < 3 || l.length > 32 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(l)) ? 'Логин: 3-32 символа (латиница)' : null;
const genAccess = (l) => jwt.sign({ login: l }, JWT_SECRET, { expiresIn: '1h' });
const genRefresh = (l) => jwt.sign({ login: l, type: 'refresh' }, JWT_SECRET, { expiresIn: '30d' });
const sanitize = (s) => String(s || '').replace(/[<>]/g, '');

async function unlockAch(login, achId) {
    if (!ACHIEVEMENTS[achId]) return;
    const user = await users.findOne({ login });
    if (!user || (user.achievements || []).includes(achId)) return;
    await users.updateOne({ login }, { $push: { achievements: achId } });
    sendToUser(login, { type: 'achievement', id: achId, meta: ACHIEVEMENTS[achId] });
}

if (TG_BOT_TOKEN && TG_CHAT_ID) {
    tgBot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
    tgBot.on('polling_error', () => {});
}

const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

async function authMw(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Нет токена' });
    try {
        const dec = jwt.verify(auth.split(' ')[1], JWT_SECRET);
        const user = await users.findOne({ login: dec.login });
        if (!user) throw new Error();
        req.user = user; next();
    } catch { return res.status(401).json({ error: 'Токен истек' }); }
}

app.post('/api/register', h(async (req, res) => {
    const { login, nickname, password } = req.body;
    const err = validateLogin(login);
    if (err) return res.status(400).json({ error: err });
    if (!nickname || password.length < 6) return res.status(400).json({ error: 'Пароль от 6 символов' });
    if (await users.findOne({ login: { $regex: new RegExp(`^${login}$`, 'i') } })) return res.status(400).json({ error: 'Занят' });

    const hashed = await bcrypt.hash(password, 10);
    const newUser = { login, password: hashed, nickname: nickname.trim(), theme: 'sunset', accent: '#ff7eb3', avatar: null, frame: 'none', achievements: [], createdAt: new Date() };
    await users.insertOne(newUser);
    
    res.cookie('refreshToken', genRefresh(login), { httpOnly: true, sameSite: 'lax', maxAge: 30*24*60*60*1000 });
    res.json({ success: true, token: genAccess(login), user: { login, nickname, theme: 'sunset', accent: '#ff7eb3', achievements: [], avatar: null } });
}));

app.post('/api/login', h(async (req, res) => {
    const { login, password } = req.body;
    const user = await users.findOne({ login: { $regex: new RegExp(`^${login}$`, 'i') } });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверные данные' });
    
    res.cookie('refreshToken', genRefresh(user.login), { httpOnly: true, sameSite: 'lax', maxAge: 30*24*60*60*1000 });
    res.json({ success: true, token: genAccess(user.login), user: { login: user.login, nickname: user.nickname, theme: user.theme, accent: user.accent, avatar: user.avatar, frame: user.frame, achievements: user.achievements || [] } });
}));

app.post('/api/refresh', h(async (req, res) => {
    const { refreshToken } = req.cookies;
    if (!refreshToken) return res.status(401).json({ error: 'Нет токена' });
    try {
        const dec = jwt.verify(refreshToken, JWT_SECRET);
        const user = await users.findOne({ login: dec.login });
        if (!user) throw new Error();
        res.json({ token: genAccess(user.login), user: { login: user.login, nickname: user.nickname, theme: user.theme, accent: user.accent, avatar: user.avatar, frame: user.frame, achievements: user.achievements || [] } });
    } catch { res.clearCookie('refreshToken'); res.status(401).json({ error: 'Сессия истекла' }); }
}));

app.post('/api/logout', (req, res) => { res.clearCookie('refreshToken'); res.json({ success: true }); });

app.put('/api/me', authMw, h(async (req, res) => {
    const { nickname, theme, accent, avatar, frame } = req.body;
    const up = {};
    if (nickname) up.nickname = sanitize(nickname).substring(0, 30);
    if (theme) up.theme = theme;
    if (accent) up.accent = accent;
    if (avatar !== undefined) up.avatar = avatar;
    if (frame) up.frame = frame;
    await users.updateOne({ login: req.user.login }, { $set: up });
    res.json({ success: true });
}));

app.get('/api/search', authMw, h(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ users: [], chats: [] });
    const regex = new RegExp(q, 'i');
    const foundUsers = await users.find({ login: regex, login: { $ne: req.user.login } }).limit(10).toArray();
    const foundChats = await chats.find({ type: 'group', name: regex }).limit(10).toArray();
    res.json({ 
        users: foundUsers.map(u => ({ login: u.login, nickname: u.nickname, avatar: u.avatar })),
        chats: foundChats.map(c => ({ id: c._id, name: c.name, login: c.login, members: c.members.length, isChannel: c.isChannel }))
    });
}));

app.get('/api/folders', authMw, h(async (req, res) => {
    let myFolders = await folders.find({ owner: req.user.login }).toArray();
    if (myFolders.length === 0) {
        const defaultFolders = [
            { _id: uuidv4(), owner: req.user.login, name: 'Все чаты', icon: '💬', system: true, chatIds: [] },
            { _id: uuidv4(), owner: req.user.login, name: 'Непрочитанные', icon: '🔴', system: true, filter: 'unread', chatIds: [] }
        ];
        await folders.insertMany(defaultFolders);
        myFolders = defaultFolders;
    }
    res.json(myFolders);
}));

app.post('/api/folders', authMw, h(async (req, res) => {
    const { name, icon } = req.body;
    const newFolder = { _id: uuidv4(), owner: req.user.login, name: sanitize(name), icon: icon || '📁', system: false, chatIds: [] };
    await folders.insertOne(newFolder);
    res.json(newFolder);
}));

app.post('/api/folders/:id/chats', authMw, h(async (req, res) => {
    await folders.updateOne({ _id: req.params.id, owner: req.user.login }, { $addToSet: { chatIds: req.body.chatId } });
    res.json({ success: true });
}));

app.get('/api/chats', authMw, h(async (req, res) => {
    const myChats = await chats.find({ members: req.user.login }).toArray();
    const unreadCounts = await messages.aggregate([
        { $match: { chatId: { $in: myChats.map(c => c._id) }, sender: { $ne: req.user.login }, deleted: false, readBy: { $ne: req.user.login } } },
        { $group: { _id: '$chatId', count: { $sum: 1 } } }
    ]).toArray();
    const unreadMap = {};
    unreadCounts.forEach(x => { unreadMap[x._id] = x.count; });

    const result = myChats.map(c => {
        let title = c.name;
        if (c.type === 'dialog') title = c.members.find(m => m !== req.user.login);
        return {
            id: c._id, type: c.type, name: title, login: c.login, avatar: c.avatar, isChannel: c.isChannel,
            membersCount: c.members.length, lastMessage: c.lastMessage, unreadCount: unreadMap[c._id] || 0, updatedAt: c.updatedAt || 0
        };
    });
    result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(result);
}));

app.post('/api/chats', authMw, h(async (req, res) => {
    const target = await users.findOne({ login: req.body.targetLogin });
    if (!target) return res.status(404).json({ error: 'Не найден' });
    const existing = await chats.findOne({ type: 'dialog', members: { $all: [req.user.login, target.login] } });
    if (existing) return res.json({ chatId: existing._id });

    const chatId = uuidv4();
    await chats.insertOne({ _id: chatId, type: 'dialog', members: [req.user.login, target.login], updatedAt: new Date() });
    sendToUser(target.login, { type: 'chatCreated' });
    res.json({ chatId });
}));

app.post('/api/groups', authMw, h(async (req, res) => {
    const { name, login, isChannel } = req.body;
    if (await chats.findOne({ login })) return res.status(400).json({ error: 'Логин занят' });
    const chatId = uuidv4();
    await chats.insertOne({ _id: chatId, type: 'group', name: sanitize(name), login, isChannel: !!isChannel, members: [req.user.login], owner: req.user.login, updatedAt: new Date() });
    if (isChannel) unlockAch(req.user.login, 'first_channel'); else unlockAch(req.user.login, 'first_group');
    res.json({ chatId });
}));

app.get('/api/chats/:id/messages', authMw, h(async (req, res) => {
    const msgs = await messages.find({ chatId: req.params.id, deleted: false }).sort({ timestamp: -1 }).limit(100).toArray();
    msgs.reverse();
    await messages.updateMany({ chatId: req.params.id, sender: { $ne: req.user.login } }, { $addToSet: { readBy: req.user.login } });
    
    const fileIds = msgs.map(m => m.fileId).filter(Boolean);
    const fileDocs = await files.find({ _id: { $in: fileIds } }).toArray();
    const fileMap = {};
    fileDocs.forEach(f => fileMap[f._id] = { id: f._id, name: f.name, mime: f.mime, size: f.size });
    
    res.json(msgs.map(m => ({ ...m, file: m.fileId ? fileMap[m.fileId] : null })));
}));

app.put('/api/messages/:id', authMw, h(async (req, res) => {
    const msg = await messages.findOne({ _id: req.params.id, sender: req.user.login });
    if (!msg) return res.status(403).json({ error: 'Нет прав' });
    await messages.updateOne({ _id: msg._id }, { $set: { text: sanitize(req.body.text), editedAt: new Date() } });
    const chat = await chats.findOne({ _id: msg.chatId });
    chat.members.forEach(m => sendToUser(m, { type: 'messageEdited', id: msg._id, text: sanitize(req.body.text) }));
    res.json({ success: true });
}));

app.delete('/api/messages/:id', authMw, h(async (req, res) => {
    const msg = await messages.findOne({ _id: req.params.id, sender: req.user.login });
    if (msg) {
        await messages.updateOne({ _id: msg._id }, { $set: { deleted: true } });
        const chat = await chats.findOne({ _id: msg.chatId });
        chat.members.forEach(m => sendToUser(m, { type: 'messageDeleted', id: msg._id }));
    }
    res.json({ success: true });
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });
app.post('/api/upload', authMw, upload.single('file'), h(async (req, res) => {
    if (!req.file || !tgBot) return res.status(400).json({ error: 'Ошибка' });
    const stream = Readable.from(req.file.buffer);
    const tgMsg = await tgBot.sendDocument(TG_CHAT_ID, stream, {}, { filename: req.file.originalname, contentType: req.file.mimetype });
    const fileId = uuidv4();
    await files.insertOne({ _id: fileId, tgFileId: tgMsg.document.file_id, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size, uploader: req.user.login });
    res.json({ id: fileId, name: req.file.originalname, mime: req.file.mimetype, size: req.file.size });
}));

app.get('/api/file/:id', authMw, h(async (req, res) => {
    const file = await files.findOne({ _id: req.params.id });
    if (!file) return res.status(404).send();
    const url = await tgBot.getFileLink(file.tgFileId);
    const r = await fetch(url);
    res.setHeader('Content-Type', file.mime);
    Readable.fromWeb(r.body).pipe(res);
}));

const wss = new WebSocket.Server({ server });
const clients = new Map();
function sendToUser(login, data) {
    if (clients.has(login)) clients.get(login).forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); });
}

wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
        const { type, payload } = JSON.parse(raw);
        if (type === 'auth') {
            try {
                const dec = jwt.verify(payload.token, JWT_SECRET);
                ws.login = dec.login;
                if (!clients.has(ws.login)) clients.set(ws.login, new Set());
                clients.get(ws.login).add(ws);
                ws.send(JSON.stringify({ type: 'auth_ok' }));
                sendToUser(ws.login, { type: 'achievements', list: (await users.findOne({ login: ws.login })).achievements || [] });
            } catch { ws.close(); }
        }
        if (!ws.login) return;

        if (type === 'newMessage') {
            const { chatId, text, clientId, fileId } = payload;
            const msgId = uuidv4();
            
            let fileInfo = null;
            if (fileId) {
                const f = await files.findOne({ _id: fileId });
                if (f) fileInfo = { id: f._id, name: f.name, mime: f.mime, size: f.size };
            }
            
            const msg = { _id: msgId, clientId, chatId, sender: ws.login, text: sanitize(text || ''), fileId, file: fileInfo, timestamp: new Date(), reactions: [], readBy: [], deleted: false };
            await messages.insertOne(msg);
            await chats.updateOne({ _id: chatId }, { $set: { lastMessage: { text: msg.text || '📎 Файл', sender: ws.login, timestamp: msg.timestamp }, updatedAt: msg.timestamp } });
            
            const chat = await chats.findOne({ _id: chatId });
            chat.members.forEach(m => sendToUser(m, { type: 'newMessage', message: msg }));
            
            const msgCount = await messages.countDocuments({ sender: ws.login });
            if (msgCount === 1) unlockAch(ws.login, 'first_message');
            if (msgCount === 100) unlockAch(ws.login, 'chatter_100');
        }

        if (type === 'reaction') {
            const { msgId, emoji } = payload;
            const msg = await messages.findOne({ _id: msgId });
            if (msg) {
                let rxs = msg.reactions || [];
                let idx = rxs.findIndex(r => r.emoji === emoji);
                if (idx !== -1) {
                    if (rxs[idx].users.includes(ws.login)) rxs[idx].users = rxs[idx].users.filter(u => u !== ws.login);
                    else rxs[idx].users.push(ws.login);
                    if (rxs[idx].users.length === 0) rxs.splice(idx, 1);
                } else rxs.push({ emoji, users: [ws.login] });
                await messages.updateOne({ _id: msgId }, { $set: { reactions: rxs } });
                const chat = await chats.findOne({ _id: msg.chatId });
                chat.members.forEach(m => sendToUser(m, { type: 'messageReaction', msgId, reactions: rxs }));
            }
        }
    });
    ws.on('close', () => { if (ws.login) clients.get(ws.login)?.delete(ws); });
});

process.on('SIGTERM', async () => { await mongoClient.close(); process.exit(0); });
(async () => { await connectDB(); server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`)); })();
