'use strict';
/*
 * STREET CITY ONLINE v2 — dedicated game server
 * - ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (ใช้ Node.js 18+ อย่างเดียว)
 * - HTTP + WebSocket (เขียน handshake/frame เอง) ที่พอร์ตเดียวกัน
 * - ห้องเดียวทั้งเซิร์ฟเวอร์ จำกัด 50 คน
 * - แอดมิน: ต้องรู้รหัสถึงจะเข้าโหมดแอดมินได้ (ตั้งผ่าน ADMIN_PASSWORD หรือให้เซิร์ฟเวอร์สุ่มให้ตอนเปิดครั้งแรก)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = 50;
const TICK_MS = 66; // ~15 ครั้ง/วินาที
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_FILE = path.join(__dirname, 'admin.json');

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
  saves[p.token] = {
    name: p.name, money: Math.floor(p.money), bank: Math.floor(p.bank), career: p.career,
    weapons: [...p.weapons], car: p.carModel ? { m: p.carModel, c: p.carColor } : null, ts: Date.now(),
  };
  dirty = true;
}
setInterval(() => { for (const p of players.values()) saveOne(p); flushSaves(); }, 10000);

/* ------------------------------ รหัสแอดมิน ------------------------------ */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
let adminCred = null;
let generatedPw = null;
try {
  const j = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
  if (j.salt && j.hash) adminCred = { salt: Buffer.from(j.salt, 'hex'), hash: Buffer.from(j.hash, 'hex') };
} catch (e) { /* ยังไม่มีไฟล์ */ }
function setAdminPw(pw, persist) {
  const salt = crypto.randomBytes(16);
  adminCred = { salt, hash: hashPw(pw, salt) };
  if (persist) {
    try { fs.writeFileSync(ADMIN_FILE, JSON.stringify({ salt: salt.toString('hex'), hash: adminCred.hash.toString('hex') }), { mode: 0o600 }); }
    catch (e) { console.error('cannot save admin.json:', e.message); }
  }
}
if (process.env.ADMIN_PASSWORD) setAdminPw(String(process.env.ADMIN_PASSWORD), false); // ตัวแปร ADMIN_PASSWORD มาก่อนเสมอ
else if (!adminCred) {
  { generatedPw = crypto.randomBytes(9).toString('base64url'); setAdminPw(generatedPw, true); }
}
function checkAdminPw(pw) {
  if (typeof pw !== 'string' || pw.length === 0 || pw.length > 64) return false;
  return crypto.timingSafeEqual(hashPw(pw, adminCred.salt), adminCred.hash);
}
// กันเดารหัส: ผิด 5 ครั้งล็อก IP นั้น 10 นาที
const fails = new Map();
const ipLocked = ip => { const f = fails.get(ip); return !!(f && f.until > Date.now()); };
function recordFail(ip) {
  const now = Date.now();
  let f = fails.get(ip);
  if (!f || now - f.first > 600000) f = { n: 0, first: now, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = now + 600000;
  fails.set(ip, f);
}
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (now - f.first > 1200000) fails.delete(ip); }, 60000);

/* ------------------------------ อาชีพ ------------------------------ */
const CAREERS = {
  worker: { n: 'พนักงานออฟฟิศ', hp: 100, def: 1,    salary: 12 },
  taxi:   { n: 'แท็กซี่',        hp: 100, def: 1,    salary: 0 },
  police: { n: 'ตำรวจ',          hp: 130, def: 0.75, salary: 8 },
  thief:  { n: 'โจร',            hp: 90,  def: 1,    salary: 0 },
  doctor: { n: 'หมอ',            hp: 100, def: 1,    salary: 6 },
};
const FARE_DIST = 150;      // แท็กซี่: ขับครบกี่พิกเซลได้ $1
const POLICE_BOUNTY = 200;
const MAX_AMMO = 60;
const WEAPONS = {
  fist:    { n: '👊 มือเปล่า',   melee: true, dmg: 12, cd: 420 },
  bat:     { n: '🏏 ไม้เบสบอล', melee: true, dmg: 24, cd: 520 },
  pistol:  { n: '🔫 ปืนพก',      dmg: 22, cd: 350, range: 520, pellets: 1, spread: 0 },
  smg:     { n: '🔫 SMG',        dmg: 11, cd: 120, range: 460, pellets: 1, spread: 0.05 },
  shotgun: { n: '💥 ลูกซอง',     dmg: 9,  cd: 850, range: 280, pellets: 6, spread: 0.22 },
};
const WORDER = ['fist', 'bat', 'pistol', 'smg', 'shotgun'];
const CAR_MODELS = {
  hatch: { n: '🚗 แฮตช์แบ็ก',   price: 800,   max: 400, acc: 520 },
  sedan: { n: '🚙 ซีดาน',        price: 2500,  max: 470, acc: 570 },
  sport: { n: '🏎️ สปอร์ต',      price: 8000,  max: 580, acc: 690 },
  super: { n: '🚀 ซูเปอร์คาร์', price: 20000, max: 700, acc: 820 },
};
const HUNGER_SECS = 6;      // หิวลด 1 หน่วยทุกกี่วินาที

