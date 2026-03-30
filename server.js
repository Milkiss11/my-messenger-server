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
        console.log("✅ MaXiM Database Connected");
    } catch (e) { console.error("❌ DB ERROR:", e.message); }
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
                const { user, tag } = msg;
                let account = await accountsCollection.findOne({ tag: tag });

                if (account) {
                    if (account.user !== user) {
                        return ws.send(JSON.stringify({ type: 'auth_error', message: 'Тег занят другим ником!' }));
                    }
                } else {
                    const nameCheck = await accountsCollection.findOne({ user: user });
                    if (nameCheck) return ws.send(JSON.stringify({ type: 'auth_error', message: 'Ник уже занят!' }));
                    await accountsCollection.insertOne({ user: user, tag: tag });
                }

                currentUser = user;
                users.set(currentUser, { ws });
                const history = await chatCollection.find({ $or: [{ type: 'group' }, { user: currentUser }, { to: currentUser }] }).sort({ timestamp: 1 }).limit(100).toArray();
                ws.send(JSON.stringify({ type: 'history', data: history }));
                broadcastOnlineList();
                return;
            }

            if (msg.type === 'group' || msg.type === 'private') {
                const doc = { ...msg, time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), timestamp: Date.now(), isEdited: false };
                const res = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: res.insertedId.toString() });
                if (msg.type === 'group') broadcast(out);
                else {
                    const t = users.get(msg.to);
                    if (t) t.ws.send(out);
                    ws.send(out);
                }
            }
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
