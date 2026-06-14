const colors = {
  red: "#ea4335",
  blue: "#4285f4",
  yellow: "#fbbc04",
  green: "#34a853"
};
const defaultPalette = [
  { id: "red", label: "Red", color: colors.red, seat: 0 },
  { id: "blue", label: "Blue", color: colors.blue, seat: 1 },
  { id: "yellow", label: "Yellow", color: colors.yellow, seat: 2 },
  { id: "green", label: "Green", color: colors.green, seat: 3 }
];
const namedColours = [
  { name: "Red", color: "#ea4335" },
  { name: "Rose", color: "#e91e63" },
  { name: "Coral", color: "#ff7043" },
  { name: "Orange", color: "#ff6d00" },
  { name: "Amber", color: "#fbbc04" },
  { name: "Gold", color: "#d9a300" },
  { name: "Lime", color: "#c0ca33" },
  { name: "Green", color: "#34a853" },
  { name: "Emerald", color: "#00c853" },
  { name: "Teal", color: "#00897b" },
  { name: "Cyan", color: "#00acc1" },
  { name: "Sky", color: "#42a5f5" },
  { name: "Blue", color: "#4285f4" },
  { name: "Indigo", color: "#5e35b1" },
  { name: "Violet", color: "#a142f4" },
  { name: "Purple", color: "#8e24aa" },
  { name: "Magenta", color: "#d81b60" },
  { name: "Brown", color: "#8d6e63" },
  { name: "Slate", color: "#607d8b" }
];
const HOME_ENTRY = 51;
const HOME_FINISH = 56;

const board = document.querySelector("#board");
let tokenLayer;
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
const joinRoomButton = document.querySelector("#joinRoom");
const leaveRoomButton = document.querySelector("#leaveRoom");
const themeToggleButton = document.querySelector("#themeToggle");
const soundToggleButton = document.querySelector("#soundToggle");
const soundIcon = document.querySelector("#soundIcon");
const motionToggleButton = document.querySelector("#motionToggle");
const motionIcon = document.querySelector("#motionIcon");
const colourSwatches = document.querySelector("#colourSwatches");
const colourStatus = document.querySelector("#colourStatus");
const customColourPreview = document.querySelector("#customColourPreview");
const useCustomColourInput = document.querySelector("#useCustomColour");
const hslControls = document.querySelector("#hslControls");
const hueRange = document.querySelector("#hueRange");
const satRange = document.querySelector("#satRange");
const lightRange = document.querySelector("#lightRange");
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
let selectedColourId = "red";
let roomPreviewState = null;
let roomPreviewTimer;
let soundEnabled = localStorage.getItem("ludoSound") !== "off";
let audioContext;
const sessionId = getSessionId();
const safeSquareIndexes = [1, 9, 14, 22, 27, 35, 40, 48];
const startSquareIndexes = [1, 14, 27, 40];
const safeSquareColors = {
  1: "red",
  9: "red",
  14: "blue",
  22: "blue",
  27: "yellow",
  35: "yellow",
  40: "green",
  48: "green"
};
const startSquareDirections = {
  1: "right",
  14: "down",
  27: "left",
  40: "up"
};
const homeArrowCells = {
  "7-0": { color: "red", direction: "right" },
  "0-7": { color: "blue", direction: "down" },
  "7-14": { color: "yellow", direction: "left" },
  "14-7": { color: "green", direction: "up" }
};

function key(row, col) {
  return `${row}-${col}`;
}

