// Consumed job ids per window (QA O9): chrome.storage.session 'seenJobs:<windowId>'. A panel reload can't run or
// auto-open a job id it already handled, even while the job is still inside its 120 s TTL. Ids only; no URLs.
// Pure parse/add helpers; the side panel (jobIntake.js) reads and writes, the service worker removes the key when the
// window closes.

export const seenJobsKey = (windowId) => `seenJobs:${windowId}`;
export const MAX_SEEN_JOBS = 20;
/** Same id rule as parseScanJob: a string of 1-64 characters. */
const isId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64;

/** Valid ids from a stored value, oldest first, at most MAX_SEEN_JOBS. */
export function parseSeenJobs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) if (isId(id) && !out.includes(id)) out.push(id);
  return out.slice(-MAX_SEEN_JOBS);
}

/** List with `id` appended (moved to the end if present), capped to the newest MAX_SEEN_JOBS. */
export function addSeenJob(list, id) {
  const rest = parseSeenJobs(list).filter((x) => x !== id);
  return isId(id) ? [...rest, id].slice(-MAX_SEEN_JOBS) : rest;
}
