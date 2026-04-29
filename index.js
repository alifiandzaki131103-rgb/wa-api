const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');

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

app.listen(PORT, () => {
  console.log(`[WA Gateway] Port ${PORT} | Multi-session | ${config.users.length} users`);
  const sessDir = '/opt/wa-gateway/sessions';
  if (fs.existsSync(sessDir)) {
    const dirs = fs.readdirSync(sessDir).filter(d => d.startsWith('session-'));
    dirs.forEach((d, i) => { const id = d.replace('session-', ''); console.log('[WA] Restoring:', id); setTimeout(() => createSession(id), i * 5000); });
  }
});
