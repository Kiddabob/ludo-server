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
    players: room.players.map(p => ({ id: p.id, color: p.color, name: p.name, bot:
