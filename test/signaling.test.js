'use strict';
// Server test: node test/signaling.test.js  (needs Node 22+ for the built-in WebSocket client)
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const PORT = 3931;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
  { env: { ...process.env, PORT, GRACE_MS: 1500, NUDGE_MS: 1000, AUTH_LIMIT: 0, DATA_DIR: require('fs').mkdtempSync('/tmp/by-data-') }, stdio: 'inherit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client() {
  const ws = new WebSocket('ws://localhost:' + PORT + '/ws');
  const got = [], waiters = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data); got.push(m);
    for (const w of waiters.slice()) if (w.t === m.t) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  return {
    ws, got,
    open: () => new Promise(r => ws.onopen = r),
    send: o => ws.send(JSON.stringify(o)),
    wait: (t, ms = 4000) => {
      const i = got.findIndex(m => m.t === t);
      if (i >= 0) return Promise.resolve(got.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { t, res: m => { got.splice(got.indexOf(m), 1); res(m); } }; waiters.push(w);
        setTimeout(() => rej(new Error('timeout waiting for ' + t)), ms);
      });
    },
    none: async (t, ms = 600) => { await sleep(ms); assert(!got.some(m => m.t === t), 'unexpected ' + t); }
  };
}
async function join(name, gender, country = 'IN') {
  const c = client(); await c.open();
  c.send({ t: 'guest', name, gender, country, agree: true, adult: true });
  c.me = await c.wait('joined'); return c;
}

