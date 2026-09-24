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
const { siteKey, siteLabel, normalizeUrlEntry } = require('./site.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const WEB_DIR = path.join(PROJECT_ROOT, 'dashboard');
const URLS_PATH = path.join(PROJECT_ROOT, 'data', 'urls.json');
// Reporte HTML de Playwright (generado por el reporter 'html' tras test:stress).
const PW_REPORT_DIR = path.join(PROJECT_ROOT, 'playwright-report');
const PW_REPORT_ROOT = path.resolve(PW_REPORT_DIR);
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
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
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
    // No store: el dashboard refleja SIEMPRE el contenido actual de reports/,
    // sin que el navegador sirva copias cacheadas (los reportes cambian tras
    // cada npm run test:stress).
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
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
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES['.json'],
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
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
  return readUrls()
    .map((entry) => normalizeUrlEntry(entry))
    .filter(Boolean)
    .map(({ url, auth }) => ({
      url,
      key: siteKey(url),
      dominio: siteLabel(url),
      // IMPORTANTE: NO exponer credenciales (username/password) ni endpoints
      // internos (loginUrl) en la API pública del dashboard. El panel solo necesita
      // saber si el sitio requiere auth para mostrar el badge.
      auth: auth ? { enabled: !!auth.enabled } : null,
    }));
}

// Reporte de un sitio, con fallback al archivo legacy (mono-sitio) si aplica.
// El fallback solo corresponde al sitio original del plan (ast): los demás sitios
// que aún no tienen su propio reporte NO deben heredar datos de ast.cl en el panel.
const LEGACY_SITE = 'ast';
function readSiteReport(subdir, key) {
  const perSite = readJson(path.join(REPORTS_DIR, subdir, `${key}.json`));
  if (perSite) return perSite;
  // Migración: reportes antiguos en reports/auditoria.json y jmeter_resumen.json
  const legacyName = subdir === 'auditoria' ? 'auditoria.json' : 'jmeter_resumen.json';
  const legacy = readJson(path.join(REPORTS_DIR, legacyName));
  if (legacy && key === LEGACY_SITE) return legacy;
  return null;
}

// Mapea reports/<subdir>/*.json -> { key: reporte }, resolviendo además los
// reportes generados con una key ANTIGUA del mismo dominio (ej: carpeta
// "10_20_7" antes del fix IPv4). Así la última ejecución de cada sitio se
// muestra aunque cambie su siteKey.
function reportMap(subdir) {
  const map = {};
  const dir = path.join(REPORTS_DIR, subdir);
  let legacyFiles = [];
  let legacyMap = {};
  try {
    legacyFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of legacyFiles) {
      const data = readJson(path.join(dir, f));
      if (data && data.dominio) legacyMap[data.dominio] = data;
    }
  } catch { /* directorio aún no existe */ }

  for (const site of loadSites()) {
    map[site.key] = readSiteReport(subdir, site.key) || legacyMap[site.dominio] || null;
  }
  return map;
}

// Agrega una URL nueva a data/urls.json (validada y sin duplicados).
// Soporta credenciales opcionales: { url, auth: { enabled, loginUrl, username, password } }
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
      const exists = urls
        .map((u) => (typeof u === 'string' ? u : u.url))
        .some((u) => u.replace(/\/$/, '').toLowerCase() === normalized.toLowerCase());
      if (exists) throw new Error('Ese sitio ya está agregado.');

      // Credenciales opcionales (login por API estilo Postman)
      const auth = payload.auth && payload.auth.enabled
        ? {
            enabled: true,
            loginUrl: (payload.auth.loginUrl || '').trim(),
            username: (payload.auth.username || '').trim(),
            password: (payload.auth.password || '').trim(),
          }
        : { enabled: false };
      if (auth.enabled) {
        if (!auth.loginUrl) throw new Error('Falta el Endpoint de Login.');
        if (!auth.username || !auth.password) throw new Error('Usuario y contraseña son obligatorios si el sitio requiere autenticación.');
      }

      urls.push({ url: normalized, auth });
      writeUrls(urls);
      sendJson(res, { ok: true, sites: loadSites() });
    } catch (err) {
      res.writeHead(400, { 'Content-Type': CONTENT_TYPES['.json'] });
      res.end(JSON.stringify({ error: err.message || 'No se pudo agregar el sitio.' }));
    }
  });
}

// Elimina un sitio completo: entrada en urls.json + reportes + pantallazos.
// El sitio fijo ast.cl (www.ast.cl) no se puede eliminar.
function deleteSite(key) {
  if (!key) return { error: 'Sitio no especificado.' };
  // Protección contra path traversal: solo claves válidas de siteKey().
  if (key !== siteKey(key) || key.includes('/') || key.includes('\\') || key.startsWith('.')) {
    return { error: 'Clave de sitio inválida.' };
  }
  if (key === 'ast') {
    return { error: 'El sitio ast.cl es fijo y no se puede eliminar.' };
  }

  const urls = readUrls();
  const before = urls.length;
  const remaining = urls.filter((u) => {
    const url = typeof u === 'string' ? u : u.url;
    return siteKey(url) !== key;
  });
  if (remaining.length === before) {
    return { error: 'El sitio no existe en urls.json.' };
  }
  writeUrls(remaining);

  // Borrado de datos asociados: reportes y pantallazos (recursivo, forzado).
  const paths = [
    path.join(REPORTS_DIR, 'auditoria', `${key}.json`),
    path.join(REPORTS_DIR, 'jmeter', `${key}.json`),
    path.join(REPORTS_DIR, 'screenshots', key),
  ];
  for (const p of paths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignora */ }
  }

  return { ok: true, sites: loadSites() };
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
      env: { ...process.env, PORT: String(PORT), NO_OPEN_DASHBOARD: '1' },
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
  if (urlPath.startsWith('/api/sites/')) {
    if (req.method === 'DELETE') {
      const key = urlPath.replace('/api/sites/', '');
      return sendJson(res, deleteSite(key));
    }
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
  if (urlPath === '/api/report') {
    // Indica si el reporte HTML de Playwright está disponible para enlazar.
    return sendJson(res, { available: fs.existsSync(path.join(PW_REPORT_ROOT, 'index.html')) });
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

  // ---- Reporte HTML de Playwright (/report/...) ----
  if (urlPath === '/report') {
    res.writeHead(302, { 'Location': '/report/' });
    res.end();
    return;
  }
  if (urlPath.startsWith('/report/')) {
    const rel = urlPath.replace(/^\/report\//, '');
    const reportFile = path.join(PW_REPORT_ROOT, rel || 'index.html');
    if (reportFile.startsWith(PW_REPORT_ROOT) && fs.existsSync(reportFile) && fs.statSync(reportFile).isFile()) {
      return sendFile(res, reportFile);
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[Dashboard] Web en http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log('[Dashboard] Visible en tu red local (LAN).:');
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