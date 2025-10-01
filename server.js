// server.js  — ESM version (works when package.json has "type": "module")

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

/* ---------- Helpers ---------- */

// random UUID that works on any Node
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

const now = () => new Date().toISOString().replace("T", " ").split(".")[0];

function pickColor(taken) {
  const order = ["red", "green", "blue"];
  for (const c of order) if (!taken.includes(c)) return c;
  return null;
}

const deepClone = (x) => JSON.parse(JSON.stringify(x));
const randInt = (n) => Math.floor(Math.random() * n) + 1;

// Ring & rules expected by the client
const START_IDX = { red: 0, green: 13, yellow: 26, blue: 39 };
const COLORS = ["red", "green", "blue"];               // 3-player game
const SAFE_TILES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const RING_LEN = 52;
const MAX_LANE = 57; // 52..57, exact 57 => home

const onRingIndex = (color, p) => (START_IDX[color] + p) % RING_LEN;

/* ---------- Room state ---------- */

const rooms = new Map(); // roomId -> room

function newRoom(id) {
  return {
    id,
    status: "waiting",   // "waiting" | "playing" | "finished"
    players: [],         // [{id,name,color,bot?, _ws?}]
    tokens: {},          // color -> [{t:"base"|"path"|"home", p:number}]
    turnIdx: 0,
    dice: null,
    lastRolls: {},
    createdAt: Date.now(),
  };
}

function ensureTokens(room) {
  for (const c of COLORS) {
    if (!room.players.find((p) => p.color === c)) continue;
    if (!room.tokens[c] || room.tokens[c].length === 0) {
      room.tokens[c] = [
        { t: "base", p: 0 },
        { t: "base", p: 0 },
        { t: "base", p: 0 },
        { t: "base", p: 0 },
      ];
    }
  }
}

/* ---------- Networking ---------- */

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Ludo server is running.\n");
});

const wss = new WebSocketServer({ server });

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p._ws && p._ws.readyState === WebSocket.OPEN) p._ws.send(data);
  }
}

function snapshot(room) {
  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    bot: !!p.bot,
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
  ws.send(
    JSON.stringify({
      type: "joined",
      you: { id: you.id, name: you.name, color: you.color, bot: !!you.bot },
      room: snapshot(room),
    })
  );
}

const sendState = (room) => broadcast(room, { type: "state", room: snapshot(room) });

/* ---------- Game mechanics ---------- */

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

function occupantsOnRing(room, ringTileIdx) {
  const res = [];
  for (const c of COLORS) {
    const arr = room.tokens[c];
    if (!arr) continue;
    arr.forEach((tok, idx) => {
      if (tok.t === "path" && tok.p < 52) {
        if (onRingIndex(c, tok.p) === ringTileIdx) res.push({ color: c, idx });
      }
    });
  }
  return res;
}

function canLeaveBase(room, color) {
  if (room.dice !== 6) return false;
  const startTile = onRingIndex(color, 0);
  const occ = occupantsOnRing(room, startTile);
  const sameColorCount = occ.filter((o) => o.color === color).length;
  return sameColorCount < 2; // two of your own already there (blockade) -> cannot enter
}

function captureIfAllowed(room, color, destP) {
  if (destP >= 52) return; // lanes: no capture
  const ringIdx = onRingIndex(color, destP);
  if (SAFE_TILES.has(ringIdx)) return;
  const victims = occupantsOnRing(room, ringIdx).filter((o) => o.color !== color);
  for (const v of victims) {
    const tok = room.tokens[v.color][v.idx];
    if (tok) {
      tok.t = "base";
      tok.p = 0;
    }
  }
}

function hasAnyMove(room, color) {
  const toks = room.tokens[color] || [];
  if (canLeaveBase(room, color)) return true;
  return toks.some((tok) => tok.t === "path" && tok.p + room.dice <= MAX_LANE);
}

