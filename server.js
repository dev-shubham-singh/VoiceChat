'use strict';
// BoloYaar - lightweight stranger voice + text chat. Zero dependencies.
// Run: node server.js   (then open http://localhost:3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const TERMS_VERSION = '2026-11-13';
const GRACE_MS = Number(process.env.GRACE_MS || 30000); // keep a dropped user's seat this long
const NUDGE_MS = Number(process.env.NUDGE_MS || 30000);  // suggest "anyone" after waiting this long with a filter
const MAX_MSG = 64 * 1024;
const REPORTS_TO_BAN = 3;
const BAN_MS = 24 * 3600 * 1000;
const PREMIUM_CODES = new Set((process.env.PREMIUM_CODES || 'DEMO-PREMIUM')
  .split(',').map(s => s.trim()).filter(Boolean));
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) {
  ICE.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
}

// ---------- static files (cached + gzipped in memory) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const files = {};
for (const f of fs.readdirSync(PUB)) {
  const raw = fs.readFileSync(path.join(PUB, f));
  files['/' + f] = { raw, gz: zlib.gzipSync(raw, { level: 9 }), type: TYPES[path.extname(f)] || 'application/octet-stream' };
}
files['/'] = files['/index.html'];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  const f = files[url];
  if (!f || req.method !== 'GET') { res.writeHead(404); return res.end('Not found'); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const head = {
    'Content-Type': f.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'microphone=(self), camera=()'
  };
  if (gz) head['Content-Encoding'] = 'gzip';
  res.writeHead(200, head);
  res.end(gz ? f.gz : f.raw);
});

// ---------- minimal WebSocket server ----------
const conns = new Set();
function frame(op, payload) {
  const len = payload.length; let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.url !== '/ws') return socket.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const fwd = process.env.TRUST_PROXY ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const c = { socket, user: null, alive: true, buf: Buffer.alloc(0), frag: [], fragLen: 0, n: 0, sec: 0, ip: fwd || socket.remoteAddress || '?' };
  conns.add(c);
  socket.on('data', d => onData(c, d));
  socket.on('close', () => { conns.delete(c); onClose(c); });
  socket.on('error', () => {});
});
function onData(c, d) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : d;
  for (;;) {
    if (c.buf.length < 2) return;
    const b0 = c.buf[0], b1 = c.buf[1];
    const fin = b0 & 0x80, op = b0 & 0x0f;
    let len = b1 & 0x7f, off = 2;
    if (!(b1 & 0x80)) return c.socket.destroy(); // clients must mask
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (c.buf.length < 10) return;
      const big = c.buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MSG)) return c.socket.destroy();
      len = Number(big); off = 10;
    }
    if (len > MAX_MSG) return c.socket.destroy();
    if (c.buf.length < off + 4 + len) return;
    const mask = c.buf.subarray(off, off + 4);
    const p = Buffer.from(c.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
    c.buf = c.buf.subarray(off + 4 + len);
    if (op === 8) { c.socket.end(frame(8, Buffer.alloc(0))); return; }
    if (op === 9) { c.socket.write(frame(10, p)); continue; }
    if (op === 10) { c.alive = true; continue; }
    if (op === 1 || op === 0) {
      c.frag.push(p); c.fragLen += len;
      if (c.fragLen > MAX_MSG) return c.socket.destroy();
      if (fin) {
        const text = Buffer.concat(c.frag).toString('utf8'); c.frag = []; c.fragLen = 0;
        const now = Math.floor(Date.now() / 1000);
        if (now !== c.sec) { c.sec = now; c.n = 0; }
        if (++c.n > 40) return c.socket.destroy(); // flood protection
        let m; try { m = JSON.parse(text); } catch (e) { continue; }
        if (m && typeof m.t === 'string') { try { onMessage(c, m); } catch (e) { console.error(e); } }
      }
    }
  }
}
function rawSend(c, obj) {
  if (c && !c.socket.destroyed) c.socket.write(frame(1, Buffer.from(JSON.stringify(obj))));
}
setInterval(() => { // heartbeat: drop dead sockets, keep proxies from idling out live ones
  for (const c of conns) {
    if (!c.alive) { c.socket.destroy(); continue; }
    c.alive = false; c.socket.write(frame(9, Buffer.alloc(0)));
  }
}, 25000).unref();

