// Minimal Ludo (3-player) WebSocket server — ESM version
// Run: node server.mjs
// PORT from env or 10000

import http from "node:http";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

/* --------------------------- helpers --------------------------- */
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString().replace("T", " ").split(".")[0];
const deepClone = (x) => JSON.parse(JSON.stringify(x));
const randInt = (n) => Math.floor(Math.random() * n) + 1;

const COLORS = ["red", "green", "blue"];       // 3 players
const START_IDX = { red: 0, green: 13, yellow: 26, blue: 39 }; // ring index starts
const SAFE_TILES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);    // ring indices
const RING_LEN = 52;
const MAX_LANE = 57; // path positions: 0..51 on ring, 52..57 in lane (57 == home)

const onRingIndex = (color, p) => (START_IDX[color] + p) % RING_LEN;

/* ----------------------------- data ---------------------------- */
const rooms = new Map(); // id -> room

function newRoom(id) {
  return {
    id,
    status: "waiting",    // "waiting" | "playing" | "finished"
    players: [],          // [{ id, name, color, bot, _ws }]
    tokens: {},           // color -> 4 tokens { t: "base" | "path" | "home", p: number }
    turnIdx: 0,
    dice: null,
    lastRolls: {},        // color -> last rolled number
    createdAt: Date.now()
  };
}

function pickColor(taken) {
  for (const c of COLORS) if (!taken.includes(c)) return c;
  return null;
}

function ensureTokens(room) {
  for (const c of COLORS) {
    const exists = room.players.find(p => p.color === c);
    if (!exists) continue;
    if (!room.tokens[c] || room.tokens[c].length !== 4) {
      room.tokens[c] = [
        { t: "base", p: 0 },
        { t: "base", p: 0 },
        { t: "base", p: 0 },
        { t: "base", p: 0 },
      ];
    }
  }
}

/* --------------------------- networking ------------------------ */
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Ludo server is running.\n");
});

const wss = new WebSocketServer({ server });

// keep-alive so some hosts don’t drop the socket
const heartbeat = (ws) => { ws.isAlive = true; };
wss.on("connection", (ws) => { ws.isAlive = true; ws.on("pong", () => heartbeat(ws)); });
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 30000);

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p._ws && p._ws.readyState === p._ws.OPEN) {
      try { p._ws.send(data); } catch {}
    }
  }
}

function snapshot(room) {
  const players = room.players.map(p => ({
    id: p.id, name: p.name, color: p.color, bot: !!p.bot
  }));
  return {
    id: room.id,
    status: room.status,
    players,
    tokens: deepClone(room.tokens),
    turnIdx: room.turnIdx,
    dice: room.dice,
    lastRolls: deepClone(room.lastRolls),
  };
}

function sendJoined(ws, room, you) {
  ws.send(JSON.stringify({
    type: "joined",
    you: { id: you.id, name: you.name, color: you.color, bot: !!you.bot },
    room: snapshot(room)
  }));
}
const sendState = (room) => broadcast(room, { type: "state", room: snapshot(room) });

/* -------------------------- game rules ------------------------- */
function startGame(room) {
  room.status = "playing";
  room.turnIdx = 0;
  room.dice = null;
  room.lastRolls = {};
  room.tokens = {};
  ensureTokens(room);
  sendState(room);
  maybeDriveBot(room);
}

function nextTurn(room, { extraTurn = false } = {}) {
  if (!extraTurn) room.turnIdx = (room.turnIdx + 1) % room.players.length;
  room.dice = null;
  sendState(room);
  maybeDriveBot(room);
}

function occupantsOnRing(room, ringIdx) {
  const res = [];
  for (const c of COLORS) {
    const arr = room.tokens[c];
    if (!arr) continue;
    arr.forEach((tok, i) => {
      if (tok.t === "path" && tok.p < 52) {
        if (onRingIndex(c, tok.p) === ringIdx) res.push({ color: c, idx: i });
      }
    });
  }
  return res;
}

function canLeaveBase(room, color) {
  if (room.dice !== 6) return false;
  const startTile = onRingIndex(color, 0);
  const occ = occupantsOnRing(room, startTile);
  const same = occ.filter(o => o.color === color).length;
  // two of your own at start is a blockade; can’t enter
  return same < 2;
}

function captureIfAllowed(room, color, destP) {
  // only on ring (<52) and not a safe tile
  if (destP >= 52) return;
  const ringIdx = onRingIndex(color, destP);
  if (SAFE_TILES.has(ringIdx)) return;

  const victims = occupantsOnRing(room, ringIdx).filter(o => o.color !== color);
  for (const v of victims) {
    const tok = room.tokens[v.color][v.idx];
    if (!tok) continue;
    tok.t = "base";
    tok.p = 0;
  }
}

function hasAnyMove(room, color) {
  const toks = room.tokens[color] || [];
  if (canLeaveBase(room, color)) return true;
  return toks.some(t => t.t === "path" && (t.p + room.dice) <= MAX_LANE);
}

