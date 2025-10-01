// Ludo Online — Cross-board rules server (3 players)
// Node 18+.  npm i ws
import http from "http";
import { WebSocketServer } from "ws";
import { randomBytes } from "crypto";

const PORT = process.env.PORT || 8080;

// --- Game constants (classic) ---
const COLORS = ["red", "green", "blue"];          // 3 players; yellow shown only in UI
const TOKENS = 4;
const RING_LEN = 52;
const LANE_LEN = 6;
const START = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE_RING = new Set([0, 8, 13, 21, 26, 34, 39, 47]); // starts + rosettes

// token shape: { t: 'base' } | { t:'path', p: 0..57 } | { t:'home' }
// path index p is steps from START[color]:
//   0..51 -> ring; 52..57 -> private home lane; 57 is HOME.
const MAX_PATH = RING_LEN + LANE_LEN - 1; // 57

const rooms = new Map();

function makeRoom() {
  const id = randomBytes(3).toString("hex");
  const room = {
    id,
    players: [],                         // {id, ws|null, color, name, bot?:true}
    status: "waiting",                   // 'waiting' | 'playing' | 'finished'
    turnIdx: 0,
    dice: null,                          // die value while a move is pending
    lastRolls: {},                       // color -> n
    tokens: {},                          // color -> token[4]
    botTimer: null,
  };
  rooms.set(id, room);
  return room;
}

function getOrCreateRoom(roomId) {
  if (!roomId) return makeRoom();
  return rooms.get(roomId) || makeRoom();
}

function initColor(room, color) {
  room.tokens[color] = Array.from({ length: TOKENS }, () => ({ t: "base" }));
}

function serialize(room) {
  return {
    id: room.id,
    status: room.status,
    turnIdx: room.turnIdx,
    dice: room.dice,
    players: room.players.map(p => ({ id: p.id, color: p.color, name: p.name, bot: !!p.bot })),
    tokens: room.tokens,
    lastRolls: room.lastRolls,
  };
}
const current = r => r.players[r.turnIdx];
const nextTurn = r => { r.turnIdx = (r.turnIdx + 1) % r.players.length; r.dice = null; };
const rollDie = () => 1 + Math.floor(Math.random() * 6);

function ringTileFor(color, pathIndex) {
  return pathIndex < RING_LEN ? (START[color] + pathIndex) % RING_LEN : null;
}
function isHomeIndex(pathIndex) { return pathIndex === MAX_PATH; }

// --- ring occupancy for capture checks ---
function ringOccupancy(room) {
  const map = new Map(); // ringIdx -> [{color, tokenIdx}]
  for (const p of room.players) {
    const arr = room.tokens[p.color] || [];
    arr.forEach((tok, i) => {
      if (tok.t === "path" && tok.p < RING_LEN) {
        const ring = ringTileFor(p.color, tok.p);
        if (!map.has(ring)) map.set(ring, []);
        map.get(ring).push({ color: p.color, tokenIdx: i });
      }
    });
  }
  return map;
}

function captureAt(room, ringTile, landingColor) {
  if (SAFE_RING.has(ringTile)) return; // safe tiles cannot be captured
  const occ = ringOccupancy(room).get(ringTile) || [];
  for (const { color, tokenIdx } of occ) {
    if (color !== landingColor) room.tokens[color][tokenIdx] = { t: "base" };
  }
}

function validMoves(room, color, dice) {
  const moves = [];
  const arr = room.tokens[color] || [];
  for (let i = 0; i < arr.length; i++) {
    const tok = arr[i];
    if (tok.t === "home") continue;
    if (tok.t === "base") {
      if (dice === 6) moves.push(i); // spawn to path p=0
    } else if (tok.t === "path") {
      const dest = tok.p + dice;
      if (dest <= MAX_PATH) moves.push(i); // exact to 57 required
    }
  }
  return moves;
}

function applyMove(room, color, tokenIdx, dice) {
  const tok = room.tokens[color][tokenIdx];

  // spawn
  if (tok.t === "base") {
    if (dice !== 6) return false;
    const tile = ringTileFor(color, 0);
    captureAt(room, tile, color);
    room.tokens[color][tokenIdx] = { t: "path", p: 0 };
    return true;
  }

  if (tok.t === "path") {
    const dest = tok.p + dice;
    if (dest > MAX_PATH) return false; // must be exact to enter home

    if (dest < RING_LEN) {
      // still on ring
      const ring = ringTileFor(color, dest);
      captureAt(room, ring, color);
      room.tokens[color][tokenIdx] = { t: "path", p: dest };
      return true;
    }

    if (dest === MAX_PATH) {
      room.tokens[color][tokenIdx] = { t: "home" };
      return true;
    }

    // inside private lane (52..56)
    room.tokens[color][tokenIdx] = { t: "path", p: dest };
    return true;
  }

  return false;
}

function allHome(room, color) {
  return (room.tokens[color] || []).every(t => t.t === "home");
}

