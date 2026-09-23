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
  // Si el parámetro no es un string válido, evitar que rompa el flujo
  if (!url || typeof url !== 'string') return '';

  // Si ya es una key procesada (ej: "10_20_7" o "ast"), no es una URL.
  // Las URLs válidas en tu entorno siempre inician con http:// o https://
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return url.toLowerCase(); // Retorna la key limpia directamente
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    // IPv4 puro (ej: 10.30.7.25): no recortar la última parte, el último octeto
    // es parte de la dirección, no un TLD (si no, 10.30.7.14 y 10.30.7.25
    // colisionarían en la key "10_30_7").
    const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
    // Deja las partes del dominio excepto el TLD (ast.cl -> ['ast'] -> 'ast').
    // Con subdominios agrupa (sub.ejemplo.cl -> sub_ejemplo).
    const base = isIPv4 ? parts.join('_') : parts.slice(0, Math.max(1, parts.length - 1)).join('_');
    return base.toLowerCase() || host.toLowerCase();
  } catch (err) {
    // Si por alguna razón falla el parseo de la URL, retorna el string original en minúsculas
    return url.toLowerCase();
  }
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