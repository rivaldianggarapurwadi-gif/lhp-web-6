// Offline browser-flow checks using Node's VM; no payment requests are sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('templates/index.html', 'utf8');
const code = html.slice(html.indexOf('let selectedPkg = null;'), html.indexOf('// Tutup modal dengan Escape'));
function setup() {
  const nodes = new Map(), events = {}, saved = new Map(), timers = new Map();
  let next = 0;
  function element() {
    const classes = new Set();
    return {textContent:'', children:[], disabled:false,
      append(...values) { this.children.push(...values); },
      classList: {add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x)}};
  }
  const context = vm.createContext({URL, URLSearchParams,
    document: {
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      querySelectorAll: () => [], createElement: element,
      addEventListener: (name, callback) => {events[name] = callback;}
    },
    window: {open: () => null, location: {href:'https://test.example/', search:''}, history: {replaceState() {}}},
    sessionStorage: {getItem:k=>saved.get(k), setItem:(k,v)=>saved.set(k,v), removeItem:k=>saved.delete(k)},
    setTimeout: f => {timers.set(++next,f); return next;}, clearTimeout: id=>timers.delete(id),
    fetch: async url => ({ok:true, status:200, json:async()=> url.includes('token-balance') ? {tokens:6} :
      url.includes('/create') ? {order_id:'order-1',payment_url:'https://app-sandbox.duitku.com/test'} :
      {status:'pending',tokens:5,payment_url:'https://app-sandbox.duitku.com/test'}})
  });
  vm.runInContext(code, context);
  return {context,nodes,events,saved,timers};
}
(async()=>{
  const t=setup();
  vm.runInContext("openTopup(); selectPkg('pkg_5');",t.context);
  await vm.runInContext('doPay()',t.context);
  assert.equal(t.saved.get('lhp-payment-order'),'order-1');
  assert(t.nodes.get('modal-status').children.some(x=>x.href==='https://app-sandbox.duitku.com/test'));
  assert.equal(t.timers.size,1);
  vm.runInContext('closeTopup()',t.context);
  assert.equal(t.timers.size,0);
  vm.runInContext("openTopup(); selectPkg('pkg_1');",t.context);
  assert.equal(t.nodes.get('btn-pay').onclick,t.context.doPay);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(t.nodes.get('btn-pay').textContent,/1 Token/);
  vm.runInContext('openTopup()',t.context);
  await new Promise(resolve=>setImmediate(resolve));
  t.context.fetch=async url=>({ok:true,status:200,json:async()=>url.includes('token-balance')?{tokens:6}:{status:'paid',tokens:5}});
  await vm.runInContext("checkPayStatus('order-1')",t.context);
  assert.equal(t.saved.has('lhp-payment-order'),false);
  assert.equal(t.nodes.get('token-count').textContent,6);
  assert.equal(t.timers.size,0);
  const redirect=setup();
  redirect.context.window.location.search='?payment_order=order-2';
  redirect.context.window.location.href='https://test.example/?payment_order=order-2';
  assert.equal(redirect.nodes.size,0); // Return handling waits until modal HTML exists.
  redirect.events.DOMContentLoaded();
  assert.equal(redirect.saved.get('lhp-payment-order'),'order-2');
  console.log('Payment UI checks passed: blocked popup, polling, package reset, paid balance, return timing.');
})().catch(error=>{console.error(error);process.exitCode=1;});