// --- bots (simple policy) ---
function maybeRunBotTurn(room) {
  const cp = current(room);
  if (!cp || !cp.bot || room.status !== "playing") return;
  if (room.botTimer) return;

  room.botTimer = setTimeout(() => {
    if (room.dice !== null) return;
    room.dice = rollDie();
    room.lastRolls[cp.color] = room.dice;
    broadcast(room, "rolled", { dice: room.dice, room: serialize(room) });

    const options = validMoves(room, cp.color, room.dice);
    if (options.length === 0) {
      nextTurn(room);
      broadcast(room, "state", { room: serialize(room) });
      clearTimeout(room.botTimer); room.botTimer = null;
      return maybeRunBotTurn(room);
    }

    // If 6, prefer spawning; otherwise move the farthest-along token.
    let idx = options[0];
    if (room.dice === 6) {
      const spawn = options.find(i => room.tokens[cp.color][i].t === "base");
      if (spawn !== undefined) idx = spawn;
    } else {
      idx = options.reduce((best, i) => {
        const bp = room.tokens[cp.color][best].t === "path" ? room.tokens[cp.color][best].p : -1;
        const ip = room.tokens[cp.color][i].t === "path" ? room.tokens[cp.color][i].p : -1;
        return ip > bp ? i : best;
      }, options[0]);
    }

    setTimeout(() => {
      applyMove(room, cp.color, idx, room.dice);
      if (allHome(room, cp.color)) {
        room.status = "finished";
        broadcast(room, "finished", { winner: cp.color, room: serialize(room) });
        clearTimeout(room.botTimer); room.botTimer = null;
        return;
      }
      if (room.dice !== 6) nextTurn(room);
      room.dice = null;
      broadcast(room, "state", { room: serialize(room) });
      clearTimeout(room.botTimer); room.botTimer = null;
      maybeRunBotTurn(room);
    }, 400);
  }, 400);
}

// --- networking ---
const server = http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Ludo cross server OK\n");
});
const wss = new WebSocketServer({ server });

function broadcast(room, type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  for (const p of room.players) if (p.ws) try { p.ws.send(msg); } catch {}
}

wss.on("connection", (ws) => {
  let room = null, me = null;

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "join") {
      room = getOrCreateRoom(msg.roomId);
      if (room.players.length >= 3) return ws.send(JSON.stringify({ type: "error", error: "Room full" }));

      const used = new Set(room.players.map(p => p.color));
      const color = COLORS.find(c => !used.has(c));
      if (!color) return ws.send(JSON.stringify({ type: "error", error: "Room full" }));

      me = { id: randomBytes(6).toString("hex"), color, name: msg.name || color, ws };
      room.players.push(me);
      if (!room.tokens[color]) initColor(room, color);
      if (room.players.length === 3 && room.status === "waiting") { room.status = "playing"; room.turnIdx = 0; }

      ws.send(JSON.stringify({ type: "joined", room: serialize(room), you: { id: me.id, color: me.color, name: me.name } }));
      broadcast(room, "state", { room: serialize(room) });
      maybeRunBotTurn(room);
      return;
    }

    if (msg.type === "addBot") {
      room = room || getOrCreateRoom(msg.roomId);
      if (room.players.length >= 3) return ws.send(JSON.stringify({ type: "error", error: "Room full" }));
      const used = new Set(room.players.map(p => p.color));
      const color = COLORS.find(c => !used.has(c));
      if (!color) return ws.send(JSON.stringify({ type: "error", error: "No color available" }));
      const bot = { id: randomBytes(6).toString("hex"), color, name: `CPU-${color}`, ws: null, bot: true };
      room.players.push(bot);
      if (!room.tokens[color]) initColor(room, color);
      if (room.players.length === 3 && room.status === "waiting") { room.status = "playing"; room.turnIdx = 0; }
      broadcast(room, "state", { room: serialize(room) });
      maybeRunBotTurn(room);
      return;
    }

    if (msg.type === "removeBot") {
      if (!room) return;
      const idx = room.players.findIndex(p => p.bot && (!msg.color || p.color === msg.color));
      if (idx !== -1) {
        const [p] = room.players.splice(idx, 1);
        delete room.tokens[p.color];
        delete room.lastRolls[p.color];
        if (room.turnIdx >= room.players.length) room.turnIdx = 0;
        if (room.players.length < 3 && room.status === "playing") room.status = "waiting";
        broadcast(room, "state", { room: serialize(room) });
      }
      return;
    }

    if (msg.type === "roll") {
      if (!room || !me) return;
      if (room.status !== "playing") return;
      if (current(room).id !== me.id) return;
      if (room.dice !== null) return; // guard

      room.dice = rollDie();
      room.lastRolls[me.color] = room.dice;
      broadcast(room, "rolled", { dice: room.dice, room: serialize(room) });

      const opts = validMoves(room, me.color, room.dice);
      if (opts.length === 0) {
        nextTurn(room);
        broadcast(room, "state", { room: serialize(room) });
        maybeRunBotTurn(room);
      }
      return;
    }

    if (msg.type === "move") {
      if (!room || !me) return;
      if (room.status !== "playing") return;
      if (current(room).id !== me.id) return;
      const d = room.dice; if (!d) return;

      const ok = applyMove(room, me.color, msg.tokenIdx, d);
      if (!ok) return ws.send(JSON.stringify({ type: "error", error: "Invalid move" }));

      if (allHome(room, me.color)) {
        room.status = "finished";
        return broadcast(room, "finished", { winner: me.color, room: serialize(room) });
      }

      if (d !== 6) nextTurn(room);
      room.dice = null;
      broadcast(room, "state", { room: serialize(room) });
      maybeRunBotTurn(room);
      return;
    }
  });

  ws.on("close", () => {
    if (!room || !me) return;
    room.players = room.players.filter(p => p.id !== me.id);
    if (room.players.length === 0) rooms.delete(room.id);
    else {
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      broadcast(room, "state", { room: serialize(room) });
      maybeRunBotTurn(room);
    }
  });
});

server.listen(PORT, () => console.log("Ludo cross server listening on :" + PORT));
