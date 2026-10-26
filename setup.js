// One-time setup: saves your Daraja (M-Pesa) keys to config.local.json on THIS PC.
// That file is git-ignored, so the keys never end up on GitHub. Run again any time: node setup.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILE = path.join(__dirname, 'config.local.json');
const SANDBOX_PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const old = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const m = old.mpesa || {};
// queue typed/pasted lines so nothing is lost when several arrive at once
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lines = [], waiting = [];
let ended = false;
rl.on('line', l => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on('close', () => { ended = true; while (waiting.length) waiting.shift()(''); });
const ask = (q, def = '') => {
  process.stdout.write(`${q}${def ? ` [${def.length > 20 ? def.slice(0, 8) + '...' : def}]` : ''}: `);
  return new Promise(res => { const done = a => { if (!process.stdin.isTTY) process.stdout.write('\n'); res(String(a).trim() || def); }; if (lines.length) done(lines.shift()); else if (ended) done(''); else waiting.push(done); });
};

(async () => {
  console.log('\n=== OneISP: M-Pesa (Safaricom Daraja) setup ===');
  console.log('Copy these from developer.safaricom.co.ke > My Apps > your app. Press Enter to keep the value in [brackets].\n');
  const consumerKey = await ask('Consumer Key', m.consumerKey);
  const consumerSecret = await ask('Consumer Secret', m.consumerSecret);
  const shortcode = await ask('Business Short Code', m.shortcode || '174379');
  const passkey = await ask('Passkey', m.passkey || SANDBOX_PASSKEY);
  const mode = (await ask('Mode: sandbox or production', m.mode || 'sandbox')).toLowerCase();
  const callbackBase = await ask('Public https URL for callbacks (optional, Enter to skip)', m.callbackBase || '');
  rl.close();
  if (!consumerKey || !consumerSecret) { console.log('\nNo key/secret entered - nothing saved. M-Pesa stays in simulate mode.'); return; }
  const cfg = { ...old, mpesa: { ...m, mode: mode === 'production' ? 'production' : 'sandbox', consumerKey, consumerSecret, shortcode, passkey, callbackBase } };
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  console.log(`\nSaved to ${FILE} (stays on this PC, never uploaded).`);

  // check the keys right away
  process.stdout.write('Checking the keys with Safaricom... ');
  try {
    const base = cfg.mpesa.mode === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
    const r = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64') }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    if (r.ok && t.includes('access_token')) console.log('OK - Safaricom accepted the keys.\n');
    else console.log(`REJECTED (HTTP ${r.status}) ${t.slice(0, 200)}\n -> copy the key/secret again, and make sure your Daraja app has the "Lipa Na M-Pesa Sandbox" product.\n`);
  } catch (e) { console.log(`could not reach Safaricom (${e.cause?.code || e.message}). Check the internet connection.\n`); }
})();
