import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import site from '../scripts/site.js';
import { normalizeUrlEntry, authEnabled } from '../scripts/site.js';
import { apiLogin } from '../scripts/auth.js';

// Carga las URLs dinámicas provistas por el equipo de I+D+i (data/urls.json).
// Cada entrada puede ser "https://sitio.cl" (sin login) o
// { url: "https://sitio.cl", auth: { enabled, loginUrl, username, password } }.
// La autenticación se resuelve por API (estilo Postman) antes de navegar.
const urlsPath = path.resolve(__dirname, '..', 'data', 'urls.json');
const allEntries = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'))
  .map((entry) => normalizeUrlEntry(entry))
  .filter(Boolean);
// TEST_SITE=<siteKey> : limita la suite a un solo sitio (ej. runner --site=ast).
const filterSite = process.env.TEST_SITE;
const targetEntries = filterSite
  ? allEntries.filter(({ url }) => site.siteKey(url) === filterSite)
  : allEntries;

// Reportes y screenshots (por sitio: cada dominio escribe en su propia carpeta)
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports');
const SHOTS_BASE = path.join(REPORTS_DIR, 'screenshots');
const AUDIT_DIR = path.join(REPORTS_DIR, 'auditoria');

// Reporte de auditoría de UN sitio
const auditReportPath = (siteKey) => path.join(AUDIT_DIR, `${siteKey}.json`);

// Borra el contenido de un directorio (sin borrar la carpeta en sí)
const clearDirContents = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
};

// Reinicia la carpeta de pantallazos de UN sitio: cada corrida reemplaza las
// imágenes de la anterior (no acumula PNGs huérfanos).
const resetShotsDirs = (shotsDir) => {
  const errorsDir = path.join(shotsDir, 'errors');
  clearDirContents(shotsDir);
  clearDirContents(errorsDir);
  fs.mkdirSync(errorsDir, { recursive: true });
};

// Normaliza una URL para comparar sin falsos duplicados (evita "https://ast.cl" vs "https://ast.cl/")
const normalizeUrl = (u) => {
  try {
    return new URL(u).href.replace(/\/$/, '');
  } catch {
    return null;
  }
};

// Extrae la URL del recurso/endpoint desde el texto de un error de consola.
// Ej: "Error HTTP: {status: 404, url: /dispositivos_historial/FJKB624330851, ...}"
//     -> "/dispositivos_historial/FJKB624330851"
const extractResourceFromMsg = (text) => {
  const m = text.match(/(?:url\s*[:=]\s*)["']?([a-zA-Z0-9_\-./?=&%:]+)/i);
  return m ? m[1] : null;
};

// Nombre de archivo seguro a partir de una URL (para screenshots)
const slugify = (url) => {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^\w\-]+/g, '_')
    .slice(0, 120);
};

