# E2E QA - Sistema de Auditoría Autónoma con Playwright

Suite de pruebas end-to-end construida con [Playwright Test](https://playwright.dev/) que audita de forma autónoma sitios web y los somete a **carga masiva con Apache JMeter**.

## Funcionalidades

- **Exploración (crawler)**: audita **todos** los enlaces internos detectados de cada dominio, **una sola pasada** (sin recursión → sin dar vueltas en círculos).
- **Auditoría profunda por página**: tiempo de carga (ms), memoria heap JS, `Cache-Control`, `<title>`, `<h1>`, imágenes sin `alt`, errores de consola y respuestas 4xx/5xx.
- **Pantallazos**: uno por página (`reports/screenshots/`) y una carpeta `errors/` con los pantallazos de las páginas que fallan.
- **Carga masiva**: estrés concurrente con JMeter (50 usuarios / 10 s ramp-up / 60 s duración).
- **Análisis de fallos bajo carga**: el runner lee el `.jtl` e informa **en qué usuario se rompió** la página, % de error y latencias.
- **Web local**: `npm run dashboard` abre `http://localhost:3000` con todo el resultado (tablas + pantallazos + reporte JMeter).

## Requisitos del equipo

1. **Node.js** 18+
2. **Google Chrome** instalado (para el modo local, canal `chrome`)
3. **Java 17+**
4. **Apache JMeter 5.6.3** — descarga desde https://jmeter.apache.org/download_jmeter.cgi

### Configurar JMeter (una sola vez)

Windows:
```powershell
[Environment]::SetEnvironmentVariable("JMETER_HOME", "C:\tu\ruta\apache-jmeter-5.6.3", "User")
```
Recuerda **abrir una terminal nueva** después de configurarlo.

## Instalación

```bash
npm install
```

## Ejecución

| Comando | Qué hace |
|---|---|
| `npm run test:stress` | JMeter + Playwright, genera reportes + pantallazos |
| `npm run test:e2e` | Solo Playwright (sin carga) |
| `npm run test:stress:ui` | Modo UI de Playwright (ver análisis en vivo) |
| `npm run dashboard` | Abre la web local en `http://localhost:3000` |
| `npm run test:stress:docker` | Todo dentro de Docker (sin instalar JMeter/Chrome) |

### Flujo recomendado

```bash
npm run test:stress    # 1. Auditoría + estrés
npm run dashboard      # 2. Ver todo en el navegador
```

### Docker

```bash
npm run test:stress:docker
```
Levanta JMeter + Playwright en un contenedor (headless).

## Estructura del proyecto

```
├── tests/
│   └── example.spec.js        # Auditoría E2E + pantallazos
├── data/
│   └── urls.json              # URLs base a auditar
├── scripts/
│   ├── runner.js              # Orquestador JMeter + Playwright + análisis JTL
│   └── dashboard.js           # Web local
├── jmeter/
│   ├── carga_ast.jmx          # Plan de carga (50 usuarios, 60 s)
│   └── results/               # Resultados .jtl (generados)
├── reports/                   # auditoria.json, jmeter_resumen.json, screenshots/
├── playwright.config.js       # Configuración global
├── Dockerfile / docker-compose.yml
└── package.json
```

## Reportes

- **Web local**: `npm run dashboard` → `http://localhost:3000`
- **JSON de auditoría**: `reports/auditoria.json`
- **JSON de estrés**: `reports/jmeter_resumen.json`
- **Pantallazos por página**: `reports/screenshots/` · fallos en `reports/screenshots/errors/`
- **HTML Playwright**: `playwright-report/` (ver con `npx playwright show-report`)
- **JMeter JTL**: `jmeter/results/carga_ast.jtl`
- **Trazas de fallos**: `test-results/`