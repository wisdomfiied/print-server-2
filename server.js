// Multi-store Shopify -> Star CloudPRNT print server.
// Each store: own webhook URL, own signing secret, own printer (by MAC), own logo + promo.
//   Webhook:  POST /webhooks/<storeKey>/orders-create      (secret in env SECRET_<STOREKEY>)
//   Printer:  POST/GET/DELETE /print   (routed by the printer's MAC)
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { renderReceipt } = require('./receipt');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const COPIES = parseInt(process.env.COPIES || '1', 10);
const QUEUE_FILE = process.env.QUEUE_FILE || path.join(__dirname, 'queue.json');

const normMac = m => String(m || '').trim().toLowerCase().replace(/-/g, ':');
const STORES = JSON.parse(fs.readFileSync(path.join(__dirname, 'stores.json'), 'utf8'));
const envKey = k => k.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const secretFor = k => process.env['SECRET_' + envKey(k)] || '';
const storeByMac = mac => Object.keys(STORES).find(k => STORES[k].enabled && normMac(STORES[k].printerMac) === normMac(mac));

for (const [k, s] of Object.entries(STORES)) {
  if (!s.enabled) continue;
  console.log(`store ${k}: printer ${normMac(s.printerMac) || 'NOT SET'}, secret ${secretFor(k) ? 'set' : 'MISSING (SECRET_' + envKey(k) + ')'}`);
}

// ---- Persistent state: pending jobs + order IDs already queued (no double prints on retries/restarts)
let queue = [], seenList = [], recent = {};
try {
  const st = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  queue = st.queue || []; seenList = st.seen || []; recent = st.recent || {};
} catch {}
const seen = new Set(seenList);
const save = () => fs.writeFileSync(QUEUE_FILE, JSON.stringify({ queue, seen: [...seen].slice(-10000), recent }));

function enqueue(storeKey, order, reprint = false) {
  const id = `${storeKey}:${order.id}`;
  if (!reprint && seen.has(id)) return false;
  seen.add(id);
  if (!String(order.name).startsWith('TEST')) {
    recent[storeKey] = [order, ...(recent[storeKey] || []).filter(o => o.id !== order.id)].slice(0, 10);
  }
  for (let i = 0; i < COPIES; i++) {
    queue.push({ token: crypto.randomUUID(), storeKey, orderId: order.id, order, createdAt: Date.now(), attempts: 0 });
  }
  save();
  return true;
}
const render = (job, format = 'png') => {
  const s = STORES[job.storeKey] || {};
  return renderReceipt(job.order, { format, storeName: s.name, storeLine: s.line, footer: s.footer, logoPath: s.logo && fs.existsSync(path.join(__dirname, s.logo)) ? s.logo : null, promo: s.promo || {} });
};

const app = express();
const status = {};        // storeKey -> last poll time
const printerStatus = {}; // storeKey -> last status the printer reported (e.g. "200 OK", "410 Paper out")
const printerInfo = {};   // storeKey -> what the printer told us about itself (encodings, client type)
const askedInfo = new Set();
const printerFormat = {}; // storeKey -> 'png' | 'starprnt' (auto-switches on decode errors)

// ---- Shopify webhooks, one URL per store
app.post('/webhooks/:store/orders-create', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const k = req.params.store;
  const secret = secretFor(k);
  if (!STORES[k] || !STORES[k].enabled || !secret) return res.status(404).send('unknown store');
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
  if (hmac.length !== digest.length || !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest))) return res.status(401).send('bad hmac');
  const order = JSON.parse(req.body.toString('utf8'));
  if (enqueue(k, order)) console.log(`[${k}] queued ${order.name}`);
  res.status(200).send('ok');
});

app.use(express.json({ limit: '2mb' }));

