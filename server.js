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
        console.log("✅ MaXiM Server: База на связи");
    } catch (e) { console.error(e); }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map();

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'auth') {
                const { user, tag, avatar } = msg;
                // 1. Ищем, есть ли аккаунт с таким ТЕГОМ
                let accountByTag = await accountsCollection.findOne({ tag: tag });

                if (accountByTag) {
                    // ТЕГ найден: разрешаем смену ника, если новый ник не занят другим ТЕГОМ
                    const nameCheck = await accountsCollection.findOne({ user: user, tag: { $ne: tag } });
                    if (nameCheck) {
                        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Этот ник уже занят другим пользователем!' }));
                    }
                    // Обновляем данные (позволяет сменить ник)
                    await accountsCollection.updateOne({ tag: tag }, { $set: { user: user, avatar: avatar } });
                } else {
                    // ТЕГ новый: проверяем, не занят ли НИК кем-то другим
                    const nameCheck = await accountsCollection.findOne({ user: user });
                    if (nameCheck) {
                        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Ник занят! Введите свой секретный тег или другой ник.' }));
                    }
                    // Регистрация нового
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
                const doc = { 
                    ...msg, 
                    time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                    timestamp: Date.now(), isEdited: false 
                };
                const res = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: res.insertedId.toString() });
                if (msg.type === 'group') broadcast(out);
                else {
                    const target = users.get(msg.to);
                    if (target) target.ws.send(out);
                    ws.send(out);
                }
            }
            // Удаление и редактирование
            if (msg.type === 'delete') {
                await chatCollection.deleteOne({ _id: new ObjectId(msg.id) });
                broadcast(JSON.stringify({ type: 'delete', id: msg.id }));
            }
            if (msg.type === 'edit') {
                await chatCollection.updateOne({ _id: new ObjectId(msg.id) }, { $set: { text: msg.text, isEdited: true } });
                broadcast(JSON.stringify({ type: 'edit', id: msg.id, text: msg.text }));
            }
        } catch (e) { console.log(e); }
    });
    ws.on('close', () => { if (currentUser) { users.delete(currentUser); broadcastOnlineList(); } });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); }); }
function broadcastOnlineList() { broadcast(JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) })); }
