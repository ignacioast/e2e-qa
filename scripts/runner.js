/**
 * scripts/runner.js — Orquestador de estrés E2E (JMeter + Playwright)
 *
 * Flujo:
 *  1. Valida que JMeter esté disponible (JMETER_HOME o PATH).
 *  2. Levanta JMeter en modo CLI (Non-GUI) con el plan jmeter/carga_ast.jmx.
 *  3. Espera 10 segundos para que la carga se establezca sobre el servidor.
 *  4. Ejecuta la suite nativa de Playwright (npx playwright test).
 *  5. Al terminar Playwright, detiene JMeter limpiamente.
 *
 * Uso:
 *  npm run test:stress
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { siteKey } = require('./site.js');

const PROJECT_ROOT = path.join(__dirname, '..');
const JMETER_DIR = path.join(PROJECT_ROOT, 'jmeter');
const RESULTS_DIR = path.join(JMETER_DIR, 'results');

const JMETER_PLAN = path.join(JMETER_DIR, 'carga_ast.jmx');
const RESULT_FILE = path.join(RESULTS_DIR, 'carga_ast.jtl');
const JMETER_LOG_FILE = path.join(JMETER_DIR, 'jmeter.log');

const LOAD_SETTLE_TIME_MS = 10000; // 10 s de carga previa antes de arrancar Playwright

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resuelve el binario de JMeter:
 *  - Prioriza env.JMETER_HOME (ej. C:\jmeter\apache-jmeter-5.6.3).
 *  - Si no, asume el comando `jmeter` está en el PATH.
 */
function resolveJmeterBinary() {
  if (process.env.JMETER_HOME) {
    const isWin = process.platform === 'win32';
    return { bin: path.join(process.env.JMETER_HOME, 'bin', isWin ? 'jmeter.bat' : 'jmeter'), auto: false };
  }
  return { bin: 'jmeter', auto: true };
}

/**
 * Verifica que JMeter realmente exista. Devuelve true si está disponible.
 */
function isJmeterAvailable({ bin, auto }) {
  if (!auto && fs.existsSync(bin)) return true; // Ruta explícita de JMETER_HOME
  if (auto) {
    // JMeter en PATH: confirma con `where`/`which`
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [bin]);
    return new Promise((resolve) => {
      probe.on('error', () => resolve(false));
      probe.on('exit', (code) => resolve(code === 0));
    });
  }
  return false;
}

/** Mensaje de ayuda imprime al usuario cuándo falta JMeter */
function jmeterNotFoundMessage() {
  const isWin = process.platform === 'win32';
  return [
    '[Runner] ERROR: No se encontró JMeter.',
    '',
    '  1. Descarga e instala Apache JMeter 5.6.3:  https://jmeter.apache.org/download_jmeter.cgi',
    `  2. ${isWin
      ? 'Ejecuta:  [Environment]::SetEnvironmentVariable("JMETER_HOME", "C:\\jmeter\\apache-jmeter-5.6.3", "User")'
      : 'Exporta:  export JMETER_HOME=/opt/apache-jmeter-5.6.3'}  (o agrega JMeter al PATH)`,
    '  3. Abre una terminal NUEVA y vuelve a correr  npm run test:stress',
  ].join('\n');
}

/**
 * Ejecuta un comando escapando correctamente las rutas (Compatible Windows/Unix).
 * Construye la línea de comando completa como string y la pasa a shell:true,
 * evitando el warning DEP0190 (args concatenados) y sin romper rutas con espacios ("E2E QA").
 */
function spawnSafe(exe, args, options = {}) {
  // Ruta con espacios entre comillas dobles.
  const cmdLine = [exe, ...args].map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');

  return spawn(cmdLine, {
    ...options,
    shell: true,   // Windows: cmd.exe /d /s /c "..."; Unix: /bin/sh -c "..."
  });
}

/**
 * Inicia JMeter en modo Non-GUI.
 * Devuelve el proceso hijo cuando el arranque se considera exitoso.
 */
