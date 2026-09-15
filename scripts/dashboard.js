/**
 * scripts/dashboard.js — Web local para visualizar la auditoría E2E.
 *
 * Sirve en http://localhost:3000:
 *  - Frontend estático: dashboard/index.html + app.css + app.js
 *  - API: /api/auditoria  -> reports/auditoria.json
 *         /api/jmeter     -> reports/jmeter_resumen.json
 *  - Archivos: reports/screenshots/... (pantallazos) y reports/**
 *
 * Uso:
 *  npm run dashboard        (después de npm run test:stress)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const WEB_DIR = path.join(PROJECT_ROOT, 'dashboard');
const PORT = process.env.PORT || 3000;

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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  // ---- API ----
  if (urlPath === '/api/auditoria') {
    return sendJson(res, readJson(path.join(REPORTS_DIR, 'auditoria.json')) ?? {
      error: 'reports/auditoria.json no existe. Corre primero: npm run test:stress',
    });
  }
  if (urlPath === '/api/jmeter') {
    return sendJson(res, readJson(path.join(REPORTS_DIR, 'jmeter_resumen.json')) ?? {
      error: 'reports/jmeter_resumen.json no existe. Corre primero: npm run test:stress',
    });
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

server.listen(PORT, () => {
  console.log(`[Dashboard] Web local en http://localhost:${PORT}`);
});