// ---------- accounts (small JSON file; fine for an MVP, move to a database when you grow) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'users.json');
let db = { accounts: {}, tokens: {} }; // accounts: key(lowercase username) -> {name, salt, hash, gender, friends[], created}
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); }), 150);
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function newToken(key) {
  const mine = Object.keys(db.tokens).filter(t => db.tokens[t].k === key).sort((a, b) => db.tokens[a].ts - db.tokens[b].ts);
  while (mine.length >= 5) delete db.tokens[mine.shift()]; // at most 5 signed-in devices
  const tok = crypto.randomBytes(24).toString('hex');
  db.tokens[tok] = { k: key, ts: Date.now() }; save();
  return tok;
}
const authTries = new Map(); // ip -> count this minute
setInterval(() => authTries.clear(), 60000).unref();
const AUTH_LIMIT = Number(process.env.AUTH_LIMIT || 12); // sign-up/log-in attempts per IP per minute (0 = no limit)
function tooMany(ip) { if (!AUTH_LIMIT) return false; const n = (authTries.get(ip) || 0) + 1; authTries.set(ip, n); return n > AUTH_LIMIT; }

// ---------- app state ----------
const users = new Map();      // sid -> live session
const byAcct = new Map();     // account key -> sid
const waiting = [];           // sids, oldest first
const bans = new Map();       // ip -> until (ms)
const reportsByIp = new Map(); // reported ip -> Set(reporter ip)
const GENDERS = ['male', 'female', 'other'];
const PREFS = ['any', 'male', 'female'];

const send = (u, obj) => { if (u && u.conn) rawSend(u.conn, obj); };
let onC = { n: 0, t: 0 };
const online = () => { // counted at most once a second so it stays cheap with thousands online
  const now = Date.now();
  if (now - onC.t > 1000) { let n = 0; for (const u of users.values()) if (u.conn) n++; onC = { n, t: now }; }
  return onC.n;
};
const CC = /^[A-Z]{2}$/;
const log = (file, obj) => fs.appendFile(path.join(DATA_DIR, file), JSON.stringify(obj) + '\n', () => {});
const unqueue = u => { const i = waiting.indexOf(u.sid); if (i >= 0) waiting.splice(i, 1); };
const ok = (pref, gender) => pref === 'any' || pref === gender;
const compatible = (a, b) => ok(a.pref, b.gender) && ok(b.pref, a.gender) && ok(a.cpref, b.country) && ok(b.cpref, a.country);
const areFriends = (a, b) => !!(a.acct && b.acct && db.accounts[a.acct] && db.accounts[a.acct].friends.includes(b.acct));
const pub = (u, viewer) => ({ name: u.name, gender: u.gender, country: u.country, acct: !!u.acct, friend: areFriends(viewer, u) });
const sess = key => users.get(byAcct.get(key));
function friendList(u) {
  if (!u.acct || !db.accounts[u.acct]) return [];
  return db.accounts[u.acct].friends.filter(k => db.accounts[k]).map(k => {
    const s = sess(k);
    return { name: db.accounts[k].name, online: !!(s && s.conn), busy: !!(s && s.state === 'incall') };
  });
}
const pushFriends = u => send(u, { t: 'friends', list: friendList(u) });