// ---- CloudPRNT: printer polls; only its own store's jobs are offered
app.post('/print', (req, res) => {
  const k = storeByMac(req.body && req.body.printerMAC);
  if (!k) { console.warn('poll from unknown MAC', req.body && req.body.printerMAC); return res.json({ jobReady: false }); }
  status[k] = new Date().toISOString();
  const ps = String((req.body && req.body.statusCode) || '').replace(/%20/g, ' ');
  if (ps && ps !== printerStatus[k]) {
    console.log(`[${k}] printer status: ${ps}${ps.startsWith('2') ? '' : '  <-- PRINTER REPORTS A PROBLEM'}`);
    printerStatus[k] = ps;
  }
  // Printer answers to our earlier questions arrive in clientAction
  if (Array.isArray(req.body.clientAction) && req.body.clientAction.length) {
    for (const a of req.body.clientAction) {
      console.log(`[${k}] printer says ${a.request}: ${a.result}`);
      printerInfo[k] = { ...(printerInfo[k] || {}), [a.request]: a.result };
    }
  }
  // First poll after start: ask the printer what formats it can print
  if (!askedInfo.has(k)) {
    askedInfo.add(k);
    console.log(`[${k}] asking printer for supported formats`);
    return res.json({ jobReady: false, clientAction: [{ request: 'Encodings', options: '' }, { request: 'ClientType', options: '' }, { request: 'ClientVersion', options: '' }] });
  }
  const job = queue.find(j => j.storeKey === k);
  if (!job) return res.json({ jobReady: false });
  if (job.offeredAt !== job.token) { console.log(`[${k}] offering ${job.order.name} to printer`); job.offeredAt = job.token; }
  // Per-printer format: start with PNG; if the printer can't decode it, switch to native StarPRNT.
  const fmt = printerFormat[k] || STORES[k].format || 'png';
  res.json({ jobReady: true, mediaTypes: [fmt === 'starprnt' ? 'application/vnd.star.starprnt' : 'image/png'], jobToken: job.token });
});

app.get('/print', async (req, res) => {
  console.log(`GET /print mac=${req.query.mac} type=${req.query.type} token=${req.query.token ? 'yes' : 'no'}`);
  const k = storeByMac(req.query.mac);
  if (!k) { console.warn(`GET rejected: MAC ${req.query.mac} not in stores.json`); return res.status(403).end(); }
  const job = queue.find(j => j.token === req.query.token && j.storeKey === k) || queue.find(j => j.storeKey === k);
  if (!job) return res.status(404).end();
  console.log(`[${k}] printer fetching ${job.order.name} (type=${req.query.type || 'none'})`);
  try {
    const star = String(req.query.type || '').includes('starprnt');
    const out = await render(job, star ? 'starprnt' : 'png');
    console.log(`[${k}] sent ${job.order.name} as ${star ? 'StarPRNT raster' : '1-bit png'} (${Math.round(out.length / 1024)} KB)`);
    res.set('Content-Type', star ? 'application/vnd.star.starprnt' : 'image/png').send(out);
  }
  catch (e) { console.error('render failed', e); res.status(500).end(); }
});

app.delete('/print', (req, res) => {
  console.log(`DELETE /print mac=${req.query.mac} code=${req.query.code}`);
  const k = storeByMac(req.query.mac);
  const code = String(req.query.code || '');
  console.log(`[${k}] printer result: ${code || '(no code)'} token=${req.query.token ? 'yes' : 'no'}`);
  // Some firmware omits the token on confirm; fall back to this printer's oldest job.
  let i = queue.findIndex(j => j.token === req.query.token && j.storeKey === k);
  if (i < 0) i = queue.findIndex(j => j.storeKey === k);
  if (code.startsWith('511') && (printerFormat[k] || STORES[k]?.format || 'png') === 'png') {
    printerFormat[k] = 'starprnt';
    console.log(`[${k}] printer can't decode PNG -> switching this printer to StarPRNT`);
    return res.status(200).end(); // retry same job in new format, don't count as a failure
  }
  if (i >= 0) {
    if (code.startsWith('2') || ++queue[i].attempts >= 5) {
      if (!code.startsWith('2')) {
        console.error(`[${k}] dropping ${queue[i].order.name} after 5 failures (${code})`);
        if (!String(queue[i].order.name).startsWith('TEST')) alert(k, `failed-${queue[i].token}`,
          `ORDER DID NOT PRINT: ${queue[i].order.name}`,
          `The printer failed to print order ${queue[i].order.name} after 5 attempts (printer said: ${code}).\n\nThis ticket will NOT print on its own. Pull it up in Shopify and hand it to the kitchen.`, false);
      }
      queue.splice(i, 1);
    }
    save();
  }
  res.status(200).end();
});

