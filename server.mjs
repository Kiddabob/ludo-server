import http from "node:http";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

/* ---------- helpers ---------- */
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString().replace("T"," ").split(".")[0];
const deepClone = (x) => JSON.parse(JSON.stringify(x));
const randInt = (n) => Math.floor(Math.random()*n) + 1;

const COLORS = ["red","green","blue"];
const START_IDX = { red:0, green:13, yellow:26, blue:39 };
const SAFE_TILES = new Set([0,8,13,21,26,34,39,47]);
const RING_LEN = 52;
const MAX_LANE = 57;

const onRingIndex = (color, p) => (START_IDX[color] + p) % RING_LEN;

/* ---------- data ---------- */
const rooms = new Map();

function newRoom(id){
  return {
    id,
    status: "waiting",
    players: [],
    tokens: {},
    turnIdx: 0,
    dice: null,
    lastRolls: {},
    awaitingMoveFor: null,   // <-- new: player.id who must move after a roll
    createdAt: Date.now()
  };
}

function pickColor(taken){ for (const c of COLORS) if (!taken.includes(c)) return c; return null; }

function ensureTokens(room){
  for (const c of COLORS){
    if (!room.players.find(p => p.color===c)) continue;
    if (!room.tokens[c] || room.tokens[c].length!==4){
      room.tokens[c] = [
        {t:"base", p:0},{t:"base", p:0},{t:"base", p:0},{t:"base", p:0}
      ];
    }
  }
}

/* ---------- networking ---------- */
const server = http.createServer((_,res)=>{ res.writeHead(200,{"content-type":"text/plain; charset=utf-8"}); res.end("Ludo server is running.\n"); });
const wss = new WebSocketServer({ server });

// keep alive
wss.on("connection", ws => { ws.isAlive = true; ws.on("pong", ()=>{ ws.isAlive=true; }); });
setInterval(()=>{ for (const ws of wss.clients){ if (!ws.isAlive){ try{ws.terminate();}catch{}; continue; } ws.isAlive=false; try{ws.ping();}catch{} } }, 30000);

function broadcast(room, msg){
  const data = JSON.stringify(msg);
  for (const p of room.players){
    if (p._ws && p._ws.readyState === p._ws.OPEN){
      try{ p._ws.send(data); }catch{}
    }
  }
}
const snapshot = (room)=>({
  id: room.id,
  status: room.status,
  players: room.players.map(p=>({id:p.id, name:p.name, color:p.color, bot:!!p.bot})),
  tokens: deepClone(room.tokens),
  turnIdx: room.turnIdx,
  dice: room.dice,
  lastRolls: deepClone(room.lastRolls)
});
const sendState = (room)=> broadcast(room, { type:"state", room: snapshot(room) });
function sendJoined(ws, room, you){
  ws.send(JSON.stringify({ type:"joined", you:{id:you.id,name:you.name,color:you.color,bot:!!you.bot}, room:snapshot(room)}));
}

/* ---------- rules ---------- */
function startGame(room){
  room.status="playing";
  room.turnIdx=0;
  room.dice=null;
  room.lastRolls={};
  room.tokens={};
  room.awaitingMoveFor=null;
  ensureTokens(room);
  sendState(room);
  maybeDriveBot(room);
}

function nextTurn(room, {extraTurn=false}={}){
  if (!extraTurn) room.turnIdx = (room.turnIdx + 1) % room.players.length;
  room.dice = null;
  room.awaitingMoveFor = null; // safety: release any lock
  sendState(room);
  maybeDriveBot(room);
}

function occupantsOnRing(room, ringIdx){
  const res=[];
  for (const c of COLORS){
    const arr = room.tokens[c];
    if (!arr) continue;
    arr.forEach((tok,i)=>{
      if (tok.t==="path" && tok.p<52 && onRingIndex(c,tok.p)===ringIdx){
        res.push({color:c, idx:i});
      }
    });
  }
  return res;
}

function canLeaveBase(room, color){
  if (room.dice !== 6) return false;
  const startTile = onRingIndex(color, 0);
  const occ = occupantsOnRing(room, startTile);
  const same = occ.filter(o=>o.color===color).length;
  return same < 2;
}

function captureIfAllowed(room, color, destP){
  if (destP >= 52) return;
  const ringIdx = onRingIndex(color, destP);
  if (SAFE_TILES.has(ringIdx)) return;
  const victims = occupantsOnRing(room, ringIdx).filter(o=>o.color!==color);
  for (const v of victims){
    const tok = room.tokens[v.color][v.idx];
    if (tok){ tok.t="base"; tok.p=0; }
  }
}

function hasAnyMove(room, color){
  const toks = room.tokens[color] || [];
  if (canLeaveBase(room, color)) return true;
  return toks.some(t => t.t==="path" && (t.p + room.dice) <= MAX_LANE);
}

function tryMove(room, player, tokenIdx){
  const color = player.color;
  const tok = room.tokens[color]?.[tokenIdx];
  if (!tok) return false;

  if (tok.t==="base"){
    if (!canLeaveBase(room, color)) return false;
    tok.t="path"; tok.p=0;
    captureIfAllowed(room, color, tok.p);
    return true;
  }

  if (tok.t==="home") return false;

  if (tok.t==="path"){
    const target = tok.p + room.dice;
    if (target > MAX_LANE) return false;
    captureIfAllowed(room, color, target);
    tok.p = target;
    if (tok.p === MAX_LANE){ tok.t="home"; tok.p=MAX_LANE; }
    return true;
  }

  return false;
}

