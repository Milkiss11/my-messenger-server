const { WebSocketServer } = require('ws');

// Используем порт от Render или 8080
const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

// Карта активных пользователей: { "ник": сокет }
const users = new Map();

wss.on('connection', (ws) => {
    let currentUser = null;
    ws.isAlive = true;

    ws.on('message', (data) => {
        const rawData = data.toString();
        
        // 1. Обработка системного PONG (чтобы связь не рвалась)
        if (rawData === 'pong') {
            ws.isAlive = true;
            return;
        }

        try {
            const msg = JSON.parse(rawData);

            // 2. АВТОРИЗАЦИЯ: привязываем ник к этому соединению
            if (msg.type === 'auth') {
                currentUser = msg.user;
                users.set(currentUser, ws);
                console.log(`Пользователь [${currentUser}] в сети`);
                return;
            }

            // 3. ГРУППОВОЕ СООБЩЕНИЕ: рассылаем всем
            if (msg.type === 'group') {
                const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                const outMsg = JSON.stringify({
                    type: 'group',
                    user: msg.user,
                    text: msg.text,
                    time: time
                });
                
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(outMsg);
                });
            }

            // 4. ЛИЧНОЕ СООБЩЕНИЕ (заготовка на будущее)
            if (msg.type === 'private') {
                const receiver = users.get(msg.to);
                const outMsg = JSON.stringify({ ...msg, time: new Date().toLocaleTimeString() });
                if (receiver && receiver.readyState === 1) receiver.send(outMsg);
                ws.send(outMsg); // Себе тоже
            }

        } catch (e) {
            console.log("Получен не JSON формат:", rawData);
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            users.delete(currentUser);
            console.log(`Пользователь [${currentUser}] вышел`);
        }
    });
});

// ПРОВЕРКА СВЯЗИ (КАЖДЫЕ 10 СЕКУНД)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.send('ping');
    });
}, 10000);

wss.on('close', () => clearInterval(interval));

console.log('Облачный сервер мессенджера запущен!');
