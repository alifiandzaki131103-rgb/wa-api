const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.PORT || 2785;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '13November*';
const CONFIG_FILE = '/opt/wa-gateway/config.json';

function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) { return { apiKey: 'dev-admin-key' }; } }
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
let config = loadConfig();

const app = express();
app.use(express.json());
app.use(express.static('/opt/wa-gateway/public'));

// Multi-session storage
const sessions = new Map(); // id -> { client, qr, status, phone, name, createdAt }
const tokens = new Set();

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.add(token);
    return res.json({ token });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

function auth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const bearer = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (apiKey === config.apiKey || tokens.has(bearer)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}
app.use('/api', auth);

// ============ MULTI-SESSION CLIENT ============
function createSession(id) {
  if (sessions.has(id)) {
    const s = sessions.get(id);
    if (s.status === 'ready' || s.status === 'initializing' || s.status === 'qr_ready') {
      return s;
    }
    try { s.client.destroy(); } catch(e) {}
  }

  const sess = { client: null, qr: null, status: 'initializing', phone: null, name: null, createdAt: new Date() };

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id, dataPath: '/opt/wa-gateway/sessions' }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-extensions'], timeout: 120000 },
    webVersionCache: { type: 'none' },
  });

  client.on('loading_screen', (p, m) => console.log('[WA:'+id+'] Loading:', p+'%', m));
  client.on('qr', (qr) => { sess.qr = qr; sess.status = 'qr_ready'; console.log('[WA:'+id+'] QR received!'); });
  client.on('ready', () => { sess.qr = null; sess.status = 'ready'; const i = client.info; sess.phone = i?.wid?.user; sess.name = i?.pushname; console.log('[WA:'+id+'] Connected:', sess.phone, sess.name); });
  client.on('authenticated', () => { sess.status = 'authenticated'; console.log('[WA:'+id+'] Authenticated'); });
  client.on('auth_failure', (m) => { sess.status = 'auth_failure'; console.log('[WA:'+id+'] Auth fail:', m); });
  client.on('disconnected', (r) => {
    sess.status = 'disconnected'; sess.phone = null; sess.name = null; sess.qr = null;
    console.log('[WA:'+id+'] Disconnected:', r);
    setTimeout(() => { console.log('[WA:'+id+'] Reconnecting...'); createSession(id); }, 5000);
  });

  sess.client = client;
  sessions.set(id, sess);

  console.log('[WA:'+id+'] Initializing...');
  client.initialize().catch(e => { console.error('[WA:'+id+'] Init error:', e.message); sess.status = 'error'; });

  return sess;
}

function getSession(id) { return sessions.get(id); }
function fmtId(p) { let n = p.replace(/[^0-9]/g, ''); if (n.startsWith('0')) n = '62' + n.slice(1); if (!n.startsWith('62')) n = '62' + n; return n + '@c.us'; }

// ============ SETTINGS ============
app.get('/api/settings', (req, res) => res.json({ apiKey: config.apiKey }));
app.put('/api/settings/apikey', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || apiKey.length < 8) return res.status(400).json({ error: 'Min 8 chars' });
  config.apiKey = apiKey; saveConfig(config);
  res.json({ apiKey: config.apiKey, message: 'Updated' });
});
app.post('/api/settings/apikey/regenerate', (req, res) => {
  config.apiKey = 'nms-' + crypto.randomBytes(24).toString('hex');
  saveConfig(config);
  res.json({ apiKey: config.apiKey, message: 'Regenerated' });
});

// ============ SESSION ROUTES ============
app.get('/health', (req, res) => {
  const list = [];
  sessions.forEach((s, id) => list.push({ id, status: s.status }));
  res.json({ status: 'ok', sessions: list, total: sessions.size, uptime: process.uptime() });
});

app.get('/api/sessions', (req, res) => {
  const list = [];
  sessions.forEach((s, id) => list.push({ id, name: id, status: s.status, phone: s.phone, createdAt: s.createdAt }));
  res.json(list);
});

app.get('/api/sessions/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.json({ id: req.params.id, status: 'not_found', phone: null, name: null });
  res.json({ id: req.params.id, status: s.status, phone: s.phone, name: s.name });
});

app.post('/api/sessions', (req, res) => {
  const id = req.body.id || req.body.name || 'default';
  const s = getSession(id);
  if (s && (s.status === 'ready' || s.status === 'qr_ready' || s.status === 'initializing')) {
    return res.json({ message: 'Session exists', id, status: s.status });
  }
  createSession(id);
  res.json({ message: 'Session starting', id });
});

app.get('/api/sessions/:id/qr', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s || !s.qr) return res.status(404).json({ error: 'No QR' });
  try { const b = await qrcode.toDataURL(s.qr); res.json({ qr: b.replace('data:image/png;base64,', '') }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const s = getSession(req.params.id);
  try {
    if (s && s.client) {
      if (req.query.logout === 'true') await s.client.logout();
      await s.client.destroy();
    }
    sessions.delete(req.params.id);
    if (req.query.logout === 'true') {
      const dir = '/opt/wa-gateway/sessions/session-' + req.params.id;
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    res.json({ message: 'Deleted', id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ MESSAGING ============
app.post('/api/send/text', async (req, res) => {
  const { to, text, sessionId } = req.body;
  const sid = sessionId || 'nmsku-billing';
  const s = getSession(sid);
  if (!s || s.status !== 'ready') return res.status(503).json({ error: 'Session ' + sid + ' not connected' });
  try { const m = await s.client.sendMessage(fmtId(to), text); res.json({ success: true, messageId: m.id._serialized }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/:sid/send-message', async (req, res) => {
  const s = getSession(req.params.sid);
  if (!s || s.status !== 'ready') return res.status(503).json({ error: 'Session not connected' });
  try { const m = await s.client.sendMessage(fmtId(req.body.to), req.body.content); res.json({ success: true, response: m.id._serialized }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/messages/send-text', async (req, res) => {
  const s = getSession(req.params.id);
  if (!s || s.status !== 'ready') return res.status(503).json({ error: 'Session not connected' });
  try { const m = await s.client.sendMessage(req.body.chatId, req.body.text); res.json({ success: true, response: m.id._serialized }); } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ START ============
app.listen(PORT, () => {
  console.log('[WA Gateway] Port', PORT, '| Multi-session enabled');
  // Auto-restore sessions from saved auth
  const sessDir = '/opt/wa-gateway/sessions';
  if (fs.existsSync(sessDir)) {
    const dirs = fs.readdirSync(sessDir).filter(d => d.startsWith('session-'));
    dirs.forEach((d, i) => {
      const id = d.replace('session-', '');
      console.log('[WA Gateway] Restoring session:', id);
      setTimeout(() => createSession(id), i * 5000); // stagger 5s
    });
  }
});
