const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');

// 1. ПОДКЛЮЧЕНИЕ К БАЗЕ
const MONGODB_URI = 'mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/myChat?retryWrites=true&w=majority';
mongoose.connect(MONGODB_URI).then(() => console.log('База данных подключена! 🏦'));

// Схема с полем для галочек (isRead)
const Message = mongoose.model('Message', new mongoose.Schema({
    from: String, to: String, text: String, time: String, 
    type: String, isRead: { type: Boolean, default: false }
}));

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map(); // "ник": сокет

function broadcastOnlineList() {
    const list = JSON.stringify({ type: 'online_list', users: Array.from(users.keys()) });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(list); });
}

wss.on('connection', async (ws) => {
    let myName = "";

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

            // --- АВТОРИЗАЦИЯ ---
            if (msg.type === 'auth') {
                myName = msg.from;
                users.set(myName, ws);
                broadcastOnlineList();
                
                // Загружаем ВСЮ историю этого пользователя
                const history = await Message.find({ 
                    $or: [{ to: 'all' }, { to: myName }, { from: myName }] 
                }).sort({ _id: 1 });
                history.forEach(m => ws.send(JSON.stringify(m)));
                return;
            }

            // --- ГАЛОЧКИ (Прочитано) ---
            if (msg.type === 'read_receipt') {
                await Message.updateMany({ from: msg.from, to: msg.to, isRead: false }, { $set: { isRead: true } });
                const senderSocket = users.get(msg.from);
                if (senderSocket) senderSocket.send(JSON.stringify({ type: 'read_update', partner: msg.to }));
                return;
            }

            // --- ОТПРАВКА СООБЩЕНИЯ ---
            const newMessage = new Message({ ...msg, time, isRead: false });
            await newMessage.save();

            const response = JSON.stringify(newMessage);
            if (msg.type === 'private') {
                const friend = users.get(msg.to);
                if (friend) friend.send(response);
                ws.send(response); // Себе
            } else {
                wss.clients.forEach(c => { if (c.readyState === 1) c.send(response); });
            }
        } catch (e) { console.log("Ошибка:", e.message); }
    });

    ws.on('close', () => { if (myName) { users.delete(myName); broadcastOnlineList(); } });
});