function tryMove(room, player, tokenIdx) {
  const color = player.color;
  const tok = room.tokens[color]?.[tokenIdx];
  if (!tok) return false;

  if (tok.t === "base") {
    if (!canLeaveBase(room, color)) return false;
    tok.t = "path";
    tok.p = 0;
    captureIfAllowed(room, color, tok.p);
    return true;
  }

  if (tok.t === "home") return false;

  if (tok.t === "path") {
    const target = tok.p + room.dice;
    if (target > MAX_LANE) return false;

    captureIfAllowed(room, color, target);
    tok.p = target;
    if (tok.p === MAX_LANE) { tok.t = "home"; tok.p = MAX_LANE; }
    return true;
  }

  return false;
}

function checkWin(room) {
  for (const p of room.players) {
    const arr = room.tokens[p.color] || [];
    const homeCount = arr.filter(t => t.t === "home").length;
    if (homeCount === 4) {
      room.status = "finished";
      sendState(room);
      broadcast(room, { type: "finished", winner: p.color, room: snapshot(room) });
      return true;
    }
  }
  return false;
}

function doRoll(room, player) {
  if (room.status !== "playing") return;
  if (room.players[room.turnIdx].id !== player.id) return;
  if (room.dice != null) return;

  const roll = randInt(6);
  room.dice = roll;
  room.lastRolls[player.color] = roll;
  sendState(room);

  // if no move with this roll: auto pass
  if (!hasAnyMove(room, player.color)) {
    setTimeout(() => nextTurn(room, { extraTurn: false }), 350);
    return;
  }

  // if bot: auto play
  maybeDriveBot(room);
}

function doMove(room, player, tokenIdx) {
  if (room.status !== "playing") return;
  if (room.players[room.turnIdx].id !== player.id) return;
  if (room.dice == null) return;

  const moved = tryMove(room, player, tokenIdx);
  if (!moved) return;

  const extra = room.dice === 6;
  if (checkWin(room)) return;

  nextTurn(room, { extraTurn: extra });
}

/* ---------------------------- bot ai --------------------------- */
function botPickMove(room, color) {
  const toks = room.tokens[color] || [];

  if (room.dice === 6) {
    const startable = toks.findIndex(t => t.t === "base");
    if (startable !== -1 && canLeaveBase(room, color)) return startable;
  }
  // try to finish
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "path" && t.p + room.dice === MAX_LANE) return i;
  }
  // first legal
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "path" && t.p + room.dice <= MAX_LANE) return i;
  }
  return -1;
}

function maybeDriveBot(room) {
  if (room.status !== "playing") return;
  const p = room.players[room.turnIdx];
  if (!p || !p.bot) return;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  (async () => {
    await sleep(350);
    if (room.dice == null) { doRoll(room, p); await sleep(280); }
    if (room.status !== "playing") return;

    const idx = botPickMove(room, p.color);
    if (idx >= 0) doMove(room, p, idx);
    else nextTurn(room, { extraTurn: false });
  })();
}

/* ------------------------- ws handlers ------------------------- */
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg = {};
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "join") {
      const rid = msg.roomId || uid().slice(0, 5);
      if (!rooms.has(rid)) rooms.set(rid, newRoom(rid));
      const room = rooms.get(rid);

      // assign color
      const color = pickColor(room.players.map(p => p.color));
      if (!color) {
        ws.send(JSON.stringify({ type: "error", error: "Room is full" }));
        return;
      }

      const player = {
        id: uid(),
        name: msg.name || color,
        color,
        bot: false,
        _ws: ws
      };
      room.players.push(player);

      ws._roomId = rid;
      ws._playerId = player.id;

      sendJoined(ws, room, player);
      sendState(room);

      if (room.players.length === 3 && room.status === "waiting") {
        startGame(room);
      }
      return;
    }

    // must be bound to a room
    const rid = ws._roomId;
    const pid = ws._playerId;
    if (!rid || !rooms.has(rid)) return;
    const room = rooms.get(rid);
    const player = room.players.find(p => p.id === pid);
    if (!player) return;

    if (msg.type === "roll") { doRoll(room, player); return; }
    if (msg.type === "move") {
      const idx = Number(msg.tokenIdx);
      if (Number.isInteger(idx)) doMove(room, player, idx);
      return;
    }
    if (msg.type === "addBot") {
      if (room.players.length >= 3 || room.status !== "waiting") return;
      const color = pickColor(room.players.map(p => p.color));
      if (!color) return;
      const bot = { id: uid(), name: `CPU-${color}`, color, bot: true, _ws: null };
      room.players.push(bot);
      sendState(room);
      if (room.players.length === 3 && room.status === "waiting") startGame(room);
      return;
    }
    if (msg.type === "removeBot") {
      if (room.status !== "waiting") return;
      for (let i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].bot) { room.players.splice(i, 1); break; }
      }
      sendState(room);
      return;
    }
  });

  ws.on("close", () => {
    const rid = ws._roomId;
    const pid = ws._playerId;
    if (!rid || !rooms.has(rid)) return;
    const room = rooms.get(rid);

    const idx = room.players.findIndex(p => p.id === pid);
    if (idx !== -1) room.players.splice(idx, 1);

    if (room.players.length === 0) { rooms.delete(rid); return; }

    if (room.status === "playing") {
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      room.dice = null; // reset pending roll so next player can roll
    }
    sendState(room);
  });
});

/* ---------------------------- start ---------------------------- */
server.listen(PORT, () => {
  console.log(`[${now()}] Ludo server listening on :${PORT}`);
});