/* ------------------------------ ร้านค้า / เมนู ------------------------------ */
const MENUS = {
  shop: { title: '🏪 ร้านสะดวกซื้อ', items: [
    ['snack', '🍫 ขนม', 10, 'อิ่ม +15'],
    ['drink', '🥤 น้ำอัดลม', 8, 'อิ่ม +10'],
    ['medkit', '🩹 ชุดปฐมพยาบาล', 60, 'เลือดเต็มทันที'],
  ] },
  rest: { title: '🍔 ร้านอาหาร', items: [
    ['noodle', '🍜 ก๋วยเตี๋ยว', 18, 'อิ่ม +30'],
    ['burger', '🍔 เบอร์เกอร์', 25, 'อิ่ม +40'],
    ['steak', '🥩 สเต็ก', 60, 'อิ่ม +80 และเลือด +20'],
  ] },
  hosp: { title: '🏥 โรงพยาบาล', items: [
    ['heal', '💉 รักษาจนหาย', 30, 'เลือดเต็มทันที'],
  ] },
  gun: { title: '🔫 ร้านอาวุธ', items: [
    ['ammo',    '🔫 กระสุน 12 นัด', 40,   `ใช้กับปืนทุกกระบอก · สะสมสูงสุด ${MAX_AMMO} นัด (เฉพาะโจร)`],
    ['bat',     '🏏 ไม้เบสบอล',     150,  'ตีแรงกว่ามือเปล่า 2 เท่า · ทุกอาชีพซื้อได้'],
    ['pistol',  '🔫 ปืนพก',         200,  'ดาเมจ 22 · เฉพาะโจร'],
    ['smg',     '🔫 SMG',           900,  'ยิงรัวเร็ว · เฉพาะโจร'],
    ['shotgun', '💥 ลูกซอง',        1200, 'ยิงกระจาย ระยะใกล้แรงมาก · เฉพาะโจร'],
  ] },
  dealer: { title: '🚗 ร้านขายรถ', colors: true, items: [
    ...Object.entries(CAR_MODELS).map(([k, c]) => ['car_' + k, c.n, c.price, `วิ่งเร็วสุด ${c.max} · รับซื้อรถเก่า 50%`]),
    ['car_call', '📍 เรียกรถส่วนตัวมาจอดหน้าร้าน', 0, 'ถ้ารถหาย/ไปไกล'],
  ] },
  bank: { title: '🏦 ธนาคาร', items: [
    ['dep_all', '📥 ฝากทั้งหมด', 0, 'เงินในธนาคารไม่โดนขโมย/ไม่หายตอนตาย'],
    ['wd_all', '📤 ถอนทั้งหมด', 0, ''],
    ['dep_100', '📥 ฝาก $100', 0, ''],
    ['wd_100', '📤 ถอน $100', 0, ''],
  ] },
};
const ITEMS = {};
for (const [kind, m] of Object.entries(MENUS)) for (const [id, n, price] of m.items) ITEMS[id] = { kind, n, price };
const FOOD = { snack: 15, drink: 10, noodle: 30, burger: 40, steak: 80 };

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
const PLACES = {
  '1,1': 'shop', '6,5': 'shop',
  '3,4': 'job', '5,2': 'job',
  '2,6': 'rest', '5,5': 'rest',
  '4,2': 'hosp', '3,1': 'bank', '7,7': 'gun', '6,2': 'dealer',
};
const KIND_IDX = { bld: 0, park: 1, shop: 2, job: 3, rest: 4, hosp: 5, bank: 6, gun: 7, dealer: 8 };
const blocks = [];
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    let k = PLACES[i + ',' + j];
    if (!k) k = rnd() < 0.18 ? 'park' : 'bld';
    blocks.push({
      x: i * CELL + ROAD / 2, y: j * CELL + ROAD / 2, w: CELL - ROAD, h: CELL - ROAD,
      k, c: Math.floor(rnd() * 6), z: Math.floor(20 + rnd() * 50),
    });
  }
}
const solid = blocks.filter(b => b.k !== 'park');
const byKind = {};
for (const b of blocks) (byKind[b.k] = byKind[b.k] || []).push(b);

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
  cars.push({ id: n, x, y, ang, speed: 0, color: n % 8, driver: 0, idle: 0, home: { x, y, ang }, active: true, owner: 0, max: 430, acc: 520 });
}
/* ------------------------------ NPC: รถจราจร + คนเดินถนน ------------------------------ */
const HD = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // ทิศ: +x, +y, -x, -y
const SGN = [1, -1, -1, 1];
function mvPlace(m, hd, line, along, off) {
  m.hd = hd; m.line = line;
  if (hd % 2 === 0) { m.x = along; m.y = line * CELL + SGN[hd] * off; }
  else { m.x = line * CELL + SGN[hd] * off; m.y = along; }
}
function mvStep(m, dist, off, straight) {
  const dir = m.hd < 2 ? 1 : -1, horiz = m.hd % 2 === 0;
  const a = horiz ? m.x : m.y, na = a + dir * dist;
  if (na < 40 || na > W - 40) { mvPlace(m, (m.hd + 2) % 4, m.line, a, off); return; }
  const kp = Math.floor(a / CELL), kn = Math.floor(na / CELL);
  if (kp !== kn) {
    const k = dir > 0 ? kn : kp, r = Math.random();
    if (r > straight && k >= 1 && k <= 7) {
      const nhd = r < straight + (1 - straight) / 2 ? (m.hd + 1) % 4 : (m.hd + 3) % 4;
      mvPlace(m, nhd, k, m.line * CELL, off);
      return;
    }
  }
  if (horiz) m.x = na; else m.y = na;
}
const randAlong = () => Math.random() * (W - 200) + 100;
const randLine = () => 1 + Math.floor(Math.random() * 7);
const npcCars = [];
for (let n = 0; n < 12; n++) {
  const car = { id: cars.length + 1, x: 0, y: 0, ang: 0, speed: 0, color: Math.floor(Math.random() * 8), driver: -1, idle: 0, home: null, active: true, owner: 0, max: 150, acc: 200, npc: true, hd: 0, line: 1, stop: 0, ghost: 0 };
  mvPlace(car, Math.floor(Math.random() * 4), randLine(), randAlong(), 22);
  car.ang = car.hd * Math.PI / 2;
  cars.push(car); npcCars.push(car);
}
const peds = [];
for (let n = 0; n < 28; n++) {
  const pd = { id: n + 1, x: 0, y: 0, hd: 0, line: 1, hp: 30, dead: false, respawnAt: 0, look: Math.floor(Math.random() * 8) };
  mvPlace(pd, Math.floor(Math.random() * 4), randLine(), randAlong(), 50);
  peds.push(pd);
}
function updateNpc(car, dt) {
  const f = HD[car.hd];
  let blockedAhead = false;
  if (car.ghost > 0) car.ghost -= dt;
  else {
    const chk = (ex, ey) => { const dx = ex - car.x, dy = ey - car.y, al = dx * f[0] + dy * f[1], la = Math.abs(-dx * f[1] + dy * f[0]); return al > 8 && al < 80 && la < 34; };
    for (const p of players.values()) if (!p.dead && !p.car && chk(p.x, p.y)) { blockedAhead = true; break; }
    if (!blockedAhead) for (const o of cars) if (o !== car && o.active && chk(o.x, o.y)) { blockedAhead = true; break; }
  }
  car.speed = approach(car.speed, blockedAhead ? 0 : car.max, (blockedAhead ? 700 : car.acc) * dt);
  if (blockedAhead) { car.stop += dt; if (car.stop > 3) { car.ghost = 2.5; car.stop = 0; } } else car.stop = 0;
  if (car.speed > 1) mvStep(car, car.speed * dt, 22, 0.6);
  car.ang = car.hd * Math.PI / 2;
}
function updatePed(pd, dt, now) {
  if (pd.dead) {
    if (now >= pd.respawnAt) { mvPlace(pd, Math.floor(Math.random() * 4), randLine(), randAlong(), 50); pd.hp = 30; pd.dead = false; }
    return;
  }
  mvStep(pd, 52 * dt, 50, 0.55);
}
function addStar(p, now) {
  p.stars = Math.min(5, (p.wantedUntil > now ? p.stars : 0) + 1);
  p.wantedUntil = now + 45000;
}
function killPed(pd, att, now) {
  pd.dead = true; pd.hp = 0; pd.respawnAt = now + 6000;
  if (att) {
    att.money += 8 + Math.floor(Math.random() * 30);
    if (att.career !== 'police') addStar(att, now);
    toast(att, '🚨 คุณทำร้ายพลเมือง!');
  }
}

