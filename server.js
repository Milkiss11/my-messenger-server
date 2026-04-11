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
        console.log("✅ Сервер Nevkini: база подключена");
    } catch (e) { 
        console.error("❌ Ошибка базы:", e);
        setTimeout(connectDB, 5000);
    }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map();

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const raw = data.toString();
            if (raw === 'pong') return;
            
            const msg = JSON.parse(raw);
            console.log(`Получено: ${msg.type} от ${msg.user || 'unknown'}`);

            if (msg.type === 'auth') {
                const { user, tag, avatar } = msg;
                
                // Ищем аккаунт по тегу
                let account = await accountsCollection.findOne({ tag: tag });
                
                if (account) {
                    // Обновляем существующий аккаунт
                    await accountsCollection.updateOne(
                        { tag: tag }, 
                        { $set: { user: user, avatar: avatar, lastSeen: new Date() } }
                    );
                } else {
                    // Проверяем, не занят ли ник
                    const nameCheck = await accountsCollection.findOne({ user: user });
                    if (nameCheck) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Ник уже занят! Используйте другой тег или ник' }));
                        return;
                    }
                    await accountsCollection.insertOne({ 
                        user: user, 
                        tag: tag, 
                        avatar: avatar || "",
                        createdAt: new Date()
                    });
                }
                
                currentUser = user;
                users.set(currentUser, { ws, avatar: avatar || "" });
                
                // Загружаем историю сообщений
                const history = await chatCollection.find({
                    $or: [
                        { type: 'group' },
                        { user: currentUser },
                        { to: currentUser }
                    ]
                }).sort({ timestamp: 1 }).limit(100).toArray();
                
                ws.send(JSON.stringify({ type: 'history', data: history }));
                broadcastOnlineList();
                console.log(`✅ ${currentUser} авторизован. Онлайн: ${users.size}`);
                return;
            }

            if (!currentUser) return;

            // Обработка сообщений
            if (msg.type === 'group' || msg.type === 'private') {
                const session = users.get(currentUser);
                const doc = { 
                    ...msg,
                    user: currentUser,
                    avatar: session ? session.avatar : "",
                    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now(),
                    isEdited: false,
                    read: false
                };
                
                const result = await chatCollection.insertOne(doc);
                const outMsg = JSON.stringify({ ...doc, _id: result.insertedId.toString() });
                
                if (msg.type === 'group') {
                    // Рассылаем всем
                    broadcast(outMsg);
                } else {
                    // Приватное сообщение - отправляем обоим участникам
                    const target = users.get(msg.to);
                    if (target) target.ws.send(outMsg);
                    ws.send(outMsg);
                }
                console.log(`📨 Сообщение от ${currentUser} в ${msg.type}`);
            }
            
            // Удаление сообщения
            else if (msg.type === 'delete') {
                const result = await chatCollection.deleteOne({ 
                    _id: new ObjectId(msg.id), 
                    user: currentUser 
                });
                if (result.deletedCount > 0) {
                    broadcast(JSON.stringify({ type: 'delete_confirm', id: msg.id }));
                }
            }
            
            // Редактирование
            else if (msg.type === 'edit') {
                const result = await chatCollection.updateOne(
                    { _id: new ObjectId(msg.id), user: currentUser },
                    { $set: { text: msg.text, isEdited: true } }
                );
                if (result.modifiedCount > 0) {
                    broadcast(JSON.stringify({ type: 'update', id: msg.id, text: msg.text }));
                }
            }
            
            // Статус печатания
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
            
            // Отметить прочитанными
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
            console.error("Ошибка обработки:", e);
        }
    });
    
    ws.on('close', () => { 
        if (currentUser) { 
            users.delete(currentUser); 
            broadcastOnlineList();
            console.log(`❌ ${currentUser} отключился. Онлайн: ${users.size}`);
        }
    });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(data);
        }
    });
}

function broadcastOnlineList() {
    const onlineList = JSON.stringify({ 
        type: 'online_list', 
        users: Array.from(users.keys()) 
    });
    broadcast(onlineList);
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