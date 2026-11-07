const { MongoClient } = require('mongodb');

// Укажи свой MONGO_URI (можно взять из настроек Render или из .env)
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';

async function migrate() {
    console.log('⏳ Начинаю миграцию старых данных...');
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    
    const oldDb = client.db('krista'); // Твоя старая база
    const newDb = client.db('krista_v5'); // Новая база

    // 1. Переносим ФАЙЛЫ
    const oldFiles = await oldDb.collection('files').find({}).toArray();
    const fileIdMap = {}; // Связь старый ID -> новый ID
    
    for (const f of oldFiles) {
        fileIdMap[f._id] = f._id; // Оставляем те же ID
        await newDb.collection('files').updateOne(
            { _id: f._id },
            { $set: {
                tgFileId: f.tgFileId,
                name: f.name,
                mime: f.mime || 'application/octet-stream',
                size: f.size || 0,
                uploader: f.uploader,
                createdAt: new Date(f.uploadedAt || Date.now())
            }},
            { upsert: true }
        );
    }
    console.log(`✅ Файлы перенесены: ${oldFiles.length}`);

    // 2. Переносим ПОЛЬЗОВАТЕЛЕЙ
    const oldUsers = await oldDb.collection('users').find({}).toArray();
    for (const u of oldUsers) {
        let avatarUrl = null;
        if (u.avatarFileId && fileIdMap[u.avatarFileId]) {
            avatarUrl = `/api/file/${fileIdMap[u.avatarFileId]}`; // Ссылка на файл
        }

        // Старые ачивки были объектами, новые — массивом строк
        let achs = [];
        if (u.achievements && Array.isArray(u.achievements)) {
            achs = u.achievements.map(a => a.id).filter(Boolean);
        }

        await newDb.collection('users').updateOne(
            { _id: u._id },
            { $set: {
                login: u.login,
                password: u.password, // Хэш пароля сохраняется, старые пароли будут работать!
                nickname: u.nickname || u.login,
                theme: u.theme || 'sunset',
                accent: u.accentColor || '#ff7eb3',
                avatar: avatarUrl,
                frame: u.avatarFrame || 'none',
                achievements: achs,
                createdAt: new Date(u.createdAt || Date.now())
            }},
            { upsert: true }
        );
    }
    console.log(`✅ Пользователи перенесены: ${oldUsers.length}`);

    // 3. Переносим ЧАТЫ
    const oldChats = await oldDb.collection('chats').find({}).toArray();
    for (const c of oldChats) {
        let avatarUrl = null;
        if (c.avatarFileId && fileIdMap[c.avatarFileId]) {
            avatarUrl = `/api/file/${fileIdMap[c.avatarFileId]}`;
        }
        
        await newDb.collection('chats').updateOne(
            { _id: c._id },
            { $set: {
                type: c.type || 'dialog',
                name: c.name,
                login: c.login,
                isChannel: !!c.isChannel,
                members: c.members,
                owner: c.owner,
                avatar: avatarUrl,
                lastMessage: c.lastMessage ? {
                    text: c.lastMessage.text || (c.lastMessage.fileId ? '📎 Файл' : ''),
                    sender: c.lastMessage.sender,
                    timestamp: new Date(c.lastMessage.timestamp)
                } : null,
                updatedAt: new Date(c.updatedAt || Date.now())
            }},
            { upsert: true }
        );
    }
    console.log(`✅ Чаты перенесены: ${oldChats.length}`);

    // 4. Переносим СООБЩЕНИЯ
    const oldMessages = await oldDb.collection('messages').find({}).toArray();
    for (const m of oldMessages) {
        // Реакции раньше хранились в поле logins, теперь в users
        let rxs = [];
        if (m.reactions && Array.isArray(m.reactions)) {
            rxs = m.reactions.map(r => ({ emoji: r.emoji, users: r.logins || [] }));
        }

        await newDb.collection('messages').updateOne(
            { _id: m._id },
            { $set: {
                clientId: m.clientId || null,
                chatId: m.chatId,
                sender: m.sender,
                text: m.text || '',
                fileId: m.fileId || null,
                timestamp: new Date(m.timestamp),
                reactions: rxs,
                readBy: m.readBy || [],
                deleted: !!m.deleted
            }},
            { upsert: true }
        );
    }
    console.log(`✅ Сообщения перенесены: ${oldMessages.length}`);

    console.log('🎉 МИГРАЦИЯ УСПЕШНО ЗАВЕРШЕНА! Теперь можно запускать сервер.');
    await client.close();
}

migrate().catch(e => console.error('Ошибка миграции:', e));