// ช่องรถส่วนตัว (ซื้อจากร้านขายรถ) 1 ช่องต่อผู้เล่น
const PRIV0 = cars.length;
for (let n = 0; n < MAX_PLAYERS; n++) cars.push({ id: PRIV0 + n + 1, x: 0, y: 0, ang: 0, speed: 0, color: 0, driver: 0, idle: 0, home: null, active: false, owner: 0, max: 430, acc: 520 });
const slotUsed = new Array(MAX_PLAYERS).fill(false);
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
  // IP จริงของผู้ใช้ (หลังพร็อกซีอย่าง Render ค่าท้ายสุดของ X-Forwarded-For คือ IP ที่พร็อกซีเห็น)
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const ip = xf.length ? xf[xf.length - 1] : socket.remoteAddress;
  const c = { socket, buf: Buffer.alloc(0), frag: [], p: null, cnt: 0, ip };
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
function cleanText(s, max) {
  return Array.from(String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, max).join('');
}
function sendRoster() {
  broadcast({ t: 'roster', list: [...players.values()].map(p => [p.id, p.name, p.career, p.platform, p.admin ? 1 : 0]) });
}
const feed = m => broadcast({ t: 'feed', m });
const toast = (p, m) => send(p, { t: 'toast', m });
const canShoot = p => p.career === 'thief' || p.admin;

