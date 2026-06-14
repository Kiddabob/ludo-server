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
const roomForm = document.querySelector("#roomForm");
const roomCodeInput = document.querySelector("#roomCode");
const playerNameInput = document.querySelector("#playerName");
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
let currentRoom = "PLAY";
let celebratedWinner = null;

function key(row, col) {
  return `${row}-${col}`;
}

function createBoard() {
  board.innerHTML = "";
  const trackKeys = new Set(outerTrack.map(([row, col]) => key(row, col)));
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
      } else if (home) {
        cell.classList.add("yard", `yard-${home[0]}`);
      }

      board.appendChild(cell);
    }
  }
}

function connect(room) {
  if (socket) socket.close();
  currentRoom = room;
  statusChip.textContent = "Connecting";
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}?room=${encodeURIComponent(room)}`);

  socket.addEventListener("open", () => {
    statusChip.textContent = "Online";
    send({ type: "join", name: playerNameInput.value });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.clientId) clientId = message.clientId;
    if (message.state) {
      state = message.state;
      render();
    }
  });

  socket.addEventListener("close", () => {
    statusChip.textContent = "Reconnecting";
    setTimeout(() => connect(currentRoom), 1200);
  });
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
          <span>${mine ? "You" : seat.type === "ai" ? "AI player" : "Online player"}</span>
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
        name: playerNameInput.value
      });
    });
  });
}

function renderTokens() {
  board.querySelectorAll(".token-stack").forEach((stack) => stack.remove());
  const stacks = new Map();
  const movable = new Set(availableMoves().map((move) => `${move.playerId}-${move.token}`));

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
    for (const item of tokens) {
      const token = document.createElement("button");
      token.className = `token ${item.movable ? "movable" : ""}`;
      token.style.background = colors[item.player.id];
      token.textContent = item.token + 1;
      token.type = "button";
      token.disabled = !item.movable;
      token.addEventListener("click", () => send({ type: "move", token: item.token }));
      stack.appendChild(token);
    }
    cell.appendChild(stack);
  }
}

function renderControls() {
  const seat = state.seats[state.turn];
  const player = state.players[state.turn];
  const isMyTurn = seat?.type === "human" && seat.clientId === clientId;
  const moves = availableMoves();
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
    if (position === -1 && state.dice === 6) return { playerId, token };
    if (position >= 0 && position + state.dice <= 57) return { playerId, token };
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
  diceValue.dataset.value = value || 0;
  diceValue.innerHTML = value
    ? Array.from({ length: 9 }, () => '<span class="pip"></span>').join("")
    : "Roll";
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const room = roomCodeInput.value.trim().toUpperCase() || "PLAY";
  roomCodeInput.value = room;
  connect(room);
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

createBoard();
const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) {
  currentRoom = roomFromUrl.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PLAY";
  roomCodeInput.value = currentRoom;
}
connect(currentRoom);