(async () => {
  await sleep(500);
  let n = 0; const pass = s => console.log('  ok ' + (++n) + ' - ' + s);

  // consent enforced on the server
  const x = client(); await x.open();
  x.send({ t: 'guest', name: 'x', gender: 'male', agree: false, adult: true });
  assert((await x.wait('error')).msg.includes('18 or older')); pass('ID refused without the terms checkbox');
  x.send({ t: 'find', pref: 'any' }); await x.wait('expired'); pass('cannot search without an ID');
  x.ws.close();

  // basic match, signalling relay, chat relay
  const a = await join('Asha', 'female'), b = await join('Ravi', 'male');
  a.send({ t: 'find', pref: 'any' }); await a.wait('waiting');
  b.send({ t: 'find', pref: 'any' });
  const ma = await a.wait('matched'), mb = await b.wait('matched');
  assert(ma.initiator !== mb.initiator); assert.equal(ma.peer.name, 'Ravi'); assert.equal(mb.peer.gender, 'female');
  pass('two users are matched, exactly one is the initiator');
  a.send({ t: 'signal', d: { sdp: { type: 'offer', sdp: 'x'.repeat(5000) } } });
  assert.equal((await b.wait('signal')).d.sdp.sdp.length, 5000); pass('large signalling message relayed');
  b.send({ t: 'chat', text: '  hello <b>there</b>  ' });
  assert.equal((await a.wait('chat')).text, 'hello <b>there</b>'); pass('text chat relayed');

  // connection drop does not cut the call if the user comes back in time
  a.ws.close(); await b.wait('peer_away'); await b.none('peer_left', 500);
  const a2 = client(); await a2.open(); a2.send({ t: 'resume', sid: a.me.sid });
  const r = await a2.wait('resumed'); assert.equal(r.state, 'incall'); await b.wait('peer_back');
  a2.send({ t: 'chat', text: 'back' }); assert.equal((await b.wait('chat')).text, 'back');
  pass('socket drop + resume keeps the call alive');

  // ...but the call ends when the grace period runs out
  a2.ws.close(); await b.wait('peer_away'); await b.wait('peer_left', 4000); pass('call ends after grace period expires');
  b.send({ t: 'stop' });

  // gender filter is premium only, and enforced on the server
  const m1 = await join('M1', 'male'), f1 = await join('F1', 'female'), p = await join('P', 'male');
  p.send({ t: 'find', pref: 'female' }); await p.wait('need_premium'); pass('filter refused without premium');
  p.send({ t: 'premium', code: 'wrong' }); assert.equal((await p.wait('premium')).ok, false);
  p.send({ t: 'premium', code: 'DEMO-PREMIUM' }); assert.equal((await p.wait('premium')).ok, true); pass('premium code check');
  m1.send({ t: 'find', pref: 'any' }); await m1.wait('waiting');
  p.send({ t: 'find', pref: 'female' }); await p.wait('waiting');
  await p.none('matched', 2500); await m1.none('matched', 10); pass('premium "female" filter skips a waiting male');
  await p.wait('nomatch'); pass('"match with anyone" nudge after a long wait');
  f1.send({ t: 'find', pref: 'any' });
  const mf = await f1.wait('matched'); const mp = await p.wait('matched');
  assert.equal(mp.peer.name, 'F1'); assert(['M1', 'P'].includes(mf.peer.name)); assert.equal(mf.peer.name, 'P');
  pass('filter user matched with the female, not the male who waited longer');

  // next: partner is told, both go back to searching
  p.send({ t: 'next' }); await f1.wait('peer_left'); await p.wait('waiting');
  f1.send({ t: 'find', pref: 'any' });
  assert.equal((await f1.wait('matched')).peer.name, 'M1'); await m1.wait('matched'); pass('Next ends the call and re-queues');

  // report ends the call
  f1.send({ t: 'report', reason: 'abuse' }); await f1.wait('reported'); await m1.wait('peer_left'); pass('report ends the call');

  // accounts, typing, friends, direct friend calls
  f1.send({ t: 'stop' }); m1.send({ t: 'stop' }); p.send({ t: 'stop' });
  const acct = async (t, username, password, extra = {}) => { const c = client(); await c.open(); c.send({ t, username, password, ...extra }); return c; };
  const bad = await acct('signup', 'Meera', 'secret1', { gender: 'female', country: 'IN', agree: false, adult: true });
  await bad.wait('error'); pass('signup refused without the terms checkbox');
  bad.send({ t: 'signup', username: 'Meera', password: 'secret1', gender: 'female', country: 'IN', agree: true, adult: true });
  const jm = await bad.wait('joined'); assert(jm.token && jm.acct); const meera = bad; pass('signup creates an account and a login token');
  const dup = await acct('signup', 'meera', 'secret2', { gender: 'male', country: 'IN', agree: true, adult: true });
  assert((await dup.wait('error')).msg.includes('taken')); pass('duplicate username refused');
  dup.send({ t: 'login', username: 'Meera', password: 'nope' }); await dup.wait('error'); pass('wrong password refused');
  const kabir = await acct('signup', 'Kabir', 'secret3', { gender: 'male', country: 'IN', agree: true, adult: true }); await kabir.wait('joined');
  const g = await join('Guesty', 'other');

  meera.send({ t: 'find', pref: 'any' }); await meera.wait('waiting'); g.send({ t: 'find', pref: 'any' });
  await meera.wait('matched'); assert.equal((await g.wait('matched')).peer.acct, true);
  meera.send({ t: 'typing' }); await g.wait('typing'); pass('typing indicator relayed');
  meera.send({ t: 'friend_req' }); assert.equal((await meera.wait('friend_res')).why, 'guest');
  g.send({ t: 'friend_req' }); assert.equal((await g.wait('friend_res')).why, 'you_guest'); pass('guests cannot add or be added as friends');
  meera.send({ t: 'stop' }); await g.wait('peer_left'); g.send({ t: 'stop' });

  meera.send({ t: 'find', pref: 'any' }); await meera.wait('waiting'); kabir.send({ t: 'find', pref: 'any' });
  await meera.wait('matched'); await kabir.wait('matched');
  meera.send({ t: 'friend_req' }); assert.equal((await kabir.wait('friend_req')).from, 'Meera');
  kabir.send({ t: 'friend_ans', ok: true });
  assert.equal((await meera.wait('friend_res')).ok, true); assert.equal((await kabir.wait('friend_res')).name, 'Meera');
  assert.equal((await meera.wait('friends')).list[0].name, 'Kabir'); await kabir.wait('friends'); pass('friend request accepted, both lists updated');
  meera.send({ t: 'stop' }); await kabir.wait('peer_left');

  kabir.send({ t: 'invite', name: 'Meera' }); assert.equal((await meera.wait('invite')).from, 'Kabir');
  meera.send({ t: 'invite_ans', from: 'Kabir', ok: true });
  const k2 = await kabir.wait('matched'); await meera.wait('matched'); assert.equal(k2.peer.friend, true); pass('calling a friend directly connects the two');
  kabir.send({ t: 'stop' }); await meera.wait('peer_left');

  // token login on a new device signs the old one out; friends persist
  const again = client(); await again.open(); again.send({ t: 'auth', token: jm.token });
  const ja = await again.wait('joined'); assert.equal(ja.friends[0].name, 'Kabir'); await meera.wait('kicked'); pass('token login restores friends and signs out the old device');
  again.send({ t: 'unfriend', name: 'Kabir' }); assert.equal((await again.wait('friends')).list.length, 0); assert.equal((await kabir.wait('friends')).list.length, 0); pass('unfriend removes both sides');

  // country: required to join, shown to the partner, and usable as a match filter
  const nc = client(); await nc.open(); nc.send({ t: 'guest', name: 'n', gender: 'male', agree: true, adult: true });
  assert((await nc.wait('error')).msg.includes('country')); pass('country is required to join');
  const us = await join('Sam', 'male', 'US'), in1 = await join('Dev', 'male', 'IN'), seeker = await join('Zoe', 'female', 'GB');
  in1.send({ t: 'find', pref: 'any' }); await in1.wait('waiting');
  seeker.send({ t: 'find', pref: 'any', country: 'US' }); await seeker.wait('waiting');
  await seeker.none('matched', 2500); pass('country filter skips people from other countries');
  us.send({ t: 'find', pref: 'any' });
  const ms = await seeker.wait('matched'); assert.equal(ms.peer.name, 'Sam'); assert.equal(ms.peer.country, 'US'); await us.wait('matched');
  pass('country filter matches the right country and shows it');

  console.log('\nAll ' + n + ' checks passed');
  srv.kill(); process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); srv.kill(); process.exit(1); });
