// SEC-03: settle when the signal aborts even if the wrapped promise never does (hung page, busy loop,
// stalled Chrome API). The wrapped promise keeps running but its result/rejection is ignored safely.

function abortError(signal) {
  const r = signal?.reason;
  if (r instanceof Error || (r && typeof r === 'object' && typeof r.name === 'string')) return r;
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * @template T
 * @param {Promise<T>|T} promise
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<T>}
 */
export function raceAbort(promise, signal) {
  const p = Promise.resolve(promise);
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}
