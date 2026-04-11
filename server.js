const { WebSocketServer } = require('ws');
const { MongoClient, ObjectId } = require('mongodb');

const uri = "mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/messenger?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let chatCollection, accountsCollection;

async function connectDB() {
    try {
        await client.connect();
        const db = client.db("messenger");
        chatCollection = db.collection("messages");
        accountsCollection = db.collection("accounts");
        
        // Создаем индексы
        await chatCollection.createIndex({ user: 1 });
        await chatCollection.createIndex({ to: 1 });
        await chatCollection.createIndex({ timestamp: 1 });
        
        console.log("✅ Сервер Nevkini: база подключена");
    } catch (e) { 
        console.error("❌ Ошибка базы:", e);
        setTimeout(connectDB, 5000);
    }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map(); // user -> { ws, avatar, fcmToken, connectionId }

let connectionCounter = 0;

wss.on('connection', (ws) => {
    let currentUser = null;
    let connectionId = ++connectionCounter;
    ws.isAlive = true;
    ws.connectionId = connectionId;
    
    ws.on('pong', () => { 
        ws.isAlive = true; 
    });

    ws.on('message', async (data) => {
        try {
            const raw = data.toString();
            if (raw === 'pong') return;
            
            const msg = JSON.parse(raw);
            console.log(`📨 [${connectionId}] Получено: ${msg.type} от ${msg.user || 'unknown'}`);

            // АВТОРИЗАЦИЯ
            if (msg.type === 'auth') {
                const { user, tag, avatar, fcmToken } = msg;
                
                // Проверяем, не подключен ли уже этот пользователь с другим сокетом
                const existingConnection = users.get(user);
                if (existingConnection && existingConnection.ws !== ws) {
                    console.log(`⚠️ Пользователь ${user} уже подключен, закрываем старое соединение ${existingConnection.connectionId}`);
                    try {
                        existingConnection.ws.close(1000, "Новое подключение");
                    } catch(e) {}
                    users.delete(user);
                }
                
                let account = await accountsCollection.findOne({ tag: tag });
                
                if (account) {
                    const oldNick = account.user;
                    const newNick = user;
                    
                    if (oldNick !== newNick) {
                        await chatCollection.updateMany(
                            { user: oldNick },
                            { $set: { user: newNick, avatar: avatar || account.avatar } }
                        );
                        await chatCollection.updateMany(
                            { to: oldNick },
                            { $set: { to: newNick } }
                        );
                        
                        await accountsCollection.updateOne(
                            { tag: tag },
                            { $set: { 
                                user: newNick, 
                                avatar: avatar || account.avatar, 
                                lastSeen: new Date(),
                                fcmToken: fcmToken || account.fcmToken
                            } }
                        );
                        
                        if (users.has(oldNick) && users.get(oldNick).ws !== ws) {
                            users.delete(oldNick);
                        }
                        
                        currentUser = newNick;
                    } else {
                        await accountsCollection.updateOne(
                            { tag: tag },
                            { $set: { 
                                avatar: avatar || account.avatar, 
                                lastSeen: new Date(),
                                fcmToken: fcmToken || account.fcmToken
                            } }
                        );
                        currentUser = user;
                    }
                } else {
                    await accountsCollection.insertOne({ 
                        user: user, 
                        tag: tag, 
                        avatar: avatar || "",
                        fcmToken: fcmToken || null,
                        lastSeen: new Date(),
                        createdAt: new Date()
                    });
                    currentUser = user;
                }
                
                // Сохраняем подключение
                users.set(currentUser, { 
                    ws, 
                    avatar: avatar || "", 
                    fcmToken,
                    connectionId: connectionId
                });
                
                // Загружаем историю
                const history = await chatCollection.find({
                    $or: [
                        { type: 'group' },
                        { user: currentUser },
                        { to: currentUser }
                    ]
                }).sort({ timestamp: 1 }).toArray();
                
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'history', data: history }));
                }
                
                // Отправляем список пользователей
                await sendUserList(ws);
                
                // Отправляем непрочитанные офлайн сообщения
                const undelivered = await chatCollection.find({
                    to: currentUser,
                    delivered: { $ne: true },
                    type: 'private'
                }).toArray();
                
                if (undelivered.length > 0 && ws.readyState === 1) {
                    console.log(`📦 Отправка ${undelivered.length} офлайн сообщений для ${currentUser}`);
                    for (const msg of undelivered) {
                        ws.send(JSON.stringify({ ...msg, _id: msg._id.toString() }));
                        await chatCollection.updateOne(
                            { _id: msg._id },
                            { $set: { delivered: true } }
                        );
                    }
                }
                
                broadcastOnlineList();
                console.log(`✅ [${connectionId}] ${currentUser} авторизован. Онлайн: ${users.size}`);
                return;
            }

            if (!currentUser) {
                console.log(`⚠️ Сообщение от неавторизованного соединения ${connectionId}`);
                return;
            }

            // Проверяем, что это актуальное соединение
            const userData = users.get(currentUser);
            if (userData && userData.connectionId !== connectionId) {
                console.log(`⚠️ Устаревшее сообщение от ${currentUser}, игнорируем`);
                return;
            }

            // ОТПРАВКА СООБЩЕНИЯ
            if (msg.type === 'group' || msg.type === 'private') {
                const session = users.get(currentUser);
                const now = new Date();
                
                const doc = { 
                    type: msg.type,
                    user: currentUser,
                    to: msg.to || (msg.type === 'group' ? 'Всем' : ''),
                    text: msg.text,
                    msgType: msg.msgType || 'text',
                    avatar: session ? session.avatar : "",
                    time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now(),
                    date: now.toISOString(),
                    isEdited: false,
                    delivered: false,
                    read: false
                };
                
                if (msg.replyTo) {
                    doc.replyTo = msg.replyTo;
                }
                
                const result = await chatCollection.insertOne(doc);
                const outMsg = JSON.stringify({ ...doc, _id: result.insertedId.toString() });
                
                if (msg.type === 'group') {
                    // Рассылаем всем, проверяя готовность соединения
                    let sentCount = 0;
                    for (const [user, data] of users) {
                        if (data.ws.readyState === 1) {
                            data.ws.send(outMsg);
                            sentCount++;
                        }
                    }
                    console.log(`📢 Групповое сообщение от ${currentUser} (отправлено ${sentCount} получателям)`);
                    
                    // Отправляем отправителю
                    if (ws.readyState === 1) {
                        ws.send(outMsg);
                    }
                } else {
                    // Приватное сообщение
                    const targetUser = users.get(msg.to);
                    
                    if (targetUser && targetUser.ws.readyState === 1) {
                        targetUser.ws.send(outMsg);
                        if (ws.readyState === 1) ws.send(outMsg);
                        await chatCollection.updateOne(
                            { _id: result.insertedId },
                            { $set: { delivered: true } }
                        );
                        console.log(`🔒 Приватное сообщение от ${currentUser} к ${msg.to} (доставлено онлайн)`);
                    } else {
                        if (ws.readyState === 1) ws.send(outMsg);
                        console.log(`💾 Приватное сообщение от ${currentUser} к ${msg.to} (сохранено офлайн)`);
                    }
                }
            }
            
            // ПЕЧАТАНИЕ
            else if (msg.type === 'typing') {
                if (msg.chatType === 'private' && msg.to && msg.to !== 'all') {
                    const target = users.get(msg.to);
                    if (target && target.ws.readyState === 1) {
                        target.ws.send(JSON.stringify({ 
                            type: 'typing', 
                            user: currentUser,
                            chatType: 'private'
                        }));
                    }
                } else if (msg.chatType === 'group') {
                    const typingMsg = JSON.stringify({ 
                        type: 'typing', 
                        user: currentUser,
                        chatType: 'group'
                    });
                    for (const [user, data] of users) {
                        if (user !== currentUser && data.ws.readyState === 1) {
                            data.ws.send(typingMsg);
                        }
                    }
                }
            }
            
            // УДАЛЕНИЕ
            else if (msg.type === 'delete') {
                try {
                    const result = await chatCollection.deleteOne({ 
                        _id: new ObjectId(msg.id), 
                        user: currentUser 
                    });
                    if (result.deletedCount > 0) {
                        const deleteMsg = JSON.stringify({ type: 'delete_confirm', id: msg.id });
                        for (const [user, data] of users) {
                            if (data.ws.readyState === 1) {
                                data.ws.send(deleteMsg);
                            }
                        }
                    }
                } catch(e) {}
            }
            
            // РЕДАКТИРОВАНИЕ
            else if (msg.type === 'edit') {
                try {
                    const result = await chatCollection.updateOne(
                        { _id: new ObjectId(msg.id), user: currentUser },
                        { $set: { text: msg.text, isEdited: true } }
                    );
                    if (result.modifiedCount > 0) {
                        const editMsg = JSON.stringify({ type: 'update', id: msg.id, text: msg.text });
                        for (const [user, data] of users) {
                            if (data.ws.readyState === 1) {
                                data.ws.send(editMsg);
                            }
                        }
                    }
                } catch(e) {}
            }
            
            // ОТМЕТКА О ПРОЧТЕНИИ
            else if (msg.type === 'read_all' && msg.target) {
                await chatCollection.updateMany(
                    { 
                        type: 'private', 
                        user: msg.target, 
                        to: currentUser, 
                        read: false 
                    },
                    { $set: { read: true } }
                );
                
                const target = users.get(msg.target);
                if (target && target.ws.readyState === 1) {
                    target.ws.send(JSON.stringify({ type: 'messages_read', by: currentUser }));
                }
            }
            
        } catch (e) {
            console.error("❌ Ошибка обработки:", e);
        }
    });
    
    ws.on('close', async (code, reason) => {
        console.log(`🔌 [${connectionId}] Соединение закрыто. Код: ${code}, Причина: ${reason || 'нет'}`);
        
        if (currentUser) {
            // Проверяем, что это именно то соединение, которое в мапе
            const userData = users.get(currentUser);
            if (userData && userData.connectionId === connectionId) {
                // Обновляем время последнего визита
                try {
                    await accountsCollection.updateOne(
                        { user: currentUser },
                        { $set: { lastSeen: new Date() } }
                    );
                } catch(e) {}
                
                users.delete(currentUser);
                broadcastOnlineList();
                console.log(`❌ ${currentUser} отключился. Онлайн: ${users.size}`);
            } else {
                console.log(`⚠️ Устаревшее закрытие соединения для ${currentUser}, игнорируем`);
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error(`❌ [${connectionId}] WebSocket ошибка:`, error.message);
    });
});

