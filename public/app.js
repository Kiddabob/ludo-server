const colors = {
  red: "#ea4335",
  blue: "#4285f4",
  yellow: "#fbbc04",
  green: "#34a853"
};

const board = document.querySelector("#board");
const seatsEl = document.querySelector("#seats");
const logEl = document.querySelector("#log");
const turnLabel = document.querySelector("#turnLabel");
const diceValue = document.querySelector("#diceValue");
const rollButton = document.querySelector("#rollDice");
const startButton = document.querySelector("#startGame");
const resetButton = document.querySelector("#resetGame");
const statusChip = document.querySelector("#connectionStatus");
const setupScreen = document.querySelector("#setupScreen");
const gameShell = document.querySelector("#gameShell");
const setupForm = document.querySelector("#setupForm");
const setupNameInput = document.querySelector("#setupName");
const setupRoomCodeInput = document.querySelector("#setupRoomCode");
const hostRoomButton = document.querySelector("#hostRoom");
const leaveRoomButton = document.querySelector("#leaveRoom");
const themeToggleButton = document.querySelector("#themeToggle");
const playerNameDisplay = document.querySelector("#playerNameDisplay");
const copyInviteButton = document.querySelector("#copyInvite");
const roomBadge = document.querySelector("#roomBadge");
const turnHint = document.querySelector("#turnHint");
const toast = document.querySelector("#toast");
const celebration = document.querySelector("#celebration");

const outerTrack = [
  [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], [7, 14],
  [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7],
  [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0], [7, 0]
];

const homeLanes = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  blue: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  green: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]]
};

const yards = {
  red: [[1, 1], [1, 4], [4, 1], [4, 4]],
  blue: [[1, 10], [1, 13], [4, 10], [4, 13]],
  yellow: [[10, 10], [10, 13], [13, 10], [13, 13]],
  green: [[10, 1], [10, 4], [13, 1], [13, 4]]
};

const homes = {
  red: { rows: [0, 1, 2, 3, 4, 5], cols: [0, 1, 2, 3, 4, 5] },
  blue: { rows: [0, 1, 2, 3, 4, 5], cols: [9, 10, 11, 12, 13, 14] },
  yellow: { rows: [9, 10, 11, 12, 13, 14], cols: [9, 10, 11, 12, 13, 14] },
  green: { rows: [9, 10, 11, 12, 13, 14], cols: [0, 1, 2, 3, 4, 5] }
};

let socket;
let clientId;
let state;
let currentRoom = "";
let playerName = "Player";
let celebratedWinner = null;
let reconnectTimer;
let connectionToken = 0;
let shouldReconnect = false;
let lastTurnSignature = "";
let lastDice = null;
let previousState = null;
const sessionId = getSessionId();
const safeSquareIndexes = [0, 8, 13, 21, 26, 34, 39, 47];
const safeSquareColors = {
  0: "red",
  8: "red",
  13: "blue",
  21: "blue",
  26: "yellow",
  34: "yellow",
  39: "green",
  47: "green"
};

function key(row, col) {
  return `${row}-${col}`;
}

function createBoard() {
  board.innerHTML = "";
  const trackKeys = new Set(outerTrack.map(([row, col]) => key(row, col)));
  const safeKeys = new Map(safeSquareIndexes.map((index) => [key(...outerTrack[index]), safeSquareColors[index]]));
  const laneKeys = new Map();
  for (const [player, cells] of Object.entries(homeLanes)) {
    cells.forEach(([row, col], index) => laneKeys.set(key(row, col), { player, index }));
  }

  for (let row = 0; row < 15; row += 1) {
    for (let col = 0; col < 15; col += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.key = key(row, col);
      cell.style.gridRow = row + 1;
      cell.style.gridColumn = col + 1;

      const home = Object.entries(homes).find(([, area]) => area.rows.includes(row) && area.cols.includes(col));
      const lane = laneKeys.get(key(row, col));

      if (row >= 6 && row <= 8 && col >= 6 && col <= 8) {
        cell.classList.add("center");
      } else if (lane) {
        cell.classList.add("path", "home", `home-${lane.player}`);
      } else if (trackKeys.has(key(row, col))) {
        cell.classList.add("path");
        if (safeKeys.has(key(row, col))) cell.classList.add("safe", `safe-${safeKeys.get(key(row, col))}`);
      } else if (home) {
        cell.classList.add("yard", `yard-${home[0]}`);
      }

      board.appendChild(cell);
    }
  }
}

