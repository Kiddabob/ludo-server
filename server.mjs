// server.mjs
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const wss = new WebSocketServer({ port: PORT });

/* ---------- Game constants ---------- */
const COLORS = ['red','green','yellow','blue'];
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;

const START_OF = { red:0, green:13, yellow:26, blue:39 };
const SAFE_STEPS = new Set([0,8,13,21,26,34,39,47]); // ring steps (relative to red start)

/* ---------- Rooms ---------- */
const ROOMS = new Map();

function id(n=5){
  return randomBytes(n).toString('hex').slice(0,n);
}

function getOrCreateRoom(roomId){
  if (roomId && ROOMS.has(roomId)) return ROOMS.get(roomId);
  const r = {
    id: roomId || id(5),
    hostId: null,
    status: 'waiting',
    players: [],          // [{id,name,color,bot?}]
    tokens: {},           // color -> [ {t:'base'|'path'|'home', p?}, x4 ]
    turnIdx: 0,
    dice: null,
    lastRolls: {},        // color -> last rolled value
  };
  ROOMS.set(r.id, r);
  return r;
}

function nextFreeColor(room){
  for (const c of COLORS){
    if (!room.players.some(p => p.color===c)) return c;
  }
  return null;
}

function playerFor(ws, room){
  return room.players.find(p => p.id === ws._pid);
}

function broadcast(room, msg){
  wss.clients.forEach(c=>{
    if (c.readyState===1 && c._roomId===room.id){
      c.send(JSON.stringify(msg));
    }
  });
}

function sendState(room){
  broadcast(room, {type:'state', room});
}

function packJoined(ws, room){
  const you = playerFor(ws, room);
  ws.send(JSON.stringify({type:'joined', you, room}));
}

/* ---------- Connection ---------- */
wss.on('connection', (ws)=>{
  ws._pid = id(6);

  ws.on('message', raw=>{
    let m={}; try{m=JSON.parse(raw.toString())}catch{ return; }
    try{
      if (m.type==='join') onJoin(ws, m);
      else if (m.type==='start') onStart(ws);
      else if (m.type==='roll') onRoll(ws);
      else if (m.type==='move') onMove(ws, m);
      else if (m.type==='addBot') onAddBot(ws);
      else if (m.type==='removeBot') onRemoveBot(ws);
    }catch(e){
      safeSend(ws,{type:'error', error:e.message||String(e)});
    }
  });

  ws.on('close', ()=>{
    const room = [...ROOMS.values()].find(r => r.players.some(p=>p.id===ws._pid));
    if (!room) return;
    // remove player
    const idx = room.players.findIndex(p=>p.id===ws._pid);
    if (idx>-1) room.players.splice(idx,1);
    if (room.players.length===0){ ROOMS.delete(room.id); return; }

    if (room.hostId===ws._pid){
      // pass host to first human if present, else any
      const human = room.players.find(p=>!p.bot);
      room.hostId = human ? human.id : room.players[0].id;
    }
    // if playing and less than 2 players remain, stop
    if (room.status==='playing' && room.players.length<2){
      room.status='waiting'; room.dice=null;
    }
    sendState(room);
  });
});

function safeSend(ws, o){ try{ws.send(JSON.stringify(o))}catch{} }

/* ---------- Handlers ---------- */
function onJoin(ws, {roomId, name}){
  const room = getOrCreateRoom(roomId);
  ws._roomId = room.id;

  if (!room.hostId) room.hostId = ws._pid; // first joiner is host
  if (room.players.length >= MAX_PLAYERS) throw new Error('Room full');

  const color = nextFreeColor(room);
  if (!color) throw new Error('No color available');

  const player = { id: ws._pid, name: name||`Player-${color}`, color };
  room.players.push(player);
  // init tokens for color
  room.tokens[color] = [{t:'base'},{t:'base'},{t:'base'},{t:'base'}];

  packJoined(ws, room);
  sendState(room);
}

function onStart(ws){
  const room = findRoomOf(ws);
  if (!room) return;
  if (ws._pid !== room.hostId) throw new Error('Only host can start');
  if (room.status!=='waiting') return;
  const n = room.players.length;
  if (n<MIN_PLAYERS || n>MAX_PLAYERS) throw new Error(`Need ${MIN_PLAYERS}–${MAX_PLAYERS} players`);

  // ensure tokens exist for seated colors
  for (const p of room.players){
    if (!room.tokens[p.color]) room.tokens[p.color] = [{t:'base'},{t:'base'},{t:'base'},{t:'base'}];
  }

  room.status='playing';
  room.turnIdx=0;
  room.dice=null;
  sendState(room);
}

function onAddBot(ws){
  const room = findRoomOf(ws); if(!room) return;
  if (room.players.length>=MAX_PLAYERS) return;
  const color = nextFreeColor(room); if(!color) return;
  const bot={ id:id(6), name:`CPU-${color}`, color, bot:true };
  room.players.push(bot);
  room.tokens[color] = [{t:'base'},{t:'base'},{t:'base'},{t:'base'}];
  sendState(room);
  maybeAutoBotTurn(room);
}

