/* E2E QA Dashboard — frontend compacto (sin dependencias) */

const $ = (sel) => document.querySelector(sel);

let state = {
  sites: [],
  audit: {},
  jmeter: {},
  currentKey: null,
};

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function load() {
  const [authSites, auditMap, jmeterMap] = await Promise.all([
    fetchJSON('/api/sites'),
    fetchJSON('/api/auditoria'),
    fetchJSON('/api/jmeter'),
  ]);

  state.sites = Array.isArray(authSites) ? authSites : [];
  state.audit = auditMap && !auditMap.error ? auditMap : {};
  state.jmeter = jmeterMap && !jmeterMap.error ? jmeterMap : {};

  // Si hay una ejecución en curso, activar el polling.
  const status = await fetchJSON('/api/run/status');
  state.run = status || { running: false, site: null, startedAt: null, tail: '' };

  const requested = new URLSearchParams(location.search).get('site');
  const selected = state.sites.find((s) => s.key === requested) ? requested : null;

  fillSiteSelect();
  if (selected) renderDetail(selected);
  else renderHome();
}

/* ---------- Vista Inicio: selector de sitios ---------- */
function renderHome() {
  state.currentKey = null;
  $('#homeView').hidden = false;
  $('#addSitePanel').hidden = false;
  $('#detailView').hidden = true;
  $('#backHome').hidden = true;
  $('#siteSelect').hidden = true;

  const count = state.sites.length;
  $('#sitesCount').textContent = count ? `(${count} ${count === 1 ? 'sitio' : 'sitios'})` : '';

  if (!count) {
    $('#siteCards').innerHTML =
      '<div class="empty">No hay sitios configurados. Agrega URLs en <code>data/urls.json</code>.</div>';
    return;
  }

  $('#siteCards').innerHTML = state.sites.map((site) => {
    const a = state.audit[site.key];
    const j = state.jmeter[site.key];
    const hasAudit = !isEmpty(a);
    const hasJmeter = !isEmpty(j);
    const stamp = hasAudit
      ? (a.ejecutado || j?.fecha)
      : hasJmeter ? j.fecha : null;

    const cells = [];
    if (hasAudit) {
      cells.push('<div class="cell"><span class="cell-label">Páginas</span><span class="cell-value">' + a.totalPaginas + '</span></div>');
      cells.push('<div class="cell"><span class="cell-label">OK</span><span class="cell-value ok">' + a.ok + '</span></div>');
      cells.push('<div class="cell"><span class="cell-label">Fallidas</span><span class="cell-value ' + (a.fallidas > 0 ? 'bad' : '') + '">' + a.fallidas + '</span></div>');
    } else if (hasJmeter) {
      cells.push('<div class="cell"><span class="cell-label">Solo Test</span><span class="cell-value muted">sin auditoría</span></div>');
    } else {
      cells.push('<div class="cell"><span class="cell-label">Estado</span><span class="cell-value bad">sin datos</span></div>');
    }
    if (hasJmeter) {
      const pct = j.porcentajeError ?? 0;
      cells.push('<div class="cell"><span class="cell-label">Peticiones</span><span class="cell-value">' + j.totalPeticiones + '</span></div>');
      cells.push('<div class="cell"><span class="cell-label">Error</span><span class="cell-value ' + (pct > 0 ? 'bad' : 'ok') + '">' + pct + '%</span></div>');
    }

    const stampHtml = stamp
      ? '<div class="site-stamp">Última ejecución: ' + new Date(stamp).toLocaleString('es-CL') + '</div>'
      : '<div class="site-stamp">Sin ejecuciones aún</div>';

    const runBtn = state.run && state.run.running && state.run.site === site.key
      ? '<button class="btn btn-ghost btn-sm" disabled>Ejecutando…</button>'
      : '<button class="btn btn-ghost btn-sm" data-run="' + esc(site.key) + '">Ejecutar Test</button>';

    return '<div class="site-card" data-site="' + esc(site.key) + '">' +
      '<div class="site-title"><span class="site-dot"></span>' + esc(site.dominio) +
      (site.auth && site.auth.enabled ? '<span class="auth-badge" title="Inicia sesión por API antes de auditar">auth</span>' : '') +
      '</div>' +
      '<div class="site-url">' + esc(site.url) + '</div>' +
      '<div class="site-cells">' + cells.join('') + '</div>' +
      stampHtml +
      '<div class="site-actions">' + runBtn + '</div>' +
      '</div>';
  }).join('');
}

