// ── FIREWALL-PROOF NETWORK CONFIGURATION ───────────────────────────────────────
const PEER_CONFIG = {
    config: {
        'iceServers': [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: "stun:stun.relay.metered.ca:80" },
            { 
                urls: "turn:global.relay.metered.ca:80", 
                username: "92040003f6021883d79e3d36", 
                credential: "HakDD0N0nzTZrq+r" 
            },
            { 
                urls: "turn:global.relay.metered.ca:80?transport=tcp", 
                username: "92040003f6021883d79e3d36", 
                credential: "HakDD0N0nzTZrq+r" 
            },
            { 
                urls: "turn:global.relay.metered.ca:443", 
                username: "92040003f6021883d79e3d36", 
                credential: "HakDD0N0nzTZrq+r" 
            },
            { 
                urls: "turns:global.relay.metered.ca:443?transport=tcp", 
                username: "92040003f6021883d79e3d36", 
                credential: "HakDD0N0nzTZrq+r" 
            }
        ]
    }
};

// ── UTILITIES ──────────────────────────────────────────────────────────────────
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
    _api: navigator.vibrate ? navigator.vibrate.bind(navigator)
        : (navigator.mozVibrate ? navigator.mozVibrate.bind(navigator) : null),
    buzz(p) { if (!this._api) return; try { this._api(p); } catch(e) {} },
    tap()   { this.buzz(45); },          
    pop()   { this.buzz([30, 30, 30]); }, 
    click() { this.buzz(35); },          
};

// ── QUESTION POOLS (Loaded dynamically) ─────────────────────────────────────────
let QUESTIONS = {};

fetch('questions.json')
    .then(response => response.json())
    .then(data => {
        QUESTIONS = data;
        // Dynamically build misc using ALL available categories so it lasts for unlimited games
        QUESTIONS.misc = [];
        for (const cat in QUESTIONS) {
            if (cat !== 'misc' && Array.isArray(QUESTIONS[cat])) {
                QUESTIONS.misc.push(...QUESTIONS[cat]);
            }
        }
    })
    .catch(err => console.error("Error loading questions.json:", err));

// ── STATE ──────────────────────────────────────────────────────────────────────
let net  = { peer: null, conn: null, connections: [], role: 'client', myName: '' };
let room = {
    id:'', players:[], currentSubject:'', currentPrompt:'', currentRawQuestion:'', currentCategory:'spicy',
    cards:[], timeLimit:45, playedQuestions:[],
    // ── NEW STATE ──
    scores: {},           // { playerName: number }
    lateJoiners: [],      // names of players who joined mid-game (for badge display)
    maxRounds: 10,        // 10 | 30 | 45 | 'unlimited'
    roundCount: 0,        // rounds completed so far
    roundActive: false,   // true while a round is in progress (writing phase)
    activeWriters: []     // players who were present at round start and must submit
};
let roundTimerInterval = null;
let timeRemaining = 0;
let screenTransitionChangeTime = 0; 

// ── HELPERS ────────────────────────────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
    $(id).scrollTop = 0;
    
    if (id === 'scrRevealStage') {
        screenTransitionChangeTime = Date.now();
    }
}

function getCleanName() {
    let n = $('menuNameInput').value.trim();
    return n || "Player_" + Math.floor(Math.random() * 900);
}

