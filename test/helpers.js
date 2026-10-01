'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/* 内存版 storage（jsdom 的 file:// 源禁用 localStorage，真实浏览器不受影响）。 */
function createMemoryStorage(seed) {
  const store = new Map();
  if (seed && typeof seed === 'object') {
    Object.keys(seed).forEach(k => store.set(k, seed[k]));
  }
  return {
    get(key) {
      const raw = store.has(key) ? store.get(key) : null;
      return raw == null ? null : JSON.parse(raw);
    },
    set(key, value) {
      store.set(key, JSON.stringify(value));
    },
    /* 跨“刷新”：把内容序列化出去（与 localStorage 落盘语义一致） */
    serialize() {
      const out = {};
      store.forEach((v, k) => { out[k] = v; });
      return out;
    }
  };
}

async function bootPage(markerPresent, storage) {
  if (markerPresent === undefined) markerPresent = true;
  const dom = await JSDOM.fromFile(path.join(PUBLIC_DIR, 'index.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
  });
  const { window } = dom;
  await new Promise(resolve => window.addEventListener('load', resolve));
  // 等待页面自身的异步回写完成
  await sleep(70);

  if (!markerPresent) {
    // 删除演练页标记 → 录制器自动挂载时应判定“不是本页面”
    const root = window.document.querySelector('[data-walkthrough-page]');
    if (root) root.removeAttribute('data-walkthrough-page');
  }

  const Recorder = require(path.join(PUBLIC_DIR, 'recorder.js')).Recorder;
  // 页面脚本已自动挂载过一个实例；销毁后用可注入的内存 storage 重新挂载
  if (window.__walkthroughRecorder && typeof window.__walkthroughRecorder.destroy === 'function') {
    window.__walkthroughRecorder.destroy();
  }
  delete window.__walkthroughRecorder;
  const recorder = Recorder.attach(window, { storage: storage || createMemoryStorage() });

  return { dom, window, recorder };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* 模拟真实用户：focus → 键入（逐字符 input）→ change。 */
function typeText(window, el, text) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  el.focus();
  for (const ch of text) {
    setter.call(el, el.value + ch);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function click(documentOrWindow, el) {
  el.dispatchEvent(new documentOrWindow.Event('click', { bubbles: true, cancelable: true }));
}

/* jsdom 不会因 scrollTop 赋值自动派发 scroll 事件；真实浏览器会。 */
function userScroll(window, el, pos) {
  el.scrollTop = pos;
  el.dispatchEvent(new window.Event('scroll', { bubbles: false }));
}

module.exports = { bootPage, createMemoryStorage, sleep, typeText, click, userScroll, PUBLIC_DIR };