function fillSiteSelect() {
  const sel = $('#siteSelect');
  sel.innerHTML = state.sites.map((s) =>
    '<option value="' + esc(s.key) + '"' + (s.key === state.currentKey ? ' selected' : '') + '>' + esc(s.dominio) + '</option>'
  ).join('') || '<option value="">Sin sitios</option>';
}

/* ---------- Vista Detalle: reporte de un sitio ---------- */
function renderDetail(key) {
  state.currentKey = key;
  $('#homeView').hidden = true;
  $('#addSitePanel').hidden = true;
  $('#detailView').hidden = false;
  $('#backHome').hidden = false;
  $('#siteSelect').hidden = false;
  fillSiteSelect();

  const audit = state.audit[key] || null;
  const jmeter = state.jmeter[key] || null;

  const stamp = $('#stamp');
  const ts = audit?.ejecutado || jmeter?.fecha;
  stamp.textContent = ts
    ? 'Última ejecución: ' + new Date(ts).toLocaleString('es-CL')
    : 'Sin datos de ejecución para este sitio';

  renderKPIs(audit, jmeter);
  $('#notice').hidden = !(isEmpty(audit) || isEmpty(jmeter));
  const search = $('#search');
  const filter = $('#filterStatus');
  renderAudit(audit, search.value.trim(), filter.value);
  renderJmeter(jmeter);
}

/* ---------- KPIs ---------- */
// La API devuelve { error: '...' } cuando aún no existe el reporte
const isEmpty = (data) => !data || !!data.error;

function renderKPIs(audit, jmeter) {
  const box = $('#kpis');
  const noAudit = isEmpty(audit);
  const noJmeter = isEmpty(jmeter);
  const cards = [];

  if (!noAudit) {
    cards.push(kpi('Dominio', audit.dominio || '—', '', 'accent'));
    cards.push(kpi('Páginas', audit.totalPaginas, 'auditadas'));
    cards.push(kpi('OK', audit.ok, 'sin problemas', 'ok'));
    cards.push(kpi('Fallidas', audit.fallidas, audit.fallidas > 0 ? 'revisar' : 'ninguna', audit.fallidas > 0 ? 'bad' : 'ok'));
  } else {
    cards.push(kpi('Auditoría', '—', 'corre primero npm run test:stress', 'muted'));
  }

  if (!noJmeter) {
    cards.push(kpi('Usuarios JMeter', jmeter.totalUsuarios, 'simultáneos', 'accent'));
    cards.push(kpi('Peticiones', jmeter.totalPeticiones, 'requests'));
    const pct = jmeter.porcentajeError ?? 0;
    cards.push(kpi('Errores', jmeter.errores + ' (' + pct + '%)', pct > 0 ? 'hay fallos' : 'sin fallos', pct > 0 ? 'warn' : 'ok'));
    cards.push(kpi('Latencia avg', jmeter.latenciaPromedioMs + ' ms', 'máx ' + jmeter.latenciaMaximaMs + ' ms'));
  } else {
    cards.push(kpi('Test', '—', 'corre primero npm run test:stress', 'muted'));
  }

  box.innerHTML = cards.join('');
}

function kpi(label, value, sub, tone) {
  return '<div class="kpi ' + (tone || '') + '"><div class="label">' + label + '</div>' +
    '<div class="value">' + value + '</div>' +
    '<div class="sub">' + (sub || '') + '</div></div>';
}

