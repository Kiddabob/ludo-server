// Minimal Ludo (3-player) server for ws:// / wss://
// Works with the client index.html we’ve been iterating on.
//
// Run locally:   node server.js
// PORT comes from env (Render) or defaults to 10000

const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

// ----- Helpers --------------------------------------------------------------

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString().replace('T',' ').split('.')[0];

function pickColor(taken) {
  const order = ["red", "green", "blue"]; // 3 players
  for (const c of order) if (!taken.includes(c)) return c;
  return null;
}

function deepClone(x){ return JSON.parse(JSON.stringify(x)); }

function randInt(n){ return Math.floor(Math.random()*n)+1; }

// Ring & rules expected by the client
const START_IDX = { red: 0, green: 13, yellow: 26, blue: 39 };
// Only 3 colors are in play
const COLORS = ["red", "green", "blue"];
const SAFE_TILES = new Set([0,8,13,21,26,34,39,47]); // on ring (0..51)
const RING_LEN = 52;
const MAX_LANE = 57; // 52..57, reaching 57 means Home

function onRingIndex(color, p) {
  // token.p is steps from its color's start
  return (START_IDX[color] + p) % RING_LEN;
}

function laneStep(color, p) {
  // convert p>=52 (lane) to lane position 0..5 then 57 is home
  return p - 52; // 0..5
}

// ----- Data -----------------------------------------------------------------

const rooms = new Map(); // roomId -> room

function newRoom(id) {
  return {
    id,
    status: "waiting", // "waiting" | "playing" | "finished"
    players: [],       // [{id,name,color,bot:true?}]
    tokens: {},        // color -> [{t:"base"|"path"|"home", p:number}]
    turnIdx: 0,
    dice: null,
    lastRolls: {},     // color -> last rolled number
    createdAt: Date.now()
  };
}

function ensureTokens(room) {
  // Create 4 tokens per color in base
  for (const c of COLORS) {
    if (!room.players.find(p => p.color === c)) continue;
    if (!room.tokens[c]) room.tokens[c] = [];
    if (room.tokens[c].length === 0) {
      room.tokens[c] = [
        { t: "base", p: 0 },
        { t: "base", p: 0 },
        { t: "base", p: 0 },
        { t: "base", p: 0 }
      ];
    }
  }
}

// ----- Networking ------------------------------------------------------------

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Ludo server is running.\n");
});

const wss = new WebSocket.Server({ server });

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p._ws && p._ws.readyState === WebSocket.OPEN) {
      p._ws.send(data);
    }
  }
}

function snapshot(room) {
  // Do not leak ws objects
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
    lastRolls: deepClone(room.lastRolls)
  };
}

function sendJoined(ws, room, you) {
  const msg = {
    type: "joined",
    you: { id: you.id, name: you.name, color: you.color, bot: !!you.bot },
    room: snapshot(room)
  };
  ws.send(JSON.stringify(msg));
}

function sendState(room) {
  broadcast(room, { type: "state", room: snapshot(room) });
}

// ----- Game mechanics --------------------------------------------------------

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

function nextTurn(room, { extraTurn=false } = {}) {
  if (!extraTurn) {
    room.turnIdx = (room.turnIdx + 1) % room.players.length;
  }
  room.dice = null;
  sendState(room);
  maybeDriveBot(room);
}

function canLeaveBase(room, color) {
  // Leaving base requires dice === 6 and start tile not blocked by your own "blockade" (two pieces on same ring tile).
  if (room.dice !== 6) return false;
  const startTile = onRingIndex(color, 0);
  const occ = occupantsOnRing(room, startTile);
  // same-color blockade prevents entering; one same-color piece is fine (stacking is allowed)
  const sameColorCount = occ.filter(o => o.color === color).length;
  return sameColorCount < 2;
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

function captureIfAllowed(room, color, destP) {
  // Only when still on ring (<52) and dest ring tile not safe
  if (destP >= 52) return;
  const ringIdx = onRingIndex(color, destP);
  if (SAFE_TILES.has(ringIdx)) return; // safe tile => no capture

  const victims = occupantsOnRing(room, ringIdx)
    .filter(o => o.color !== color);

  // Send all victims back to base
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
  // leave base?
  if (canLeaveBase(room, color)) return true;
  // move along path?
  return toks.some(tok => tok.t === "path" && (tok.p + room.dice) <= MAX_LANE);
}

function tryMove(room, player, tokenIdx) {
  const color = player.color;
  const tok = room.tokens[color]?.[tokenIdx];
  if (!tok) return false;

  // base -> start on dice=6
  if (tok.t === "base") {
    if (!canLeaveBase(room, color)) return false;
    tok.t = "path";
    tok.p = 0; // on your start ring tile
    captureIfAllowed(room, color, tok.p);
    return true;
  }

  if (tok.t === "home") return false;

  if (tok.t === "path") {
    const target = tok.p + room.dice;
    if (target > MAX_LANE) return false;

    // Move with capture if still on ring
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
  // 4 home tokens = win
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
  if (room.dice != null) return; // already rolled

  const roll = randInt(6);
  room.dice = roll;
  room.lastRolls[player.color] = roll;
  sendState(room);

  // If player has no move with this roll, pass immediately.
  if (!hasAnyMove(room, player.color)) {
    setTimeout(() => nextTurn(room, { extraTurn: false }), 350);
    return;
  }

  // If bot, decide and move.
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

// Basic bot logic: prefer base -> start on 6, else move the furthest token that can reach home, else first movable.
function botPickMove(room, color) {
  const toks = room.tokens[color] || [];
  if (room.dice === 6) {
    // prefer leave base if possible
    const startable = toks.findIndex(t => t.t === "base");
    if (startable !== -1 && canLeaveBase(room, color)) return startable;
  }
  // try to finish (reach home)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "path" && t.p + room.dice === MAX_LANE) return i;
  }
  // first legal path move
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "path" && t.p + room.dice <= MAX_LANE) return i;
  }
  // fallback: if dice is 6 and we couldn't leave base because of blockade, no move
  return -1;
}

