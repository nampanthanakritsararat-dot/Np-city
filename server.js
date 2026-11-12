'use strict';
/*
 * STREET CITY ONLINE — dedicated game server
 * - ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (ใช้ Node.js 18+ อย่างเดียว)
 * - HTTP + WebSocket (เขียน handshake/frame เอง) ที่พอร์ตเดียวกัน
 * - ห้องเดียวทั้งเซิร์ฟเวอร์ จำกัด 50 คน
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = 50;
const TICK_MS = 66; // ~15 ครั้ง/วินาที
const DATA_FILE = path.join(__dirname, 'data.json');

/* ------------------------------ บันทึกเงิน/อาชีพ ------------------------------ */
let saves = {};
try { saves = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* ไฟล์ยังไม่มี */ }
let dirty = false;
function flushSaves() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(saves)); } catch (e) { console.error('save failed:', e.message); }
}
function saveOne(p) {
  saves[p.token] = { name: p.name, money: Math.floor(p.money), career: p.career, ts: Date.now() };
  dirty = true;
}
setInterval(() => { for (const p of players.values()) saveOne(p); flushSaves(); }, 10000);

/* ------------------------------ อาชีพ ------------------------------ */
const CAREERS = {
  worker: { n: 'พนักงานออฟฟิศ', hp: 100, def: 1,    salary: 12 },
  taxi:   { n: 'แท็กซี่',        hp: 100, def: 1,    salary: 0 },
  police: { n: 'ตำรวจ',          hp: 130, def: 0.75, salary: 8 },
  thief:  { n: 'โจร',            hp: 90,  def: 1,    salary: 0 },
  doctor: { n: 'หมอ',            hp: 100, def: 1,    salary: 6 },
};
const FARE_DIST = 150;      // แท็กซี่: ขับครบกี่พิกเซลได้ $1
const MEDKIT_COST = 60;
const POLICE_BOUNTY = 200;

/* ------------------------------ แผนที่เมือง ------------------------------ */
const CELL = 400, N = 8, W = CELL * N, ROAD = 120;
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261113);
const SHOPS = new Set(['1,1', '6,5']);
const JOBS = new Set(['3,4', '5,2']);
const KIND_IDX = { bld: 0, park: 1, shop: 2, job: 3 };
const blocks = [];
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    const key = i + ',' + j;
    let k = 'bld';
    if (SHOPS.has(key)) k = 'shop';
    else if (JOBS.has(key)) k = 'job';
    else if (rnd() < 0.18) k = 'park';
    blocks.push({
      x: i * CELL + ROAD / 2, y: j * CELL + ROAD / 2, w: CELL - ROAD, h: CELL - ROAD,
      k, c: Math.floor(rnd() * 6), z: Math.floor(20 + rnd() * 50),
    });
  }
}
const solid = blocks.filter(b => b.k !== 'park');
const shops = blocks.filter(b => b.k === 'shop');
const jobBlocks = blocks.filter(b => b.k === 'job');

/** ดันวงกลมออกจากตึก คืนค่า {x,y,hit} */
function collide(x, y, r) {
  let hit = false;
  for (const b of solid) {
    const cx = Math.max(b.x, Math.min(x, b.x + b.w));
    const cy = Math.max(b.y, Math.min(y, b.y + b.h));
    const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
    if (d2 < r * r) {
      hit = true;
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r; y = cy + (dy / d) * r;
      } else {
        const l = x - b.x, rr = b.x + b.w - x, t = y - b.y, bt = b.y + b.h - y;
        const m = Math.min(l, rr, t, bt);
        if (m === l) x = b.x - r; else if (m === rr) x = b.x + b.w + r;
        else if (m === t) y = b.y - r; else y = b.y + b.h + r;
      }
    }
  }
  x = Math.max(r, Math.min(W - r, x));
  y = Math.max(r, Math.min(W - r, y));
  return { x, y, hit };
}
function blocked(x, y, r) {
  for (const b of solid) {
    const cx = Math.max(b.x, Math.min(x, b.x + b.w));
    const cy = Math.max(b.y, Math.min(y, b.y + b.h));
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return true;
  }
  return x < r || y < r || x > W - r || y > W - r;
}
function nearBlock(p, list, range) {
  for (const b of list) {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
    if (Math.hypot(dx, dy) < range) return true;
  }
  return false;
}
function spawnPoint() {
  const i = 1 + Math.floor(Math.random() * (N - 1));
  const j = 1 + Math.floor(Math.random() * (N - 1));
  return { x: i * CELL + (Math.random() - 0.5) * 60, y: j * CELL + (Math.random() - 0.5) * 60 };
}

