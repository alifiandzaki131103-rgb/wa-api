const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 2785;
const CONFIG_FILE = '/opt/wa-gateway/config.json';

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!c.users) c.users = [{ id: '1', username: 'admin', password: '13November*', role: 'superadmin', createdAt: new Date().toISOString() }];
    if (!c.apiKey) c.apiKey = 'dev-admin-key';
    return c;
  } catch(e) {
    return { apiKey: 'dev-admin-key', users: [{ id: '1', username: 'admin', password: '13November*', role: 'superadmin', createdAt: new Date().toISOString() }] };
  }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
let config = loadConfig();
saveConfig(config);

const app = express();
app.use(express.json());
app.use(express.static('/opt/wa-gateway/public'));

const sessions = new Map();
const tokens = new Map();

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = config.users.find(u => u.username === username && u.password === password);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, { username: user.username, role: user.role });
    return res.json({ token, user: { username: user.username, role: user.role } });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

function auth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const bearer = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (apiKey === config.apiKey) { req.userRole = 'api'; return next(); }
  const t = tokens.get(bearer);
  if (t) { req.userRole = t.role; req.userName = t.username; return next(); }
  return res.status(401).json({ error: 'Unauthorized' });
}
function requireSuperadmin(req, res, next) {
  if (req.userRole !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
  next();
}
app.use('/api', auth);

// Users
app.get('/api/users', (req, res) => {
  res.json(config.users.map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt })));
});
app.post('/api/users', requireSuperadmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username & password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username min 3 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  if (config.users.find(u => u.username === username)) return res.status(409).json({ error: 'Username exists' });
  const user = { id: crypto.randomBytes(4).toString('hex'), username, password, role: role || 'admin', createdAt: new Date().toISOString() };
  config.users.push(user); saveConfig(config);
  res.json({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
});
app.put('/api/users/:id', requireSuperadmin, (req, res) => {
  const user = config.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (req.body.username) user.username = req.body.username;
  if (req.body.password) user.password = req.body.password;
  if (req.body.role) user.role = req.body.role;
  saveConfig(config);
  res.json({ id: user.id, username: user.username, role: user.role });
});
app.delete('/api/users/:id', requireSuperadmin, (req, res) => {
  const idx = config.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (config.users[idx].role === 'superadmin' && config.users.filter(u => u.role === 'superadmin').length <= 1)
    return res.status(400).json({ error: 'Cannot delete last superadmin' });
  config.users.splice(idx, 1); saveConfig(config);
  res.json({ message: 'Deleted' });
});

// Settings
app.get('/api/settings', (req, res) => res.json({ apiKey: config.apiKey }));
app.put('/api/settings/apikey', requireSuperadmin, (req, res) => {
  if (!req.body.apiKey || req.body.apiKey.length < 8) return res.status(400).json({ error: 'Min 8 chars' });
  config.apiKey = req.body.apiKey; saveConfig(config);
  res.json({ apiKey: config.apiKey });
});
app.post('/api/settings/apikey/regenerate', requireSuperadmin, (req, res) => {
  config.apiKey = 'nms-' + crypto.randomBytes(24).toString('hex');
  saveConfig(config); res.json({ apiKey: config.apiKey });
});

// Sessions
function createSession(id) {
  if (sessions.has(id)) { const s = sessions.get(id); if (['ready','initializing','qr_ready'].includes(s.status)) return s; try{s.client.destroy();}catch(e){} }
  const sess = { client: null, qr: null, status: 'initializing', phone: null, name: null, createdAt: new Date() };
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: '/opt/wa-gateway/sessions' }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-extensions'], timeout: 120000 },
    webVersionCache: { type: 'none' },
  });
  client.on('loading_screen', (p,m) => console.log(`[WA:${id}] Loading: ${p}% ${m}`));
  client.on('qr', qr => { sess.qr = qr; sess.status = 'qr_ready'; console.log(`[WA:${id}] QR!`); });
  client.on('ready', () => { sess.qr = null; sess.status = 'ready'; const i = client.info; sess.phone = i?.wid?.user; sess.name = i?.pushname; console.log(`[WA:${id}] Ready: ${sess.phone}`); });
  client.on('authenticated', () => { sess.status = 'authenticated'; });
  client.on('auth_failure', m => { sess.status = 'auth_failure'; });
  client.on('disconnected', r => { sess.status = 'disconnected'; sess.phone = null; sess.name = null; sess.qr = null; if (!sess._manualStop) setTimeout(() => createSession(id), 5000); });
  sess.client = client; sessions.set(id, sess);
  client.initialize().catch(e => { console.error(`[WA:${id}] Error: ${e.message}`); sess.status = 'error'; });
  return sess;
}
function fmtId(p) { let n = p.replace(/[^0-9]/g, ''); if (n.startsWith('0')) n = '62' + n.slice(1); if (!n.startsWith('62')) n = '62' + n; return n + '@c.us'; }

