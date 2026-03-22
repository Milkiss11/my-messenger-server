const { WebSocketServer } = require('ws');
const { MongoClient, ObjectId } = require('mongodb');

const uri = "mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/messenger?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let chatCollection;

async function connectDB() {
    try {
        await client.connect();
        chatCollection = client.db("messenger").collection("messages");
        console.log("✅ MongoDB Подключена");
    } catch (e) { console.error("❌ Ошибка базы:", e); }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map(); // { nick: { ws, avatar } }

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const raw = data.toString();
            if (raw === 'pong') { ws.isAlive = true; return; }
            const msg = JSON.parse(raw);

            // 1. АВТОРИЗАЦИЯ
            if (msg.type === 'auth') {
                currentUser = msg.user;
                users.set(currentUser, { ws, avatar: msg.avatar || "" });
                const history = await chatCollection.find({
                    $or: [{ type: 'group' }, { user: currentUser }, { to: currentUser }]
                }).sort({ timestamp: 1 }).limit(100).toArray();
                ws.send(JSON.stringify({ type: 'history', data: history }));
                broadcastOnlineList();
                return;
            }

            // 2. ИНДИКАТОР ПЕЧАТИ (Не сохраняем в БД)
            if (msg.type === 'typing') {
                const out = JSON.stringify({ type: 'typing', user: msg.user, chatType: msg.chatType });
                if (msg.chatType === 'group') {
                    wss.clients.forEach(c => { if (c !== ws && c.readyState === 1) c.send(out); });
                } else {
                    const target = users.get(msg.to);
                    if (target && target.ws.readyState === 1) target.ws.send(out);
                }
                return;
            }

            // 3. ПРОЧТЕНИЕ
            if (msg.type === 'read_all') {
                await chatCollection.updateMany({ type: 'private', user: msg.target, to: currentUser, read: false }, { $set: { read: true } });
                const sender = users.get(msg.target);
                if (sender) sender.ws.send(JSON.stringify({ type: 'messages_read', by: currentUser }));
                return;
            }

            // 4. УДАЛЕНИЕ И ПРАВКА
            if (msg.type === 'delete') {
                await chatCollection.deleteOne({ _id: new ObjectId(msg.id) });
                broadcast(JSON.stringify({ type: 'delete_confirm', id: msg.id }));
                return;
            }
            if (msg.type === 'edit') {
                await chatCollection.updateOne({ _id: new ObjectId(msg.id) }, { $set: { text: msg.text, isEdited: true } });
                broadcast(JSON.stringify({ type: 'update', id: msg.id, text: msg.text }));
                return;
            }

            // 5. ОТПРАВКА СООБЩЕНИЯ
            if (msg.type === 'group' || msg.type === 'private') {
                const session = users.get(currentUser);
                const doc = { 
                    ...msg, 
                    avatar: session ? session.avatar : "",
                    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now(),
                    isEdited: false, read: false 
                };
                const result = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: result.insertedId.toString() });
                if (msg.type === 'group') broadcast(out);
                else {
                    const target = users.get(msg.to);
                    if (target) target.ws.send(out);
                    ws.send(out);
                }
            }
        } catch (e) { console.log(e); }
    });

    ws.on('close', () => { if (currentUser) { users.delete(currentUser); broadcastOnlineList(); } });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); }); }
function broadcastOnlineList() { broadcast(JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) })); }
setInterval(() => { wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 45000);