/* ------------------------------ รถ ------------------------------ */
const cars = [];
for (let n = 1; n <= 16; n++) {
  let x, y, ang;
  if (rnd() < 0.5) {
    const i = Math.floor(rnd() * N), j = 1 + Math.floor(rnd() * (N - 1));
    x = i * CELL + CELL / 2; y = j * CELL + 22; ang = 0;
  } else {
    const i = 1 + Math.floor(rnd() * (N - 1)), j = Math.floor(rnd() * N);
    x = i * CELL + 22; y = j * CELL + CELL / 2; ang = Math.PI / 2;
  }
  cars.push({ id: n, x, y, ang, speed: 0, color: n % 8, driver: 0, idle: 0, home: { x, y, ang } });
}
const approach = (v, t, d) => (v < t ? Math.min(v + d, t) : Math.max(v - d, t));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------ WebSocket (เขียนเอง) ------------------------------ */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const conns = new Set();
const players = new Map();
let nextId = 1;

function frame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function sendRaw(c, buf) {
  const s = c.socket;
  if (s.destroyed || !s.writable) return;
  if (s.writableLength > 2e6) { s.destroy(); return; }
  s.write(buf);
}
const send = (p, o) => sendRaw(p.c, frame(JSON.stringify(o)));
function broadcast(o) {
  const buf = frame(JSON.stringify(o));
  for (const c of conns) if (c.p) sendRaw(c, buf);
}
function closeConn(c) {
  try { if (c.socket.writable) c.socket.write(Buffer.from([0x88, 0x00])); c.socket.end(); } catch (e) { /* ignore */ }
  setTimeout(() => c.socket.destroy(), 500);
}
function refuse(c, msg) {
  sendRaw(c, frame(JSON.stringify({ t: 'err', m: msg })));
  closeConn(c);
}

function onData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  if (c.buf.length > 65536) { c.socket.destroy(); return; }
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 16384) { c.socket.destroy(); return; }
    const mlen = masked ? 4 : 0;
    if (b.length < off + mlen + len) return;
    let payload = b.subarray(off + mlen, off + mlen + len);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    c.buf = b.subarray(off + mlen + len);
    if (op === 8) { closeConn(c); return; }
    if (op === 9) { c.socket.write(Buffer.concat([Buffer.from([0x8a, Math.min(payload.length, 125)]), payload.subarray(0, 125)])); continue; }
    if (op === 1 || op === 0) {
      if (op === 1) c.frag = [];
      c.frag.push(payload);
      if (fin) {
        const s = Buffer.concat(c.frag).toString('utf8');
        c.frag = [];
        onMessage(c, s);
      }
    }
  }
}

/* ------------------------------ HTTP ------------------------------ */
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } else if (url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ n: players.size, max: MAX_PLAYERS, names: [...players.values()].map(p => p.name).slice(0, 30) }));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key || conns.size >= MAX_PLAYERS + 30) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), frag: [], p: null, cnt: 0 };
  conns.add(c);
  c.joinTimer = setTimeout(() => { if (!c.p) socket.destroy(); }, 10000);
  socket.on('data', d => onData(c, d));
  socket.on('close', () => { clearTimeout(c.joinTimer); conns.delete(c); if (c.p) leave(c.p); });
  socket.on('error', () => {});
});
setInterval(() => { for (const c of conns) { if (c.cnt > 150) c.socket.destroy(); c.cnt = 0; } }, 1000);

/* ------------------------------ ตรรกะเกม ------------------------------ */
const num = (v, a, b) => (typeof v === 'number' && isFinite(v) ? clamp(v, a, b) : 0);
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 14).join('');
}
function sendRoster() {
  broadcast({ t: 'roster', list: [...players.values()].map(p => [p.id, p.name, p.career, p.platform]) });
}
const feed = m => broadcast({ t: 'feed', m });
const toast = (p, m) => send(p, { t: 'toast', m });

