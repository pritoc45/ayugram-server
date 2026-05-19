const WebSocket = require('ws');

// Берем порт из облака или 8080 для компа
const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: port });

// ДОБАВЛЕНО: Хранилища данных, без которых код падал
const profiles = {}; 
const activeSockets = {};

console.log(`🚀 Сервер AyuGram успешно запущен на порту ${port}...`);

wss.on('connection', (ws) => {
    let myUsername = null;

    ws.on('message', (message) => {
        try {
            const packet = JSON.parse(message.toString());

            // 1. АВТОРИЗАЦИЯ
            if (packet.type === 'login') {
                const username = packet.username.trim();
                if (!username) return;

                // Если кто-то чужой сидит под этим ником
                if (activeSockets[username] && activeSockets[username] !== ws) {
                    return ws.send(JSON.stringify({ type: 'error', text: 'Ник сейчас используется' }));
                }

                myUsername = username;
                activeSockets[myUsername] = ws;

                // Если профиля еще нет - создаем
                if (!profiles[myUsername]) {
                    profiles[myUsername] = {
                        displayName: myUsername,
                        avatar: null,
                        bio: 'Всем привет, я использую AyuGram Web!'
                    };
                }

                console.log(`👤 В сети: ${myUsername}`);
                
                ws.send(JSON.stringify({ 
                    type: 'auth_success', 
                    username: myUsername,
                    profile: profiles[myUsername]
                }));
                broadcastUserList();
            }

            // 2. ОБНОВЛЕНИЕ ПРОФИЛЯ
            if (packet.type === 'update_profile') {
                if (!myUsername || !profiles[myUsername]) return;

                if (packet.displayName) profiles[myUsername].displayName = packet.displayName;
                if (packet.bio) profiles[myUsername].bio = packet.bio;
                if (packet.avatar !== undefined) profiles[myUsername].avatar = packet.avatar;

                ws.send(JSON.stringify({
                    type: 'profile_updated',
                    profile: profiles[myUsername]
                }));

                broadcastUserList();
            }

            // 3. ОТПРАВКА СООБЩЕНИЯ
            if (packet.type === 'message') {
                if (!myUsername) return;

                const msgPayload = {
                    type: 'new_message',
                    from: myUsername,
                    to: packet.to,
                    text: packet.text,
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };

                if (packet.to === 'Избранное') {
                    ws.send(JSON.stringify(msgPayload));
                } else {
                    const targetWs = activeSockets[packet.to];
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify(msgPayload));
                    }
                    ws.send(JSON.stringify(msgPayload));
                }
            }

        } catch (err) {
            console.error('Ошибка пакета:', err);
        }
    });

    // ПРИ ОТКЛЮЧЕНИИ
    ws.on('close', () => {
        if (myUsername) {
            console.log(`💤 Отключился: ${myUsername}`);
            delete activeSockets[myUsername]; 
            broadcastUserList();
        }
    });
});

function broadcastUserList() {
    const usersData = Object.keys(activeSockets).map(username => ({
        username: username,
        displayName: profiles[username].displayName,
        avatar: profiles[username].avatar,
        bio: profiles[username].bio
    }));

    const packet = JSON.stringify({ type: 'user_list', users: usersData });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(packet);
        }
    });
}