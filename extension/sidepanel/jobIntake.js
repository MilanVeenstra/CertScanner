// Side-panel job intake (ADR-001 §4). Subscribes to storage.onChanged *before* reading the current
// value; each job id is consumed once; the key is removed only if the stored id still matches.
// O9: consumed ids are also kept in storage.session ('seenJobs:<windowId>', newest 20), so a reloaded panel never
// runs (or auto-opens) a job id it already handled.
import { jobKey, parseScanJob } from '../shared/jobContract.js';
import { seenJobsKey, parseSeenJobs, addSeenJob } from '../shared/seenJobs.js';

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
  const seenKey = seenJobsKey(windowId);
  const seen = new Set();
  let persisted = [];
  let stopped = false;

  // Ids consumed by earlier panel instances in this window.
  const loaded = (async () => {
    try {
      const got = await area.get(seenKey);
      persisted = parseSeenJobs(got?.[seenKey]);
      for (const id of persisted) seen.add(id);
    } catch { /* none */ }
  })();
  /** Jobs are handled one at a time, in arrival order, after the consumed ids are known. */
  let chain = loaded;
  const enqueue = (raw) => { chain = chain.then(() => consider(raw)).catch(() => {}); return chain; };

  async function remember(id) {
    persisted = addSeenJob(persisted, id);
    try { await area.set({ [seenKey]: persisted }); } catch { /* best effort: the in-memory set still applies */ }
  }

  async function removeIfStill(id) {
    try {
      const got = await area.get(key);
      if (got?.[key]?.id === id) await area.remove(key);
    } catch { /* storage unavailable: the TTL makes a leftover job harmless */ }
  }

  async function consider(raw) {
    if (stopped || raw === undefined) return;
    const parsed = parseScanJob(raw, { now: now(), windowId });
    if (!parsed.ok) {
      // Our own slot holds something unusable: clear it so it never resurfaces.
      area.remove(key).catch?.(() => {});
      return;
    }
    const { job } = parsed;
    if (seen.has(job.id)) {
      // Already handled: clear it too, so a panel reload within the TTL doesn't run it again.
      removeIfStill(job.id);
      return;
    }
    seen.add(job.id);
    await remember(job.id);
    if (stopped) return;
    try {
      onJob(job);
    } finally {
      removeIfStill(job.id);
    }
  }

  const listener = (changes, areaName) => {
    if (areaName !== 'session' || !changes[key]) return;
    enqueue(changes[key].newValue);
  };
  onChanged.addListener(listener);

  const ready = (async () => {
    let raw;
    try {
      const got = await area.get(key);
      raw = got?.[key];
    } catch { /* nothing stored */ }
    await enqueue(raw);
  })();

  return {
    ready,
    stop() {
      stopped = true;
      onChanged.removeListener(listener);
    },
  };
}
