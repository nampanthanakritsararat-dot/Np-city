'use strict';
/*
 * Np city RP (STREET CITY ONLINE v3) — dedicated game server
 * - ไม่ต้องติดตั้งแพ็กเกจเพิ่ม (ใช้ Node.js 18+ อย่างเดียว)
 * - HTTP + WebSocket (เขียน handshake/frame เอง) ที่พอร์ตเดียวกัน
 * - ห้องเดียวทั้งเซิร์ฟเวอร์ จำกัด 50 คน
 * - ระบบผู้สร้าง (แอดมิน): ต้องรู้รหัสถึงจะเข้าได้ รหัสเริ่มต้น nampan (เก็บเป็นแฮช) เปลี่ยนได้ในเกม/หน้าล็อบบี้ (ต้องใส่รหัสเดิมก่อน)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = 50;
const TICK_MS = 50; // 20 ครั้ง/วินาที
const CITY_NAME = 'Np-city RP';
const VERSION = 'v3.3';
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
  if (p.noSave) return;
  saves[p.token] = {
    name: p.name, money: Math.floor(p.money), bank: Math.floor(p.bank), career: p.career,
    weapons: [...p.weapons], car: p.carModel ? { m: p.carModel, c: p.carColor } : null,
    look: p.look, inv: p.inv, unl: [...p.unl], prog: p.prog, ts: Date.now(),
  };
  dirty = true;
}
setInterval(() => { for (const p of players.values()) saveOne(p); flushSaves(); }, 10000);

/* ------------------------------ รหัสแอดมิน / รหัสผู้สร้าง ------------------------------ */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
const DEF_SALT = Buffer.from('ccc0a10f5f78faadcf00d77986414179', 'hex');
const DEF_HASH = Buffer.from('726c5e818ab77f02f03e01f015f8dab657f2687f8431e52ae0d0e9e2e4d78e59', 'hex'); // แฮชของรหัสเริ่มต้น nampan
function mkCred(envName) {
  const v = process.env[envName];
  if (v && String(v).length > 0) { const salt = crypto.randomBytes(16); return { salt, hash: hashPw(String(v), salt), env: true }; }
  return { salt: DEF_SALT, hash: DEF_HASH, env: false };
}
// รหัสแอดมิน (ช่องในหน้าล็อบบี้): ตั้งที่ Render → Environment → ADMIN_PASSWORD (ไม่ตั้ง = nampan)
// รหัสระบบผู้สร้าง (ปลดล็อกแท็บ ประกาศ/เตะ/เสก/รีเซ็ต): CREATOR_PASSWORD (ไม่ตั้ง = nampan)
const CRED = { admin: mkCred('ADMIN_PASSWORD'), creator: mkCred('CREATOR_PASSWORD') };
function checkPw(which, pw) {
  const c = CRED[which];
  if (typeof pw !== 'string' || pw.length === 0 || pw.length > 64) return false;
  return crypto.timingSafeEqual(hashPw(pw, c.salt), c.hash);
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
/** ตรวจรหัสผู้สร้างพร้อมกันเดา: คืน 'ok' | 'bad' | 'locked' */
function authPw(ip, pw, which = 'admin') {
  if (ipLocked(ip)) return 'locked';
  if (!checkPw(which, pw)) { recordFail(ip); console.log(`[admin] รหัสผิดจาก ${ip}`); return 'bad'; }
  fails.delete(ip);
  return 'ok';
}
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (now - f.first > 1200000) fails.delete(ip); }, 60000);

