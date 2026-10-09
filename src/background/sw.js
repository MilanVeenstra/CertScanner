// Service worker (ADR-001 §4): stateless trigger. Every listener is registered synchronously at the
// module top level. No runtime messaging listeners exist in v1 (ADR §10).
import { MENU_ID, createScanJob, jobKey } from '../shared/jobContract.js';

function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      { id: MENU_ID, title: chrome.i18n.getMessage('menuScan') || 'Scan slab cert number', contexts: ['image'] },
      () => void chrome.runtime.lastError,
    );
  });
}

chrome.runtime.onInstalled.addListener(registerMenus);
chrome.runtime.onStartup.addListener(registerMenus); // removeAll -> create; refreshes the localized title
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.warn);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !(tab.id >= 0)) return;
  // MUST be the first side effect; no await before it (the gesture is only valid synchronously).
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => chrome.windows.create({
    type: 'popup', width: 420, height: 760,
    url: chrome.runtime.getURL(`sidepanel/sidepanel.html?w=${tab.windowId}`),
  }).catch(console.warn));
  const job = createScanJob(info, tab, Date.now(), crypto.randomUUID());
  chrome.storage.session.set({ [jobKey(tab.windowId)]: job }).catch(console.warn);
});

chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.session.remove(jobKey(windowId)).catch(() => {});
});