function maybeDriveBot(room) {
  if (room.status !== "playing") return;
  const p = room.players[room.turnIdx];
  if (!p || !p.bot) return;

  // Bot timing
  const think = (ms) => new Promise(r => setTimeout(r, ms));

  (async () => {
    await think(350);
    if (room.dice == null) {
      // roll
      doRoll(room, p);
      await think(300);
    }
    if (room.status !== "playing") return;

    const idx = botPickMove(room, p.color);
    if (idx >= 0) {
      doMove(room, p, idx);
    } else {
      // no legal move, pass turn
      nextTurn(room, { extraTurn: false });
    }
  })();
}

// ----- WebSocket handlers ----------------------------------------------------

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg = {};
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const type = msg.type;

    if (type === "join") {
      let rid = msg.roomId || uid().slice(0,5);
      if (!rooms.has(rid)) rooms.set(rid, newRoom(rid));
      const room = rooms.get(rid);

      // Assign color
      const taken = room.players.map(p => p.color);
      const color = pickColor(taken);
      if (!color) {
        ws.send(JSON.stringify({ type: "error", error: "Room is full" }));
        return;
      }

      const player = {
        id: uid(),
        name: (msg.name || color),
        color,
        bot: false,
        _ws: ws
      };
      room.players.push(player);

      // Bind WS -> room/player
      ws._roomId = rid;
      ws._playerId = player.id;

      sendJoined(ws, room, player);
      sendState(room);

      // Start when we have 3 players
      if (room.players.length === 3 && room.status === "waiting") {
        startGame(room);
      }
      return;
    }

    // Everything below needs a bound room
    const rid = ws._roomId;
    const pid = ws._playerId;
    if (!rid || !rooms.has(rid)) return;
    const room = rooms.get(rid);
    const player = room.players.find(p => p.id === pid);
    if (!player) return;

    if (type === "roll") {
      doRoll(room, player);
      return;
    }

    if (type === "move") {
      const idx = Number(msg.tokenIdx);
      if (Number.isInteger(idx)) doMove(room, player, idx);
      return;
    }

    if (type === "addBot") {
      if (room.players.length >= 3 || room.status !== "waiting") return;
      const color = pickColor(room.players.map(p => p.color));
      if (!color) return;
      const bot = { id: uid(), name: `CPU-${color}`, color, bot: true, _ws: null };
      room.players.push(bot);
      sendState(room);
      if (room.players.length === 3 && room.status === "waiting") {
        startGame(room);
      }
      return;
    }

    if (type === "removeBot") {
      // remove last bot if waiting
      if (room.status !== "waiting") return;
      for (let i = room.players.length - 1; i >= 0; i--) {
        if (room.players[i].bot) {
          room.players.splice(i, 1);
          break;
        }
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
    // Remove player
    const idx = room.players.findIndex(p => p.id === pid);
    if (idx !== -1) room.players.splice(idx, 1);

    // If room empty, delete it
    if (room.players.length === 0) {
      rooms.delete(rid);
      return;
    }

    // If playing and current player left, normalize turn
    if (room.status === "playing") {
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      room.dice = null; // reset pending roll
    }

    sendState(room);
  });
});

// ----- Start HTTP/WS --------------------------------------------------------

server.listen(PORT, () => {
  console.log(`[${now()}] Ludo server listening on :${PORT}`);
});
