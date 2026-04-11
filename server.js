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
        await chatCollection.createIndex({ delivered: 1 });
        await chatCollection.createIndex({ read: 1 });
        
        console.log("✅ Сервер Nevkini: база подключена");
    } catch (e) { 
        console.error("❌ Ошибка базы:", e);
        setTimeout(connectDB, 5000);
    }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map(); // user -> { ws, avatar, lastSeen }

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const raw = data.toString();
            if (raw === 'pong') return;
            
            const msg = JSON.parse(raw);
            console.log(`📨 Получено: ${msg.type} от ${msg.user || 'unknown'}`);

            // АВТОРИЗАЦИЯ
            if (msg.type === 'auth') {
                const { user, tag, avatar } = msg;
                
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
                            { $set: { user: newNick, avatar: avatar || account.avatar, lastSeen: new Date() } }
                        );
                        
                        if (users.has(oldNick)) {
                            const oldWs = users.get(oldNick).ws;
                            if (oldWs !== ws) oldWs.close();
                            users.delete(oldNick);
                        }
                        
                        currentUser = newNick;
                    } else {
                        await accountsCollection.updateOne(
                            { tag: tag },
                            { $set: { avatar: avatar || account.avatar, lastSeen: new Date() } }
                        );
                        currentUser = user;
                    }
                } else {
                    await accountsCollection.insertOne({ 
                        user: user, 
                        tag: tag, 
                        avatar: avatar || "",
                        lastSeen: new Date(),
                        createdAt: new Date()
                    });
                    currentUser = user;
                }
                
                users.set(currentUser, { ws, avatar: avatar || "", lastSeen: new Date() });
                
                // Загружаем историю (все сообщения, не только 100)
                const history = await chatCollection.find({
                    $or: [
                        { type: 'group' },
                        { user: currentUser },
                        { to: currentUser }
                    ]
                }).sort({ timestamp: 1 }).toArray();
                
                ws.send(JSON.stringify({ type: 'history', data: history }));
                
                // Отправляем список пользователей с их статусами
                await sendUserList(ws);
                
                // Отправляем непрочитанные офлайн сообщения
                const undelivered = await chatCollection.find({
                    to: currentUser,
                    delivered: { $ne: true },
                    type: 'private'
                }).toArray();
                
                if (undelivered.length > 0) {
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
                console.log(`✅ ${currentUser} авторизован. Онлайн: ${users.size}`);
                return;
            }

            if (!currentUser) return;

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
                    broadcast(outMsg);
                    console.log(`📢 Групповое сообщение от ${currentUser}`);
                } else {
                    // Приватное сообщение
                    const targetUser = users.get(msg.to);
                    if (targetUser) {
                        // Если пользователь онлайн - отправляем сразу
                        targetUser.ws.send(outMsg);
                        ws.send(outMsg);
                        await chatCollection.updateOne(
                            { _id: result.insertedId },
                            { $set: { delivered: true } }
                        );
                        console.log(`🔒 Приватное сообщение от ${currentUser} к ${msg.to} (доставлено онлайн)`);
                    } else {
                        // Если офлайн - сохраняем в БД, доставим при подключении
                        ws.send(outMsg);
                        console.log(`💾 Приватное сообщение от ${currentUser} к ${msg.to} (сохранено офлайн)`);
                    }
                }
            }
            
            // ПОЛУЧЕНИЕ ОФЛАЙН СООБЩЕНИЙ
            else if (msg.type === 'get_offline') {
                const offlineMessages = await chatCollection.find({
                    to: currentUser,
                    delivered: { $ne: true },
                    type: 'private'
                }).toArray();
                
                for (const msg of offlineMessages) {
                    ws.send(JSON.stringify({ ...msg, _id: msg._id.toString() }));
                    await chatCollection.updateOne(
                        { _id: msg._id },
                        { $set: { delivered: true } }
                    );
                }
                console.log(`📦 Отправлено ${offlineMessages.length} офлайн сообщений для ${currentUser}`);
            }
            
            // УДАЛЕНИЕ
            else if (msg.type === 'delete') {
                const result = await chatCollection.deleteOne({ 
                    _id: new ObjectId(msg.id), 
                    user: currentUser 
                });
                if (result.deletedCount > 0) {
                    broadcast(JSON.stringify({ type: 'delete_confirm', id: msg.id }));
                }
            }
            
            // РЕДАКТИРОВАНИЕ
            else if (msg.type === 'edit') {
                const result = await chatCollection.updateOne(
                    { _id: new ObjectId(msg.id), user: currentUser },
                    { $set: { text: msg.text, isEdited: true } }
                );
                if (result.modifiedCount > 0) {
                    broadcast(JSON.stringify({ type: 'update', id: msg.id, text: msg.text }));
                }
            }
            
            // ПЕЧАТАНИЕ
            else if (msg.type === 'typing') {
                if (msg.chatType === 'private' && msg.to) {
                    const target = users.get(msg.to);
                    if (target) {
                        target.ws.send(JSON.stringify({ type: 'typing', user: currentUser }));
                    }
                } else if (msg.chatType === 'group') {
                    broadcast(JSON.stringify({ type: 'typing', user: currentUser }));
                }
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
                if (target) {
                    target.ws.send(JSON.stringify({ type: 'messages_read', by: currentUser }));
                }
            }
            
        } catch (e) {
            console.error("❌ Ошибка обработки:", e);
        }
    });
    
    ws.on('close', async () => { 
        if (currentUser) { 
            // Обновляем время последнего визита
            await accountsCollection.updateOne(
                { user: currentUser },
                { $set: { lastSeen: new Date() } }
            );
            
            users.delete(currentUser); 
            broadcastOnlineList();
            console.log(`❌ ${currentUser} отключился. Онлайн: ${users.size}`);
        }
    });
});

// Отправка списка пользователей с их статусами
async function sendUserList(ws) {
    const allUsers = await accountsCollection.find({}).toArray();
    const userList = allUsers.map(user => ({
        user: user.user,
        avatar: user.avatar,
        isOnline: users.has(user.user),
        lastSeen: user.lastSeen
    }));
    
    ws.send(JSON.stringify({ type: 'user_list', users: userList }));
}

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(data);
        }
    });
}

async function broadcastOnlineList() {
    const allUsers = await accountsCollection.find({}).toArray();
    const userList = allUsers.map(user => ({
        user: user.user,
        avatar: user.avatar,
        isOnline: users.has(user.user),
        lastSeen: user.lastSeen
    }));
    
    const message = JSON.stringify({ type: 'user_list', users: userList });
    broadcast(message);
}

// Пинг для поддержания соединения
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

console.log(`🚀 Сервер запущен на порту ${process.env.PORT || 8080}`);