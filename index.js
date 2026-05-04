const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const pino = require('pino');

const PORT = process.env.PORT || 2785;
const CONFIG_FILE = '/opt/wa-gateway/config.json';
const SESSIONS_DIR = '/opt/wa-gateway/baileys-sessions';

const logger = pino({ level: 'silent' }); // suppress baileys internal logs

// ─── Config ───
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

// ─── Auth ───
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

// ─── Users ───
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

// ─── Settings ───
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

// ─── Sessions (Baileys) ───
async function createSession(id) {
  // Clean up existing
  if (sessions.has(id)) {
    const old = sessions.get(id);
    if (['ready', 'initializing', 'qr_ready'].includes(old.status) && old.sock) return old;
    try { old.sock?.end(); } catch(e) {}
  }

  const sessDir = `${SESSIONS_DIR}/${id}`;
  if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

  const sess = { sock: null, qr: null, status: 'initializing', phone: null, name: null, createdAt: new Date(), _manualStop: false, _retryCount: 0 };
  sessions.set(id, sess);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: ['NMSKU-WA', 'Chrome', '22.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 500,
      markOnlineOnConnect: false,
    });

    sess.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr: qrCode } = update;

      if (qrCode) {
        sess.qr = qrCode;
        sess.status = 'qr_ready';
        console.log(`[WA:${id}] QR code generated — scan from phone`);
      }

      if (connection === 'open') {
        sess.qr = null;
        sess.status = 'ready';
        sess._retryCount = 0;
        // Extract phone from sock.user
        const jid = sock.user?.id;
        if (jid) {
          sess.phone = jid.split(':')[0].split('@')[0];
          sess.name = sock.user?.name || null;
        }
        console.log(`[WA:${id}] Connected: ${sess.phone} (${sess.name || 'no name'})`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason;
        const shouldReconnect = statusCode !== reason.loggedOut && statusCode !== reason.forbidden;

        console.log(`[WA:${id}] Disconnected: code=${statusCode}, reconnect=${shouldReconnect}`);

        sess.status = 'disconnected';
        sess.qr = null;

        if (statusCode === reason.loggedOut) {
          // Session logged out — clear auth data
          console.log(`[WA:${id}] Logged out — clearing session data`);
          sess.status = 'logged_out';
          sess.phone = null;
          sess.name = null;
          try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch(e) {}
        } else if (statusCode === reason.forbidden) {
          console.log(`[WA:${id}] Forbidden/Banned`);
          sess.status = 'banned';
        } else if (!sess._manualStop && shouldReconnect) {
          sess._retryCount++;
          const delay = Math.min(5000 * sess._retryCount, 60000); // exponential backoff, max 60s
          console.log(`[WA:${id}] Reconnecting in ${delay/1000}s (attempt ${sess._retryCount})`);
          setTimeout(() => createSession(id), delay);
        }
      }
    });

  } catch(e) {
    console.error(`[WA:${id}] Init error: ${e.message}`);
    sess.status = 'error';
  }

  return sess;
}

function fmtId(p) {
  let n = p.replace(/[^0-9]/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (!n.startsWith('62')) n = '62' + n;
  return n + '@s.whatsapp.net';
}

// ─── Health ───
app.get('/health', (req, res) => {
  const l = [];
  sessions.forEach((s, id) => l.push({ id, status: s.status }));
  res.json({ status: 'ok', engine: 'baileys', sessions: l, total: sessions.size, uptime: process.uptime() });
});

// ─── Session endpoints ───
app.get('/api/sessions', (req, res) => {
  const l = [];
  sessions.forEach((s, id) => l.push({ id, name: id, status: s.status, phone: s.phone, createdAt: s.createdAt }));
  res.json(l);
});

app.get('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ id: req.params.id, status: 'not_found' });
  res.json({ id: req.params.id, status: s.status, phone: s.phone, name: s.name });
});

app.post('/api/sessions', (req, res) => {
  const id = req.body.id || req.body.name || 'default';
  const s = sessions.get(id);
  if (s && ['ready', 'qr_ready', 'initializing'].includes(s.status)) return res.json({ message: 'Exists', id, status: s.status });
  createSession(id);
  res.json({ message: 'Starting', id });
});

app.get('/api/sessions/:id/qr', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.qr) return res.status(404).json({ error: 'No QR available' });
  try {
    const b = await qrcode.toDataURL(s.qr);
    res.json({ qr: b.replace('data:image/png;base64,', '') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions/:id/stop', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  try {
    s._manualStop = true;
    if (s.sock) s.sock.end();
    s.status = 'stopped'; s.phone = null; s.name = null; s.qr = null; s.sock = null;
    res.json({ message: 'Stopped', id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  try {
    if (s?.sock) {
      s._manualStop = true;
      if (req.query.logout === 'true') await s.sock.logout();
      else s.sock.end();
    }
    sessions.delete(req.params.id);
    if (req.query.logout === 'true') {
      const d = `${SESSIONS_DIR}/${req.params.id}`;
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Messaging ───
async function sendText(s, jid, text, sessionName) {
  if (!s || s.status !== 'ready') {
    throw { code: 503, message: `Session not connected (status: ${s?.status || 'not_found'})` };
  }
  if (!s.sock) {
    throw { code: 503, message: 'Socket not initialized' };
  }

  try {
    const result = await s.sock.sendMessage(jid, { text });
    if (!result || !result.key || !result.key.id) {
      throw new Error('No message ID returned');
    }
    console.log(`[WA:${sessionName}] Sent to ${jid}: ${result.key.id}`);
    return result;
  } catch(e) {
    console.error(`[WA:${sessionName}] Send failed to ${jid}: ${e.message}`);
    throw { code: 500, message: e.message };
  }
}

app.post('/api/send/text', async (req, res) => {
  const { to, text, sessionId } = req.body;
  const sid = sessionId || 'nmsku-billing';
  const s = sessions.get(sid);
  try {
    const m = await sendText(s, fmtId(to), text, sid);
    res.json({ success: true, messageId: m.key.id });
  } catch(e) {
    res.status(e.code || 500).json({ success: false, error: e.message });
  }
});

app.post('/api/:sid/send-message', async (req, res) => {
  const s = sessions.get(req.params.sid);
  try {
    const m = await sendText(s, fmtId(req.body.to), req.body.content, req.params.sid);
    res.json({ success: true, response: m.key.id });
  } catch(e) {
    res.status(e.code || 500).json({ success: false, error: e.message });
  }
});

app.post('/api/sessions/:id/messages/send-text', async (req, res) => {
  const s = sessions.get(req.params.id);
  try {
    const m = await sendText(s, req.body.chatId, req.body.text, req.params.id);
    res.json({ success: true, response: m.key.id });
  } catch(e) {
    res.status(e.code || 500).json({ success: false, error: e.message });
  }
});

// ─── Start ───
app.listen(PORT, () => {
  console.log(`[WA Gateway] Port ${PORT} | Baileys engine | ${config.users.length} users`);

  // Restore existing sessions
  if (fs.existsSync(SESSIONS_DIR)) {
    const dirs = fs.readdirSync(SESSIONS_DIR).filter(d => {
      const p = `${SESSIONS_DIR}/${d}`;
      return fs.statSync(p).isDirectory() && fs.existsSync(`${p}/creds.json`);
    });
    dirs.forEach((id, i) => {
      console.log(`[WA] Restoring: ${id}`);
      setTimeout(() => createSession(id), i * 3000);
    });
    if (dirs.length === 0) {
      console.log('[WA] No saved sessions found');
    }
  } else {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log('[WA] Sessions directory created');
  }
});
