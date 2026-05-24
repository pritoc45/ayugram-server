const WebSocket = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port, maxPayload: 100 * 1024 * 1024 });

const profiles = {};
const activeSockets = {};

console.log(`🚀 AyuGram Pro сервер запущен на порту ${port}`);

wss.on('connection', (ws) => {
    let myUsername = null;

    ws.on('message', (message) => {
        try {
            const p = JSON.parse(message.toString());

            // ── LOGIN ──
            if (p.type === 'login') {
                const username = p.username.trim();
                if (!username) return;
                if (activeSockets[username] && activeSockets[username] !== ws) {
                    return ws.send(JSON.stringify({ type: 'error', text: 'Ник сейчас используется на другом устройстве' }));
                }
                myUsername = username;
                activeSockets[myUsername] = ws;
                if (!profiles[myUsername]) {
                    profiles[myUsername] = { displayName: myUsername, avatar: null, bio: 'Использую AyuGram' };
                }
                profiles[myUsername].online = true;
                console.log(`👤 В сети: ${myUsername}`);
                ws.send(JSON.stringify({ type: 'auth_success', username: myUsername, profile: profiles[myUsername] }));
                broadcastUserList();
            }

            // ── UPDATE PROFILE ──
            if (p.type === 'update_profile') {
                if (!myUsername) return;
                if (p.displayName) profiles[myUsername].displayName = p.displayName;
                if (p.bio !== undefined) profiles[myUsername].bio = p.bio;
                if (p.avatar !== undefined) profiles[myUsername].avatar = p.avatar;
                ws.send(JSON.stringify({ type: 'profile_updated', profile: profiles[myUsername] }));
                broadcastUserList();
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
                    const target = activeSockets[p.to];
                    if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg));
                    ws.send(JSON.stringify(msg));
                }
            }

            // ── EDIT MESSAGE ──
            if (p.type === 'edit_message') {
                if (!myUsername) return;
                const payload = { type: 'msg_edited', from: myUsername, to: p.to, messageId: p.messageId, newText: p.newText };
                const target = activeSockets[p.to];
                if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(payload));
                ws.send(JSON.stringify(payload));
            }

            // ── TYPING ──
            if (p.type === 'typing') {
                if (!myUsername) return;
                const target = activeSockets[p.to];
                if (target && target.readyState === WebSocket.OPEN) {
                    target.send(JSON.stringify({ type: 'typing', from: myUsername }));
                }
            }

            // ── REACTION ──
            if (p.type === 'reaction') {
                if (!myUsername) return;
                const payload = { type: 'new_reaction', from: myUsername, to: p.to, messageId: p.messageId, reaction: p.reaction };
                if (p.to === 'Избранное') ws.send(JSON.stringify(payload));
                else {
                    const target = activeSockets[p.to];
                    if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(payload));
                    ws.send(JSON.stringify(payload));
                }
            }

            // ── PIN ──
            if (p.type === 'pin_message') {
                if (!myUsername) return;
                const payload = { type: 'message_pinned', from: myUsername, to: p.to, messageId: p.messageId, text: p.text };
                if (p.to === 'Избранное') ws.send(JSON.stringify(payload));
                else {
                    const target = activeSockets[p.to];
                    if (target && target.readyState === WebSocket.OPEN) target.send(JSON.stringify(payload));
                    ws.send(JSON.stringify(payload));
                }
            }

            // ── CALLS (audio + video) ──
            if (['call_offer','video_offer','call_answer','ice_candidate','call_end'].includes(p.type)) {
                const target = activeSockets[p.to];
                if (target && target.readyState === WebSocket.OPEN) {
                    p.from = myUsername;
                    target.send(JSON.stringify(p));
                }
            }

            // ── GROUP NOTIFICATIONS ──
            if (p.type === 'group_created') {
                const target = activeSockets[p.to];
                if (target && target.readyState === WebSocket.OPEN) {
                    target.send(JSON.stringify({ type: 'group_invite', from: myUsername, groupId: p.groupId, groupData: p.groupData }));
                }
            }

        } catch (err) {
            console.error('Ошибка пакета:', err.message);
        }
    });

    ws.on('close', () => {
        if (myUsername) {
            console.log(`💤 Отключился: ${myUsername}`);
            delete activeSockets[myUsername];
            if (profiles[myUsername]) {
                profiles[myUsername].online = false;
                profiles[myUsername].lastSeen = Date.now();
            }
            broadcastUserList();
        }
    });
});

function broadcastUserList() {
    const users = Object.keys(profiles).map(u => ({
        username: u,
        displayName: profiles[u].displayName,
        avatar: profiles[u].avatar,
        bio: profiles[u].bio,
        online: !!activeSockets[u],
        lastSeen: profiles[u].lastSeen
    }));
    const packet = JSON.stringify({ type: 'user_list', users });
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(packet); });
}
