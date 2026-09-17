/**
 * scripts/dashboard.js — Web local para visualizar la auditoría E2E.
 *
 * Sirve en http://localhost:3000:
 *  - Frontend estático: dashboard/index.html + app.css + app.js
 *  - API: /api/sites              -> lista de sitios de data/urls.json
 *         /api/auditoria          -> { [siteKey]: reporte | null, ... }
 *         /api/jmeter             -> { [siteKey]: reporte | null, ... }
 *  - Archivos: reports/screenshots/... (pantallazos) y reports/**
 *
 * Uso:
 *  npm run dashboard        (después de npm run test:stress)
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { siteKey, siteLabel } = require('./site.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const WEB_DIR = path.join(PROJECT_ROOT, 'dashboard');
const URLS_PATH = path.join(PROJECT_ROOT, 'data', 'urls.json');
const PORT = process.env.PORT || 3000;
// HOST '0.0.0.0' expone el dashboard a toda la red local (LAN).
// Para acceso solo local: HOST=127.0.0.1; detrás de nginx: HOST=127.0.0.1.
const HOST = process.env.HOST || '0.0.0.0';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const type = CONTENT_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.json'] });
  res.end(JSON.stringify(data));
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function readUrls() {
  try {
    const urls = JSON.parse(fs.readFileSync(URLS_PATH, 'utf-8'));
    return Array.isArray(urls) ? urls : [];
  } catch {
    return [];
  }
}

function writeUrls(urls) {
  fs.mkdirSync(path.dirname(URLS_PATH), { recursive: true });
  fs.writeFileSync(URLS_PATH, JSON.stringify(urls, null, 2) + '\n');
}

// ---- Sitios (data/urls.json) ----
function loadSites() {
  return readUrls().map((url) => ({
    url,
    key: siteKey(url),
    dominio: siteLabel(url),
  }));
}

// Reporte de un sitio, con fallback al archivo legacy (mono-sitio) si aplica.
function readSiteReport(subdir, key) {
  const perSite = readJson(path.join(REPORTS_DIR, subdir, `${key}.json`));
  if (perSite) return perSite;
  // Migración: reportes antiguos en reports/auditoria.json y jmeter_resumen.json
  const legacy = readJson(path.join(REPORTS_DIR, subdir === 'auditoria' ? 'auditoria.json' : 'jmeter_resumen.json'));
  return legacy || null;
}

function reportMap(subdir) {
  const map = {};
  for (const site of loadSites()) {
    map[site.key] = readSiteReport(subdir, site.key);
  }
  return map;
}

// Agrega una URL nueva a data/urls.json (validada y sin duplicados).
function handleAddSite(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const raw = (payload.url || '').trim();
      if (!raw) throw new Error('Ingresa una URL válida.');

      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error('La URL no tiene un formato válido.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Solo se permiten URLs http:// o https://');
      }

      const normalized = parsed.href.replace(/\/$/, '');
      const urls = readUrls();
      const exists = urls.some((u) => u.replace(/\/$/, '').toLowerCase() === normalized.toLowerCase());
      if (exists) throw new Error('Ese sitio ya está agregado.');

      urls.push(normalized);
      writeUrls(urls);
      sendJson(res, { ok: true, sites: loadSites() });
    } catch (err) {
      res.writeHead(400, { 'Content-Type': CONTENT_TYPES['.json'] });
      res.end(JSON.stringify({ error: err.message || 'No se pudo agregar el sitio.' }));
    }
  });
}

// Estado de la ejecución de auditorías desde el frontend
const RUN_LOG = path.join(REPORTS_DIR, 'run.log');
let runState = { running: false, site: null, startedAt: null, pid: null };

// Lanza el runner (node scripts/runner.js --site=<key>) en segundo plano.
function startRun(site) {
  if (runState.running) return { error: 'Ya hay una ejecución en curso.' };
  if (!loadSites().some((s) => s.key === site)) {
    return { error: 'Sitio no encontrado.' };
  }

  runState = { running: true, site, startedAt: new Date().toISOString(), pid: null };
  const runnerPath = path.join(__dirname, 'runner.js');

  let child;
  try {
    child = spawn(process.execPath, [runnerPath, '--site=' + site], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT) },
    });
  } catch (err) {
    runState.running = false;
    console.error('[Dashboard] No se pudo lanzar el runner:', err.message);
    return { error: 'No se pudo lanzar la auditoría: ' + err.message };
  }

  const logStream = fs.createWriteStream(RUN_LOG, { flags: 'a' });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.on('error', (err) => {
    console.error('[Dashboard] Error del runner:', err.message);
    runState.running = false;
    logStream.end();
  });
  child.on('exit', () => {
    runState.running = false;
    logStream.end();
  });

  runState.pid = child.pid;
  child.unref();
  return { ok: true };
}

function runStatus() {
  let tail = '';
  try {
    const st = fs.statSync(RUN_LOG);
    const len = Math.min(st.size, 2500);
    const fd = fs.openSync(RUN_LOG, 'r');
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    fs.closeSync(fd);
    tail = buf.toString('utf-8', 0, read).replace(/\s+$/, '');
  } catch { /* no hay log */ }
  return { ...runState, tail };
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // ---- API ----
  if (urlPath === '/api/sites') {
    if (req.method === 'POST') {
      return handleAddSite(req, res);
    }
    return sendJson(res, loadSites());
  }
  if (urlPath === '/api/auditoria') {
    return sendJson(res, reportMap('auditoria'));
  }
  if (urlPath === '/api/jmeter') {
    return sendJson(res, reportMap('jmeter'));
  }
  if (urlPath === '/api/run/status') {
    return sendJson(res, runStatus());
  }
  if (urlPath.startsWith('/api/run/start/')) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    const site = urlPath.replace('/api/run/start/', '');
    return sendJson(res, startRun(site));
  }

  // ---- Frontend (stático) ----
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const webFile = path.join(WEB_DIR, rel);
  if (webFile.startsWith(WEB_DIR) && fs.existsSync(webFile)) {
    return sendFile(res, webFile);
  }

  // ---- Archivos de reportes (screenshots, etc.) ----
  const filePath = path.join(REPORTS_DIR, urlPath.replace(/^\/+/, ''));
  if (filePath.startsWith(REPORTS_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[Dashboard] Web en http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log('[Dashboard] Visible en tu red local (LAN). Avisa a tus compañeros con tu IP:');
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`  │  http://${net.address}:${PORT}   (${name})`);
        }
      }
    }
  }
});