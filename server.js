const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();
const RECONNECT_GRACE_MS = 15000;
const AI_TURN_DELAY_MS = 1100;

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
  { id: "red", name: "Ruby", color: "#ea4335", start: 1, entry: 50, home: [52, 53, 54, 55, 56, 57] },
  { id: "blue", name: "Azure", color: "#4285f4", start: 14, entry: 11, home: [58, 59, 60, 61, 62, 63] },
  { id: "yellow", name: "Sunny", color: "#fbbc04", start: 27, entry: 24, home: [64, 65, 66, 67, 68, 69] },
  { id: "green", name: "Jade", color: "#34a853", start: 40, entry: 37, home: [70, 71, 72, 73, 74, 75] }
];

const HOME_ENTRY = 51;
const HOME_FINISH = 56;
const safeSquares = new Set([1, 9, 14, 22, 27, 35, 40, 48]);
const COLOR_DISTANCE_MINIMUM = 95;
const AI_FALLBACK_COLORS = [
  "#a142f4",
  "#00acc1",
  "#e91e63",
  "#ff6d00",
  "#7c4dff",
  "#00897b",
  "#c0ca33",
  "#8d6e63"
];

function createGame(roomCode) {
  return {
    roomCode,
    phase: "lobby",
    seats: players.map((player) => ({
      playerId: player.id,
      label: player.name,
      type: "ai",
      clientId: null,
      sessionId: null,
      disconnected: false,
      color: player.color
    })),
    hostSessionId: null,
    turn: 0,
    dice: null,
    rollId: 0,
    lastRoll: null,
    canRoll: true,
    winner: null,
    settings: {
      launchAssist: false
    },
    launchMisses: Object.fromEntries(players.map((player) => [player.id, 0])),
    log: ["Room created. Invite friends or let AI take the open seats."],
    tokens: Object.fromEntries(players.map((player) => [player.id, [-1, -1, -1, -1]]))
  };
}

function roomFor(code) {
  const roomCode = (code || "PLAY").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PLAY";
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { game: createGame(roomCode), clients: new Map(), disconnectTimers: new Map() });
  }
  return rooms.get(roomCode);
}

function publicState(game) {
  const dynamicPlayers = players.map((player, index) => ({
    ...player,
    color: game.seats[index]?.color || player.color
  }));

  return {
    ...game,
    players: dynamicPlayers,
    safeSquares: Array.from(safeSquares)
  };
}

function addLog(game, message) {
  game.log = [message, ...game.log].slice(0, 8);
}

function defaultColorForSeat(index) {
  return players[index]?.color || "#0b57d0";
}

function normalizeHexColor(value) {
  const color = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}

