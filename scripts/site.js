/**
 * scripts/site.js — Helpers de sitios (dominios) usados por runner, spec y dashboard.
 *
 * Cada URL de data/urls.json tiene una clave estable (siteKey) que sirve para
 * nombrar sus reportes (reports/auditoria/<key>.json, reports/jmeter/<key>.json)
 * y sus pantallazos (reports/screenshots/<key>/...).
 *
 * Ejemplos:
 *   siteKey('https://ast.cl')          -> 'ast'
 *   siteKey('https://www.ast.cl')      -> 'ast'   (www se ignora)
 *   siteKey('https://facebook.com')    -> 'facebook'
 *   siteKey('https://sub.ejemplo.cl')  -> 'sub_ejemplo'
 */

function siteKey(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const parts = host.split('.');
  // Deja las partes del dominio excepto el TLD (ast.cl -> ['ast'] -> 'ast').
  // Con subdominios agrupa (sub.ejemplo.cl -> sub_ejemplo).
  const base = parts.slice(0, Math.max(1, parts.length - 1)).join('_');
  return base.toLowerCase() || host.toLowerCase();
}

function siteLabel(url) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return host.toLowerCase();
}

// data/urls.json admite dos formatos:
//   "https://sitio.cl"                      (legacy, sin auth)
//   { url: "https://sitio.cl", auth: {...} } (con credenciales opcionales)
// Este normalizador convierte cualquier entrada en { url, auth }.
function normalizeUrlEntry(entry) {
  if (typeof entry === 'string') return { url: entry, auth: null };
  if (entry && typeof entry.url === 'string') {
    const auth = entry.auth && typeof entry.auth === 'object' ? entry.auth : null;
    return { url: entry.url, auth };
  }
  return null;
}

// Indica si una entrada tiene autenticación habilitada (login por API).
function authEnabled(entry) {
  const norm = normalizeUrlEntry(entry);
  return !!(norm && norm.auth && norm.auth.enabled);
}

module.exports = { siteKey, siteLabel, normalizeUrlEntry, authEnabled };