// Ludo Online (3-player) — WebSocket Server
// Run:  node server.js
// Env:  Node 18+ (or 16 + ws)

import http from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';

const PORT = process.env.PORT || 8080;

/** Game constants **/
const COLORS = ['red', 'green', 'blue']; // enforced 3 players
const TRACK_LEN = 52; // ring length
// each color start offset on the ring (spaced for 3 players)
const START_OFFSETS = { red: 0, green: 17, blue: 34 };
const TOKENS_PER_PLAYER = 4;

// safe squares (cannot capture on them), include each color's start square
const SAFE_SQUARES = new Set(Object.values(START_OFFSETS));

/** In-memory storage (use Redis/DB for production) **/
const rooms = new Map(); // roomId -> room

function makeRoom() {
  const id = randomBytes(3).toString('hex'); // short room id
  const room = {
    id,
    players: [], // {id, ws, color, name}
    status: 'waiting', // 'waiting' | 'playing' | 'finished'
    turnIdx: 0,
    dice: null,
    board: {}, // color -> [pos,..] length 4 ; pos = -1 (base) | 0..51 | 'home'
    homes: {}, // color -> count home
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
    players: room.players.map(p => ({ id: p.id, color: p.color, name: p.name })),
    board: room.board,
    homes: room.homes,
  };
}

function broadcast(room, type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  for (const p of room.players) {
    try { p.ws.send(msg); } catch {}
  }
}

function nextTurn(room) {
  if (room.players.length === 0) return;
  room.turnIdx = (room.turnIdx + 1) % room.players.length;
  room.dice = null;
}

function currentPlayer(room) {
  return room.players[room.turnIdx];
}

function rollDie() { return 1 + Math.floor(Math.random() * 6); }

function initPlayerState(room, color) {
  room.board[color] = Array(TOKENS_PER_PLAYER).fill(-1);
  room.homes[color] = 0;
}

function allHome(room, color) {
  return room.homes[color] === TOKENS_PER_PLAYER;
}

function tileIndexFor(color, rel) {
  // color’s path starts at its offset, moves forward on ring
  return (START_OFFSETS[color] + rel) % TRACK_LEN;
}

function canSpawn(room, color) {
  // if a token is in base and start tile not blocked by own token
  const start = START_OFFSETS[color];
  const own = room.board[color];
  if (!own.some(p => p === -1)) return false;
  // cannot spawn if start tile already has your token
  const occupiedBySelf = own.some(p => p === start);
  return !occupiedBySelf;
}

function captureIfAny(room, color, destTile) {
  if (SAFE_SQUARES.has(destTile)) return; // no capture on safe squares
  for (const c of COLORS) {
    if (c === color) continue;
    const arr = room.board[c];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === destTile) {
        arr[i] = -1; // back to base
      }
    }
  }
}

function applyMove(room, color, tokenIdx, steps) {
  const arr = room.board[color];
  let pos = arr[tokenIdx];

  if (pos === -1) {
    // spawn
    if (steps !== 6 || !canSpawn(room, color)) return false;
    const start = START_OFFSETS[color];
    arr[tokenIdx] = start;
    captureIfAny(room, color, start);
    return true;
  }

  // moving on ring; detect completing a full loop back to start square
  const start = START_OFFSETS[color];
  let relFromStart = (pos - start + TRACK_LEN) % TRACK_LEN; // 0 at start
  const newRel = relFromStart + steps;
  const destTile = tileIndexFor(color, newRel % TRACK_LEN);

  // Exact-landing home rule (MVP)
  if (destTile === start && newRel >= TRACK_LEN) {
    arr[tokenIdx] = 'home';
    room.homes[color]++;
    return true;
  }

  // Normal move on ring
  arr[tokenIdx] = destTile;
  captureIfAny(room, color, destTile);
  return true;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Ludo server OK\\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let me = null; // {id,color,name,ws}

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // {type:'join', roomId?, name?}
    if (msg.type === 'join') {
      room = getOrCreateRoom(msg.roomId);
      if (room.status !== 'waiting' && room.players.length >= 3) {
        ws.send(JSON.stringify({ type: 'error', error: 'Room full' }));
        return;
      }

      // assign next available color
      const used = new Set(room.players.map(p => p.color));
      const color = COLORS.find(c => !used.has(c));
      if (!color) {
        ws.send(JSON.stringify({ type: 'error', error: 'Room full' }));
        return;
      }

      me = { id: randomBytes(6).toString('hex'), color, name: msg.name || color, ws };
      room.players.push(me);
      initPlayerState(room, color);

      // auto-start when 3 players joined
      if (room.players.length === 3 && room.status === 'waiting') {
        room.status = 'playing';
        room.turnIdx = 0;
        room.dice = null;
      }

      ws.send(JSON.stringify({ type: 'joined', room: serializeRoom(room), you: { id: me.id, color: me.color, name: me.name } }));
      broadcast(room, 'state', { room: serializeRoom(room) });
      return;
    }

    // roll
    if (msg.type === 'roll') {
      if (!room || !me) return;
      if (room.status !== 'playing') return;
      if (currentPlayer(room).id !== me.id) return;
      const d = rollDie();
      room.dice = d;
      broadcast(room, 'rolled', { dice: d, room: serializeRoom(room) });
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
      if (!ok) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid move' }));
        return;
      }

      // check win
      if (allHome(room, me.color)) {
        room.status = 'finished';
        broadcast(room, 'finished', { winner: me.color, room: serializeRoom(room) });
        return;
      }

      // extra turn on 6
      if (d !== 6) nextTurn(room);
      room.dice = null;
      broadcast(room, 'state', { room: serializeRoom(room) });
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    // remove player
    room.players = room.players.filter(p => p.id !== me.id);
    if (room.players.length === 0) {
      rooms.delete(room.id);
    } else {
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      broadcast(room, 'state', { room: serializeRoom(room) });
    }
  });
});

server.listen(PORT, () => {
  console.log('Ludo server listening on :' + PORT);
});
