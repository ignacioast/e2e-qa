import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Carga las URLs dinámicas provistas por el equipo de I+D+i (data/urls.json)
const urlsPath = path.resolve(__dirname, '..', 'data', 'urls.json');
const targetUrls = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));

// Reportes y screenshots
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports');
const SHOTS_DIR = path.join(REPORTS_DIR, 'screenshots');
const ERRORS_SHOTS_DIR = path.join(SHOTS_DIR, 'errors');
const AUDIT_REPORT = path.join(REPORTS_DIR, 'auditoria.json');

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

  targetUrls.forEach((urlBase) => {
    test(`Análisis de cobertura funcional, memoria y caché en: ${urlBase}`, async ({ page }) => {
      const baseKey = normalizeUrl(urlBase);
      const visitedPages = new Set([baseKey]);
      const auditResults = [];
      const cacheHeaders = {};

      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      fs.mkdirSync(ERRORS_SHOTS_DIR, { recursive: true });

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
      async function auditPage(url, label) {
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
            await page.screenshot({ path: path.join(ERRORS_SHOTS_DIR, `${slugify(url)}_error.png`), fullPage: true });
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

        // --- CHECKS DE CALIDAD HTML ---
        const htmlChecks = await page.evaluate(() => {
          return {
            title: document.title || '',
            h1: document.querySelector('h1')?.textContent?.trim().slice(0, 80) || '',
            imgSinAlt: [...document.querySelectorAll('img')].filter((i) => !i.getAttribute('alt')).length,
          };
        });
        if (!htmlChecks.title) issues.push('Página sin <title>');
        if (!htmlChecks.h1) issues.push('Página sin <h1>');
        if (htmlChecks.imgSinAlt > 0) issues.push(`${htmlChecks.imgSinAlt} imágenes sin alt`);

        // --- PANTALLAZO POR PÁGINA ---
        const shotName = `${slugify(url)}.png`;
        let shotRel = null;
        try {
          await page.screenshot({ path: path.join(SHOTS_DIR, shotName), fullPage: true });
          shotRel = `screenshots/${shotName}`;
        } catch { /* no crítico */ }

        const pageIssues = [...issues, ...consoleErrors.slice(0, 5)];
        if (failedRequests.length) pageIssues.push(`${failedRequests.length} respuestas 4xx/5xx`);

        // LOG LEGIBLE
        console.log(`  [Tiempo]  ${loadMs} ms`);
        console.log(`  [Memoria] ${memoryMB} MB`);
        console.log(`  [Cache]   ${cache}`);
        console.log(`  [Title]   ${htmlChecks.title || '(sin title)'}`);
        if (pageIssues.length) console.log(`  [Issue]   ${pageIssues.join(' | ')}`);

        auditResults.push({
          url, status: 'OK', loadMs, memoryMB, cache,
          title: htmlChecks.title,
          issues: pageIssues,
          screenshot: shotRel,
        });
        return normalized;
      }

      // --- PASO 1: Página base ---
      await auditPage(urlBase, 'Página base');

      // --- PASO 2: TODOS los enlaces internos (sin límite, sin círculos) ---
      const navLinks = await collectNavLinks(page, baseDomain);
      console.log(`[Auditoría] ${navLinks.length} enlaces internos detectados. Auditando todos...`);

      for (const link of navLinks) {
        if (visitedPages.has(link.normalized)) continue;
        visitedPages.add(link.normalized);
        await auditPage(link.url, `Página ${visitedPages.size - 1}/${navLinks.length}`);
      }

      // --- GUARDAR REPORTE JSON ---
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      fs.writeFileSync(AUDIT_REPORT, JSON.stringify({
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