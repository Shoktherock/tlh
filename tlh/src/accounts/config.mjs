import {ReviewError} from '../review-error.mjs';
export function accountConfig(url, key) {
  if (!url && !key) return null;
  if (!url || !key) throw new ReviewError('Set both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))) {
    throw new ReviewError('Supabase URL must be an HTTPS origin, or localhost for development.');
  }
  let publicKey = key.startsWith('sb_publishable_');
  if (!publicKey && key.split('.').length === 3) {
    try { publicKey = JSON.parse(atob(key.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).role === 'anon'; } catch {}
  }
  if (!publicKey) throw new ReviewError('Use a publishable or legacy anon key. Secret and service-role keys must never enter the browser build.');
  return { url: parsed.origin, key };
}