function pair(a, b) { // a becomes the WebRTC initiator
  for (const x of [a, b]) { if (x.partner) endCall(x); unqueue(x); x.freq = null; x.inviting = null; }
  a.partner = b.sid; b.partner = a.sid; a.state = b.state = 'incall';
  send(a, { t: 'matched', initiator: true, peer: pub(b, a) });
  send(b, { t: 'matched', initiator: false, peer: pub(a, b) });
}
function tryMatch(u) {
  const now = Date.now();
  // Pass 0 serves waiting users who have a (premium) filter first, because their pool is smaller. Pass 1 is oldest-first.
  for (let pass = 0; pass < 2; pass++) for (const sid of waiting) {
    const v = users.get(sid);
    if (!v || v === u || !v.conn || !compatible(u, v)) continue;
    if (pass === 0 && v.pref === 'any' && v.cpref === 'any') continue;
    if (u.last === v.sid && now - u.lastAt < 8000) continue; // avoid instant re-match with the same person
    pair(v, u);
    return true;
  }
  if (!waiting.includes(u.sid)) { waiting.push(u.sid); u.waitSince = now; u.nudged = false; }
  return false;
}
function endCall(u) {
  const p = users.get(u.partner);
  u.partner = null; u.state = 'idle'; u.freq = null;
  if (!p) return;
  u.last = p.sid; u.lastAt = Date.now(); u.lastIp = p.ip;
  p.last = u.sid; p.lastAt = Date.now(); p.lastIp = u.ip;
  p.partner = null; p.state = 'idle'; p.freq = null;
  send(p, { t: 'peer_left' });
}
function drop(u) {
  clearTimeout(u.awayTimer); unqueue(u);
  if (u.partner) endCall(u);
  users.delete(u.sid);
  if (u.acct && byAcct.get(u.acct) === u.sid) byAcct.delete(u.acct);
}
function startFind(u, pref, cpref) {
  if (!PREFS.includes(pref)) pref = 'any';
  u.cpref = CC.test(cpref) ? cpref : 'any';
  if (pref !== 'any' && !u.premium) return send(u, { t: 'need_premium' });
  if (u.partner) endCall(u);
  unqueue(u);
  u.pref = pref; u.state = 'waiting';
  if (!tryMatch(u)) send(u, { t: 'waiting', online: online() });
}
setInterval(() => { // retry matches; nudge filtered users who have waited a long time
  const now = Date.now();
  for (const sid of waiting.slice()) {
    const u = users.get(sid);
    if (!u || u.state !== 'waiting' || !u.conn) continue;
    if (tryMatch(u)) continue;
    if ((u.pref !== 'any' || u.cpref !== 'any') && !u.nudged && now - u.waitSince > NUDGE_MS) { u.nudged = true; send(u, { t: 'nomatch' }); }
  }
}, 2000).unref();
setInterval(() => {
  const n = online();
  for (const c of conns) rawSend(c, c.user && c.user.acct ? { t: 'online', n, friends: friendList(c.user) } : { t: 'online', n });
}, 8000).unref();

function open(c, name, gender, country, acct, extra) { // start a live session on this socket
  if (acct) { const old = sess(acct); if (old) { send(old, { t: 'kicked' }); if (old.conn) old.conn.user = null; drop(old); } }
  const sid = crypto.randomBytes(16).toString('hex');
  const u = { sid, name, gender, country: country || '', acct: acct || null, premium: false, pref: 'any', cpref: 'any', conn: c, partner: null, state: 'idle', ip: c.ip, last: null, lastAt: 0, lastIp: null, freq: null, inviting: null, inviteAt: 0 };
  users.set(sid, u); c.user = u;
  if (acct) byAcct.set(acct, sid);
  rawSend(c, Object.assign({ t: 'joined', sid, name, gender, country: u.country, acct: !!acct, premium: false, ice: ICE, online: online(), friends: friendList(u) }, extra));
}
const consent = (c, id) => log('consent.log', { ts: new Date().toISOString(), id, ip: c.ip, terms: TERMS_VERSION, adult: true });
const NEED_TERMS = 'Confirm you are 18 or older and accept the Terms to continue.';

