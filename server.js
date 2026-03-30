const { WebSocketServer } = require('ws');
const { MongoClient, ObjectId } = require('mongodb');

const uri = "mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/messenger?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let chatCollection, accountsCollection;

async function connectDB() {
    await client.connect();
    const db = client.db("messenger");
    chatCollection = db.collection("messages");
    accountsCollection = db.collection("accounts");
    console.log("✅ MaXiM DB Connected");
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
                    if (account.user !== user) await accountsCollection.updateOne({ tag: tag }, { $set: { user: user } });
                } else {
                    const nameCheck = await accountsCollection.findOne({ user: user });
                    if (nameCheck) return ws.send(JSON.stringify({ type: 'auth_error', message: 'Ник занят!' }));
                    await accountsCollection.insertOne({ user: user, tag: tag });
                }
                currentUser = user;
                users.set(currentUser, { ws });
                const history = await chatCollection.find({ $or: [{ type: 'group' }, { user: currentUser }, { to: currentUser }] }).sort({ timestamp: 1 }).toArray();
                ws.send(JSON.stringify({ type: 'history', messages: history }));
                broadcastOnlineList();
                return;
            }
            if (msg.type === 'group' || msg.type === 'private') {
                const doc = { ...msg, time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), timestamp: Date.now() };
                const res = await chatCollection.insertOne(doc);
                const out = JSON.stringify({ ...doc, _id: res.insertedId.toString() });
                if (msg.type === 'group') broadcast(out);
                else {
                    const t = users.get(msg.to);
                    if (t) t.ws.send(out);
                    ws.send(out);
                }
            }
        } catch (e) { console.log(e); }
    });
    ws.on('close', () => { if (currentUser) { users.delete(currentUser); broadcastOnlineList(); } });
});

function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); }); }
function broadcastOnlineList() { broadcast(JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) })); }