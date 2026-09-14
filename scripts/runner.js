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

  console.log('[Runner] Iniciando JMeter en modo Non-GUI...');
  console.log(`[Runner] Plan de carga: ${JMETER_PLAN}`);
  console.log(`[Runner] Resultados  : ${RESULT_FILE}`);

  const child = spawnSafe(target.bin, ['-n', '-t', JMETER_PLAN, '-l', RESULT_FILE, '-j', JMETER_LOG_FILE], {
    stdio: 'inherit',
  });

  // Si JMeter termina antes de que pidamos el cierre, es un fallo de arranque.
  child.on('exit', (code) => {
    if (!child.stopRequested) {
      console.error(`[Runner] ERROR: JMeter terminó prematuramente (código ${code}). Revisa el plan o la instalación.`);
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
function runPlaywright() {
  return new Promise((resolve, reject) => {
    console.log('[Runner] Ejecutando suite Playwright (npx playwright test)...');
    const exe = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawnSafe(exe, ['playwright', 'test'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    child.on('error', (err) => reject(new Error(`No se pudo ejecutar Playwright: ${err.message}`)));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** Detiene JMeter de forma limpia y da margen para que escriba el .jtl */
async function stopJmeter(child) {
  if (!child) return;
  if (child.exitCode !== null) {
    console.log('[Runner] JMeter ya había finalizado.');
    return;
  }
  child.stopRequested = true;
  child.kill();
  console.log('[Runner] Señal de detención enviada a JMeter.');
  await sleep(3000);
}

async function main() {
  let jmeter;

  const onInterrupt = async () => {
    console.log('\n[Runner] Interrupción recibida, deteniendo JMeter...');
    await stopJmeter(jmeter);
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  try {
    jmeter = await startJmeter();

    console.log(`[Runner] Dando ${LOAD_SETTLE_TIME_MS / 1000} s para que la carga se establezca...`);
    await sleep(LOAD_SETTLE_TIME_MS);

    const exitCode = await runPlaywright();

    console.log(`[Runner] Playwright finalizó con código ${exitCode}. Deteniendo JMeter...`);
    await stopJmeter(jmeter);

    console.log('[Runner] Estrés finalizado.');
    console.log(`[Runner] JTL   : ${RESULT_FILE}`);
    console.log('[Runner] Reporte HTML: playwright-report/');
    process.exit(exitCode);
  } catch (err) {
    console.error(err.message);
    await stopJmeter(jmeter);
    process.exit(1);
  }
}

main();