function doJoin(c, m) {
  clearTimeout(c.joinTimer);
  if (players.size >= MAX_PLAYERS) return refuse(c, `เซิร์ฟเวอร์เต็มแล้ว (${MAX_PLAYERS}/${MAX_PLAYERS}) ลองใหม่อีกครั้งภายหลัง`);
  const name = cleanName(m.name);
  if (Array.from(name).length < 2) return refuse(c, 'ชื่อต้องยาว 2-14 ตัวอักษร');
  const low = name.toLowerCase();
  for (const q of players.values()) if (q.name.toLowerCase() === low) return refuse(c, 'ชื่อนี้มีคนใช้อยู่แล้ว');
  const token = typeof m.token === 'string' && /^[\w-]{16,64}$/.test(m.token) ? m.token : crypto.randomBytes(12).toString('hex');
  for (const q of players.values()) if (q.token === token) return refuse(c, 'บัญชีนี้กำลังออนไลน์อยู่ในอีกแท็บ');

  let isAdmin = false;
  if (typeof m.admin === 'string' && m.admin.length > 0) {
    if (ipLocked(c.ip)) return refuse(c, 'ใส่รหัสแอดมินผิดหลายครั้ง ถูกล็อกชั่วคราว ลองใหม่ภายหลัง');
    if (!checkAdminPw(m.admin)) {
      recordFail(c.ip);
      console.log(`[admin] รหัสผิดจาก ${c.ip}`);
      return refuse(c, 'รหัสแอดมินไม่ถูกต้อง');
    }
    fails.delete(c.ip);
    isAdmin = true;
  }

  const save = saves[token];
  const career = CAREERS[m.career] ? m.career : (save && CAREERS[save.career] ? save.career : 'worker');
  const sp = spawnPoint();
  const now = Date.now();
  const p = {
    id: nextId++, c, token, name, career, platform: m.platform === 'mobile' ? 'mobile' : 'pc', admin: isAdmin,
    x: sp.x, y: sp.y, ang: 0, kx: 0, ky: 0,
    maxhp: CAREERS[career].hp, hp: CAREERS[career].hp,
    money: save ? Math.max(50, +save.money || 0) : 100,
    bank: save ? Math.max(0, +save.bank || 0) : 0,
    hunger: 80, ammo: 12, stars: 0, weapons: new Set(['fist']), weapon: 'fist', carModel: '', carColor: 0, carSlot: 0,
    fast: false, god: false, inf: false,
    car: 0, in: { mx: 0, my: 0, th: 0, st: 0 },
    dead: false, respawnAt: 0, protectUntil: now + 3000, wantedUntil: 0,
    lastPunch: 0, punchT: 0, lastShot: 0, hurtT: 0, lastHurt: 0, lastCarHit: 0, lastChat: 0,
    payAcc: 0, fareAcc: 0, lastMe: '',
  };
  c.p = p;
  players.set(p.id, p);
  { const si = slotUsed.indexOf(false); slotUsed[si] = true; p.carSlot = PRIV0 + si + 1; }
  if (save && Array.isArray(save.weapons)) for (const k of save.weapons) if (WEAPONS[k]) p.weapons.add(k);
  if (career === 'thief') p.weapons.add('pistol');
  if (isAdmin) for (const k of WORDER) p.weapons.add(k);
  p.weapon = p.weapons.has('pistol') && canShoot(p) ? 'pistol' : 'fist';
  if (save && save.car && CAR_MODELS[save.car.m]) { p.carModel = save.car.m; p.carColor = (save.car.c | 0) & 7; placeCar(p); }
  send(p, {
    t: 'welcome', id: p.id, token, W, max: MAX_PLAYERS, admin: isAdmin, weapons: WEAPONS, worder: WORDER,
    blocks: blocks.map(b => [b.x, b.y, b.w, b.h, KIND_IDX[b.k], b.c, b.z]),
    you: { x: p.x, y: p.y },
    menus: MENUS,
  });
  sendRoster();
  feed(`➕ ${isAdmin ? '🛡️ ' : ''}${p.name} เข้าเมือง (${players.size}/${MAX_PLAYERS})`);
  if (isAdmin) console.log(`[admin] ${p.name} เข้าสู่ระบบแอดมิน`);
  saveOne(p);
}
function leave(p) {
  players.delete(p.id);
  if (p.car) { const car = cars[p.car - 1]; if (car) car.driver = 0; }
  const pc = cars[p.carSlot - 1];
  if (pc) { pc.active = false; pc.owner = 0; pc.driver = 0; pc.speed = 0; }
  if (p.carSlot) slotUsed[p.carSlot - PRIV0 - 1] = false;
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
    case 'p':
      if (typeof m.ang === 'number' && isFinite(m.ang)) p.ang = clamp(m.ang, -7, 7);
      punch(p, now); break;
    case 'shoot':
      if (typeof m.ang === 'number' && isFinite(m.ang)) p.ang = clamp(m.ang, -7, 7);
      shoot(p, now); break;
    case 'e': toggleCar(p); break;
    case 'buy': doBuy(p, String(m.item || ''), m); break;
    case 'job':
      if (p.dead || p.car || !CAREERS[m.career] || !nearBlock(p, byKind.job || [], 60)) return;
      p.career = m.career; p.maxhp = CAREERS[p.career].hp; p.hp = Math.min(p.hp, p.maxhp);
      p.payAcc = 0; p.fareAcc = 0;
      if (p.career === 'thief') { p.ammo = Math.max(p.ammo, 12); p.weapons.add('pistol'); }
      if (!canShoot(p) && WEAPONS[p.weapon] && !WEAPONS[p.weapon].melee) p.weapon = 'fist';
      toast(p, `เปลี่ยนอาชีพเป็น ${CAREERS[p.career].n} แล้ว`);
      sendRoster();
      break;
    case 'chat': {
      if (now - p.lastChat < 800) return;
      const text = cleanText(m.m, 100);
      if (!text) return;
      p.lastChat = now;
      if (/^\/me\s+/i.test(text)) { broadcast({ t: 'chat', id: p.id, n: '✦', m: p.name + ' ' + text.replace(/^\/me\s+/i, ''), a: 0, b: 0 }); break; }
      broadcast({ t: 'chat', id: p.id, n: p.name, m: text, a: p.admin ? 1 : 0, b: 1 });
      break;
    }
    case 'wpn': {
      const id = String(m.w || '');
      if (!WEAPONS[id] || !p.weapons.has(id)) return;
      if (!WEAPONS[id].melee && !canShoot(p)) return toast(p, 'อาวุธปืนใช้ได้เฉพาะอาชีพโจร 🦹');
      p.weapon = id;
      break;
    }
    case 'horn':
      if (p.car && now - (p.lastHorn || 0) > 400) { p.lastHorn = now; broadcast({ t: 'horn', x: Math.round(p.x), y: Math.round(p.y) }); }
      break;
    case 'adm': doAdmin(p, m); break;
    case 'ping': send(p, { t: 'pong', ts: num(m.ts, 0, 1e15) }); break;
  }
}

