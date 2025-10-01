// Ludo Online (3-player) — WebSocket Server with simple AI bots
// Run:  node server.js
// Env:  Node 18+ (or 16 + ws)

import http from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';

const PORT = process.env.PORT || 8080;

/** Game constants **/
const COLORS = ['red', 'green', 'blue']; // enforced 3 players
const TRACK_LEN = 52; // ring length
// spaced starts for 3 players
const START_OFFSETS = { red: 0, green: 17, blue: 34 };
const TOKENS_PER_PLAYER = 4;

// safe squares (cannot capture on them), include each color's start square
const SAFE_SQUARES = new Set(Object.values(START_OFFSETS));

/** In-memory storage **/
const rooms = new Map(); // roomId -> room

function makeRoom() {
  const id = randomBytes(3).toString('hex');
  const room = {
    id,
    players: [], // {id, ws|null, color, name, bot?:true}
    status: 'waiting', // 'waiting' | 'playing' | 'finished'
    turnIdx: 0,
    dice: null,
    board: {},  // color -> [pos,..] length 4 ; pos = -1 (base) | 0..51 | 'home'
    homes: {},  // color -> count home
    botTimer: null,
    createdAt: Date.now()
  };
  rooms.set(id, room);
  return room;
}

function getOrCreateRoom(roomId) {
  if (!roomId) return makeRoom();
  const room = rooms.get(roomId);
  return room || makeRoom();
}

function serializeRoom(room) {
  return {
    id: room.id,
    status: room.status,
    turnIdx: room.turnIdx,
    dice: room.dice,
    players: room.players.map(p => ({ id: p.id, color: p.color, name: p.name, bot: !!p.bot })),
    board: room.board,
    homes: room.homes,
  };
}

function broadcast(room, type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  for (const p of room.players) {
    if (!p.ws) continue; // bots have no websocket
    try { p.ws.send(msg); } catch {}
  }
}

function nextTurn(room) {
  if (room.players.length === 0) return;
  room.turnIdx = (room.turnIdx + 1) % room.players.length;
  room.dice = null;
}

function currentPlayer(room) { return room.players[room.turnIdx]; }
function rollDie() { return 1 + Math.floor(Math.random() * 6); }

function initPlayerState(room, color) {
  room.board[color] = Array(TOKENS_PER_PLAYER).fill(-1);
  room.homes[color] = 0;
}

function allHome(room, color) { return room.homes[color] === TOKENS_PER_PLAYER; }

function tileIndexFor(color, rel) {
  return (START_OFFSETS[color] + rel) % TRACK_LEN;
}

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
    const arr = room.board[c];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === destTile) arr[i] = -1; // back to base
    }
  }
}

function applyMove(room, color, tokenIdx, steps) {
  const arr = room.board[color];
  let pos = arr[tokenIdx];

  if (pos === -1) {
    if (steps !== 6 || !canSpawn(room, color)) return false;
    const start = START_OFFSETS[color];
    arr[tokenIdx] = start;
    captureIfAny(room, color, start);
    return true;
  }

  const start = START_OFFSETS[color];
  const relFromStart = (pos - start + TRACK_LEN) % TRACK_LEN;
  const newRel = relFromStart + steps;
  const destTile = tileIndexFor(color, newRel % TRACK_LEN);

  // exact-landing home rule (MVP)
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
  const moves = [];
  const arr = room.board[color];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    if (p === 'home') continue;
    if (p === -1) {
      if (dice === 6 && canSpawn(room, color)) moves.push(i);
    } else {
      moves.push(i);
    }
  }
  return moves;
}

