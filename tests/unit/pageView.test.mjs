// A9 panel-side page-scan view logic (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_COMMAND, SHORTCUTS_URL, scanShortcut, classifyInjectError, panelScanPlan, alwaysAllowHost,
  accessBody, idleShortcutHint, pageSummary, pageQrInfo, pageErrorCode, persistablePage,
} from '../../src/sidepanel/pageView.js';
import { autoOpenKey } from '../../src/sidepanel/viewModel.js';

test('scanShortcut reads the scan-page command; empty when unset or missing', () => {
  assert.equal(PAGE_COMMAND, 'scan-page');
  assert.equal(SHORTCUTS_URL, 'chrome://extensions/shortcuts');
  assert.equal(scanShortcut([{ name: '_execute_action', shortcut: '' }, { name: 'scan-page', shortcut: 'Alt+Shift+S' }]), 'Alt+Shift+S');
  assert.equal(scanShortcut([{ name: 'scan-page', shortcut: '' }]), '');
  assert.equal(scanShortcut([]), '');
  assert.equal(scanShortcut(null), '');
  assert.equal(scanShortcut([{ name: 'scan-page', shortcut: 'x'.repeat(80) }]), ''); // implausible value ignored
});

test('classifyInjectError: Chrome-refused pages are restricted, missing access is access', () => {
  assert.equal(classifyInjectError('Cannot access a chrome:// URL'), 'restricted');
  assert.equal(classifyInjectError('Cannot access a chrome-extension:// URL of different extension'), 'restricted');
  assert.equal(classifyInjectError('The extensions gallery cannot be scripted.'), 'restricted');
  assert.equal(classifyInjectError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.'), 'access');
  assert.equal(classifyInjectError(''), 'access');
  assert.equal(classifyInjectError(undefined), 'access');
});

test('panelScanPlan: readable URL scans, restricted URL is restricted, hidden URL needs a probe', () => {
  assert.deepEqual(panelScanPlan({ id: 1, url: 'https://www.ebay.com/itm/1' }), { action: 'scan' });
  assert.deepEqual(panelScanPlan({ id: 1, url: 'chrome://version/' }), { action: 'restricted' });
  assert.deepEqual(panelScanPlan({ id: 1, url: 'https://chromewebstore.google.com/detail/x' }), { action: 'restricted' });
  assert.deepEqual(panelScanPlan({ id: 1 }), { action: 'probe' });
  assert.deepEqual(panelScanPlan({ id: 1 }, { injectError: 'Cannot access a chrome:// URL' }), { action: 'restricted' });
  assert.deepEqual(panelScanPlan({ id: 1 }, { injectError: 'Cannot access contents of the page.' }), { action: 'access' });
  assert.deepEqual(panelScanPlan(null), { action: 'access' });
});

test('alwaysAllowHost: only https hosts the panel already knows for this tab', () => {
  assert.equal(alwaysAllowHost('https://www.ebay.com/itm/1'), 'www.ebay.com');
  assert.equal(alwaysAllowHost('http://shop.example/'), null);
  assert.equal(alwaysAllowHost('chrome://version/'), null);
  assert.equal(alwaysAllowHost(''), null);
  assert.equal(alwaysAllowHost(null), null);
});

test('accessBody and idleShortcutHint follow the toolbar setting and the shortcut', () => {
  assert.deepEqual(accessBody({ scanOnClick: true, shortcut: 'Alt+Shift+S' }), { key: 'page_access_body_keys', subs: ['Alt+Shift+S'] });
  assert.deepEqual(accessBody({ scanOnClick: true, shortcut: '' }), { key: 'page_access_body', subs: [] });
  assert.deepEqual(accessBody({ scanOnClick: false, shortcut: 'Alt+Shift+S' }), { key: 'page_access_body_keys_only', subs: ['Alt+Shift+S'] });
  assert.deepEqual(accessBody({ scanOnClick: false, shortcut: '' }), { key: 'page_access_body_none', subs: [] });
  assert.deepEqual(idleShortcutHint({ scanOnClick: true, shortcut: 'Alt+Shift+S' }), { key: 'shortcut_hint', subs: ['Alt+Shift+S'] });
  assert.deepEqual(idleShortcutHint({ scanOnClick: true, shortcut: '' }), { key: 'shortcut_none', subs: [] });
  assert.deepEqual(idleShortcutHint({ scanOnClick: false, shortcut: 'Alt+Shift+S' }), { key: 'shortcut_hint_keys_only', subs: ['Alt+Shift+S'] });
  assert.equal(idleShortcutHint({ scanOnClick: false, shortcut: '' }), null);
});

test('pageSummary: count line, plus a partial-page note when the budget ran out', () => {
  assert.deepEqual(pageSummary({ items: [{}, {}], partial: null }), [{ key: 'page_results_summary', subs: ['2'] }]);
  assert.deepEqual(pageSummary({ items: [{}], partial: { checked: 3, total: 8 } }), [
    { key: 'page_results_summary', subs: ['1'] },
    { key: 'page_results_partial', subs: ['3', '8'] },
  ]);
});

test('pageQrInfo: off-site QR host and whether a listed number came from it', () => {
  assert.deepEqual(pageQrInfo({ warnings: [], items: [] }), { qrHost: null, qrNumberUsed: false });
  const r = { warnings: [{ code: 'qr-untrusted-host', detail: 'evil.example' }], items: [{ evidence: ['qr-untrusted:evil.example'] }] };
  assert.deepEqual(pageQrInfo(r), { qrHost: 'evil.example', qrNumberUsed: true });
  assert.deepEqual(pageQrInfo({ ...r, items: [{ evidence: ['len:8'] }] }), { qrHost: 'evil.example', qrNumberUsed: false });
});

test('pageErrorCode: toolbar/shortcut refusals are restricted; a panel scan that lost access asks for a click', () => {
  assert.equal(pageErrorCode({ code: 'restricted', injectFailed: true }, { source: 'panel', pageUrl: 'https://a.example/' }), 'page-access');
  assert.equal(pageErrorCode({ code: 'restricted', injectFailed: true }, { source: 'action', pageUrl: 'https://a.example/' }), 'restricted');
  assert.equal(pageErrorCode({ code: 'restricted' }, { source: 'panel', pageUrl: 'chrome://version/' }), 'restricted');
  assert.equal(pageErrorCode({ code: 'timeout' }, { source: 'command' }), 'page-timeout');
  assert.equal(pageErrorCode({ code: 'aborted' }, { source: 'command' }), 'aborted');
  assert.equal(pageErrorCode({ code: 'engine-failed' }, { source: 'command' }), 'engine-failed');
  assert.equal(pageErrorCode(undefined, { source: 'command' }), 'engine-failed');
});

test('persistablePage: only an auto-open page result maps onto the lastResult schema', () => {
  const top = { grader: 'psa', graderOptions: ['psa'], number: '01234567', confidence: 0.9, source: 'ocr', evidence: [] };
  assert.deepEqual(persistablePage({ status: 'auto-open', top, warnings: [] }), { candidates: [top], warnings: [], imageInfo: null });
  assert.equal(persistablePage({ status: 'page-results', items: [top], warnings: [] }), null);
  assert.equal(persistablePage({ status: 'none', items: [], warnings: [] }), null);
});

test('autoOpenKey: page jobs are keyed on the job id like image jobs (SEC-06)', () => {
  assert.equal(autoOpenKey({ kind: 'page', job: { id: 'p1' } }, 's1'), 'job:p1');
  assert.equal(autoOpenKey({ kind: 'job', job: { id: 'j1' } }, 's1'), 'job:j1');
  assert.equal(autoOpenKey({ kind: 'blob' }, 's1'), 'scan:s1');
});

test('errorView: page timeout (E11) offers Try again only when re-runnable, names the menu item', async () => {
  const { errorView } = await import('../../src/sidepanel/viewModel.js');
  assert.deepEqual(errorView('page-timeout', { retryable: true, menuTitle: 'Scan slab cert number' }), {
    id: 'E11', tone: 'warning', heading: 'err_page_timeout_heading', body: 'err_page_timeout_body', bodySubs: ['Scan slab cert number'], actions: ['retry', 'choose'],
  });
  assert.deepEqual(errorView('page-timeout', { retryable: false }).actions, ['choose']);
});

test('lastResult keeps a page-timeout error across a panel reopen', async () => {
  const { makeLastResult, parseLastResult } = await import('../../src/shared/lastResult.js');
  const saved = makeLastResult({ task: 'error', body: 'error', result: null, error: { code: 'page-timeout' }, opened: null, imageHost: null }, 1000);
  assert.equal(parseLastResult(saved, { now: 2000 }).ok, true);
});
