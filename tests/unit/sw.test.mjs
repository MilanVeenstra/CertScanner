// Service worker wiring with a fake `chrome`: listeners registered at top level, settings via storage.sync only
// (no wake-ups from the panel's session/local writes), and window-close cleanup (SEC-18, O9).
import { test } from 'node:test';
import assert from 'node:assert/strict';

function fakeChrome() {
  const ev = () => { const ls = []; return { listeners: ls, addListener: (l) => ls.push(l), removeListener: () => {} }; };
  const calls = [];
  const c = {
    calls,
    runtime: { onInstalled: ev(), onStartup: ev(), lastError: undefined, getURL: (p) => `chrome-extension://x/${p}` },
    contextMenus: { removeAll: (cb) => cb?.(), create: (_o, cb) => cb?.(), onClicked: ev() },
    i18n: { getMessage: (k) => k },
    action: { onClicked: ev(), setTitle: async (o) => { calls.push(['setTitle', o.title]); } },
    commands: { onCommand: ev() },
    sidePanel: { setPanelBehavior: async (o) => { calls.push(['setPanelBehavior', o.openPanelOnActionClick]); }, open: async () => {} },
    windows: { onRemoved: ev(), create: async () => {} },
    storage: {
      onChanged: ev(),
      sync: { onChanged: ev(), get: async () => ({ settings: c.syncSettings }) },
      session: { set: async () => {}, remove: async (keys) => { calls.push(['session.remove', keys]); } },
    },
    syncSettings: undefined,
  };
  return c;
}

test('SW: settings changes are watched on storage.sync only; window close clears job slot, seen ids and last result', async () => {
  const c = fakeChrome();
  const saved = globalThis.chrome;
  globalThis.chrome = c;
  try {
    await import(`../../src/background/sw.js?test=${Date.now()}`);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(c.storage.onChanged.listeners.length, 0, 'no all-area storage listener (it would wake the worker on every scan)');
    assert.equal(c.storage.sync.onChanged.listeners.length, 1);
    for (const e of [c.runtime.onInstalled, c.runtime.onStartup, c.contextMenus.onClicked, c.action.onClicked, c.commands.onCommand, c.windows.onRemoved]) {
      assert.equal(e.listeners.length, 1);
    }

    c.calls.length = 0;
    c.syncSettings = { v: 1, scanOnToolbarClick: false };
    c.storage.sync.onChanged.listeners[0]({ settings: { newValue: c.syncSettings } });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(c.calls, [['setPanelBehavior', true], ['setTitle', 'action_title_open']]);
    c.calls.length = 0;
    c.storage.sync.onChanged.listeners[0]({ other: { newValue: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(c.calls, [], 'unrelated sync keys are ignored');

    c.windows.onRemoved.listeners[0](42);
    assert.deepEqual(c.calls, [['session.remove', ['scanJob:42', 'seenJobs:42', 'lastResult:42']]]);
  } finally {
    globalThis.chrome = saved;
  }
});