async function startJmeter() {
  const target = resolveJmeterBinary();

  if (!(await isJmeterAvailable(target))) {
    throw new Error(jmeterNotFoundMessage());
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Limpia resultados de corridas anteriores: JMeter hace append al .jtl, así que
  // sin borrar se acumularían peticiones viejas y el reporte saldría inflado.
  // El archivo puede estar bloqueado por un JMeter anterior (EBUSY): reintenta.
  for (const f of [RESULT_FILE, JMETER_LOG_FILE]) {
    if (!fs.existsSync(f)) continue;
    let cleared = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        fs.unlinkSync(f);
        cleared = true;
        break;
      } catch (err) {
        if (attempt === 5) {
          throw new Error(
            `[Runner] No se pudo borrar ${f}: ${err.message}. ` +
            'Una instancia de JMeter aún tiene el archivo abierto. ' +
            'Ciérrala (taskkill /F /IM java.exe) y vuelve a correr el test.'
          );
        }
        console.log(`[Runner] Archivo en uso (${f}), reintentando en 1 s... (intento ${attempt}/5)`);
        await sleep(1000);
      }
    }
  }

  console.log('[Runner] Iniciando JMeter en modo Non-GUI...');
  console.log(`[Runner] Plan de carga: ${JMETER_PLAN}`);
  console.log(`[Runner] Resultados  : ${RESULT_FILE}`);

  const child = spawnSafe(target.bin, ['-n', '-t', JMETER_PLAN, '-l', RESULT_FILE, '-j', JMETER_LOG_FILE], {
    stdio: 'inherit',
  });

  // Si JMeter termina antes de que pidamos el cierre, es un fallo de arranque.
  child.on('exit', (code) => {
    if (!child.stopRequested && code !== 0) {
      console.error(`[Runner] ERROR: JMeter terminó con error (código ${code}). Revisa el plan o la instalación.`);
      process.exitCode = 1;
    }
  });

  await sleep(3000);
  return child;
}

/**
 * Ejecuta la suite nativa de Playwright desde la raíz del proyecto.
 * Resuelve con el código de salida de Playwright.
 */