function checkWin(room){
  for (const p of room.players){
    const arr = room.tokens[p.color]||[];
    if (arr.filter(t=>t.t==="home").length === 4){
      room.status="finished";
      sendState(room);
      broadcast(room, { type:"finished", winner:p.color, room:snapshot(room) });
      return true;
    }
  }
  return false;
}

function doRoll(room, player){
  if (room.status!=="playing") return;
  if (room.players[room.turnIdx].id !== player.id) return;

  // if some other player is expected to move, refuse any roll
  if (room.awaitingMoveFor && room.awaitingMoveFor !== player.id) return;

  if (room.dice != null) return; // already rolled for this turn

  const roll = randInt(6);
  room.dice = roll;
  room.lastRolls[player.color] = roll;
  sendState(room);

  // no legal move => auto pass after tiny delay
  if (!hasAnyMove(room, player.color)){
    setTimeout(()=> nextTurn(room, {extraTurn:false}), 350);
    return;
  }

  // legal move exists => lock the turn to this player until they move
  room.awaitingMoveFor = player.id;

  // if it's a bot, make it act
  maybeDriveBot(room);
}

function doMove(room, player, tokenIdx){
  if (room.status!=="playing") return;
  if (room.players[room.turnIdx].id !== player.id) return;
  if (room.dice == null) return;

  const moved = tryMove(room, player, tokenIdx);
  if (!moved) return;

  const extra = room.dice === 6;
  room.awaitingMoveFor = null; // player resolved their move

  if (checkWin(room)) return;
  nextTurn(room, { extraTurn: extra });
}

/* ---------- bot ---------- */
function botPickMove(room, color){
  const toks = room.tokens[color] || [];
  if (room.dice === 6){
    const startable = toks.findIndex(t=>t.t==="base");
    if (startable !== -1 && canLeaveBase(room, color)) return startable;
  }
  for (let i=0;i<toks.length;i++){ const t=toks[i]; if (t.t==="path" && t.p+room.dice===MAX_LANE) return i; }
  for (let i=0;i<toks.length;i++){ const t=toks[i]; if (t.t==="path" && t.p+room.dice<=MAX_LANE) return i; }
  return -1;
}

function maybeDriveBot(room){
  if (room.status!=="playing") return;
  const p = room.players[room.turnIdx];
  if (!p || !p.bot) return;
  if (room.awaitingMoveFor && room.awaitingMoveFor !== p.id) return; // wait for human move

  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  (async ()=>{
    await sleep(350);
    if (room.dice == null) { doRoll(room, p); await sleep(280); }
    if (room.status!=="playing") return;

    // if after roll, human is expected to move (shouldn't happen for bot), bail
    if (room.awaitingMoveFor && room.awaitingMoveFor !== p.id) return;

    const idx = botPickMove(room, p.color);
    if (idx >= 0) doMove(room, p, idx); else nextTurn(room, {extraTurn:false});
  })();
}

/* ---------- ws handlers ---------- */
wss.on("connection", (ws)=>{
  ws.on("message", (data)=>{
    let msg={}; try{ msg = JSON.parse(data.toString()); }catch{ return; }

    if (msg.type==="join"){
      const rid = msg.roomId || uid().slice(0,5);
      if (!rooms.has(rid)) rooms.set(rid, newRoom(rid));
      const room = rooms.get(rid);

      const color = pickColor(room.players.map(p=>p.color));
      if (!color){ ws.send(JSON.stringify({type:"error", error:"Room is full"})); return; }

      const player = { id:uid(), name:msg.name||color, color, bot:false, _ws:ws };
      room.players.push(player);

      ws._roomId = rid; ws._playerId = player.id;

      sendJoined(ws, room, player);
      sendState(room);

      if (room.players.length===3 && room.status==="waiting") startGame(room);
      return;
    }

    const rid = ws._roomId, pid = ws._playerId;
    if (!rid || !rooms.has(rid)) return;
    const room = rooms.get(rid);
    const player = room.players.find(p=>p.id===pid);
    if (!player) return;

    if (msg.type==="roll"){ doRoll(room, player); return; }
    if (msg.type==="move"){
      const idx = Number(msg.tokenIdx);
      if (Number.isInteger(idx)) doMove(room, player, idx);
      return;
    }
    if (msg.type==="addBot"){
      if (room.players.length>=3 || room.status!=="waiting") return;
      const color = pickColor(room.players.map(p=>p.color));
      if (!color) return;
      const bot = { id:uid(), name:`CPU-${color}`, color, bot:true, _ws:null };
      room.players.push(bot);
      sendState(room);
      if (room.players.length===3 && room.status==="waiting") startGame(room);
      return;
    }
    if (msg.type==="removeBot"){
      if (room.status!=="waiting") return;
      for (let i=room.players.length-1;i>=0;i--){ if (room.players[i].bot){ room.players.splice(i,1); break; } }
      sendState(room);
      return;
    }
  });

  ws.on("close", ()=>{
    const rid = ws._roomId, pid = ws._playerId;
    if (!rid || !rooms.has(rid)) return;
    const room = rooms.get(rid);

    const i = room.players.findIndex(p=>p.id===pid);
    if (i!==-1) room.players.splice(i,1);

    if (room.players.length===0){ rooms.delete(rid); return; }

    // if the leaver was blocking with an awaited move, release & advance
    if (room.awaitingMoveFor === pid){
      room.awaitingMoveFor = null;
      nextTurn(room, { extraTurn:false });
      return;
    }

    if (room.status==="playing"){
      if (room.turnIdx >= room.players.length) room.turnIdx = 0;
      room.dice = null;
    }
    sendState(room);
  });
});

/* ---------- start ---------- */
server.listen(PORT, ()=> console.log(`[${now()}] Ludo server listening on :${PORT}`));
