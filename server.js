const { WebSocketServer } = require('ws');
const { MongoClient } = require('mongodb');

// Твоя ссылка (добавили название базы 'messenger' перед знаком вопроса)
const uri = "mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/messenger?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);

let chatCollection;

async function connectDB() {
    try {
        await client.connect();
        const db = client.db("messenger");
        chatCollection = db.collection("messages");
        console.log("✅ Успешное подключение к MongoDB Atlas");
    } catch (e) {
        console.error("❌ Ошибка подключения к базе:", e);
    }
}
connectDB();

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map();

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;

    ws.on('message', async (data) => {
        const rawData = data.toString();
        if (rawData === 'pong') { ws.isAlive = true; return; }

        try {
            const msg = JSON.parse(rawData);

            // 1. РЕГИСТРАЦИЯ И ЗАГРУЗКА ИСТОРИИ
            if (msg.type === 'auth') {
                currentUser = msg.user;
                users.set(currentUser, ws);
                console.log(`Профиль активен: ${currentUser}`);

                // Достаем последние 50 сообщений (общие + личные для этого юзера)
                const history = await chatCollection.find({
                    $or: [
                        { type: 'group' },
                        { user: currentUser },
                        { to: currentUser }
                    ]
                }).sort({ _id: -1 }).limit(50).toArray();

                // Отправляем историю только этому пользователю
                ws.send(JSON.stringify({ type: 'history', data: history.reverse() }));
                
                broadcastOnlineList();
                return;
            }

            // 2. ОБРАБОТКА СООБЩЕНИЙ (GROUP / PRIVATE)
            if (msg.type === 'group' || msg.type === 'private') {
                const fullMsg = { ...msg, time: getTime(), timestamp: Date.now() };
                
                // Сохраняем в MongoDB
                await chatCollection.insertOne(fullMsg);
                
                const out = JSON.stringify(fullMsg);

                if (msg.type === 'group') {
                    wss.clients.forEach(c => { if (c.readyState === 1) c.send(out); });
                } else if (msg.type === 'private') {
                    const target = users.get(msg.to);
                    if (target && target.readyState === 1) target.send(out);
                    ws.send(out); // Себе тоже отправляем для подтверждения
                }
            }

        } catch (e) { console.log("Ошибка данных:", e); }
    });

    ws.on('close', () => {
        if (currentUser) {
            users.delete(currentUser);
            broadcastOnlineList();
        }
    });
});

function getTime() { return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }

function broadcastOnlineList() {
    const list = JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(list); });
}

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.send('ping');
    });
}, 10000);

console.log('Сервер с базой данных запущен!');