/* ---------- Auditoría ---------- */
function renderAudit(audit, search, statusFilter) {
  const tbody = $('#auditTable tbody');
  if (!audit || !audit.paginas || !audit.paginas.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Aún no hay datos. Ejecuta primero: npm run test:stress</td></tr>';
    return;
  }

  const rows = audit.paginas
    .filter((p) => !search || p.url.toLowerCase().includes(search.toLowerCase()))
    .filter((p) => statusFilter === 'all' || p.status === statusFilter)
    .map((p) => {
      const cls = p.status === 'OK' ? 'ok' : 'bad';
      const issues = (p.issues && p.issues.length)
        ? p.issues.map((i) => '<div>' + esc(i) + '</div>').join('')
        : '<span class="nobadge">—</span>';
      const shot = p.screenshot
        ? '<img class="thumb" src="/' + esc(p.screenshot) + '" loading="lazy" onclick="openLightbox(\'/' + esc(p.screenshot) + '\')">'
        : (p.status === 'FALLÓ' ? '<span class="issue">sin captura</span>' : '—');
      return '<tr>' +
        '<td><span class="badge ' + cls + '">' + esc(p.status) + '</span></td>' +
        '<td class="url">' + esc(p.url) + '</td>' +
        '<td class="num">' + esc(p.loadMs) + '</td>' +
        '<td class="num">' + esc(p.memoryMB) + '</td>' +
        '<td class="num">' + formsCell(p) + '</td>' +
        '<td>' + esc(p.cache) + '</td>' +
        '<td class="issue">' + issues + '</td>' +
        '<td>' + shot + '</td>' +
        '</tr>';
    })
    .join('');

  tbody.innerHTML = rows || '<tr><td colspan="7" class="empty">Sin resultados para ese filtro.</td></tr>';
}

function formsCell(p) {
  const n = p.forms;
  if (!n || n === 0) return '<span class="muted">—</span>';
  return String(n) + '<div class="muted" style="font-size:11px">' + (p.inputs || 0) + ' campos</div>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- JMeter ---------- */
function renderJmeter(jmeter) {
  const box = $('#jmeter');
  if (isEmpty(jmeter)) {
    box.innerHTML = '<div class="empty">No hay reporte de Test para este sitio. Ejecuta primero: npm run test:stress</div>';
    return;
  }

  const pct = jmeter.porcentajeError ?? 0;
  let html = '<div class="jmeter-grid">' +
    kpi('Peticiones', jmeter.totalPeticiones, 'requests') +
    kpi('Errores', jmeter.errores, 'de ' + jmeter.totalPeticiones, pct > 0 ? 'bad' : 'ok') +
    kpi('% error', pct + '%', 'de todas las peticiones', pct > 0 ? 'warn' : 'ok') +
    kpi('Latencia prom.', jmeter.latenciaPromedioMs + ' ms', '') +
    kpi('Latencia máx.', jmeter.latenciaMaximaMs + ' ms', '') +
    '</div>';

  // Barra de tasa de error
  html += '<div class="meter"><div class="fill" style="width:' + Math.min(pct * 8, 100) + '%"></div></div>';

  // Primer error
  if (jmeter.primerError) {
    html += '<h3>Primer fallo registrado</h3><div class="error-users"><div class="row">' +
      '<span class="usuario">' + esc(jmeter.primerError.thread) + '</span>' +
      '<span class="num">código ' + esc(jmeter.primerError.code) + ' · ' + esc(jmeter.primerError.label || '') + '</span>' +
      '</div></div>';
  }

  // Usuarios con errores
  if (jmeter.usuariosConErrores && jmeter.usuariosConErrores.length) {
    html += '<h3>Usuarios donde la página se rompió (' + jmeter.usuariosConErrores.length + ')</h3>';
    html += '<div class="error-users">' +
      jmeter.usuariosConErrores.map((u) => {
        const tasa = Math.round((u.errores / u.peticiones) * 100);
        return '<div class="row"><span class="usuario">' + esc(u.usuario) + '</span>' +
          '<span class="num">' + u.errores + ' err / ' + u.peticiones + ' (≈' + tasa + '%)</span></div>';
      }).join('') +
      '</div>';
  } else {
    html += '<p class="ok-msg">Sin errores: ninguna página se rompió bajo carga.</p>';
  }

  box.innerHTML = html;
}

/* ---------- Lightbox ---------- */
function openLightbox(src) {
  $('#lightbox').hidden = false;
  $('#lightbox img').src = src;
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightbox img').src = '';
}

/* ---------- Ejecución de Test por sitio ---------- */
let runTimer = null;

async function runSite(key) {
  if (runTimer) return;
  const msg = $('#runStatus');
  msg.hidden = false;
  msg.className = 'run-status running';
  msg.textContent = 'Ejecutando Test para ' + (state.sites.find((s) => s.key === key)?.dominio || key) + '…';

  try {
    const res = await fetch('/api/run/start/' + encodeURIComponent(key), { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) {
      msg.className = 'run-status bad';
      msg.textContent = data.error || 'No se pudo iniciar.';
      return;
    }
    state.run = { running: true, site: key, startedAt: new Date().toISOString(), tail: '' };
    pollRun(key);
  } catch {
    msg.className = 'run-status bad';
    msg.textContent = 'Error de conexión.';
  }
}

function pollRun(key) {
  if (runTimer) clearInterval(runTimer);
  runTimer = setInterval(async () => {
    try {
      const s = await fetchJSON('/api/run/status');
      state.run = s || state.run;
      if (s && s.tail) {
        $('#runStatus').textContent = s.tail.slice(-180);
      }
      if (s && !s.running) {
        clearInterval(runTimer);
        runTimer = null;
        const msg = $('#runStatus');
        msg.className = 'run-status ok';
        msg.textContent = 'Auditoría finalizada. Actualizando datos…';
        setTimeout(() => { msg.hidden = true; load(); }, 1200);
      }
    } catch {
      // sigue intentando
    }
  }, 2500);
}

/* ---------- Events ---------- */
$('#refresh').addEventListener('click', load);
$('#search').addEventListener('input', (e) => {
  if (!state.currentKey) return;
  renderAudit(state.audit[state.currentKey], e.target.value.trim(), $('#filterStatus').value);
});
$('#filterStatus').addEventListener('change', (e) => {
  if (!state.currentKey) return;
  renderAudit(state.audit[state.currentKey], $('#search').value.trim(), e.target.value);
});
$('#siteSelect').addEventListener('change', (e) => {
  if (e.target.value) location.search = '?site=' + encodeURIComponent(e.target.value);
});

// Botones "Ejecutar Test" de las tarjetas (delegado)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-run]');
  if (btn) {
    e.stopPropagation();
    e.preventDefault();
    runSite(btn.dataset.run);
    return;
  }
  const card = e.target.closest('.site-card');
  if (card && card.dataset.site) {
    location.search = '?site=' + encodeURIComponent(card.dataset.site);
  }
});