/* ---- ซื้อของ / ร้านขายรถ ---- */
function dealerSpot(car) {
  const b = (byKind.dealer || [])[0];
  if (!b) return { x: 400, y: 400 };
  return { x: b.x + 40 + (car.id % 5) * 50, y: b.y + b.h + 28 };
}
function placeCar(p) {
  const car = cars[p.carSlot - 1], def = CAR_MODELS[p.carModel];
  if (!car || !def) return;
  const sp = dealerSpot(car);
  Object.assign(car, { active: true, owner: p.id, x: sp.x, y: sp.y, ang: 0, speed: 0, driver: 0, idle: 0, color: p.carColor, max: def.max, acc: def.acc });
}
function doBuy(p, id, m) {
  const it = ITEMS[id];
  if (!it || p.dead || p.car || !nearBlock(p, byKind[it.kind] || [], 60)) return;

  if (it.kind === 'bank') {
    const dep = id.startsWith('dep');
    let amt = id.endsWith('_all') ? Math.floor(dep ? p.money : p.bank) : 100;
    amt = Math.min(amt, Math.floor(dep ? p.money : p.bank));
    if (amt <= 0) return toast(p, dep ? 'ไม่มีเงินให้ฝาก' : 'ไม่มีเงินในธนาคาร');
    if (dep) { p.money -= amt; p.bank += amt; } else { p.bank -= amt; p.money += amt; }
    return toast(p, `🏦 ${dep ? 'ฝาก' : 'ถอน'} $${amt} แล้ว`);
  }

  if (it.kind === 'dealer') {
    if (id === 'car_call') {
      if (!p.carModel) return toast(p, 'คุณยังไม่มีรถส่วนตัว ซื้อได้ที่นี่เลย 🚗');
      placeCar(p);
      return toast(p, '📍 นำรถส่วนตัวมาจอดหน้าร้านแล้ว');
    }
    const model = id.slice(4), def = CAR_MODELS[model];
    if (!def) return;
    if (p.carModel === model) return toast(p, 'คุณมีรถรุ่นนี้อยู่แล้ว (กด "เรียกรถ" ได้)');
    const refund = p.carModel ? Math.floor(CAR_MODELS[p.carModel].price * 0.5) : 0;
    const cost = def.price - refund;
    if (!p.inf && p.money < cost) return toast(p, `เงินไม่พอ 💸 (ต้องใช้ $${cost}${refund ? ` หลังหักรถเก่า $${refund}` : ''})`);
    if (!p.inf) p.money -= cost;
    p.carModel = model;
    p.carColor = m && Number.isInteger(m.color) && m.color >= 0 && m.color < 8 ? m.color : 0;
    placeCar(p);
    return toast(p, `🎉 ซื้อ ${def.n} แล้ว จอดอยู่หน้าร้าน!${refund ? ` (รับซื้อรถเก่า $${refund})` : ''}`);
  }

  if (it.kind === 'gun') {
    const w = WEAPONS[id];
    if ((id === 'ammo' || (w && !w.melee)) && !canShoot(p)) return toast(p, 'อาวุธปืนขายเฉพาะอาชีพโจรเท่านั้น 🦹');
    if (w && p.weapons.has(id)) return toast(p, 'คุณมีอาวุธนี้แล้ว');
  }
  if (!p.inf && p.money < it.price) return toast(p, 'เงินไม่พอ 💸');

  let msg = '';
  if (FOOD[id]) {
    if (p.hunger >= 100) return toast(p, 'อิ่มแล้ว 😋');
    p.hunger = Math.min(100, p.hunger + FOOD[id]);
    if (id === 'steak') p.hp = Math.min(p.maxhp, p.hp + 20);
    msg = `😋 กิน ${it.n} แล้ว`;
  } else if (id === 'medkit' || id === 'heal') {
    if (p.hp >= p.maxhp) return toast(p, 'เลือดเต็มอยู่แล้ว');
    p.hp = p.maxhp; msg = '🩹 เลือดเต็ม!';
  } else if (id === 'ammo') {
    if (p.ammo >= MAX_AMMO) return toast(p, 'กระสุนเต็มแล้ว');
    p.ammo = Math.min(MAX_AMMO, p.ammo + 12); msg = '🔫 ได้กระสุน +12 นัด';
  } else if (WEAPONS[id]) {
    p.weapons.add(id); p.weapon = id;
    if (!WEAPONS[id].melee) p.ammo = Math.max(p.ammo, 12);
    msg = `ซื้อ ${WEAPONS[id].n} แล้ว (ถือไว้ในมือ)`;
  } else return;
  if (!p.inf) p.money -= it.price;
  toast(p, msg);
}