function doJoin(c, m) {
  clearTimeout(c.joinTimer);
  if (players.size >= MAX_PLAYERS) return refuse(c, `เซิร์ฟเวอร์เต็มแล้ว (${MAX_PLAYERS}/${MAX_PLAYERS}) ลองใหม่อีกครั้งภายหลัง`);
  const name = cleanName(m.name);
  if (Array.from(name).length < 2) return refuse(c, 'ชื่อต้องยาว 2-14 ตัวอักษร');
  const low = name.toLowerCase();
  for (const q of players.values()) if (q.name.toLowerCase() === low) return refuse(c, 'ชื่อนี้มีคนใช้อยู่แล้ว');
  const token = typeof m.token === 'string' && /^[\w-]{16,64}$/.test(m.token) ? m.token : crypto.randomBytes(12).toString('hex');
  for (const q of players.values()) if (q.token === token) return refuse(c, 'บัญชีนี้กำลังออนไลน์อยู่ในอีกแท็บ');
  const save = saves[token];
  const career = CAREERS[m.career] ? m.career : (save && CAREERS[save.career] ? save.career : 'worker');
  const sp = spawnPoint();
  const now = Date.now();
  const p = {
    id: nextId++, c, token, name, career, platform: m.platform === 'mobile' ? 'mobile' : 'pc',
    x: sp.x, y: sp.y, ang: 0, kx: 0, ky: 0,
    maxhp: CAREERS[career].hp, hp: CAREERS[career].hp,
    money: save ? Math.max(50, +save.money || 0) : 100,
    car: 0, in: { mx: 0, my: 0, th: 0, st: 0 },
    dead: false, respawnAt: 0, protectUntil: now + 3000, wantedUntil: 0,
    lastPunch: 0, punchT: 0, hurtT: 0, lastHurt: 0, lastCarHit: 0, lastChat: 0,
    payAcc: 0, fareAcc: 0, lastMe: '',
  };
  c.p = p;
  players.set(p.id, p);
  send(p, {
    t: 'welcome', id: p.id, token, W, max: MAX_PLAYERS,
    blocks: blocks.map(b => [b.x, b.y, b.w, b.h, KIND_IDX[b.k], b.c, b.z]),
    you: { x: p.x, y: p.y },
    medkit: MEDKIT_COST,
  });
  sendRoster();
  feed(`➕ ${p.name} เข้าเมือง (${players.size}/${MAX_PLAYERS})`);
  saveOne(p);
}
function leave(p) {
  players.delete(p.id);
  if (p.car) { const car = cars[p.car - 1]; if (car) car.driver = 0; }
  saveOne(p); flushSaves();
  sendRoster();
  feed(`➖ ${p.name} ออกจากเมือง`);
}