// ---- Admin (all require ?key=ADMIN_KEY&store=<storeKey>)
const admin = (req, res, next) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).send('unauthorized');
  if (req.query.store && !STORES[req.query.store]) return res.status(404).send('unknown store');
  next();
};
app.get('/admin/preview', admin, async (req, res) => {
  const k = req.query.store || Object.keys(STORES)[0];
  res.set('Content-Type', 'image/png').send(await render({ storeKey: k, order: require('./sample-order.json') }));
});
// View real orders in the browser: n=1 newest, n=2 the one before, etc.
app.get('/admin/last', admin, async (req, res) => {
  const k = req.query.store; if (!k) return res.status(400).send('add &store=');
  const n = Math.max(1, parseInt(req.query.n || '1', 10));
  const o = (recent[k] || [])[n - 1];
  if (!o) return res.status(404).send(`no real orders received yet for ${k} (place an order on Shopify, then refresh)`);
  res.set('Content-Type', 'image/png').send(await render({ storeKey: k, order: o }));
});
// Remove pending (not yet printed) jobs for a store, e.g. browser tests you don't want printed
app.get('/admin/clear', admin, (req, res) => {
  const k = req.query.store; if (!k) return res.status(400).send('add &store=');
  const before = queue.length; queue = queue.filter(j => j.storeKey !== k); save();
  res.send(`cleared ${before - queue.length} pending job(s) for ${k}`);
});
app.post('/admin/test', admin, (req, res) => {
  const k = req.query.store; if (!k) return res.status(400).send('add &store=');
  enqueue(k, { ...require('./sample-order.json'), id: Date.now(), name: 'TEST' }, true);
  res.send(`test queued for ${k}`);
});
app.get('/admin/test', admin, (req, res) => { // browser-friendly version
  const k = req.query.store; if (!k) return res.status(400).send('add &store=');
  enqueue(k, { ...require('./sample-order.json'), id: Date.now(), name: 'TEST' }, true);
  res.send(`test queued for ${k} — should print within ~10 seconds`);
});
app.get('/admin/status', admin, (req, res) => res.json(Object.fromEntries(
  Object.entries(STORES).filter(([, s]) => s.enabled).map(([k, s]) => [k, {
    printerMac: normMac(s.printerMac), lastPoll: status[k] || 'never (printer not connected)',
    printerStatus: printerStatus[k] || 'unknown',
    printerInfo: printerInfo[k] || 'not reported yet',
    format: printerFormat[k] || s.format || 'png',
    pending: queue.filter(j => j.storeKey === k).map(j => j.order.name),
    recentOrders: (recent[k] || []).map(o => o.name), secret: secretFor(k) ? 'set' : 'MISSING',
  }]))));

// ---- Optional backup sync per store: catches any order a webhook missed (checks every 60s)
//      Env per store: SHOP_<STOREKEY>=xxx.myshopify.com  TOKEN_<STOREKEY>=shpat_... (read_orders)
const BOOT = Date.now();
setInterval(async () => {
  for (const [k, s] of Object.entries(STORES)) {
    const shop = process.env['SHOP_' + envKey(k)], token = process.env['TOKEN_' + envKey(k)];
    if (!s.enabled || !shop || !token) continue;
    try {
      const since = new Date(Math.max(BOOT, Date.now() - 30 * 60 * 1000)).toISOString();
      const r = await fetch(`https://${shop}/admin/api/2025-07/orders.json?status=any&created_at_min=${encodeURIComponent(since)}&limit=50`, { headers: { 'X-Shopify-Access-Token': token } });
      if (!r.ok) { console.error(`[${k}] backup sync ${r.status}`); continue; }
      for (const o of (await r.json()).orders || []) if (enqueue(k, o)) console.log(`[${k}] backup sync caught ${o.name}`);
    } catch (e) { console.error(`[${k}] backup sync failed`, e.message); }
  }
}, 60 * 1000);

// ===================== EMAIL ALERTS =====================
// Env: RESEND_API_KEY (resend.com, free), ALERT_EMAIL (where to send), optional ALERT_FROM.
const RESEND_KEY = process.env.RESEND_API_KEY, ALERT_TO = process.env.ALERT_EMAIL;
const ALERT_FROM = process.env.ALERT_FROM || 'Print Server <onboarding@resend.dev>';
const open = new Map(); // alertId -> {store, subject} for problems currently active

