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

/* ---------- Logging helpers ---------- */
function roomLog(room, text){
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  console.log(`[${room.id}] ${text}`);
  broadcast(room, { type:'log', line });
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
    if (idx>-1){
      const left = room.players[idx];
      room.players.splice(idx,1);
      roomLog(room, `${left.name||left.color} left the room`);
    }
    if (room.players.length===0){ ROOMS.delete(room.id); return; }

    if (room.hostId===ws._pid){
      // pass host to first human if present, else any
      const human = room.players.find(p=>!p.bot);
      room.hostId = human ? human.id : room.players[0].id;
      const newHost = room.players.find(p=>p.id===room.hostId);
      roomLog(room, `Host left — new host is ${newHost?.name||newHost?.color}`);
    }
    // if playing and less than 2 players remain, stop
    if (room.status==='playing' && room.players.length<2){
      room.status='waiting'; room.dice=null;
      roomLog(room, `Not enough players — returning to waiting state`);
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

  const player = { id: ws._pid, name: (name||'').trim() || `Player-${color}`, color };
  room.players.push(player);
  // init tokens for color
  room.tokens[color] = [{t:'base'},{t:'base'},{t:'base'},{t:'base'}];

  packJoined(ws, room);
  sendState(room);
  roomLog(room, `${player.name} joined as ${color}`);
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
  const first = room.players[0];
  roomLog(room, `Game started — ${first.name||first.color} (${first.color}) to roll`);
  maybeAutoBotTurn(room);
}

function onAddBot(ws){
  const room = findRoomOf(ws); if(!room) return;
  if (room.players.length>=MAX_PLAYERS) return;
  const color = nextFreeColor(room); if(!color) return;
  const bot={ id:id(6), name:`CPU-${color}`, color, bot:true };
  room.players.push(bot);
  room.tokens[color] = [{t:'base'},{t:'base'},{t:'base'},{t:'base'}];
  sendState(room);
  roomLog(room, `Added bot ${bot.name} (${color})`);
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
    roomLog(room, `Removed bot ${rm.name} (${rm.color})`);
  }
}

function onRoll(ws){
  const room = findRoomOf(ws); if(!room) return;
  const p = room.players[room.turnIdx];
  if (!p || p.id!==ws._pid) return; // not your turn
  if (room.dice!=null) return; // already rolled

  const v = 1 + Math.floor(Math.random()*6);
  room.dice = v;
  room.lastRolls[p.color] = v;
  sendState(room);
  roomLog(room, `${p.name||p.color} rolled a ${v}`);

  // For bots, auto-move after short delay
  if (p.bot) setTimeout(()=>botMove(room), 350);

  // Safety: in case dice resets without a move (edge cases), try again
  setTimeout(()=>maybeAutoBotTurn(room), 500);
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
  // step is ring step (0..51)
  for (const opp of room.players){
    if (opp.color===color) continue;
    const ts = room.tokens[opp.color];
    for (const tok of ts){
      if (tok.t==='path' && tok.p<52){
        const oppStep = (START_OF[opp.color] + tok.p) % 52;
        if (oppStep===step){
          const safe = SAFE_STEPS.has(step);
          if (!safe){
            tok.t='base'; delete tok.p;
            roomLog(room, `${opp.name||opp.color} token captured by ${color} at step ${step}`);
          }
        }
      }
    }
  }
}

function onMove(ws, {tokenIdx}){
  const room = findRoomOf(ws); if(!room) return;
  const pl = room.players[room.turnIdx]; if (!pl || pl.id!==ws._pid) return;
  const dice = room.dice; if (dice==null) return;

  const opts = legalMoves(room, pl.color, dice);
  const choice = opts.find(o=>o.idx===Number(tokenIdx));
  if (!choice) {
    roomLog(room, `${pl.name||pl.color} tried an illegal move with token ${tokenIdx}`);
    return;
  }

  const tok = room.tokens[pl.color][choice.idx];

  // apply movement
  if (tok.t==='base' && choice.to.t==='path' && choice.to.p===0){
    tok.t='path'; tok.p=0;
    roomLog(room, `${pl.name||pl.color} moved token ${choice.idx} out of base`);
    applyCapture(room, pl.color, START_OF[pl.color] % 52);
  }else{
    tok.p = choice.to.p;
    if (tok.p<52){
      const step = (START_OF[pl.color] + tok.p) % 52;
      roomLog(room, `${pl.name||pl.color} moved token ${choice.idx} to step ${tok.p} (ring ${step})`);
      applyCapture(room, pl.color, step);
    }else if (tok.p===57){
      tok.t='home'; delete tok.p;
      roomLog(room, `${pl.name||pl.color} brought token ${choice.idx} HOME`);
    }
  }

  const rolledSix = dice===6;
  room.dice=null;

  // win check
  const allHome = room.tokens[pl.color].every(t=>t.t==='home');
  if (allHome){
    room.status='finished';
    broadcast(room, {type:'finished', winner:pl.color, room});
    roomLog(room, `🎉 ${pl.name||pl.color} WINS!`);
    return;
  }

  if (!rolledSix){
    room.turnIdx = (room.turnIdx+1) % room.players.length;
  }else{
    roomLog(room, `${pl.name||pl.color} rolled a 6 — plays again`);
  }
  const nxt = room.players[room.turnIdx];
  sendState(room);
  roomLog(room, `Turn: ${nxt.name||nxt.color} (${nxt.color})`);

  maybeAutoBotTurn(room);
}

/* ---------- Helpers ---------- */
function botMove(room){
  const p = room.players[room.turnIdx];
  if (!p || !p.bot) return;
  const dice = room.dice;
  const options = legalMoves(room, p.color, dice);
  let pick = options.find(o=>o.to.p===57) || options.sort((a,b)=> (b.to.p??0)-(a.to.p??0))[0];
  if (!pick) { // no legal move; pass turn
    roomLog(room, `${p.name} has no legal moves — turn passes`);
    room.dice=null;
    room.turnIdx = (room.turnIdx+1) % room.players.length;
    sendState(room);
    const nxt = room.players[room.turnIdx];
    roomLog(room, `Turn: ${nxt.name||nxt.color} (${nxt.color})`);
    return maybeAutoBotTurn(room);
  }
  // apply as if client clicked
  roomLog(room, `${p.name} auto-moves token ${pick.idx}`);
  onMove({ _pid:p.id }, { tokenIdx: pick.idx });
}

function maybeAutoBotTurn(room){
  const p = room.players[room.turnIdx];
  if (room.status!=='playing' || !p?.bot) return;
  // If dice hasn't been rolled yet, auto-roll for the bot
  if (room.dice==null){
    const fakeWs = { _pid:p.id };
    setTimeout(()=>onRoll(fakeWs), 250);
  }else{
    // dice is up -> bot will move shortly
    setTimeout(()=>botMove(room), 250);
  }
}

function findRoomOf(ws){
  if (!ws._roomId) return null;
  return ROOMS.get(ws._roomId) || null;
}

/* ---------- Boot ---------- */
console.log(`Ludo server up on :${PORT}`);
