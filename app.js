/*
 * app.js —— 内置演练页面的演示应用
 * 提供：标签页、表单、可重建弹窗、可滚动区域、以及“迟到的异步界面更新”。
 * 通过 UMD 暴露：浏览器下为 window.WalkthroughApp；Node 下为 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WalkthroughApp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PANELS = ['panel-profile', 'panel-security', 'panel-activities'];

  function createApp(doc, opts) {
    opts = opts || {};
    var win = opts.window || (doc.defaultView || (typeof window !== 'undefined' ? window : null));
    var setTimeoutFn = opts.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    var clearTimeoutFn = opts.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);

    var els = {
      tabs: {
        profile: doc.getElementById('tab-profile'),
        security: doc.getElementById('tab-security'),
        activities: doc.getElementById('tab-activities')
      },
      panels: {
        profile: doc.getElementById('panel-profile'),
        security: doc.getElementById('panel-security'),
        activities: doc.getElementById('panel-activities')
      },
      form: doc.getElementById('demo-form'),
      bumpBtn: doc.getElementById('bump-btn'),
      bumpCount: doc.getElementById('bump-count'),
      openModal: doc.getElementById('open-modal'),
      asyncClose: doc.getElementById('async-close'),
      modalRoot: doc.getElementById('modal-root'),
      scrollBox: doc.getElementById('scroll-box'),
      scrollContent: doc.getElementById('scroll-content')
    };

    var state = { activeTab: 'profile', bump: 0, modalOpen: false, rebuild: 0 };
    var pendingTimers = [];

    /* ---- 滚动区域内容 ---- */
    if (els.scrollContent && !els.scrollContent.childNodes.length) {
      var frag = doc.createDocumentFragment();
      for (var i = 1; i <= 30; i++) {
        var p = doc.createElement('p');
        p.textContent = '滚动占位行 ' + i + '：录制器会合并滚动并记录停止时的滚动像素值。';
        frag.appendChild(p);
      }
      els.scrollContent.appendChild(frag);
    }

    /*
     * jsdom 不做布局，scrollTop 读写恒为 0 且不会派发 scroll 事件。
     * 在这类无布局环境里为滚动盒补一个可观察的 scrollTop 访问器；
     * 真实浏览器中原生工作，不做任何替换（特性可通过 opts.nativeLayout: true 强制）。
     * 注意：不能用脱离文档的探针元素探测——真实浏览器里离屏元素的 scrollTop 同样恒为 0。
     */
    (function installSyntheticScrollIfNeeded() {
      var hasNativeLayout = opts.nativeLayout === true ||
        (opts.nativeLayout !== false && !/jsdom/i.test(win.navigator && win.navigator.userAgent || ''));
      if (hasNativeLayout) return;
      var box = els.scrollBox;
      var top = 0;
      Object.defineProperty(box, 'scrollTop', {
        configurable: true,
        get: function () { return top; },
        set: function (v) {
          v = Math.max(0, v | 0);
          if (v !== top) {
            top = v;
            var view = box.ownerDocument.defaultView;
            var ev = view && view.Event ? new view.Event('scroll', { bubbles: false })
                                       : doc.createEvent('Event');
            if (!view || !view.Event) ev.initEvent('scroll', false, false);
            box.dispatchEvent(ev);
          }
        }
      });
    })();

    function setTab(name) {
      state.activeTab = name;
      Object.keys(els.tabs).forEach(function (key) {
        els.tabs[key].setAttribute('aria-selected', key === name ? 'true' : 'false');
      });
      Object.keys(els.panels).forEach(function (key) {
        var panel = els.panels[key];
        if (panel) panel.hidden = key !== name;
      });
    }

    function renderModal() {
      var root = els.modalRoot;
      root.hidden = false;
      /* 每次渲染都重建全部内部节点，节点 id 保持稳定 */
      root.innerHTML =
        '<div class="modal-scrim" id="modal-scrim">' +
        '  <div class="modal-card" id="modal-card" role="dialog" aria-modal="true">' +
        '    <h3 id="modal-title">示例弹窗</h3>' +
        '    <p class="meta">打开/重建次数：<span id="modal-rebuild-count">' + state.rebuild + '</span>' +
        '       （每次“重建”都会销毁并重新创建内部节点，但 ID 不变）</p>' +
        '    <div class="btn-row">' +
        '      <button type="button" class="btn" id="modal-rebuild" data-track>重建弹窗内部 DOM</button>' +
        '      <button type="button" class="btn primary" id="modal-confirm" data-track>确认</button>' +
        '      <button type="button" class="btn warn" id="modal-close" data-track>关闭</button>' +
        '    </div>' +
        '  </div>' +
        '</div>';
    }

    function openModal() {
      state.modalOpen = true;
      state.rebuild += 1;
      renderModal();
    }

    function closeModal() {
      state.modalOpen = false;
      els.modalRoot.hidden = true;
      els.modalRoot.innerHTML = '';
    }

    function rebuildModal() {
      state.rebuild += 1;
      renderModal();
    }

    function onModalClick(ev) {
      var id = ev.target && ev.target.id;
      if (id === 'modal-close' || id === 'modal-confirm' || id === 'modal-scrim') {
        closeModal();
      } else if (id === 'modal-rebuild') {
        rebuildModal();
      }
    }

    function scheduleAsyncClose() {
      if (!setTimeoutFn) return;
      var handle = setTimeoutFn(function () {
        /* 迟到的异步界面更新：即使录制/回放已经结束，它仍可能触发 */
        if (state.modalOpen) closeModal();
      }, 120);
      pendingTimers.push(handle);
    }

    /* ---- 事件绑定（应用自己的监听先于录制器注册） ---- */
    Object.keys(els.tabs).forEach(function (key) {
      els.tabs[key].addEventListener('click', function () { setTab(key); });
    });
    els.bumpBtn.addEventListener('click', function () {
      state.bump += 1;
      els.bumpCount.textContent = String(state.bump);
    });
    els.openModal.addEventListener('click', openModal);
    els.asyncClose.addEventListener('click', scheduleAsyncClose);
    els.modalRoot.addEventListener('click', onModalClick);

    function reset() {
      pendingTimers.forEach(function (h) { clearTimeoutFn && clearTimeoutFn(h); });
      pendingTimers = [];
      if (els.form && typeof els.form.reset === 'function') els.form.reset();
      state.bump = 0;
      els.bumpCount.textContent = '0';
      state.rebuild = 0;
      closeModal();
      setTab('profile');
      try { els.scrollBox.scrollTop = 0; } catch (e) { /* 忽略 */ }
      if (doc.activeElement && typeof doc.activeElement.blur === 'function') doc.activeElement.blur();
      return Promise.resolve();
    }

    return {
      version: '1.0.0',
      reset: reset,
      getState: function () { return { activeTab: state.activeTab, bump: state.bump, modalOpen: state.modalOpen, rebuild: state.rebuild }; }
    };
  }

  /* 仅在演练页面自启动；其它页面完全不工作 */
  function bootIfWalkthrough(win) {
    var doc = win.document;
    if (!doc.documentElement || doc.documentElement.dataset.page !== 'walkthrough') return null;
    if (win.__walkthroughApp) return win.__walkthroughApp;
    var app = createApp(doc);
    win.__walkthroughApp = app;
    return app;
  }

  return { createApp: createApp, bootIfWalkthrough: bootIfWalkthrough, version: '1.0.0' };
});

/* 浏览器直挂 <script> 时：尝试自启动（Node/require 环境下无 window，跳过） */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try { window.WalkthroughApp.bootIfWalkthrough(window); } catch (e) { /* 页面不匹配时静默 */ }
}
