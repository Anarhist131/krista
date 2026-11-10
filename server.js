// КРИСТА.NET · server.js v5.67
'use strict';
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_change_me';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'krista';
const LOGIN_COOLDOWN = 24 * 60 * 60 * 1000;
const MAX_MSG_LEN = 2000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
const BASE_URL = process.env.BASE_URL || 'https://krista-4.onrender.com';
const SUPPORT_TG = 'prikin_1';
const ALLOWED_THEMES = ['sunset', 'classic', 'oldschool', 'watermelon'];
const ALLOWED_FRAMES = ['none', 'devil', 'star', 'sparkle', 'vine', 'flower'];
const ALLOWED_REACTIONS = ['yahoo', 'victory', 'tongue', 'sarcasm', 'cray2', 'facepalm'];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERSION = '5.67';
const ADMIN_PASSWORD = '52526767';

const ACHIEVEMENTS = { /* Оставляем как было */ };

let usersCol, chatsCol, messagesCol, filesCol, countersCol, tgLinksCol, botSessionsCol, foldersCol, invitesCol, threadsCol, threadPostsCol;
const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000, socketTimeoutMS: 45000 });

const TG_CHAT_ID = (process.env.TG_CHAT_ID || '').trim();
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
let tgBot = null, botUsername = 'krista_bot';