/* ---- ต่อย / ตีด้วยไม้ ---- */
function punch(p, now) {
  const w = p.weapon === 'bat' ? WEAPONS.bat : WEAPONS.fist;
  if (p.dead || p.car || now - p.lastPunch < w.cd) return;
  p.lastPunch = now; p.punchT = now;
  const reach = w === WEAPONS.bat ? 76 : 62;
  const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
  let best = null, bd = 1e9;
  for (const q of players.values()) {
    if (q === p || q.dead || q.car) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d > reach) continue;
    if (d > 8 && (dx * ca + dy * sa) / d < 0.3) continue;
    if (d < bd) { bd = d; best = q; }
  }
  if (!best) {
    for (const pd of peds) {
      if (pd.dead) continue;
      const dx = pd.x - p.x, dy = pd.y - p.y, d = Math.hypot(dx, dy);
      if (d > reach || (d > 8 && (dx * ca + dy * sa) / d < 0.3)) continue;
      pd.hp -= w.dmg;
      if (pd.hp <= 0) killPed(pd, p, now);
      return;
    }
    return;
  }
  if (now < best.protectUntil) return;
  const dx = best.x - p.x, dy = best.y - p.y, d = Math.hypot(dx, dy) || 1;
  best.kx = (dx / d) * 280; best.ky = (dy / d) * 280;
  if (p.career === 'thief' && !best.inf) {
    const s = Math.min(Math.floor(best.money * 0.12), 60);
    if (s > 0) { best.money -= s; p.money += s; }
  }
  damage(best, p.career === 'police' && w === WEAPONS.fist ? 14 : w.dmg, p, now);
}

/* ---- ยิงปืน (โจร/แอดมิน) ---- */
function shoot(p, now) {
  const w = WEAPONS[p.weapon];
  if (p.dead || p.car || !w || w.melee || !canShoot(p)) return;
  if (now - p.lastShot < w.cd * 0.9) return;
  if (!p.inf && p.ammo <= 0) { p.lastShot = now; return toast(p, '🔫 กระสุนหมด! ซื้อเพิ่มที่ร้านอาวุธ'); }
  p.lastShot = now;
  if (!p.inf) p.ammo--;
  const lines = [], hits = new Map();
  for (let n = 0; n < w.pellets; n++) {
    const a = p.ang + (w.pellets > 1 ? (n / (w.pellets - 1) - 0.5) * 2 * w.spread : (Math.random() - 0.5) * 2 * w.spread);
    const ca = Math.cos(a), sa = Math.sin(a);
    let reach = w.range;
    for (let d = 14; d <= w.range; d += 10) {
      if (blocked(p.x + ca * d, p.y + sa * d, 1)) { reach = d - 10; break; }
    }
    let best = null, bt = 1e9;
    for (const q of players.values()) {
      if (q === p || q.dead || q.car) continue;
      const dx = q.x - p.x, dy = q.y - p.y, t = dx * ca + dy * sa;
      if (t < 0 || t > reach + 14) continue;
      if (Math.abs(-dx * sa + dy * ca) > 22) continue;
      if (t < bt) { bt = t; best = q; }
    }
    let pedHit = null, pt = best ? bt : 1e9;
    for (const pd of peds) {
      if (pd.dead) continue;
      const dx = pd.x - p.x, dy = pd.y - p.y, t = dx * ca + dy * sa;
      if (t < 0 || t > reach + 14 || Math.abs(-dx * sa + dy * ca) > 20) continue;
      if (t < pt) { pt = t; pedHit = pd; }
    }
    const end = pedHit ? pt : (best ? bt : reach);
    lines.push([Math.round(p.x), Math.round(p.y), Math.round(p.x + ca * end), Math.round(p.y + sa * end)]);
    if (pedHit) { pedHit.hp -= w.dmg; if (pedHit.hp <= 0 && !pedHit.dead) killPed(pedHit, p, now); }
    else if (best) hits.set(best, (hits.get(best) || 0) + w.dmg);
  }
  broadcast({ t: 'shot', l: lines });
  for (const [q, dmg] of hits) {
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
    q.kx = (dx / d) * 140; q.ky = (dy / d) * 140;
    damage(q, dmg, p, now);
  }
}