function onRemoveBot(ws){
  const room = findRoomOf(ws); if(!room) return;
  const i = room.players.findIndex(p=>p.bot);
  if (i>-1){
    const [rm]=room.players.splice(i,1);
    delete room.tokens[rm.color];
    if (room.turnIdx>=room.players.length) room.turnIdx=0;
    sendState(room);
  }
}

function onRoll(ws){
  const room = findRoomOf(ws); if(!room) return;
  const p = room.players[room.turnIdx];
  if (p.id!==ws._pid) return; // not your turn
  if (room.dice!=null) return; // already rolled

  const v = 1 + Math.floor(Math.random()*6);
  room.dice = v;
  room.lastRolls[p.color] = v;
  sendState(room);

  // For bots, auto-move after short delay
  if (p.bot) setTimeout(()=>botMove(room), 350);
}

function legalMoves(room, color, dice){
  const toks = room.tokens[color];
  const options = [];
  for (let i=0;i<4;i++){
    const t = toks[i];
    if (t.t==='home') continue;
    if (t.t==='base'){
      if (dice===6) options.push({idx:i, to:{t:'path', p:0}});
      continue;
    }
    // path
    const np = t.p + dice;
    if (np>57) continue; // overshoot
    options.push({idx:i, to:{t:'path', p:np}});
  }
  return options;
}

function applyCapture(room, color, step){
  // step is ring step (0..51) relative to red start, but for other colors we just compare equal steps
  for (const opp of room.players){
    if (opp.color===color) continue;
    const ts = room.tokens[opp.color];
    for (const tok of ts){
      if (tok.t==='path' && tok.p<52){
        // map opp token p to ring step
        const oppStep = (START_OF[opp.color] + tok.p) % 52;
        if (oppStep===step){
          // send back to base (unless safe tile)
          const safe = SAFE_STEPS.has(step);
          if (!safe){
            tok.t='base'; delete tok.p;
          }
        }
      }
    }
  }
}

function onMove(ws, {tokenIdx}){
  const room = findRoomOf(ws); if(!room) return;
  const pl = room.players[room.turnIdx]; if (pl.id!==ws._pid) return;
  const dice = room.dice; if (dice==null) return;

  const opts = legalMoves(room, pl.color, dice);
  const choice = opts.find(o=>o.idx===Number(tokenIdx));
  if (!choice) return;

  const tok = room.tokens[pl.color][choice.idx];

  // apply movement
  if (tok.t==='base' && choice.to.t==='path' && choice.to.p===0){
    tok.t='path'; tok.p=0;
    // capture if landing step not safe and opponent present
    applyCapture(room, pl.color, START_OF[pl.color] % 52);
  }else{
    tok.p = choice.to.p;
    if (tok.p<52){
      const step = (START_OF[pl.color] + tok.p) % 52;
      applyCapture(room, pl.color, step);
    }else if (tok.p===57){
      tok.t='home'; delete tok.p;
    }
  }

  // turn logic: roll again on 6 (if at least one legal move existed), else next
  const rolledSix = dice===6;
  room.dice=null;

  // win check
  const allHome = room.tokens[pl.color].every(t=>t.t==='home');
  if (allHome){
    room.status='finished';
    broadcast(room, {type:'finished', winner:pl.color, room});
    return;
  }

  if (rolledSix){
    // same player continues
  }else{
    room.turnIdx = (room.turnIdx+1) % room.players.length;
  }
  sendState(room);

  maybeAutoBotTurn(room);
}

/* ---------- Helpers ---------- */
function botMove(room){
  const p = room.players[room.turnIdx];
  if (!p || !p.bot) return;
  const dice = room.dice;
  const options = legalMoves(room, p.color, dice);
  // naive: prefer finishing, else move the furthest token, else first
  let pick = options.find(o=>o.to.p===57) || options.sort((a,b)=> (b.to.p??0)-(a.to.p??0))[0];
  if (!pick) { // no legal move; pass turn
    room.dice=null;
    room.turnIdx = (room.turnIdx+1) % room.players.length;
    sendState(room);
    return maybeAutoBotTurn(room);
  }
  // apply as if client clicked
  onMove({ _pid:p.id }, { tokenIdx: pick.idx });
}

function maybeAutoBotTurn(room){
  const p = room.players[room.turnIdx];
  if (room.status!=='playing' || !p?.bot) return;
  // auto-press roll
  setTimeout(()=>{
    if (room.status!=='playing') return;
    const fakeWs = { _pid:p.id };
    onRoll(fakeWs);
  }, 350);
}

function findRoomOf(ws){
  if (!ws._roomId) return null;
  return ROOMS.get(ws._roomId) || null;
}

/* ---------- Boot ---------- */
console.log(`Ludo server up on :${PORT}`);