if (TG_BOT_TOKEN && TG_CHAT_ID) {
  try {
    tgBot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
    tgBot.getMe().then(me => { botUsername = me.username; console.log(`Bot: @${me.username}`); }).catch(e => console.error('getMe:', e.message));
    tgBot.on('polling_error', e => {});
    tgBot.on('message', async msg => { try { if (msg.chat.type === 'private') await handleBotPrivateMessage(msg); } catch (e) {} });
    tgBot.on('callback_query', async cb => { try { await handleCallback(cb); } catch (e) { try { tgBot.answerCallbackQuery(cb.id); } catch {} } });
  } catch (e) { console.error('Telegram init:', e.message); }
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

async function connectDB() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await mongoClient.connect();
      const db = mongoClient.db(DB_NAME);
      usersCol = db.collection('users'); chatsCol = db.collection('chats'); messagesCol = db.collection('messages');
      filesCol = db.collection('files'); countersCol = db.collection('counters'); tgLinksCol = db.collection('tg_links');
      botSessionsCol = db.collection('bot_sessions'); foldersCol = db.collection('folders'); invitesCol = db.collection('invites');
      threadsCol = db.collection('threads'); threadPostsCol = db.collection('thread_posts');

      await usersCol.createIndex({ login: 1 }, { unique: true, sparse: true }).catch(() => {});
      await usersCol.createIndex({ tgChatId: 1 }, { sparse: true }).catch(() => {});
      await chatsCol.createIndex({ login: 1 }, { unique: true, sparse: true }).catch(() => {});
      await chatsCol.createIndex({ members: 1 }).catch(() => {});
      await messagesCol.createIndex({ chatId: 1, timestamp: 1 }).catch(() => {});
      await messagesCol.createIndex({ sender: 1 }).catch(() => {});
      await messagesCol.createIndex({ chatId: 1, readBy: 1 }).catch(() => {});
      await filesCol.createIndex({ uploader: 1 }).catch(() => {});
      await foldersCol.createIndex({ owner: 1 }).catch(() => {});
      await foldersCol.createIndex({ owner: 1, system: 1, filter: 1 }, { unique: true, partialFilterExpression: { system: true } }).catch(() => {});
      await tgLinksCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
      await botSessionsCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
      await invitesCol.createIndex({ code: 1 }, { unique: true, sparse: true }).catch(() => {});
      await invitesCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
      await threadsCol.createIndex({ createdAt: -1 }).catch(() => {});
      await threadPostsCol.createIndex({ threadId: 1, createdAt: 1 }).catch(() => {});

      console.log('MongoDB подключена');
      await migrate();
      return;
    } catch (err) { console.error(err.message); if (attempt >= 5) process.exit(1); await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function migrate() {
  try {
    const m565 = await countersCol.findOne({ _id: 'migrated_v565' });
    if (!m565) {
      await usersCol.updateMany({ badges: { $exists: false } }, { $set: { badges: [], chatWallpapers: {} } });
      await countersCol.updateOne({ _id: 'migrated_v565' }, { $set: { value: 1, date: new Date().toISOString() } }, { upsert: true });
      console.log('Миграция v5.65 завершена (Badges & Wallpapers)');
    }
  } catch (e) { console.error('Миграция:', e); }
}

const generateToken = (login, version = 0) => jwt.sign({ login, v: version }, JWT_SECRET, { expiresIn: '30d' });
const verifyToken = t => { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } };
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isValidClientId = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const validColor = v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const sanitizeStringArray = (arr, max = 500, len = 64) => Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.length > 0 && x.length <= len).slice(0, max) : null;
const sanitizeEmoji = v => typeof v === 'string' ? Array.from(v).slice(0, 8).join('').replace(/[<>&"']/g, '') : '';
const validFrame = v => ALLOWED_FRAMES.includes(v) ? v : 'none';
const moscowHour = () => (new Date().getUTCHours() + 3) % 24;

function validateLogin(login) {
  if (typeof login !== 'string') return 'Логин обязателен';
  if (login.length < 3 || login.length > 32) return 'Логин: 3-32 символа';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(login)) return 'Логин: только латиница, цифры, _ и -';
  return null;
}

async function nextNum() { /* Как было */ }
async function unlockAchievement(login, achId) { /* Как было */ }
async function recordLoginDay(login) { /* Как было */ }

function pubUser(doc) {
  if (!doc) return null;
  return {
    login: doc.login, nickname: doc.nickname || doc.login, accentColor: doc.accentColor || '#ff3b30',
    nicknameColor: doc.nicknameColor || '#ff3b30', nicknameEmoji: doc.nicknameEmoji || '',
    avatarFileId: doc.avatarFileId || null, avatarFrame: validFrame(doc.avatarFrame),
    loginChangeableAt: doc.loginChangeableAt || null, tgChatId: !!doc.tgChatId, theme: doc.theme || 'sunset',
    pinnedChats: doc.pinnedChats || [], archivedChats: doc.archivedChats || [], mutedChats: doc.mutedChats || {},
    searchHistory: doc.searchHistory || [], achievements: doc.achievements || [], badges: doc.badges || [],
    chatWallpapers: doc.chatWallpapers || {}, createdAt: doc.createdAt, lastSeen: doc.lastSeen
  };
}
function pubUserShort(doc) {
  if (!doc) return null;
  return { login: doc.login, nickname: doc.nickname || doc.login, nicknameColor: doc.nicknameColor || '#ff3b30', nicknameEmoji: doc.nicknameEmoji || '', avatarFileId: doc.avatarFileId || null, avatarFrame: validFrame(doc.avatarFrame), badges: doc.badges || [], online: isOnline(doc.login) };
}
const pubFile = f => f ? { id: f._id, name: f.name, size: f.size, mime: f.mime, kind: f.kind, purpose: f.purpose, uploadedAt: f.uploadedAt } : null;
function pubMessage(doc, filesMap, avatarMap) {
  if (!doc) return null;
  let file = null;
  if (doc.fileId && filesMap && filesMap[doc.fileId]) file = pubFile(filesMap[doc.fileId]);
  const s = (avatarMap && avatarMap[doc.sender]) || null;
  return {
    id: doc._id, clientId: doc.clientId || null, chatId: doc.chatId, sender: doc.sender, senderName: doc.senderName,
    senderAvatarFileId: s ? s.avatarFileId : null, senderNicknameColor: s ? s.nicknameColor : null, senderAvatarFrame: s ? validFrame(s.avatarFrame) : 'none',
    senderBadges: s ? (s.badges || []) : [], senderEmoji: doc.senderEmoji || '', type: doc.type || 'text', text: doc.text, file,
    reactions: doc.reactions || [], deliveredTo: doc.deliveredTo || [], readBy: doc.readBy || [], timestamp: doc.timestamp,
    editedAt: doc.editedAt || null, replyTo: doc.replyTo || null, forwardFrom: doc.forwardFrom || null, fromBot: !!doc.fromBot, deleted: doc.deleted ? 1 : 0
  };
}
async function getFilesMap(ids) { /* Как было */ }
async function getAvatarMap(logins) {
  const uniq = [...new Set(logins.filter(Boolean))];
  if (!uniq.length) return {};
  const users = await usersCol.find({ login: { $in: uniq } }).toArray();
  const map = {};
  users.forEach(u => { map[u.login] = { avatarFileId: u.avatarFileId || null, nicknameColor: u.nicknameColor || null, avatarFrame: validFrame(u.avatarFrame), badges: u.badges || [] }; });
  return map;
}
async function pubMessagesList(msgs) { /* Как было */ }
async function maybeDeleteFiles(fileIds) { /* Как было */ }
async function updateChatLastMessage(chatId) { /* Как было */ }

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, p) => { if (!p.endsWith('.html')) res.setHeader('Cache-Control', 'public, max-age=3600'); } }));