function onMessage(c, m) {
  const u = c.user;
  if (!u) {
    const err = msg => rawSend(c, { t: 'error', msg });
    if (m.t === 'ping') return;
    if (m.t === 'resume') {
      const ru = users.get(String(m.sid || ''));
      if (!ru) return rawSend(c, { t: 'expired' });
      if (ru.conn && ru.conn !== c) { ru.conn.user = null; ru.conn.socket.destroy(); }
      clearTimeout(ru.awayTimer); ru.conn = c; c.user = ru;
      const p = users.get(ru.partner);
      send(ru, { t: 'resumed', state: ru.state, premium: ru.premium, peer: p ? pub(p, ru) : null, online: online(), friends: friendList(ru) });
      if (p) send(p, { t: 'peer_back' });
      return;
    }
    if (!['guest', 'signup', 'login', 'auth'].includes(m.t)) return rawSend(c, { t: 'expired' });
    if ((bans.get(c.ip) || 0) > Date.now()) return rawSend(c, { t: 'banned' });
    if (m.t === 'auth') {
      const tk = db.tokens[String(m.token || '')];
      const acc = tk && db.accounts[tk.k];
      if (!acc) return rawSend(c, { t: 'auth_fail' });
      return open(c, acc.name, acc.gender, acc.country, tk.k);
    }
    if (tooMany(c.ip)) return err('Too many attempts. Wait a minute and try again.');
    if (m.t === 'guest') {
      if (m.agree !== true || m.adult !== true) return err(NEED_TERMS);
      if (!GENDERS.includes(m.gender)) return err('Select your gender.');
      const name = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Stranger';
      if (!CC.test(m.country)) return err('Select your country.');
      consent(c, 'guest');
      return open(c, name, m.gender, m.country, null);
    }
    const name = String(m.username || '').trim(), key = name.toLowerCase(), pw = String(m.password || '');
    if (m.t === 'signup') {
      if (m.agree !== true || m.adult !== true) return err(NEED_TERMS);
      if (!/^[a-zA-Z0-9_]{3,16}$/.test(name)) return err('Username must be 3 to 16 letters, numbers or underscores.');
      if (pw.length < 6 || pw.length > 72) return err('Password must be at least 6 characters.');
      if (!GENDERS.includes(m.gender)) return err('Select your gender.');
      if (!CC.test(m.country)) return err('Select your country.');
      if (db.accounts[key]) return err('That username is taken. Try another.');
      const salt = crypto.randomBytes(16).toString('hex');
      db.accounts[key] = { name, salt, hash: hashPw(pw, salt), gender: m.gender, country: m.country, friends: [], created: Date.now() };
      consent(c, key);
      return open(c, name, m.gender, m.country, key, { token: newToken(key) });
    }
    // login
    const acc = db.accounts[key];
    const good = acc && crypto.timingSafeEqual(Buffer.from(hashPw(pw, acc.salt), 'hex'), Buffer.from(acc.hash, 'hex'));
    if (!good) return err('Wrong username or password.');
    return open(c, acc.name, acc.gender, acc.country, key, { token: newToken(key) });
  }
  const me = u.acct && db.accounts[u.acct];
  switch (m.t) {
    case 'logout':
      if (m.token && db.tokens[m.token] && db.tokens[m.token].k === u.acct) { delete db.tokens[m.token]; save(); }
      c.user = null; drop(u); return rawSend(c, { t: 'bye' });
    case 'premium': // demo unlock. Replace with a real payment check (e.g. Razorpay webhook) before launch.
      u.premium = PREMIUM_CODES.has(String(m.code || '').trim());
      return send(u, { t: 'premium', ok: u.premium });
    case 'find': return startFind(u, m.pref, m.country);
    case 'next': return startFind(u, u.pref, u.cpref);
    case 'stop': unqueue(u); if (u.partner) endCall(u); u.state = 'idle'; return;
    case 'signal': if (u.partner && m.d) send(users.get(u.partner), { t: 'signal', d: m.d }); return;
    case 'typing': if (u.partner) send(users.get(u.partner), { t: 'typing' }); return;
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 500);
      if (text && u.partner) send(users.get(u.partner), { t: 'chat', text });
      return;
    }
    // ----- friends -----
    case 'friend_req': {
      const p = users.get(u.partner); if (!p) return;
      if (!me) return send(u, { t: 'friend_res', ok: false, why: 'you_guest' });
      if (!p.acct) return send(u, { t: 'friend_res', ok: false, why: 'guest', name: p.name });
      if (areFriends(u, p)) return send(u, { t: 'friend_res', ok: true, name: p.name });
      if (me.friends.length >= 200) return send(u, { t: 'friend_res', ok: false, why: 'full' });
      if (p.freq === u.sid) return befriend(u, p); // they already asked you
      u.freq = p.sid;
      return send(p, { t: 'friend_req', from: u.name });
    }
    case 'friend_ans': {
      const p = users.get(u.partner);
      if (!p || p.freq !== u.sid || !me || !p.acct) return;
      p.freq = null;
      if (m.ok === true) return befriend(u, p);
      return send(p, { t: 'friend_res', ok: false, why: 'declined', name: u.name });
    }
    case 'unfriend': {
      const k = String(m.name || '').toLowerCase(); if (!me) return;
      me.friends = me.friends.filter(x => x !== k);
      if (db.accounts[k]) db.accounts[k].friends = db.accounts[k].friends.filter(x => x !== u.acct);
      save(); pushFriends(u); pushFriends(sess(k));
      return;
    }
    case 'invite': { // call a friend directly
      const k = String(m.name || '').toLowerCase();
      if (!me || !me.friends.includes(k)) return;
      const f = sess(k);
      if (!f || !f.conn) return send(u, { t: 'invite_res', ok: false, why: 'offline', name: m.name });
      if (f.state === 'incall') return send(u, { t: 'invite_res', ok: false, why: 'busy', name: f.name });
      u.inviting = k; u.inviteAt = Date.now();
      return send(f, { t: 'invite', from: u.name });
    }
    case 'invite_ans': {
      const inv = sess(String(m.from || '').toLowerCase());
      if (!inv || !inv.conn || inv.inviting !== u.acct || Date.now() - inv.inviteAt > 60000) return send(u, { t: 'invite_res', ok: false, why: 'gone' });
      inv.inviting = null;
      if (m.ok !== true) return send(inv, { t: 'invite_res', ok: false, why: 'declined', name: u.name });
      return pair(inv, u);
    }
    case 'report': {
      const target = users.get(u.partner);
      const tip = target ? target.ip : (Date.now() - u.lastAt < 120000 ? u.lastIp : null);
      if (!tip) return;
      log('reports.log', { ts: new Date().toISOString(), reporter: u.acct || 'guest', reporterIp: u.ip, target: target ? (target.acct || 'guest') : '?', targetIp: tip, reason: String(m.reason || '').slice(0, 40) });
      let set = reportsByIp.get(tip); if (!set) reportsByIp.set(tip, set = new Set());
      set.add(u.ip);
      if (u.partner) endCall(u);
      if (set.size >= REPORTS_TO_BAN) {
        bans.set(tip, Date.now() + BAN_MS); reportsByIp.delete(tip);
        for (const x of [...users.values()]) if (x.ip === tip) { send(x, { t: 'banned' }); if (x.conn) x.conn.user = null; drop(x); }
      }
      return send(u, { t: 'reported' });
    }
    case 'ping': return send(u, { t: 'pong' });
  }
}
function befriend(a, b) {
  const A = db.accounts[a.acct], B = db.accounts[b.acct];
  if (!A || !B) return;
  if (!A.friends.includes(b.acct)) A.friends.push(b.acct);
  if (!B.friends.includes(a.acct)) B.friends.push(a.acct);
  a.freq = b.freq = null; save();
  send(a, { t: 'friend_res', ok: true, name: b.name }); send(b, { t: 'friend_res', ok: true, name: a.name });
  pushFriends(a); pushFriends(b);
}
function onClose(c) {
  const u = c.user;
  if (!u || u.conn !== c) return;
  u.conn = null; unqueue(u);
  if (u.state === 'waiting') u.state = 'idle';
  if (u.partner) send(users.get(u.partner), { t: 'peer_away' });
  // Do not cut the call straight away: the user gets GRACE_MS to come back (weak network, app switch).
  u.awayTimer = setTimeout(() => drop(u), GRACE_MS);
}

server.listen(PORT, () => console.log('BoloYaar running on http://localhost:' + PORT));