function createBoard() {
  board.innerHTML = "";
  const trackKeys = new Set(outerTrack.map(([row, col]) => key(row, col)));
  const safeKeys = new Map(safeSquareIndexes.map((index) => [key(...outerTrack[index]), safeSquareColors[index]]));
  const startKeys = new Map(startSquareIndexes.map((index) => [key(...outerTrack[index]), { color: safeSquareColors[index], direction: startSquareDirections[index] }]));
  const homeArrows = new Map(Object.entries(homeArrowCells));
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
      const homeArrow = homeArrows.get(key(row, col));

      if (row >= 6 && row <= 8 && col >= 6 && col <= 8) {
        cell.classList.add("center");
      } else if (lane) {
        cell.classList.add("path", "home", `home-${lane.player}`);
      } else if (trackKeys.has(key(row, col))) {
        cell.classList.add("path");
        if (safeKeys.has(key(row, col))) cell.classList.add("safe", `safe-${safeKeys.get(key(row, col))}`);
        if (startKeys.has(key(row, col))) {
          const start = startKeys.get(key(row, col));
          cell.classList.add("safe-start", `start-${start.color}`, `arrow-${start.direction}`);
        }
        if (homeArrow) cell.classList.add("home-arrow", `home-arrow-${homeArrow.color}`, `arrow-${homeArrow.direction}`);
      } else if (home) {
        cell.classList.add("yard", `yard-${home[0]}`);
      }

      board.appendChild(cell);
    }
  }
  const finishDiamond = document.createElement("div");
  finishDiamond.className = "finish-diamond";
  finishDiamond.style.gridRow = "7 / 10";
  finishDiamond.style.gridColumn = "7 / 10";
  ["red", "blue", "yellow", "green"].forEach((playerId) => {
    const slice = document.createElement("span");
    slice.className = `finish-slice finish-${playerId}`;
    finishDiamond.appendChild(slice);
  });
  board.appendChild(finishDiamond);
  tokenLayer = document.createElement("div");
  tokenLayer.id = "tokenLayer";
  tokenLayer.className = "token-layer";
  board.appendChild(tokenLayer);
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
    send({
      type: "join",
      name: playerName,
      sessionId,
      seat: selectedSeatIndex(),
      color: selectedColour()
    });
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
  applyPlayerColourVariables();
  renderSeats();
  renderTokens();
  renderControls();
  renderLog();
  renderCelebration();
  processActivityEffects();
}

function applyPlayerColourVariables() {
  state.players.forEach((player) => {
    document.documentElement.style.setProperty(`--player-${player.id}`, colorFor(player.id));
  });
}

function colorFor(playerId) {
  const seat = state?.seats?.find((item) => item.playerId === playerId);
  return seat?.color || colors[playerId] || "#0b57d0";
}

function colourNameFor(color) {
  return namedColours
    .map((item) => ({ ...item, distance: colourDistance(color.toLowerCase(), item.color.toLowerCase()) }))
    .sort((left, right) => left.distance - right.distance)[0]?.name || "Custom";
}

function playerColorVar(playerId) {
  return `var(--player-${playerId}, ${colors[playerId] || "#0b57d0"})`;
}

function selectedSeatIndex() {
  if (useCustomColourInput.checked) return null;
  return defaultPalette.find((item) => item.id === selectedColourId)?.seat ?? 0;
}

function selectedColour() {
  if (useCustomColourInput.checked) return hslToHex(Number(hueRange.value), Number(satRange.value), Number(lightRange.value));
  return defaultPalette.find((item) => item.id === selectedColourId)?.color || colors.red;
}

function usedHumanColours() {
  return (roomPreviewState?.seats || [])
    .filter((seat) => seat.type === "human")
    .map((seat) => seat.color)
    .filter(Boolean);
}

