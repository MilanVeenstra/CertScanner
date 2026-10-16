// Service worker (ADR-001 §4, A9): stateless trigger. Every listener is registered synchronously at the
// module top level. No runtime messaging listeners exist in v1 (ADR §10).
import { MENU_ID, PAGE_COMMAND, createScanJob, createPageJob, jobKey } from '../shared/jobContract.js';
import { seenJobsKey } from '../shared/seenJobs.js';
import { SETTINGS_KEY, migrateSettings } from '../shared/settings.js';
import { lastResultKey } from '../shared/lastResult.js';


function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      { id: MENU_ID, title: chrome.i18n.getMessage('context_menu_scan') || 'Scan slab cert number', contexts: ['image'] },
      () => void chrome.runtime.lastError,
    );
  });
}

/**
 * A9: with scanOnToolbarClick (default) the icon scans the page via action.onClicked; otherwise it only opens the
 * panel. The tooltip says which (RM-6: manifest default = "Scan this page…", runtime "Open CertScanner" when off).
 * Runs at every worker start, on install/startup and on every settings change.
 */
async function applyPanelBehavior() {
  let scanOnClick = true;
  try {
    const got = await chrome.storage.sync.get(SETTINGS_KEY);
    scanOnClick = migrateSettings(got?.[SETTINGS_KEY]).value.scanOnToolbarClick;
  } catch { /* default */ }
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !scanOnClick }).catch(console.warn);
  const title = chrome.i18n.getMessage(scanOnClick ? 'action_title' : 'action_title_open');
  if (title) await chrome.action.setTitle({ title }).catch(console.warn);
}

/** MUST be the first side effect of a user gesture: no await before sidePanel.open(). */
function openPanel(windowId) {
  chrome.sidePanel.open({ windowId }).catch(() => chrome.windows.create({
    type: 'popup', width: 420, height: 760,
    url: chrome.runtime.getURL(`sidepanel/sidepanel.html?w=${windowId}`),
  }).catch(console.warn));
}

function queue(windowId, job) {
  chrome.storage.session.set({ [jobKey(windowId)]: job }).catch(console.warn);
}

chrome.runtime.onInstalled.addListener(() => { registerMenus(); applyPanelBehavior(); });
chrome.runtime.onStartup.addListener(() => { registerMenus(); applyPanelBehavior(); }); // refreshes the localized title
applyPanelBehavior();
// Settings live in sync storage. Listening to that area only means the panel's session/local writes (jobs, history,
// last result) never wake a stopped worker.
chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes[SETTINGS_KEY]) applyPanelBehavior();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !(tab.id >= 0)) return;
  openPanel(tab.windowId);
  queue(tab.windowId, createScanJob(info, tab, Date.now(), crypto.randomUUID()));
});

// A9 trigger 1: toolbar icon (only fires while openPanelOnActionClick is false). Grants activeTab.
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !(tab.id >= 0)) return;
  openPanel(tab.windowId);
  queue(tab.windowId, createPageJob(tab, Date.now(), crypto.randomUUID(), 'action'));
});

// A9 trigger 2: keyboard command (suggested Alt+Shift+S). Grants activeTab.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== PAGE_COMMAND || !tab || !(tab.id >= 0)) return;
  openPanel(tab.windowId);
  queue(tab.windowId, createPageJob(tab, Date.now(), crypto.randomUUID(), 'command'));
});

// A closed window leaves nothing behind: its job slot, its consumed job ids and its last result (SEC-18).
chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.session.remove([jobKey(windowId), seenJobsKey(windowId), lastResultKey(windowId)]).catch(() => {});
});
