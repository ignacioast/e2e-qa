# E2E QA - Sistema de Auditoría Autónoma con Playwright

Suite de pruebas end-to-end construida con [Playwright Test](https://playwright.dev/) que audita de forma autónoma sitios web y los somete a **carga masiva con Apache JMeter**.

## Funcionalidades

- **Exploración (crawler)**: recorre automáticamente los enlaces internos de cada dominio (hasta 5 páginas por dominio).
- **Almacenamiento en caché**: intercepta las respuestas de red para validar las directivas `Cache-Control`.
- **Memoria RAM**: mide el uso real del heap de JavaScript (`performance.memory.usedJSHeapSize`) y lo mantiene bajo 150 MB.
- **Carga masiva**: genera estrés concurrente con JMeter (50 usuarios / 10 s ramp-up / 60 s duración).
- **Capturas y trazas**: screenshot + trace automáticos en caso de fallo (`test-results/`).

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
| `npm run test:e2e` | Solo Playwright (sin carga) |
| `npm run test:stress` | JMeter + Playwright orquestados por `scripts/runner.js` |
| `npm run test:stress:ui` | Modo UI de Playwright |
| `npm run test:stress:docker` | Todo dentro de Docker (sin instalar JMeter/Chrome) |

### Docker

```bash
npm run test:stress:docker
```
Levanta JMeter + Playwright en un contenedor (headless). Los resultados quedan en `playwright-report/`, `test-results/` y `jmeter/results/`.

## Estructura del proyecto

```
├── tests/
│   └── example.spec.js        # Script de auditoría E2E
├── data/
│   └── urls.json              # URLs base a auditar
├── scripts/
│   └── runner.js              # Orquestador JMeter + Playwright
├── jmeter/
│   ├── carga_ast.jmx          # Plan de carga (50 usuarios, 60 s)
│   └── results/               # Resultados .jtl (generados)
├── playwright.config.js       # Configuración global
├── Dockerfile / docker-compose.yml
└── package.json
```

## Reportes

- **HTML**: `playwright-report/` (ver con `npx playwright show-report`)
- **JMeter JTL**: `jmeter/results/carga_ast.jtl` (abrir en el Listener de JMeter)
- **Capturas y trazas de fallos**: `test-results/`