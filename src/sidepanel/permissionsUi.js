// Optional per-origin host access ("Sharper scans on <host>") and the granted-sites list (ADR-001 §11).
// permissions.request() must be the FIRST call in the click handler (user gesture), so requestSharper()
// is synchronous up to that call.

/** `https://<host>/*` for an https origin, else null. */
export function originPattern(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' || !u.hostname) return null;
    return `https://${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Call directly from a click handler. Resolves true (granted) / false (denied); rejects when Chrome could not
 * show the request (UX spec N1 "failed").
 */
export function requestSharper(origin, chromeApi = globalThis.chrome) {
  const pattern = originPattern(origin);
  if (!pattern) return Promise.resolve(false);
  return chromeApi.permissions.request({ origins: [pattern] });
}

const SITE_RE = /^https:\/\/([a-z0-9.-]+)\/\*$/i;

const WILDCARDS = new Set(['https://*/*', '<all_urls>', '*://*/*', 'http://*/*']);

/**
 * Hosts granted through "Sharper scans", plus any wildcard grant (SEC-11: shown as an "All sites" row).
 * @returns {Promise<{hosts:string[], allSites:string[]}>}
 */
export async function listGrantedSites(chromeApi = globalThis.chrome) {
  const all = await chromeApi.permissions.getAll();
  const origins = Array.isArray(all?.origins) ? all.origins : [];
  return {
    hosts: origins.map((o) => SITE_RE.exec(o)?.[1]).filter((h) => h && h !== '*').sort(),
    allSites: origins.filter((o) => WILDCARDS.has(o)),
  };
}

export function removeSite(host, chromeApi = globalThis.chrome) {
  return chromeApi.permissions.remove({ origins: [`https://${host}/*`] });
}

/** Remove wildcard grants. Install-time host permissions (e2e build only) cannot be removed and resolve false. */
export function removeAllSites(patterns, chromeApi = globalThis.chrome) {
  return chromeApi.permissions.remove({ origins: patterns }).catch(() => false);
}

export function onPermissionsChanged(cb, chromeApi = globalThis.chrome) {
  chromeApi.permissions.onAdded.addListener(cb);
  chromeApi.permissions.onRemoved.addListener(cb);
  return () => {
    chromeApi.permissions.onAdded.removeListener(cb);
    chromeApi.permissions.onRemoved.removeListener(cb);
  };
}
