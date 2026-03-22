const { WebSocketServer } = require('ws');
const { MongoClient, ObjectId } = require('mongodb'); // Добавили ObjectId

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

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg === 'pong') { ws.isAlive = true; return; }

            // 1. АВТОРИЗАЦИЯ И ИСТОРИЯ
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

            // 2. РЕДАКТИРОВАНИЕ
            if (msg.type === 'edit') {
                await chatCollection.updateOne(
                    { _id: new ObjectId(msg.id) },
                    { $set: { text: msg.text, isEdited: true } }
                );
                broadcast(JSON.stringify({ ...msg, type: 'update' }));
                return;
            }

            // 3. НОВОЕ СООБЩЕНИЕ (Обычное, Ответ или Пересылка)
            if (msg.type === 'group' || msg.type === 'private') {
                const doc = { 
                    ...msg, 
                    time: getTime(), 
                    timestamp: Date.now(),
                    isEdited: false 
                };
                const result = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: result.insertedId }); // Возвращаем с ID

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

    ws.on('close', () => { if (currentUser) { users.delete(currentUser); broadcastOnlineList(); } });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); }); }
function getTime() { return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
function broadcastOnlineList() {
    const list = JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) });
    broadcast(list);
}

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.send('ping');
    });
}, 10000);
