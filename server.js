const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');

// 1. ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ
const MONGODB_URI = 'mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/myChat?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('База данных MongoDB подключена! 🏦'))
    .catch(err => console.error('Ошибка базы:', err));

// Схема сообщения для базы данных
const Message = mongoose.model('Message', new mongoose.Schema({
    from: String,
    to: { type: String, default: 'all' },
    text: String,
    time: String,
    type: { type: String, default: 'group' }
}));

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

// Хранилище активных пользователей: { "ник": сокет }
const users = new Map();

// Функция для рассылки списка всех, кто в сети
function broadcastOnlineList() {
    const onlineList = JSON.stringify({
        type: 'online_list',
        users: Array.from(users.keys())
    });
    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(onlineList);
    });
}

wss.on('connection', async (ws) => {
    let userNick = "";
    console.log('Новое подключение! 📱');

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

            // --- 1. РЕГИСТРАЦИЯ / АВТОРИЗАЦИЯ ---
            if (msg.type === 'auth') {
                // Если юзер сменил ник, удаляем старый из списка
                if (userNick && users.has(userNick)) {
                    users.delete(userNick);
                }
                
                userNick = msg.from;
                users.set(userNick, ws);
                console.log(`Пользователь ${userNick} теперь в сети!`);
                
                // Рассылаем всем обновленный список онлайн-юзеров
                broadcastOnlineList();

                // Загружаем историю (общую и личную для этого юзера)
                const history = await Message.find({ 
                    $or: [{ to: 'all' }, { to: userNick }, { from: userNick }] 
                }).sort({ _id: 1 }).limit(100);
                
                history.forEach(m => {
                    const historyMsg = m.toObject();
                    historyMsg.type = m.type; // Убеждаемся, что тип передается
                    ws.send(JSON.stringify(historyMsg));
                });
                return;
            }

            // --- 2. ОБРАБОТКА И СОХРАНЕНИЕ СООБЩЕНИЙ ---
            const newMessage = new Message({
                from: msg.from,
                to: msg.to || 'all',
                text: msg.text,
                time: time,
                type: msg.type || 'group'
            });
            await newMessage.save();

            const dataToSend = JSON.stringify(newMessage);

            if (msg.type === 'private') {
                // Личное сообщение: шлем только получателю и себе
                const targetSocket = users.get(msg.to);
                if (targetSocket && targetSocket.readyState === 1) {
                    targetSocket.send(dataToSend);
                }
                ws.send(dataToSend); // Отправляем автору, чтобы отобразилось в чате
            } else {
                // Групповое сообщение: шлем всем
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(dataToSend);
                });
            }

        } catch (e) {
            console.log('Ошибка обработки сообщения:', e.message);
        }
    });

    // Когда кто-то отключается
    ws.on('close', () => {
        if (userNick) {
            console.log(`${userNick} вышел из сети.`);
            users.delete(userNick);
            broadcastOnlineList(); // Обновляем список у всех остальных
        }
    });

    ws.on('error', (err) => console.log('Ошибка сокета:', err));
});

console.log('Сервер мессенджера с поддержкой вкладок и БД запущен!');
