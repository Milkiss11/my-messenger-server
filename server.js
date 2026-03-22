const { WebSocketServer } = require('ws');
const { MongoClient, ObjectId } = require('mongodb');

const uri = "mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/messenger?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let chatCollection;

async function connectDB() {
    try {
        await client.connect();
        chatCollection = client.db("messenger").collection("messages");
        console.log("✅ MongoDB подключена");
    } catch (e) { console.error("❌ Ошибка базы:", e); }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map();

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;

    // Обработка Pong от клиента
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const raw = data.toString();
            if (raw === 'pong') { ws.isAlive = true; return; }
            const msg = JSON.parse(raw);

            if (msg.type === 'auth') {
                currentUser = msg.user;
                users.set(currentUser, ws);
                const history = await chatCollection.find({
                    $or: [{ type: 'group' }, { user: currentUser }, { to: currentUser }]
                }).sort({ _id: -1 }).limit(50).toArray();
                ws.send(JSON.stringify({ type: 'history', data: history.reverse() }));
                broadcastOnlineList();
                return;
            }

            if (msg.type === 'edit') {
                await chatCollection.updateOne({ _id: new ObjectId(msg.id) }, { $set: { text: msg.text, isEdited: true } });
                broadcast(JSON.stringify({ type: 'update', id: msg.id, text: msg.text }));
                return;
            }

            if (msg.type === 'group' || msg.type === 'private') {
                const doc = { 
                    ...msg, 
                    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now(),
                    isEdited: false 
                };
                const result = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: result.insertedId.toString() });

                if (msg.type === 'group') {
                    broadcast(out);
                } else {
                    const target = users.get(msg.to);
                    if (target) target.send(out);
                    ws.send(out);
                }
            }
        } catch (e) { console.log("Ошибка:", e); }
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

// Пинг раз в 45 секунд, чтобы Render не закрыл соединение
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(); // Используем встроенный протокольный пинг
    });
}, 45000);

console.log('Сервер запущен');
