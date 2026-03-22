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
    } catch (e) { console.error("❌ Ошибка базы:", e); }
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
            if (raw === 'pong') { ws.isAlive = true; return; }
            const msg = JSON.parse(raw);

            if (msg.type === 'auth') {
                const { user, tag, avatar } = msg;
                let account = await accountsCollection.findOne({ tag: tag });
                if (account) {
                    await accountsCollection.updateOne({ tag: tag }, { $set: { user: user, avatar: avatar } });
                } else {
                    const nameCheck = await accountsCollection.findOne({ user: user });
                    if (nameCheck) { ws.send(JSON.stringify({ type: 'auth_error', message: 'Ник занят!' })); return; }
                    await accountsCollection.insertOne({ user: user, tag: tag, avatar: avatar });
                }
                currentUser = user;
                users.set(currentUser, { ws, avatar: avatar || "" });
                const history = await chatCollection.find({
                    $or: [{ type: 'group' }, { user: currentUser }, { to: currentUser }]
                }).sort({ timestamp: 1 }).limit(100).toArray();
                ws.send(JSON.stringify({ type: 'history', data: history }));
                broadcastOnlineList();
                return;
            }

            if (msg.type === 'group' || msg.type === 'private') {
                const session = users.get(currentUser);
                const doc = { 
                    ...msg, avatar: session ? session.avatar : "", 
                    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now(), isEdited: false, read: false 
                };
                const res = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: res.insertedId.toString() });
                if (msg.type === 'group') broadcast(out);
                else {
                    const t = users.get(msg.to);
                    if (t) t.ws.send(out);
                    ws.send(out);
                }
            }
            // Другие типы (delete, edit, typing, read_all) остаются без изменений...
        } catch (e) { console.log(e); }
    });
    ws.on('close', () => { if (currentUser) { users.delete(currentUser); broadcastOnlineList(); } });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); }); }
function broadcastOnlineList() { broadcast(JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) })); }
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 45000);
