/**
 * scripts/auth.js — Login por API (estilo Postman) para sitios con auth.
 *
 * Estrategia en 3 capas (robusta ante sitios protegidos por Cloudflare):
 *
 *   Capa 1 — Liberar el reto anti-bot: se visita el origen en el NAVEGADOR
 *            real (Chrome) para que pase el desafío de Cloudflare y deje su
 *            cookie (cf_clearance/__cf_bm) en el contexto compartido.
 *
 *   Capa 2 — Login dentro de la página (page.evaluate + fetch): la petición
 *            se ejecuta DENTRO del navegador (mismo fingerprint/TLS que ya
 *            pasó el reto). NextAuth: GET /api/auth/csrf -> token, luego
 *            POST al callback con form-urlencoded { csrfToken, username,
 *            password, json: 'true' }. Las cookies de sesión quedan en el
 *            contexto => el page.goto() siguiente inicia logueado.
 *
 *   Capa 3 — Fallback visual: si la API sigue fallando, se rellena el
 *            formulario de login visible y se envía como un usuario real.
 *
 * Siempre imprime status + body del error para debug (consola / reports/run.log).
 */

// Rellena el formulario de login visible (fallback visual).
async function visualLogin(page, loginUrl, username, password) {
  console.log(`[Auth] Fallback visual: navegando a ${loginUrl}`);
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const form = page.locator('form').first();
    const pw = form.locator('input[type="password"]');
    const user = form.locator('input[type="email"], input[type="text"], input:not([type])').first();

    if ((await pw.count()) === 0) {
      console.log('[Auth] Fallback visual: no hay input de contraseña visible, se omite.');
      return false;
    }
    await user.fill(username).catch(() => {});
    await pw.fill(password);
    await page.waitForTimeout(300);

    const submit = form.locator('button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Ingresar"), button:has-text("Login"), button:has-text("Acceder")').first();
    if ((await submit.count()) > 0) {
      await submit.click().catch(() => {});
    } else {
      await pw.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(3000);
    console.log('[Auth] Fallback visual: formulario enviado. Cargando siguiente paso...');
    return true;
  } catch (err) {
    console.log(`[Auth] Fallback visual falló: ${err.message}`);
    return false;
  }
}

async function apiLogin(page, context, entry) {
  const { auth } = entry;
  const { loginUrl, username, password } = auth;
  const origin = new URL(loginUrl).origin;

  // --- Capa 1: pasar el reto de Cloudflare en el navegador real ---
  console.log(`[Auth] Visitando ${origin} para pasar el reto anti-bot (Cloudflare)...`);
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000); // margen para resolver "Just a moment..."
  } catch (err) {
    console.log(`[Auth] No se pudo cargar ${origin} (se continúa): ${err.message}`);
  }

  // --- Capa 2: login dentro de la página (estilo Postman, in-browser) ---
  console.log(`[Auth] Login por API (in-browser / Postman) en: ${loginUrl}`);
  let result;
  try {
    result = await page.evaluate(async ({ loginUrl, username, password }) => {
      const csrfUrl = new URL('/api/auth/csrf', loginUrl).href;

      // NextAuth: obtener token CSRF primero (misma cookie jar del navegador).
      let csrfToken = '';
      try {
        const csrfRes = await fetch(csrfUrl, { credentials: 'include' });
        if (csrfRes.ok) {
          const data = await csrfRes.json().catch(() => ({}));
          csrfToken = data.csrfToken || '';
        }
      } catch { /* sigue sin token */ }

      const res = await fetch(loginUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrfToken, username, password, json: 'true' }).toString(),
      });

      let bodyText = '';
      let isCloudflare = false;
      try {
        bodyText = (await res.text()).slice(0, 300);
        isCloudflare = /just a moment|cf-browser-verification|challenge/i.test(bodyText);
      } catch { /* sin body */ }

      return { status: res.status, body: bodyText, csrf: csrfToken ? 'obtenido' : 'no disponible', isCloudflare };
    }, { loginUrl, username, password });
  } catch (err) {
    console.log(`[Auth] Login por API falló al evaluar: ${err.message}`);
    result = { status: 0, body: err.message, csrf: 'n/a', isCloudflare: false };
  }

  console.log(`[Auth] CSRF: ${result.csrf} | Login HTTP ${result.status}: ${result.body || '(sin body)'}`);
  if (result.isCloudflare) {
    console.log('[Auth] El servidor respondió reto de Cloudflare. Reintentando con más margen...');
  }

  // 200 (JSON ok) o 302 (redirect de NextAuth) = credenciales válidas.
  if (result.status === 200 || result.status === 302) {
    console.log('[Auth] Login OK. Sesión iniciada en el contexto del navegador.');
    return true;
  }

  // --- Capa 3: fallback visual con el formulario real ---
  return await visualLogin(page, loginUrl, username, password);
}

module.exports = { apiLogin };