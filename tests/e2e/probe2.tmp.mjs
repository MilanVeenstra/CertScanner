import * as E from './lib/env.mjs';
const env = await E.launchExtension();
const url = env.url('sidepanel/sidepanel.html?w=1');
const p = await env.context.newPage();
const errs = E.watchErrors(p);
await p.goto(url);
await E.sleep(4000);
console.log(errs, await p.evaluate(() => ({ ready: document.body.dataset.ready, state: document.body.dataset.state })));
await env.close();
