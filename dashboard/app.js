/* E2E QA Dashboard — frontend compacto (sin dependencias) */

const $ = (sel) => document.querySelector(sel);

let state = { audit: null, jmeter: null };

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
  const [audit, jmeter] = await Promise.all([
    fetchJSON('/api/auditoria'),
    fetchJSON('/api/jmeter'),
  ]);
  state.audit = audit;
  state.jmeter = jmeter;

  const stamp = $('#stamp');
  const ts = audit?.ejecutado || jmeter?.fecha;
  stamp.textContent = ts ? '⏱ ' + new Date(ts).toLocaleString('es-CL') : 'sin datos';

  renderKPIs(audit, jmeter);
  const search = $('#search');
  const filter = $('#filterStatus');
  renderAudit(audit, search.value.trim(), filter.value);
  renderJmeter(jmeter);
}

/* ---------- KPIs ---------- */
function renderKPIs(audit, jmeter) {
  const box = $('#kpis');
  const cards = [];

  if (audit) {
    cards.push(kpi('Dominio', audit.dominio || '—', '', 'accent'));
    cards.push(kpi('Páginas', audit.totalPaginas, 'auditadas'));
    cards.push(kpi('OK', audit.ok, 'sin problemas', 'ok'));
    cards.push(kpi('Fallidas', audit.fallidas, audit.fallidas > 0 ? 'revisar' : 'ninguna', audit.fallidas > 0 ? 'bad' : 'ok'));
  } else {
    cards.push(kpi('Auditoría', '—', 'corre primero npm run test:stress', 'muted'));
  }

  if (jmeter) {
    cards.push(kpi('Usuarios JMeter', jmeter.totalUsuarios, 'simultáneos', 'accent'));
    cards.push(kpi('Peticiones', jmeter.totalPeticiones, 'requests'));
    const pct = jmeter.porcentajeError ?? 0;
    cards.push(kpi('Errores', jmeter.errores + ' (' + pct + '%)', pct > 0 ? 'hay fallos' : 'sin fallos', pct > 0 ? 'warn' : 'ok'));
    cards.push(kpi('Latencia avg', jmeter.latenciaPromedioMs + ' ms', 'máx ' + jmeter.latenciaMaximaMs + ' ms'));
  } else {
    cards.push(kpi('Estrés', '—', 'corre primero npm run test:stress', 'muted'));
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
        '<td>' + esc(p.cache) + '</td>' +
        '<td class="issue">' + issues + '</td>' +
        '<td>' + shot + '</td>' +
        '</tr>';
    })
    .join('');

  tbody.innerHTML = rows || '<tr><td colspan="7" class="empty">Sin resultados para ese filtro.</td></tr>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- JMeter ---------- */
function renderJmeter(jmeter) {
  const box = $('#jmeter');
  if (!jmeter) {
    box.innerHTML = '<div class="empty">Aún no hay reporte de estrés. Ejecuta primero: npm run test:stress</div>';
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
    html += '<p class="ok-msg">✅ Ninguna página se rompió bajo carga.</p>';
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

/* ---------- Events ---------- */
$('#refresh').addEventListener('click', load);
$('#search').addEventListener('input', (e) => renderAudit(state.audit, e.target.value.trim(), $('#filterStatus').value));
$('#filterStatus').addEventListener('change', (e) => renderAudit(state.audit, $('#search').value.trim(), e.target.value));
$('#lbClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => { if (e.target === $('#lightbox')) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

load();