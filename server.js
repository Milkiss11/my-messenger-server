const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

// Карта пользователей: { "ник": сокет }
const users = new Map();

wss.on('connection', (ws) => {
    let currentUser = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            // 1. Авторизация (при входе приложение шлет {type: "auth", user: "ник"})
            if (msg.type === 'auth') {
                currentUser = msg.user;
                users.set(currentUser, ws);
                console.log(`${currentUser} зашел в сеть`);
                return;
            }

            // 2. Личное сообщение {type: "private", to: "кому", from: "кто", text: "привет"}
            if (msg.type === 'private') {
                const receiver = users.get(msg.to);
                if (receiver && receiver.readyState === 1) {
                    receiver.send(JSON.stringify(msg));
                }
                ws.send(JSON.stringify(msg)); // Себе тоже для отображения
            }

            // 3. Групповое (всем) {type: "group", user: "кто", text: "всем привет"}
            if (msg.type === 'group') {
                const outMsg = JSON.stringify(msg);
                wss.clients.forEach(client => {
                    if (client.readyState === 1) client.send(outMsg);
                });
            }
        } catch (e) {
            console.log("Ошибка формата данных:", data.toString());
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            users.delete(currentUser);
            console.log(`${currentUser} вышел`);
        }
    });
});

console.log('Сервер с поддержкой лички и групп запущен!');
