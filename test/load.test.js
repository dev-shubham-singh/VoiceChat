'use strict';
// Load test: N simulated users join, get matched, exchange call set-up messages, chat, and press Next.
// node test/load.test.js [users=5000] [seconds=40]
// It tests the matching/signalling server. Voice audio is peer to peer and never touches this server.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const N = Number(process.argv[2] || 5000), SECS = Number(process.argv[3] || 40), PORT = 3933;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
  { env: { ...process.env, PORT, AUTH_LIMIT: 0, DATA_DIR: fs.mkdtempSync('/tmp/by-load-') }, stdio: ['ignore', 'ignore', 'inherit'] });
const URL = 'ws://localhost:' + PORT + '/ws';
const SDP = 'v=0 ' + 'a=candidate-and-codec-lines '.repeat(90); // about 2.5 KB, like a real audio offer
const CAND = { candidate: 'candidate:842163049 1 udp 1677729535 203.0.113.7 46154 typ srflx raddr 10.0.0.2 rport 46154 generation 0', sdpMid: '0', sdpMLineIndex: 0 };
const GENDERS = ['male', 'male', 'female', 'other'], COUNTRIES = ['IN', 'IN', 'IN', 'IN', 'US', 'GB', 'BD', 'PK', 'NP', 'AE'];
const rnd = (a, b) => a + Math.random() * (b - a);
const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const st = { open: 0, joined: 0, failed: 0, closed: 0, matches: 0, recv: 0, sent: 0, inCall: 0, matchMs: [], pingMs: [] };
let measuring = false, stopping = false;

function user(i) {
  const ws = new WebSocket(URL); let findAt = 0, inCall = false, timers = [];
  const send = o => { if (ws.readyState === 1) { ws.send(JSON.stringify(o)); st.sent++; } };
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const find = () => { if (stopping) return; findAt = Date.now(); send({ t: 'find', pref: 'any' }); };
  const leave = () => { timers.forEach(clearTimeout); timers = []; if (inCall) { inCall = false; st.inCall--; } };
  ws.onopen = () => { st.open++; send({ t: 'guest', name: 'user' + i, gender: GENDERS[i % 4], country: COUNTRIES[i % 10], agree: true, adult: true }); };
  ws.onerror = () => { st.failed++; };
  ws.onclose = () => { st.closed++; leave(); };
  ws.onmessage = e => {
    st.recv++; const m = JSON.parse(e.data);
    if (m.t === 'joined') { st.joined++; later(find, rnd(0, 3000)); }
    else if (m.t === 'matched') {
      if (measuring) st.matchMs.push(Date.now() - findAt);
      st.matches++; leave(); inCall = true; st.inCall++;
      if (m.initiator) send({ t: 'signal', d: { sdp: { type: 'offer', sdp: SDP } } });
      for (let k = 1; k <= 4; k++) later(() => { send({ t: 'typing' }); send({ t: 'chat', text: 'message ' + k + ' from user ' + i }); }, rnd(2000, 30000));
      later(() => { leave(); if (stopping) return; findAt = Date.now(); send({ t: 'next' }); }, rnd(12000, 45000)); // press Next after 12 to 45 s
    }
    else if (m.t === 'signal' && m.d.sdp) {
      if (m.d.sdp.type === 'offer') send({ t: 'signal', d: { sdp: { type: 'answer', sdp: SDP } } });
      for (let k = 0; k < 5; k++) send({ t: 'signal', d: { c: CAND } });
    }
    else if (m.t === 'peer_left') { leave(); later(find, 1500); }
  };
  return ws;
}

function cpuTicks() { const f = fs.readFileSync('/proc/' + srv.pid + '/stat', 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); }
function rssMb() { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + srv.pid + '/status', 'utf8'))[1]) / 1024; }

(async () => {
  await sleep(700);
  console.log('Connecting ' + N + ' users…');
  const t0 = Date.now(), all = [];
  for (let i = 0; i < N; i++) { all.push(user(i)); if (i % 200 === 199) await sleep(120); }
  for (let w = 0; w < 100 && st.joined + st.failed < N; w++) await sleep(200);
  console.log('  ' + st.joined + ' of ' + N + ' joined in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s (' + st.failed + ' failed)');

  // probe: a normal user measuring how long the server takes to answer
  const probe = new WebSocket(URL); let pAt = 0;
  probe.onopen = () => probe.send(JSON.stringify({ t: 'guest', name: 'probe', gender: 'other', country: 'IN', agree: true, adult: true }));
  probe.onmessage = e => { if (JSON.parse(e.data).t === 'pong' && measuring) st.pingMs.push(performance.now() - pAt); };
  const pt = setInterval(() => { pAt = performance.now(); probe.send(JSON.stringify({ t: 'ping' })); }, 250);

  await sleep(6000); // let everyone get into calls
  measuring = true;
  const c0 = cpuTicks(), r0 = { recv: st.recv, sent: st.sent, matches: st.matches }, m0 = Date.now();
  let peakRss = 0, peakCall = 0, pageMs = [];
  for (let s = 0; s < SECS; s += 5) {
    await sleep(5000);
    peakRss = Math.max(peakRss, rssMb()); peakCall = Math.max(peakCall, st.inCall);
    const a = performance.now(); await (await fetch('http://localhost:' + PORT + '/')).text(); pageMs.push(performance.now() - a);
    console.log('  t=' + (s + 5) + 's  in a call: ' + st.inCall + '  server memory: ' + rssMb().toFixed(0) + ' MB');
  }
  const secs = (Date.now() - m0) / 1000, cpu = (cpuTicks() - c0) / 100 / secs * 100;
  measuring = false; stopping = true; clearInterval(pt);
  console.log('\nResults with ' + N + ' users online for ' + secs.toFixed(0) + ' s');
  console.log('  users connected at the end:   ' + (st.open - st.closed) + ' of ' + N + ' (dropped: ' + st.closed + ')');
  console.log('  users in a call (peak):       ' + peakCall);
  console.log('  new matches per second:       ' + ((st.matches - r0.matches) / 2 / secs).toFixed(0) + ' pairs');
  console.log('  messages handled per second:  ' + ((st.sent - r0.sent) / secs).toFixed(0) + ' in, ' + ((st.recv - r0.recv) / secs).toFixed(0) + ' out');
  console.log('  time to get matched:          median ' + pct(st.matchMs, .5).toFixed(0) + ' ms, 95% under ' + pct(st.matchMs, .95).toFixed(0) + ' ms, worst ' + Math.max(0, ...st.matchMs).toFixed(0) + ' ms');
  console.log('  server response time:         median ' + pct(st.pingMs, .5).toFixed(1) + ' ms, 99% under ' + pct(st.pingMs, .99).toFixed(1) + ' ms, worst ' + Math.max(0, ...st.pingMs).toFixed(1) + ' ms');
  console.log('  page load from server:        ' + pct(pageMs, .5).toFixed(1) + ' ms median');
  console.log('  server CPU (one core):        ' + cpu.toFixed(0) + '%');
  console.log('  server memory (peak):         ' + peakRss.toFixed(0) + ' MB');
  srv.kill(); process.exit(0);
})().catch(e => { console.error('FAILED:', e); srv.kill(); process.exit(1); });
