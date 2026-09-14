# E2E QA - Sistema de Auditoría Autónoma con Playwright

Suite de pruebas end-to-end construida con [Playwright Test](https://playwright.dev/) que audita de forma autónoma sitios web:

- **Exploración (crawler)**: recorre automáticamente los enlaces internos de cada dominio (hasta 5 páginas por dominio).
- **Almacenamiento en caché**: intercepta las respuestas de red para validar las directivas `Cache-Control`.
- **Memoria RAM**: mide el uso real del heap de JavaScript (`performance.memory.usedJSHeapSize`) y lo mantiene bajo 150 MB.
- **Resiliencia**: tolera URLs rotas o inválidas en el HTML sin detener la auditoría.

## Requisitos

- Node.js 18+
- Google Chrome instalado (por defecto el proyecto usa el canal `chrome`)

## Instalación

```bash
npm install
```

## Ejecutar las auditorías

```bash
npx playwright test
```

El reporte HTML se genera en `playwright-report/` tras la ejecución.

## Configuración

- **`urls.json`**: lista de URLs base a auditar (agrega o quita dominios aquí).
- **`playwright.config.js`**: configuración global (navegador, viewport, timeouts, reporter).

## Estructura

```
├── example.spec.js         # Script de auditoría E2E
├── playwright.config.js    # Configuración de Playwright
├── urls.json               # URLs a auditar
└── package.json
```