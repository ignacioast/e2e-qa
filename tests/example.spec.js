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
  const dims = await page.evaluate(() => ({ height: document.body.scrollHeight, vh: window.innerHeight }));
  const total = Math.max(dims.height - dims.vh, 0);
  const step = Math.max(400, Math.floor(total / 12));
  for (let y = 0; y < total; y += step) {
    await page.evaluate((_y) => window.scrollTo(0, _y), y);
    await page.waitForTimeout(260); // deja tiempo para que carguen las imágenes lazy
  }
  await page.evaluate((_total) => window.scrollTo(0, _total), total);
  await page.waitForTimeout(400);
  // Hover sobre los enlaces del menú para revelar submenús desplegables (solo página base)
  if (hoverMenu) {
    const navLinks = await page.locator('nav a, header a, .menu a').all().catch(() => []);
    for (const link of navLinks.slice(0, 10)) {
      try { await link.hover().catch(() => {}); await page.waitForTimeout(150); } catch { /* ignorar */ }
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

// Extrae enlaces únicos internos del mismo dominio desde toda la página (sin recursión)
async function collectNavLinks(page, baseDomain) {
  const seen = new Set();
  const links = [];

  const anchors = await page.locator('a').all().catch(() => []);

  for (const anchor of anchors) {
    const href = await anchor.getAttribute('href').catch(() => null);
    if (!href || href.trim() === '' || href === '#') continue;

    try {
      const absoluteUrl = new URL(href, page.url()).href;
      const normalized = normalizeUrl(absoluteUrl);

      if (normalized && absoluteUrl.includes(baseDomain) && !absoluteUrl.includes('#')) {
        if (!seen.has(normalized)) {
          seen.add(normalized);
          links.push({ url: absoluteUrl, normalized });
        }
      }
    } catch {
      console.log(`[Crawler] Enlace inválido en el HTML: "${href}" — omitido.`);
    }
  }
  return links;
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

      // Autenticación estilo Postman: login por API directa ANTES de navegar.
      // Guardamos cookies/tokens en el contexto del navegador para que el
      // page.goto() inicial ya viaje con sesión iniciada. Soporta NextAuth
      // (CSRF + form-encoded) y loguea status/body si falla.
      if (needsAuth) {
        await apiLogin(page, context, entry);
      }

      const baseKey = normalizeUrl(urlBase);
      const visitedPages = new Set([baseKey]);
      const auditResults = [];
      const cacheHeaders = {};

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

      // Audita UNA página de forma profunda
      async function auditPage(url, label, hoverMenu) {
        const normalized = normalizeUrl(url) || url;
        const issues = [];
        const consoleErrors = [];
        let failedRequests = [];

        page.on('pageerror', (err) => consoleErrors.push(`[JS] ${err.message}`));
        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            consoleErrors.push(`[Console] ${msg.text().slice(0, 200)}`);
          }
        });

        page.on('response', (resp) => {
          if (resp.status() >= 400) {
            failedRequests.push(`${resp.status()} ${resp.url().slice(0, 120)}`);
          }
        });

        console.log(`[Auditoría] ${label} — Analizando: ${url}`);

        const t0 = Date.now();
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

          auditResults.push({ url, status: 'FALLÓ', loadMs: 'falló', memoryMB: 'falló', cache: 'falló', issues: [msg], screenshot: null });
          return normalized;
        }
        const loadMs = Date.now() - t0;

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
          };
        });
        if (!htmlChecks.title) issues.push('Página sin <title>');
        if (!htmlChecks.h1) issues.push('Página sin <h1>');
        if (htmlChecks.imgSinAlt > 0) issues.push(`${htmlChecks.imgSinAlt} imágenes sin alt`);

        // --- PANTALLAZO POR PÁGINA ---
        const shotName = `${slugify(url)}.png`;
        let shotRel = null;
        try {
          await page.screenshot({ path: path.join(SHOTS_DIR, shotName) });
          shotRel = `screenshots/${siteKey}/${shotName}`;
        } catch { /* no crítico */ }

        const pageIssues = [...issues, ...consoleErrors.slice(0, 5)];
        if (failedRequests.length) pageIssues.push(`${failedRequests.length} respuestas 4xx/5xx`);

        // LOG LEGIBLE
        console.log(`  [Tiempo]  ${loadMs} ms`);
        console.log(`  [Memoria] ${memoryMB} MB`);
        console.log(`  [Cache]   ${cache}`);
        console.log(`  [Title]   ${htmlChecks.title || '(sin title)'}`);
        console.log(`  [Forms]   ${htmlChecks.forms} formulario(s) · ${htmlChecks.inputs} campo(s) · ${htmlChecks.buttons} botón(es)`);
        if (pageIssues.length) console.log(`  [Issue]   ${pageIssues.join(' | ')}`);

        auditResults.push({
          url, status: 'OK', loadMs, memoryMB, cache,
          title: htmlChecks.title,
          forms: htmlChecks.forms,
          inputs: htmlChecks.inputs,
          buttons: htmlChecks.buttons,
          issues: pageIssues,
          screenshot: shotRel,
        });
        return normalized;
      }

      // --- PASO 1: Página base ---
      await auditPage(urlBase, 'Página base', true);

      // --- PASO 2: TODOS los enlaces internos (sin límite, sin círculos) ---
      // El sitio responde a veces una versión reducida (anti-bot) sin enlaces:
      // si no detectamos nada, esperamos y reintentamos antes de rendirnos.
      let navLinks = [];
      for (let attempt = 1; attempt <= 3 && !navLinks.length; attempt++) {
        navLinks = await collectNavLinks(page, baseDomain);
        if (!navLinks.length && attempt < 3) {
          console.log(`[Crawler] 0 enlaces detectados (posible respuesta reducida). Reintentando en 2 s... (${attempt}/3)`);
          await page.waitForTimeout(2000);
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(1000);
        }
      }
      console.log(`[Auditoría] ${navLinks.length} enlaces internos detectados. Auditando todos...`);

      for (const link of navLinks) {
        if (visitedPages.has(link.normalized)) continue;
        visitedPages.add(link.normalized);
        await auditPage(link.url, `Página ${visitedPages.size - 1}/${navLinks.length}`, false);
      }

      // --- GUARDAR REPORTE JSON (por sitio) ---
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      fs.writeFileSync(auditReportPath(siteKey), JSON.stringify({
        dominio: baseDomain,
        ejecutado: new Date().toISOString(),
        totalPaginas: auditResults.length,
        ok: auditResults.filter((r) => r.status === 'OK').length,
        fallidas: auditResults.filter((r) => r.status === 'FALLÓ').length,
        paginas: auditResults,
      }, null, 2));

      // --- RESUMEN FINAL ---
      console.log('\n===== RESUMEN DE AUDITORÍA =====');
      const ok = auditResults.filter((r) => r.status === 'OK');
      const failed = auditResults.filter((r) => r.status !== 'OK');
      for (const r of auditResults) {
        console.log(`  [${r.status}] ${r.url} — ${r.loadMs} ms — ${r.memoryMB} — ${r.cache}`);
      }
      console.log(`Total: ${auditResults.length} páginas (${ok.length} OK / ${failed.length} fallidas)`);

      // Aserción final: informa de las páginas fallidas (sin matar el reporte)
      expect(failed.length, `Páginas que fallaron: ${failed.map((f) => f.url).join(', ')}`).toBe(0);
    });
  });
});