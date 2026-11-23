'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'fastdelivery.sqlite');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 1024 * 1024;

if (!ADMIN_USER || !ADMIN_PASSWORD || SESSION_SECRET.length < 32) {
  console.error('Faltan variables obligatorias. Configura ADMIN_USER, ADMIN_PASSWORD y SESSION_SECRET (mínimo 32 caracteres).');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folio TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    guide_number TEXT NOT NULL,
    category TEXT NOT NULL,
    channel TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Recibida',
    assigned_area TEXT NOT NULL DEFAULT 'Atención al Cliente',
    solution TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS complaint_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_complaints_created ON complaints(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
  CREATE INDEX IF NOT EXISTS idx_updates_complaint ON complaint_updates(complaint_id, created_at DESC);
`);

const STATUS = ['Recibida', 'En análisis', 'En espera del cliente', 'Solución propuesta', 'Resuelta', 'Cerrada'];
const CATEGORIES = ['Retraso en la entrega', 'Paquete dañado', 'Información incorrecta de rastreo', 'Otro'];
const AREAS = ['Atención al Cliente', 'Logística', 'Distribución', 'Almacén', 'Sistemas', 'Finanzas', 'Supervisión'];
const CHANNELS = ['Teléfono', 'Correo electrónico', 'Otro'];

const loginAttempts = new Map();

function nowIso() { return new Date().toISOString(); }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
function sign(value) { return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function issueSession(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}
function sessionUser(req) {
  const token = getCookie(req, 'fd_session');
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.u !== ADMIN_USER || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.u;
  } catch { return null; }
}
function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || (req.socket && req.socket.encrypted);
}
function setSessionCookie(res, token, req) {
  const flags = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${isSecure(req) ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `fd_session=${encodeURIComponent(token)}; ${flags}`);
}
function clearSessionCookie(res, req) {
  res.setHeader('Set-Cookie', `fd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(req) ? '; Secure' : ''}`);
}
function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
}
function sendError(res, status, message) { sendJson(res, status, { error: message }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('La solicitud es demasiado grande.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('El formato de la solicitud no es válido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return parsed.host === host;
  } catch { return false; }
}
function clean(value, max = 2000) {
  return String(value ?? '').trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
}
function validateComplaint(input) {
  const item = {
    customerName: clean(input.customerName, 120),
    phone: clean(input.phone, 40),
    email: clean(input.email, 160),
    guideNumber: clean(input.guideNumber, 80),
    category: clean(input.category, 80),
    channel: clean(input.channel, 40),
    description: clean(input.description, 3000),
    assignedArea: clean(input.assignedArea || 'Atención al Cliente', 80),
  };
  if (!item.customerName || !item.guideNumber || !item.description) throw Object.assign(new Error('Completa el nombre, número de guía y descripción del problema.'), { status: 400 });
  if (!CATEGORIES.includes(item.category)) throw Object.assign(new Error('Selecciona un motivo válido.'), { status: 400 });
  if (!CHANNELS.includes(item.channel)) throw Object.assign(new Error('Selecciona un canal válido.'), { status: 400 });
  if (!AREAS.includes(item.assignedArea)) throw Object.assign(new Error('Selecciona un área responsable válida.'), { status: 400 });
  if (item.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email)) throw Object.assign(new Error('El correo electrónico no tiene un formato válido.'), { status: 400 });
  return item;
}
function getComplaintByFolio(folio) {
  const row = db.prepare('SELECT * FROM complaints WHERE folio = ?').get(folio);
  if (!row) return null;
  const updates = db.prepare('SELECT kind, message, actor, created_at AS createdAt FROM complaint_updates WHERE complaint_id = ? ORDER BY id DESC').all(row.id);
  return { ...mapComplaint(row), updates };
}
function mapComplaint(row) {
  return {
    folio: row.folio,
    customerName: row.customer_name,
    phone: row.phone,
    email: row.email,
    guideNumber: row.guide_number,
    category: row.category,
    channel: row.channel,
    description: row.description,
    status: row.status,
    assignedArea: row.assigned_area,
    solution: row.solution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function addUpdate(complaintId, kind, message, actor = ADMIN_USER) {
  db.prepare('INSERT INTO complaint_updates (complaint_id, kind, message, actor, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(complaintId, kind, message, actor, nowIso());
}
function listComplaints() {
  return db.prepare('SELECT * FROM complaints ORDER BY id DESC').all().map(mapComplaint);
}
function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[=+@\-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function exportCsv(res) {
  const rows = listComplaints();
  const headers = ['Folio','Fecha de recepción','Última actualización','Cliente','Teléfono','Correo','Número de guía','Motivo','Canal','Descripción','Estado','Área responsable','Solución'];
  const keys = ['folio','createdAt','updatedAt','customerName','phone','email','guideNumber','category','channel','description','status','assignedArea','solution'];
  const lines = [headers.map(csvEscape).join(','), ...rows.map(row => keys.map(key => csvEscape(row[key])).join(','))];
  const body = '\uFEFF' + lines.join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="fastdelivery-quejas.csv"',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function staticFile(res, pathname) {
  const routes = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  };
  const entry = routes[pathname];
  if (!entry) return sendError(res, 404, 'No se encontró la página solicitada.');
  const filePath = path.join(PUBLIC_DIR, entry[0]);
  fs.readFile(filePath, (err, content) => {
    if (err) return sendError(res, 404, 'No se encontró el archivo.');
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': pathname === '/' || pathname === '/index.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return sendError(res, 400, 'Dirección no válida.'); }
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !requireSameOrigin(req)) return sendError(res, 403, 'Origen no permitido.');

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
      if (attempt.resetAt < Date.now()) { attempt.count = 0; attempt.resetAt = Date.now() + 15 * 60 * 1000; }
      if (attempt.count >= 10) return sendError(res, 429, 'Demasiados intentos. Inténtalo más tarde.');
      try {
        const body = await readBody(req);
        if (safeEqual(body.username || '', ADMIN_USER) && safeEqual(body.password || '', ADMIN_PASSWORD)) {
          loginAttempts.delete(ip);
          setSessionCookie(res, issueSession(ADMIN_USER), req);
          return sendJson(res, 200, { user: ADMIN_USER });
        }
        attempt.count += 1;
        loginAttempts.set(ip, attempt);
        return sendError(res, 401, 'Usuario o contraseña incorrectos.');
      } catch (error) { return sendError(res, error.status || 400, error.message); }
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const user = sessionUser(req);
      return user ? sendJson(res, 200, { user }) : sendError(res, 401, 'Necesitas iniciar sesión.');
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      clearSessionCookie(res, req);
      return sendJson(res, 200, { ok: true });
    }

    const user = sessionUser(req);
    if (!user) return sendError(res, 401, 'Tu sesión terminó. Inicia sesión nuevamente.');

    if (pathname === '/api/complaints' && req.method === 'GET') {
      return sendJson(res, 200, { complaints: listComplaints() });
    }
    if (pathname === '/api/complaints' && req.method === 'POST') {
      try {
        const input = validateComplaint(await readBody(req));
        const timestamp = nowIso();
        const result = db.prepare(`INSERT INTO complaints (folio, customer_name, phone, email, guide_number, category, channel, description, status, assigned_area, solution, created_at, updated_at)
          VALUES ('PENDING', ?, ?, ?, ?, ?, ?, ?, 'Recibida', ?, '', ?, ?)`)
          .run(input.customerName, input.phone, input.email, input.guideNumber, input.category, input.channel, input.description, input.assignedArea, timestamp, timestamp);
        const id = Number(result.lastInsertRowid);
        const datePart = timestamp.slice(0, 10).replace(/-/g, '');
        const folio = `FD-${datePart}-${String(id).padStart(6, '0')}`;
        db.prepare('UPDATE complaints SET folio = ? WHERE id = ?').run(folio, id);
        addUpdate(id, 'Registro', 'Queja recibida y registrada en el sistema.', user);
        return sendJson(res, 201, { complaint: getComplaintByFolio(folio) });
      } catch (error) { return sendError(res, error.status || 400, error.message); }
    }
    if (pathname === '/api/export.csv' && req.method === 'GET') return exportCsv(res);

    const match = pathname.match(/^\/api\/complaints\/([^/]+)$/);
    if (match && req.method === 'GET') {
      const complaint = getComplaintByFolio(decodeURIComponent(match[1]));
      return complaint ? sendJson(res, 200, { complaint }) : sendError(res, 404, 'No se encontró la reclamación.');
    }
    if (match && req.method === 'PATCH') {
      try {
        const folio = decodeURIComponent(match[1]);
        const existing = db.prepare('SELECT * FROM complaints WHERE folio = ?').get(folio);
        if (!existing) return sendError(res, 404, 'No se encontró la reclamación.');
        const body = await readBody(req);
        const updates = [];
        const nextStatus = body.status === undefined ? existing.status : clean(body.status, 60);
        const nextArea = body.assignedArea === undefined ? existing.assigned_area : clean(body.assignedArea, 80);
        const nextSolution = body.solution === undefined ? existing.solution : clean(body.solution, 3000);
        if (!STATUS.includes(nextStatus)) return sendError(res, 400, 'Selecciona un estado válido.');
        if (!AREAS.includes(nextArea)) return sendError(res, 400, 'Selecciona un área válida.');
        if (nextStatus !== existing.status) updates.push(['Estado', `El estado cambió de “${existing.status}” a “${nextStatus}”.`]);
        if (nextArea !== existing.assigned_area) updates.push(['Asignación', `El caso se asignó al área de ${nextArea}.`]);
        if (nextSolution !== existing.solution && nextSolution) updates.push(['Solución', `Solución registrada: ${nextSolution}`]);
        const note = clean(body.note, 2000);
        if (note) updates.push(['Seguimiento', note]);
        if (!updates.length) return sendJson(res, 200, { complaint: getComplaintByFolio(folio) });
        const timestamp = nowIso();
        db.prepare('UPDATE complaints SET status = ?, assigned_area = ?, solution = ?, updated_at = ? WHERE id = ?')
          .run(nextStatus, nextArea, nextSolution, timestamp, existing.id);
        for (const [kind, message] of updates) addUpdate(existing.id, kind, message, user);
        return sendJson(res, 200, { complaint: getComplaintByFolio(folio) });
      } catch (error) { return sendError(res, error.status || 400, error.message); }
    }
    return sendError(res, 404, 'Servicio no encontrado.');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Método no permitido.');
  return staticFile(res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FastDelivery disponible en http://localhost:${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
});

function shutdown() {
  try { db.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
