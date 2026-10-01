/* test/helpers.js —— jsdom 环境装配与交互模拟 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function readAsset(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

/* 可注入到多个 JSDOM window 的共享内存存储（模拟跨刷新 localStorage） */
function createMemoryStorage(seed) {
  const data = Object.assign({}, seed || {});
  return function () {
    return {
      getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem(k, v) { data[k] = String(v); },
      removeItem(k) { delete data[k]; },
      _dump: () => JSON.parse(JSON.stringify(data))
    };
  };
}

/*
 * 加载一个演练页 DOM。
 * opts:
 *   pageMark   : data-page 标记（默认 walkthrough；可改成别的验证页面守卫）
 *   storage    : 上面 createMemoryStorage() 的共享工厂；不给则用 window 自带 localStorage
 *   scripts    : 是否执行页面自带脚本（默认 true）
 */
async function loadPage(opts) {
  opts = opts || {};
  let html = readAsset('index.html');
  if (opts.pageMark && opts.pageMark !== 'walkthrough') {
    html = html.replace('data-page="walkthrough"', 'data-page="' + opts.pageMark + '"');
  }
  if (opts.scripts === false) {
    html = html.replace(/<script[^>]*app\.js[^>]*><\/script>/g, '');
    html = html.replace(/<script[^>]*recorder\.js[^>]*><\/script>/g, '');
  }

  const dom = new JSDOM(html, {
    url: 'https://example.test/walkthrough',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;

  const storage = opts.storage ? opts.storage() : null;
  window.__testStorage = storage;

  /* 在 window 全局上下文内求值脚本，保证脚本里的 window/self/document 指向该页 */
  const ctx = dom.getInternalVMContext();
  vm.runInContext(readAsset('app.js'), ctx, { filename: 'app.js' });
  vm.runInContext(readAsset('recorder.js'), ctx, { filename: 'recorder.js' });

  /* 默认 createRecorder 用 window.localStorage；注入共享内存时重建录制器 */
  if (storage) {
    window.__walkthroughRecorder = null;
    delete window.__walkthroughRecorder;
    window.WalkthroughRecorder.bootIfWalkthrough(window, { storage: storage });
  }

  await tick(0);

  return {
    dom,
    window,
    document: window.document,
    app: window.__walkthroughApp,
    recorder: window.__walkthroughRecorder,
    storage: storage || window.localStorage,
    async close() { window.close(); }
  };
}

/* 不执行脚本的空白标记页（验证 bootIfWalkthrough 守卫） */
async function loadBarePage(pageMark) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html data-page="' + pageMark + '"><body><button id="x">x</button></body></html>',
    { url: 'https://example.test/other', runScripts: 'outside-only' }
  );
  const ctx = dom.getInternalVMContext();
  vm.runInContext(readAsset('app.js'), ctx, { filename: 'app.js' });
  vm.runInContext(readAsset('recorder.js'), ctx, { filename: 'recorder.js' });
  await tick(0);
  return dom;
}

/* ---------- 交互模拟（派发真实事件，走捕获/冒泡/默认动作全链路） ---------- */

function click(el) {
  const ev = new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView });
  el.dispatchEvent(ev);
}

function focusEl(el) { el.focus(); }
function blurEl(el) { el.blur(); }

function setValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }));
}

/* 真实浏览器中 <select> 选定选项只派发 change（不派发 input） */
function selectOption(el, value) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true }));
}

function scrollTo(el, top) { el.scrollTop = top; }

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function tick(ms) { await wait(ms == null ? 0 : ms); }

/* 等滚动合并（debounce 16ms + 微任务 post 结算） */
async function settleScroll() { await wait(40); await tick(); }

function kinds(recorder) { return recorder.getTrace().steps.map(s => s.kind + ':' + s.target); }

module.exports = {
  loadPage,
  loadBarePage,
  createMemoryStorage,
  click,
  focusEl,
  blurEl,
  setValue,
  selectOption,
  scrollTo,
  wait,
  tick,
  settleScroll,
  kinds
};