/* ------------------------------ อาชีพ ------------------------------ */
const CAREERS = {
  worker:  { n: 'พนักงานออฟฟิศ', hp: 100, def: 1,    salary: 12 },
  student: { n: 'นักเรียน',       hp: 100, def: 1,    salary: 4 },   // ไปโรงเรียนได้ค่าขนม/ทุนเพิ่ม
  fisher:  { n: 'นักตกปลา',       hp: 100, def: 1,    salary: 0 },   // ตกปลาที่บ่อ ขายที่ตลาดปลา
  taxi:    { n: 'แท็กซี่',        hp: 100, def: 1,    salary: 0 },
  police:  { n: 'ตำรวจ',          hp: 130, def: 0.75, salary: 8 },
  doctor:  { n: 'หมอ',            hp: 100, def: 1,    salary: 6 },
  thief:   { n: 'โจร',            hp: 90,  def: 1,    salary: 0 },
};
const FISH = [['🐟 ปลาซิว', 8, 0.5], ['🐠 ปลานิล', 20, 0.3], ['🐡 ปลาช่อน', 45, 0.15], ['🦈 ปลากะพง', 120, 0.05]];
const FARE_DIST = 150;      // แท็กซี่: ขับครบกี่พิกเซลได้ $1
const POLICE_BOUNTY = 200;
const MAX_AMMO = 90;
const WEAPONS = {
  fist:    { n: '👊 มือเปล่า',   melee: true, dmg: 14, cd: 380, reach: 70 },
  bat:     { n: '🏏 ไม้เบสบอล', melee: true, dmg: 26, cd: 480, reach: 84, price: 150 },
  knife:   { n: '🔪 มีด',        melee: true, dmg: 34, cd: 360, reach: 72, price: 350 },
  pistol:  { n: '🔫 ปืนพก',      dmg: 24, cd: 330, range: 560, pellets: 1, spread: 0,    price: 200 },
  smg:     { n: '🔫 SMG',        dmg: 12, cd: 110, range: 500, pellets: 1, spread: 0.05, price: 900 },
  shotgun: { n: '💥 ลูกซอง',     dmg: 10, cd: 800, range: 300, pellets: 6, spread: 0.22, price: 1200 },
  rifle:   { n: '🎯 ไรเฟิล',     dmg: 32, cd: 220, range: 780, pellets: 1, spread: 0.02, price: 2500 },
};
const WORDER = ['fist', 'bat', 'knife', 'pistol', 'smg', 'shotgun', 'rifle'];
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
    ['ammo',    '🔫 กระสุน 12 นัด', 40,   `ใช้กับปืนทุกกระบอก · สะสมสูงสุด ${MAX_AMMO} นัด`],
    ['bat',     '🏏 ไม้เบสบอล',     150,  'ดาเมจ 26 · ระยะไกลกว่ามือเปล่า'],
    ['knife',   '🔪 มีด',           350,  'ดาเมจ 34 · ฟันเร็ว'],
    ['pistol',  '🔫 ปืนพก',         200,  'ดาเมจ 24 · แม่นยำ'],
    ['smg',     '🔫 SMG',           900,  'ยิงรัวเร็ว ดาเมจ 12/นัด'],
    ['shotgun', '💥 ลูกซอง',        1200, 'ยิงกระจาย ระยะใกล้แรงมาก'],
    ['rifle',   '🎯 ไรเฟิล',        2500, 'ดาเมจ 32 · ยิงไกลมาก'],
    ['sell_wpn', '💱 ขายอาวุธที่ถืออยู่', 0, 'ได้เงินคืน 50% ของราคา'],
  ] },
  market: { title: '🐟 ตลาดปลา', items: [
    ['sell_fish', '💰 ขายปลาทั้งหมด', 0, 'ซิว $8 · นิล $20 · ช่อน $45 · กะพง $120 (เลเวลสูง ได้เพิ่ม)'],
  ] },
  police: { title: '🚓 สถานีตำรวจ', items: [
    ['join_police', '🚓 สมัครเป็นตำรวจ', 0, 'เปลี่ยนอาชีพ แล้วกดปุ่ม 🚓 (หรือ R) จับกุมคนที่มีค่าหัวเข้าคุก'],
  ] },
  cloth: { title: '👕 ร้านเสื้อผ้า', colors: 12, pal: 'cloth', items: [
    ['shirt', '👕 เปลี่ยนสีเสื้อ',   30, 'เลือกสีด้านล่างก่อนกดซื้อ'],
    ['pants', '👖 เปลี่ยนสีกางเกง', 30, 'เลือกสีด้านล่างก่อนกดซื้อ'],
    ['skin',  '🧑 เปลี่ยนสีผิว',    0,  'ฟรี (เลือก 0-5)'],
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
const MENU_KINDS = Object.keys(MENUS);
const FOOD = { snack: 15, drink: 10, noodle: 30, burger: 40, steak: 80 };

/* ------------------------------ แผนที่เมือง ------------------------------ */
const CELL = 400, N = 14, W = CELL * N, ROAD = 120;
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
  '2,2': 'shop', '11,3': 'shop', '7,9': 'shop', '3,11': 'shop', '12,12': 'shop',
  '5,4': 'job', '9,8': 'job', '3,7': 'job',
  '4,2': 'rest', '10,5': 'rest', '6,7': 'rest', '11,10': 'rest',
  '7,2': 'hosp', '2,12': 'hosp',
  '5,6': 'bank', '10,2': 'bank',
  '13,8': 'gun', '1,5': 'gun',
  '8,5': 'dealer', '3,3': 'dealer', '11,11': 'dealer',
  '7,7': 'farm', '3,10': 'farm', '11,6': 'farm',          // เซฟโซน 3 จุด (จุดยืนฟามเงิน)
  '12,1': 'lake', '1,8': 'lake', '9,12': 'lake',          // บ่อตกปลา
  '12,2': 'market', '2,8': 'market', '10,12': 'market',   // ตลาดปลา
  '4,9': 'cloth', '10,9': 'cloth',                        // ร้านเสื้อผ้า
  '6,3': 'school', '12,6': 'school',                      // โรงเรียน
  '9,3': 'jail',                                          // คุก
  '8,3': 'police',                                        // สถานีตำรวจ (เดินเข้าลานได้)
};
const KIND_IDX = { bld: 0, park: 1, shop: 2, job: 3, rest: 4, hosp: 5, bank: 6, gun: 7, dealer: 8, farm: 9, lake: 10, market: 11, cloth: 12, school: 13, jail: 14, police: 15 };
const blocks = [];
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    let k = PLACES[i + ',' + j];
    if (!k) k = rnd() < 0.16 ? 'park' : 'bld';
    blocks.push({
      x: i * CELL + ROAD / 2, y: j * CELL + ROAD / 2, w: CELL - ROAD, h: CELL - ROAD,
      k, c: Math.floor(rnd() * 6), z: Math.floor(20 + rnd() * 50),
    });
  }
}
const solid = blocks.filter(b => b.k !== 'park' && b.k !== 'farm' && b.k !== 'police');
// สถานีตำรวจ: เดินเข้าลานด้านหน้าได้ ส่วนตัวอาคารด้านหลังเป็นของแข็ง
for (const b of blocks) if (b.k === 'police') solid.push({ x: b.x + b.w * 0.15, y: b.y + b.h * 0.06, w: b.w * 0.7, h: b.h * 0.34, k: 'bld' });
const byKind = {};
for (const b of blocks) (byKind[b.k] = byKind[b.k] || []).push(b);
const farms = byKind.farm || [], jailBlock = (byKind.jail || [])[0];
/** อยู่ในเซฟโซน (ลานฟาม) หรือไม่ */
function inSafe(p) {
  for (const b of farms) if (p.x > b.x - 8 && p.x < b.x + b.w + 8 && p.y > b.y - 8 && p.y < b.y + b.h + 8) return true;
  return false;
}
const nearestOf = (list, x, y) => { let best = list[0], bd = 1e18; for (const b of list) { const d = (b.x + b.w / 2 - x) ** 2 + (b.y + b.h / 2 - y) ** 2; if (d < bd) { bd = d; best = b; } } return best; };

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
for (let n = 1; n <= 6; n++) {
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
    if (r > straight && k >= 1 && k <= N - 1) {
      const nhd = r < straight + (1 - straight) / 2 ? (m.hd + 1) % 4 : (m.hd + 3) % 4;
      mvPlace(m, nhd, k, m.line * CELL, off);
      return;
    }
  }
  if (horiz) m.x = na; else m.y = na;
}
const randAlong = () => Math.random() * (W - 200) + 100;
const randLine = () => 1 + Math.floor(Math.random() * (N - 1));
const npcCars = [];
for (let n = 0; n < 5; n++) {
  const car = { id: cars.length + 1, x: 0, y: 0, ang: 0, speed: 0, color: Math.floor(Math.random() * 8), driver: -1, idle: 0, home: null, active: true, owner: 0, max: 150, acc: 200, npc: true, hd: 0, line: 1, stop: 0, ghost: 0 };
  mvPlace(car, Math.floor(Math.random() * 4), randLine(), randAlong(), 22);
  car.ang = car.hd * Math.PI / 2;
  cars.push(car); npcCars.push(car);
}
const peds = [];
for (let n = 0; n < 40; n++) {
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
    res.end(JSON.stringify({ ver: VERSION, city: CITY_NAME, n: players.size, max: MAX_PLAYERS, names: [...players.values()].map(p => p.name).slice(0, 30) }));
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
  broadcast({ t: 'roster', list: [...players.values()].map(p => [p.id, p.name, p.career, p.platform, p.admin ? 1 : 0, p.look[0], p.look[1], p.look[2]]) });
}
const feed = m => broadcast({ t: 'feed', m });
const toast = (p, m) => send(p, { t: 'toast', m });
const canShoot = p => !(p.jailUntil > Date.now());
const lvlOf = g => 1 + Math.floor(Math.sqrt(g.xp / 25));
const progOf = p => p.prog[p.career] || (p.prog[p.career] = { xp: 0, earned: 0, n: 0 });
/** รายได้จากอาชีพ: ได้ XP + โบนัสตามเลเวล (เซฟแยกตามอาชีพ) */
function earn(p, base, bonus = true) {
  if (!(base > 0)) return;
  const g = progOf(p), l0 = lvlOf(g);
  const amt = bonus ? base * (1 + 0.08 * (l0 - 1)) : base;
  p.money += amt; g.earned += amt; g.xp += amt;
  const l1 = lvlOf(g);
  if (l1 > l0) toast(p, `⭐ ${CAREERS[p.career].n} เลเวล ${l1}! รายได้เพิ่มขึ้น`);
}
function revokeAdmins(except) {
  let n = 0;
  for (const q of players.values()) {
    if (q !== except && q.admin) { q.admin = false; q.fast = q.god = q.inf = false; n++; toast(q, '🔒 รหัสผู้สร้างถูกเปลี่ยน สิทธิ์ของคุณสิ้นสุดแล้ว'); }
  }
  if (n) sendRoster();
}

