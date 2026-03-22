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
        console.log("✅ MongoDB успешно подключена");
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

    // Стандартный обработчик Pong для проверки активности
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const raw = data.toString();
            if (raw === 'pong') { ws.isAlive = true; return; }
            const msg = JSON.parse(raw);

            // 1. АВТОРИЗАЦИЯ И ЗАГРУЗКА ИСТОРИИ (Общая + Личная)
            if (msg.type === 'auth') {
                currentUser = msg.user;
                users.set(currentUser, ws);
                
                // Фильтр истории: сообщения группы ИЛИ сообщения от меня ИЛИ сообщения мне
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

            // 2. РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
            if (msg.type === 'edit') {
                const msgId = new ObjectId(msg.id);
                await chatCollection.updateOne(
                    { _id: msgId }, 
                    { $set: { text: msg.text, isEdited: true } }
                );
                broadcast(JSON.stringify({ type: 'update', id: msg.id, text: msg.text }));
                return;
            }

            // 3. НОВОЕ СООБЩЕНИЕ (Группа / Личное / Ответ)
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
                    // Личное сообщение: отправляем получателю (если он онлайн) и автору
                    const target = users.get(msg.to);
                    if (target && target.readyState === 1) target.send(out);
                    ws.send(out); 
                }
            }
        } catch (e) { console.error("Ошибка при обработке сообщения:", e); }
    });

    ws.on('close', () => {
        if (currentUser) {
            users.delete(currentUser);
            broadcastOnlineList();
        }
    });
});

// Функция рассылки всем активным клиентам
function broadcast(data) {
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// Рассылка актуального списка пользователей онлайн
function broadcastOnlineList() {
    const list = JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) });
    broadcast(list);
}

// Пинг раз в 45 секунд для предотвращения "засыпания" сокета на Render.com
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(); // Протокольный пинг
    });
}, 45000);

wss.on('close', () => clearInterval(interval));

console.log('🚀 Сервер мессенджера запущен!');
