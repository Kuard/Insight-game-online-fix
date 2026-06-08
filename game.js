const PEER_CONFIG = {
    config: { 'iceServers': [{ urls: 'stun:stun.l.google.com:19302' }] }
};

const $ = id => document.getElementById(id);

const Sound = {
    ctx: null,
    init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); },
    play(freq, type, duration) {
        try {
            this.init();
            const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
            osc.type = type; osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(0.05, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
            osc.connect(gain); gain.connect(this.ctx.destination);
            osc.start(); osc.stop(this.ctx.currentTime + duration);
        } catch(e) {}
    }
};

const Vibrate = {
    _api: navigator.vibrate ? navigator.vibrate.bind(navigator) : null,
    buzz(p) { if (!this._api) return; try { this._api(p); } catch(e) {} },
    tap() { this.buzz(45); },
    pop() { this.buzz([30, 30, 30]); },
    click() { this.buzz(35); }
};

let QUESTIONS = {};
fetch('questions.json').then(r => r.json()).then(data => {
    QUESTIONS = data;
    QUESTIONS.misc = [...QUESTIONS.classic.slice(0,6), ...QUESTIONS.spicy.slice(0,6), ...QUESTIONS.trash.slice(0,6)];
});

let net = { peer: null, conn: null, connections: [], role: 'client', myName: '' };
let room = { id:'', players:[], currentSubject:'', currentPrompt:'', currentRawQuestion:'', currentCategory:'spicy', cards:[], timeLimit:45, playedQuestions: [] };
let roundTimerInterval = null;
let timeRemaining = 0;
let screenTransitionChangeTime = 0;

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
    $(id).scrollTop = 0;
    if (id === 'scrRevealStage') screenTransitionChangeTime = Date.now();
}

function getCleanName() {
    let n = $('menuNameInput').value.trim();
    return n || "Player_" + Math.floor(Math.random() * 900);
}

function setCategory(cat, el) {
    room.currentCategory = cat;
    document.querySelectorAll('.deck-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    if (net.role === 'host') broadcastToAll({ type: 'SYNC_CATEGORY', category: cat });
}

function triggerLeaveConfirmation() { $('confirmLeaveModal').classList.add('active'); }
function dismissLeaveConfirmation() { $('confirmLeaveModal').classList.remove('active'); }
function confirmLeaveRoom() { $('confirmLeaveModal').classList.remove('active'); leaveRoom(); }

function leaveRoom() {
    clearInterval(roundTimerInterval);
    if (net.peer) { try { net.peer.destroy(); } catch(e) {} }
    net = { peer: null, conn: null, connections: [], role: 'client', myName: '' };
    room = { id:'', players:[], currentSubject:'', currentPrompt:'', currentRawQuestion:'', currentCategory:'spicy', cards:[], timeLimit:45, playedQuestions: [] };
    showScreen('scrMenu');
}

function createLiveRoom() {
    net.myName = getCleanName();
    net.role = 'host';
    room.players = [net.myName];
    const shortId = Math.random().toString(36).substring(2,6).toUpperCase();
    net.peer = new Peer(shortId, PEER_CONFIG);
    net.peer.on('open', (id) => {
        room.id = id;
        $('lobbyIdLabel').innerText = id;
        $('hostOnlyControls').style.display = 'block';
        $('hostStartBtn').style.display = 'block';
        showScreen('scrLobby');
    });
    net.peer.on('connection', (connection) => {
        connection.on('data', (data) => handleData(data, connection));
    });
}

function joinLiveRoom() {
    net.myName = getCleanName();
    net.role = 'client';
    const targetId = $('joinRoomInput').value.trim().toUpperCase();
    net.peer = new Peer(undefined, PEER_CONFIG);
    net.peer.on('open', () => {
        net.conn = net.peer.connect(targetId, { reliable: true });
        net.conn.on('open', () => {
            net.conn.send({ type: 'JOIN', name: net.myName });
            $('lobbyIdLabel').innerText = targetId;
            showScreen('scrLobby');
        });
        net.conn.on('data', (data) => handleData(data, null));
    });
}

function handleData(data, connection) {
    if (data.type === 'JOIN' && net.role === 'host') {
        if (connection && connection.playerName) return;
        if (room.players.includes(data.name)) {
            if (connection) connection.send({ type: 'KICKED', reason: 'Name taken!' });
            return;
        }
        room.players.push(data.name);
        if (connection) { connection.playerName = data.name; net.connections.push(connection); }
        broadcastToAll({ type: 'SYNC_LOBBY', players: room.players, category: room.currentCategory, playedQuestions: room.playedQuestions });
        updateLobbyUI();
    }
    else if (data.type === 'KICKED') { alert(data.reason); leaveRoom(); }
    else if (data.type === 'SYNC_LOBBY') {
        room.players = data.players;
        room.currentCategory = data.category;
        updateLobbyUI();
    }
    else if (data.type === 'START_ROUND') {
        room.currentSubject = data.subject; room.currentPrompt = data.prompt;
        room.cards = []; startRoundExecution();
    }
    else if (data.type === 'SUBMIT_CARD' && net.role === 'host') {
        if (!room.cards.some(c => c.creator === data.creator)) {
            room.cards.push({ text: data.text, creator: data.creator, revealed: false, selected: false });
            if (room.cards.length >= room.players.length - 1) {
                clearInterval(roundTimerInterval);
                broadcastToAll({ type: 'GO_TO_REVEAL', cards: room.cards.sort(() => Math.random() - 0.5) });
            }
        }
    }
    else if (data.type === 'GO_TO_REVEAL') { room.cards = data.cards; renderRevealStage(); }
    else if (data.type === 'FLIP_CARD') { room.cards[data.index].revealed = true; updateCardDOM(data.index); if(net.role==='host') rebroadcast(data, connection); }
    else if (data.type === 'SELECT_CARD') { 
        room.cards.forEach((c,i) => c.selected = (i === data.index));
        room.cards.forEach((_,i) => updateCardDOM(i));
        if(net.role==='host') rebroadcast(data, connection); 
    }
}

function broadcastToAll(payload) {
    if (net.role === 'host') {
        net.connections.forEach(c => { try { c.send(payload); } catch(e) {} });
        handleData(payload, null);
    }
}

function updateLobbyUI() {
    const grid = $('lobbyPlayerGrid'); grid.innerHTML = "";
    room.players.forEach(p => {
        const pill = document.createElement('div');
        pill.className = "player-pill";
        pill.innerText = p;
        if (net.role === 'host' && p !== net.myName) {
            const kick = document.createElement('span');
            kick.className = "kick-btn"; kick.innerHTML = "&times;";
            kick.onclick = () => kickPlayer(p);
            pill.appendChild(kick);
        }
        grid.appendChild(pill);
    });
}

function kickPlayer(name) {
    const connToKick = net.connections.find(c => c.playerName === name);
    if (connToKick) { connToKick.send({ type: 'KICKED', reason: 'Kicked by host.' }); net.connections = net.connections.filter(c => c !== connToKick); }
    room.players = room.players.filter(p => p !== name);
    broadcastToAll({ type: 'SYNC_LOBBY', players: room.players, category: room.currentCategory, playedQuestions: room.playedQuestions });
    updateLobbyUI();
}
// ... (Keep existing broadcastStartRound, startRoundExecution, renderRevealStage, etc.)