function colourDistance(left, right) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function hexToRgb(color) {
  const hex = color.replace("#", "");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function colourTooClose(color) {
  return usedHumanColours().some((used) => colourDistance(color, used) < 95);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((value) => Math.round(255 * value).toString(16).padStart(2, "0")).join("")}`;
}

function renderColourPicker() {
  const humanSeats = new Set((roomPreviewState?.seats || [])
    .map((seat, index) => seat.type === "human" ? index : null)
    .filter((index) => index !== null));

  colourSwatches.innerHTML = defaultPalette.map((item) => {
    const disabled = humanSeats.has(item.seat);
    const selected = !useCustomColourInput.checked && selectedColourId === item.id;
    return `
      <button class="colour-swatch ${selected ? "selected" : ""}" type="button" data-colour="${item.id}" ${disabled ? "disabled" : ""}>
        <span style="background:${item.color}"></span>
        ${item.label}
      </button>
    `;
  }).join("");

  colourSwatches.querySelectorAll(".colour-swatch").forEach((button) => {
    button.addEventListener("click", () => {
      selectedColourId = button.dataset.colour;
      useCustomColourInput.checked = false;
      hslControls.classList.add("hidden");
      renderColourPicker();
    });
  });

  const custom = selectedColour();
  const customConflict = useCustomColourInput.checked && colourTooClose(custom);
  customColourPreview.style.background = custom;
  colourStatus.textContent = customConflict
    ? "Custom colour too close"
    : useCustomColourInput.checked
      ? "Custom colour selected"
      : `${defaultPalette.find((item) => item.id === selectedColourId)?.label || "Red"} selected`;
  joinRoomButton.disabled = customConflict || (!useCustomColourInput.checked && humanSeats.has(selectedSeatIndex()));
}

async function loadRoomPreview() {
  const code = cleanRoomCode(setupRoomCodeInput.value);
  if (!code) {
    roomPreviewState = null;
    renderColourPicker();
    return;
  }

  try {
    const response = await fetch(`/api/room/${encodeURIComponent(code)}`);
    roomPreviewState = response.ok ? await response.json() : null;
  } catch {
    roomPreviewState = null;
  }
  renderColourPicker();
}

function renderSeats() {
  const amSeated = state.seats.some((seat) => seat.clientId === clientId);
  seatsEl.innerHTML = state.seats.map((seat, index) => {
    const player = state.players[index];
    const mine = seat.clientId === clientId;
    const isHost = seat.sessionId && seat.sessionId === state.hostSessionId;
    const seatStatus = seat.type === "ai" ? "AI" : isHost ? "Host" : "Player";
    const tokensHome = state.tokens[player.id].filter((position) => position === HOME_FINISH).length;
    return `
      <article class="seat ${index === state.turn && state.phase === "playing" ? "active" : ""}">
        <div class="seat-dot" style="background:${playerColorVar(player.id)}"></div>
        <div>
          <strong>${escapeHtml(seat.label)}</strong>
          <span>${mine ? `You (${seatStatus})` : seat.disconnected ? "Reconnecting" : seatStatus}</span>
          <small>${tokensHome}/4 home</small>
        </div>
        <button type="button" data-seat="${index}" ${seat.type === "human" || amSeated ? "disabled" : ""}>${seat.type === "ai" ? amSeated ? "AI" : "Open" : seatStatus}</button>
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
        sessionId,
        color: selectedColour()
      });
    });
  });
}

