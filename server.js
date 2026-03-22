const { WebSocketServer } = require('ws');
const { MongoClient, ObjectId } = require('mongodb');

// Твоя ссылка на MongoDB Atlas
const uri = "mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/messenger?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let chatCollection;

async function connectDB() {
    try {
        await client.connect();
        chatCollection = client.db("messenger").collection("messages");
        console.log("✅ MongoDB подключена. База Nevkini готова к работе.");
    } catch (e) { console.error("❌ Ошибка базы:", e); }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map(); // Храним { ник: { ws, avatar } }

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const raw = data.toString();
            if (raw === 'pong') { ws.isAlive = true; return; }
            const msg = JSON.parse(raw);

            // 1. АВТОРИЗАЦИЯ + ИСТОРИЯ + АВАТАР
            if (msg.type === 'auth') {
                currentUser = msg.user;
                // Сохраняем и сокет, и ссылку на аватар пользователя
                users.set(currentUser, { ws, avatar: msg.avatar || "" });
                
                console.log(`👤 Вход: ${currentUser}`);

                const history = await chatCollection.find({
                    $or: [{ type: 'group' }, { user: currentUser }, { to: currentUser }]
                }).sort({ timestamp: 1 }).limit(100).toArray();

                ws.send(JSON.stringify({ type: 'history', data: history }));
                broadcastOnlineList();
                return;
            }

            // 2. УДАЛЕНИЕ СООБЩЕНИЯ
            if (msg.type === 'delete') {
                const msgId = new ObjectId(msg.id);
                // Проверяем, существует ли сообщение, перед удалением (опционально)
                await chatCollection.deleteOne({ _id: msgId });
                // Рассылаем всем команду на удаление из списка в UI
                broadcast(JSON.stringify({ type: 'delete_confirm', id: msg.id }));
                return;
            }

            // 3. РЕДАКТИРОВАНИЕ
            if (msg.type === 'edit') {
                await chatCollection.updateOne(
                    { _id: new ObjectId(msg.id) },
                    { $set: { text: msg.text, isEdited: true } }
                );
                broadcast(JSON.stringify({ type: 'update', id: msg.id, text: msg.text }));
                return;
            }

            // 4. ПРОЧТЕНИЕ (Синие галочки)
            if (msg.type === 'read_all') {
                await chatCollection.updateMany(
                    { type: 'private', user: msg.target, to: currentUser, read: false },
                    { $set: { read: true } }
                );
                const sender = users.get(msg.target);
                if (sender) sender.ws.send(JSON.stringify({ type: 'messages_read', by: currentUser }));
                return;
            }

            // 5. ОТПРАВКА (Группа / Личка)
            if (msg.type === 'group' || msg.type === 'private') {
                // Берем актуальный аватар отправителя из памяти сервера
                const userSession = users.get(currentUser);
                
                const doc = { 
                    ...msg, 
                    avatar: userSession ? userSession.avatar : "", // Прикрепляем аватар к сообщению
                    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now(),
                    isEdited: false,
                    read: false 
                };
                
                const result = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: result.insertedId.toString() });

                if (msg.type === 'group') {
                    broadcast(out);
                } else {
                    const target = users.get(msg.to);
                    if (target && target.ws.readyState === 1) target.ws.send(out);
                    ws.send(out); 
                }
            }
        } catch (e) { console.error("Ошибка сервера:", e); }
    });

    ws.on('close', () => {
        if (currentUser) {
            users.delete(currentUser);
            broadcastOnlineList();
        }
    });
});

function broadcast(data) {
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

function broadcastOnlineList() {
    const list = JSON.stringify({ 
        type: 'online_list', 
        users: Array.from(users.keys()) 
    });
    broadcast(list);
}

// Пинг-понг для Render (45 секунд)
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 45000);

wss.on('close', () => clearInterval(interval));

console.log('🚀 Nevkini Server Pro запущен на порту 8080');
