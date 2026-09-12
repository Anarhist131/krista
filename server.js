// КРИСТА.МЕССЕНДЖЕР v0.17 — СЕРВЕР
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_me';
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'krista';
const EDIT_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const LOGIN_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1000;

if (!MONGO_URI) { console.error('❌ MONGO_URI не задан.'); process.exit(1); }

let usersCol, chatsCol, messagesCol;
const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, socketTimeoutMS: 45000 });

async function connectDB() {
  let attempt = 0;
  while (attempt < 5) {
    try {
      attempt++;
      console.log(`🔌 MongoDB: попытка ${attempt}/5...`);
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      usersCol = db.collection('users');
      chatsCol = db.collection('chats');
      messagesCol = db.collection('messages');

      try {
        const userIndexes = await usersCol.indexes();
        for (const idx of userIndexes) {
          if (idx.name === 'uin_1' || idx.name === 'username_1') { await usersCol.dropIndex(idx.name); }
        }
        const chatIndexes = await chatsCol.indexes();
        for (const idx of chatIndexes) {
          if (idx.name === 'publicId_1') { await chatsCol.dropIndex(idx.name); }
        }
      } catch (e) {}

      try { await usersCol.createIndex({ login: 1 }, { unique: true, sparse: true }); } catch {}
      try { await chatsCol.createIndex({ login: 1 }, { unique: true, sparse: true }); } catch {}
      try { await chatsCol.createIndex({ members: 1 }); } catch {}
      try { await chatsCol.createIndex({ published: 1 }); } catch {}
      try { await messagesCol.createIndex({ chatId: 1, timestamp: 1 }); } catch {}

      console.log('✅ MongoDB подключена');
      try { await chatsCol.deleteOne({ _id: 'common_chat' }); } catch {}
      return;
    } catch (err) {
      console.error(`❌ ${err.message}`);
      if (attempt >= 5) process.exit(1);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const generateToken = (login) => jwt.sign({ login }, JWT_SECRET, { expiresIn: '30d' });
function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const STATUS_COLORS = { online: '#8ee0a8', away: '#ffd06a', dnd: '#ff8aa0', custom: '#a89ab0' };

function validateLogin(login) {
  if (typeof login !== 'string') return 'login_required';
  if (login.length < 3 || login.length > 32) return 'login_length';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) return 'login_format';
  return null;
}

function publicUser(doc) {
  if (!doc) return null;
  return {
    login: doc.login, nickname: doc.nickname || doc.login,
    theme: doc.theme || 'dark',
    accentColor: doc.accentColor || '#f0a0c8',
    nicknameColor: doc.nicknameColor || '#f0a0c8',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#f0a0c8',
    status: doc.status || 'online', statusText: doc.statusText || '',
    statusColor: doc.statusColor || STATUS_COLORS.online,
    avatarType: doc.avatarType || 'initial', avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#f0a0c8',
    avatarShape: doc.avatarShape || 'circle',
    language: doc.language || 'ru',
    loginChangeableAt: doc.loginChangeableAt || null,
    createdAt: doc.createdAt, lastSeen: doc.lastSeen
  };
}
function publicUserShort(doc) {
  if (!doc) return null;
  return {
    login: doc.login, nickname: doc.nickname || doc.login,
    nicknameColor: doc.nicknameColor || '#f0a0c8',
    nicknameEmoji: doc.nicknameEmoji || '',
    nicknameEmojiColor: doc.nicknameEmojiColor || '#f0a0c8',
    status: doc.status || 'online', statusText: doc.statusText || '',
    statusColor: doc.statusColor || STATUS_COLORS.online,
    avatarType: doc.avatarType || 'initial', avatarEmoji: doc.avatarEmoji || '',
    avatarBgColor: doc.avatarBgColor || '#f0a0c8'
  };
}
function publicChat(doc) {
  if (!doc) return null;
  return {
    id: doc._id, type: doc.type || 'dialog',
    members: doc.members, admins: doc.admins || [],
    owner: doc.owner || null, name: doc.name || null, login: doc.login || null,
    isPrivate: !!doc.isPrivate, isChannel: !!doc.isChannel,
    published: !!doc.published,
    updatedAt: doc.updatedAt
  };
}
function publicMessage(doc) {
  if (!doc) return null;
  return {
    id: doc._id, clientId: doc.clientId || null, chatId: doc.chatId,
    sender: doc.sender, senderName: doc.senderName, text: doc.text,
    timestamp: doc.timestamp, replyTo: doc.replyTo || null,
    deleted: doc.deleted ? 1 : 0, editedAt: doc.editedAt || null,
    reactions: doc.reactions || []
  };
}

const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'auth_required' });
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) return res.status(401).json({ error: 'auth_invalid' });
  req.userLogin = decoded.login;
  next();
}

