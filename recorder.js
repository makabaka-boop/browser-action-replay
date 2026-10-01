/*
 * recorder.js —— 内置交互录制器（只在 data-page="walkthrough" 页面工作）
 *
 * 录制目标：仅带稳定 id 的元素（#id）。
 * 录制动作：click / input / focus / scroll。
 * 每一步保存：
 *   pre   —— 执行前条件（全局快照 + 目标元素快照）
 *   post  —— 执行后可观察状态摘要
 * 密码类输入（input[type=password]）：任何阶段都只保存 {secret:true, empty, changed}，
 *   绝不保存字符。
 * 回放：先把应用重置回初始状态，逐步执行；任何一步出现
 *   “元素缺失 / 前条件不符 / 执行后摘要分歧”，立即停在第一处，
 *   展示录制值与当前值，后续步骤一律标记为 blocked，不得继续。
 * 轨迹经 storage（localStorage）持久化，可跨刷新保存；带会话代号（epoch），
 * 开始新录制或停止回放后，迟到的异步界面更新不会写进旧轨迹。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WalkthroughRecorder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var TRACE_KEY = 'walkthrough.recorder.trace.v1';
  var AUTOPLAY_KEY = 'walkthrough.recorder.autoplay.v1';
  var PANEL_IDS = ['panel-profile', 'panel-security', 'panel-activities'];
  var INPUT_TAGS = { INPUT: 1, TEXTAREA: 1, SELECT: 1 };

  var KIND_LABEL = { click: '点击', input: '输入', focus: '聚焦', scroll: '滚动' };

  /* ------------------------------------------------------------------ */
  /* 存储适配：默认走 localStorage，测试可注入内存存储                     */
  /* ------------------------------------------------------------------ */
  function defaultStorage(win) {
    try {
      var ls = win.localStorage;
      var probe = '__r_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (e) {
      var mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  }

  /* ------------------------------------------------------------------ */
  /* 快照：从 DOM 读取可观察状态                                          */
  /* ------------------------------------------------------------------ */
  function elSnapshot(el, dirtySet) {
    if (!el) return null;
    var tag = el.tagName;
    var type = el.getAttribute('type');
    if (tag === 'INPUT' && type === 'password') {
      return { secret: true, empty: el.value === '', changed: dirtySet.has(el) };
    }
    var snap;
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
      snap = { tag: tag, type: type, checked: el.checked };
    } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
      snap = { tag: tag, type: type || 'text', value: el.value };
    } else if (tag === 'SELECT') {
      snap = { tag: tag, value: el.value };
    } else {
      snap = { tag: tag, text: (el.textContent || '').trim().slice(0, 120) };
    }
    if (el.hasAttribute && el.hasAttribute('data-kind')) snap.kindAttr = el.getAttribute('data-kind');
    if (el.hidden) snap.hidden = true;
    return snap;
  }

  function globalSnapshot(doc, extra) {
    var g = {
      activeId: doc.activeElement && doc.activeElement.id ? doc.activeElement.id : null
    };
    PANEL_IDS.forEach(function (id) {
      var p = doc.getElementById(id);
      g[id] = p ? !p.hidden : null;
    });
    var bump = doc.getElementById('bump-count');
    if (bump) g.bump = bump.textContent.trim();
    var modal = doc.getElementById('modal-root');
    g.modalOpen = modal ? !modal.hidden : null;
    var rebuild = doc.getElementById('modal-rebuild-count');
    g.modalRebuild = rebuild ? rebuild.textContent.trim() : null;
    if (extra) Object.keys(extra).forEach(function (k) { g[k] = extra[k]; });
    return g;
  }

  /* 深比较：返回首个分歧的定位路径，无分歧返回 null */
  function diffObjects(rec, cur, path) {
    path = path || '';
    if (rec === cur) return null;
    if (typeof rec !== typeof cur) return path || '$';
    if (rec === null || cur === null) return path || '$';
    if (typeof rec !== 'object') return path || '$';
    var keys = {};
    Object.keys(rec).forEach(function (k) { keys[k] = 1; });
    Object.keys(cur).forEach(function (k) { keys[k] = 1; });
    var ks = Object.keys(keys).sort();
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i], p = path ? path + '.' + k : k;
      var inR = Object.prototype.hasOwnProperty.call(rec, k);
      var inC = Object.prototype.hasOwnProperty.call(cur, k);
      if (inR !== inC || rec[k] === null || cur[k] === null || typeof rec[k] !== 'object' || typeof cur[k] !== 'object') {
        var rv = inR ? rec[k] : MISSING;
        var cv = inC ? cur[k] : MISSING;
        if (JSON.stringify(rv) !== JSON.stringify(cv)) return p;
      } else {
        var d = diffObjects(rec[k], cur[k], p);
        if (d) return d;
      }
    }
    return null;
  }
  var MISSING = { __missing__: true };

  /* ------------------------------------------------------------------ */
  /* 创建录制器                                                          */
  /* ------------------------------------------------------------------ */
  function createRecorder(win, opts) {
    opts = opts || {};
    var doc = win.document;
    var storage = opts.storage || defaultStorage(win);
    var setTimeoutFn = opts.setTimeout || win.setTimeout.bind(win);
    var clearTimeoutFn = opts.clearTimeout || win.clearTimeout.bind(win);
    var PromiseFn = opts.Promise || win.Promise;

    var ui = { root: doc.getElementById('recorder-root'), panel: null };

    var mode = 'idle';               // 'idle' | 'recording' | 'playing'
    var epoch = 0;                   // 会话代号；每次 start / play 递增
    var trace = { version: VERSION, startedAt: null, steps: [] };
    var baseline = new Map();        // id -> 上一个元素快照（执行前基线）
    var seededNodes = new (win.WeakSet || WeakSet)(); // 已建立基线的节点（识别弹窗重建）
    var dirtySecrets = new (win.WeakSet || WeakSet)();
    var listeners = [];
    var scrollAttached = new (win.WeakSet || WeakSet)();
    var pendingStep = null;          // 已捕获事件、等待 post 结算的步骤
    var knownActiveId = null;        // 上一个步骤结束后的 activeElement id（用于 focus 步骤的“执行前”焦点）
    var scrollTimers = new Map();    // id -> 滚动合并定时器
    var scrollBaseline = new Map();  // id -> 本次滚动序列起始 scrollTop（前值）
    var lastScrollPos = new Map();   // id -> 最近一次观察到的 scrollTop（用于取事件发生前的值）
    var replayResult = null;

    function isWalkthroughPage() {
      return doc.documentElement && doc.documentElement.dataset.page === 'walkthrough';
    }

    function trackedIdFromEvent(ev) {
      var node = ev.target;
      if (!node || node.nodeType !== 1) return null;
      if (node.id && node.id.indexOf('rec-') !== 0 &&
          !(ui.panel && ui.panel.contains && ui.panel.contains(node))) {
        return node.id;
      }
      var host = node.closest && node.closest('[data-track]');
      return host && host.id ? host.id : null;
    }

    function elById(id) { return doc.getElementById(id); }

    /* ---------------------------------------------------------------- */
    /* 基线管理                                                          */
    /* ---------------------------------------------------------------- */
    function seedBaseline(id) {
      var el = elById(id);
      if (!el) return null;
      var old = baseline.get(id);
      /* 节点被重建（弹窗）或第一次遇到：重建基线 */
      if (!old || !seededNodes.has(el)) {
        baseline.set(id, elSnapshot(el, dirtySecrets));
        seededNodes.add(el);
      }
      return el;
    }
    function seedAllBaselines() {
      var all = doc.querySelectorAll('[data-track][id]');
      Array.prototype.forEach.call(all, function (el) { seedBaseline(el.id); });
    }
    function snapshotById(id) {
      return elSnapshot(elById(id), dirtySecrets);
    }
    /* 在事件捕获的最早期调用：保证“执行前”读取到的是应用处理器运行前的值 */
    function ensurePreBaseline(id, kind) {
      seedBaseline(id);
      if (kind === 'scroll') {
        return { scrollTop: scrollBaseline.has(id) ? scrollBaseline.get(id)
                                                  : (lastScrollPos.has(id) ? lastScrollPos.get(id) : currentScroll(id)) };
      }
      return baseline.get(id);
    }
    function refreshBaseline(id) {
      if (scrollTimers.has(id)) return; // 滚动尚未结算，保留滚动前基线
      var el = elById(id);
      if (el) {
        baseline.set(id, elSnapshot(el, dirtySecrets));
        seededNodes.add(el);
      }
    }
    function currentScroll(id) {
      var el = elById(id);
      return el ? (el.scrollTop | 0) : null;
    }

    /* ---------------------------------------------------------------- */
    /* 步骤落盘                                                          */
    /* ---------------------------------------------------------------- */
    function persist() {
      try { storage.setItem(TRACE_KEY, JSON.stringify(trace)); } catch (e) { /* 配额等错误忽略 */ }
    }
    function loadPersistedTrace() {
      try {
        var raw = storage.getItem(TRACE_KEY);
        if (!raw) return null;
        var t = JSON.parse(raw);
        if (t && t.version === VERSION && Array.isArray(t.steps)) return t;
      } catch (e) { /* 损坏轨迹忽略 */ }
      return null;
    }

    function finalizeStep() {
      var t = pendingStep;
      pendingStep = null;
      if (!t) return;
      var el = elById(t.target);
      t.post.el = el ? elSnapshot(el, dirtySecrets) : null;
      t.post.global = globalSnapshot(doc);
      if (t.kind === 'scroll') {
        t.post.el = { scrollTop: currentScroll(t.target) };
      }
      knownActiveId = t.post.global.activeId;
      trace.steps.push(t);
      if (t.kind !== 'scroll') refreshBaseline(t.target);
      persist();
      renderSteps();
    }

    /* ---------------------------------------------------------------- */
    /* 事件捕获（应用监听已先注册；录制器在捕获阶段取“执行前”条件）         */
    /* ---------------------------------------------------------------- */
    function openStep(kind, id, extraPre, extraPost, preGlobalOverride) {
      if (pendingStep) finalizeStep(); // 同一任务内的连续动作：先结算上一步
      var step = {
        seq: trace.steps.length + 1,
        kind: kind,
        target: id,
        pre: {
          global: (function () {
            var g = globalSnapshot(doc);
            if (preGlobalOverride) Object.keys(preGlobalOverride).forEach(function (k) { g[k] = preGlobalOverride[k]; });
            return g;
          })(),
          el: extraPre !== undefined ? extraPre : ensurePreBaseline(id, kind)
        },
        post: { global: null, el: null }
      };
      if (extraPost) Object.keys(extraPost).forEach(function (k) { step.post[k] = extraPost[k]; });
      pendingStep = step;
      /* post 放在微任务里取：本轮任务中应用处理器（含同任务派发的 input 事件）已执行完 */
      PromiseFn.resolve().then(function () {
        if (pendingStep === step) finalizeStep();
      });
    }

    var programmaticClick = null; // 回放/测试中 el.click() 期间被程序化触发的后续 input

    function onClickCapture(ev) {
      if (mode !== 'recording') return;
      var id = trackedIdFromEvent(ev);
      if (!id || id.indexOf('rec-') === 0) return;
      var el = elById(id);
      if (!el) return;
      var isCheckable = el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
      if (isCheckable) {
        programmaticClick = el; // 同任务里该控件随后触发的 input 不重复录步骤
        PromiseFn.resolve().then(function () {
          if (programmaticClick === el) programmaticClick = null;
        });
      }
      openStep('click', id);
    }

    function onInputCapture(ev) {
      if (mode !== 'recording') return;
      var id = trackedIdFromEvent(ev);
      if (!id) return;
      var el = elById(id);
      if (!el) return;
      if (el.type === 'password') dirtySecrets.add(el); // 只打“已改变”标记，字符永不落盘
      if (programmaticClick === el) return; // checkbox 的值变化并入 click 步骤
      openStep('input', id);
    }

    var lastFocusSeen = null; // 同一聚焦动作可能同时冒泡 focusin 与 focus：去重

    function onChangeCapture(ev) {
      if (mode !== 'recording') return;
      var el = ev.target;
      /* 真实浏览器里 <select> 只派发 change；checkbox/radio 的变化已并入 click 步骤 */
      if (!el || el.tagName !== 'SELECT') return;
      var id = trackedIdFromEvent(ev);
      if (!id) return;
      openStep('input', id);
    }

    function onFocusCapture(ev) {
      if (mode !== 'recording') return;
      var id = trackedIdFromEvent(ev);
      if (!id) return;
      /* focus 事件触发时 activeElement 通常已是新焦点；前条件用上一步结束时的焦点 */
      var priorActive = knownActiveId !== null ? knownActiveId
                        : (doc.activeElement && doc.activeElement.id !== id ? doc.activeElement.id : null);
      /* focusin/focus 为同一动作的成对事件：若已有同目标 focus 步骤待结算则跳过 */
      if (pendingStep && pendingStep.kind === 'focus' && pendingStep.target === id) return;
      var sig = id + '|' + priorActive;
      if (lastFocusSeen === sig) return;
      lastFocusSeen = sig;
      openStep('focus', id, undefined, undefined, { activeId: priorActive });
    }

    function onScrollCapture(ev) {
      if (mode !== 'recording') return;
      var el = ev.target;
      if (!el || !el.id) return;
      var id = el.id;
      /* scroll 事件在 scrollTop 已变为新值后才触发；用上次观察值作为“执行前”位置 */
      var from = lastScrollPos.has(id) ? lastScrollPos.get(id) : (el.scrollTop | 0);
      lastScrollPos.set(id, el.scrollTop | 0);
      if (!scrollBaseline.has(id)) scrollBaseline.set(id, from);
      if (scrollTimers.has(id)) clearTimeoutFn(scrollTimers.get(id));
      scrollTimers.set(id, setTimeoutFn(function () {
        if (mode !== 'recording') { scrollTimers.delete(id); scrollBaseline.delete(id); return; }
        scrollTimers.delete(id);
        var from0 = scrollBaseline.get(id);
        scrollBaseline.delete(id);
        var to = currentScroll(id);
        lastScrollPos.set(id, to);
        if (from0 === to) return;
        openStep('scroll', id, { scrollTop: from0 }, { recorded: { from: from0, to: to } });
      }, opts.scrollDebounce == null ? 16 : opts.scrollDebounce));
    }

    function attachScrollTargets() {
      /* scroll 事件不冒泡，必须直接挂到滚动元素上 */
      var boxes = doc.querySelectorAll('[data-kind="scroll"]');
      Array.prototype.forEach.call(boxes, function (box) {
        if (!box.id || scrollAttached.has(box)) return;
        scrollAttached.add(box);
        add(box, 'scroll', onScrollCapture, true);
      });
    }

    function attach() {
      add(doc, 'click', onClickCapture, true);
      add(doc, 'input', onInputCapture, true);
      add(doc, 'change', onChangeCapture, true);
      add(doc, 'focusin', onFocusCapture, true);
      add(doc, 'focus', onFocusCapture, true); // 兼容不冒泡 focusin 的环境
      attachScrollTargets();
      buildUI();
    }

    function add(target, type, fn, capture) {
      target.addEventListener(type, fn, capture);
      listeners.push([target, type, fn, capture]);
    }
    function detach() {
      listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], l[3]); });
      listeners = [];
    }

    function flushPending(reasonEpoch) {
      if (reasonEpoch !== epoch) return;          // 旧会话：任何迟到结果一律丢弃
      if (scrollTimers.size) {
        scrollTimers.forEach(function (handle) { clearTimeoutFn(handle); });
        scrollTimers.forEach(function (handle, id) {
          scrollTimers.delete(id);
          var from = scrollBaseline.get(id);
          scrollBaseline.delete(id);
          var to = currentScroll(id);
          lastScrollPos.set(id, to);
          if (from == null || from === to) return;
          openStep('scroll', id, { scrollTop: from }, { recorded: { from: from, to: to } });
        });
      }
      if (pendingStep) finalizeStep();
    }

    /* ---------------------------------------------------------------- */
    /* 录制控制                                                          */
    /* ---------------------------------------------------------------- */
    function start() {
      if (!isWalkthroughPage()) throw new Error('录制器只在演练页面工作');
      if (mode === 'playing') throw new Error('回放进行中不能开始新录制');
      epoch += 1;
      mode = 'recording';
      trace = { version: VERSION, startedAt: new Date().toISOString(), steps: [] };
      baseline = new Map();
      seededNodes = new (win.WeakSet || WeakSet)();
      dirtySecrets = new (win.WeakSet || WeakSet)();
      pendingStep = null;
      knownActiveId = doc.activeElement && doc.activeElement.id ? doc.activeElement.id : null;
      lastFocusSeen = null;
      scrollTimers.forEach(function (h) { clearTimeoutFn(h); });
      scrollTimers = new Map();
      scrollBaseline = new Map();
      lastScrollPos = new Map();
      replayResult = null;
      attachScrollTargets();
      seedAllBaselines();
      var boxes0 = doc.querySelectorAll('[data-kind="scroll"][id]');
      Array.prototype.forEach.call(boxes0, function (b) { lastScrollPos.set(b.id, b.scrollTop | 0); });
      persist();
      renderAll();
      return trace;
    }

    function stop() {
      var stoppedEpoch = epoch;
      flushPending(stoppedEpoch);
      if (mode === 'recording') mode = 'idle';
      /* epoch 不变：之后若同一轨迹再 start 会进入新代号；旧代号的迟到微任务全部失效 */
      renderAll();
    }

    function clearTrace() {
      epoch += 1;
      mode = 'idle';
      trace = { version: VERSION, startedAt: null, steps: [] };
      replayResult = null;
      storage.removeItem(TRACE_KEY);
      renderAll();
    }

    /* ---------------------------------------------------------------- */
    /* 回放                                                              */
    /* ---------------------------------------------------------------- */
    function play(playOpts) {
      playOpts = playOpts || {};
      if (!isWalkthroughPage()) return PromiseFn.reject(new Error('录制器只在演练页面工作'));
      if (mode === 'recording') throw new Error('录制中不能回放');
      var steps = playOpts.steps || trace.steps;
      if (!steps || !steps.length) return PromiseFn.resolve({ status: 'empty', index: -1, steps: [] });

      epoch += 1;
      var playEpoch = epoch;
      mode = 'playing';
      dirtySecrets = new (win.WeakSet || WeakSet)(); // 回放从初始空状态开始，重放“已改变”
      replayResult = null;
      renderAll();

      var stepDelay = playOpts.delay == null ? 0 : playOpts.delay;
      var app = win.__walkthroughApp;

      var reports = steps.map(function (s) { return { seq: s.seq, kind: s.kind, target: s.target, status: 'pending' }; });
      renderSteps(reports);

      return PromiseFn.resolve()
        .then(function () { return playOpts.reset === false ? null : (app ? app.reset() : null); })
        .then(function () {
          return runSteps(0);
        });

      function runSteps(i) {
        if (i >= steps.length) {
          if (playEpoch !== epoch) return null; // 已被停止：结果作废
          mode = 'idle';
          replayResult = { status: 'ok', index: -1, steps: reports };
          renderAll();
          return replayResult;
        }
        if (playEpoch !== epoch) return null;   // 已停止回放：后续步骤绝不执行
        var step = steps[i];

        /* 1) 目标元素缺失检查 */
        var targetEl = elById(step.target);
        if (!targetEl) {
          return fail(i, step, 'missing',
            { exists: false, snapshot: null },
            { exists: false, snapshot: null });
        }

        /* 2) 执行前条件核对（元素 + 全局） */
        var curPreEl = elSnapshot(targetEl, dirtySecrets);
        var elDiff = step.kind === 'scroll'
          ? diffObjects(step.pre.el, { scrollTop: currentScroll(step.target) }, 'el')
          : diffObjects(step.pre.el, curPreEl, 'el');
        if (elDiff) {
          return fail(i, step, 'pre-element', step.pre.el, curPreEl, elDiff);
        }
        var curPreGlobal = globalSnapshot(doc);
        var gDiff = diffObjects(step.pre.global, curPreGlobal, 'global');
        if (gDiff) {
          return fail(i, step, 'pre-global', step.pre.global, curPreGlobal, gDiff);
        }

        /* 3) 执行动作 */
        try {
          executeStep(step, targetEl);
        } catch (err) {
          return fail(i, step, 'execution-error', String(step && (step.recorded || '')), String(err && err.message || err));
        }
        reports[i].status = 'running';
        renderSteps(reports);

        return wait(stepDelay).then(function () {
          if (playEpoch !== epoch) return null;

          /* 4) 执行后可观察摘要核对 */
          var afterEl = elById(step.target);
          var postEl = step.kind === 'scroll'
            ? { scrollTop: afterEl ? (afterEl.scrollTop | 0) : null }
            : (afterEl ? elSnapshot(afterEl, dirtySecrets) : null);
          var expectedPostEl = step.kind === 'scroll'
            ? { scrollTop: step.post.el && step.post.el.scrollTop }
            : step.post.el;
          var pdEl = diffObjects(expectedPostEl, postEl, 'el');
          if (pdEl) return fail(i, step, 'post-element', expectedPostEl, postEl, pdEl);

          var postGlobal = globalSnapshot(doc);
          var pdG = diffObjects(step.post.global, postGlobal, 'global');
          if (pdG) return fail(i, step, 'post-global', step.post.global, postGlobal, pdG);

          reports[i].status = 'done';
          renderSteps(reports);
          return runSteps(i + 1);
        });
      }

      function fail(index, step, reason, recordedValue, currentValue, where) {
        reports[index].status = 'fail';
        for (var j = index + 1; j < reports.length; j++) reports[j].status = 'blocked';
        mode = 'idle';
        replayResult = {
          status: 'stopped',
          index: index,
          reason: reason,
          where: where || null,
          recordedValue: recordedValue,
          currentValue: currentValue,
          step: step,
          steps: reports
        };
        renderAll();
        return replayResult;
      }
    }

    function executeStep(step, el) {
      if (step.kind === 'click') {
        var tag = el.tagName;
        var t = el.getAttribute('type');
        if (tag === 'INPUT' && (t === 'checkbox' || t === 'radio')) {
          el.checked = !el.checked; // 录制是对旧值取反
          dispatchNative(el, 'input');
          dispatchNative(el, 'change');
        } else {
          el.click();
        }
      } else if (step.kind === 'input') {
        if (el.type === 'password') {
          /* 回放不使用真实字符：打脏标记并派发事件，效果同样是“已改变” */
          dirtySecrets.add(el);
          setNativeValue(el, el.value === '' ? 'replay-secret-placeholder' : '');
        } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          el.checked = !!step.post.el.checked;
          dispatchNative(el, 'input');
          dispatchNative(el, 'change');
        } else {
          var want = step.post.el && step.post.el.value;
          setNativeValue(el, want == null ? '' : want);
        }
      } else if (step.kind === 'focus') {
        el.focus();
      } else if (step.kind === 'scroll') {
        var wantTop = step.post.el && step.post.el.scrollTop;
        el.scrollTop = wantTop | 0; // jsdom 合成访问器会派发 scroll；录制器 mode 已为 playing，不会录
      }
    }

    function dispatchNative(el, type) {
      var Ctor = win.Event;
      var ev;
      try { ev = new Ctor(type, { bubbles: true }); }
      catch (e) { ev = doc.createEvent('Event'); ev.initEvent(type, true, false); }
      el.dispatchEvent(ev);
    }
    function setNativeValue(el, value) {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      dispatchNative(el, 'input');
      if (el.tagName === 'SELECT') dispatchNative(el, 'change');
    }

    function wait(ms) {
      return new PromiseFn(function (resolve) { setTimeoutFn(resolve, ms); });
    }

    function stopPlayback() {
      /* 停止回放：换代号，挂起的异步回调全部作废，绝不可能再写入旧轨迹/继续后续步骤 */
      epoch += 1;
      mode = 'idle';
      replayResult = replayResult || { status: 'aborted', index: -1, steps: [] };
      renderAll();
    }

    /* ---------------------------------------------------------------- */
    /* 持久化 / 跨刷新自动回放                                            */
    /* ---------------------------------------------------------------- */
    function restoreTrace() {
      var t = loadPersistedTrace();
      if (t) trace = t;
      return t;
    }
    function enableAutoplay() { storage.setItem(AUTOPLAY_KEY, '1'); }
    function autoplayRequested() { return storage.getItem(AUTOPLAY_KEY) === '1'; }
    function consumeAutoplay() { storage.removeItem(AUTOPLAY_KEY); }

    /* ---------------------------------------------------------------- */
    /* 录制器 UI                                                          */
    /* ------------------------------------------------------------------ */
    function el(tag, attrs, text) {
      var n = doc.createElement(tag);
      if (attrs) Object.keys(attrs).forEach(function (k) {
        if (k === 'className') n.className = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
      if (text != null) n.textContent = text;
      return n;
    }

    function buildUI() {
      var root = ui.root;
      if (!root || root.__built) return;
      root.__built = true;

      var box = el('div', { className: 'recorder', id: 'rec-panel' });
      var bar = el('div', { className: 'rec-bar' });
      bar.appendChild(el('span', { className: 'rec-dot' }));
      bar.appendChild(el('span', { className: 'rec-title' }, '交互录制器'));
      var status = el('span', { className: 'rec-status', id: 'rec-status' });
      bar.appendChild(status);
      bar.appendChild(el('span', { className: 'rec-spacer' }));

      var btnStart = el('button', { type: 'button', className: 'rec-btn go', id: 'rec-start' }, '开始录制');
      var btnStop = el('button', { type: 'button', className: 'rec-btn danger', id: 'rec-stop' }, '停止录制');
      var btnPlay = el('button', { type: 'button', className: 'rec-btn', id: 'rec-play' }, '回放');
      var btnStopPlay = el('button', { type: 'button', className: 'rec-btn danger', id: 'rec-stop-play' }, '停止回放');
      var btnClear = el('button', { type: 'button', className: 'rec-btn', id: 'rec-clear' }, '清除轨迹');
      [btnStart, btnStop, btnPlay, btnStopPlay, btnClear].forEach(function (b) { bar.appendChild(b); });
      box.appendChild(bar);

      var steps = el('div', { className: 'rec-steps', id: 'rec-steps' });
      box.appendChild(steps);

      var diff = el('div', { className: 'rec-diff', id: 'rec-diff' });
      box.appendChild(diff);

      root.appendChild(box);
      ui.panel = box;

      btnStart.addEventListener('click', function () { try { start(); } catch (e) { flashStatus(e.message); } });
      btnStop.addEventListener('click', stop);
      btnPlay.addEventListener('click', function () {
        play().catch(function (e) { flashStatus(e.message); });
      });
      btnStopPlay.addEventListener('click', stopPlayback);
      btnClear.addEventListener('click', clearTrace);

      renderAll();
    }

    function flashStatus(msg) {
      var s = doc.getElementById('rec-status');
      if (!s) return;
      s.textContent = msg;
    }

    function stepText(s) {
      var tail = '';
      if (s.kind === 'scroll') {
        var r = s.recorded || (s.post.el ? { from: s.pre.el.scrollTop, to: s.post.el.scrollTop } : null);
        tail = r ? (' #' + s.target + '  ' + r.from + 'px → ' + r.to + 'px') : '';
      } else {
        tail = ' #' + s.target;
      }
      return KIND_LABEL[s.kind] + tail;
    }

    function renderSteps(reports) {
      var box = doc.getElementById('rec-steps');
      if (!box) return;
      box.innerHTML = '';
      var list = reports || trace.steps.map(function (s) {
        return { seq: s.seq, kind: s.kind, target: s.target, status: mode === 'recording' ? 'recorded' : 'idle' };
      });
      if (!list.length) {
        box.appendChild(el('div', { className: 'rec-empty' }, '尚无步骤。点击“开始录制”，然后操作页面。'));
        return;
      }
      list.forEach(function (r, i) {
        var row = el('div', { className: 'rec-step ' + (r.status || '') });
        row.appendChild(el('span', { className: 'idx' }, String(i + 1) + '.'));
        row.appendChild(el('span', { className: 'kind' }, KIND_LABEL[r.kind]));
        var s = trace.steps[i];
        var label = '#' + r.target;
        if (r.kind === 'scroll' && s) {
          label += '  ' + (s.recorded ? s.recorded.from + 'px → ' + s.recorded.to : (s.pre.el.scrollTop + 'px'));
        }
        if (r.status === 'blocked') label += '（已阻止，未执行）';
        if (r.status === 'fail') label += '（停在此处）';
        row.appendChild(el('span', { className: 'desc' }, label));
        box.appendChild(row);
      });
    }

    function renderDiff() {
      var box = doc.getElementById('rec-diff');
      if (!box) return;
      box.innerHTML = '';
      box.className = 'rec-diff';
      if (!replayResult) return;

      if (replayResult.status === 'ok') {
        box.classList.add('show', 'ok');
        box.appendChild(el('h4', null, '✔ 回放完成：全部 ' + trace.steps.length + ' 步的前条件与执行后摘要均一致。'));
        return;
      }
      if (replayResult.status === 'aborted') {
        box.classList.add('show');
        box.appendChild(el('h4', null, '■ 回放已手动停止，后续步骤未执行。'));
        return;
      }
      if (replayResult.status === 'empty') return;

      var reasonMap = {
        'missing': '目标元素缺失',
        'pre-element': '执行前条件不符（目标元素状态）',
        'pre-global': '执行前条件不符（全局状态）',
        'post-element': '执行后状态摘要分歧（目标元素）',
        'post-global': '执行后状态摘要分歧（全局状态）',
        'execution-error': '动作执行出错'
      };
      var r = replayResult;
      box.classList.add('show');
      var h = el('h4', null, '■ 回放停在第 ' + (r.index + 1) + ' 步（' + KIND_LABEL[r.step.kind] +
        ' #' + r.step.target + '）：' + reasonMap[r.reason] +
        (r.where ? '，分歧定位 → ' + r.where : ''));
      box.appendChild(h);
      box.appendChild(el('div', { className: 'where' }, '后续步骤已全部阻止，不会产生看似成功的回放结果。'));
      box.appendChild(el('div', null, '录制值（录制时保存）：'));
      box.appendChild(el('pre', null, safeJson(r.recordedValue)));
      box.appendChild(el('div', null, '当前值（回放现场观察到）：'));
      box.appendChild(el('pre', null, safeJson(r.currentValue)));
    }

    function safeJson(v) {
      try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
    }

    function renderAll() {
      var panel = doc.getElementById('rec-panel');
      if (panel) panel.className = 'recorder' + (mode === 'recording' ? ' recording' : mode === 'playing' ? ' playing' : '');
      var status = doc.getElementById('rec-status');
      if (status) {
        status.textContent = mode === 'recording'
          ? '录制中… 已记录 ' + trace.steps.length + ' 步（会话 #' + epoch + '）'
          : mode === 'playing'
            ? '回放中…（会话 #' + epoch + '）'
            : '空闲 · 已保存 ' + trace.steps.length + ' 步';
      }
      var toggles = {
        'rec-start': mode === 'idle',
        'rec-stop': mode === 'recording',
        'rec-play': mode === 'idle' && trace.steps.length > 0,
        'rec-stop-play': mode === 'playing',
        'rec-clear': mode === 'idle'
      };
      Object.keys(toggles).forEach(function (id) {
        var b = doc.getElementById(id);
        if (b) b.disabled = !toggles[id];
      });
      renderSteps();
      renderDiff();
    }

    /* ---------------------------------------------------------------- */
    /* 生命周期                                                          */
    /* ---------------------------------------------------------------- */
    var attached = false;
    function init() {
      if (!isWalkthroughPage()) return null;
      if (attached) return api;
      attached = true;
      restoreTrace();
      attach();
      return api;
    }
    var api = {
      version: VERSION,
      init: init,
      start: start,
      stop: stop,
      play: play,
      stopPlayback: stopPlayback,
      clear: clearTrace,
      getTrace: function () { return trace; },
      getMode: function () { return mode; },
      getEpoch: function () { return epoch; },
      getResult: function () { return replayResult; },
      enableAutoplay: enableAutoplay,
      consumeAutoplay: consumeAutoplay,
      autoplayRequested: autoplayRequested,
      /* 测试辅助 */
      _internals: function () { return { flushPending: function () { flushPending(epoch); }, finalizeStep: finalizeStep }; }
    };
    return api;
  }

  /* 只在演练页面自启动；其它页面不创建录制器、不绑定任何事件 */
  function bootIfWalkthrough(win, opts) {
    var doc = win.document;
    if (!doc.documentElement || doc.documentElement.dataset.page !== 'walkthrough') return null;
    if (win.__walkthroughRecorder) return win.__walkthroughRecorder;
    var recorder = createRecorder(win, opts || {});
    win.__walkthroughRecorder = recorder;
    recorder.init();
    if (recorder.autoplayRequested()) {
      recorder.consumeAutoplay();
      win.setTimeout(function () {
        if (recorder.getMode() === 'idle') recorder.play().catch(function () { /* 界面按钮可见错误 */ });
      }, 30);
    }
    return recorder;
  }

  return { createRecorder: createRecorder, bootIfWalkthrough: bootIfWalkthrough, version: VERSION };
});

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  try { window.WalkthroughRecorder.bootIfWalkthrough(window); } catch (e) { /* 非演练页面静默 */ }
}