function setCategory(cat, el) {
    room.currentCategory = cat;
    document.querySelectorAll('.deck-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    Sound.play(400, 'sine', 0.05);
    Vibrate.click();
    if (net.role === 'host') broadcastToAll({ type: 'SYNC_CATEGORY', category: cat });
}

// ── NEW: Set max rounds (host only) ──────────────────────────────────────────
function setMaxRounds(n, el) {
    room.maxRounds = n;
    document.querySelectorAll('.round-pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    Sound.play(400, 'sine', 0.05);
    Vibrate.click();
    if (net.role === 'host') broadcastToAll({ type: 'SYNC_MAX_ROUNDS', maxRounds: n });
}

/* ── LEAVE CONFIRMATION SYSTEM ── */
function triggerLeaveConfirmation() {
    Sound.play(200, 'sine', 0.08);
    Vibrate.click();
    $('confirmLeaveModal').classList.add('active');
}

function dismissLeaveConfirmation() {
    Sound.play(350, 'sine', 0.05);
    Vibrate.click();
    $('confirmLeaveModal').classList.remove('active');
}

function confirmLeaveRoom() {
    $('confirmLeaveModal').classList.remove('active');
    leaveRoom();
}

function leaveRoom() {
    clearInterval(roundTimerInterval);
    if (window.hostWaitInterval) clearInterval(window.hostWaitInterval);
    if (net.peer) {
        try { net.peer.destroy(); } catch(e) {}
    }
    net = { peer: null, conn: null, connections: [], role: 'client', myName: '' };
    room = {
        id:'', players:[], currentSubject:'', currentPrompt:'', currentRawQuestion:'', currentCategory:'spicy',
        cards:[], timeLimit:45, playedQuestions:[],
        scores: {}, lateJoiners: [], maxRounds: 10, roundCount: 0, roundActive: false, activeWriters: []
    };
    
    $('hostOnlyControls').style.display = 'none';
    $('hostStartBtn').style.display = 'none';
    $('clientWaitNotice').style.display = 'none';
    $('writerInput').value = "";
    
    showScreen('scrMenu');
    Vibrate.click();
}

function addTestBots() {
    if (net.role !== 'host') return;
    ['bot1', 'bot2', 'bot3'].forEach(bot => {
        if (!room.players.includes(bot)) room.players.push(bot);
    });
    broadcastToAll({ type: 'SYNC_LOBBY', players: room.players, category: room.currentCategory, playedQuestions: room.playedQuestions });
    updateLobbyUI();
    Sound.play(500, 'sine', 0.1);
    Vibrate.tap();
}

// ── WORD COUNTER for writer input ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const wi = $('writerInput');
    const cc = $('charCount');
    if (wi && cc) {
        wi.addEventListener('input', function() {
            let wordsCount = (this.value.match(/\S+/g) || []).length;
            if (wordsCount > 120) {
                let matched = this.value.match(/^(\s*\S+){120}/);
                if (matched) {
                    this.value = matched[0];
                    wordsCount = 120;
                }
            }
            cc.innerText = `${wordsCount} / 120 words`;
        });
    }
});

// ── TOAST NOTIFICATION ────────────────────────────────────────────────────────
function showToast(msg) {
    let existing = document.getElementById('gameToast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'gameToast';
    toast.className = 'game-toast';
    toast.innerText = msg;
    document.querySelector('.app-container').appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { toast.classList.add('visible'); });
    });

    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
    }, 3500);
}

// ── NETWORKING ─────────────────────────────────────────────────────────────────
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
        $('clientWaitNotice').style.display = 'none';
        updateLobbyUI();
        showScreen('scrLobby');
    });

    net.peer.on('connection', (connection) => {
        connection.on('data', (data) => handleData(data, connection));
        connection.on('open', () => {
            connection.send({
                type: 'SYNC_LOBBY',
                players: room.players,
                category: room.currentCategory,
                playedQuestions: room.playedQuestions,
                // ── NEW: send round/score state to new connections ──
                maxRounds: room.maxRounds,
                roundCount: room.roundCount,
                scores: room.scores,
                lateJoiners: room.lateJoiners
            });
        });
    });

    net.peer.on('error', (err) => alert("Host error: " + err.type));
}

function joinLiveRoom() {
    net.myName = getCleanName();
    net.role = 'client';
    const targetId = $('joinRoomInput').value.trim().toUpperCase();
    if (!targetId) { alert("Please enter a Room ID"); return; }

    net.peer = new Peer(undefined, PEER_CONFIG);
    
    net.peer.on('open', () => {
        net.conn = net.peer.connect(targetId, { reliable: true });
        
        net.conn.on('open', () => {
            net.conn.send({ type: 'JOIN', name: net.myName });
            $('lobbyIdLabel').innerText = targetId;
            $('hostOnlyControls').style.display = 'none';
            $('hostStartBtn').style.display = 'none';
            $('clientWaitNotice').style.display = 'block';
            showScreen('scrLobby');
        });
        net.conn.on('data', (data) => handleData(data, null));
        net.conn.on('error', () => alert("Could not connect. Check the Room ID and try again."));
    });
    net.peer.on('error', (err) => alert("Connection error: " + err.type));
}