function runPlaywright(runSite) {
  return new Promise((resolve, reject) => {
    console.log('[Runner] Ejecutando suite Playwright (npx playwright test)...');
    const exe = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const env = { ...process.env };
    if (runSite) {
      // Filtra la suite a un solo sitio (data/urls.json) pasando su siteKey.
      env.TEST_SITE = runSite;
    }
    const child = spawnSafe(exe, ['playwright', 'test'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env,
    });

    child.on('error', (err) => reject(new Error(`No se pudo ejecutar Playwright: ${err.message}`)));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Analiza el JTL generado por JMeter y responde:
 *  - Cuántas peticiones se hicieron y cuántas fallaron (%).
 *  - En qué usuario(n) concreto se rompió la página (threadName = usuario JMeter).
 *  - Latencia promedio / máxima.
 * Genera reports/jmeter/<siteKey>.json (consumido por la web local).
 * El sitio se deriva del dominio del plan JMX (carga_ast.jmx -> ast).
 */
async function analyzeJtl() {
  // El dominio del plan JMX define a qué sitio corresponden estos resultados.
  const plan = fs.readFileSync(JMETER_PLAN, 'utf-8');
  const udvMatch = plan.match(/Argument\.value">([^<]+)<\/stringProp>/g) || [];
  const domain = udvMatch[1] ? udvMatch[1].replace(/.*Argument\.value">|<\/stringProp>/g, '') : 'ast.cl';
  const jmeterSiteKey = siteKey(`https://${domain}`);

  const outDir = path.join(PROJECT_ROOT, 'reports', 'jmeter');
  const outFile = path.join(outDir, `${jmeterSiteKey}.json`);

  if (!fs.existsSync(RESULT_FILE)) {
    console.error('[Runner] No se encontró el JTL para analizar.');
    return;
  }

  const lines = fs.readFileSync(RESULT_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    console.error('[Runner] El JTL está vacío.');
    return;
  }

  const headers = lines[0].split(',');
  const idx = {
    thread: headers.indexOf('threadName'),
    success: headers.indexOf('success'),
    elapsed: headers.indexOf('elapsed'),
    label: headers.indexOf('label'),
    code: headers.indexOf('responseCode'),
  };
  if (idx.thread === -1 || idx.success === -1) {
    console.error('[Runner] Formato de JTL inesperado. No se pudo analizar.');
    return;
  }

  const parseCsvLine = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };

  let total = 0;
  let errors = 0;
  let sumElapsed = 0;
  let maxElapsed = 0;
  let firstError = null;
  const byThread = {};     // usuario -> {ok, err, latencies[]}
  const errorCodes = {};

  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const thread = c[idx.thread] || '';
    // Las filas sin threadName son líneas auxiliares de la aserción de JMeter ("****** received", etc.):
    // no son peticiones reales, se omiten para no inflar las métricas.
    if (!thread || !c[idx.success]) continue;

    const ok = c[idx.success].trim() === 'true';
    const elapsed = parseInt(c[idx.elapsed], 10) || 0;

    total++;
    sumElapsed += elapsed;
    maxElapsed = Math.max(maxElapsed, elapsed);

    if (!byThread[thread]) byThread[thread] = { ok: 0, err: 0, latencies: [] };
    byThread[thread].latencies.push(elapsed);

    if (ok) byThread[thread].ok++;
    else {
      byThread[thread].err++;
      errors++;
      if (!firstError) firstError = { thread, code: c[idx.code], label: c[idx.label] };
      const code = c[idx.code] || '?';
      errorCodes[code] = (errorCodes[code] || 0) + 1;
    }
  }

  // Usuarios con fallos
  const userErrors = Object.entries(byThread)
    .filter(([, s]) => s.err > 0)
    .map(([thread, s]) => ({ usuario: thread, errores: s.err, peticiones: s.ok + s.err, ok: s.ok }))
    .sort((a, b) => b.errores - a.errores);

  const avgElapsed = total ? (sumElapsed / total) : 0;

  const resumen = {
    fecha: new Date().toISOString(),
    totalPeticiones: total,
    errores: errors,
    porcentajeError: total ? +((errors / total) * 100).toFixed(2) : 0,
    latenciaPromedioMs: Math.round(avgElapsed),
    latenciaMaximaMs: maxElapsed,
    primerError: firstError,
    usuariosConErrores: userErrors,
    totalUsuarios: Object.keys(byThread).length,
    codigosError: errorCodes,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(resumen, null, 2));

  console.log('\n===== REPORTE JMETER (STRESS) =====');
  console.log(`[JMeter] Peticiones totales : ${total}`);
  console.log(`[JMeter] Usuarios simulados : ${Object.keys(byThread).length}`);
  console.log(`[JMeter] Errores            : ${errors} (${resumen.porcentajeError}%)`);
  console.log(`[JMeter] Latencia promedio  : ${resumen.latenciaPromedioMs} ms | máxima ${maxElapsed} ms`);

  if (userErrors.length) {
    console.log('\n[JMeter] ------  La página se rompió en estos usuarios:');
    for (const u of userErrors) {
      console.log(`  · ${u.usuario} → ${u.errores} errores de ${u.peticiones} peticiones`);
    }
    if (firstError) {
      console.log(`\n[JMeter] Primer fallo registrado: usuario ${firstError.thread}, código ${firstError.code}, label "${firstError.label}"`);
    }
  } else {
    console.log('\n[JMeter] ✅ Sin errores: ninguna página se rompió bajo carga.');
  }
}

/**
 * Abre la web local del dashboard al terminar el estrés (solo en uso local).
 * En CI (GitHub Actions) se omite para no colgar/abrir navegador sin sentido.
 */
async function openDashboard(runSite) {
  if (process.env.CI) {
    console.log('[Runner] Entorno CI detectado, saltando apertura del dashboard.');
    return;
  }

  const port = process.env.PORT || 3000;
  const url = runSite
    ? `http://localhost:${port}/?site=${encodeURIComponent(runSite)}`
    : `http://localhost:${port}`;
  const dashboardScript = path.join(__dirname, 'dashboard.js');

  const dashCmd = `"${process.execPath}" "${dashboardScript}"`;
  const dash = spawn(dashCmd, {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
    detached: true,
    shell: true,
  });
  dash.unref();

  await sleep(1500);
  console.log(`[Runner] Abriendo dashboard local: ${url}`);

  const isWin = process.platform === 'win32';
  const openCmd = isWin
    ? `cmd /c start "" "${url}"`
    : `xdg-open "${url}"`;

  spawn(openCmd, { shell: true, stdio: 'ignore', detached: true }).unref();
}

/** Detiene JMeter de forma limpia y da margen para que escriba el .jtl */
async function killProcessTree(child) {
  const isWin = process.platform === 'win32';
  if (isWin) {
    // taskkill /T mata el árbol completo (cmd -> jmeter.bat -> java).
    // child.kill() solo mata el shell y dejaría el JVM corriendo con el .jtl bloqueado (EBUSY).
    const killTree = spawnSafe('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise((resolve) => {
      killTree.on('exit', resolve);
      killTree.on('error', resolve);
      setTimeout(resolve, 5000);
    });
    child.kill();
  } else {
    child.kill('SIGTERM');
  }
  await sleep(2000);
}

async function stopJmeter(child) {
  if (!child) return;
  if (child.exitCode !== null) {
    console.log('[Runner] JMeter ya había finalizado.');
    return;
  }
  child.stopRequested = true;
  console.log('[Runner] Deteniendo JMeter (todos sus procesos)...');
  await killProcessTree(child);
  await sleep(3000);
}

async function main() {
  let jmeter;
  let ranJmeter = true;

  // --site=<key> : solo audita (y estresa, si aplica) ese sitio.
  const runSiteArg = process.argv.find((a) => a.startsWith('--site='));
  const runSite = runSiteArg ? runSiteArg.split('=')[1] : null;

  // Valida que el sitio pedido esté en data/urls.json
  if (runSite) {
    const urlsPath = path.join(PROJECT_ROOT, 'data', 'urls.json');
    const urls = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));
    const known = new Set(urls.map((u) => siteKey(u)));
    if (!known.has(runSite)) {
      console.error(`[Runner] ERROR: el sitio "${runSite}" no está en data/urls.json.`);
      console.error(`Sitios conocidos: ${[...known].join(', ')}`);
      process.exit(1);
    }
  }

  const onInterrupt = async () => {
    console.log('\n[Runner] Interrupción recibida, deteniendo JMeter...');
    await stopJmeter(jmeter);
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  try {
    // El estrés JMeter solo corresponde al dominio del plan (ast.cl).
    // Si pedimos otro sitio, Playwright audita solo ese y no se corre JMeter.
    const jmeterSiteKey = (() => {
      const plan = fs.readFileSync(JMETER_PLAN, 'utf-8');
      const udvMatch = plan.match(/Argument\.value">([^<]+)<\/stringProp>/g) || [];
      const domain = udvMatch[1] ? udvMatch[1].replace(/.*Argument\.value">|<\/stringProp>/g, '') : 'ast.cl';
      return siteKey(`https://${domain}`);
    })();

    if (runSite && runSite !== jmeterSiteKey) {
      console.log(`[Runner] Solo se auditará el sitio "${runSite}" (sin estrés JMeter, que apunta a "${jmeterSiteKey}").`);
      ranJmeter = false;
    }

    if (ranJmeter) {
      jmeter = await startJmeter();

      console.log(`[Runner] Dando ${LOAD_SETTLE_TIME_MS / 1000} s para que la carga se establezca...`);
      await sleep(LOAD_SETTLE_TIME_MS);
    }

    const exitCode = await runPlaywright(runSite);

    if (ranJmeter) {
      console.log(`[Runner] Playwright finalizó con código ${exitCode}. Deteniendo JMeter...`);
      await stopJmeter(jmeter);

      console.log('[Runner] Estrés finalizado.');
      console.log('[Runner] Reporte HTML: playwright-report/');

      await analyzeJtl();
    } else {
      console.log('[Runner] Auditoría finalizada (sin estrés JMeter).');
    }

    await openDashboard(runSite);

    process.exit(exitCode);
  } catch (err) {
    console.error(err.message);
    await stopJmeter(jmeter);
    process.exit(1);
  }
}

main();