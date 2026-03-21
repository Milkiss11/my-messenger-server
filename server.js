const { WebSocketServer } = require('ws');
const fs = require('fs'); // Модуль для работы с файлами

const wss = new WebSocketServer({ port: 8080 });
const HISTORY_FILE = 'chat_history.txt';

// Функция для загрузки истории из файла
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(line => line.length > 0);
    }
    return [];
}

wss.on('connection', (ws) => {
    console.log('Новое подключение! 📱');

    // 1. Сразу отправляем новичку всю историю сообщений
    const history = loadHistory();
    history.forEach(msg => ws.send(msg));

    ws.on('message', (data) => {
        const message = data.toString();
        console.log('Получено:', message);

        // 2. Сохраняем новое сообщение в файл (дописываем в конец)
        fs.appendFileSync(HISTORY_FILE, message + '\n');

        // 3. Рассылаем всем в сети
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(message);
            }
        });
    });
});

console.log('Сервер с памятью запущен на ws://localhost:8080');