function doJoin(c, m) {
  clearTimeout(c.joinTimer);
  if (players.size >= MAX_PLAYERS) return refuse(c, `เซิร์ฟเวอร์เต็มแล้ว (${MAX_PLAYERS}/${MAX_PLAYERS}) ลองใหม่อีกครั้งภายหลัง`);
  const name = cleanName(m.name);
  if (Array.from(name).length < 2) return refuse(c, 'ชื่อต้องยาว 2-14 ตัวอักษร');
  const low = name.toLowerCase();
  for (const q of players.values()) if (q.name.toLowerCase() === low) return refuse(c, 'ชื่อนี้มีคนใช้อยู่แล้ว');
  const token = typeof m.token === 'string' && /^[\w-]{16,64}$/.test(m.token) ? m.token : crypto.randomBytes(12).toString('hex');
  for (const q of players.values()) if (q.token === token) return refuse(c, 'บัญชีนี้กำลังออนไลน์อยู่ในอีกแท็บ');

  let isAdmin = false, isCreator = false;
  if (typeof m.creator === 'string' && m.creator.length > 0) {
    const r = authPw(c.ip, m.creator, 'creator');
    if (r === 'locked') return refuse(c, 'ใส่รหัสผิดหลายครั้ง ถูกล็อกชั่วคราว ลองใหม่ภายหลัง');
    if (r === 'bad') return refuse(c, 'รหัสระบบผู้สร้างไม่ถูกต้อง');
    isCreator = true; isAdmin = true;   // ผู้สร้างใช้แผงแอดมินได้ด้วย
  }
  if (typeof m.admin === 'string' && m.admin.length > 0) {
    const r = authPw(c.ip, m.admin);
    if (r === 'locked') return refuse(c, 'ใส่รหัสแอดมินผิดหลายครั้ง ถูกล็อกชั่วคราว ลองใหม่ภายหลัง');
    if (r === 'bad') return refuse(c, 'รหัสแอดมินไม่ถูกต้อง');
    isAdmin = true;
  }

  const save = saves[token];
  const unl = new Set(save && Array.isArray(save.unl) ? save.unl.filter(k => CAREERS[k]) : []);
  const okCareer = k => CAREERS[k] && (!CAREERS[k].price || unl.has(k) || isAdmin);
  const career = okCareer(m.career) ? m.career : (save && okCareer(save.career) ? save.career : 'worker');
  const lk = Array.isArray(m.look) ? m.look : (save && Array.isArray(save.look) ? save.look : null);
  const ri = n => Math.floor(Math.random() * n);
  const look = lk ? [clamp(lk[0] | 0, 0, 11), clamp(lk[1] | 0, 0, 11), clamp(lk[2] | 0, 0, 5)] : [ri(12), ri(12), ri(6)];
  const inv = [0, 0, 0, 0];
  if (save && Array.isArray(save.inv)) for (let i = 0; i < 4; i++) inv[i] = clamp(save.inv[i] | 0, 0, 9999);
  const prog = {};
  if (save && save.prog && typeof save.prog === 'object') {
    for (const k of Object.keys(CAREERS)) {
      const g = save.prog[k];
      if (g && typeof g === 'object') prog[k] = { xp: Math.max(0, +g.xp || 0), earned: Math.max(0, +g.earned || 0), n: Math.max(0, g.n | 0) };
    }
  }
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
    creator: isCreator, look, inv, unl, prog, jailUntil: 0, fishing: 0, farmAcc: 0, studyAcc: 0, work: false, lastSafeMsg: 0,
  };
  progOf(p);
  c.p = p;
  players.set(p.id, p);
  { const si = slotUsed.indexOf(false); slotUsed[si] = true; p.carSlot = PRIV0 + si + 1; }
  if (save && Array.isArray(save.weapons)) for (const k of save.weapons) if (WEAPONS[k]) p.weapons.add(k);
  if (career === 'thief') p.weapons.add('pistol');
  if (isAdmin) for (const k of WORDER) p.weapons.add(k);
  p.weapon = p.weapons.has('pistol') ? 'pistol' : 'fist';
  if (p.weapon !== 'fist') p.ammo = 24;
  if (save && save.car && CAR_MODELS[save.car.m]) { p.carModel = save.car.m; p.carColor = (save.car.c | 0) & 7; placeCar(p, nearestOf(byKind.dealer, p.x, p.y)); }
  send(p, {
    t: 'welcome', id: p.id, token, W, max: MAX_PLAYERS, admin: isAdmin, weapons: WEAPONS, worder: WORDER,
    city: CITY_NAME, fish: FISH.map(f => [f[0], f[1]]),
    careers: Object.fromEntries(Object.entries(CAREERS).map(([k, v]) => [k, { n: v.n, price: v.price || 0 }])),
    blocks: blocks.map(b => [b.x, b.y, b.w, b.h, KIND_IDX[b.k], b.c, b.z]),
    you: { x: p.x, y: p.y },
    menus: MENUS,
  });
  sendRoster();
  feed(`➕ ${isAdmin ? '🛠️ ' : ''}${p.name} เข้าเมือง (${players.size}/${MAX_PLAYERS})`);
  if (isAdmin) console.log(`[admin] ${p.name} เข้าสู่ระบบ${isCreator ? 'ผู้สร้าง' : 'แอดมิน'}`);
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
  if (!c.p) {
    if (m.t === 'join') doJoin(c, m);
    return;
  }
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
    case 'job': {
      if (p.dead || p.car || p.jailUntil > now || !CAREERS[m.career] || !nearBlock(p, byKind.job || [], 60)) return;
      const cd = CAREERS[m.career];
      if (cd.price && !p.unl.has(m.career) && !p.admin) {
        if (!m.buy) return toast(p, `🔒 ${cd.n} ล็อกอยู่ ต้องซื้อในเกมราคา $${cd.price.toLocaleString()}`);
        if (p.money < cd.price) return toast(p, `เงินไม่พอ 💸 (ต้องใช้ $${cd.price.toLocaleString()})`);
        p.money -= cd.price; p.unl.add(m.career);
        toast(p, `🔓 ปลดล็อกอาชีพ ${cd.n} แล้ว!`);
      }
      setCareer(p, m.career);
      break;
    }
    case 'fish': castFish(p, now); break;
    case 'arrest': arrest(p, now); break;
    case 'give': doGive(p, m); break;
    case 'chat': {
      if (now - p.lastChat < 800) return;
      const text = cleanText(m.m, 100);
      if (!text) return;
      p.lastChat = now;
      const wm = /^\/w\s+(\S+)\s+(.+)$/i.exec(text);
      if (wm) {
        const t = [...players.values()].find(q => q.name.toLowerCase() === wm[1].toLowerCase());
        if (!t) return toast(p, 'ไม่พบผู้เล่นชื่อนี้ (พิมพ์ /w ชื่อ ข้อความ)');
        const o = { t: 'chat', id: p.id, n: `🔒 ${p.name} → ${t.name}`, m: wm[2], a: 0, b: 0 };
        send(p, o); if (t !== p) send(t, o);
        break;
      }
      if (/^\/me\s+/i.test(text)) { broadcast({ t: 'chat', id: p.id, n: '✦', m: p.name + ' ' + text.replace(/^\/me\s+/i, ''), a: 0, b: 0 }); break; }
      broadcast({ t: 'chat', id: p.id, n: p.name, m: text, a: p.admin ? 1 : 0, b: 1 });
      break;
    }
    case 'wpn': {
      const id = String(m.w || '');
      if (!WEAPONS[id] || !p.weapons.has(id)) return;
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
function dealerSpot(car, b) {
  b = b || (byKind.dealer || [])[0];
  if (!b) return { x: 400, y: 400 };
  return { x: b.x + 40 + (car.id % 5) * 50, y: b.y + b.h + 28 };
}
/** วางรถส่วนตัวของผู้เล่น: at = บล็อกร้านขายรถ หรือจุด {x,y} */
function placeCar(p, at) {
  const car = cars[p.carSlot - 1], def = CAR_MODELS[p.carModel];
  if (!car || !def) return;
  const sp = at && at.w === undefined && at.x !== undefined ? { x: at.x, y: at.y } : dealerSpot(car, at);
  Object.assign(car, { active: true, owner: p.id, x: sp.x, y: sp.y, ang: 0, speed: 0, driver: 0, idle: 0, color: p.carColor, max: def.max, acc: def.acc });
}
function nearBlk(p, list, range) {
  for (const b of list) {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
    if (Math.hypot(dx, dy) < range) return b;
  }
  return null;
}
function doBuy(p, id, m) {
  const it = ITEMS[id];
  const now = Date.now();
  if (!it || p.dead || p.car || p.jailUntil > now) return;
  const shopB = nearBlk(p, byKind[it.kind] || [], 60);
  if (!shopB) return;

  if (it.kind === 'bank') {
    const dep = id.startsWith('dep');
    let amt = id.endsWith('_all') ? Math.floor(dep ? p.money : p.bank) : 100;
    amt = Math.min(amt, Math.floor(dep ? p.money : p.bank));
    if (amt <= 0) return toast(p, dep ? 'ไม่มีเงินให้ฝาก' : 'ไม่มีเงินในธนาคาร');
    if (dep) { p.money -= amt; p.bank += amt; } else { p.bank -= amt; p.money += amt; }
    return toast(p, `🏦 ${dep ? 'ฝาก' : 'ถอน'} $${amt} แล้ว`);
  }

  if (it.kind === 'police') {
    if (p.career === 'police') return toast(p, 'คุณเป็นตำรวจอยู่แล้ว 🚓');
    setCareer(p, 'police');
    return;
  }

  if (it.kind === 'market') {   // ขายปลา
    let total = 0, cnt = 0;
    for (let i = 0; i < 4; i++) { total += p.inv[i] * FISH[i][1]; cnt += p.inv[i]; p.inv[i] = 0; }
    if (cnt <= 0) return toast(p, 'คุณไม่มีปลาให้ขาย 🎣');
    earn(p, total);
    progOf(p).n += 0;
    return toast(p, `💰 ขายปลา ${cnt} ตัว ได้เงินรวม`);
  }

  if (it.kind === 'cloth') {
    const c = m && Number.isInteger(m.color) ? m.color : -1;
    const idx = id === 'shirt' ? 0 : id === 'pants' ? 1 : 2;
    if (c < 0 || c > (idx === 2 ? 5 : 11)) return toast(p, 'เลือกสีก่อน แล้วค่อยกดซื้อ 🎨');
    if (!p.inf && p.money < it.price) return toast(p, 'เงินไม่พอ 💸');
    if (!p.inf) p.money -= it.price;
    p.look[idx] = c; sendRoster(); saveOne(p);
    return toast(p, '👕 เปลี่ยนลุคเรียบร้อย!');
  }

  if (it.kind === 'dealer') {
    if (id === 'car_call') {
      if (!p.carModel) return toast(p, 'คุณยังไม่มีรถส่วนตัว ซื้อได้ที่นี่เลย 🚗');
      placeCar(p, shopB);
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
    placeCar(p, shopB);
    return toast(p, `🎉 ซื้อ ${def.n} แล้ว จอดอยู่หน้าร้าน!${refund ? ` (รับซื้อรถเก่า $${refund})` : ''}`);
  }

  if (it.kind === 'gun') {
    if (id === 'sell_wpn') {
      const w = WEAPONS[p.weapon];
      if (!w || !w.price || !p.weapons.has(p.weapon)) return toast(p, 'ถืออาวุธที่ขายได้ไว้ก่อน (มือเปล่าขายไม่ได้)');
      const back = Math.floor(w.price * 0.5);
      p.weapons.delete(p.weapon); p.money += back;
      toast(p, `💱 ขาย ${w.n} ได้ $${back}`);
      p.weapon = 'fist';
      return;
    }
    const w = WEAPONS[id];
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

/* ---- เปลี่ยนอาชีพ / ตกปลา / จับเข้าคุก / ให้ของกัน ---- */
function setCareer(p, k) {
  p.career = k; p.maxhp = CAREERS[k].hp; p.hp = Math.min(p.hp, p.maxhp);
  p.payAcc = 0; p.fareAcc = 0; p.fishing = 0;
  if (k === 'thief') { p.ammo = Math.max(p.ammo, 12); p.weapons.add('pistol'); }
  const g = progOf(p);
  toast(p, `เปลี่ยนอาชีพเป็น ${CAREERS[k].n} (เลเวล ${lvlOf(g)}) · ความคืบหน้าของอาชีพนี้ถูกเซฟไว้`);
  saveOne(p); sendRoster();
}
function castFish(p, now) {
  if (p.career !== 'fisher' || p.dead || p.car || p.jailUntil > now) return;
  if (p.fishing) { p.fishing = 0; return toast(p, '🎣 เก็บเบ็ดแล้ว'); }
  if (!nearBlock(p, byKind.lake || [], 90)) return toast(p, '🎣 ต้องไปยืนริมบ่อตกปลา (พื้นที่สีน้ำเงิน)');
  p.fishing = now + 2500 + Math.random() * 3500;
  toast(p, '🎣 หย่อนเบ็ดแล้ว รอปลากินเบ็ด... (ขยับตัว = เก็บเบ็ด)');
}
function catchFish(p, now) {
  const g = progOf(p), boost = Math.min(0.15, (lvlOf(g) - 1) * 0.015);
  const w = [0.5 - boost, 0.3, 0.15 + boost * 0.6, 0.05 + boost * 0.4];
  let r = Math.random(), i = 0;
  while (i < 3 && r >= w[i]) { r -= w[i]; i++; }
  p.inv[i]++; g.n++; g.xp += FISH[i][1] * 0.5;
  toast(p, `🎣 ได้ ${FISH[i][0]}! (มี ${p.inv[i]} ตัว) นำไปขายที่ตลาดปลา`);
  p.fishing = now + 2500 + Math.random() * 3500;
}
function jailPlayer(q, by, now) {
  const stars = Math.max(1, q.stars || 1), secs = 25 + 15 * stars;
  if (q.car) { const cr = cars[q.car - 1]; if (cr) cr.driver = 0; q.car = 0; }
  q.jailUntil = now + secs * 1000; q.wantedUntil = 0; q.stars = 0; q.fishing = 0; q.kx = q.ky = 0;
  if (jailBlock) { q.x = jailBlock.x + jailBlock.w / 2 + (Math.random() - 0.5) * 100; q.y = jailBlock.y + jailBlock.h / 2 + (Math.random() - 0.5) * 100; }
  const fine = q.inf ? 0 : Math.floor(q.money * 0.1);
  q.money -= fine;
  toast(q, `🚔 คุณถูกจับเข้าคุก ${secs} วินาที (ค่าปรับ $${fine})`);
  if (by) {
    const bounty = POLICE_BOUNTY + 50 * stars;
    earn(by, bounty); progOf(by).n++;
    feed(`🚓 ตำรวจ ${by.name} จับ ${q.name} เข้าคุก ${secs} วิ (ค่าหัว $${bounty})`);
  } else feed(`🚔 ${q.name} ถูกจับเข้าคุก ${secs} วินาที`);
}
function arrest(p, now) {
  if (p.career !== 'police' || p.dead || p.car || p.jailUntil > now) return;
  let best = null, bd = 120;
  for (const q of players.values()) {
    if (q === p || q.dead || q.car || q.jailUntil > now || q.wantedUntil <= now || inSafe(q)) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = q; }
  }
  if (!best) return toast(p, '🚓 ไม่มีผู้ต้องหา (ต้องมีดาวค่าหัวและอยู่ใกล้คุณ)');
  jailPlayer(best, p, now);
}
function doGive(p, m) {
  const t = players.get(+m.id);
  if (!t || t === p || t.dead || p.dead) return;
  if (Math.hypot(t.x - p.x, t.y - p.y) > 220) return toast(p, 'ต้องอยู่ใกล้กันถึงจะให้ของได้');
  if (m.k === 'money') {
    const amt = Math.floor(+m.amt);
    if (!(amt > 0) || amt > 1e9) return toast(p, 'จำนวนเงินไม่ถูกต้อง');
    if (!p.inf && amt > p.money) return toast(p, 'เงินไม่พอ 💸');
    if (!p.inf) p.money -= amt;
    t.money += amt;
    toast(p, `🎁 ให้เงิน $${amt.toLocaleString()} แก่ ${t.name}`); toast(t, `🎁 ${p.name} ให้เงินคุณ $${amt.toLocaleString()}`);
  } else if (m.k === 'fish') {
    const f = clamp(m.f | 0, 0, 3), n = Math.min(Math.max(1, m.amt | 0), p.inv[f]);
    if (n <= 0) return toast(p, 'คุณไม่มีปลาชนิดนี้');
    p.inv[f] -= n; t.inv[f] += n;
    toast(p, `🎁 ให้ ${FISH[f][0]} ${n} ตัวแก่ ${t.name}`); toast(t, `🎁 ${p.name} ให้ ${FISH[f][0]} ${n} ตัว`);
  }
}

/* ---- ต่อย / ตีด้วยอาวุธประชิด (ช่วยเล็ง: เลือกเป้าที่ใกล้ที่สุดด้านหน้าแล้วหันหาให้) ---- */
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
function noFight(p, now) {
  if (inSafe(p)) {
    if (now - p.lastSafeMsg > 2000) { p.lastSafeMsg = now; toast(p, '🟢 เซฟโซน ห้ามต่อสู้'); }
    return true;
  }
  return false;
}
function punch(p, now) {
  const wd = WEAPONS[p.weapon], w = wd && wd.melee ? wd : WEAPONS.fist;
  if (p.dead || p.car || p.jailUntil > now || now - p.lastPunch < w.cd) return;
  if (noFight(p, now)) return;
  p.lastPunch = now; p.punchT = now;
  const reach = w.reach + 10, ca = Math.cos(p.ang), sa = Math.sin(p.ang);
  let best = null, bd = 1e9;
  for (const q of players.values()) {
    if (q === p || q.dead || q.car) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d > reach || (d > 10 && (dx * ca + dy * sa) / d < -0.1)) continue;
    if (d < bd) { bd = d; best = q; }
  }
  if (!best) {
    let bp = null, pdist = 1e9;
    for (const pd of peds) {
      if (pd.dead) continue;
      const dx = pd.x - p.x, dy = pd.y - p.y, d = Math.hypot(dx, dy);
      if (d > reach || (d > 10 && (dx * ca + dy * sa) / d < -0.1)) continue;
      if (d < pdist) { pdist = d; bp = pd; }
    }
    if (bp) {
      p.ang = Math.atan2(bp.y - p.y, bp.x - p.x);
      bp.hp -= w.dmg;
      if (bp.hp <= 0) killPed(bp, p, now);
    }
    return;
  }
  p.ang = Math.atan2(best.y - p.y, best.x - p.x);
  if (now < best.protectUntil || inSafe(best)) return;
  const dx = best.x - p.x, dy = best.y - p.y, d = Math.hypot(dx, dy) || 1;
  best.kx = (dx / d) * 280; best.ky = (dy / d) * 280;
  if (p.career === 'thief' && !best.inf) {
    const s = Math.min(Math.floor(best.money * 0.12), 60);
    if (s > 0) { best.money -= s; p.money += s; }
  }
  damage(best, p.career === 'police' && w === WEAPONS.fist ? 16 : w.dmg, p, now);
}

/* ---- ยิงปืน (ทุกอาชีพ มีช่วยเล็งอัตโนมัติ) ---- */
function shoot(p, now) {
  const w = WEAPONS[p.weapon];
  if (p.dead || p.car || p.jailUntil > now || !w || w.melee) return;
  if (now - p.lastShot < w.cd * 0.9) return;
  if (noFight(p, now)) return;
  if (!p.inf && p.ammo <= 0) { p.lastShot = now; return toast(p, '🔫 กระสุนหมด! ซื้อเพิ่มที่ร้านอาวุธ'); }
  p.lastShot = now;
  if (!p.inf) p.ammo--;
  // ช่วยเล็ง: ถ้ามีผู้เล่นอยู่ใกล้แนวเล็ง (±0.34 rad) ให้หันไปหาเป้านั้น
  let base = p.ang, bs = 9;
  for (const q of players.values()) {
    if (q === p || q.dead || q.car || inSafe(q)) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d > w.range || d < 1) continue;
    const df = Math.abs(angDiff(Math.atan2(dy, dx), p.ang));
    if (df < 0.34 && df + d / 6000 < bs) { bs = df + d / 6000; base = Math.atan2(dy, dx); }
  }
  p.ang = base;
  const lines = [], hits = new Map();
  for (let n = 0; n < w.pellets; n++) {
    const a = base + (w.pellets > 1 ? (n / (w.pellets - 1) - 0.5) * 2 * w.spread : (Math.random() - 0.5) * 2 * w.spread);
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
      if (Math.abs(-dx * sa + dy * ca) > 28) continue;
      if (t < bt) { bt = t; best = q; }
    }
    let pedHit = null, pt = best ? bt : 1e9;
    for (const pd of peds) {
      if (pd.dead) continue;
      const dx = pd.x - p.x, dy = pd.y - p.y, t = dx * ca + dy * sa;
      if (t < 0 || t > reach + 14 || Math.abs(-dx * sa + dy * ca) > 22) continue;
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
  if (v.dead || v.god || now < v.protectUntil || v.jailUntil > now || inSafe(v)) return;
  v.hp -= amt * CAREERS[v.career].def;
  v.hurtT = now; v.lastHurt = now;
  if (v.hp <= 0) kill(v, att, now);
}
function kill(v, att, now) {
  v.hp = 0; v.dead = true; v.respawnAt = now + 3000; v.kx = v.ky = 0; v.fishing = 0;
  if (v.car) { const cr = cars[v.car - 1]; if (cr) cr.driver = 0; v.car = 0; }
  const lose = v.inf ? 0 : Math.floor(v.money * 0.2); // เงินในธนาคารไม่หาย
  v.money -= lose;
  if (att && att !== v) {
    att.money += 40 + Math.floor(lose * 0.5);
    if (v.wantedUntil > now) {
      if (att.career === 'police') {
        const bounty = POLICE_BOUNTY + 50 * (v.stars || 0);
        earn(att, bounty); v.wantedUntil = 0; v.stars = 0;
        feed(`🚓 ตำรวจ ${att.name} จัดการ ${v.name} ได้ รับค่าหัว $${bounty}`);
        return;
      }
    } else if (att.career !== 'police') {
      addStar(att, now);
    }
    feed(`${att.lastShot > now - 400 ? '🔫' : '👊'} ${att.name} น็อค ${v.name}`);
  } else {
    feed(`💀 ${v.name} ล้มลง`);
  }
}
function respawn(p, now) {
  const hs = byKind.hosp || [];
  const h = hs.length ? nearestOf(hs, p.x, p.y) : null;
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

/* ---- ระบบผู้สร้าง (แอดมิน) ---- */
function resetCity(by) {
  for (const car of npcCars) { mvPlace(car, Math.floor(Math.random() * 4), randLine(), randAlong(), 22); car.ang = car.hd * Math.PI / 2; car.speed = 0; }
  for (const pd of peds) { mvPlace(pd, Math.floor(Math.random() * 4), randLine(), randAlong(), 50); pd.hp = 30; pd.dead = false; }
  for (const car of cars) if (car.active && !car.npc && !car.owner && !car.driver && car.home) { car.x = car.home.x; car.y = car.home.y; car.ang = car.home.ang; car.speed = 0; }
  const now = Date.now();
  for (const q of players.values()) { q.stars = 0; q.wantedUntil = 0; q.jailUntil = 0; q.fishing = 0; if (q.dead) q.respawnAt = now; }
  broadcast({ t: 'announce', m: '♻️ เมืองถูกรีเซ็ตใหม่ (NPC / รถ / ค่าหัว / คุก)', n: by.name });
  console.log(`[admin] ${by.name} รีเซ็ตเมือง`);
}
let restartTimer = null;
/** รีเซ็ตเซิร์ฟเวอร์: นับถอยหลังตามเวลาที่ตั้ง แล้วรีเซ็ตเมือง + เตะทุกคนพร้อมข้อความ "รีเซ็ต" */
function scheduleRestart(by, secs, wipe) {
  if (!(secs >= 5 && secs <= 3600)) return toast(by, 'ตั้งเวลา 5-3600 วินาที');
  if (restartTimer) clearInterval(restartTimer);
  let left = secs;
  const say = () => {
    const txt = left >= 60 ? `${Math.floor(left / 60)} นาที ${left % 60 ? (left % 60) + ' วินาที' : ''}` : `${left} วินาที`;
    broadcast({ t: 'announce', m: `♻️ เซิร์ฟเวอร์จะรีเซ็ตใน ${txt}${wipe ? ' (ล้างข้อมูลผู้เล่นทั้งหมด)' : ''}`, n: by.name });
  };
  say();
  console.log(`[admin] ${by.name} ตั้งรีเซ็ตเซิร์ฟเวอร์ใน ${secs} วินาที${wipe ? ' + ล้างเซฟ' : ''}`);
  restartTimer = setInterval(() => {
    left--;
    if (left > 0) { if (left <= 10 || left === 30 || left === 60 || (left % 300 === 0)) say(); return; }
    clearInterval(restartTimer); restartTimer = null;
    resetCity(by);
    if (wipe) { saves = {}; for (const q of players.values()) q.noSave = true; }
    dirty = true; flushSaves();
    for (const q of [...players.values()]) refuse(q.c, '♻️ รีเซ็ต — เซิร์ฟเวอร์ถูกรีเซ็ตแล้ว กรุณาเข้าเกมใหม่อีกครั้ง');
  }, 1000);
}
function doAdmin(p, m) {
  if (!p.admin) return; // ตรวจฝั่งเซิร์ฟเวอร์ทุกครั้ง
  const now = Date.now();
  if (['ann', 'kick', 'spawn', 'reset', 'resetcancel'].includes(m.a) && !p.creator) return toast(p, '🔒 ต้องเข้าด้วยรหัสระบบผู้สร้างจากหน้าล็อบบี้ก่อน');
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
      if (t !== p) toast(t, `🎁 ผู้สร้างให้เงินคุณ $${amt.toLocaleString()}`);
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
      feed(`🥾 ${t.name} ถูกผู้สร้างเตะออกจากเซิร์ฟเวอร์`);
      refuse(t.c, 'คุณถูกผู้สร้างเตะออกจากเซิร์ฟเวอร์');
      break;
    }
    case 'spawn': {   // เสกได้ทุกอย่าง
      const t = m.id ? players.get(+m.id) : p;
      if (!t) return;
      const v = String(m.v || '');
      switch (m.k) {
        case 'weapon':
          if (v === 'all') for (const k of WORDER) t.weapons.add(k);
          else if (WEAPONS[v]) { t.weapons.add(v); t.weapon = v; } else return;
          t.ammo = MAX_AMMO; break;
        case 'car': {
          const def = CAR_MODELS[v]; if (!def) return;
          t.carModel = v; t.carColor = Number.isInteger(m.color) ? clamp(m.color, 0, 7) : 0;
          const r = collide(t.x + 70, t.y, 24); placeCar(t, { x: r.x, y: r.y });
          break;
        }
        case 'heal': t.hp = t.maxhp; t.hunger = 100; break;
        case 'ammo': t.ammo = MAX_AMMO; break;
        case 'fish': t.inv = t.inv.map(n => n + 5); break;
        case 'unlock': t.unl.add('thief'); break;
        case 'clear': t.stars = 0; t.wantedUntil = 0; t.jailUntil = 0; break;
        case 'jail': jailPlayer(t, null, now); break;
        case 'money': { const amt = Math.floor(+m.amt); if (!(amt > 0) || amt > 1e9) return; t.money += amt; break; }
        case 'career': if (!CAREERS[v]) return; setCareer(t, v); break;
        default: return;
      }
      toast(p, '✨ เสกสำเร็จ');
      if (t !== p) toast(t, '✨ ผู้สร้างเสกของให้คุณ');
      break;
    }
    case 'tpk': {   // วาร์ปไปสถานที่
      const list = byKind[String(m.v || '')];
      if (!list || !list.length) return;
      const b = list[(m.i | 0) % list.length];
      tpTo(p, b.x + b.w / 2, String(m.v) === 'farm' ? b.y + b.h / 2 : b.y + b.h + 30);
      break;
    }
    case 'reset':
      if (m.mode === 'city') resetCity(p);       // รีเซ็ตเมืองทันที ไม่เตะใคร
      else scheduleRestart(p, Math.floor(+m.secs), !!m.wipe);
      break;
    case 'resetcancel':
      if (restartTimer) { clearInterval(restartTimer); restartTimer = null; broadcast({ t: 'announce', m: '✅ ยกเลิกการรีเซ็ตเซิร์ฟเวอร์แล้ว', n: p.name }); }
      break;
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
  const MAXS = car.max * boost, ACC = car.acc * boost, BRAKE = 1100, FRIC = 320;
  let th = 0, st = 0;
  if (d && !d.dead) { th = d.in.th; st = d.in.st; }
  if (th !== 0) {
    const target = th > 0 ? th * MAXS : th * MAXS * 0.4;
    const opposing = car.speed !== 0 && Math.sign(target) !== Math.sign(car.speed);
    car.speed = approach(car.speed, target, (opposing ? BRAKE : ACC) * dt);
  } else {
    car.speed = approach(car.speed, 0, FRIC * dt);
  }
  // ขับง่าย: เลี้ยวได้ตั้งแต่ความเร็วต่ำ ยิ่งเร็วยิ่งเลี้ยวนุ่มขึ้น
  car.ang += st * (2.9 - 1.3 * Math.min(1, Math.abs(car.speed) / Math.max(car.max, 1))) * dt * clamp(car.speed / 110, -1, 1);
  if (Math.abs(car.speed) > 0.5) {
    const r = collide(car.x + Math.cos(car.ang) * car.speed * dt, car.y + Math.sin(car.ang) * car.speed * dt, 22);
    car.x = r.x; car.y = r.y;
    if (r.hit && Math.abs(car.speed) > 20) car.speed *= 0.55;
  }
  if (d) {
    car.idle = 0;
    if (d.career === 'taxi') {
      d.fareAcc += Math.abs(car.speed) * dt;
      if (d.fareAcc >= FARE_DIST) { const k = Math.floor(d.fareAcc / FARE_DIST); earn(d, k); d.fareAcc -= k * FARE_DIST; }
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
  if (p.jailUntil > 0 && now >= p.jailUntil) {
    p.jailUntil = 0;
    if (jailBlock) { p.x = jailBlock.x + jailBlock.w / 2; p.y = jailBlock.y + jailBlock.h + 34; }
    p.protectUntil = now + 2000;
    toast(p, '🔓 คุณถูกปล่อยตัวแล้ว ประพฤติตัวดีๆ นะ');
  }
  const jailed = p.jailUntil > 0;
  let moving = false;
  if (p.car) {
    const car = cars[p.car - 1];
    p.x = car.x; p.y = car.y; p.ang = car.ang;
  } else {
    let mx = p.in.mx, my = p.in.my;
    const l = Math.hypot(mx, my);
    moving = l > 0.05;
    if (l > 1) { mx /= l; my /= l; }
    const spd = 175 * (p.fast ? 2.4 : 1);
    const nx = p.x + (mx * spd + p.kx) * dt;
    const ny = p.y + (my * spd + p.ky) * dt;
    const k = Math.exp(-7 * dt);
    p.kx *= k; p.ky *= k;
    if (jailed && jailBlock) {   // ในคุก: เดินได้เฉพาะในห้องขัง
      p.x = clamp(nx, jailBlock.x + 22, jailBlock.x + jailBlock.w - 22);
      p.y = clamp(ny, jailBlock.y + 22, jailBlock.y + jailBlock.h - 22);
    } else {
      const r = collide(nx, ny, 14);
      p.x = r.x; p.y = r.y;
    }
  }
  p.work = false;
  // รายได้ประจำ
  const cr = CAREERS[p.career];
  if (cr.salary > 0 && !jailed) {
    p.payAcc += dt;
    if (p.payAcc >= 10) { p.payAcc -= 10; earn(p, cr.salary); }
  }
  // นักเรียน: อยู่ในโรงเรียนได้ค่าทุนเพิ่ม
  if (p.career === 'student' && !p.car && !jailed && nearBlock(p, byKind.school || [], 80)) {
    p.work = true; p.studyAcc += dt;
    if (p.studyAcc >= 10) { p.studyAcc -= 10; earn(p, 6); progOf(p).n++; }
  }
  // จุดยืนฟาม (เซฟโซน): ยืนนิ่งๆ ได้เงินเรื่อยๆ
  if (!p.car && !jailed && !moving && inSafe(p)) {
    p.work = true; p.farmAcc += dt;
    if (p.farmAcc >= 6) { p.farmAcc -= 6; earn(p, 5); }
  }
  // ตกปลา: ขยับตัว/ขึ้นรถ = เก็บเบ็ด
  if (p.fishing) {
    if (moving || p.car || jailed) { p.fishing = 0; toast(p, '🎣 เก็บเบ็ดแล้ว'); }
    else { p.work = true; if (now >= p.fishing) catchFish(p, now); }
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
      q.hp += heal; earn(p, heal * 0.25); p.work = true;
    }
  }
}

function buildMe(p, now) {
  const g = progOf(p), lv = lvlOf(g);
  return JSON.stringify({
    t: 'me', hp: Math.ceil(p.hp), mhp: p.maxhp, money: Math.floor(p.money), bank: Math.floor(p.bank),
    hunger: Math.ceil(p.hunger), ammo: p.ammo, gun: true, wp: p.weapon, own: [...p.weapons], carm: p.carModel, career: p.career,
    wanted: p.wantedUntil > now, stars: p.wantedUntil > now ? p.stars : 0, dead: p.dead,
    adm: p.admin, fast: p.fast, god: p.god, inf: p.inf,
    unl: [...p.unl], look: p.look, inv: p.inv, cr: !!p.creator,
    lvl: lv, xp: Math.floor(g.xp), xp0: 25 * (lv - 1) * (lv - 1), xpn: 25 * lv * lv, earned: Math.floor(g.earned), jobs: g.n,
    jail: p.jailUntil > now ? Math.ceil((p.jailUntil - now) / 1000) : 0, safe: inSafe(p), fishing: !!p.fishing,
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
    const fl = (now - p.punchT < 220 ? 1 : 0) | (p.wantedUntil > now ? 2 : 0) | (now - p.hurtT < 200 ? 4 : 0) | (now < p.protectUntil ? 8 : 0) | (p.fishing ? 16 : 0) | (p.work ? 32 : 0) | (p.jailUntil > 0 ? 64 : 0);
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
  console.log(`${CITY_NAME} พร้อมแล้ว → http://localhost:${PORT}  (จำกัด ${MAX_PLAYERS} คน)`);
  console.log(`รหัสแอดมิน: ${CRED.admin.env ? 'จาก ADMIN_PASSWORD' : 'ค่าเริ่มต้น nampan'} · รหัสระบบผู้สร้าง: ${CRED.creator.env ? 'จาก CREATOR_PASSWORD' : 'ค่าเริ่มต้น nampan'}`);
});
// กัน Render ฟรีหลับ: ยิงหาตัวเองทุก 8 นาที (เซิร์ฟเวอร์เปิดตลอด ยกเว้นผู้สร้างสั่งรีเซ็ต)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + '/status').catch(() => {}); }, 8 * 60 * 1000);
}
function shutdown() { for (const p of players.values()) saveOne(p); flushSaves(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