function renderTokens() {
  const previousRects = new Map();
  tokenLayer.querySelectorAll(".token").forEach((token) => {
    previousRects.set(token.dataset.tokenId, token.getBoundingClientRect());
  });
  tokenLayer.innerHTML = "";
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
    placeOverlayItem(stack, cell);
    stack.style.setProperty("--stack-count", tokens.length);
    tokens.forEach((item, index) => {
      const token = document.createElement("button");
      token.dataset.tokenId = `${item.player.id}-${item.token}`;
      token.style.setProperty("--stack-index", index);
      token.className = `token ${item.movable ? "movable" : ""}`;
      token.style.background = playerColorVar(item.player.id);
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
    tokenLayer.appendChild(stack);
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
  if (state.winner) {
    turnLabel.textContent = `${seatLabel(state.winner)} wins`;
  } else if (state.phase === "lobby") {
    turnLabel.textContent = "Lobby";
  } else {
    turnLabel.innerHTML = `${escapeHtml(seat.label)} <span class="turn-colour-name" style="color:${playerColorVar(player.id)}">(${escapeHtml(colourNameFor(colorFor(player.id)))})</span>`;
  }
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
  const turnColor = state.phase === "playing" && player ? player.color : "#0b57d0";
  document.body.style.setProperty("--turn-color", turnColor);
  document.body.style.setProperty("--turn-color-soft", `${turnColor}22`);
}

function renderLog() {
  logEl.innerHTML = state.log.map((item, index) => {
    const detail = activityDetail(item);
    return `
      <li class="log-item log-${detail.type} ${index === 0 ? "latest" : ""}" style="--log-accent:${detail.color}">
        <span class="log-mark">${activityBadge(detail)}</span>
        <span>${escapeHtml(item)}</span>
      </li>
    `;
  }).join("");
}

function activityDetail(message) {
  const roll = /rolled a ([1-6])\./.exec(message);
  if (roll) return { type: "roll", icon: "casino", value: Number(roll[1]), color: "#8ab4f8", sound: "roll" };
  if (/captured/.test(message)) return { type: "capture", icon: "flare", color: "#ff6d00", sound: "capture" };
  if (/wins the game/.test(message)) return { type: "win", icon: "trophy", color: "#fbbc04", sound: "win" };
  if (/moved token/.test(message)) return { type: "move", icon: "near_me", color: "#34a853", sound: "move" };
  if (/no legal move/.test(message)) return { type: "blocked", icon: "block", color: "#a8b3c2", sound: "soft" };
  if (/joined|human seat|AI controlled|Room created|replaced/.test(message)) return { type: "room", icon: "groups", color: "#a142f4", sound: "soft" };
  return { type: "note", icon: "info", color: "#8ab4f8", sound: "soft" };
}

function activityBadge(detail) {
  if (detail.type === "roll") return `<span class="log-die" data-value="${detail.value}">${detail.value}</span>`;
  return `<span class="material-symbols-rounded" aria-hidden="true">${detail.icon}</span>`;
}

function availableMoves() {
  if (!state || state.phase !== "playing" || state.canRoll || state.dice === null) return [];
  const seat = state.seats[state.turn];
  if (seat.type !== "human" || seat.clientId !== clientId) return [];
  const playerId = seat.playerId;

  return state.tokens[playerId].map((position, token) => {
    if (position === -1 && state.dice === 6) return { playerId, token, from: -1, to: 0 };
    if (position >= 0 && position + state.dice <= HOME_FINISH) return { playerId, token, from: position, to: position + state.dice };
    return null;
  }).filter(Boolean);
}

function cellForToken(playerId, position, token) {
  if (position === -1) return key(...yards[playerId][token]);
  if (position < HOME_ENTRY) {
    const player = state.players.find((item) => item.id === playerId);
    return key(...outerTrack[(player.start + position) % 52]);
  }
  if (position <= HOME_FINISH) return key(...homeLanes[playerId][position - HOME_ENTRY]);
  return "7-7";
}

function seatLabel(playerId) {
  const index = state.players.findIndex((player) => player.id === playerId);
  return state.seats[index]?.label || playerId;
}

function renderDice(value) {
  if (lastDice !== value && value) {
    rollButton.classList.add("rolled");
    setTimeout(() => rollButton.classList.remove("rolled"), 920);
  }
  lastDice = value;
  diceValue.dataset.value = value || 0;
  diceValue.innerHTML = value
    ? diceCubeMarkup()
    : "Roll";
}

function diceCubeMarkup() {
  return [1, 2, 3, 4, 5, 6]
    .map((value) => `<span class="die-face die-face-${value}" data-face="${value}">${Array.from({ length: 9 }, () => '<span class="die-pip"></span>').join("")}</span>`)
    .join("");
}

function processActivityEffects() {
  if (!previousState || !state) return;

  const newest = state.log?.[0];
  if (newest && newest !== previousState.log?.[0]) {
    playSound(activityDetail(newest).sound);
  }

  const seat = state.seats[state.turn];
  const wasSeat = previousState.seats?.[previousState.turn];
  const isMyTurn = state.phase === "playing" && seat?.type === "human" && seat.clientId === clientId;
  const wasMyTurn = previousState.phase === "playing" && wasSeat?.type === "human" && wasSeat.clientId === clientId;
  if (isMyTurn && !wasMyTurn) playSound("turn");
}

function setSoundEnabled(enabled, announce = false) {
  soundEnabled = enabled;
  localStorage.setItem("ludoSound", enabled ? "on" : "off");
  soundIcon.textContent = enabled ? "volume_up" : "volume_off";
  soundToggleButton.title = enabled ? "Sound effects on" : "Sound effects off";
  soundToggleButton.setAttribute("aria-label", soundToggleButton.title);
  if (enabled && announce) {
    ensureAudio();
    playSound("soft");
  }
}

function ensureAudio() {
  if (!soundEnabled) return null;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  audioContext ||= new AudioContext();
  if (audioContext.state === "suspended") audioContext.resume();
  return audioContext;
}

function playSound(type) {
  const context = ensureAudio();
  if (!context) return;
  const now = context.currentTime;

  if (type === "roll") {
    playNoise(context, now, 0.28, 0.055);
    playTone(context, 160, 0.08, now, "triangle", 0.035);
    playTone(context, 280, 0.09, now + 0.08, "triangle", 0.035);
    playTone(context, 420, 0.12, now + 0.18, "sine", 0.035);
    return;
  }

  if (type === "move") {
    [360, 440, 520].forEach((frequency, index) => playTone(context, frequency, 0.07, now + index * 0.055, "sine", 0.03));
    return;
  }

  if (type === "capture") {
    playTone(context, 180, 0.12, now, "sawtooth", 0.035);
    playTone(context, 560, 0.16, now + 0.06, "triangle", 0.04);
    return;
  }

  if (type === "win") {
    [392, 523, 659, 784].forEach((frequency, index) => playTone(context, frequency, 0.14, now + index * 0.09, "sine", 0.04));
    return;
  }

  if (type === "turn") {
    playTone(context, 620, 0.12, now, "sine", 0.028);
    playTone(context, 820, 0.12, now + 0.09, "sine", 0.028);
    return;
  }

  playTone(context, 520, 0.08, now, "sine", 0.018);
}

function playTone(context, frequency, duration, start, type = "sine", volume = 0.03) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function playNoise(context, start, duration, volume) {
  const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
  const output = buffer.getChannelData(0);
  for (let index = 0; index < output.length; index += 1) output[index] = (Math.random() * 2 - 1) * (1 - index / output.length);
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(900, start);
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);
  source.start(start);
}

function showLandingPreview(move) {
  clearLandingPreview();
  if (!move) return;
  const cellKey = cellForToken(move.playerId, move.to, move.token);
  const cell = board.querySelector(`[data-key="${cellKey}"]`);
  if (!cell) return;
  const preview = document.createElement("div");
  preview.className = "landing-preview";
  preview.style.background = playerColorVar(move.playerId);
  placeOverlayItem(preview, cell);
  tokenLayer.appendChild(preview);
}

function clearLandingPreview() {
  tokenLayer?.querySelectorAll(".landing-preview").forEach((preview) => preview.remove());
}

function animateMovedTokens(previousRects) {
  tokenLayer.querySelectorAll(".token").forEach((token) => {
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

function placeOverlayItem(item, cell) {
  item.style.left = `${cell.offsetLeft}px`;
  item.style.top = `${cell.offsetTop}px`;
  item.style.width = `${cell.offsetWidth}px`;
  item.style.height = `${cell.offsetHeight}px`;
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
  document.querySelector("#themeIcon").textContent = theme === "dark" ? "light_mode" : "dark_mode";
  localStorage.setItem("ludoTheme", theme);
}

function applyMotion(enabled) {
  document.body.classList.toggle("motion-bg", enabled);
  motionIcon.textContent = enabled ? "pause_circle" : "animation";
  motionToggleButton.title = enabled ? "Moving background on" : "Moving background off";
  motionToggleButton.setAttribute("aria-label", motionToggleButton.title);
  localStorage.setItem("ludoMotion", enabled ? "on" : "off");
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
  if (joinRoomButton.disabled) {
    showToast("Choose an available colour first");
    return;
  }
  connect(room);
});

hostRoomButton.addEventListener("click", () => {
  setupRoomCodeInput.value = randomRoomCode();
  roomPreviewState = null;
  renderColourPicker();
  connect(setupRoomCodeInput.value);
});

leaveRoomButton.addEventListener("click", () => {
  disconnect(true);
});

themeToggleButton.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

soundToggleButton.addEventListener("click", () => {
  setSoundEnabled(!soundEnabled, true);
});

motionToggleButton.addEventListener("click", () => {
  applyMotion(!document.body.classList.contains("motion-bg"));
});

setupRoomCodeInput.addEventListener("input", () => {
  clearTimeout(roomPreviewTimer);
  roomPreviewTimer = setTimeout(loadRoomPreview, 280);
});

useCustomColourInput.addEventListener("change", () => {
  hslControls.classList.toggle("hidden", !useCustomColourInput.checked);
  renderColourPicker();
});

[hueRange, satRange, lightRange].forEach((input) => {
  input.addEventListener("input", renderColourPicker);
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

startButton.addEventListener("click", () => {
  ensureAudio();
  send({ type: "start" });
});
resetButton.addEventListener("click", () => send({ type: "reset" }));
rollButton.addEventListener("click", () => {
  ensureAudio();
  send({ type: "roll" });
});
window.addEventListener("beforeunload", () => disconnect(false));
document.addEventListener("pointerdown", ensureAudio, { once: true });
document.addEventListener("keydown", ensureAudio, { once: true });

createBoard();
applyTheme(localStorage.getItem("ludoTheme") || "light");
applyMotion(localStorage.getItem("ludoMotion") === "on");
setSoundEnabled(soundEnabled);
renderColourPicker();

const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) {
  setupRoomCodeInput.value = cleanRoomCode(roomFromUrl);
  loadRoomPreview();
}