function handleData(data, connection) {
    if (data.type === 'JOIN' && net.role === 'host') {
        if (room.players.includes(data.name)) {
            if (connection) connection.send({ type: 'NAME_TAKEN' });
            return;
        }
        room.players.push(data.name);
        // ── NEW: init score for this player ──
        if (!(data.name in room.scores)) room.scores[data.name] = 0;

        if (connection) {
            connection._kickName = data.name;
            net.connections.push(connection);
        }

        // ── NEW: detect mid-game join ──
        if (room.roundActive) {
            // Mark as late joiner
            if (!room.lateJoiners.includes(data.name)) room.lateJoiners.push(data.name);

            // Send them a catch-up packet so they can observe the current round
            if (connection) {
                connection.send({
                    type: 'CATCH_UP',
                    subject: room.currentSubject,
                    prompt: room.currentPrompt,
                    category: room.currentCategory,
                    cards: room.cards,           // cards submitted so far (may be partial)
                    scores: room.scores,
                    lateJoiners: room.lateJoiners,
                    maxRounds: room.maxRounds,
                    roundCount: room.roundCount
                });
            }

            // Notify everyone else
            broadcastToAll({
                type: 'PLAYER_JOINED_LATE',
                name: data.name,
                players: room.players,
                lateJoiners: room.lateJoiners,
                scores: room.scores
            });
        } else {
            broadcastToAll({
                type: 'SYNC_LOBBY',
                players: room.players,
                category: room.currentCategory,
                playedQuestions: room.playedQuestions,
                maxRounds: room.maxRounds,
                roundCount: room.roundCount,
                scores: room.scores,
                lateJoiners: room.lateJoiners
            });
            updateLobbyUI();
        }
    }
    else if (data.type === 'SYNC_LOBBY') {
        room.players = data.players;
        room.currentCategory = data.category;
        room.playedQuestions = data.playedQuestions || [];
        // ── NEW: sync round/score state ──
        if (data.maxRounds !== undefined) room.maxRounds = data.maxRounds;
        if (data.roundCount !== undefined) room.roundCount = data.roundCount;
        if (data.scores !== undefined) room.scores = data.scores;
        if (data.lateJoiners !== undefined) room.lateJoiners = data.lateJoiners;
        updateLobbyUI();
    }
    else if (data.type === 'SYNC_CATEGORY') {
        room.currentCategory = data.category;
    }
    // ── NEW: sync max rounds on clients ──
    else if (data.type === 'SYNC_MAX_ROUNDS') {
        room.maxRounds = data.maxRounds;
    }
    else if (data.type === 'START_ROUND') {
        room.currentSubject  = data.subject;
        room.currentPrompt   = data.prompt;
        room.currentCategory = data.category;
        if (data.rawQuestion) {
            room.playedQuestions.push(data.rawQuestion);
        }
        // ── NEW: sync round metadata ──
        if (data.roundCount !== undefined) room.roundCount = data.roundCount;
        if (data.lateJoiners !== undefined) room.lateJoiners = data.lateJoiners;
        room.cards = [];
        room.roundActive = true;
        startRoundExecution();
    }
    else if (data.type === 'REQUEST_NEXT_ROUND' && net.role === 'host') {
        if (window.hostWaitInterval) {
            clearInterval(window.hostWaitInterval);
            window.hostWaitInterval = null;
        }
        broadcastStartRound();
    }
    else if (data.type === 'SUBMIT_CARD' && net.role === 'host') {
        if (!room.cards.some(c => c.creator === data.creator)) {
            room.cards.push({ text: data.text, creator: data.creator, revealed: false, selected: false });
            broadcastToAll({ type: 'CARD_COUNT', count: room.cards.length, total: room.activeWriters.length });
            // ── NEW: completion check uses activeWriters, not all players ──
            if (room.cards.length >= room.activeWriters.length) {
                clearInterval(roundTimerInterval);
                room.roundActive = false;
                room.cards.sort(() => Math.random() - 0.5);
                broadcastToAll({ type: 'GO_TO_REVEAL', cards: room.cards, scores: room.scores });
            }
        }
    }
    else if (data.type === 'CARD_COUNT') {
        if ($('submissionTrackLabel')) \( ('submissionTrackLabel').innerText = ` \){data.count} of ${data.total} cards locked in...`;
    }
    else if (data.type === 'GO_TO_REVEAL') {
        room.cards = data.cards;
        // ── NEW: sync scores on reveal ──
        if (data.scores !== undefined) room.scores = data.scores;
        room.roundActive = false;
        clearInterval(roundTimerInterval);
        renderRevealStage();
    }
    else if (data.type === 'FLIP_CARD') {
        room.cards[data.index].revealed = true;
        updateCardDOM(data.index);
        if (net.role === 'host' && connection) rebroadcast(data, connection);
    }
    else if (data.type === 'SELECT_CARD') {
        room.cards.forEach((c,i) => c.selected = (i === data.index));
        room.cards.forEach((_,i) => updateCardDOM(i));

        // ── NEW: award point to card creator (host is authoritative) ──
        if (net.role === 'host') {
            const winner = room.cards[data.index].creator;
            if (!winner.startsWith('bot')) {   // bots don't need scores tracked visibly, but they do count
                room.scores[winner] = (room.scores[winner] || 0) + 1;
            } else {
                room.scores[winner] = (room.scores[winner] || 0) + 1;
            }
            broadcastToAll({ type: 'SYNC_SCORES', scores: room.scores });
            if (connection) rebroadcast(data, connection);
        }
    }
    else if (data.type === 'SYNC_SCORES') {
        room.scores = data.scores;
    }
    else if (data.type === 'TIMER_TICK') {
        document.querySelectorAll('.timer-display').forEach(d => {
            d.innerText = `0:${data.t.toString().padStart(2,'0')}`;
        });
    }
    else if (data.type === 'GAME_OVER') {
        // ── NEW: sync final scores before rendering ──
        if (data.scores !== undefined) room.scores = data.scores;
        if (data.lateJoiners !== undefined) room.lateJoiners = data.lateJoiners;
        executeGameOverUI();
    }
    else if (data.type === 'NAME_TAKEN') {
        leaveRoom();
        alert("That nickname is already taken in this room. Please choose a different name.");
    }
    else if (data.type === 'KICKED') {
        leaveRoom();
        alert("You were removed from the room by the host.");
    }
    // ── NEW: mid-game catch-up for late joiners ──
    else if (data.type === 'CATCH_UP') {
        room.currentSubject  = data.subject;
        room.currentPrompt   = data.prompt;
        room.currentCategory = data.category;
        room.cards           = data.cards || [];
        room.scores          = data.scores || {};
        room.lateJoiners     = data.lateJoiners || [];
        room.maxRounds       = data.maxRounds || room.maxRounds;
        room.roundCount      = data.roundCount || room.roundCount;
        room.roundActive     = true;

        // Show them the reveal stage as a read-only observer
        // (cards may be partially in, so it shows what's been submitted so far)
        $('revealPromptLabel').innerText  = room.currentPrompt;
        $('revealInstructions').innerText = `You joined mid-round — sit tight for the next one!`;
        $('nextRoundBtn').style.display   = 'none';

        const container = $('cardsWrapper');
        container.innerHTML = `
            <div class="late-join-notice">
                ⏳ Round in progress...<br>
                <span>You'll be a full player starting next round.</span>
            </div>
        `;
        showScreen('scrRevealStage');
    }
    // ── NEW: notify everyone of a late joiner ──
    else if (data.type === 'PLAYER_JOINED_LATE') {
        room.players    = data.players;
        room.lateJoiners = data.lateJoiners || room.lateJoiners;
        room.scores     = data.scores || room.scores;
        if (!room.lateJoiners.includes(data.name)) room.lateJoiners.push(data.name);
        showToast(`📲 ${data.name} joined the game!`);
        Vibrate.tap();
    }
}

function broadcastToAll(payload) {
    if (net.role === 'host') {
        net.connections.forEach(c => { try { c.send(payload); } catch(e) {} });
        handleData(payload, null);
    }
}

// ── LOBBY UI ───────────────────────────────────────────────────────────────────
function updateLobbyUI() {
    const grid = $('lobbyPlayerGrid');
    grid.innerHTML = "";
    room.players.forEach(p => {
        const pill = document.createElement('div');
        pill.className = "player-pill";
        const nameSpan = document.createElement('span');
        nameSpan.innerText = p;
        pill.appendChild(nameSpan);
        if (net.role === 'host' && p !== net.myName) {
            const kick = document.createElement('span');
            kick.className = "kick-btn";
            kick.innerHTML = "&times;";
            kick.onclick = () => kickPlayer(p);
            pill.appendChild(kick);
        }
        grid.appendChild(pill);
    });

    const count  = room.players.length;
    const needed = Math.max(0, 3 - count);
    const lbl    = $('lobbyStatusLabel');
    if (lbl) {
        lbl.innerText = needed > 0
            ? `${count} / 3 players — need ${needed} more`
            : `${count} players — ready!`;
        lbl.className = needed > 0 ? 'lobby-status' : 'lobby-status ready';
    }

    const startBtn = $('hostStartBtn');
    if (startBtn) {
        startBtn.disabled = count < 3;
        startBtn.innerText = count < 3 ? `Need \( {needed} more player \){needed > 1 ? 's' : ''}...` : "Start Game";
    }
}

function kickPlayer(name) {
    const kickedConn = net.connections.find(c => c._kickName === name);
    if (kickedConn) {
        try { kickedConn.send({ type: 'KICKED' }); } catch(e) {}
        setTimeout(() => { try { kickedConn.close(); } catch(e) {} }, 400);
        net.connections = net.connections.filter(c => c !== kickedConn);
    }
    room.players = room.players.filter(p => p !== name);
    broadcastToAll({ type: 'SYNC_LOBBY', players: room.players, category: room.currentCategory, playedQuestions: room.playedQuestions });
    updateLobbyUI();
    Vibrate.click();
}

// ── ROUND FLOW ─────────────────────────────────────────────────────────────────
function broadcastStartRound() {
    if (room.players.length < 3) { alert("Need at least 3 players!"); return; }

    // ── NEW: promote late joiners to full players for this round ──
    room.lateJoiners = [];

    // ── NEW: check round limit ──
    if (room.maxRounds !== 'unlimited' && room.roundCount >= room.maxRounds) {
        broadcastToAll({ type: 'GAME_OVER', scores: room.scores, lateJoiners: room.lateJoiners });
        return;
    }
    
    const pool = QUESTIONS[room.currentCategory] || QUESTIONS.spicy;
    const unusedQuestions = pool.filter(q => !room.playedQuestions.includes(q));
    
    if (unusedQuestions.length === 0) {
        broadcastToAll({ type: 'GAME_OVER', scores: room.scores, lateJoiners: room.lateJoiners });
        return;
    }
    
    const eligible = room.players.filter(p => p !== room.currentSubject);
    const subject  = eligible[Math.floor(Math.random() * eligible.length)];
    const raw      = unusedQuestions[Math.floor(Math.random() * unusedQuestions.length)];
    const prompt   = raw.replace(/\[Subject\]/g, subject);

    // ── NEW: increment round count ──
    room.roundCount++;

    // ── NEW: set activeWriters — everyone except subject ──
    room.activeWriters = room.players.filter(p => p !== subject && !p.startsWith('bot_late'));

    // ── NEW: make sure all players have a score entry ──
    room.players.forEach(p => {
        if (!(p in room.scores)) room.scores[p] = 0;
    });
    
    broadcastToAll({
        type: 'START_ROUND',
        subject,
        prompt,
        category: room.currentCategory,
        rawQuestion: raw,
        roundCount: room.roundCount,
        lateJoiners: room.lateJoiners
    });
}

function startRoundExecution() {
    $('lockInBtn').disabled  = false;
    $('lockInBtn').innerText = "Lock In Card";
    $('writerInput').value   = "";
    $('charCount').innerText = "0 / 120 words";

    if (net.role === 'host') {
        clearInterval(roundTimerInterval);
        timeRemaining = room.timeLimit;
        roundTimerInterval = setInterval(() => {
            broadcastToAll({ type: 'TIMER_TICK', t: timeRemaining });
            if (timeRemaining <= 0) {
                clearInterval(roundTimerInterval);
                if (net.myName !== room.currentSubject) {
                    const val = $('writerInput').value.trim();
                    if (!$('lockInBtn').disabled) {
                        $('writerInput').value = val || "*Ran out of time*";
                        submitWriterCard();
                    }
                }
            }
            timeRemaining--;
        }, 1000);

        room.players.forEach(p => {
            if (p.startsWith('bot') && p !== room.currentSubject) {
                setTimeout(() => {
                    const botAnswers = ["100% true.", "Classic behavior.", "Without a doubt.", "Secretly an expert.", "Probably under pressure."];
                    const txt = botAnswers[Math.floor(Math.random() * botAnswers.length)];
                    handleData({ type: 'SUBMIT_CARD', text: `[${p}] ${txt}`, creator: p }, null);
                }, 1000 + Math.random() * 1500);
            }
        });
    }

    if (net.myName === room.currentSubject) {
        $('subjectPromptLabel').innerText = room.currentPrompt;
        $('submissionTrackLabel').innerText = "0 cards locked in...";
        setupFidgets();
        showScreen('scrSubjectLounge');
    } else {
        $('writerCategoryLabel').innerText = room.currentCategory.toUpperCase();
        $('activePromptLabel').innerText   = room.currentPrompt;
        showScreen('scrWriterInput');
    }
}

function submitWriterCard() {
    if (net.myName === room.currentSubject) return;
    const txt = $('writerInput').value.trim();
    if (!txt) return;

    $('lockInBtn').disabled  = true;
    $('lockInBtn').innerText = "Locked ✓";

    const payload = { type: 'SUBMIT_CARD', text: txt, creator: net.myName };
    if (net.role === 'host') handleData(payload, null);
    else net.conn.send(payload);
}

// ── REVEAL STAGE ───────────────────────────────────────────────────────────────
function renderRevealStage() {
    if (window.hostWaitInterval) {
        clearInterval(window.hostWaitInterval);
        window.hostWaitInterval = null;
    }

    $('revealPromptLabel').innerText = room.currentPrompt;
    
    const pool = QUESTIONS[room.currentCategory] || QUESTIONS.spicy;
    const outOfPrompts = pool.every(q => room.playedQuestions.includes(q));
    const roundLimitReached = (room.maxRounds !== 'unlimited') && (room.roundCount >= room.maxRounds);
    const isMeSubject = (net.myName === room.currentSubject);
    const isHost = (net.role === 'host');
    const gameOver = outOfPrompts || roundLimitReached;

    let nextBtn = $('nextRoundBtn');

    if (gameOver) {
        if (isHost) {
            nextBtn.style.display = "block";
            nextBtn.disabled = false;
            nextBtn.innerText = roundLimitReached
                ? `End Game (Round \( {room.roundCount}/ \){room.maxRounds})`
                : "End Game (No Prompts Left)";
            nextBtn.onclick = () => broadcastToAll({ type: 'GAME_OVER', scores: room.scores, lateJoiners: room.lateJoiners });
        } else {
            nextBtn.style.display = "none";
        }
    } else {
        if (isHost || isMeSubject) {
            nextBtn.style.display = "block";
            nextBtn.disabled = false;
            
            let nextText = room.maxRounds === 'unlimited' 
                ? `Next Round (${room.roundCount})` 
                : `Next Round (\( {room.roundCount}/ \){room.maxRounds})`;

            if (isHost && !isMeSubject) {
                nextBtn.disabled = true;
                let secs = 10;
                nextBtn.innerText = nextText + ` (Waiting for Subject... ${secs}s)`;
                
                window.hostWaitInterval = setInterval(() => {
                    if (!$('scrRevealStage').classList.contains('active')) {
                        clearInterval(window.hostWaitInterval);
                        return;
                    }
                    secs--;
                    if (secs > 0) {
                        nextBtn.innerText = nextText + ` (Waiting for Subject... ${secs}s)`;
                    } else {
                        clearInterval(window.hostWaitInterval);
                        nextBtn.disabled = false;
                        nextBtn.innerText = nextText;
                    }
                }, 1000);

                nextBtn.onclick = () => {
                    clearInterval(window.hostWaitInterval);
                    nextBtn.disabled = true;
                    broadcastStartRound();
                };
            } else if (isHost && isMeSubject) {
                nextBtn.innerText = nextText;
                nextBtn.onclick = () => {
                    nextBtn.disabled = true;
                    broadcastStartRound();
                };
            } else if (isMeSubject && !isHost) {
                nextBtn.innerText = nextText;
                nextBtn.onclick = () => {
                    nextBtn.disabled = true;
                    nextBtn.innerText = "Starting...";
                    net.conn.send({ type: 'REQUEST_NEXT_ROUND' });
                };
            }
        } else {
            nextBtn.style.display = "none";
        }
    }

    $('revealInstructions').innerText = isMeSubject
        ? "Tap to flip, then choose your favourite!"
        : `${room.currentSubject} is judging...`;

    const container = $('cardsWrapper');
    container.innerHTML = "";

    room.cards.forEach((c, idx) => {
        const el = document.createElement('div');
        el.id = `rcard-${idx}`;
        container.appendChild(el);
        updateCardDOM(idx);

        el.onclick = () => {
            if (!isMeSubject) return;
            if (Date.now() - screenTransitionChangeTime < 500) return;
            
            if (!room.cards[idx].revealed) {
                Sound.play(300, 'triangle', 0.1);
                Vibrate.tap();
                room.cards[idx].revealedAt = Date.now();
                
                const payload = { type: 'FLIP_CARD', index: idx };
                if (net.role === 'host') broadcastToAll(payload);
                else {
                    room.cards[idx].revealed = true;
                    updateCardDOM(idx);
                    net.conn.send(payload);
                }
            } else if (!room.cards.some(card => card.selected)) {
                if (Date.now() - (room.cards[idx].revealedAt || 0) < 400) return;

                Sound.play(280, 'sine', 0.15);
                Vibrate.buzz([20, 30, 40]);
                const payload = { type: 'SELECT_CARD', index: idx };
                if (net.role === 'host') broadcastToAll(payload);
                else {
                    room.cards.forEach((c,i) => c.selected = (i === idx));
                    room.cards.forEach((_,i) => updateCardDOM(i));
                    net.conn.send(payload);
                }
            }
        };
    });

    showScreen('scrRevealStage');

    if (net.role === 'host' && room.currentSubject.startsWith('bot')) {
        let currentFlipIdx = 0;
        function autoProcessBotSubject() {
            if (!$('scrRevealStage').classList.contains('active')) return;
            
            if (currentFlipIdx < room.cards.length) {
                if (!room.cards[currentFlipIdx].revealed) {
                    room.cards[currentFlipIdx].revealed = true;
                    broadcastToAll({ type: 'FLIP_CARD', index: currentFlipIdx });
                }
                currentFlipIdx++;
                setTimeout(autoProcessBotSubject, 1500);
            } else {
                const checkUnselected = room.cards.every(c => !c.selected);
                if (checkUnselected && room.cards.length > 0) {
                    const winningIdx = Math.floor(Math.random() * room.cards.length);
                    room.cards.forEach((c, i) => c.selected = (i === winningIdx));
                    broadcastToAll({ type: 'SELECT_CARD', index: winningIdx });
                }
            }
        }
        setTimeout(autoProcessBotSubject, 2000);
    }
}

function updateCardDOM(idx) {
    const el = \( (`rcard- \){idx}`);
    if (!el) return;
    const c = room.cards[idx];
    const isMeSubject = (net.myName === room.currentSubject);

    if (c.selected) {
        el.className = "reveal-card selected";
        el.style.cssText = ""; 
        el.innerHTML = `<div>${c.text}</div><div class="author-reveal">👑 Written by: ${c.creator}</div>`;
    } else if (!c.revealed) {
        if (isMeSubject) {
            el.className = "reveal-card hidden-state";
            el.style.cssText = "";
            el.innerText = `HIDDEN CARD ${idx + 1}`;
        } else {
            el.className = "reveal-card hidden-state";
            el.style.borderStyle = "solid";
            el.innerHTML = `<div>${c.text}</div><div style="font-size: 11px; color: var(--title-pink); margin-top: 6px; font-weight: 700; letter-spacing: 0.5px;">🔒 HIDDEN FROM SUBJECT</div>`;
        }
    } else {
        el.className = "reveal-card";
        el.style.cssText = "";
        el.innerText = c.text;
    }
}

// ── GAME OVER / SCOREBOARD ────────────────────────────────────────────────────
function executeGameOverUI() {
    clearInterval(roundTimerInterval);
    room.roundActive = false;

    $('revealPromptLabel').innerText  = `Game Over — \( {room.roundCount} Round \){room.roundCount !== 1 ? 's' : ''} Played`;
    $('revealInstructions').innerText = "Final Scoreboard";

    // ── Build sorted scoreboard ──
    const humanPlayers = room.players.filter(p => !p.startsWith('bot'));
    const sorted = [...humanPlayers].sort((a, b) => (room.scores[b] || 0) - (room.scores[a] || 0));

    const medals = ['🥇', '🥈', '🥉'];
    const container = $('cardsWrapper');
    container.innerHTML = "";

    const board = document.createElement('div');
    board.className = 'scoreboard';

    const title = document.createElement('div');
    title.className = 'scoreboard-title';
    title.innerText = '🏆 Final Scores';
    board.appendChild(title);

    sorted.forEach((name, rank) => {
        const pts   = room.scores[name] || 0;
        const isMe  = name === net.myName;
        const isLate = room.lateJoiners.includes(name);

        const row = document.createElement('div');
        row.className = 'scoreboard-row' + (isMe ? ' scoreboard-row--me' : '');

        const left = document.createElement('div');
        left.className = 'scoreboard-left';

        const medal = document.createElement('span');
        medal.className = 'scoreboard-medal';
        medal.innerText = medals[rank] || `${rank + 1}.`;

        const nameEl = document.createElement('span');
        nameEl.className = 'scoreboard-name';
        nameEl.innerText = name + (isMe ? ' (you)' : '');

        if (isLate) {
            const badge = document.createElement('span');
            badge.className = 'late-badge';
            badge.innerText = 'late';
            nameEl.appendChild(badge);
        }

        left.appendChild(medal);
        left.appendChild(nameEl);

        const right = document.createElement('div');
        right.className = 'scoreboard-points';
        right.innerText = `\( {pts} pt \){pts !== 1 ? 's' : ''}`;

        row.appendChild(left);
        row.appendChild(right);
        board.appendChild(row);
    });

    container.appendChild(board);

    if (net.role === 'host') {
        $('nextRoundBtn').style.display = "block";
        $('nextRoundBtn').innerText = "Return to Lobby";
        $('nextRoundBtn').onclick = () => {
            room.playedQuestions = [];
            room.roundCount      = 0;
            room.scores          = {};
            room.lateJoiners     = [];
            broadcastToAll({
                type: 'SYNC_LOBBY',
                players: room.players,
                category: room.currentCategory,
                playedQuestions: [],
                maxRounds: room.maxRounds,
                roundCount: 0,
                scores: {},
                lateJoiners: []
            });
            showScreen('scrLobby');
        };
    } else {
        $('nextRoundBtn').style.display = "none";
    }

    showScreen('scrRevealStage');
}

function rebroadcast(payload, senderConn) {
    if (net.role === 'host') {
        net.connections.forEach(c => {
            if (c !== senderConn) { try { c.send(payload); } catch(e) {} }
        });
    }
}

// ── FIDGET TOYS ────────────────────────────────────────────────────────────────
function setupFidgets() {
    const clk = $('toyClicker');
    clk.innerText = "0";
    clk.onclick = () => {
        const n = parseInt(clk.innerText) + 1;
        clk.innerText = n;
        Sound.play(400 + (n % 10) * 20, 'triangle', 0.05);
        Vibrate.tap();
    };

    const tgl = $('toyToggle');
    tgl.classList.remove('on');
    tgl.onclick = () => {
        tgl.classList.toggle('on');
        Sound.play(150, 'sine', 0.05);
        Vibrate.click();
    };

    const bGrid = $('toyBubbleGrid');
    bGrid.innerHTML = "";
    for (let i = 0; i < 8; i++) {
        const b = document.createElement('div');
        b.className = "bubble";
        b.onclick = () => {
            if (!b.classList.contains('popped')) {
                b.classList.add('popped');
                Sound.play(600, 'sine', 0.02);
                Vibrate.pop();
                setTimeout(() => b.classList.remove('popped'), 3000);
            }
        };
        bGrid.appendChild(b);
    }
}