app.get('/health', (req, res) => { const l=[]; sessions.forEach((s,id)=>l.push({id,status:s.status})); res.json({status:'ok',sessions:l,total:sessions.size,uptime:process.uptime()}); });
app.get('/api/sessions', (req, res) => { const l=[]; sessions.forEach((s,id)=>l.push({id,name:id,status:s.status,phone:s.phone,createdAt:s.createdAt})); res.json(l); });
app.get('/api/sessions/:id', (req, res) => { const s=sessions.get(req.params.id); if(!s) return res.json({id:req.params.id,status:'not_found'}); res.json({id:req.params.id,status:s.status,phone:s.phone,name:s.name}); });
app.post('/api/sessions', (req, res) => {
  const id = req.body.id || req.body.name || 'default';
  const s = sessions.get(id);
  if (s && ['ready','qr_ready','initializing'].includes(s.status)) return res.json({ message: 'Exists', id, status: s.status });
  createSession(id); res.json({ message: 'Starting', id });
});
app.get('/api/sessions/:id/qr', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s || !s.qr) return res.status(404).json({ error: 'No QR' });
  try { const b = await qrcode.toDataURL(s.qr); res.json({ qr: b.replace('data:image/png;base64,', '') }); } catch(e) { res.status(500).json({ error: e.message }); }
});
// Stop session (keep in list, just disconnect)
app.post('/api/sessions/:id/stop', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  try {
    s._manualStop = true;
    if (s.client) await s.client.destroy();
    s.status = 'stopped'; s.phone = null; s.name = null; s.qr = null; s.client = null;
    res.json({ message: 'Stopped', id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete session (remove completely + optional logout)
app.delete('/api/sessions/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  try {
    if (s?.client) {
      s._manualStop = true;
      if (req.query.logout==='true') await s.client.logout();
      await s.client.destroy();
    }
    sessions.delete(req.params.id);
    if (req.query.logout==='true') { const d='/opt/wa-gateway/sessions/session-'+req.params.id; if(fs.existsSync(d)) fs.rmSync(d,{recursive:true,force:true}); }
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Messaging
app.post('/api/send/text', async (req, res) => {
  const { to, text, sessionId } = req.body; const sid = sessionId || 'nmsku-billing';
  const s = sessions.get(sid); if (!s || s.status !== 'ready') return res.status(503).json({ error: `Session ${sid} not connected` });
  try { const m = await s.client.sendMessage(fmtId(to), text); res.json({ success: true, messageId: m.id._serialized }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/:sid/send-message', async (req, res) => {
  const s = sessions.get(req.params.sid); if (!s || s.status !== 'ready') return res.status(503).json({ error: 'Not connected' });
  try { const m = await s.client.sendMessage(fmtId(req.body.to), req.body.content); res.json({ success: true, response: m.id._serialized }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sessions/:id/messages/send-text', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s || s.status !== 'ready') return res.status(503).json({ error: 'Not connected' });
  try { const m = await s.client.sendMessage(req.body.chatId, req.body.text); res.json({ success: true, response: m.id._serialized }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ PROXY SCRAPER ============
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-https.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
  'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
  'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt',
  'https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt',
  'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt',
  'https://raw.githubusercontent.com/ErcinDedeworken/proxies/main/proxies.txt',
  'https://raw.githubusercontent.com/Zaeem20/FREE_PROXY_LIST/master/http.txt',
  'https://raw.githubusercontent.com/Zaeem20/FREE_PROXY_LIST/master/https.txt',
  'https://raw.githubusercontent.com/Zaeem20/FREE_PROXY_LIST/master/socks5.txt',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all',
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://www.proxy-list.download/api/v1/get?type=https',
  'https://www.proxy-list.download/api/v1/get?type=socks5',
];

let proxyState = { status: 'idle', scraped: 0, validated: 0, total: 0, working: [], failed: 0, startedAt: null, sources: PROXY_SOURCES.length };

function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function validateProxy(host, port, timeout = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    const opts = { host, port: parseInt(port), method: 'CONNECT', path: 'www.google.com:443', timeout };
    const req = http.request(opts);
    req.on('connect', (res) => {
      const latency = Date.now() - start;
      req.destroy();
      resolve({ host, port, latency, working: true });
    });
    req.on('error', () => resolve({ host, port, working: false }));
    req.on('timeout', () => { req.destroy(); resolve({ host, port, working: false }); });
    req.end();
  });
}

async function scrapeProxies(concurrency = 50) {
  proxyState = { status: 'scraping', scraped: 0, validated: 0, total: 0, working: [], failed: 0, startedAt: new Date(), sources: PROXY_SOURCES.length };
  console.log(`[Proxy] Scraping from ${PROXY_SOURCES.length} sources...`);

  const allProxies = new Set();
  const results = await Promise.allSettled(PROXY_SOURCES.map(async url => {
    try {
      const data = await fetchUrl(url);
      const lines = data.split('\n').map(l => l.trim()).filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
      lines.forEach(l => allProxies.add(l));
      return lines.length;
    } catch(e) { return 0; }
  }));

  proxyState.scraped = allProxies.size;
  proxyState.total = allProxies.size;
  proxyState.status = 'validating';
  console.log(`[Proxy] Scraped ${allProxies.size} unique proxies. Validating with ${concurrency} workers...`);

  const proxies = [...allProxies];
  const working = [];
  let validated = 0, failed = 0;

  // Process in batches
  for (let i = 0; i < proxies.length; i += concurrency) {
    const batch = proxies.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(p => {
      const [host, port] = p.split(':');
      return validateProxy(host, port);
    }));
    results.forEach(r => {
      validated++;
      if (r.working) { working.push({ proxy: `${r.host}:${r.port}`, latency: r.latency }); }
      else { failed++; }
    });
    proxyState.validated = validated;
    proxyState.failed = failed;
    proxyState.working = working.sort((a, b) => a.latency - b.latency);
  }

  proxyState.status = 'done';
  proxyState.working = working.sort((a, b) => a.latency - b.latency);
  console.log(`[Proxy] Done! ${working.length} working / ${allProxies.size} total`);
  return proxyState;
}

app.get('/api/proxy/status', (req, res) => {
  res.json({
    status: proxyState.status,
    sources: proxyState.sources,
    scraped: proxyState.scraped,
    validated: proxyState.validated,
    total: proxyState.total,
    working: proxyState.working.length,
    failed: proxyState.failed,
    startedAt: proxyState.startedAt,
  });
});

app.get('/api/proxy/list', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const type = req.query.type || 'all';
  res.json(proxyState.working.slice(0, limit));
});

app.post('/api/proxy/scrape', (req, res) => {
  if (proxyState.status === 'scraping' || proxyState.status === 'validating') {
    return res.json({ message: 'Already running', status: proxyState.status });
  }
  const concurrency = parseInt(req.body.concurrency) || 50;
  scrapeProxies(concurrency);
  res.json({ message: 'Scraping started', sources: PROXY_SOURCES.length, concurrency });
});

app.post('/api/proxy/stop', (req, res) => {
  proxyState.status = 'stopped';
  res.json({ message: 'Stopped' });
});

app.listen(PORT, () => {
  console.log(`[WA Gateway] Port ${PORT} | Multi-session | ${config.users.length} users`);
  const sessDir = '/opt/wa-gateway/sessions';
  if (fs.existsSync(sessDir)) {
    const dirs = fs.readdirSync(sessDir).filter(d => d.startsWith('session-'));
    dirs.forEach((d, i) => { const id = d.replace('session-', ''); console.log('[WA] Restoring:', id); setTimeout(() => createSession(id), i * 5000); });
  }
});
