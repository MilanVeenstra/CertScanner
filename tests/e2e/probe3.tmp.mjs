import * as E from './lib/env.mjs';
import { readFileSync } from 'node:fs';
const S = process.env.SCR;
const servers = await E.startServers();
const env = await E.launchExtension({ args: [`--log-net-log=${S}/netlog.json`, '--net-log-capture-mode=Default'] });
const page0 = env.context.pages()[0];
await page0.goto(`${servers.A}/pages/gallery.html`);
const tab = await E.findTab(env, `${servers.A}/pages/gallery.html`);
const { page } = await E.openPanel(env, tab.windowId);
const pages = [];
env.context.on('page', (p) => { pages.push(p); p.on('request', r => console.log('page req', r.url())); p.on('framenavigated', f => console.log('nav', f.url())); });
const r1 = await E.uploadAndWait(page, `${E.FIXTURES}/psa-8digit-leading-zero.png`);
console.log(r1.state);
await E.sleep(1500);
console.log('non-local', env.net.filter(n => !n.url.startsWith('chrome-extension://') && !n.url.includes('127.0.0.1')).map(n => [n.url, n.where, n.failure]));
console.log('pages', env.context.pages().map(p => p.url()));
await env.close(); await servers.close();
const raw = readFileSync(`${S}/netlog.json`, 'utf8');
let j; try { j = JSON.parse(raw); } catch { j = JSON.parse(raw.replace(/,?\s*$/, '') + ']}'); }
const urls = new Set(); const hosts = new Set();
for (const ev of j.events) { const p = ev.params || {}; if (typeof p.url === 'string') urls.add(p.url.slice(0, 80)); if (typeof p.host === 'string') hosts.add(p.host); }
console.log('netlog urls', [...urls].filter(u => !u.startsWith('chrome-extension://')));
console.log('netlog hosts', [...hosts]);