// AUTH
app.post('/api/register', async (req, res) => {
  try {
    const { login, nickname, password, confirmPassword, language } = req.body || {};
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    if (!nickname || nickname.length < 1 || nickname.length > 30) return res.status(400).json({ error: 'nickname_length' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'password_short' });
    if (confirmPassword !== undefined && password !== confirmPassword) return res.status(400).json({ error: 'passwords_mismatch' });
    const existing = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (existing) return res.status(400).json({ error: 'login_taken' });
    const chatDup = await chatsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (chatDup) return res.status(400).json({ error: 'login_taken_chat' });
    const hashed = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    const doc = {
      login, password: hashed, nickname: nickname.trim(),
      theme: 'dark', accentColor: '#f0a0c8',
      nicknameColor: '#f0a0c8',
      nicknameEmoji: '', nicknameEmojiColor: '#f0a0c8',
      status: 'online', statusText: '', statusColor: STATUS_COLORS.online,
      avatarType: 'initial', avatarEmoji: '', avatarBgColor: '#f0a0c8',
      avatarShape: 'circle',
      loginChangeableAt: null, language: language || 'ru',
      createdAt: now, lastSeen: now
    };
    await usersCol.insertOne(doc);
    const token = generateToken(login);
    res.status(201).json({ success: true, login, nickname: doc.nickname, token });
  } catch (err) { console.error('Register:', err); res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body || {};
    if (!login || !password) return res.status(400).json({ error: 'fill_all' });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(login)) return res.status(400).json({ error: 'login_format' });
    const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'wrong_password' });
    await usersCol.updateOne({ login: user.login }, { $set: { lastSeen: new Date().toISOString() } });
    const token = generateToken(user.login);
    res.json({ success: true, login: user.login, nickname: user.nickname, token });
  } catch (err) { console.error('Login:', err); res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json(publicUser(user));
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const user = await usersCol.findOne({ login: req.userLogin });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const updates = {};
    let newLogin = null;

    if (b.newLogin !== undefined && b.newLogin !== user.login) {
      const loginErr = validateLogin(b.newLogin);
      if (loginErr) return res.status(400).json({ error: loginErr });
      if (user.loginChangeableAt) {
        const next = new Date(user.loginChangeableAt).getTime();
        if (Date.now() < next) return res.status(429).json({ error: 'login_cooldown', hours: Math.ceil((next - Date.now()) / 3600000) });
      }
      const dup = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(b.newLogin) + '$', 'i') } });
      if (dup) return res.status(400).json({ error: 'login_taken' });
      const chatDup = await chatsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(b.newLogin) + '$', 'i') } });
      if (chatDup) return res.status(400).json({ error: 'login_taken_chat' });
      newLogin = b.newLogin;
      updates.login = b.newLogin;
      updates.loginChangeableAt = new Date(Date.now() + LOGIN_CHANGE_COOLDOWN_MS).toISOString();
    }

    if (b.nickname !== undefined) {
      if (b.nickname.length < 1 || b.nickname.length > 30) return res.status(400).json({ error: 'nickname_length' });
      updates.nickname = b.nickname.trim();
    }
    if (b.newPassword) {
      if (!b.password) return res.status(400).json({ error: 'enter_password' });
      if (!(await bcrypt.compare(b.password, user.password))) return res.status(401).json({ error: 'wrong_password' });
      if (b.newPassword.length < 6) return res.status(400).json({ error: 'password_short' });
      updates.password = await bcrypt.hash(b.newPassword, 10);
    }
    if (b.theme !== undefined) {
      const allowed = ['dark', 'light'];
      if (!allowed.includes(b.theme)) return res.status(400).json({ error: 'invalid_theme' });
      updates.theme = b.theme;
    }
    if (b.accentColor !== undefined) updates.accentColor = String(b.accentColor).slice(0, 20);
    if (b.language !== undefined) {
      const allowed = ['ru', 'en'];
      if (!allowed.includes(b.language)) return res.status(400).json({ error: 'invalid_language' });
      updates.language = b.language;
    }
    if (b.nicknameColor !== undefined) updates.nicknameColor = String(b.nicknameColor).slice(0, 20);
    if (b.nicknameEmoji !== undefined) updates.nicknameEmoji = String(b.nicknameEmoji).slice(0, 8);
    if (b.nicknameEmojiColor !== undefined) updates.nicknameEmojiColor = String(b.nicknameEmojiColor).slice(0, 20);
    if (b.status !== undefined) {
      const allowed = ['online', 'away', 'dnd', 'custom'];
      if (!allowed.includes(b.status)) return res.status(400).json({ error: 'invalid_status' });
      updates.status = b.status;
      if (b.status !== 'custom') updates.statusColor = STATUS_COLORS[b.status];
    }
    if (b.statusText !== undefined) updates.statusText = String(b.statusText).slice(0, 60);
    if (b.statusColor !== undefined) updates.statusColor = String(b.statusColor).slice(0, 20);
    if (b.avatarType !== undefined) {
      if (!['initial', 'emoji'].includes(b.avatarType)) return res.status(400).json({ error: 'invalid_avatar' });
      updates.avatarType = b.avatarType;
    }
    if (b.avatarEmoji !== undefined) updates.avatarEmoji = String(b.avatarEmoji).slice(0, 8);
    if (b.avatarBgColor !== undefined) updates.avatarBgColor = String(b.avatarBgColor).slice(0, 20);
    if (b.avatarShape !== undefined) {
      if (!['circle', 'rounded'].includes(b.avatarShape)) return res.status(400).json({ error: 'invalid_shape' });
      updates.avatarShape = b.avatarShape;
    }

    if (Object.keys(updates).length === 0) return res.json({ success: true });
    await usersCol.updateOne({ login: req.userLogin }, { $set: updates });

    if (newLogin) {
      const oldLogin = req.userLogin;
      await chatsCol.updateMany({ members: oldLogin }, { $set: { 'members.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await chatsCol.updateMany({ admins: oldLogin }, { $set: { 'admins.$[el]': newLogin } }, { arrayFilters: [{ el: oldLogin }] });
      await chatsCol.updateMany({ owner: oldLogin }, { $set: { owner: newLogin } });
      await messagesCol.updateMany({ sender: oldLogin }, { $set: { sender: newLogin } });
      const newToken = generateToken(newLogin);
      req.userLogin = newLogin;
      const fresh = await usersCol.findOne({ login: newLogin });
      broadcast({ type: 'userUpdated', payload: publicUserShort(fresh) });
      return res.json({ success: true, newLogin, newToken });
    }

    const fresh = await usersCol.findOne({ login: req.userLogin });
    broadcast({ type: 'userUpdated', payload: publicUserShort(fresh) });
    res.json({ success: true });
  } catch (err) { console.error('Update me:', err); res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/me', authMiddleware, async (req, res) => {
  try {
    const login = req.userLogin;
    const chats = await chatsCol.find({ members: login }).toArray();
    for (const chat of chats) {
      if (chat.type === 'group' && chat.owner === login) {
        await messagesCol.deleteMany({ chatId: chat._id });
        await chatsCol.deleteOne({ _id: chat._id });
      } else if (chat.type === 'group') {
        await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: login, admins: login } });
      } else {
        await messagesCol.deleteMany({ chatId: chat._id });
        await chatsCol.deleteOne({ _id: chat._id });
      }
    }
    await usersCol.deleteOne({ login });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

// USERS
app.get('/api/users/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'login_required' });
    const user = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json({ ...publicUserShort(user), online: clients.has(user.login) });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

// SEARCH
app.get('/api/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    if (q.length < 1) return res.json({ users: [], chats: [] });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await usersCol.find({ login: { $ne: req.userLogin }, $or: [{ login: regex }, { nickname: regex }] }).limit(15).toArray();
    const groups = await chatsCol.find({ type: 'group', $or: [{ login: regex }, { name: regex }] }).limit(15).toArray();
    res.json({
      users: users.map(publicUserShort),
      chats: groups.map(g => ({ id: g._id, login: g.login, name: g.name, membersCount: g.members.length, isPrivate: !!g.isPrivate, isMember: g.members.includes(req.userLogin) }))
    });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

// CATALOG — публичные чаты и каналы, топ по подписчикам
app.get('/api/catalog', authMiddleware, async (req, res) => {
  try {
    const list = await chatsCol.find({ type: 'group', published: true }).toArray();
    // сортировка по количеству участников (убывание)
    const sorted = list.sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0));
    res.json(sorted.map((g, i) => ({
      rank: i + 1,
      id: g._id, login: g.login, name: g.name,
      membersCount: g.members.length,
      isChannel: !!g.isChannel,
      isMember: g.members.includes(req.userLogin)
    })));
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/chats/find/:login', authMiddleware, async (req, res) => {
  try {
    const login = String(req.params.login || '').trim();
    if (!login) return res.status(400).json({ error: 'login_required' });
    const chat = await chatsCol.findOne({ type: 'group', login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (chat.isPrivate && !chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'private_chat' });
    res.json({ id: chat._id, login: chat.login, name: chat.name, membersCount: chat.members.length, isPrivate: !!chat.isPrivate, isChannel: !!chat.isChannel, isMember: chat.members.includes(req.userLogin), published: !!chat.published });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

// CHATS
app.get('/api/chats', authMiddleware, async (req, res) => {
  try {
    const me = await usersCol.findOne({ login: req.userLogin });
    if (!me) return res.status(404).json({ error: 'user_not_found' });
    const myChats = await chatsCol.find({ members: req.userLogin }).toArray();
    const result = [];
    for (const chat of myChats) {
      const isGroup = chat.type === 'group';
      let title, subtitle, otherLogin = null, otherUser = null;
      if (isGroup) {
        title = chat.name;
        subtitle = `${chat.members.length} участ.${chat.isChannel ? ' · канал' : ''} · @${chat.login}`;
      } else {
        otherLogin = chat.members.find(u => u !== req.userLogin);
        otherUser = otherLogin ? await usersCol.findOne({ login: otherLogin }) : null;
        title = otherUser?.nickname || otherUser?.login || '???';
        subtitle = otherUser ? (otherUser.statusText || statusLabel(otherUser.status)) : '—';
      }
      const lastMsg = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } }).sort({ timestamp: -1 }).limit(1).next();
      let unread = 0;
      if (me.lastSeen) unread = await messagesCol.countDocuments({ chatId: chat._id, sender: { $ne: req.userLogin }, timestamp: { $gt: me.lastSeen }, deleted: { $ne: true } });
      result.push({
        id: chat._id, type: chat.type || 'dialog', isGroup,
        isPrivate: !!chat.isPrivate, isChannel: !!chat.isChannel,
        published: !!chat.published,
        isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin,
        name: title, subtitle, login: chat.login || null, membersCount: chat.members.length,
        otherLogin, otherUser: otherUser ? publicUserShort(otherUser) : null,
        lastMessage: lastMsg ? publicMessage(lastMsg) : null,
        unreadCount: unread, updatedAt: chat.updatedAt,
        online: otherLogin ? clients.has(otherLogin) : false
      });
    }
    res.json(result);
  } catch (err) { console.error('Chats:', err); res.status(500).json({ error: 'server_error' }); }
});

function statusLabel(s) { return { online: 'status_online', away: 'status_away', dnd: 'status_dnd', custom: '' }[s] || 'status_online'; }

app.post('/api/chats', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login || typeof login !== 'string') return res.status(400).json({ error: 'login_invalid' });
    if (login.toLowerCase() === req.userLogin.toLowerCase()) return res.status(400).json({ error: 'cant_add_self' });
    const other = await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } });
    if (!other) return res.status(404).json({ error: 'user_not_found' });
    const existing = await chatsCol.findOne({ type: { $in: ['dialog', null] }, members: { $all: [req.userLogin, other.login], $size: 2 } });
    if (existing) return res.json({ success: true, chatId: existing._id, existing: true });
    const chatId = uuidv4();
    await chatsCol.insertOne({ _id: chatId, type: 'dialog', members: [req.userLogin, other.login], admins: [], owner: null, updatedAt: new Date().toISOString() });
    const c = clients.get(other.login);
    if (c && c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'chatCreated', payload: { chatId } }));
    res.status(201).json({ success: true, chatId });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/groups', authMiddleware, async (req, res) => {
  try {
    const { name, login, members, isPrivate, isChannel, published } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'name_length' });
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: 'chat_' + loginErr });
    if (await chatsCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'chat_login_taken' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'login_taken_user' });
    const arr = Array.isArray(members) ? members : [];
    const uniq = [...new Set(arr.filter(u => typeof u === 'string' && u.length > 0))];
    for (const u of uniq) {
      if (!(await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(u) + '$', 'i') } }))) return res.status(404).json({ error: 'user_not_found_in_list', login: u });
    }
    const chatId = uuidv4();
    const now = new Date().toISOString();
    const allMembers = [...new Set([req.userLogin, ...uniq])];
    await chatsCol.insertOne({ _id: chatId, type: 'group', name: name.trim(), login, members: allMembers, admins: [req.userLogin], owner: req.userLogin, isPrivate: !!isPrivate, isChannel: !!isChannel, published: !!published, updatedAt: now });
    const payload = JSON.stringify({ type: 'chatCreated', payload: { chatId } });
    allMembers.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(payload); });
    res.status(201).json({ success: true, chatId, login });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/chats/:chatId/join', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'not_group' });
    if (chat.members.includes(req.userLogin)) return res.json({ success: true, already: true });
    if (chat.isPrivate) return res.status(403).json({ error: 'private_chat' });
    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, login: req.userLogin } });
    [...chat.members, req.userLogin].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/chats/:chatId/leave', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (!chat.members.includes(req.userLogin)) return res.json({ success: true });
    if (chat.owner === req.userLogin) return res.status(400).json({ error: 'owner_cant_leave' });
    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: req.userLogin, admins: req.userLogin }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, login: req.userLogin } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/chats/:chatId', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'no_access' });
    if (chat.type === 'group' && chat.owner !== req.userLogin) return res.status(403).json({ error: 'owner_only' });
    await messagesCol.deleteMany({ chatId: chat._id });
    await chatsCol.deleteOne({ _id: chat._id });
    const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId: chat._id } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/chats/:chatId/info', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (!chat.members.includes(req.userLogin) && chat.isPrivate) return res.status(403).json({ error: 'no_access' });
    const membersInfo = [];
    for (const login of chat.members) {
      const u = await usersCol.findOne({ login });
      if (u) membersInfo.push({ ...publicUserShort(u), isAdmin: (chat.admins || []).includes(login), isOwner: chat.owner === login, online: clients.has(login) });
    }
    res.json({ ...publicChat(chat), membersInfo, isMember: chat.members.includes(req.userLogin), isAdmin: (chat.admins || []).includes(req.userLogin) || chat.owner === req.userLogin });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.put('/api/chats/:chatId/name', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || name.trim().length < 1 || name.trim().length > 60) return res.status(400).json({ error: 'name_length' });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'not_group' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'admin_only' });
    await chatsCol.updateOne({ _id: chat._id }, { $set: { name: name.trim(), updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'chatRenamed', payload: { chatId: chat._id, name: name.trim() } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.put('/api/chats/:chatId/login', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    const loginErr = validateLogin(login);
    if (loginErr) return res.status(400).json({ error: loginErr });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'not_group' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'admin_only' });
    if (await chatsCol.findOne({ _id: { $ne: chat._id }, login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'chat_login_taken' });
    if (await usersCol.findOne({ login: { $regex: new RegExp('^' + escapeRegex(login) + '$', 'i') } })) return res.status(400).json({ error: 'login_taken_user' });
    await chatsCol.updateOne({ _id: chat._id }, { $set: { login, updatedAt: new Date().toISOString() } });
    res.json({ success: true, login });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.put('/api/chats/:chatId/flags', authMiddleware, async (req, res) => {
  try {
    const { isPrivate, isChannel, published } = req.body || {};
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'not_group' });
    if (chat.owner !== req.userLogin) return res.status(403).json({ error: 'owner_only' });
    const up = { updatedAt: new Date().toISOString() };
    if (isPrivate !== undefined) up.isPrivate = !!isPrivate;
    if (isChannel !== undefined) up.isChannel = !!isChannel;
    if (published !== undefined) up.published = !!published;
    await chatsCol.updateOne({ _id: chat._id }, { $set: up });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.delete('/api/chats/:chatId/members/:login', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'not_group' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'admin_only' });
    const target = req.params.login;
    if (target === chat.owner) return res.status(400).json({ error: 'cant_kick_owner' });
    if (!chat.members.includes(target)) return res.status(404).json({ error: 'not_member' });
    await chatsCol.updateOne({ _id: chat._id }, { $pull: { members: target, admins: target }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberRemoved', payload: { chatId: chat._id, login: target } });
    chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/chats/:chatId/members', authMiddleware, async (req, res) => {
  try {
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ error: 'login_invalid' });
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (chat.type !== 'group') return res.status(400).json({ error: 'not_group' });
    if (!(chat.admins || []).includes(req.userLogin)) return res.status(403).json({ error: 'admin_only' });
    if (chat.members.includes(login)) return res.status(400).json({ error: 'already_member' });
    const user = await usersCol.findOne({ login });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    await chatsCol.updateOne({ _id: chat._id }, { $push: { members: login }, $set: { updatedAt: new Date().toISOString() } });
    const out = JSON.stringify({ type: 'memberAdded', payload: { chatId: chat._id, login, nickname: user.nickname } });
    [...chat.members, login].forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

// MESSAGES
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const chat = await chatsCol.findOne({ _id: req.params.chatId });
    if (!chat) return res.status(404).json({ error: 'chat_not_found' });
    if (!chat.members.includes(req.userLogin)) return res.status(403).json({ error: 'no_access' });
    const msgs = await messagesCol.find({ chatId: chat._id, deleted: { $ne: true } }).sort({ timestamp: 1 }).limit(500).toArray();
    await usersCol.updateOne({ login: req.userLogin }, { $set: { lastSeen: new Date().toISOString() } });
    res.json(msgs.map(publicMessage));
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.post('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  try {
    const { text, clientId, replyTo } = req.body || {};
    const result = await processNewMessage(req.params.chatId, req.userLogin, text, clientId, replyTo);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    res.status(201).json(result.message);
  } catch (err) { console.error('HTTP send:', err); res.status(500).json({ error: 'server_error' }); }
});

async function processNewMessage(chatId, senderLogin, text, clientId, replyTo) {
  if (!chatId || typeof text !== 'string') return { error: 'invalid_data', code: 400 };
  const trimmed = text.trim();
  if (!trimmed) return { error: 'empty', code: 400 };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { error: 'too_long', code: 400 };
  const chat = await chatsCol.findOne({ _id: chatId });
  if (!chat) return { error: 'chat_not_found', code: 404 };
  if (!chat.members.includes(senderLogin)) return { error: 'not_member', code: 403 };
  if (chat.isChannel && !(chat.admins || []).includes(senderLogin) && chat.owner !== senderLogin) return { error: 'channel_readonly', code: 403 };
  const user = await usersCol.findOne({ login: senderLogin });
  if (!user) return { error: 'user_not_found', code: 404 };
  const msgId = clientId || uuidv4();
  if (clientId) {
    const exists = await messagesCol.findOne({ _id: msgId });
    if (exists) return { message: publicMessage(exists), duplicate: true };
  }
  let validReply = null;
  if (replyTo) {
    const parent = await messagesCol.findOne({ _id: replyTo, chatId, deleted: { $ne: true } });
    if (parent) validReply = parent._id;
  }
  const timestamp = new Date().toISOString();
  const msgDoc = { _id: msgId, clientId: clientId || null, chatId, sender: senderLogin, senderName: user.nickname || user.login, text: trimmed, timestamp, replyTo: validReply, deleted: false, editedAt: null, reactions: [] };
  await messagesCol.insertOne(msgDoc);
  await chatsCol.updateOne({ _id: chatId }, { $set: { updatedAt: timestamp } });
  await usersCol.updateOne({ login: senderLogin }, { $set: { lastSeen: timestamp } });
  const publicMsg = publicMessage(msgDoc);
  const out = JSON.stringify({ type: 'newMessage', payload: publicMsg });
  chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
  return { message: publicMsg };
}

app.put('/api/messages/:id', authMiddleware, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'empty' });
    if (text.trim().length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: 'too_long' });
    const msg = await messagesCol.findOne({ _id: req.params.id });
    if (!msg || msg.deleted) return res.status(404).json({ error: 'not_found' });
    if (msg.sender !== req.userLogin) return res.status(403).json({ error: 'only_own' });
    const age = Date.now() - new Date(msg.timestamp).getTime();
    if (age > EDIT_WINDOW_MS) return res.status(403).json({ error: 'edit_expired' });
    const editedAt = new Date().toISOString();
    await messagesCol.updateOne({ _id: msg._id }, { $set: { text: text.trim(), editedAt } });
    const fresh = await messagesCol.findOne({ _id: msg._id });
    const chat = await chatsCol.findOne({ _id: msg.chatId });
    const out = JSON.stringify({ type: 'messageEdited', payload: publicMessage(fresh) });
    if (chat) chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'server_error' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// WEBSOCKET
