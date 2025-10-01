// Ludo Online — 3-player WebSocket server
// Features: bots, last-rolls, roll guard (no re-roll while pending), auto-pass
// Node 18+ recommended (or 16 + "ws")

import http from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';

const PORT = process.env.PORT || 8080;

/** Game constants **/
const COLORS = ['red', 'green', 'blue'];        // still 3 players
const TRACK_LEN = 52;                            // keep 52 for MVP
// Space starts like classic Ludo quarters (0/13/26/39). We skip Yellow (26) visually.
const START_OFFSETS = { red: 0, green: 13, blue: 39 };
const TOKENS_PER_PLAYER = 4;
// Safe squares: each color start
const SAFE_SQUARES = new Set(Object.values(START_OFFSETS));

/** In-memory rooms **/
const rooms = new Map();

function makeRoom() {
  const id = randomBytes(3).toString('hex');
  const room = {
    id,
    players: [],          // {id, ws|null, color, name, bot?:true}
    status: 'waiting',    // 'waiting' | 'playing' | 'finished'
    turnIdx: 0,
    dice: null,           // die value while a turn is pending a move
    board: {},            // color -> [ -1 | 0..51 | 'home', x4 ]
    homes: {},            // color -> number (0..4)
    lastRolls: {},        // color -> last die value (display on client)
    botTimer: null,
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function getOrCreateRoom(roomId) { return roomId ? (rooms.get(roomId) || makeRoom()) : makeRoom(); }

function serializeRoom(room) {
  return {
    id: room.id,
    status: room.status,
    turnIdx: room.turnIdx,
    dice: room.dice,
    players: room.players.map(p => ({ id: p.id, color: p.color, name: p.name, bot: !!p.bot })),
    board: room.board,
    homes: room.homes,
    lastRolls: room.lastRolls,
  };
}

function broadcast(room, type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  for (const p of room.players) {
    if (!p.ws) continue;
    try { p.ws.send(msg); } catch {}
  }
}

function currentPlayer(room) { return room.players[room.turnIdx]; }
function nextTurn(room) { room.turnIdx = (room.turnIdx + 1) % room.players.length; room.dice = null; }
function rollDie() { return 1 + Math.floor(Math.random() * 6); }

function initPlayerState(room, color) {
  room.board[color] = Array(TOKENS_PER_PLAYER).fill(-1);
  room.homes[color] = 0;
}

function allHome(room, color) { return room.homes[color] === TOKENS_PER_PLAYER; }
function tileIndexFor(color, rel) { return (START_OFFSETS[color] + rel) % TRACK_LEN; }

function canSpawn(room, color) {
  const start = START_OFFSETS[color];
  const own = room.board[color];
  if (!own.some(p => p === -1)) return false;
  const occupiedBySelf = own.some(p => p === start);
  return !occupiedBySelf;
}

function captureIfAny(room, color, destTile) {
  if (SAFE_SQUARES.has(destTile)) return;
  for (const c of COLORS) {
    if (c === color) continue;
    const arr = room.board[c] || [];
    for (let i = 0; i < arr.length; i++) if (arr[i] === destTile) arr[i] = -1;
  }
}

function applyMove(room, color, tokenIdx, steps) {
  const arr = room.board[color];
  const pos = arr[tokenIdx];

  // spawn from base
  if (pos === -1) {
    if (steps !== 6 || !canSpawn(room, color)) return false;
    const start = START_OFFSETS[color];
    arr[tokenIdx] = start;
    captureIfAny(room, color, start);
    return true;
  }

  // move on the 52-tile loop; “home” when exact landing back to start after >=1 loop
  const start = START_OFFSETS[color];
  const relFromStart = (pos - start + TRACK_LEN) % TRACK_LEN;
  const newRel = relFromStart + steps;
  const destTile = tileIndexFor(color, newRel % TRACK_LEN);

  if (destTile === start && newRel >= TRACK_LEN) {
    arr[tokenIdx] = 'home';
    room.homes[color]++;
    return true;
  }

  arr[tokenIdx] = destTile;
  captureIfAny(room, color, destTile);
  return true;
}

function validMoves(room, color, dice) {
  const arr = room.board[color];
  const moves = [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (p === 'home') continue;
    if (p === -1) { if (dice === 6 && canSpawn(room, color)) moves.push(i); }
    else moves.push(i);
  }
  return moves;
}

/* ---- Bot helpers ---- */
function maybeRunBotTurn(room) {
  const cp = currentPlayer(room);
  if (!cp || !cp.bot || room.status !== 'playing') return;
  if (room.botTimer) return;

  room.botTimer = setTimeout(() => {
    if (room.dice !== null) return; // safety

    // roll
    room.dice = rollDie();
    room.lastRolls[cp.color] = room.dice;
    broadcast(room, 'rolled', { dice: room.dice, room: serializeRoom(room) });

    const options = validMoves(room, cp.color, room.dice);
    if (options.length === 0) {
      nextTurn(room);
      room.dice = null;
      broadcast(room, 'state', { room: serializeRoom(room) });
      clearTimeout(room.botTimer); room.botTimer = null;
      return maybeRunBotTurn(room);
    }

    // trivial policy: spawn on 6 if possible; otherwise push farthest along
    let tokenIdx = options[0];
    if (room.dice === 6) {
      const spawnIdx = options.find(i => room.board[cp.color][i] === -1);
      if (spawnIdx !== undefined) tokenIdx = spawnIdx;
    } else {
      tokenIdx = options.reduce((best, i) => {
        const s = START_OFFSETS[cp.color];
        const rel = room.board[cp.color][i] === -1 ? -1 : (room.board[cp.color][i] - s + TRACK_LEN) % TRACK_LEN;
        const bestRel = room.board[cp.color][best] === -1 ? -1 : (room.board[cp.color][best] - s + TRACK_LEN) % TRACK_LEN;
        return rel > bestRel ? i : best;
      }, options[0]);
    }

    setTimeout(() => {
      applyMove(room, cp.color, tokenIdx, room.dice);

      if (allHome(room, cp.color)) {
        room.status = 'finished';
        broadcast(room, 'finished', { winner: cp.color, room: serializeRoom(room) });
        clearTimeout(room.botTimer); room.botTimer = null;
        return;
      }

      if (room.dice !== 6) nextTurn(room);
      room.dice = null;
      broadcast(room, 'state', { room: serializeRoom(room) });
      clearTimeout(room.botTimer); room.botTimer = null;
      return maybeRunBotTurn(room);
    }, 400);
  }, 400);
}

/* ---- HTTP + WebSocket server ---- */
const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Ludo server OK\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let me = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      room = getOrCreateRoom(msg.roomId);
      if (room.players.length >= 3) return ws.send(JSON.stringify({ type: 'error', error: 'Room full' }));

      const used = new Set(room.players.map(p => p.color));
      const color = COLORS.find(c => !used.has(c));
      if (!color) return ws.send(JSON.stringify({ type: 'error', error: 'Room full' }));

      me = { id: randomBytes(6).toString('hex'), color, name: msg.name || color, ws };
      room.players.push(me);
      initPlayerState(room, color);

      if (room.players.length === 3 && room.status === 'waiting') {
        room.status = 'playing'; room.turnIdx = 0; room.dice = null;
      }

      ws.send(JSON.stringify({ type: 'joined', room: serializeRoom(room), you: { id: me.id, color: me.color, name: me.name } }));
      broadcast(room, 'state', { room: serializeRoom(room) });
      maybeRunBotTurn(room);
      return;
    }

    if (msg.type === 'addBot') {
      room = room || getOrCreateRoom(msg.roomId);
      if (room.players.length >= 3) return ws.send(JSON.stringify({ type: 'error', error: 'Room full' }));
      const used = new Set(room.players.map(p => p.color));
      const color = COLORS.find(c => !used.has(c));
      if (!color) return ws.send(JSON.stringify({ type: 'error', error: 'No color available' }));
      const bot = { id: randomBytes(6).toString('hex'), color, name: msg.name || `CPU-${color}`, ws: null, bot: true };
      room.players.push(bot);
      initPlayerState(room, color);

      if (room.players.length === 3 && room.status === 'waiting') { room.status = 'playing'; room.turnIdx = 0; }
      broadcast(room, 'state', { room: serializeRoom(room) });
      maybeRunBotTurn(room);
      return;
    }

    if (msg.type === 'removeBot') {
      if (!room) return;
      const idx = room.players.findIndex(p => p.bot && (!msg.color || p.color === msg.color));
      if (idx !== -1) {
        const [p] = room.players.splice(idx, 1);
        delete room.board[p.color];
        delete room.homes[p.color];
        delete room.lastRolls[p.color];
        if (room.turnIdx >= room.players.length) room.turnIdx = 0;
        if (room.players.length < 3 && room.status === 'playing') room.status = 'waiting';
        broadcast(room, 'state', { room: serializeRoom(room) });
      }
      return;
    }

    // Human ROLL — with guard + auto-pass
    if (msg.type === 'roll') {
      if (!room || !me) return;
      if (room.status !== 'playing') return;
      if (currentPlayer(room).id !== me.id) return;
      if (room.dice !== null) return;  // guard: don’t allow re-roll while a move is pending

      room.dice = rollDie();
      room.lastRolls[me.color] = room.dice;
      broadcast(room, 'rolled', { dice: room.dice, room: serializeRoom(room) });

      const opts = validMoves(room, me.color, room.dice);
      if (opts.length === 0) {
        nextTurn(room);
        room.dice = null;
        broadcast(room, 'state', { room: serializeRoom(room) });
        maybeRunBotTurn(room);
      }
      return;
    }

    // Human MOVE
    if (msg.type === 'move') {
      if (!room || !me) return;
      if (room.status !== 'playing') return;
      if (currentPlayer(room).id !== me.id) return;
      const d = room.dice;
      if (!d) return; // must roll first

      const ok = applyMove(room, me.color, msg.tokenIdx, d);
      if (!ok) return ws.send(JSON.stringify({ type: 'error', error: 'Invalid move' }));

      if (allHome(room, me.color)) {
        room.status = 'finished';
        broadcast(room, 'finished', { winner: me.color, room: serializeRoom(room) });
        return;
      }

      if (d !== 6) nextTurn(room);
      room.dice = null;
      broadcast(room, 'state', { room: serializeRoom(room) });
      maybeRunBotTurn(room);
      return;
    }

    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  });

  ws.on('close', () => {
    if (!room || !me) return;
    room.players = room.players.filter(p => p.id !== me.id);
    if (room.players.length === 0) rooms.delete(room.id);
    else {
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      broadcast(room, 'state', { room: serializeRoom(room) });
      maybeRunBotTurn(room);
    }
  });
});

server.listen(PORT, () => console.log('Ludo server listening on :' + PORT));