function damage(v, amt, att, now) {
  if (v.dead || v.god || now < v.protectUntil) return;
  v.hp -= amt * CAREERS[v.career].def;
  v.hurtT = now; v.lastHurt = now;
  if (v.hp <= 0) kill(v, att, now);
}
function kill(v, att, now) {
  v.hp = 0; v.dead = true; v.respawnAt = now + 3000; v.kx = v.ky = 0;
  if (v.car) { const cr = cars[v.car - 1]; if (cr) cr.driver = 0; v.car = 0; }
  const lose = v.inf ? 0 : Math.floor(v.money * 0.2); // เงินในธนาคารไม่หาย
  v.money -= lose;
  if (att && att !== v) {
    att.money += 40 + Math.floor(lose * 0.5);
    if (v.wantedUntil > now) {
      if (att.career === 'police') {
        const bounty = POLICE_BOUNTY + 50 * (v.stars || 0);
        att.money += bounty; v.wantedUntil = 0; v.stars = 0;
        feed(`🚓 ตำรวจ ${att.name} จับ ${v.name} ได้ รับค่าหัว $${bounty}`);
        return;
      }
    } else if (att.career !== 'police') {
      addStar(att, now);
    }
    feed(`${att.career === 'thief' && att.lastShot > now - 400 ? '🔫' : '👊'} ${att.name} น็อค ${v.name}`);
  } else {
    feed(`💀 ${v.name} ล้มลง`);
  }
}
function respawn(p, now) {
  const h = (byKind.hosp || [])[0];
  const sp = h ? { x: h.x + h.w / 2 + (Math.random() - 0.5) * 120, y: h.y + h.h + 30 } : spawnPoint();
  p.x = sp.x; p.y = sp.y; p.hp = p.maxhp; p.dead = false; p.wantedUntil = 0; p.stars = 0;
  toast(p, '🏥 คุณตื่นขึ้นที่โรงพยาบาล');
  p.hunger = Math.max(p.hunger, 30);
  p.protectUntil = now + 2000; p.kx = p.ky = 0;
}

function tpTo(p, x, y) {
  if (p.car) toggleCar(p);
  const r = collide(x, y, 14);
  p.x = r.x; p.y = r.y; p.kx = p.ky = 0;
}

/* ---- แอดมิน ---- */
function doAdmin(p, m) {
  if (!p.admin) return; // ตรวจฝั่งเซิร์ฟเวอร์ทุกครั้ง
  switch (m.a) {
    case 'tog': {
      if (!['fast', 'god', 'inf'].includes(m.k)) return;
      p[m.k] = !p[m.k];
      if (m.k === 'god' && p.god) { p.hp = p.maxhp; p.hunger = 100; }
      const label = { fast: '⚡ วิ่งเร็ว', god: '🛡️ อมตะ', inf: '💰 เงินไม่จำกัด' }[m.k];
      toast(p, `${label}: ${p[m.k] ? 'เปิด' : 'ปิด'}`);
      break;
    }
    case 'give': {
      const t = players.get(+m.id), amt = Math.floor(+m.amt);
      if (!t || !(amt > 0) || amt > 1e9) return toast(p, 'ข้อมูลไม่ถูกต้อง (เงิน 1 - 1,000,000,000)');
      t.money += amt;
      toast(p, `🎁 เสกเงิน $${amt.toLocaleString()} ให้ ${t.name} แล้ว`);
      if (t !== p) toast(t, `🎁 แอดมินให้เงินคุณ $${amt.toLocaleString()}`);
      break;
    }
    case 'ann': {
      const text = cleanText(m.m, 160);
      if (!text) return;
      broadcast({ t: 'announce', m: text, n: p.name });
      console.log(`[admin] ประกาศโดย ${p.name}: ${text}`);
      break;
    }
    case 'goto': case 'bring': {
      const t = players.get(+m.id);
      if (!t || t === p) return;
      if (m.a === 'goto') tpTo(p, t.x + 30, t.y); else tpTo(t, p.x + 30, p.y);
      toast(p, m.a === 'goto' ? `📍 วาร์ปไปหา ${t.name}` : `📍 ดึง ${t.name} มาหาคุณ`);
      break;
    }
    case 'kick': {
      const t = players.get(+m.id);
      if (!t || t === p || t.admin) return toast(p, 'เตะไม่ได้');
      feed(`🥾 ${t.name} ถูกแอดมินเตะออกจากเซิร์ฟเวอร์`);
      refuse(t.c, 'คุณถูกแอดมินเตะออกจากเซิร์ฟเวอร์');
      break;
    }
    case 'pw': {
      const pw = String(m.pw || '');
      if (pw.length < 6 || pw.length > 64) return toast(p, 'รหัสต้องยาว 6-64 ตัวอักษร');
      setAdminPw(pw, true);
      let kicked = 0;
      for (const q of players.values()) {
        if (q !== p && q.admin) { q.admin = false; q.fast = q.god = q.inf = false; kicked++; toast(q, '🔒 รหัสแอดมินถูกเปลี่ยน สิทธิ์แอดมินของคุณสิ้นสุดแล้ว'); }
      }
      if (kicked) sendRoster();
      toast(p, '🔑 เปลี่ยนรหัสแอดมินแล้ว (ใช้รหัสใหม่ครั้งหน้า)');
      console.log(`[admin] ${p.name} เปลี่ยนรหัสแอดมิน`);
      break;
    }
  }
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
  let best = null, bd = 80, lockedNear = false;
  for (const car of cars) {
    if (!car.active || car.driver) continue;
    const d = Math.hypot(car.x - p.x, car.y - p.y);
    if (car.owner && car.owner !== p.id) { if (d < 80) lockedNear = true; continue; }
    if (d < bd) { bd = d; best = car; }
  }
  if (best) { best.driver = p.id; best.idle = 0; p.car = best.id; p.kx = p.ky = 0; }
  else if (lockedNear) toast(p, '🔒 รถคันนี้เป็นของผู้เล่นคนอื่น');
}

