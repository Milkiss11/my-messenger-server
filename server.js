const { WebSocketServer } = require('ws');
const { MongoClient } = require('mongodb');

const uri = "mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/messenger?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let chatCollection, accountsCollection;

async function connectDB() {
    try {
        await client.connect();
        const db = client.db("messenger");
        chatCollection = db.collection("messages");
        accountsCollection = db.collection("accounts");
        console.log("✅ База Nevkini подключена");
    } catch (e) { console.error("❌ Ошибка MongoDB:", e); }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map(); // key: nick, value: { ws, avatar }

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'auth') {
                currentUser = msg.user;
                users.set(currentUser, { ws, avatar: msg.avatar || "" });
                
                // Сохраняем аккаунт
                await accountsCollection.updateOne({ tag: msg.tag }, { $set: { user: msg.user, avatar: msg.avatar } }, { upsert: true });

                // Загружаем историю (общие + сообщения для/от текущего юзера)
                const history = await chatCollection.find({
                    $or: [
                        { type: 'group' }, 
                        { user: currentUser }, 
                        { to: currentUser }
                    ]
                }).sort({ timestamp: 1 }).limit(100).toArray();
                
                ws.send(JSON.stringify({ type: 'history', data: history }));
                broadcastOnlineList();
                return;
            }

            if (msg.type === 'group' || msg.type === 'private') {
                const doc = { 
                    ...msg, 
                    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now() 
                };
                const res = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: res.insertedId.toString() });

                if (msg.type === 'group') {
                    broadcast(out);
                } else {
                    // Личное сообщение (АФК логика)
                    const target = users.get(msg.to);
                    if (target) target.ws.send(out); // Отправляем онлайн-получателю
                    ws.send(out); // Отправляем себе для подтверждения
                }
            }
        } catch (e) { console.log("WS Error:", e); }
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
    const list = JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) });
    broadcast(list);
}

// Пинг, чтобы Render не закрывал соединение
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