$('#lbClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => { if (e.target === $('#lightbox')) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

// Switch "¿Requiere autenticación?": muestra/oculta los campos de credenciales.
$('#authToggle').addEventListener('change', (e) => {
  $('#authFields').hidden = !e.target.checked;
});

// Agregar un sitio desde el dashboard (se guarda en data/urls.json).
// Si "¿Requiere autenticación?" está activo, se guardan credenciales opcionales.
$('#addSiteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#siteUrl');
  const msg = $('#addSiteMsg');
  msg.hidden = true;

  const authEnabled = $('#authToggle').checked;
  const payload = { url: input.value };
  if (authEnabled) {
    payload.auth = {
      enabled: true,
      loginUrl: $('#authLoginUrl').value.trim(),
      username: $('#authUser').value.trim(),
      password: $('#authPass').value,
    };
  }

  try {
    const res = await fetch('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      msg.textContent = data.error || 'No se pudo agregar.';
      msg.className = 'form-msg bad';
      msg.hidden = false;
      return;
    }
    msg.textContent = 'Sitio agregado: ' + (data.sites[data.sites.length - 1].dominio || input.value);
    msg.className = 'form-msg ok';
    msg.hidden = false;
    input.value = '';
    $('#authLoginUrl').value = '';
    $('#authUser').value = '';
    $('#authPass').value = '';
    $('#authToggle').checked = false;
    $('#authFields').hidden = true;
    await load();
  } catch {
    msg.textContent = 'Error de conexión.';
    msg.className = 'form-msg bad';
    msg.hidden = false;
  }
});

load();