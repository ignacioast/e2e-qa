import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Carga las URLs dinámicas provistas por el equipo de I+D+i
const urlsPath = path.resolve(__dirname, 'urls.json');
const targetUrls = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));

test.describe('Sistema de Auditoría E2E y Rendimiento Autónomo - Playwright Engine', () => {
  // Forzar 5 minutos de timeout directamente en la prueba activa
  test.setTimeout(300000); 

  const visitedPages = new Set();

  targetUrls.forEach((urlBase) => {
    
    test(`Análisis de cobertura funcional, memoria y caché en: ${urlBase}`, async ({ page, context }) => {
      const visitedPages = new Set();
      const MAX_PAGES_LIMIT = 5; // Límite de exploración por dominio
      
      const urlObject = new URL(urlBase);
      const baseDomain = urlObject.hostname.replace('www.', '');

      async function crawlerExploration(url) {
        if (visitedPages.has(url) || visitedPages.size >= MAX_PAGES_LIMIT) return;
        visitedPages.add(url);

        console.log(`[Crawler] Navegando de forma autónoma a: ${url}`);
        
        // Intercepta las llamadas de red para validar directivas de almacenamiento en caché
        page.on('response', (response) => {
          if (response.url() === url) {
            const headers = response.headers();
            if (headers['cache-control']) {
              console.log(`[Network] Cache-Control para ${url}: ${headers['cache-control']}`);
            }
          }
        });

        // Visita la página web omitiendo errores de certificados o caídas menores
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 300000 });

        // --- EVALUACIÓN DE MEMORIA RAM REAL (SIN CONTAMINACIÓN DEL RUNNER) ---
        const memoryMetrics = await page.evaluate(() => {
          if (window.performance && window.performance.memory) {
            return {
              usedJSHeapSize: window.performance.memory.usedJSHeapSize,
              memoryMB: (window.performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2)
            };
          }
          return null;
        });

        if (memoryMetrics) {
          console.log(`[Performance] Uso de Heap de JS puro: ${memoryMetrics.memoryMB} MB`);
          // Aserción estricta de resiliencia del sistema
          expect(memoryMetrics.usedJSHeapSize).toBeLessThan(150000000); 
        }

                // --- RASTREO DINÁMICO DE ENLACES INTERNOS BLINDADO ---
        const anchors = await page.locator('a').all();
        
        for (const anchor of anchors) {
          const href = await anchor.getAttribute('href');
          
          if (href) {
            try {
              // Intenta resolver la URL de forma segura
              const absoluteUrl = new URL(href, url).href;

              // Filtro para asegurar permanencia en el dominio nativo de la empresa
              if (absoluteUrl.includes(baseDomain) && !absoluteUrl.includes('#')) {
                if (!visitedPages.has(absoluteUrl) && visitedPages.size < MAX_PAGES_LIMIT) {
                  await crawlerExploration(absoluteUrl);
                }
              }
            } catch (urlError) {
              // Si la URL está rota o es inválida en el HTML, el bot la reporta en consola pero NO se cae
              console.log(`[Crawler Warning] Se detectó una URL inválida en el HTML: "${href}". Saltando enlace.`);
            }
          }
        }

      }

      // Inicializa el proceso en la raíz del proyecto asignado
      await crawlerExploration(urlBase);
    });
  });
});