async function sendUserList(ws) {
    try {
        const allUsers = await accountsCollection.find({}).toArray();
        const userList = allUsers.map(user => ({
            user: user.user,
            avatar: user.avatar || "",
            isOnline: users.has(user.user),
            lastSeen: user.lastSeen
        }));
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'user_list', users: userList }));
        }
    } catch(e) {
        console.error("Ошибка отправки списка пользователей:", e);
    }
}

async function broadcastOnlineList() {
    try {
        const allUsers = await accountsCollection.find({}).toArray();
        const userList = allUsers.map(user => ({
            user: user.user,
            avatar: user.avatar || "",
            isOnline: users.has(user.user),
            lastSeen: user.lastSeen
        }));
        const message = JSON.stringify({ type: 'user_list', users: userList });
        
        for (const [user, data] of users) {
            if (data.ws.readyState === 1) {
                data.ws.send(message);
            }
        }
    } catch(e) {
        console.error("Ошибка рассылки списка пользователей:", e);
    }
}

// Пинг для поддержания соединения
const interval = setInterval(() => {
    for (const [user, data] of users) {
        if (!data.ws.isAlive) {
            console.log(`💀 ${user} не отвечает на пинг, закрываем соединение`);
            try {
                data.ws.terminate();
            } catch(e) {}
            users.delete(user);
            broadcastOnlineList();
        } else {
            data.ws.isAlive = false;
            try {
                data.ws.ping();
            } catch(e) {}
        }
    }
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

console.log(`🚀 Сервер запущен на порту ${process.env.PORT || 8080}`);