function updateCar(car, dt) {
  const d = car.driver ? players.get(car.driver) : null;
  const boost = d && d.fast ? 1.5 : 1;
  const MAXS = car.max * boost, ACC = car.acc * boost, BRAKE = 900, FRIC = 260;
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
    if (car.home && car.idle > 120 && (car.x !== car.home.x || car.y !== car.home.y)) {
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
    const spd = 175 * (p.fast ? 2.4 : 1);
    const nx = p.x + (mx * spd + p.kx) * dt;
    const ny = p.y + (my * spd + p.ky) * dt;
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
  // หิว: ค่อยๆ ลด หิวจัดเลือดค่อยๆ ลด (แต่ไม่ถึงตาย)
  if (p.god) { p.hp = p.maxhp; p.hunger = 100; }
  else {
    p.hunger = Math.max(0, p.hunger - dt / HUNGER_SECS);
    if (p.hunger <= 0) p.hp = Math.max(1, p.hp - 1 * dt);
  }
  // ฟื้นเลือดช้าๆ เมื่อไม่โดนตีนาน 5 วิ และไม่หิวจัด
  if (now - p.lastHurt > 5000 && p.hp < p.maxhp && p.hunger >= 20) p.hp = Math.min(p.maxhp, p.hp + 0.6 * dt);
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

function buildMe(p, now) {
  return JSON.stringify({
    t: 'me', hp: Math.ceil(p.hp), mhp: p.maxhp, money: Math.floor(p.money), bank: Math.floor(p.bank),
    hunger: Math.ceil(p.hunger), ammo: p.ammo, gun: canShoot(p), wp: p.weapon, own: [...p.weapons], carm: p.carModel, career: p.career,
    wanted: p.wantedUntil > now, stars: p.wantedUntil > now ? p.stars : 0, dead: p.dead,
    adm: p.admin, fast: p.fast, god: p.god, inf: p.inf,
  });
}

let last = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  for (const car of cars) if (car.active && !car.npc) updateCar(car, dt);
  for (const car of npcCars) updateNpc(car, dt);
  for (const pd of peds) updatePed(pd, dt, now);
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

  // รถผู้เล่นชนคนเดินถนน
  for (const car of cars) {
    if (!car.active || car.driver <= 0 || Math.abs(car.speed) < 100) continue;
    const dr = players.get(car.driver);
    for (const pd of peds) if (!pd.dead && Math.hypot(pd.x - car.x, pd.y - car.y) < 30) killPed(pd, dr, now);
  }
  // รถผู้เล่นชนรถจราจร / รถจราจรชนคนเดินเท้า
  for (const nc of npcCars) {
    for (const car of cars) {
      if (car === nc || !car.active || car.driver <= 0) continue;
      const dx = car.x - nc.x, dy = car.y - nc.y, d = Math.hypot(dx, dy);
      if (d < 46 && d > 0.01) {
        const push = (46 - d) / d;
        car.x += dx * push; car.y += dy * push;
        if (Math.abs(car.speed) > 60) car.speed *= -0.25;
        nc.speed = 0;
      }
    }
    if (nc.speed > 40) {
      for (const p of players.values()) {
        if (p.dead || p.car || now - p.lastCarHit < 900) continue;
        if (Math.hypot(p.x - nc.x, p.y - nc.y) > 34) continue;
        p.lastCarHit = now;
        const f = HD[nc.hd]; p.kx = f[0] * 260; p.ky = f[1] * 260;
        damage(p, 10, null, now);
      }
    }
  }

  // snapshot
  const ps = [];
  for (const p of players.values()) {
    const fl = (now - p.punchT < 220 ? 1 : 0) | (p.wantedUntil > now ? 2 : 0) | (now - p.hurtT < 200 ? 4 : 0) | (now < p.protectUntil ? 8 : 0);
    ps.push([p.id, Math.round(p.x), Math.round(p.y), Math.round(p.ang * 100), Math.ceil(p.hp), p.car, fl]);
  }
  const cs = cars.filter(c => c.active).map(c => [c.id, Math.round(c.x), Math.round(c.y), Math.round(c.ang * 100), c.driver, c.color]);
  const ns = peds.filter(a => !a.dead).map(a => [a.id, Math.round(a.x), Math.round(a.y), a.hd, a.look]);
  const buf = frame(JSON.stringify({ t: 's', p: ps, c: cs, n: ns }));
  for (const c of conns) {
    const p = c.p;
    if (!p) continue;
    sendRaw(c, buf);
    const me = buildMe(p, now);
    if (me !== p.lastMe) { p.lastMe = me; sendRaw(c, frame(me)); }
  }
}
setInterval(tick, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`STREET CITY ONLINE v2 พร้อมแล้ว → http://localhost:${PORT}  (จำกัด ${MAX_PLAYERS} คน)`);
  if (generatedPw) {
    console.log('============================================================');
    console.log(` รหัสแอดมิน (สุ่มให้ครั้งแรก): ${generatedPw}`);
    console.log(' แนะนำให้ตั้งรหัสเอง: ตั้งตัวแปร ADMIN_PASSWORD หรือเปลี่ยนในแผงแอดมิน');
    console.log('============================================================');
  } else {
    console.log('แอดมิน: ใช้รหัสจาก admin.json หรือตัวแปร ADMIN_PASSWORD');
  }
});
function shutdown() { for (const p of players.values()) saveOne(p); flushSaves(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