/* ------------ Bot helpers ------------ */
function maybeRunBotTurn(room) {
  const cp = currentPlayer(room);
  if (!cp || !cp.bot || room.status !== 'playing') return;
  if (room.botTimer) return; // already scheduled

  // schedule: roll -> decide -> move (with tiny delays for UX)
  room.botTimer = setTimeout(() => {
    room.dice = rollDie();
    broadcast(room, 'rolled', { dice: room.dice, room: serializeRoom(room) });

    const dice = room.dice;
    const color = cp.color;
    const options = validMoves(room, color, dice);

    if (options.length === 0) {
      if (dice !== 6) nextTurn(room);
      room.dice = null;
      broadcast(room, 'state', { room: serializeRoom(room) });
      clearTimeout(room.botTimer); room.botTimer = null;
      // chain if next player is also a bot
      maybeRunBotTurn(room);
      return;
    }

    // simple policy:
    // if 6 and spawn possible → spawn; else move the token farthest from start
    let tokenIdx = options[0];
    if (dice === 6) {
      const spawnIdx = options.find(i => room.board[color][i] === -1);
      if (spawnIdx !== undefined) tokenIdx = spawnIdx;
    } else {
      tokenIdx = options.reduce((best, i) => {
        const start = START_OFFSETS[color];
        const rel = room.board[color][i] === -1 ? -1
          : (room.board[color][i] - start + TRACK_LEN) % TRACK_LEN;
        const bestRel = room.board[color][best] === -1 ? -1
          : (room.board[color][best] - start + TRACK_LEN) % TRACK_LEN;
        return rel > bestRel ? i : best;
      }, options[0]);
    }

    setTimeout(() => {
      applyMove(room, color, tokenIdx, dice);

      if (allHome(room, color)) {
        room.status = 'finished';
        broadcast(room, 'finished', { winner: color, room: serializeRoom(room) });
        clearTimeout(room.botTimer); room.botTimer = null;
        return;
      }

      if (dice !== 6) nextTurn(room);
      room.dice = null;
      broadcast(room, 'state', { room: serializeRoom(room) });
      clearTimeout(room.botTimer); room.botTimer = null;
      // chain next bot turn if applicable
      maybeRunBotTurn(room);
    }, 600);
  }, 600);
}

/* ------------ Server ------------ */
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Ludo server OK\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let me = null; // {id,color,name,ws}

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // join {roomId?, name?}
    if (msg.type === 'join') {
      room = getOrCreateRoom(msg.roomId);
      if (room.players.length >= 3) {
        ws.send(JSON.stringify({ type: 'error', error: 'Room full' }));
        return;
      }

      // assign next available color
      const used = new Set(room.players.map(p => p.color));
      const color = COLORS.find(c => !used.has(c));
      if (!color) { ws.send(JSON.stringify({ type: 'error', error: 'Room full' })); return; }

      me = { id: randomBytes(6).toString('hex'), color, name: msg.name || color, ws };
      room.players.push(me);
      initPlayerState(room, color);

      if (room.players.length === 3 && room.status === 'waiting') {
        room.status = 'playing';
        room.turnIdx = 0;
        room.dice = null;
      }

      ws.send(JSON.stringify({
        type: 'joined',
        room: serializeRoom(room),
        you: { id: me.id, color: me.color, name: me.name }
      }));
      broadcast(room, 'state', { room: serializeRoom(room) });
      maybeRunBotTurn(room);
      return;
    }

    // add/remove bots
    if (msg.type === 'addBot') {
      room = room || getOrCreateRoom(msg.roomId);
      if (room.players.length >= 3) { ws.send(JSON.stringify({ type: 'error', error: 'Room full' })); return; }
      const used = new Set(room.players.map(p => p.color));
      const color = COLORS.find(c => !used.has(c));
      if (!color) { ws.send(JSON.stringify({ type: 'error', error: 'No color available' })); return; }
      const bot = { id: randomBytes(6).toString('hex'), color, name: msg.name || `CPU-${color}`, ws: null, bot: true };
      room.players.push(bot);
      initPlayerState(room, color);

      if (room.players.length === 3 && room.status === 'waiting') {
        room.status = 'playing';
        room.turnIdx = 0;
      }
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
        if (room.turnIdx >= room.players.length) room.turnIdx = 0;
        if (room.players.length < 3 && room.status === 'playing') room.status = 'waiting';
        broadcast(room, 'state', { room: serializeRoom(room) });
      }
      return;
    }

    // roll
    if (msg.type === 'roll') {
      if (!room || !me) return;
      if (room.status !== 'playing') return;
      if (currentPlayer(room).id !== me.id) return;
      room.dice = rollDie();
      broadcast(room, 'rolled', { dice: room.dice, room: serializeRoom(room) });
      return;
    }

    // move {tokenIdx}
    if (msg.type === 'move') {
      if (!room || !me) return;
      if (room.status !== 'playing') return;
      if (currentPlayer(room).id !== me.id) return;
      const d = room.dice;
      if (!d) return; // must roll first
      const tokenIdx = msg.tokenIdx;
      const ok = applyMove(room, me.color, tokenIdx, d);
      if (!ok) { ws.send(JSON.stringify({ type: 'error', error: 'Invalid move' })); return; }

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

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    room.players = room.players.filter(p => p.id !== me.id);
    if (room.players.length === 0) {
      rooms.delete(room.id);
    } else {
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      broadcast(room, 'state', { room: serializeRoom(room) });
      maybeRunBotTurn(room);
    }
  });
});

server.listen(PORT, () => {
  console.log('Ludo server listening on :' + PORT);
});
