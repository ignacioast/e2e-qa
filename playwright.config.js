const { defineConfig } = require('@playwright/test');

// Resolución de navegador: local usa Google Chrome; Docker usa chromium bundled.
// - PW_CHANNEL  undefined -> chrome (Google Chrome instalado)
// - PW_CHANNEL  "chromium" -> chromium portable (Docker)
// - PW_HEADLESS "true"     -> modo headless (Docker)
const rawChannel = process.env.PW_CHANNEL;
const channel = rawChannel === undefined ? 'chrome' : rawChannel === 'chromium' ? undefined : rawChannel;

module.exports = defineConfig({
  testDir: './tests',       // Pruebas en la carpeta tests/
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  reporter: 'html',
  use: {
    headless: process.env.PW_HEADLESS === 'true',
    // Escritorio ancho (1440): con fullPage:true los pantallazos ya no quedan
    // como tiras estrechas "de celular" (antes: viewport 1280).
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    channel,
    screenshot: 'only-on-failure',     // Captura de pantalla automática al fallar
    trace: 'retain-on-failure',        // Traza de red/consola en caso de fallo
  },
  outputDir: './test-results',         // Screenshots y trazas de fallos
  projects: [
    {
      name: 'chromium',
      use: {},
    },
  ],
});