async function sendEmail(subject, text) {
  if (!RESEND_KEY || !ALERT_TO) { console.warn('[alert not sent: RESEND_API_KEY / ALERT_EMAIL not set]', subject); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: ALERT_TO.split(',').map(e => e.trim()), subject, text }),
    });
    console.log(`[alert] ${r.ok ? 'emailed' : 'EMAIL FAILED ' + r.status}: ${subject}`);
  } catch (e) { console.error('[alert] email error', e.message); }
}
// track=true: remember it so we send one "resolved" email later and don't repeat
function alert(k, id, subject, body, track = true) {
  const key = `${k}:${id}`;
  if (track && open.has(key)) return;
  if (track) open.set(key, { subject });
  const name = STORES[k]?.name || k;
  sendEmail(`[${name}] ${subject}`, `${body}\n\nStatus page: ${STATUS_URL}\nTime: ${new Date().toLocaleString('en-US', { timeZone: TZN })}`);
}
function resolve(k, id, body) {
  const key = `${k}:${id}`;
  const a = open.get(key); if (!a) return;
  open.delete(key);
  sendEmail(`[${STORES[k]?.name || k}] RESOLVED: ${a.subject}`, body || 'Back to normal.');
}

// Open hours per store (stores.json "hours": {"tue":"10:30-22:00", ...}); missing day = closed; no "hours" = always open
const TZN = process.env.TZ_NAME || 'America/New_York';
const STATUS_URL = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/admin/status?key=${ADMIN_KEY}` : '(set PUBLIC_URL to include a link)';
function isOpen(k) {
  const h = STORES[k].hours; if (!h) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZN, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(p => [p.type, p.value]));
  const range = h[parts.weekday.toLowerCase()]; if (!range) return false;
  const [a, b] = range.split('-').map(t => { const [hh, mm] = t.split(':').map(Number); return hh * 60 + (mm || 0); });
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  return now >= a && now <= b;
}

const STARTED = Date.now();
const statusSince = {}; // storeKey -> when current non-OK printer status began
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of Object.entries(STORES)) {
    if (!s.enabled) continue;
    // 1) Orders stuck in queue > 2 min (ignore TEST tickets)
    for (const j of queue.filter(j => j.storeKey === k && !String(j.order.name).startsWith('TEST'))) {
      if (now - j.createdAt > 2 * 60 * 1000)
        alert(k, `stuck-${j.token}`, `Order ${j.order.name} has NOT printed`,
          `Order ${j.order.name} came in over 2 minutes ago and still hasn't printed.\n\nPrinter last checked in: ${status[k] || 'not since server restart'}\nPrinter status: ${printerStatus[k] || 'unknown'}\n\nCheck the printer, and pull the order up in Shopify so the kitchen has it.`);
    }
    for (const key of [...open.keys()].filter(x => x.startsWith(`${k}:stuck-`))) {
      const tok = key.slice(`${k}:stuck-`.length);
      if (!queue.some(j => j.token === tok)) resolve(k, `stuck-${tok}`, 'That order has now printed.');
    }
    // 2) Printer offline > 3 min while store is open (grace period after server restart)
    const last = status[k] ? Date.parse(status[k]) : null;
    const offline = last ? now - last > 3 * 60 * 1000 : now - STARTED > 5 * 60 * 1000;
    if (offline && isOpen(k)) alert(k, 'offline', 'PRINTER OFFLINE',
      `The printer hasn't checked in for over 3 minutes (last seen: ${status[k] || 'not since server restart'}).\n\nNew online orders will NOT print until it's back. Check power, paper door, and Wi-Fi/network cable, then turn it off and on.`);
    if (!offline) resolve(k, 'offline', 'Printer is back online. Any orders waiting will print now.');
    // 3) Printer reporting a problem (paper out, cover open...) > 1 min
    const ps = printerStatus[k] || '';
    if (ps && !ps.startsWith('2')) {
      statusSince[k] = statusSince[k] || now;
      if (now - statusSince[k] > 60 * 1000) alert(k, 'hw', `PRINTER PROBLEM: ${ps}`,
        `The printer is reporting "${ps}". Usually paper out or cover open. Orders will wait until it's fixed.`);
    } else { statusSince[k] = null; resolve(k, 'hw', 'Printer problem cleared.'); }
  }
}, 30 * 1000);

app.get('/admin/test-alert', admin, async (req, res) => {
  await sendEmail('Print server test alert', 'If you got this, alerts are working.');
  res.send(RESEND_KEY && ALERT_TO ? `test email sent to ${ALERT_TO} — check inbox and spam` : 'RESEND_API_KEY or ALERT_EMAIL not set in Railway');
});

app.get('/', (req, res) => res.send('print server up'));
app.listen(PORT, () => console.log(`listening on ${PORT}`));