function tryMove(room, player, tokenIdx) {
  const color = player.color;
  const tok = room.tokens[color]?.[tokenIdx];
  if (!tok) return false;

  if (tok.t === "base") {
    if (!canLeaveBase(room, color)) return false;
    tok.t = "path";
    tok.p = 0; // start tile
    captureIfAllowed(room, color, tok.p);
    return true;
  }

  if (tok.t === "home") return false;

  if (tok.t === "path") {
    const target = tok.p + room.dice;
    if (target > MAX_LANE) return false;
    captureIfAllowed(room, color, target);
    tok.p = target;
    if (tok.p === MAX_LANE) {
      tok.t = "home";
      tok.p = MAX_LANE;
    }
    return true;
  }
  return false;
}

function checkWin(room) {
  for (const p of room.players) {
    const homeCount = (room.tokens[p.color] || []).filter((t) => t.t === "home").length;
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

  if (!hasAnyMove(room, player.color)) {
    setTimeout(() => nextTurn(room, { extraTurn: false }), 350);
    return;
  }

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

// very basic bot
function botPickMove(room, color) {
  const toks = room.tokens[color] || [];
  if (room.dice === 6) {
    const startable = toks.findIndex((t) => t.t === "base");
    if (startable !== -1 && canLeaveBase(room, color)) return startable;
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "path" && t.p + room.dice === MAX_LANE) return i;
  }
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

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    await wait(350);
    if (room.dice == null) {
      doRoll(room, p);
      await wait(300);
    }
    if (room.status !== "playing") return;

    const idx = botPickMove(room, p.color);
    if (idx >= 0) doMove(room, p, idx);
    else nextTurn(room, { extraTurn: false });
  })();
}

/* ---------- WebSocket handlers ---------- */

wss.on("connection", (ws) => {
  ws.on("message", (buf) => {
    let msg = {};
    try { msg = JSON.parse(String(buf)); } catch { return; }

    const type = msg.type;

    if (type === "join") {
      const rid = msg.roomId || uid().slice(0, 5);
      if (!rooms.has(rid)) rooms.set(rid, newRoom(rid));
      const room = rooms.get(rid);

      const color = pickColor(room.players.map((p) => p.color));
      if (!color) {
        ws.send(JSON.stringify({ type: "error", error: "Room is full" }));
        return;
      }
      const player = { id: uid(), name: msg.name || color, color, bot: false, _ws: ws };
      room.players.push(player);

      ws._roomId = rid;
      ws._playerId = player.id;

      sendJoined(ws, room, player);
      sendState(room);

      if (room.players.length === 3 && room.status === "waiting") startGame(room);
      return;
    }

    const rid = ws._roomId;
    const pid = ws._playerId;
    if (!rid || !rooms.has(rid)) return;
    const room = rooms.get(rid);
    const player = room.players.find((p) => p.id === pid);
    if (!player) return;

    if (type === "roll") { doRoll(room, player); return; }
    if (type === "move") {
      const i = Number(msg.tokenIdx);
      if (Number.isInteger(i)) doMove(room, player, i);
      return;
    }

    if (type === "addBot") {
      if (room.players.length >= 3 || room.status !== "waiting") return;
      const color = pickColor(room.players.map((p) => p.color));
      if (!color) return;
      const bot = { id: uid(), name: `CPU-${color}`, color, bot: true, _ws: null };
      room.players.push(bot);
      sendState(room);
      if (room.players.length === 3 && room.status === "waiting") startGame(room);
      return;
    }

    if (type === "removeBot") {
      if (room.status !== "waiting") return;
      for (let i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].bot) { room.players.splice(i, 1); break; }
      }
      sendState(room);
    }
  });

  ws.on("close", () => {
    const rid = ws._roomId;
    const pid = ws._playerId;
    if (!rid || !rooms.has(rid)) return;
    const room = rooms.get(rid);

    const idx = room.players.findIndex((p) => p.id === pid);
    if (idx !== -1) room.players.splice(idx, 1);

    if (room.players.length === 0) { rooms.delete(rid); return; }

    if (room.status === "playing") {
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      room.dice = null;
    }
    sendState(room);
  });
});

/* ---------- Start ---------- */

server.listen(PORT, () => {
  console.log(`[${now()}] Ludo server listening on :${PORT}`);
});