function connect(room) {
  disconnect(false);

  currentRoom = cleanRoomCode(room) || randomRoomCode();
  playerName = cleanPlayerName(setupNameInput.value);
  playerNameDisplay.textContent = playerName;
  setupRoomCodeInput.value = currentRoom;
  setupScreen.classList.add("hidden");
  gameShell.classList.remove("hidden");
  statusChip.textContent = "Connecting";
  shouldReconnect = true;

  const token = connectionToken;
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}?room=${encodeURIComponent(currentRoom)}`);

  socket.addEventListener("open", () => {
    if (token !== connectionToken) return;
    statusChip.textContent = "Online";
    send({ type: "join", name: playerName, sessionId });
  });

  socket.addEventListener("message", (event) => {
    if (token !== connectionToken) return;
    const message = JSON.parse(event.data);
    if (message.clientId) clientId = message.clientId;
    if (message.state) {
      previousState = state ? structuredClone(state) : null;
      state = message.state;
      render();
    }
  });

  socket.addEventListener("close", () => {
    if (token !== connectionToken || !shouldReconnect) return;
    statusChip.textContent = "Reconnecting";
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(currentRoom), 1400);
  });
}

function disconnect(returnToSetup = true) {
  shouldReconnect = false;
  clearTimeout(reconnectTimer);
  connectionToken += 1;

  if (socket) {
    const closingSocket = socket;
    socket = null;
    closingSocket.close();
  }

  if (returnToSetup) {
    setupScreen.classList.remove("hidden");
    gameShell.classList.add("hidden");
    statusChip.textContent = "Offline";
    state = null;
    clientId = null;
    celebratedWinner = null;
  }
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function render() {
  if (!state) return;
  roomBadge.textContent = state.roomCode;
  renderSeats();
  renderTokens();
  renderControls();
  renderLog();
  renderCelebration();
}

function renderSeats() {
  seatsEl.innerHTML = state.seats.map((seat, index) => {
    const player = state.players[index];
    const mine = seat.clientId === clientId;
    const tokensHome = state.tokens[player.id].filter((position) => position === 57).length;
    return `
      <article class="seat ${index === state.turn && state.phase === "playing" ? "active" : ""}">
        <div class="seat-dot" style="background:${player.color}"></div>
        <div>
          <strong>${escapeHtml(seat.label)}</strong>
          <span>${mine ? "You" : seat.disconnected ? "Reconnecting" : seat.type === "ai" ? "AI player" : "Online player"}</span>
          <small>${tokensHome}/4 home</small>
        </div>
        <button type="button" data-seat="${index}">${seat.type === "ai" ? "Take" : mine ? "AI" : "Busy"}</button>
      </article>
    `;
  }).join("");

  seatsEl.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.seat);
      const seat = state.seats[index];
      if (seat.type === "human" && seat.clientId !== clientId) return;
      send({
        type: "setSeat",
        seat: index,
        seatType: seat.type === "ai" ? "human" : "ai",
        name: playerName,
        sessionId
      });
    });
  });
}

function renderTokens() {
  const previousRects = new Map();
  board.querySelectorAll(".token").forEach((token) => {
    previousRects.set(token.dataset.tokenId, token.getBoundingClientRect());
  });
  board.querySelectorAll(".token-stack").forEach((stack) => stack.remove());
  clearLandingPreview();
  const stacks = new Map();
  const moves = availableMoves();
  const movable = new Map(moves.map((move) => [`${move.playerId}-${move.token}`, move]));

  for (const player of state.players) {
    state.tokens[player.id].forEach((position, token) => {
      const cellKey = cellForToken(player.id, position, token);
      if (!stacks.has(cellKey)) stacks.set(cellKey, []);
      stacks.get(cellKey).push({ player, token, movable: movable.has(`${player.id}-${token}`) });
    });
  }

  for (const [cellKey, tokens] of stacks) {
    const cell = board.querySelector(`[data-key="${cellKey}"]`);
    if (!cell) continue;
    const stack = document.createElement("div");
    stack.className = "token-stack";
    stack.style.setProperty("--stack-count", tokens.length);
    tokens.forEach((item, index) => {
      const token = document.createElement("button");
      token.dataset.tokenId = `${item.player.id}-${item.token}`;
      token.style.setProperty("--stack-index", index);
      token.className = `token ${item.movable ? "movable" : ""}`;
      token.style.background = colors[item.player.id];
      token.textContent = item.token + 1;
      token.type = "button";
      token.disabled = !item.movable;
      token.addEventListener("pointerenter", () => showLandingPreview(movable.get(token.dataset.tokenId)));
      token.addEventListener("pointerleave", clearLandingPreview);
      token.addEventListener("focus", () => showLandingPreview(movable.get(token.dataset.tokenId)));
      token.addEventListener("blur", clearLandingPreview);
      token.addEventListener("click", () => send({ type: "move", token: item.token }));
      stack.appendChild(token);
    });
    cell.appendChild(stack);
  }

  animateMovedTokens(previousRects);
}

function renderControls() {
  const seat = state.seats[state.turn];
  const player = state.players[state.turn];
  const isMyTurn = seat?.type === "human" && seat.clientId === clientId;
  const moves = availableMoves();
  const turnSignature = `${state.phase}-${state.turn}-${state.canRoll}-${state.dice}-${clientId}`;
  if (isMyTurn && turnSignature !== lastTurnSignature) {
    showToast(state.canRoll ? "Your turn to roll" : "Choose a highlighted token");
  }
  lastTurnSignature = turnSignature;
  turnLabel.textContent = state.winner
    ? `${seatLabel(state.winner)} wins`
    : state.phase === "lobby"
      ? "Lobby"
      : `${seat.label} (${player.name})`;
  turnHint.textContent = state.winner
    ? "Match complete. Reset the room to play again."
    : state.phase === "lobby"
      ? "Take a seat, invite friends, or start with AI players."
      : isMyTurn && state.canRoll
        ? "Your turn. Roll the dice."
        : isMyTurn && moves.length
          ? `Choose one of ${moves.length} highlighted token${moves.length === 1 ? "" : "s"}.`
          : seat?.type === "ai"
            ? "AI is thinking..."
            : "Waiting for the current player.";
  renderDice(state.dice);
  rollButton.disabled = !(state.phase === "playing" && state.canRoll && isMyTurn);
  startButton.disabled = state.phase === "playing";
  board.classList.toggle("my-turn", Boolean(isMyTurn && state.phase === "playing"));
  document.body.classList.toggle("is-my-turn", Boolean(isMyTurn && state.phase === "playing"));
  document.body.style.setProperty("--turn-color", player?.color || "#0b57d0");
  document.body.style.setProperty("--turn-color-soft", `${player?.color || "#0b57d0"}22`);
}

function renderLog() {
  logEl.innerHTML = state.log.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function availableMoves() {
  if (!state || state.phase !== "playing" || state.canRoll || state.dice === null) return [];
  const seat = state.seats[state.turn];
  if (seat.type !== "human" || seat.clientId !== clientId) return [];
  const playerId = seat.playerId;

  return state.tokens[playerId].map((position, token) => {
    if (position === -1 && state.dice === 6) return { playerId, token, from: -1, to: 0 };
    if (position >= 0 && position + state.dice <= 57) return { playerId, token, from: position, to: position + state.dice };
    return null;
  }).filter(Boolean);
}

function cellForToken(playerId, position, token) {
  if (position === -1) return key(...yards[playerId][token]);
  if (position < 52) {
    const player = state.players.find((item) => item.id === playerId);
    return key(...outerTrack[(player.start + position) % 52]);
  }
  if (position <= 57) return key(...homeLanes[playerId][position - 52]);
  return "7-7";
}

function seatLabel(playerId) {
  const index = state.players.findIndex((player) => player.id === playerId);
  return state.seats[index]?.label || playerId;
}

function renderDice(value) {
  if (lastDice !== value && value) {
    rollButton.classList.add("rolled");
    setTimeout(() => rollButton.classList.remove("rolled"), 650);
  }
  lastDice = value;
  diceValue.dataset.value = value || 0;
  diceValue.innerHTML = value
    ? Array.from({ length: 9 }, () => '<span class="pip"></span>').join("")
    : "Roll";
}

function showLandingPreview(move) {
  clearLandingPreview();
  if (!move) return;
  const cellKey = cellForToken(move.playerId, move.to, move.token);
  const cell = board.querySelector(`[data-key="${cellKey}"]`);
  if (!cell) return;
  const preview = document.createElement("div");
  preview.className = "landing-preview";
  preview.style.background = colors[move.playerId];
  cell.appendChild(preview);
}

function clearLandingPreview() {
  board.querySelectorAll(".landing-preview").forEach((preview) => preview.remove());
}

function animateMovedTokens(previousRects) {
  board.querySelectorAll(".token").forEach((token) => {
    const previous = previousRects.get(token.dataset.tokenId);
    if (!previous) return;
    const next = token.getBoundingClientRect();
    const path = movementPathFor(token.dataset.tokenId, next);
    const keyframes = path.length ? path : [{ x: previous.left - next.left, y: previous.top - next.top }];
    if (!keyframes.some((point) => Math.abs(point.x) > 2 || Math.abs(point.y) > 2)) return;

    token.animate([
      ...keyframes.map((point) => ({ transform: `translate(${point.x}px, ${point.y}px) scale(1.08)`, zIndex: 3 })),
      { transform: "translate(0, 0) scale(1)", zIndex: 3 }
    ], {
      duration: Math.min(1100, 360 + keyframes.length * 90),
      easing: "cubic-bezier(0.2, 0, 0, 1)"
    });
  });
}

function movementPathFor(tokenId, finalRect) {
  if (!previousState || !state) return [];
  const [playerId, tokenIndexText] = tokenId.split("-");
  const tokenIndex = Number(tokenIndexText);
  const from = previousState.tokens[playerId]?.[tokenIndex];
  const to = state.tokens[playerId]?.[tokenIndex];
  if (from === undefined || to === undefined || from === to || from < 0 || to < 0 || to < from) return [];

  const steps = [];
  for (let position = from; position < to; position += 1) {
    const cellKey = cellForToken(playerId, position, tokenIndex);
    const cell = board.querySelector(`[data-key="${cellKey}"]`);
    if (!cell) continue;
    const rect = cell.getBoundingClientRect();
    steps.push({
      x: rect.left + rect.width / 2 - (finalRect.left + finalRect.width / 2),
      y: rect.top + rect.height / 2 - (finalRect.top + finalRect.height / 2)
    });
  }
  return steps;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function renderCelebration() {
  if (!state.winner || celebratedWinner === state.winner) return;
  celebratedWinner = state.winner;
  celebration.innerHTML = "";
  const palette = ["#ea4335", "#4285f4", "#fbbc04", "#34a853", "#d3e3fd"];
  for (let index = 0; index < 48; index += 1) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = palette[index % palette.length];
    piece.style.animationDelay = `${Math.random() * 420}ms`;
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    celebration.appendChild(piece);
  }
  showToast(`${seatLabel(state.winner)} wins the match`);
  setTimeout(() => {
    celebration.innerHTML = "";
  }, 2600);
}

function cleanRoomCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function cleanPlayerName(value) {
  return String(value || "Player").trim().slice(0, 18) || "Player";
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getSessionId() {
  const keyName = "ludoPlayerSessionId";
  const existing = localStorage.getItem(keyName);
  if (existing) return existing;
  const next = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  localStorage.setItem(keyName, next);
  return next;
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggleButton.textContent = theme === "dark" ? "☀" : "☾";
  localStorage.setItem("ludoTheme", theme);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = cleanRoomCode(setupRoomCodeInput.value);
  if (!room) {
    showToast("Enter a join code first");
    setupRoomCodeInput.focus();
    return;
  }
  connect(room);
});

hostRoomButton.addEventListener("click", () => {
  setupRoomCodeInput.value = randomRoomCode();
  connect(setupRoomCodeInput.value);
});

leaveRoomButton.addEventListener("click", () => {
  disconnect(true);
});

themeToggleButton.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

copyInviteButton.addEventListener("click", async () => {
  const url = new URL(location.href);
  url.searchParams.set("room", currentRoom);
  try {
    await navigator.clipboard.writeText(url.toString());
    showToast("Invite link copied");
  } catch {
    showToast(`Room code: ${currentRoom}`);
  }
});

startButton.addEventListener("click", () => send({ type: "start" }));
resetButton.addEventListener("click", () => send({ type: "reset" }));
rollButton.addEventListener("click", () => send({ type: "roll" }));
window.addEventListener("beforeunload", () => disconnect(false));

createBoard();
applyTheme(localStorage.getItem("ludoTheme") || "light");

const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) {
  setupRoomCodeInput.value = cleanRoomCode(roomFromUrl);
}
