const { WebSocketServer } = require('ws');
const fs = require('fs');

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
const HISTORY_FILE = 'chat_history.txt';

function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(line => line.length > 0);
    }
    return [];
}

wss.on('connection', (ws) => {
    console.log('Новое подключение! 📱');
    ws.isAlive = true;

    // Сразу отправляем историю
    const history = loadHistory();
    history.forEach(msg => ws.send(msg));

    ws.on('message', (data) => {
        const message = data.toString();
        
        // Ответ на пинг от телефона (если добавишь в Android)
        if (message === 'pong') {
            ws.isAlive = true;
            return;
        }

        // Если пришло обычное сообщение
        const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        // Проверяем, нет ли уже времени в начале (чтобы не дублировать при пересылке)
        const finalMsg = message.startsWith('[') ? message : `[${time}] ${message}`;
        
        console.log('Получено:', finalMsg);
        fs.appendFileSync(HISTORY_FILE, finalMsg + '\n');

        wss.clients.forEach(client => {
            if (client.readyState === 1) client.send(finalMsg);
        });
    });

    ws.on('pong', () => { ws.isAlive = true; }); // Стандартный обработчик понга
});

// ПРОВЕРКА СВЯЗИ КАЖДЫЕ 10 СЕКУНД
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        
        ws.isAlive = false;
        ws.send('ping'); // Посылаем сигнал жизни
    });
}, 10000); // 10000 мс = 10 сек

wss.on('close', () => clearInterval(interval));

console.log('Сервер с быстрым пингом (10с) запущен!');
