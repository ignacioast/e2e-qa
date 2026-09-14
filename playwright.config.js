const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.', // Busca los archivos de prueba en la carpeta raíz
  timeout: 30000,
  expect: {
    timeout: 5000
  },
  reporter: 'html',
  use: {
    headless: false,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { 
        // Fuerza a Playwright a usar el Google Chrome 
        channel: 'chrome', 
      },
    },
  ],
});
