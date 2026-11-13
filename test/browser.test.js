'use strict';
// Real-browser test: two headless Chrome tabs with fake microphones make an actual WebRTC call.
// node test/browser.test.js   (needs google-chrome on PATH and Node 22+)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const PORT = 3932, DBG = 9339;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: fs.mkdtempSync('/tmp/by-data-') }, stdio: 'inherit' });
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + DBG, '--user-data-dir=/tmp/by-chrome-' + Date.now(), 'about:blank'], { stdio: 'ignore' });
const done = code => { srv.kill(); chrome.kill(); process.exit(code); };

async function tab(w, h) {
  const info = await (await fetch('http://localhost:' + DBG + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const cmd = (method, params = {}) => new Promise(res => { pend.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
  await cmd('Page.navigate', { url: 'http://localhost:' + PORT + '/' });
  await sleep(800);
  const until = async (expr, what, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await ev(expr)) return; await sleep(200); }
    throw new Error('timeout: ' + what + ' | status=' + await ev("document.getElementById('status').textContent"));
  };
  const shot = async file => fs.writeFileSync(file, Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  return { ev, until, shot };
}

(async () => {
  await sleep(1500);
  let n = 0; const pass = s => console.log('  ok ' + (++n) + ' - ' + s);
  const out = process.argv[2] || '/tmp';
  const A = await tab(390, 780), B = await tab(1100, 760);

  const click = sel => `document.querySelector(${JSON.stringify(sel)}).click()`;
  const on = v => `document.getElementById('v-${v}').classList.contains('on')`;
  const toastBtn = label => `(function(){var b=[...document.querySelectorAll('.toast button')].find(x=>x.textContent===${JSON.stringify(label)});if(b){b.click();return true}return false})()`;
  await sleep(600); await A.shot(out + '/1-landing-mobile.png'); await B.shot(out + '/1-landing-desktop.png');
  await A.ev(click('[data-go=start]')); await A.until(on('start'), 'start page'); await sleep(350); await A.shot(out + '/2-start-mobile.png');
  await A.ev(click('[data-go=signup]')); await A.until(on('form'), 'form page');
  assert.equal(await A.ev("document.getElementById('fgo').disabled"), true); pass('Create account is disabled until the terms box is ticked');
  const signup = (name, g) => `document.getElementById('fname').value='${name}';document.getElementById('fpw').value='secret12';
    document.querySelector('input[name=g][value=${g}]').click();document.getElementById('fcountry').value='IN';document.getElementById('agree').click();`;
  await A.ev(signup('Asha', 'female')); await sleep(350); await A.shot(out + '/3-signup-mobile.png');
  await A.ev(click('#fgo')); await A.until(on('lobby'), 'A lobby');
  await B.ev(click('[data-go=start]')); await B.ev(click('[data-go=signup]')); await B.ev(signup('Ravi', 'male')); await B.ev(click('#fgo'));
  await B.until(on('lobby'), 'B lobby'); pass('both users signed up and reached the lobby');

  await A.ev(click('#start')); await sleep(900); await A.shot(out + '/4-searching-mobile.png');
  await B.ev(click('#start'));
  const connected = "document.getElementById('status').textContent==='Connected'";
  await A.until(connected, 'A connected'); await B.until(connected, 'B connected'); pass('WebRTC call connected in both tabs');
  const audio = "(function(){var s=document.getElementById('au').srcObject;return !!s&&s.getAudioTracks().length===1&&s.getAudioTracks()[0].readyState==='live'})()";
  assert(await A.ev(audio)); assert(await B.ev(audio)); pass('each side is receiving a live audio track');
  await B.until("parseFloat(document.getElementById('orb').style.getPropertyValue('--lvl'))>0.02", 'orb reacts to the voice level'); pass('orb and wave react to real audio');

  await A.ev("document.getElementById('msg').value='hi from Asha';document.getElementById('sendb').click()");
  await B.until("[...document.querySelectorAll('.m.them')].some(e=>e.textContent==='hi from Asha')", 'chat arrives');
  await B.ev("var i=document.getElementById('msg');i.value='<img src=x onerror=alert(1)>';i.dispatchEvent(new Event('input'))");
  await A.until("document.getElementById('typing').classList.contains('on')&&document.getElementById('typt').textContent==='Ravi is typing'", 'typing shows'); pass('"Ravi is typing" appears');
  await A.shot(out + '/5-call-typing-mobile.png');
  await B.ev(click('#sendb'));
  await A.until("[...document.querySelectorAll('.m.them')].some(e=>e.textContent.includes('<img'))", 'html shown as text');
  assert.equal(await A.ev("document.querySelectorAll('#log img').length"), 0);
  assert.equal(await A.ev("document.getElementById('typing').classList.contains('on')"), false); pass('chat works, HTML is not executed, typing hides on send');

  await A.ev(click('#addf')); await B.until("!!document.querySelector('.toast button')", 'friend request toast');
  await sleep(400); await B.shot(out + '/6-call-friend-request-desktop.png');
  await B.ev(toastBtn('Accept'));
  await A.until("document.getElementById('addf').textContent==='Friends ✓'", 'A sees friends'); await B.until("document.getElementById('addf').textContent==='Friends ✓'", 'B sees friends');
  pass('add friend: request, accept, both sides updated');

  await sleep(5000); assert(await A.ev(connected)); pass('call still up after idle time (no auto cut)');
  await A.ev(click('#end')); await A.until(on('lobby'), 'A lobby'); await B.ev(click('#end')); await B.until(on('lobby'), 'B lobby');
  await A.until("[...document.querySelectorAll('.fr.on .nm')].some(e=>e.textContent.startsWith('Ravi'))&&!!document.querySelector('.fr button.pri')", 'friend online in lobby', 20000);
  await sleep(4000); await A.shot(out + '/7-lobby-mobile.png'); await B.shot(out + '/7-lobby-desktop.png');
  await A.ev(click('.fr button.pri')); await B.until(toastBtn('Answer'), 'B answers the friend call');
  await A.until(connected, 'friend call A'); await B.until(connected, 'friend call B'); pass('calling a friend from the lobby connects');
  await B.ev(click('#next')); await A.until("document.getElementById('peer').textContent==='Finding someone…'", 'A re-queued'); pass('Next: partner is told and searches again');

  console.log('\nAll ' + n + ' browser checks passed'); done(0);
})().catch(e => { console.error('FAILED:', e.message); done(1); });
