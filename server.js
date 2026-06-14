const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const players = [
  { id: "red", name: "Ruby", color: "#ea4335", start: 0, entry: 50, home: [52, 53, 54, 55, 56, 57] },
  { id: "blue", name: "Azure", color: "#4285f4", start: 13, entry: 11, home: [58, 59, 60, 61, 62, 63] },
  { id: "yellow", name: "Sunny", color: "#fbbc04", start: 26, entry: 24, home: [64, 65, 66, 67, 68, 69] },
  { id: "green", name: "Jade", color: "#34a853", start: 39, entry: 37, home: [70, 71, 72, 73, 74, 75] }
];

const safeSquares = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

function createGame(roomCode) {
  return {
    roomCode,
    phase: "lobby",
    seats: players.map((player) => ({
      playerId: player.id,
      label: player.name,
      type: "ai",
      clientId: null
    })),
    turn: 0,
    dice: null,
    canRoll: true,
    winner: null,
    log: ["Room created. Invite friends or let AI take the open seats."],
    tokens: Object.fromEntries(players.map((player) => [player.id, [-1, -1, -1, -1]]))
  };
}

function roomFor(code) {
  const roomCode = (code || "PLAY").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PLAY";
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { game: createGame(roomCode), clients: new Map() });
  }
  return rooms.get(roomCode);
}

function publicState(game) {
  return {
    ...game,
    players,
    safeSquares: Array.from(safeSquares)
  };
}

function addLog(game, message) {
  game.log = [message, ...game.log].slice(0, 8);
}

function currentSeat(game) {
  return game.seats[game.turn];
}

function isHumanTurn(game, clientId) {
  const seat = currentSeat(game);
  return seat && seat.type === "human" && seat.clientId === clientId;
}

function pathIndexFor(player, value) {
  if (value < 0 || value > 57) return null;
  if (value < 52) return (player.start + value) % 52;
  return player.home[value - 52];
}

function availableMoves(game, playerId, dice) {
  const player = players.find((item) => item.id === playerId);
  return game.tokens[playerId]
    .map((position, token) => {
      if (position === 57) return null;
      if (position === -1 && dice === 6) return { token, from: -1, to: 0, boardIndex: player.start };
      if (position >= 0 && position + dice <= 57) {
        return { token, from: position, to: position + dice, boardIndex: pathIndexFor(player, position + dice) };
      }
      return null;
    })
    .filter(Boolean);
}

function nextTurn(game, keepTurn = false) {
  if (!keepTurn) game.turn = (game.turn + 1) % players.length;
  game.dice = null;
  game.canRoll = true;
}

function rollDice(game, clientId = null) {
  if (game.phase !== "playing" || game.winner || !game.canRoll) return;
  if (clientId && !isHumanTurn(game, clientId)) return;

  const seat = currentSeat(game);
  game.dice = 1 + Math.floor(Math.random() * 6);
  game.canRoll = false;
  addLog(game, `${seat.label} rolled a ${game.dice}.`);

  const moves = availableMoves(game, seat.playerId, game.dice);
  if (!moves.length) {
    addLog(game, `${seat.label} has no legal move.`);
    nextTurn(game, game.dice === 6);
  }
}

function captureTokens(game, moverId, boardIndex) {
  if (boardIndex === null || boardIndex > 51 || safeSquares.has(boardIndex)) return 0;
  let captured = 0;

  for (const player of players) {
    if (player.id === moverId) continue;
    game.tokens[player.id] = game.tokens[player.id].map((position) => {
      if (pathIndexFor(player, position) === boardIndex) {
        captured += 1;
        return -1;
      }
      return position;
    });
  }

  return captured;
}

function moveToken(game, clientId, token) {
  if (game.phase !== "playing" || game.winner || game.canRoll || game.dice === null) return;
  if (clientId && !isHumanTurn(game, clientId)) return;

  const seat = currentSeat(game);
  const moves = availableMoves(game, seat.playerId, game.dice);
  const move = moves.find((item) => item.token === token);
  if (!move) return;

  game.tokens[seat.playerId][token] = move.to;
  const captures = captureTokens(game, seat.playerId, move.boardIndex);
  const finished = move.to === 57;
  addLog(game, `${seat.label} moved token ${token + 1}${captures ? ` and captured ${captures}` : ""}.`);

  if (game.tokens[seat.playerId].every((position) => position === 57)) {
    game.winner = seat.playerId;
    game.phase = "finished";
    addLog(game, `${seat.label} wins the game.`);
    return;
  }

  nextTurn(game, game.dice === 6 || captures > 0 || finished);
}

function aiMove(room) {
  const { game } = room;
  if (game.phase !== "playing" || game.winner || currentSeat(game).type !== "ai") return;

  if (game.canRoll) {
    rollDice(game);
    broadcast(room);
    setTimeout(() => aiMove(room), 650);
    return;
  }

  const seat = currentSeat(game);
  const moves = availableMoves(game, seat.playerId, game.dice);
  if (!moves.length) return;

  const move = moves
    .map((item) => ({ ...item, score: scoreAiMove(game, seat.playerId, item) }))
    .sort((a, b) => b.score - a.score)[0];
  moveToken(game, null, move.token);
  broadcast(room);
  setTimeout(() => aiMove(room), 650);
}

