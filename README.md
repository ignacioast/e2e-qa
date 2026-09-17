# E2E QA

Auditoría autónoma de sitios web con Playwright + carga masiva con JMeter.

## Instalacion (1 vez)

```powershell
npm install
```

## Configurar JMeter (1 vez, Windows)

```powershell
[Environment]::SetEnvironmentVariable("JMETER_HOME", "C:\tu\ruta\apache-jmeter-5.6.3", "User")
```

Abre una terminal nueva.

## Agregar sitios a auditar

Edita `data/urls.json` y agrega las URLs (una por linea). Cada dominio se audita
y aparece en el dashboard con su propio reporte.

## Comandos

| Comando | Que hace |
|---|---|
| `npm run test:stress` | Auditoria + estres completo, abre el dashboard al terminar |
| `npm run test:e2e` | Solo Playwright (sin carga) |
| `npm run test:stress:ui` | Modo UI de Playwright (ver analisis en vivo) |
| `npm run dashboard` | Abre la web local `http://localhost:3000` |
| `npm run dashboard:lan` | Dashboard visible para la red local (LAN) |
| `npm run dashboard:local` | Dashboard solo local (detras de nginx) |
| `npm run test:stress:docker` | Todo en Docker |

## Automatizacion (GitHub Actions)

- Automatico: diario 09:00 UTC.
- Manual: Actions > E2E Stress Nightly > Run workflow.
- Artefactos descargables: `reports/`, `playwright-report/`, `test-results/`.

## Exponer a la red

- LAN: `npm run dashboard:lan` (usa la IP que imprime).
- Internet con nginx: config en `deploy/nginx-dashboard.conf`.