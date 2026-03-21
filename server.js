const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');

// 1. ПОДКЛЮЧЕНИЕ К ТВОЕЙ БАЗЕ MONGODB
const MONGODB_URI = 'mongodb+srv://Milkissur0:Dolocat228@cluster0.veutlub.mongodb.net/myChat?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('База данных MongoDB подключена! 🏦'))
    .catch(err => console.error('Ошибка базы:', err));

// Схема сообщения (кто, кому, что, когда)
const MessageSchema = new mongoose.Schema({
    from: String,
    to: { type: String, default: 'all' }, 
    text: String,
    time: String
});
const Message = mongoose.model('Message', MessageSchema);

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

wss.on('connection', async (ws) => {
    console.log('Новое подключение! 📱');

    // 2. ЗАГРУЗКА ПОСЛЕДНИХ 50 СООБЩЕНИЙ ИЗ БАЗЫ
    try {
        const history = await Message.find({ to: 'all' }).sort({ _id: 1 }).limit(50);
        history.forEach(msg => {
            ws.send(`[${msg.time}] [${msg.from}]: ${msg.text}`);
        });
    } catch (e) { console.log('Ошибка загрузки истории:', e); }

    ws.on('message', async (data) => {
        const rawData = data.toString();
        const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        // Парсим ник и текст: [ник]: текст
        const match = rawData.match(/\[(.*?)\]: (.*)/);
        if (match) {
            const userName = match[1];
            const messageText = match[2];

            // 3. СОХРАНЯЕМ В БАЗУ
            try {
                const newMessage = new Message({
                    from: userName,
                    text: messageText,
                    time: time
                });
                await newMessage.save();
            } catch (e) { console.log('Ошибка сохранения:', e); }

            // Рассылаем всем
            const fullMsg = `[${time}] [${userName}]: ${messageText}`;
            wss.clients.forEach(client => {
                if (client.readyState === 1) client.send(fullMsg);
            });
        }
    });
});

console.log('Сервер с вечной памятью запущен!');