const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error('Handler:', req.method, req.path, e.message); if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' }); });
async function authMw(req, res, next) { /* Как было */ }
async function requireChatMember(req, res, next) { /* Как было */ }
function requireChatAdmin(req, res, next) { /* Как было */ }

// === AUTH ===
app.post('/api/auth/telegram', h(async (req, res) => {
  const { initData } = req.body || {};
  if (!initData) return res.status(400).json({ error: 'No initData' });
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');
  const dataCheckString = Array.from(urlParams.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TG_BOT_TOKEN).digest();
  const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (calcHash !== hash) return res.status(401).json({ error: 'Invalid hash' });
  const tgUser = JSON.parse(urlParams.get('user'));

  // Ищем юзера, к которому привязан этот TG
  let u = await usersCol.findOne({ tgChatId: tgUser.id.toString() });
  if (!u) {
    // Если не нашли, создаем нового
    let login = tgUser.username || 'tg_' + tgUser.id;
    if (await usersCol.findOne({ login })) login = 'tg_' + tgUser.id + '_' + Math.floor(Math.random()*1000);
    const now = new Date().toISOString();
    u = { login, password: '', nickname: tgUser.first_name || login, accentColor: '#ff3b30', nicknameColor: '#ff3b30', nicknameEmoji: '', avatarFileId: null, tgChatId: tgUser.id.toString(), loginChangeableAt: null, theme: 'sunset', pinnedChats: [], archivedChats: [], mutedChats: {}, searchHistory: [], achievements: [], badges: [], chatWallpapers: {}, loginDays: [now.slice(0, 10)], avatarFrame: 'none', tokenVersion: 0, createdAt: now, lastSeen: now };
    await usersCol.insertOne(u);
  }
  res.json({ success: true, login: u.login, nickname: u.nickname, token: generateToken(u.login, u.tokenVersion || 0) });
}));

// ... ОСТАЛЬНЫЕ ЭНДПОИНТЫ БЕЗ ИЗМЕНЕНИЙ (register, login, me, chats, messages, threads, ws) ...
// (Я их не вставляю сюда, чтобы не раздувать ответ, они остаются точно такими же, как в v5.65)

// === TELEGRAM BOT ===
app.post('/api/tg/link', authMw, h(async (req, res) => { /* Как было */ }));
app.post('/api/tg/unlink', authMw, h(async (req, res) => { /* Как было */ }));
function notifyChat(chat, senderLogin, msg) { /* Как было */ }
async function findUserByTg(chatId) { return await usersCol.findOne({ tgChatId: chatId.toString() }); }
async function getUserChatsForBot(user) { /* Как было */ }
async function sendMainMenu(chatId) { /* Как было */ }
async function sendChatsMenu(chatId, editMessageId) { /* Как было */ }
async function openChatInBot(chatId, targetChatId) { /* Как было */ }
async function cmdFind(chatId, login) { /* Как было */ }
async function cmdStats(chatId) { /* Как было */ }
async function executePost(chatId, channelId, login, text) { /* Как было */ }
async function handleBotFile(chatId, msg, user) { /* Как было */ }
async function handleCallback(cb) { /* Как было */ }
async function handleBotPrivateMessage(msg) { /* Как было, с учетом интерактивных команд /new, /find, /admin67 */ }

// ... THREADS, WS, INIT ...

(async () => {
  try {
    console.log('=== SERVER STARTING ===');
    await connectDB();
    console.log('DB connected, starting server...');
    server.listen(PORT, () => {
      console.log(`Криста.Net v${VERSION} · порт ${PORT}`);
      console.log(`Бот: @${botUsername}`);
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
})();