const wss = new WebSocket.Server({ server });
const clients = new Map();
const wsRate = new Map();

function checkRate(login) {
  const now = Date.now();
  const cur = wsRate.get(login);
  if (!cur || now - cur.first > 3000) { wsRate.set(login, { count: 1, first: now }); return true; }
  if (cur.count >= 15) return false;
  cur.count++;
  return true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.login = null;
  ws.lastPong = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const { type, payload } = data;
    if (type === 'pong') { ws.lastPong = Date.now(); return; }
    if (type === 'auth') {
      const dec = verifyToken(payload?.token);
      if (!dec) { ws.close(); return; }
      const user = await usersCol.findOne({ login: dec.login });
      if (!user) { ws.close(); return; }
      ws.login = dec.login;
      clients.set(ws.login, ws);
      broadcast({ type: 'status', payload: { login: ws.login, status: 'online' } });
      ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } }));
      return;
    }
    if (!ws.login) return;
    if (!checkRate(ws.login)) { ws.send(JSON.stringify({ type: 'error', payload: 'rate_limit' })); return; }
    if (type === 'ping') { ws.send(JSON.stringify({ type: 'pong', payload: { t: Date.now() } })); return; }
    if (type === 'newMessage') {
      try {
        const { chatId, text, replyTo, clientId } = payload || {};
        const result = await processNewMessage(chatId, ws.login, text, clientId, replyTo);
        if (result.error) { ws.send(JSON.stringify({ type: 'error', payload: { clientId, error: result.error } })); return; }
        if (result.duplicate) ws.send(JSON.stringify({ type: 'messageAck', payload: { clientId, id: result.message.id } }));
      } catch (err) { console.error('WS newMessage:', err); }
      return;
    }
    if (type === 'editMessage') {
      try {
        const { messageId, text } = payload || {};
        if (!messageId || !text || !text.trim() || text.length > MAX_MESSAGE_LENGTH) return;
        const msg = await messagesCol.findOne({ _id: messageId });
        if (!msg || msg.deleted || msg.sender !== ws.login) return;
        if (Date.now() - new Date(msg.timestamp).getTime() > EDIT_WINDOW_MS) return;
        await messagesCol.updateOne({ _id: messageId }, { $set: { text: text.trim(), editedAt: new Date().toISOString() } });
        const fresh = await messagesCol.findOne({ _id: messageId });
        const chat = await chatsCol.findOne({ _id: msg.chatId });
        if (!chat) return;
        const out = JSON.stringify({ type: 'messageEdited', payload: publicMessage(fresh) });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }
    if (type === 'deleteMessage') {
      try {
        const { messageId } = payload || {};
        const msg = await messagesCol.findOne({ _id: messageId });
        if (!msg || msg.deleted) return;
        const chat = await chatsCol.findOne({ _id: msg.chatId });
        if (!chat) return;
        const isAuthor = msg.sender === ws.login;
        const isAdmin = chat.type === 'group' && ((chat.admins || []).includes(ws.login) || chat.owner === ws.login);
        if (!isAuthor && !isAdmin) return;
        await messagesCol.updateOne({ _id: messageId }, { $set: { deleted: true } });
        const out = JSON.stringify({ type: 'deleteMessage', payload: { messageId, chatId: msg.chatId } });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }
    if (type === 'toggleReaction') {
      try {
        const { messageId, emoji } = payload || {};
        if (!messageId || !emoji || emoji.length > 8) return;
        const msg = await messagesCol.findOne({ _id: messageId });
        if (!msg || msg.deleted) return;
        const chat = await chatsCol.findOne({ _id: msg.chatId });
        if (!chat || !chat.members.includes(ws.login)) return;
        const reactions = msg.reactions || [];
        const idx = reactions.findIndex(r => r.emoji === emoji);
        if (idx === -1) reactions.push({ emoji, logins: [ws.login] });
        else {
          const logins = reactions[idx].logins || [];
          if (logins.includes(ws.login)) {
            reactions[idx].logins = logins.filter(l => l !== ws.login);
            if (reactions[idx].logins.length === 0) reactions.splice(idx, 1);
          } else reactions[idx].logins.push(ws.login);
        }
        await messagesCol.updateOne({ _id: messageId }, { $set: { reactions } });
        const fresh = await messagesCol.findOne({ _id: messageId });
        const out = JSON.stringify({ type: 'messageReaction', payload: publicMessage(fresh) });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }
    if (type === 'typing') {
      try {
        const { chatId } = payload || {};
        if (!chatId) return;
        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.login)) return;
        const user = await usersCol.findOne({ login: ws.login }, { projection: { nickname: 1, login: 1 } });
        if (!user) return;
        const out = JSON.stringify({ type: 'typing', payload: { chatId, login: ws.login, nickname: user.nickname || user.login } });
        chat.members.forEach(u => { if (u === ws.login) return; const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }
    if (type === 'deleteChat') {
      try {
        const { chatId } = payload || {};
        const chat = await chatsCol.findOne({ _id: chatId });
        if (!chat || !chat.members.includes(ws.login)) return;
        if (chat.type === 'group' && chat.owner !== ws.login) return;
        await messagesCol.deleteMany({ chatId });
        await chatsCol.deleteOne({ _id: chatId });
        const out = JSON.stringify({ type: 'chatDeleted', payload: { chatId } });
        chat.members.forEach(u => { const c = clients.get(u); if (c && c.readyState === WebSocket.OPEN) c.send(out); });
      } catch (err) {}
      return;
    }
  });
  ws.on('close', () => {
    if (ws.login) {
      clients.delete(ws.login);
      broadcast({ type: 'status', payload: { login: ws.login, status: 'offline' } });
    }
  });
  ws.on('error', () => {});
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [, c] of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
}

setInterval(() => {
  const now = Date.now();
  for (const [login, ws] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (now - ws.lastPong > 60000) { try { ws.terminate(); } catch {} clients.delete(login); continue; }
    try { ws.send(JSON.stringify({ type: 'ping', payload: { t: now } })); } catch {}
  }
}, 20000);

setInterval(() => {
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🚀 Криста.Мессенджер v0.17 на порту ${PORT}`);
    console.log(`📦 MongoDB / ${DB_NAME}`);
  });
})();