function hexToRgb(color) {
  const hex = color.replace("#", "");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function colorDistance(left, right) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function colorIsAvailable(game, color, allowedSeatIndex = -1) {
  return game.seats.every((seat, index) => {
    if (index === allowedSeatIndex || seat.type !== "human") return true;
    return colorDistance(seat.color || defaultColorForSeat(index), color) >= COLOR_DISTANCE_MINIMUM;
  });
}

function colorConflicts(color, takenColors) {
  return takenColors.some((used) => colorDistance(used, color) < COLOR_DISTANCE_MINIMUM);
}

function openAiColorForSeat(index, takenColors) {
  const candidates = [defaultColorForSeat(index), ...AI_FALLBACK_COLORS];
  return candidates.find((color) => !colorConflicts(color, takenColors)) || defaultColorForSeat(index);
}

function refreshAiSeatColors(game) {
  const takenColors = game.seats
    .map((seat, index) => seat.type === "human" ? seat.color || defaultColorForSeat(index) : null)
    .filter(Boolean);

  game.seats.forEach((seat, index) => {
    if (seat.type === "human") return;
    seat.color = openAiColorForSeat(index, takenColors);
    takenColors.push(seat.color);
  });
}

function preferredSeatIndex(game, message, sessionId) {
  const existingSeatIndex = game.seats.findIndex((seat) => seat.clientId === message.clientId || (sessionId && seat.sessionId === sessionId));
  if (existingSeatIndex >= 0) return existingSeatIndex;

  const hasRequestedSeat = message.seat !== null && message.seat !== undefined && message.seat !== "";
  const requested = hasRequestedSeat ? Number(message.seat) : NaN;
  if (Number.isInteger(requested) && requested >= 0 && requested < game.seats.length && game.seats[requested].type !== "human") {
    return requested;
  }

  const requestedColor = normalizeHexColor(message.color);
  if (requestedColor) {
    const matchingDefault = players.findIndex((player) => colorDistance(player.color, requestedColor) < 12);
    if (matchingDefault >= 0 && game.seats[matchingDefault].type !== "human") return matchingDefault;
  }

  return game.seats.findIndex((seat) => seat.type !== "human");
}

function currentSeat(game) {
  return game.seats[game.turn];
}

function isHumanTurn(game, clientId) {
  const seat = currentSeat(game);
  return seat && seat.type === "human" && seat.clientId === clientId && !seat.disconnected;
}

function isHostClient(game, clientId) {
  return game.seats.some((seat) => seat.clientId === clientId && seat.sessionId === game.hostSessionId);
}

function pathIndexFor(player, value) {
  if (value < 0 || value > HOME_FINISH) return null;
  if (value < HOME_ENTRY) return (player.start + value) % 52;
  return player.home[value - HOME_ENTRY];
}

function availableMoves(game, playerId, dice) {
  const player = players.find((item) => item.id === playerId);
  return game.tokens[playerId]
    .map((position, token) => {
      if (position === HOME_FINISH) return null;
      if (position === -1 && dice === 6) return { token, from: -1, to: 0, boardIndex: player.start };
      if (position >= 0 && position + dice <= HOME_FINISH) {
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

function hasNoLaunchedTokens(game, playerId) {
  return game.tokens[playerId].every((position) => position === -1);
}

function launchAssistToken(game, seat) {
  if (!game.settings?.launchAssist || !hasNoLaunchedTokens(game, seat.playerId)) return false;
  game.launchMisses[seat.playerId] = (game.launchMisses[seat.playerId] || 0) + 1;
  if (game.launchMisses[seat.playerId] < 6) return false;

  game.tokens[seat.playerId][0] = 0;
  game.launchMisses[seat.playerId] = 0;
  addLog(game, `${seat.label} received launch assist and entered token 1.`);
  return true;
}

function rollDice(game, clientId = null) {
  if (game.phase !== "playing" || game.winner || !game.canRoll) return;
  if (clientId && !isHumanTurn(game, clientId)) return;

  const seat = currentSeat(game);
  game.dice = 1 + Math.floor(Math.random() * 6);
  game.rollId += 1;
  game.lastRoll = {
    id: game.rollId,
    playerId: seat.playerId,
    value: game.dice
  };
  game.canRoll = false;
  addLog(game, `${seat.label} rolled a ${game.dice}.`);

  const moves = availableMoves(game, seat.playerId, game.dice);
  if (!moves.length) {
    const assisted = game.dice !== 6 && launchAssistToken(game, seat);
    if (!assisted) addLog(game, `${seat.label} has no legal move.`);
    nextTurn(game, game.dice === 6 || assisted);
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
  if (move.from === -1) game.launchMisses[seat.playerId] = 0;
  const captures = captureTokens(game, seat.playerId, move.boardIndex);
  const finished = move.to === HOME_FINISH;
  addLog(game, `${seat.label} moved token ${token + 1}${captures ? ` and captured ${captures}` : ""}.`);

  if (game.tokens[seat.playerId].every((position) => position === HOME_FINISH)) {
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
    setTimeout(() => aiMove(room), AI_TURN_DELAY_MS);
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
  setTimeout(() => aiMove(room), AI_TURN_DELAY_MS);
}

function scoreAiMove(game, playerId, move) {
  let score = move.to;
  if (move.to === HOME_FINISH) score += 100;
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
  game.rollId = 0;
  game.lastRoll = null;
  game.canRoll = true;
  game.winner = null;
  game.launchMisses = Object.fromEntries(players.map((player) => [player.id, 0]));
  game.tokens = Object.fromEntries(players.map((player) => [player.id, [-1, -1, -1, -1]]));
  addLog(game, game.settings?.launchAssist
    ? "Game started with launch assist. A 6th failed launch attempt enters one token."
    : "Game started with classic launch rules. Roll a six to launch a token.");
}

function broadcast(room) {
  const message = encodeFrame(JSON.stringify({ type: "state", state: publicState(room.game) }));
  for (const [clientId, socket] of room.clients.entries()) {
    if (!writeFrame(room, clientId, socket, message)) {
      removeClient(room, clientId);
    }
  }
}

function send(socket, payload) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(encodeFrame(JSON.stringify(payload)));
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

function writeFrame(room, clientId, socket, frame) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    socket.write(frame);
    return true;
  } catch {
    socket.destroy();
    room.clients.delete(clientId);
    return false;
  }
}

function removeClient(room, clientId, announce = true) {
  const socket = room.clients.get(clientId);
  room.clients.delete(clientId);
  if (socket && !socket.destroyed) socket.destroy();

  let hadSeat = false;
  for (const seat of room.game.seats) {
    if (seat.clientId === clientId) {
      hadSeat = true;
      seat.clientId = null;
      seat.disconnected = true;
      if (seat.sessionId) {
        const sessionId = seat.sessionId;
        clearTimeout(room.disconnectTimers.get(sessionId));
        room.disconnectTimers.set(sessionId, setTimeout(() => {
          if (!seat.clientId && seat.disconnected) {
            seat.type = "ai";
            seat.sessionId = null;
            seat.disconnected = false;
            seat.label = players.find((player) => player.id === seat.playerId).name;
            refreshAiSeatColors(room.game);
            addLog(room.game, "A disconnected player was replaced by AI.");
            broadcast(room);
            setTimeout(() => aiMove(room), AI_TURN_DELAY_MS);
          }
          room.disconnectTimers.delete(sessionId);
        }, RECONNECT_GRACE_MS));
      } else {
        seat.type = "ai";
        seat.disconnected = false;
        seat.label = players.find((player) => player.id === seat.playerId).name;
        refreshAiSeatColors(room.game);
      }
    }
  }

  if (announce && hadSeat) {
    addLog(room.game, "A player disconnected. Holding their seat briefly.");
  }

  return hadSeat;
}

function handleMessage(room, clientId, message) {
  const game = room.game;
  if (message.type === "join") {
    const sessionId = String(message.sessionId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
    const existingSeatIndex = game.seats.findIndex((seat) => seat.clientId === clientId || (sessionId && seat.sessionId === sessionId));
    const seatIndex = preferredSeatIndex(game, { ...message, clientId }, sessionId);
    if (seatIndex < 0 || seatIndex >= game.seats.length) {
      send(room.clients.get(clientId), { type: "error", message: "That room is full." });
      return;
    }
    const seat = game.seats[seatIndex] || game.seats[0];
    const wasAlreadySeated = existingSeatIndex >= 0;
    const requestedColor = normalizeHexColor(message.color) || seat.color || defaultColorForSeat(seatIndex);
    if (!colorIsAvailable(game, requestedColor, seatIndex)) {
      send(room.clients.get(clientId), { type: "error", message: "That colour is too close to another player." });
      return;
    }
    if (seat.sessionId) {
      clearTimeout(room.disconnectTimers.get(seat.sessionId));
      room.disconnectTimers.delete(seat.sessionId);
    }
    if (!game.hostSessionId) game.hostSessionId = sessionId;
    seat.type = "human";
    seat.clientId = clientId;
    seat.sessionId = sessionId || seat.sessionId;
    seat.disconnected = false;
    seat.label = (message.name || seat.label || "Player").trim().slice(0, 18);
    seat.color = requestedColor;
    refreshAiSeatColors(game);
    if (!wasAlreadySeated) {
      addLog(game, `${seat.label} joined as ${players[seatIndex].name}.`);
    }
  }

  if (message.type === "setSeat") {
    const seat = game.seats[message.seat];
    if (seat && (seat.clientId === clientId || seat.type === "ai")) {
      const wantsHuman = message.seatType === "human";
      const nextColor = wantsHuman ? normalizeHexColor(message.color) || seat.color : defaultColorForSeat(message.seat);
      if (wantsHuman && !colorIsAvailable(game, nextColor, message.seat)) {
        send(room.clients.get(clientId), { type: "error", message: "That colour is too close to another player." });
        return;
      }
      seat.type = wantsHuman ? "human" : "ai";
      seat.clientId = wantsHuman ? clientId : null;
      seat.sessionId = wantsHuman ? String(message.sessionId || seat.sessionId || "").slice(0, 64) : null;
      seat.disconnected = false;
      seat.color = nextColor;
      seat.label = wantsHuman ? (message.name || seat.label).trim().slice(0, 18) : players[message.seat].name;
      refreshAiSeatColors(game);
      addLog(game, `${players[message.seat].name} is now ${wantsHuman ? "a human seat" : "AI controlled"}.`);
    }
  }

  if (message.type === "settings" && game.phase === "lobby" && isHostClient(game, clientId)) {
    game.settings = {
      ...game.settings,
      launchAssist: Boolean(message.launchAssist)
    };
    addLog(game, game.settings.launchAssist ? "Launch assist rule enabled." : "Classic launch rule enabled.");
  }

  if (message.type === "start") startGame(game);
  if (message.type === "roll") rollDice(game, clientId);
  if (message.type === "move") moveToken(game, clientId, message.token);
  if (message.type === "reset") room.game = createGame(game.roomCode);

  const activeRoom = room;
  broadcast(activeRoom);
  setTimeout(() => aiMove(activeRoom), AI_TURN_DELAY_MS);
}

function serveFile(request, response) {
  const urlPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  if (urlPath.startsWith("/api/room/")) {
    const roomCode = urlPath.split("/").pop();
    const room = roomFor(roomCode);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(publicState(room.game)));
    return;
  }

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
  socket.on("error", () => {
    if (!socket.destroyed) socket.destroy();
  });

  if (request.headers.upgrade !== "websocket") {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  try {
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));
  } catch {
    socket.destroy();
    return;
  }

  const roomCode = new URL(request.url, `http://${request.headers.host}`).searchParams.get("room");
  const room = roomFor(roomCode);
  const clientId = crypto.randomUUID();
  room.clients.set(clientId, socket);
  socket.on("error", () => {
    const hadSeat = removeClient(room, clientId);
    if (hadSeat) broadcast(room);
  });
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
    const hadSeat = removeClient(room, clientId);
    if (hadSeat) {
      broadcast(room);
      setTimeout(() => aiMove(room), AI_TURN_DELAY_MS);
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Ludo Online Multiplayer running at http://localhost:${PORT}`);
  });
}

module.exports = {
  HOME_ENTRY,
  HOME_FINISH,
  availableMoves,
  colorDistance,
  createGame,
  pathIndexFor,
  players,
  refreshAiSeatColors,
  rollDice,
  server
};
