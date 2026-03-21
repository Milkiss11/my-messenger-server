const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');

const MONGODB_URI = 'mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/myChat?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('База данных MongoDB подключена! 🏦'))
    .catch(err => console.error('Ошибка базы:', err));

const Message = mongoose.model('Message', new mongoose.Schema({
    from: String,
    to: { type: String, default: 'all' },
    text: String,
    time: String,
    type: { type: String, default: 'group' }
}));

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const users = new Map(); // Хранилище ник -> сокет для лички

wss.on('connection', async (ws) => {
    let userNick = "";
    console.log('Новое подключение! 📱');

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString()); // Пытаемся прочитать JSON
            const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

            // 1. РЕГИСТРАЦИЯ ПРИ ВХОДЕ
            if (msg.type === 'auth') {
                userNick = msg.from;
                users.set(userNick, ws);
                console.log(`Пользователь ${userNick} теперь в сети!`);
                
                // Загружаем историю (общую и личную для этого юзера)
                const history = await Message.find({ 
                    $or: [{ to: 'all' }, { to: userNick }, { from: userNick }] 
                }).sort({ _id: 1 }).limit(50);
                
                history.forEach(m => ws.send(JSON.stringify(m)));
                return;
            }

            // 2. СОХРАНЕНИЕ И РАССЫЛКА (Личка или Группа)
            const newMessage = new Message({
                from: msg.from,
                to: msg.to || 'all',
                text: msg.text,
                time: time,
                type: msg.type || 'group'
            });
            await newMessage.save();

            if (msg.type === 'private') {
                // Шлем конкретному человеку
                const targetSocket = users.get(msg.to);
                if (targetSocket) targetSocket.send(JSON.stringify(newMessage));
                ws.send(JSON.stringify(newMessage)); // Себе тоже
            } else {
                // Шлем всем (группа)
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(JSON.stringify(newMessage));
                });
            }

        } catch (e) {
            console.log('Ошибка обработки сообщения:', e.message);
        }
    });

    ws.on('close', () => {
        if (userNick) users.delete(userNick);
    });
});

console.log('Сервер личных чатов запущен!');