function scoreAiMove(game, playerId, move) {
  let score = move.to;
  if (move.to === 57) score += 100;
  if (move.from === -1) score += 18;
  if (move.boardIndex !== null && safeSquares.has(move.boardIndex)) score += 8;

  for (const player of players) {
    if (player.id === playerId) continue;
    if (game.tokens[player.id].some((position) => pathIndexFor(player, position) === move.boardIndex)) score += 35;
  }

  return score;
}

function startGame(game) {
  game.phase = "playing";
  game.turn = 0;
  game.dice = null;
  game.canRoll = true;
  game.winner = null;
  game.tokens = Object.fromEntries(players.map((player) => [player.id, [-1, -1, -1, -1]]));
  addLog(game, "Game started. Roll a six to launch a token.");
}

function broadcast(room) {
  const message = encodeFrame(JSON.stringify({ type: "state", state: publicState(room.game) }));
  for (const socket of room.clients.values()) {
    socket.write(message);
  }
}

function send(socket, payload) {
  socket.write(encodeFrame(JSON.stringify(payload)));
}

function handleMessage(room, clientId, message) {
  const game = room.game;
  if (message.type === "join") {
    const requested = Number(message.seat);
    const existingSeatIndex = game.seats.findIndex((seat) => seat.clientId === clientId);
    const seatIndex = existingSeatIndex >= 0
      ? existingSeatIndex
      : Number.isInteger(requested)
        ? requested
        : game.seats.findIndex((seat) => seat.type !== "human");
    if (seatIndex < 0 || seatIndex >= game.seats.length) {
      send(room.clients.get(clientId), { type: "error", message: "That room is full." });
      return;
    }
    const seat = game.seats[seatIndex] || game.seats[0];
    const wasAlreadySeated = existingSeatIndex >= 0;
    seat.type = "human";
    seat.clientId = clientId;
    seat.label = (message.name || seat.label || "Player").trim().slice(0, 18);
    if (!wasAlreadySeated) {
      addLog(game, `${seat.label} joined as ${players[seatIndex].name}.`);
    }
  }

  if (message.type === "setSeat") {
    const seat = game.seats[message.seat];
    if (seat && (seat.clientId === clientId || seat.type === "ai")) {
      seat.type = message.seatType === "human" ? "human" : "ai";
      seat.clientId = seat.type === "human" ? clientId : null;
      seat.label = seat.type === "human" ? (message.name || seat.label).trim().slice(0, 18) : players[message.seat].name;
      addLog(game, `${players[message.seat].name} is now ${seat.type === "human" ? "a human seat" : "AI controlled"}.`);
    }
  }

  if (message.type === "start") startGame(game);
  if (message.type === "roll") rollDice(game, clientId);
  if (message.type === "move") moveToken(game, clientId, message.token);
  if (message.type === "reset") room.game = createGame(game.roomCode);

  const activeRoom = room;
  broadcast(activeRoom);
  setTimeout(() => aiMove(activeRoom), 650);
}

function serveFile(request, response) {
  const urlPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    response.end(data);
  });
}

function encodeFrame(message) {
  const payload = Buffer.from(message);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error("Message too large");
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const lengthByte = buffer[offset + 1];
    let length = lengthByte & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    }

    const masked = Boolean(lengthByte & 0x80);
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += masked ? 4 : 0;
    if (cursor + length > buffer.length) break;

    const payload = buffer.subarray(cursor, cursor + length);
    const decoded = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      decoded[index] = masked ? payload[index] ^ mask[index % 4] : payload[index];
    }
    messages.push(decoded.toString("utf8"));
    offset = cursor + length;
  }

  return messages;
}

const server = http.createServer(serveFile);

server.on("upgrade", (request, socket) => {
  if (request.headers.upgrade !== "websocket") {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const roomCode = new URL(request.url, `http://${request.headers.host}`).searchParams.get("room");
  const room = roomFor(roomCode);
  const clientId = crypto.randomUUID();
  room.clients.set(clientId, socket);
  send(socket, { type: "hello", clientId, state: publicState(room.game) });

  socket.on("data", (data) => {
    for (const frame of decodeFrames(data)) {
      try {
        handleMessage(room, clientId, JSON.parse(frame));
      } catch (error) {
        send(socket, { type: "error", message: "That move could not be handled." });
      }
    }
  });

  socket.on("close", () => {
    room.clients.delete(clientId);
    for (const seat of room.game.seats) {
      if (seat.clientId === clientId) {
        seat.type = "ai";
        seat.clientId = null;
        seat.label = players.find((player) => player.id === seat.playerId).name;
      }
    }
    addLog(room.game, "A player left. AI has taken over their seat.");
    broadcast(room);
    setTimeout(() => aiMove(room), 650);
  });
});

server.listen(PORT, () => {
  console.log(`Ludo Online Multiplayer running at http://localhost:${PORT}`);
});
