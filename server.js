const { WebSocketServer } = require('ws');
const fs = require('fs');

// Используем порт от Render или 8080 для локальных тестов
const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const HISTORY_FILE = 'chat_history.txt';

// Функция загрузки истории
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(line => line.length > 0);
    }
    return [];
}

wss.on('connection', (ws) => {
    console.log('Новое подключение! 📱');

    // 1. Отправляем историю новому пользователю
    const history = loadHistory();
    history.forEach(msg => ws.send(msg));

    // 2. Обработка новых сообщений
    ws.on('message', (data) => {
        // Добавляем время сервера (МСК/Локальное)
        const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const messageWithTime = `[${time}] ${data.toString()}`;
        
        console.log('Получено:', messageWithTime);

        // Сохраняем в файл
        fs.appendFileSync(HISTORY_FILE, messageWithTime + '\n');

        // Рассылаем ВСЕМ активным пользователям
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(messageWithTime);
            }
        });
    });

    ws.on('error', (err) => console.log('Ошибка сокета:', err));
});

console.log('Сервер запущен и готов к работе!');
