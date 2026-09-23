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


// Rellena el formulario de login visible (fallback visual generalizado).
async function visualLogin(page, loginUrl, username, password) {
  console.log(`[Auth] Fallback visual: analizando ruta de acceso para ${loginUrl}`);
  try {
    // Si la URL apunta a un endpoint de API (/api/, /api-system/, etc.), buscamos la interfaz gráfica en la raíz
    let targetUrl = loginUrl;
    if (loginUrl.includes('/api/') || loginUrl.includes('/api-system/')) {
      targetUrl = new URL(loginUrl).origin;
      console.log(`[Auth Visual] Detectada URL de API. Redirigiendo a interfaz gráfica de usuario en: ${targetUrl}`);
    }

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000); // Dar margen a que cargue el frontend (React/Vue/Astro)

    // Estrategia de búsqueda de formulario flexible y agnóstica
    let form = page.locator("form").first();
    let pw = form.locator('input[type="password"]');
    
    // Si no está dentro de una etiqueta <form>, buscar en todo el DOM del sitio
    if ((await pw.count()) === 0) {
      pw = page.locator('input[type="password"]').first();
    }

    let user = page.locator('input[type="email"], input[type="text"], input[name="username"], input[name="email"]').first();

    // Si sigue sin haber campos, intentamos una recarga limpia en la raíz por si acaso
    if ((await pw.count()) === 0) {
      console.log("[Auth Visual] No se detectó formulario en la ruta inicial. Probando navegación forzada a la raíz...");
      await page.goto(new URL(loginUrl).origin, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
      pw = page.locator('input[type="password"]').first();
      user = page.locator('input[type="email"], input[type="text"], input[name="username"], input[name="email"]').first();
    }

    if ((await pw.count()) === 0) {
      console.log("[Auth Visual] Fallo crítico: No existe ningún input de contraseña en la interfaz renderizada.");
      return false;
    }

    // Rellenar campos emulando teclado humano para burlar blindajes
    await user.click().catch(() => {});
    await user.fill(username);
    await page.waitForTimeout(200);
    
    await pw.click().catch(() => {});
    await pw.fill(password);
    await page.waitForTimeout(300);

    // Buscar botones con nombres universales en inglés y español
    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Ingresar"), button:has-text("Login"), button:has-text("Acceder"), button:has-text("Sign in")').first();
    
    if ((await submit.count()) > 0 && await submit.isVisible()) {
      await submit.click().catch(() => {});
    } else {
      await pw.press("Enter").catch(() => {});
    }
    
    await page.waitForTimeout(4000); // Esperar que procese la redirección del login exitoso
    
    // Validar si logramos salir de la pantalla de login comprobando que la URL cambió
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('auth/')) {
      console.log(`[Auth Visual] Advertencia: La URL sigue siendo de login (${currentUrl}). Posibles credenciales erróneas.`);
      return false;
    }

    console.log("[Auth Visual] Login visual completado con éxito.");
    return true;
  } catch (err) {
    console.log(`[Auth] Fallback visual falló por excepción: ${err.message}`);
    return false;
  }
}


