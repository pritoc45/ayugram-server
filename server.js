const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const port = process.env.PORT || 8080;

// ── HTTP сервер (для health check + keep-alive) ──
const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('AyuGram Pro Server OK');
});

const wss = new WebSocket.Server({ server: httpServer, maxPayload: 100 * 1024 * 1024 });

// ── БД (в памяти, но с персистентностью через JSON если нужно) ──
const users = {};        // username → { passwordHash, salt, displayName, avatar, bio, createdAt }
const activeSockets = {};
const sessions = {};     // token → username

console.log(`🚀 AyuGram Pro сервер запущен на порту ${port}`);

// Keep-alive пинг каждые 14 минут (Render не засыпает)
setInterval(() => {
    http.get(`http://localhost:${port}`, () => {});
    // Пинг всех клиентов
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
    });
}, 14 * 60 * 1000);

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function broadcast(data) {
    const packet = JSON.stringify(data);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(packet); });
}

function broadcastUserList() {
    const userList = Object.keys(users).map(u => ({
        username: u,
        displayName: users[u].displayName,
        avatar: users[u].avatar,
        bio: users[u].bio,
        online: !!activeSockets[u],
        lastSeen: users[u].lastSeen
    }));
    broadcast({ type: 'user_list', users: userList });
}

function sendTo(username, data) {
    const sock = activeSockets[username];
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
    let myUsername = null;

    ws.on('pong', () => {}); // heartbeat

    ws.on('message', (message) => {
        try {
            const p = JSON.parse(message.toString());

            // ── REGISTER ──
            if (p.type === 'register') {
                const username = (p.username || '').trim().toLowerCase();
                const password = p.password || '';
                const displayName = (p.displayName || p.username || '').trim();

                if (!username || username.length < 3)
                    return ws.send(JSON.stringify({ type: 'error', code: 'register', text: 'Имя пользователя минимум 3 символа' }));
                if (!password || password.length < 4)
                    return ws.send(JSON.stringify({ type: 'error', code: 'register', text: 'Пароль минимум 4 символа' }));
                if (!/^[a-z0-9_\.]+$/.test(username))
                    return ws.send(JSON.stringify({ type: 'error', code: 'register', text: 'Только латиница, цифры, _ и .' }));
                if (users[username])
                    return ws.send(JSON.stringify({ type: 'error', code: 'register', text: 'Имя пользователя занято' }));

                const salt = crypto.randomBytes(16).toString('hex');
                const passwordHash = hashPassword(password, salt);
                users[username] = {
                    displayName: displayName || username,
                    avatar: null,
                    bio: 'Использую AyuGram',
                    passwordHash, salt,
                    createdAt: Date.now(),
                    online: false,
                    lastSeen: null
                };
                console.log(`✅ Зарегистрирован: ${username}`);
                ws.send(JSON.stringify({ type: 'register_success', username }));
            }

            // ── LOGIN ──
            if (p.type === 'login') {
                // Логин по токену (автологин)
                if (p.token) {
                    const uname = sessions[p.token];
                    if (!uname || !users[uname])
                        return ws.send(JSON.stringify({ type: 'error', code: 'auth', text: 'Сессия истекла, войдите снова' }));
                    return doLogin(ws, uname, p.token);
                }
                // Логин по логину/паролю
                const username = (p.username || '').trim().toLowerCase();
                const password = p.password || '';
                if (!users[username])
                    return ws.send(JSON.stringify({ type: 'error', code: 'auth', text: 'Пользователь не найден' }));
                const { passwordHash, salt } = users[username];
                if (hashPassword(password, salt) !== passwordHash)
                    return ws.send(JSON.stringify({ type: 'error', code: 'auth', text: 'Неверный пароль' }));
                const token = generateToken();
                sessions[token] = username;
                doLogin(ws, username, token);
            }

            // ── UPDATE PROFILE ──
            if (p.type === 'update_profile') {
                if (!myUsername) return;
                if (p.displayName) users[myUsername].displayName = p.displayName;
                if (p.bio !== undefined) users[myUsername].bio = p.bio;
                if (p.avatar !== undefined) users[myUsername].avatar = p.avatar;
                ws.send(JSON.stringify({ type: 'profile_updated', profile: getProfile(myUsername) }));
                broadcastUserList();
            }

            // ── CHANGE PASSWORD ──
            if (p.type === 'change_password') {
                if (!myUsername) return;
                const { oldPassword, newPassword } = p;
                const { passwordHash, salt } = users[myUsername];
                if (hashPassword(oldPassword, salt) !== passwordHash)
                    return ws.send(JSON.stringify({ type: 'error', code: 'password', text: 'Неверный старый пароль' }));
                if (!newPassword || newPassword.length < 4)
                    return ws.send(JSON.stringify({ type: 'error', code: 'password', text: 'Новый пароль минимум 4 символа' }));
                const newSalt = crypto.randomBytes(16).toString('hex');
                users[myUsername].passwordHash = hashPassword(newPassword, newSalt);
                users[myUsername].salt = newSalt;
                ws.send(JSON.stringify({ type: 'password_changed' }));
            }

            // ── MESSAGE ──
            if (p.type === 'message') {
                if (!myUsername) return;
                const msg = {
                    type: 'new_message',
                    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
                    from: myUsername,
                    to: p.to,
                    text: p.text,
                    media: p.media,
                    mediaType: p.mediaType,
                    fileName: p.fileName,
                    voice: p.voice,
                    replyTo: p.replyTo,
                    replyText: p.replyText,
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    reactions: {}
                };
                if (p.to === 'Избранное') {
                    ws.send(JSON.stringify(msg));
                } else {
                    sendTo(p.to, msg);
                    ws.send(JSON.stringify(msg));
                }
            }

            // ── EDIT ──
            if (p.type === 'edit_message') {
                if (!myUsername) return;
                const payload = { type: 'msg_edited', from: myUsername, to: p.to, messageId: p.messageId, newText: p.newText };
                sendTo(p.to, payload);
                ws.send(JSON.stringify(payload));
            }

            // ── TYPING ──
            if (p.type === 'typing') {
                if (!myUsername) return;
                sendTo(p.to, { type: 'typing', from: myUsername });
            }

            // ── REACTION ──
            if (p.type === 'reaction') {
                if (!myUsername) return;
                const payload = { type: 'new_reaction', from: myUsername, to: p.to, messageId: p.messageId, reaction: p.reaction };
                if (p.to === 'Избранное') ws.send(JSON.stringify(payload));
                else { sendTo(p.to, payload); ws.send(JSON.stringify(payload)); }
            }

            // ── PIN ──
            if (p.type === 'pin_message') {
                if (!myUsername) return;
                const payload = { type: 'message_pinned', from: myUsername, to: p.to, messageId: p.messageId, text: p.text };
                if (p.to === 'Избранное') ws.send(JSON.stringify(payload));
                else { sendTo(p.to, payload); ws.send(JSON.stringify(payload)); }
            }

            // ── CALLS ──
            if (['call_offer','video_offer','call_answer','ice_candidate','call_end'].includes(p.type)) {
                const target = activeSockets[p.to];
                if (target && target.readyState === WebSocket.OPEN) {
                    p.from = myUsername;
                    target.send(JSON.stringify(p));
                } else if (['call_offer','video_offer'].includes(p.type)) {
                    ws.send(JSON.stringify({ type: 'call_end', from: p.to, reason: 'offline' }));
                }
            }

            // ── GROUP ──
            if (p.type === 'group_created') {
                sendTo(p.to, { type: 'group_invite', from: myUsername, groupId: p.groupId, groupData: p.groupData });
            }

        } catch (err) {
            console.error('Ошибка пакета:', err.message);
        }
    });

    ws.on('close', () => {
        if (myUsername) {
            console.log(`💤 Отключился: ${myUsername}`);
            delete activeSockets[myUsername];
            if (users[myUsername]) {
                users[myUsername].online = false;
                users[myUsername].lastSeen = Date.now();
            }
            broadcastUserList();
        }
    });

    ws.on('error', err => console.error('WS error:', err.message));

    function doLogin(ws, username, token) {
        if (activeSockets[username] && activeSockets[username] !== ws) {
            activeSockets[username].send(JSON.stringify({ type: 'kicked', text: 'Вы вошли с другого устройства' }));
            activeSockets[username].close();
        }
        myUsername = username;
        activeSockets[username] = ws;
        users[username].online = true;
        console.log(`👤 В сети: ${username}`);
        ws.send(JSON.stringify({
            type: 'auth_success',
            username,
            token,
            profile: getProfile(username)
        }));
        broadcastUserList();
    }
});

function getProfile(username) {
    const u = users[username];
    return { displayName: u.displayName, avatar: u.avatar, bio: u.bio };
}

httpServer.listen(port, () => console.log(`HTTP + WS на порту ${port}`));