function onMessage(c, str) {
  c.cnt++;
  let m;
  try { m = JSON.parse(str); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  if (!c.p) { if (m.t === 'join') doJoin(c, m); return; }
  const p = c.p, now = Date.now();
  switch (m.t) {
    case 'in':
      p.in.mx = num(m.mx, -1, 1); p.in.my = num(m.my, -1, 1);
      p.in.th = num(m.th, -1, 1); p.in.st = num(m.st, -1, 1);
      if (typeof m.ang === 'number' && isFinite(m.ang)) p.ang = clamp(m.ang, -7, 7);
      break;
    case 'p': punch(p, now); break;
    case 'e': toggleCar(p); break;
    case 'buy':
      if (p.dead || p.car || !nearBlock(p, shops, 60)) return;
      if (p.hp >= p.maxhp) return toast(p, 'เลือดเต็มอยู่แล้ว');
      if (p.money < MEDKIT_COST) return toast(p, 'เงินไม่พอ 💸');
      p.money -= MEDKIT_COST; p.hp = p.maxhp; toast(p, '🩹 ซื้อชุดปฐมพยาบาลแล้ว เลือดเต็ม!');
      break;
    case 'job':
      if (p.dead || p.car || !CAREERS[m.career] || !nearBlock(p, jobBlocks, 60)) return;
      p.career = m.career; p.maxhp = CAREERS[p.career].hp; p.hp = Math.min(p.hp, p.maxhp);
      p.payAcc = 0; p.fareAcc = 0;
      toast(p, `เปลี่ยนอาชีพเป็น ${CAREERS[p.career].n} แล้ว`);
      sendRoster();
      break;
    case 'chat': {
      if (now - p.lastChat < 800) return;
      const text = Array.from(String(m.m || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 100).join('');
      if (!text) return;
      p.lastChat = now;
      broadcast({ t: 'chat', id: p.id, n: p.name, m: text });
      break;
    }
    case 'ping': send(p, { t: 'pong', ts: num(m.ts, 0, 1e15) }); break;
  }
}

function punch(p, now) {
  if (p.dead || p.car || now - p.lastPunch < 420) return;
  p.lastPunch = now; p.punchT = now;
  const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
  let best = null, bd = 1e9;
  for (const q of players.values()) {
    if (q === p || q.dead || q.car) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d > 62) continue;
    if (d > 8 && (dx * ca + dy * sa) / d < 0.3) continue;
    if (d < bd) { bd = d; best = q; }
  }
  if (!best || now < best.protectUntil) return;
  const dx = best.x - p.x, dy = best.y - p.y, d = Math.hypot(dx, dy) || 1;
  best.kx = (dx / d) * 280; best.ky = (dy / d) * 280;
  if (p.career === 'thief') {
    const s = Math.min(Math.floor(best.money * 0.12), 60);
    if (s > 0) { best.money -= s; p.money += s; }
  }
  damage(best, p.career === 'police' ? 14 : 12, p, now);
}

function damage(v, amt, att, now) {
  if (v.dead || now < v.protectUntil) return;
  v.hp -= amt * CAREERS[v.career].def;
  v.hurtT = now; v.lastHurt = now;
  if (v.hp <= 0) kill(v, att, now);
}
function kill(v, att, now) {
  v.hp = 0; v.dead = true; v.respawnAt = now + 3000; v.kx = v.ky = 0;
  const lose = Math.floor(v.money * 0.2);
  v.money -= lose;
  if (att && att !== v) {
    att.money += 40 + Math.floor(lose * 0.5);
    if (v.wantedUntil > now) {
      if (att.career === 'police') {
        att.money += POLICE_BOUNTY; v.wantedUntil = 0;
        feed(`🚓 ตำรวจ ${att.name} จับ ${v.name} ได้ รับค่าหัว $${POLICE_BOUNTY}`);
        return;
      }
    } else if (att.career !== 'police') {
      att.wantedUntil = now + 40000;
    }
    feed(`👊 ${att.name} น็อค ${v.name}`);
  } else {
    feed(`💀 ${v.name} ล้มลง`);
  }
}
function respawn(p, now) {
  const sp = spawnPoint();
  p.x = sp.x; p.y = sp.y; p.hp = p.maxhp; p.dead = false; p.wantedUntil = 0;
  p.protectUntil = now + 2000; p.kx = p.ky = 0;
}

function toggleCar(p) {
  if (p.dead) return;
  if (p.car) {
    const car = cars[p.car - 1];
    car.driver = 0; p.car = 0; p.in.th = p.in.st = 0;
    const px = Math.cos(car.ang + Math.PI / 2), py = Math.sin(car.ang + Math.PI / 2);
    const tries = [[px, py, 42], [-px, -py, 42], [-Math.cos(car.ang), -Math.sin(car.ang), 52], [Math.cos(car.ang), Math.sin(car.ang), 52]];
    p.x = car.x; p.y = car.y;
    for (const [dx, dy, d] of tries) {
      if (!blocked(car.x + dx * d, car.y + dy * d, 14)) { p.x = car.x + dx * d; p.y = car.y + dy * d; break; }
    }
    return;
  }
  let best = null, bd = 80;
  for (const car of cars) {
    if (car.driver) continue;
    const d = Math.hypot(car.x - p.x, car.y - p.y);
    if (d < bd) { bd = d; best = car; }
  }
  if (best) { best.driver = p.id; best.idle = 0; p.car = best.id; p.kx = p.ky = 0; }
}

function updateCar(car, dt) {
  const d = car.driver ? players.get(car.driver) : null;
  const MAXS = 430, ACC = 520, BRAKE = 900, FRIC = 260;
  let th = 0, st = 0;
  if (d && !d.dead) { th = d.in.th; st = d.in.st; }
  if (th !== 0) {
    const target = th > 0 ? th * MAXS : th * MAXS * 0.4;
    const opposing = car.speed !== 0 && Math.sign(target) !== Math.sign(car.speed);
    car.speed = approach(car.speed, target, (opposing ? BRAKE : ACC) * dt);
  } else {
    car.speed = approach(car.speed, 0, FRIC * dt);
  }
  car.ang += st * 2.4 * dt * clamp(car.speed / 180, -1, 1);
  if (Math.abs(car.speed) > 0.5) {
    const r = collide(car.x + Math.cos(car.ang) * car.speed * dt, car.y + Math.sin(car.ang) * car.speed * dt, 22);
    car.x = r.x; car.y = r.y;
    if (r.hit && Math.abs(car.speed) > 20) car.speed *= -0.3;
  }
  if (d) {
    car.idle = 0;
    if (d.career === 'taxi') {
      d.fareAcc += Math.abs(car.speed) * dt;
      if (d.fareAcc >= FARE_DIST) { const k = Math.floor(d.fareAcc / FARE_DIST); d.money += k; d.fareAcc -= k * FARE_DIST; }
    }
  } else {
    car.idle += dt;
    if (car.idle > 120 && (car.x !== car.home.x || car.y !== car.home.y)) {
      let near = false;
      for (const p of players.values()) if (Math.hypot(p.x - car.x, p.y - car.y) < 500) { near = true; break; }
      if (!near) { car.x = car.home.x; car.y = car.home.y; car.ang = car.home.ang; car.speed = 0; car.idle = 0; }
    }
  }
}

function updatePlayer(p, dt, now) {
  if (p.dead) { if (now >= p.respawnAt) respawn(p, now); return; }
  if (p.car) {
    const car = cars[p.car - 1];
    p.x = car.x; p.y = car.y; p.ang = car.ang;
  } else {
    let mx = p.in.mx, my = p.in.my;
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    let nx = p.x + (mx * 175 + p.kx) * dt;
    let ny = p.y + (my * 175 + p.ky) * dt;
    const k = Math.exp(-7 * dt);
    p.kx *= k; p.ky *= k;
    const r = collide(nx, ny, 14);
    p.x = r.x; p.y = r.y;
  }
  // รายได้ประจำ
  const cr = CAREERS[p.career];
  if (cr.salary > 0) {
    p.payAcc += dt;
    if (p.payAcc >= 10) { p.payAcc -= 10; p.money += cr.salary; }
  }
  // ฟื้นเลือดช้าๆ เมื่อไม่โดนตีนาน 5 วิ
  if (now - p.lastHurt > 5000 && p.hp < p.maxhp) p.hp = Math.min(p.maxhp, p.hp + 0.6 * dt);
  // หมอ: ฟื้นตัวเอง + รักษาคนใกล้ๆ ได้เงิน
  if (p.career === 'doctor') {
    if (p.hp < p.maxhp) p.hp = Math.min(p.maxhp, p.hp + 1 * dt);
    for (const q of players.values()) {
      if (q === p || q.dead || q.hp >= q.maxhp) continue;
      if (Math.hypot(q.x - p.x, q.y - p.y) > 130) continue;
      const heal = Math.min(4 * dt, q.maxhp - q.hp);
      q.hp += heal; p.money += heal * 0.25;
    }
  }
}

let last = Date.now();
let seq = 0;
function tick() {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now; seq++;

  for (const car of cars) updateCar(car, dt);
  for (const p of players.values()) updatePlayer(p, dt, now);

  // รถชนคน
  for (const car of cars) {
    if (!car.driver || Math.abs(car.speed) < 140) continue;
    const dr = players.get(car.driver);
    if (!dr) continue;
    for (const p of players.values()) {
      if (p.dead || p.car || p.id === car.driver || now - p.lastCarHit < 700) continue;
      if (Math.hypot(p.x - car.x, p.y - car.y) > 38) continue;
      p.lastCarHit = now;
      const dir = car.speed > 0 ? 1 : -1;
      p.kx = Math.cos(car.ang) * 320 * dir; p.ky = Math.sin(car.ang) * 320 * dir;
      damage(p, Math.abs(car.speed) / 9, dr, now);
    }
  }

  // snapshot
  const ps = [];
  for (const p of players.values()) {
    const fl = (now - p.punchT < 220 ? 1 : 0) | (p.wantedUntil > now ? 2 : 0) | (now - p.hurtT < 200 ? 4 : 0) | (now < p.protectUntil ? 8 : 0);
    ps.push([p.id, Math.round(p.x), Math.round(p.y), Math.round(p.ang * 100), Math.ceil(p.hp), p.car, fl]);
  }
  const cs = cars.map(c => [c.id, Math.round(c.x), Math.round(c.y), Math.round(c.ang * 100), c.driver, c.color]);
  const buf = frame(JSON.stringify({ t: 's', p: ps, c: cs }));
  for (const c of conns) {
    const p = c.p;
    if (!p) continue;
    sendRaw(c, buf);
    const me = JSON.stringify({ t: 'me', hp: Math.ceil(p.hp), mhp: p.maxhp, money: Math.floor(p.money), career: p.career, wanted: p.wantedUntil > now, dead: p.dead });
    if (me !== p.lastMe) { p.lastMe = me; sendRaw(c, frame(me)); }
  }
}
setInterval(tick, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`STREET CITY ONLINE พร้อมแล้ว → http://localhost:${PORT}  (จำกัด ${MAX_PLAYERS} คน)`);
});
function shutdown() { for (const p of players.values()) saveOne(p); flushSaves(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