async function apiLogin(page, context, entry) {
  const { auth } = entry;
  const { loginUrl, username, password } = auth;
  const origin = new URL(loginUrl).origin;

  // --- Capa 1: pasar el reto de Cloudflare en el navegador real ---
  console.log(
    `[Auth] Visitando ${origin} para pasar el reto anti-bot (Cloudflare)...`,
  );
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000); // margen para resolver "Just a moment..."
  } catch (err) {
    console.log(
      `[Auth] No se pudo cargar ${origin} (se continúa): ${err.message}`,
    );
  }

    // --- Capa 2: login dentro de la página (estilo Postman, in-browser) ---
  console.log(`[Auth] Login por API (in-browser / Postman) en: ${loginUrl}`);
  let result;
  try {
    result = await page.evaluate(
      async ({ loginUrl, username, password }) => {
        const csrfUrl = new URL("/api/auth/csrf", loginUrl).href;

        // 1. Obtener token CSRF opcional (para ecosistemas NextAuth)
        let csrfToken = "";
        try {
          const csrfRes = await fetch(csrfUrl, { credentials: "include" });
          if (csrfRes.ok) {
            const data = await csrfRes.json().catch(() => ({}));
            csrfToken = data.csrfToken || "";
          }
        } catch {}

        // 2. Preparar el lote de payloads según distintas arquitecturas de backend
        const payloadNextAuthForm = new URLSearchParams({ csrfToken, username, password, json: "true" }).toString();
        const payloadFastApiForm = new URLSearchParams({ username, password }).toString(); // Estilo OAuth2 puro de Python
        const payloadJsonStandard = JSON.stringify({ username, password });
        const payloadJsonEmail = JSON.stringify({ email: username, password });

        // 3. Intento 1: Formulario NextAuth Tradicional
        let res = await fetch(loginUrl, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: payloadNextAuthForm,
        });

        let bodyText = "";
        try { bodyText = await res.text(); } catch {}
        let strategyUsed = "NextAuth Form";

        // 4. Cascada adaptativa si el servidor responde con errores de validación (422 o 400)
        const isValidationError = res.status === 422 || res.status === 400 || bodyText.includes("model_attributes_type") || bodyText.includes("valid dictionary");

        if (isValidationError) {
          // Intento 2: Formulario Limpio (Bypass estricto para FastAPI / Python OAuth2)
          strategyUsed = "FastAPI / OAuth2 Clean Form";
          res = await fetch(loginUrl, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: payloadFastApiForm,
          });
          try { bodyText = await res.text(); } catch {}

          // Intento 3: JSON Estándar (Para APIs convencionales de Node/Express/Go)
          if (res.status === 422 || res.status === 400) {
            strategyUsed = "JSON (username/password)";
            res = await fetch(loginUrl, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json", "Accept": "application/json" },
              body: payloadJsonStandard,
            });
            try { bodyText = await res.text(); } catch {}
          }

          // Intento 4: JSON Mutado (Sustituyendo llave a email para NestJS/Laravel)
          if (res.status === 422 || res.status === 400) {
            strategyUsed = "JSON (email/password)";
            res = await fetch(loginUrl, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json", "Accept": "application/json" },
              body: payloadJsonEmail,
            });
            try { bodyText = await res.text(); } catch {}
          }
        }

        // 5. Persistir el token en localStorage (SPAs React/Vue con auth por token).
        //    Muchas apps frontend guardan el token y luego deciden si muestran el
        //    sidebar/logged-in; sin esto el crawler se quedaba en el login sin enlaces.
        let tokenSaved = false;
        if (res.ok) {
          try {
            const parsed = JSON.parse(bodyText);
            const tokenCandidates = ["token", "access_token", "jwt", "auth_token", "authToken", "session_token", "id_token"];
            const tokenKey = tokenCandidates.find((k) => parsed && typeof parsed[k] === "string");
            if (tokenKey) {
              const value = parsed[tokenKey];
              tokenCandidates.forEach((k) => { try { localStorage.setItem(k, value); } catch {} });
              try { sessionStorage.setItem(tokenKey, value); } catch {}
              try { localStorage.setItem("user", JSON.stringify(parsed)); } catch {}
              tokenSaved = true;
            }
          } catch {}
        }

        const isCloudflare = /just a moment|cf-browser-verification|challenge/i.test(bodyText);
        return {
          status: res.status,
          body: bodyText.slice(0, 300),
          csrf: csrfToken ? "obtenido" : "no disponible",
          isCloudflare,
          strategyUsed,
          tokenSaved
        };
      },
      { loginUrl, username, password },
    );
  } catch (err) {
    console.log(`[Auth] Login por API falló al evaluar: ${err.message}`);
    result = { status: 0, body: err.message, csrf: "n/a", isCloudflare: false, strategyUsed: "Ninguna", tokenSaved: false };
  }

  console.log(`[Auth] Estrategia final utilizada en el motor: ${result.strategyUsed}`);
  console.log(`[Auth] CSRF: ${result.csrf} | Login HTTP ${result.status}: ${result.body || "(sin body)"}`);

  // --- Capa 3: fallback visual con el formulario real ---
  const visualOk = await visualLogin(page, loginUrl, username, password);
  return { ok: visualOk, tokenSaved: result.tokenSaved, status: result.status, strategyUsed: result.strategyUsed };
}

module.exports = { apiLogin };