// Hace scroll real por toda la página (para cargar contenido lazy, formularios,
// imágenes y demás que solo aparecen al hacer scroll), como haría un usuario.
async function scrollThroughPage(page, hoverMenu) {
  // Total de scroll acotado a 120 pasos como máximo: si una página crece sin fin
  // (feed infinito, snowstorm), el loop no debe colgar el test para siempre.
  const dims = await page.evaluate(() => ({ height: document.body.scrollHeight, vh: window.innerHeight }));
  const total = Math.max(dims.height - dims.vh, 0);
  const step = Math.max(400, Math.floor(total / 12));
  const maxSteps = Math.ceil(total / step);
  const steps = Math.min(Math.max(maxSteps, 1), 120);
  for (let i = 0; i < steps; i++) {
    await page.evaluate((_y) => window.scrollTo(0, _y), Math.min(i * step, total));
    await page.waitForTimeout(260); // deja tiempo para que carguen las imágenes lazy
  }
  await page.evaluate((_total) => window.scrollTo(0, _total), total);
  await page.waitForTimeout(400);
  // Hover sobre los enlaces del menú para revelar submenús desplegables (solo página base).
  // NOTA: timeout corto obligatorio — sin él, un elemento enorme/animado (p. ej. un
  // div contenedor del header) hace esperar a Playwright indefinidamente y cuelga el test.
  if (hoverMenu) {
    const navLinks = await page.locator('nav a, header a, header button, .menu a, aside a, aside [role="menuitem"], .sidebar a').all().catch(() => []);
    for (const link of navLinks.slice(0, 10)) {
      try { await link.hover({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(150); } catch { /* ignorar */ }
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

// Extrae enlaces únicos internos del mismo dominio desde toda la página (sin recursión).
// Soporta hash-routing (SPAs tipo "#/ruta" o "/#/ruta"): un ancla pura "#contacto" no
// se cuenta como página, pero "#/akva" sí se audita como ruta propia.
async function collectNavLinks(page, baseDomain) {
  const seen = new Set();
  const links = [];

  // Anchors de TODO el documento + los del menú/sidebar (los <a> del nav ya están
  // incluidos en 'a', pero lo dejamos explícito por si hay iframes o shadow DOM).
  const anchors = await page.locator('a, aside a, nav a, header a, .sidebar a').all().catch(() => []);
  if (anchors.length === 0) return links; // ningún <a> en todo el documento: sin enlaces

  for (const anchor of anchors) {
    const href = await anchor.getAttribute('href').catch(() => null);
    if (!href) continue;
    const raw = href.trim();
    if (raw === '' || raw === '#' || raw === 'javascript:void(0)' || raw === 'javascript:void(0);') continue;

    // Anclas puras (#seccion) no son subpáginas; rutas con hash (#/ruta) sí.
    const isHashRoute = /^#\/|^#!\/|^\/#\//.test(raw);
    if (raw.startsWith('#') && !isHashRoute) continue;

    try {
      const absoluteUrl = new URL(raw, page.url()).href;
      // Un ancla de sección sobre una ruta real (ej: /akva#equipo) audita la ruta sin el hash.
      const isRouteHash = absoluteUrl.includes('#') && absoluteUrl.split('#')[1].startsWith('/');
      const targetUrl = isRouteHash ? absoluteUrl : absoluteUrl.split('#')[0];
      const normalized = normalizeUrl(targetUrl);

      if (normalized && targetUrl.includes(baseDomain)) {
        if (!seen.has(normalized)) {
          seen.add(normalized);
          links.push({ url: targetUrl, normalized });
        }
      }
    } catch {
      console.log(`[Crawler] Enlace inválido en el HTML: "${href}" — omitido.`);
    }
  }
  return links;
}

// Detecta si la página actual está operando con sesión viva (menú/nav visible).
// Si es true, UNA RECARGA (page.goto/page.reload) desloguearía SPAs cuya sesión
// vive solo en memoria del router → por eso evitamos goto a la misma URL.
async function hasNavLinks(page) {
  try {
    const count = await page.locator('nav a, header a, aside a, .sidebar a, .menu a, [role="menuitem"]').count();
    return count > 0;
  } catch {
    return false;
  }
}

// Navega a un enlace interno haciendo CLICK en el <a href> real (navegación
// client-side en SPAs, sin recargar = no se pierde la sesión). Devuelve true si
// la URL quedó en el destino; false si no había anchor que coincida o no navegó
// (cae en el fallback de page.goto en el flujo principal).
async function clickAndWaitUrl(page, targetUrl) {
  let tNorm;
  try { tNorm = normalizeUrl(targetUrl); } catch { return false; }
  let tPath;
  try { tPath = new URL(targetUrl).pathname + new URL(targetUrl).search; } catch { return false; }

  const clicked = await page.evaluate((path) => {
    const anchors = [...document.querySelectorAll('a[href]')];
    const anchor = anchors.find((a) => {
      const href = a.getAttribute('href') || '';
      const target = href.split('#')[0];
      if (target === path) return true;
      try { return new URL(target, location.origin).pathname + new URL(target, location.origin).search === path; } catch { return false; }
    });
    if (!anchor) return false;
    try { anchor.scrollIntoView({ block: 'center' }); } catch {}
    anchor.click();
    return true;
  }, tPath).catch(() => false);

  if (!clicked) return false;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(250);
    try {
      if (normalizeUrl(page.url()) === tNorm) return true;
    } catch { return false; }
  }
  return false;
}

// Descubrimiento por clic para SPAs con routing por JS (React/Vue/Angular) donde el
// menú navega por onClick sobre divs/spans (sin <a href> ni <button>, a veces sin
// <nav>/<aside>). Hace click en cada candidato y captura la URL resultante.
// IMPORTANTE: es best-effort y acotado de forma garantizada: `Promise.race` limita la
// función completa a ~15 s aunque algo se cuelgue (ej: 10.30.7.14, un radar sin
// subpáginas). Si no hay candidatos o no se detecta navegación real, retorna [] y el
// test continúa auditando solo la página base.
async function collectViaMenuClicks(page, baseUrl, baseDomain) {
  const HARD_LIMIT_MS = 15000;

  const crawl = async () => {
    const found = new Map();
    const origin = new URL(baseUrl).origin;
    const baseNorm = normalizeUrl(baseUrl);
    const DEADLINE_MS = 22000;
    const deadline = Date.now() + DEADLINE_MS;

    // Localizar candidatos clicables de la zona de menú (mitad izquierda de la pantalla)
    const candidates = await page.evaluate(() => {
      const items = [];
      const seen = new Set();
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        const tag = el.tagName.toLowerCase();
        if (['input', 'select', 'textarea', 'script', 'style', 'svg', 'path', 'label', 'img', 'iframe', 'button', 'a'].includes(tag)) continue;
        if (getComputedStyle(el).cursor !== 'pointer' && getComputedStyle(el).cursor !== 'hand') continue;
        const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!text || text.length > 60 || text.length < 2) continue;
        if (seen.has(text)) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // Ampliar zona de menú: izquierda 65% (antes 55%) para captar menús laterales anchos
        if (r.left > window.innerWidth * 0.65) continue;
        const href = el.getAttribute('href');
        if (href && href !== '#') continue; // los <a> reales ya los cubre collectNavLinks
        seen.add(text);
        items.push({ text, tag, x: Math.round(r.left), y: Math.round(r.top) });
      }
      // Aumentar límite a 12 candidatos (antes 6)
      return items.slice(0, 12);
    }).catch(() => []);

    if (candidates.length === 0) {
      console.log('[Crawler] Sin candidatos clicables en el menú — solo se audita la página base.');
      return [];
    }
    console.log(`[Crawler] Probando ${candidates.length} elemento(s) clicables (hasta ${Math.round(DEADLINE_MS / 1000)} s)...`);

    for (const cand of candidates) {
      if (found.size >= 20 || Date.now() > deadline) break;
      if (/login|logout|ingresar|salir|cerrar sesión/i.test(cand.text)) continue;
      // Estado limpio: cada intento parte de la página base (con timeout, nunca cuelga).
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(400);

      const target = page.locator('body').getByText(cand.text, { exact: false }).first();
      try {
        await target.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(900);
        const after = page.url();
        const afterNorm = normalizeUrl(after);
        const isNewPage = afterNorm && afterNorm !== baseNorm && after.startsWith(origin) && !found.has(afterNorm);
        if (isNewPage) {
          found.set(afterNorm, after);
          console.log(`[Crawler] 💠 Click "${cand.text}" → ${after}`);
          // IMPORTANTE: NO hacer return aquí — seguir probando el resto de candidatos
          // para descubrir TODAS las subpáginas (fix: 10.20.7.81 solo hallaba 1).
        } else {
          console.log(`[Crawler]   click "${cand.text}" sin cambio de ruta`);
        }
      } catch { /* elemento no clickeable */ }
    }

    return [...found.entries()].map(([normalized, url]) => ({ url, normalized }));
  };

  // El crawl tiene su propio DEADLINE_MS (14 s). No usar Promise.race que
  // resuelve antes de que crawl() devuelva los hallazgos (fix: 10.20.7.81).
  return crawl();
}

// Detecta páginas que sirven HTTP 200 pero cuyo contenido renderizado es de
// "página no encontrada" (soft 404): comunes en SPAs que cargan el layout con
// cualquier URL aunque la ruta no exista. Funciona con títulos/plantillas ES y EN.
function detectSoft404({ title, h1, bodyText }) {
  const haystack = [title, h1, bodyText].filter(Boolean).join(' ').toLowerCase();
  if (!haystack) return false;

  // Frases completas de plantilla "no encontrada".
  const frases = [
    'página no encontrada',
    'pagina no encontrada',
    'recurso no encontrado',
    'no se encontró la página',
    'no se encontro la pagina',
    'content not found',
    'page not found',
    'resource not found',
  ];
  if (frases.some((f) => haystack.includes(f))) return true;

  // <title> o <h1> que son la plantilla 404 por sí mismos (indicador fuerte).
  if (/(^|\s)(404|error 404|not found)(\s|$)/.test(title.toLowerCase()) ||
      /(^|\s)(404|error 404|not found)(\s|$)/.test((h1 || '').toLowerCase())) {
    return true;
  }

  // En conjunción: el body menciona "no encontrad"/"not found" de forma aislada
  // sumado a que la página no tiene h1 real (señal débil combinada).
  if (/(no encontrad|not found)/.test(haystack) && !h1) return true;
  return false;
}

test.describe('Sistema de Auditoría E2E y Rendimiento Autónomo - Playwright Engine', () => {
  test.setTimeout(600000);

  targetEntries.forEach((entry) => {
    const urlBase = entry.url;
    test(`Análisis de cobertura funcional, memoria y caché en: ${urlBase}`, async ({ page, context }) => {
      const siteKey = site.siteKey(urlBase);
      const SHOTS_DIR = path.join(SHOTS_BASE, siteKey);
      const ERRORS_SHOTS_DIR = path.join(SHOTS_DIR, 'errors');

      const needsAuth = authEnabled(entry);

      // Si tras el login el menú queda visible, la sesión vive en memoria del
      // router SPA y una recarga la desloguearía: auditamos SIN page.goto.
      let liveSession = false;

      // Autenticación estilo Postman: login por API directa ANTES de navegar.
      // Guardamos cookies/tokens en el contexto del navegador para que el
      // page.goto() inicial ya viaje con sesión iniciada. Soporta NextAuth
      // (CSRF + form-encoded) y loguea status/body si falla.
      if (needsAuth) {
        const loginResult = await apiLogin(page, context, entry);
        // Si tras el login el menú ya es visible, la sesión vive en la página (SPA
        // con sesión en memoria o cookie): una recarga (page.goto/page.reload) la
        // desloguearía → auditamos todo SIN recargar, navegando por clicks en los
        // <a> reales (routing client-side).
        liveSession = await hasNavLinks(page);
        if (liveSession) {
          console.log('[Auth] Sesión viva detectada tras login (menú visible) — se audita SIN recargar.');
        } else if (loginResult && loginResult.tokenSaved) {
          // SPAs con auth por TOKEN (localStorage): el menú aparece tras recargar
          // (la app decide el estado logueado leyendo el localStorage).
          await page.goto(urlBase, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
          await page.waitForTimeout(2500);
          console.log(`[Auth] App base recargada tras login (token guardado): ${page.url()}`);
        }
      }

      const baseKey = normalizeUrl(urlBase);
      const visitedPages = new Set([baseKey]);
      const auditResults = [];
      const cacheHeaders = {};
      // Errores de consola a nivel SITIO, deduplicados por mensaje (no se repiten
      // por página): mensaje -> Set(URLs donde apareció).
      const siteConsoleErrors = new Map();
      const registerConsoleErrors = (url, consoleErrors, recursos = null) => {
        for (const msg of consoleErrors) {
          if (!msg || !msg.trim()) continue;
          const key = msg.trim();
          if (!siteConsoleErrors.has(key)) siteConsoleErrors.set(key, new Set());
          const entry = siteConsoleErrors.get(key);
          entry.add(url);
          if (recursos && recursos.length) entry.resources = new Set([...(entry.resources || []), ...recursos]);
        }
      };

      resetShotsDirs(SHOTS_DIR);

      const urlObject = new URL(urlBase);
      const baseDomain = urlObject.hostname.replace('www.', '');

      // Intercepta respuestas para registrar Cache-Control y fallos (4xx/5xx)
      page.on('response', (response) => {
        const cacheControl = response.headers()['cache-control'];
        if (cacheControl) {
          const key = normalizeUrl(response.url());
          if (key) cacheHeaders[key] = cacheControl;
        }
      });

      // Audita UNA página de forma profunda. Si `live` es true, NO se hace
      // page.goto: se asume que la página ya está cargada en esa URL y hay que
      // auditarla sin recargar (SPAs cuya sesión se pierde al re-navegar).
      async function auditPage(url, label, hoverMenu, live = false) {
        const normalized = normalizeUrl(url) || url;
        const issues = [];
        const consoleErrors = [];
        const brokenAssets = [];
        const slowApis = [];
        const assertionFails = [];
        const consoleErrDetails = []; // { msg, resources:Set } por error de consola
        let failedRequests = [];
        const apiTimings = new Map(); // url -> fecha de inicio (para medir duración)

        // Aserciones tipo "expect(...).toBe(404)" que el propio sitio lanza cuando
        // una imagen/recurso no responde como debería: se reportan como observación.
        const isAssertionError = (text) => /expect\s*\(/i.test(text) && /\.toBe\s*\(/i.test(text);

        page.on('pageerror', (err) => {
          const text = err.message || '';
          consoleErrors.push(`[JS] ${text}`);
          if (isAssertionError(text)) assertionFails.push(text.trim());
        });
        page.on('console', (msg) => {
          if (msg.type() !== 'error') return;
          const text = msg.text().trim();
          consoleErrors.push(`[Console] ${text}`);
          const detail = { msg: text, resources: new Set() };
          // Correlacionar el error con su URL cuando el propio mensaje la trae
          // (p. ej. "Error HTTP: {status: 404, url: /dispositivos_historial/...}").
          const recurso = extractResourceFromMsg(text);
          if (recurso) detail.resources.add(recurso);
          consoleErrDetails.push(detail);
          if (isAssertionError(text)) assertionFails.push(text);
        });

        // Marca el inicio de cada petición para medir cuánto tarda en responder.
        page.on('request', (req) => {
          const rt = req.resourceType();
          if (rt === 'xhr' || rt === 'fetch') apiTimings.set(req.url(), Date.now());
        });

        page.on('response', (resp) => {
          const status = resp.status();
          const reqUrl = resp.url();
          const rt = resp.request().resourceType();

          // Imágenes / CSS / JS / fuentes rotos: 404 o 500.
          if ((status === 404 || status === 500) && ['image', 'stylesheet', 'script', 'font', 'manifest'].includes(rt)) {
            brokenAssets.push(`${status} ${rt} ${reqUrl.slice(0, 140)}`);
          }

          // Endpoints de API que tardan más de 2 s: cuello de botella de backend.
          if (rt === 'xhr' || rt === 'fetch') {
            const start = apiTimings.get(reqUrl);
            if (start) {
              const ms = Date.now() - start;
              if (ms > 2000) slowApis.push(`${reqUrl.slice(0, 140)} → ${ms} ms`);
            }
            apiTimings.delete(reqUrl);
          }

          if (status >= 400) {
            failedRequests.push(`${status} ${reqUrl.slice(0, 120)}`);
          }
        });

        console.log(`[Auditoría] ${label} — Analizando: ${url}`);

        const t0 = Date.now();
        let loadMs = 0;
        if (!live) {
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
          } catch (err) {
            const msg = (err.message || '').split('\n')[0];
            console.log(`[Auditoría] ERROR CARGANDO ${url}: ${msg}`);

            // Pantallazo del error (si la página sigue viva)
            try {
              await page.screenshot({ path: path.join(ERRORS_SHOTS_DIR, `${slugify(url)}_error.png`) });
              console.log(`[Pantallazo] Guardado en reports/screenshots/errors/${slugify(url)}_error.png`);
            } catch { /* página cerrada */ }

            // Distinguir errores de conexión (infra) de fallos reales:
            // net::ERR_CONNECTION_REFUSED, ERR_CONNECTION_TIMEOUT, ERR_INTERNET_DISCONNECTED,
            // ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_RESET, ERR_EMPTY_RESPONSE → 'INACCESIBLE'
            const isConnectionError = /net::ERR_(CONNECTION_(REFUSED|RESET|TIMEOUT)|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|EMPTY_RESPONSE|ADDRESS_UNREACHABLE)/.test(msg);
            const status = isConnectionError ? 'INACCESIBLE' : 'FALLÓ';

            auditResults.push({ url, status, loadMs: 'falló', memoryMB: 'falló', cache: 'falló', issues: [msg], screenshot: null });
            return normalized;
          }
          loadMs = Date.now() - t0;
        } else {
          console.log('  [Live] Página ya cargada (sesión viva): se audita sin recargar.');
        }

        // --- MEMORIA ---
        const memoryMetrics = await page.evaluate(() => {
          if (window.performance && window.performance.memory) {
            return {
              usedJSHeapSize: window.performance.memory.usedJSHeapSize,
              memoryMB: (window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)
            };
          }
          return null;
        });
        const memoryMB = memoryMetrics?.memoryMB ?? 'n/a';
        if (memoryMetrics && memoryMetrics.usedJSHeapSize >= 150000000) {
          issues.push(`Memoria alta: ${memoryMB} MB`);
        }

        // --- CACHÉ ---
        const cache = cacheHeaders[normalized] || 'sin Cache-Control';

        // --- SCROLL REAL POR LA PÁGINA (carga lazy: forms, imágenes, submenús) ---
        console.log(`  [Scroll]  Recorriendo la página completa...`);
        const scrollStart = Date.now();
        await scrollThroughPage(page, hoverMenu);
        console.log(`  [Scroll]  ${Date.now() - scrollStart} ms de scroll autónomo`);

        // --- CHECKS DE CALIDAD HTML ---
        const htmlChecks = await page.evaluate(() => {
          return {
            title: document.title || '',
            h1: document.querySelector('h1')?.textContent?.trim().slice(0, 80) || '',
            imgSinAlt: [...document.querySelectorAll('img')].filter((i) => !i.getAttribute('alt')).length,
            forms: document.querySelectorAll('form').length,
            inputs: [...document.querySelectorAll('input, select, textarea')].length,
            buttons: document.querySelectorAll('button, [type="submit"], [type="button"]').length,
            bodyText: (document.body?.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300),
          };
        });
        if (!htmlChecks.title) issues.push('Página sin <title>');
        if (!htmlChecks.h1) issues.push('Página sin <h1>');
        if (htmlChecks.imgSinAlt > 0) issues.push(`${htmlChecks.imgSinAlt} imágenes sin alt`);

        // --- SOFT 404: HTTP 200 pero el contenido renderizado es de "no encontrada".
        // Ocurre en SPAs que sirven el layout con la URL pero no existe la página
        // (p. ej. ast /network-ip). Detección universal por frases/plantillas.
        const soft404 = detectSoft404(htmlChecks);
        if (soft404) {
          issues.push('Soft 404: HTTP 200 pero el contenido muestra "página no encontrada"');
          console.log('  [Soft404] Página carga con HTTP 200 pero su contenido es de "no encontrada"');
        }

        // --- PANTALLAZO POR PÁGINA ---
        const shotName = `${slugify(url)}.png`;
        let shotRel = null;
        try {
          // Esperar a que los elementos dinámicos terminen de renderizarse
          // antes del pantallazo (el shot inmediato salía "vacío" en SPAs).
          await page.waitForTimeout(2000);
          await page.screenshot({ path: path.join(SHOTS_DIR, shotName) });
          shotRel = `screenshots/${siteKey}/${shotName}`;
        } catch { /* no crítico */ }

        // Pantallazo extra del estado con errores (4xx/5xx o console errors de red)
        // para que el reporte muestre visualmente el problema sin abrir DevTools.
        let shotErrRel = null;
        if (consoleErrDetails.length || failedRequests.length || brokenAssets.length) {
          try {
            const errShotName = `${slugify(url)}_errores.png`;
            await page.waitForTimeout(500);
            await page.screenshot({ path: path.join(SHOTS_DIR, errShotName) });
            shotErrRel = `screenshots/${siteKey}/${errShotName}`;
            console.log(`  [ShotError] ${shotErrRel}`);
          } catch { /* no crítico */ }
        }

        const pageIssues = [...issues];
        const consoleErrorsUnique = [...new Set(consoleErrors)];
        // Correlación final: los errores genéricos de red ("Failed to load resource:
        // ... 404 ()") no traen la URL en el texto; se les asocia la lista real de
        // peticiones 4xx/5xx de la misma página (failedRequests) para que el reporte
        // sea trazable sin recurrir a DevTools.
        const loadRes404 = consoleErrDetails.filter(
          (d) => /failed to load resource/i.test(d.msg) && d.resources.size === 0,
        );
        if (loadRes404.length && failedRequests.length) {
          const urlsReales = [...new Set(failedRequests)];
          loadRes404.forEach((d) => urlsReales.forEach((u) => d.resources.add(u)));
        }
        // Mapa mensaje -> Set(recursos) consolidado para el registro a nivel sitio.
        const errToResources = new Map();
        for (const d of consoleErrDetails) {
          if (!errToResources.has(d.msg)) errToResources.set(d.msg, new Set());
          d.resources.forEach((r) => errToResources.get(d.msg).add(r));
        }
        registerConsoleErrors(url, consoleErrorsUnique, errToResources);
        if (failedRequests.length) pageIssues.push(`${failedRequests.length} respuestas 4xx/5xx`);
        if (brokenAssets.length) pageIssues.push(`${brokenAssets.length} asset(s) roto(s) [404/500]`);
        if (slowApis.length) pageIssues.push(`${slowApis.length} API(s) lenta(s) >2s`);
        // Fallos de aserción (imagen/recurso que no responde como el sitio espera):
        // se registran como observación en la propia página.
        assertionFails.forEach((af) => pageIssues.push(`Fallido (aserción): ${af.slice(0, 160)}`));

        // LOG LEGIBLE
        console.log(`  [Tiempo]  ${loadMs} ms`);
        console.log(`  [Memoria] ${memoryMB} MB`);
        console.log(`  [Cache]   ${cache}`);
        console.log(`  [Title]   ${htmlChecks.title || '(sin title)'}`);
        console.log(`  [Forms]   ${htmlChecks.forms} formulario(s) · ${htmlChecks.inputs} campo(s) · ${htmlChecks.buttons} botón(es)`);
        if (failedRequests.length) console.log(`  [Assets]  ${failedRequests.length} respuesta(s) 4xx/5xx`);
        if (brokenAssets.length) console.log(`  [Assets]  Rotos: ${brokenAssets.join(' | ')}`);
        if (slowApis.length) console.log(`  [API]     LENTAS (>2s): ${slowApis.join(' | ')}`);
        if (pageIssues.length) console.log(`  [Issue]   ${pageIssues.join(' | ')}`);

        // Fallo de aserción (p. ej. expect(...).toBe(404)) o soft 404 = la página quedó
        // con un recurso/contenido fallido: se marca como FALLÓ (no solo observación).
        const pageStatus = (assertionFails.length || soft404) ? 'FALLÓ' : 'OK';

        auditResults.push({
          url, status: pageStatus, loadMs, memoryMB, cache,
          title: htmlChecks.title,
          forms: htmlChecks.forms,
          inputs: htmlChecks.inputs,
          buttons: htmlChecks.buttons,
          issues: pageIssues,
          brokenAssets,
          slowApis,
          erroresConsola: consoleErrDetails.map((d) => ({
            mensaje: d.msg,
            recursos: [...d.resources],
          })),
          screenshotErrores: shotErrRel,
          soft404: !!soft404,
          screenshot: shotRel,
        });
        return normalized;
      }

      // --- PASO 1: Página base ---
      await auditPage(urlBase, 'Página base', true, liveSession);

      // --- PASO 2: TODOS los enlaces internos (sin límite, sin círculos) ---
      // El sitio responde a veces una versión reducida (anti-bot) sin enlaces:
      // si no detectamos nada, esperamos y reintentamos antes de rendirnos.
      let navLinks = [];
      for (let attempt = 1; attempt <= 2 && !navLinks.length; attempt++) {
        navLinks = await collectNavLinks(page, baseDomain);
        if (!navLinks.length && attempt < 2) {
          console.log(`[Crawler] 0 enlaces detectados (posible respuesta reducida). Reintentando en 2 s... (${attempt}/2)`);
          await page.waitForTimeout(2000);
          // Con sesión viva NO recargar (desloguearía la SPA): solo re-colectar.
          if (!liveSession) {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          }
          await page.waitForTimeout(1000);
        }
      }

      // PASO 2.5: SOLO para SPAs donde NO existe ningún <a href> real (p. ej. un
      // dashboard React que navega por onClick sobre divs). En sitios normales
      // (ast.cl, hub.wisensor) con enlaces tradicionales este paso se OMITE:
      // navegar/clickear la web real solo rompía pantallazos y el anti-bot.
      let clickLinks = [];
      if (navLinks.length === 0) {
        clickLinks = await collectViaMenuClicks(page, urlBase, baseDomain);
      }
      const merged = new Map();
      for (const link of navLinks) merged.set(link.normalized, link.url);
      for (const link of clickLinks) if (!merged.has(link.normalized)) merged.set(link.normalized, link.url);
      navLinks = [...merged.entries()].map(([normalized, url]) => ({ url, normalized }));

      if (navLinks.length === 0) {
        console.log('[Crawler] No se encontraron subpáginas (ni enlaces ni clics). Se audita solo la página base.');
      } else {
        console.log(`[Auditoría] ${navLinks.length} enlaces internos detectados (${clickLinks.length} por clic). Auditando todos...`);
      }

      if (liveSession) {
        // Sesión viva (SPA): navegar por CLICK en el <a> real conserva la sesión
        // (routing client-side, sin recarga). El menú/header está presente en todas
        // las páginas del layout, así que se puede encadenar click a click.
        console.log('[Crawler] Modo sesión viva: navegación por clicks internos (sin recargas).');
        for (const link of navLinks) {
          if (visitedPages.has(link.normalized)) continue;
          visitedPages.add(link.normalized);
          const navigated = await clickAndWaitUrl(page, link.url);
          if (navigated) {
            await auditPage(link.url, `Página ${visitedPages.size - 1}/${navLinks.length}`, false, true);
          } else {
            console.log(`[Crawler] Click no navegó a ${link.url} — fallback a page.goto.`);
            await auditPage(link.url, `Página ${visitedPages.size - 1}/${navLinks.length}`, false);
          }
        }
        // Volver a la base por click (el <a> raíz, si existe) o dejar el estado.
        await clickAndWaitUrl(page, urlBase).catch(() => {});
      } else {
        // Modo tradicional: volver a la página base y abrir cada enlace con goto.
        await page.goto(urlBase, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        for (const link of navLinks) {
          if (visitedPages.has(link.normalized)) continue;
          visitedPages.add(link.normalized);
          await auditPage(link.url, `Página ${visitedPages.size - 1}/${navLinks.length}`, false);
        }
      }

      // --- GUARDAR REPORTE JSON (por sitio) ---
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      fs.writeFileSync(auditReportPath(siteKey), JSON.stringify({
        dominio: baseDomain,
        ejecutado: new Date().toISOString(),
        totalPaginas: auditResults.length,
        ok: auditResults.filter((r) => r.status === 'OK').length,
        fallidas: auditResults.filter((r) => r.status === 'FALLÓ').length,
        inaccesibles: auditResults.filter((r) => r.status === 'INACCESIBLE').length,
        paginas: auditResults,
        // Errores de consola únicos por mensaje, con las páginas donde aparecen y los
        // recursos correlacionados (deduplicados a nivel sitio).
        erroresConsola: [...siteConsoleErrors.entries()].map(([mensaje, paginas]) => ({
          mensaje,
          paginas: [...paginas],
          recursos: [...(paginas.resources || [])],
        })),
      }, null, 2));

      // --- RESUMEN FINAL ---
      console.log('\n===== RESUMEN DE AUDITORÍA =====');
      const ok = auditResults.filter((r) => r.status === 'OK');
      const failed = auditResults.filter((r) => r.status === 'FALLÓ');
      const unreachable = auditResults.filter((r) => r.status === 'INACCESIBLE');
      if (unreachable.length) {
        console.log('\n[Páginas inaccesibles]');
        for (const r of unreachable) {
          console.log(`  [${r.status}] ${r.url} — ${r.issues.join(', ')}`);
        }
        console.log('');
      }
      for (const r of auditResults) {
        if (r.status === 'INACCESIBLE') continue;
        console.log(`  [${r.status}] ${r.url} — ${r.loadMs} ms — ${r.memoryMB} — ${r.cache}`);
      }
      console.log(`Total: ${auditResults.length} páginas (${ok.length} OK / ${failed.length} fallidas${unreachable.length ? ` / ${unreachable.length} inaccesibles` : ''})`);

      // Aserción final: solo falla si hay páginas FALLÓ, no INACCESIBLE
      expect(failed.length, `Páginas que fallaron: ${failed.map((f) => f.url).join(', ')}`).toBe(0);
    });
  });
});