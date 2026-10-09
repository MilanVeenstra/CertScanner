// Side-panel job intake (ADR-001 §4). Subscribes to storage.onChanged *before* reading the current
// value; each job id is consumed once; the key is removed only if the stored id still matches.
import { jobKey, parseScanJob } from '../shared/jobContract.js';

/** `?w=<windowId>` (1-10 digits) or null. */
export function parseWindowParam(search) {
  const w = new URLSearchParams(typeof search === 'string' ? search : '').get('w');
  return w !== null && /^\d{1,10}$/.test(w) ? Number(w) : null;
}

/** Target window: `?w=` when valid (popup fallback, e2e), else the window hosting this panel. */
export async function resolveTargetWindowId(search = globalThis.location?.search, chromeApi = globalThis.chrome) {
  const fromParam = parseWindowParam(search);
  if (fromParam !== null) return fromParam;
  const win = await chromeApi.windows.getCurrent();
  return win.id;
}

/**
 * @param {{windowId:number, onJob:(job:import('../core/types.js').ScanJob)=>void,
 *   area?:chrome.storage.StorageArea, onChanged?:chrome.storage.StorageChangedEvent, now?:()=>number}} opts
 * @returns {{ready:Promise<void>, stop:()=>void}}
 */
export function startJobIntake({ windowId, onJob, area = globalThis.chrome?.storage.session, onChanged = globalThis.chrome?.storage.onChanged, now = () => Date.now() }) {
  const key = jobKey(windowId);
  const seen = new Set();
  let stopped = false;

  async function removeIfStill(id) {
    try {
      const got = await area.get(key);
      if (got?.[key]?.id === id) await area.remove(key);
    } catch { /* storage unavailable: the TTL makes a leftover job harmless */ }
  }

  function consider(raw) {
    if (stopped || raw === undefined) return;
    const parsed = parseScanJob(raw, { now: now(), windowId });
    if (!parsed.ok) {
      // Our own slot holds something unusable: clear it so it never resurfaces.
      area.remove(key).catch?.(() => {});
      return;
    }
    const { job } = parsed;
    if (seen.has(job.id)) return;
    seen.add(job.id);
    try {
      onJob(job);
    } finally {
      removeIfStill(job.id);
    }
  }

  const listener = (changes, areaName) => {
    if (areaName !== 'session' || !changes[key]) return;
    consider(changes[key].newValue);
  };
  onChanged.addListener(listener);

  const ready = (async () => {
    try {
      const got = await area.get(key);
      consider(got?.[key]);
    } catch { /* nothing stored */ }
  })();

  return {
    ready,
    stop() {
      stopped = true;
      onChanged.removeListener(listener);
    },
  };
}
