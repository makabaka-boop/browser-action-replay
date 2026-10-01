/* 交互录制器 —— 只在带 data-walkthrough-page 标记的演练页工作。
 *
 * 录制：click / input / focus / scroll；目标一律使用稳定元素 ID。
 * 每一步保存：
 *   pre  —— 执行前条件（完整状态摘要，含按本步修正过的字段/焦点/滚动值）
 *   post —— 执行后可观察状态摘要（settleMs 后采集，吸收异步回写）
 * 密码字段在任何摘要/轨迹中都只出现 {type:'password', changed:boolean}。
 *
 * 回放：复位到初始状态 → 逐步核对 pre → 执行 → 等待与录制相同的沉淀时间 → 核对 post；
 *      元素缺失 / pre 不符 / post 不符，停在第一处，展示录制值与当前值，
 *      且不会继续执行后续步骤。
 *
 * 会话令牌（session）：开始新录制或停止回放都会令令牌作废并递增，
 * 任何迟到的异步回调/界面更新都不可能再写进旧轨迹。 */
(function () {
  'use strict';

  var STORAGE_KEY = 'walkthrough-recorder:tracks:v1';
  var SETTLE_MS = 60;      // 录制后等待异步界面回写的时间（应用自身延迟为 30ms）
  var SCROLL_DEBOUNCE_MS = 100;
  var PAGE_MARKER = 'data-walkthrough-page';
  var PASSWORD_REPLAY_PLACEHOLDER = 'wt-replay-placeholder'; // 仅回放时瞬时使用，绝不入库

  // ---------------------------------------------------------------- 工具
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /* 深度相等的“第一处分歧”：返回 {path, recorded, current}，一致返回 null。
   * 对象按键名字典序遍历，保证报告稳定、可定位到首个分歧字段。 */
  function firstDiff(recorded, current, path) {
    path = path || '';
    if (recorded === current) return null;

    var rt = typeOf(recorded), ct = typeOf(current);
    if (rt !== ct || rt === 'null' || rt === 'string' || rt === 'number' ||
        rt === 'boolean' || rt === 'undefined') {
      return { path: path || '$', recorded: recorded, current: current };
    }
    if (rt === 'array') {
      var n = Math.max(recorded.length, current.length);
      for (var i = 0; i < n; i++) {
        var d = firstDiff(recorded[i], current[i], path + '[' + i + ']');
        if (d) return d;
      }
      return null;
    }
    var keys = Object.keys(recorded).concat(Object.keys(current))
      .filter(function (k, idx, arr) { return arr.indexOf(k) === idx; })
      .sort();
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var d2 = firstDiff(recorded[key], current[key], path ? path + '.' + key : key);
      if (d2) return d2;
    }
    return null;
  }

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function valueAtPath(obj, path) {
    if (!path || path === '$') return obj;
    var cur = obj;
    var parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  // ---------------------------------------------------------------- 状态摘要
  function encodeFieldValue(el) {
    if (el.type === 'password') {
      // 只记录是否相对默认值发生过改变，绝不接触字符内容
      return { type: 'password', changed: el.value !== el.defaultValue };
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      return { type: 'check', checked: !!el.checked };
    }
    return String(el.value);
  }

  /* 可观察状态摘要：焦点、标签页、弹窗、各字段值、文本节点、滚动位置。
   * 只收集带稳定 ID 的元素；弹窗重建后节点是新的，但 ID 不变，摘要连续。 */
  function buildSnapshot(win, root) {
    var doc = win.document;
    var snap = {
      activeId: null,
      tabs: {},
      modal: { open: false, version: 0 },
      values: {},
      text: {},
      scroll: { window: 0, byId: {} }
    };

    if (doc.activeElement && doc.activeElement.id && root.contains(doc.activeElement)) {
      snap.activeId = doc.activeElement.id;
    }

    Array.prototype.forEach.call(root.querySelectorAll('[role="tab"]'), function (t) {
      if (t.id) snap.tabs[t.id] = t.getAttribute('aria-selected') === 'true';
    });

    var overlay = root.querySelector('[data-modal-overlay]');
    if (overlay) {
      snap.modal.open = !overlay.classList.contains('wt-hidden');
      snap.modal.version = parseInt(overlay.getAttribute('data-modal-version') || '0', 10) || 0;
    }

    Array.prototype.forEach.call(root.querySelectorAll('input, textarea, select'), function (el) {
      if (el.id) snap.values[el.id] = encodeFieldValue(el);
    });

    Array.prototype.forEach.call(root.querySelectorAll('[data-snapshot-text]'), function (el) {
      if (el.id) snap.text[el.id] = el.textContent;
    });

    snap.scroll.window = Math.round(win.scrollY || doc.documentElement.scrollTop || 0);
    Array.prototype.forEach.call(root.querySelectorAll('[data-snapshot-scroll]'), function (el) {
      if (el.id) snap.scroll.byId[el.id] = Math.round(el.scrollTop || 0);
    });

    return snap;
  }

  // ---------------------------------------------------------------- 录制器
  function Recorder(win, options) {
    options = options || {};
    this.win = win;
    this.doc = win.document;
    this.storage = options.storage || null;
    this.settleMs = options.settleMs != null ? options.settleMs : SETTLE_MS;

    this.root = this.doc.querySelector('[' + PAGE_MARKER + ']');
    this.tracks = [];
    // 页面守卫：目标演练页标记不存在 → 录制器不挂载、不工作
    if (!this.root) {
      this.pagePresent = false;
      return;
    }
    this.pagePresent = true;
    this.pageId = this.root.getAttribute(PAGE_MARKER);
    if (!this.storage) this.storage = this._defaultStorage();

    this.mode = 'idle';          // 'idle' | 'recording' | 'playing'
    this.session = 0;            // 每次开始/停止递增；废弃所有持有旧令牌的迟到回调
    this.tracks = this._loadTracks();
    this.activeTrack = this.tracks.length ? this.tracks[this.tracks.length - 1] : null;

    this.pending = null;         // 尚未定稿的主步骤 {step, settleMs, timer, session}
    this.pendingFocus = null;    // 可能并入后续输入/点击的焦点 {id, step, timer}
    this.lastPost = null;        // 上一步定稿后的摘要（下一步 pre 的基线）
    this.lastReplayed = -1;
    this.halt = null;
    this.playToken = 0;

    this._bindEvents();
    this._mountPanel();
    this._renderPanel();
  }

  Recorder.prototype._defaultStorage = function () {
    var win = this.win, key = STORAGE_KEY;
    return {
      get: function () {
        try {
          var raw = win.localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      },
      set: function (v) {
        try { win.localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 忽略配额错误 */ }
      }
    };
  };

  Recorder.prototype._loadTracks = function () {
    var data = this.storage.get(STORAGE_KEY);
    return Array.isArray(data) ? data : [];
  };

  Recorder.prototype._save = function () {
    this.storage.set(STORAGE_KEY, this.tracks);
  };

  // ------------------------------------------------ 事件绑定（capture 阶段）
  Recorder.prototype._bindEvents = function () {
    var self = this;
    var root = self.root;

    self._handlers = [];
    function onRoot(type, fn) {
      var bound = fn;
      root.addEventListener(type, bound, true);
      self._handlers.push({ target: root, type: type, fn: bound, capture: true });
    }
    function onWin(type, fn) {
      var bound = fn;
      self.win.addEventListener(type, bound, true);
      self._handlers.push({ target: self.win, type: type, fn: bound, capture: true });
    }

    // 焦点：focusin（冒泡）与 focus（capture 兜底）都可能触发，同目标同任务内去重
    onRoot('focusin', function (e) { self._onFocus(e); });
    onRoot('focus', function (e) { self._onFocus(e); });
    onRoot('click', function (e) { self._onClick(e); });
    onRoot('input', function (e) { self._onInput(e, false); });
    onRoot('change', function (e) { self._onInput(e, true); });
    onRoot('scroll', function (e) {
      var t = e.target;
      if (t === self.doc || t === self.win || t === self.doc.documentElement) return;
      self._onScroll(e);
    });
    // 页面级滚动 + 卸载前落盘
    onWin('scroll', function (e) { self._onWindowScroll(e); });
    onWin('beforeunload', function () {
      if (self.mode === 'recording') self._stopFlushAll();
    });
  };

  Recorder.prototype.destroy = function () {
    (this._handlers || []).forEach(function (h) {
      h.target.removeEventListener(h.type, h.fn, h.capture);
    });
    this._cancelPendingTimers();
    var panel = this.doc.getElementById('wt-recorder-panel');
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    if (this.win.__walkthroughRecorder === this) delete this.win.__walkthroughRecorder;
    this.mode = 'idle';
  };

  Recorder.prototype._stableId = function (el) {
    if (!el || !el.id) return null;
    // 录制器自身面板在 root 之外，天然被排除
    return this.root.contains(el) ? el.id : null;
  };

  Recorder.prototype._snapshot = function () {
    return buildSnapshot(this.win, this.root);
  };

  /* 事件触发时焦点/输入值/滚动可能已生效，这里在当前摘要上修正出“执行前”值。 */
  Recorder.prototype._preSnapshot = function (overrides) {
    var snap = this._snapshot();
    if (overrides.activeId !== undefined) snap.activeId = overrides.activeId;
    if (overrides.field) snap.values[overrides.field.id] = overrides.field.before;
    if (overrides.scrollId) snap.scroll.byId[overrides.scrollId] = overrides.scrollPos;
    if (overrides.windowScroll !== undefined) snap.scroll.window = overrides.windowScroll;
    return snap;
  };

  // ------------------------------------------------ 焦点
  Recorder.prototype._onFocus = function (e) {
    if (this.mode !== 'recording') return;
    var id = this._stableId(e.target);
    if (!id) return;
    if (this.pendingFocus && this.pendingFocus.id === id) return; // focusin/focus 去重

    // 焦点落到新元素，意味着上一动作已经结束
    this._flushAll();

    var prevActive = this.lastPost ? this.lastPost.activeId : null;
    var pre = this._preSnapshot({ activeId: prevActive });
    var step = { type: 'focus', target: id, ts: Date.now(), pre: pre, post: null, settleMs: this.settleMs };

    var self = this, session = this.session;
    this.pendingFocus = {
      id: id,
      step: step,
      timer: setTimeout(function () {
        if (!self._sessionAlive(session)) return; // 停止/新录制后迟到：丢弃
        if (self.pendingFocus) self._promoteFocus(self.pendingFocus);
      }, this.settleMs)
    };
  };

  Recorder.prototype._promoteFocus = function (held) {
    if (this.pendingFocus !== held) return;
    this.pendingFocus = null;
    this._queuePrimary(held.step, this.settleMs, 0);
  };

  /* 主动作发生时处理暂存焦点：同目标则并入（返回其 pre）；异目标则立即定稿。 */
  Recorder.prototype._absorbFocus = function (targetId) {
    if (!this.pendingFocus) return null;
    var held = this.pendingFocus;
    this.pendingFocus = null;
    clearTimeout(held.timer);
    if (held.id === targetId) return held.step.pre;
    held.step.post = this._snapshot();
    this._finalize(held.step, 0);
    return null;
  };

  // ------------------------------------------------ 点击
  Recorder.prototype._onClick = function (e) {
    if (this.mode !== 'recording') return;
    var el = e.target;
    var id = this._stableId(el);
    if (!id) return;
    // 表单控件的状态由 input 步骤负责，避免 click/input 重放时互相打架
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;

    var focusPre = this._absorbFocus(id);
    this._interruptPrimary();
    var pre = focusPre || this._snapshot();
    var step = { type: 'click', target: id, ts: Date.now(), pre: pre, post: null,
      settleMs: this.settleMs, absorbedFocus: !!focusPre };
    this._queuePrimary(step, this.settleMs, this.settleMs);
  };

  // ------------------------------------------------ 输入
  Recorder.prototype._onInput = function (e, isChange) {
    if (this.mode !== 'recording') return;
    var el = e.target;
    var id = this._stableId(el);
    if (!id) return;
    var isCheckable = el.type === 'checkbox' || el.type === 'radio';
    var isPassword = el.type === 'password';
    if (isChange && el.tagName !== 'SELECT' && !isCheckable) return; // 文本框以 input 为准

    // 同一字段连续输入合并为一步；change 不重复建步
    if (this.pending && this.pending.step.type === 'input' && this.pending.step.target === id) {
      if (isChange) return;
      // 更新录制值（密码始终为 null，只记录 changed）
      if (!isPassword) {
        this.pending.step.value = el.tagName === 'SELECT' ? el.value
          : (isCheckable ? null : String(el.value));
      }
      this._refreshPrimaryTimer();
      return;
    }

    var focusPre = this._absorbFocus(id);
    this._interruptPrimary();

    var before = this.lastPost && this.lastPost.values[id] !== undefined
      ? clone(this.lastPost.values[id])
      : encodeFieldValue(el);

    var pre;
    if (focusPre) {
      pre = focusPre;                 // 并入的焦点已修正 activeId
      pre.values[id] = before;        // 再把字段值修正为输入前
    } else {
      pre = this._preSnapshot({ field: { id: id, before: before } });
    }
    // 勾选类控件：click 先翻转再派发 change，事件到达时新值已生效。
    // pre 必须还原成点击前的勾选态 —— 直接从上一步定稿摘要(lastPost)取回整组真值。
    if (isCheckable) {
      if (this.lastPost) {
        if (this.lastPost.values[id] !== undefined) {
          pre.values[id] = clone(this.lastPost.values[id]);
        } else {
          pre.values[id] = { type: 'check', checked: !el.checked };
        }
        if (el.type === 'radio' && el.name) {
          Array.prototype.forEach.call(
            this.root.querySelectorAll('input[type="radio"][name="' + el.name + '"]'),
            function (r) {
              if (r.id && r.id !== id && this.lastPost.values[r.id] !== undefined) {
                pre.values[r.id] = clone(this.lastPost.values[r.id]);
              }
            }, this);
        }
      } else {
        pre.values[id] = { type: 'check', checked: !el.checked };
      }
    }

    var isPassword = el.type === 'password';
    var step = {
      type: 'input',
      target: id,
      ts: Date.now(),
      redacted: isPassword,
      absorbedFocus: !!focusPre,
      // 密码：不保存任何字符；其余保存输入结果（select 存 value，勾选框不存值）
      value: isPassword ? null
        : (el.tagName === 'SELECT' ? el.value : (isCheckable ? null : String(el.value))),
      pre: pre,
      post: null,
      settleMs: this.settleMs
    };
    this._queuePrimary(step, this.settleMs, this.settleMs);
  };

  // ------------------------------------------------ 滚动
  Recorder.prototype._onWindowScroll = function () {
    if (this.mode !== 'recording') return;
    var pos = Math.round(this.win.scrollY || this.doc.documentElement.scrollTop || 0);
    if (this.pending && this.pending.step.type === 'scroll' && this.pending.step.target === '__window__') {
      if (pos === this.pending.step.pos) return;
      this.pending.step.pos = pos;
      this._refreshPrimaryTimer();
      return;
    }
    if (this.lastPost && pos === this.lastPost.scroll.window) return;
    this._flushAll();
    var prev = this.lastPost ? this.lastPost.scroll.window : 0;
    var pre = this._preSnapshot({ windowScroll: prev });
    var step = { type: 'scroll', target: '__window__', pos: pos, ts: Date.now(),
      pre: pre, post: null, settleMs: 0 };
    this._queuePrimary(step, 0, SCROLL_DEBOUNCE_MS);
  };

  Recorder.prototype._onScroll = function (e) {
    if (this.mode !== 'recording') return;
    var el = e.target;
    var id = this._stableId(el);
    if (!id) return;
    var pos = Math.round(el.scrollTop || 0);

    if (this.pending && this.pending.step.type === 'scroll' && this.pending.step.target === id) {
      if (pos === this.pending.step.pos) return;
      this.pending.step.pos = pos;
      this._refreshPrimaryTimer();
      return;
    }
    if (this.lastPost && pos === (this.lastPost.scroll.byId[id] || 0)) return;

    this._flushAll();
    var prevPos = this.lastPost && this.lastPost.scroll.byId[id] !== undefined
      ? this.lastPost.scroll.byId[id] : 0;
    var pre = this._preSnapshot({ scrollId: id, scrollPos: prevPos });
    var step = { type: 'scroll', target: id, pos: pos, ts: Date.now(),
      pre: pre, post: null, settleMs: 0 };
    this._queuePrimary(step, 0, SCROLL_DEBOUNCE_MS);
  };

  // ------------------------------------------------ 步骤队列 / 定稿
  Recorder.prototype._queuePrimary = function (step, settleMs, waitMs) {
    if (this.pending) this._interruptPrimary();
    var self = this, session = this.session;
    this.pending = {
      step: step,
      settleMs: settleMs,                 // 期望沉淀时长（被打断时按实际经过重算）
      queuedAt: Date.now(),
      timer: setTimeout(function () {
        if (!self._sessionAlive(session)) return; // 令牌已失效：迟到更新绝不入轨迹
        self._flushPrimary(settleMs);
      }, waitMs)
    };
  };

  /* 被新动作打断：按“实际经过时长”定稿，回放将镜像同一时间线，
   * 保证异步回写在录制/回放两侧落在相同的步骤窗口里。 */
  Recorder.prototype._interruptPrimary = function () {
    if (!this.pending) return;
    var held = this.pending;
    this.pending = null;
    clearTimeout(held.timer);
    var elapsed = Math.max(0, Date.now() - held.queuedAt);
    this._finalize(held.step, Math.min(held.settleMs, elapsed));
  };

  Recorder.prototype._refreshPrimaryTimer = function () {
    if (!this.pending) return;
    var held = this.pending;
    clearTimeout(held.timer);
    var self = this, session = this.session;
    var wait = held.step.type === 'scroll' ? SCROLL_DEBOUNCE_MS : this.settleMs;
    held.timer = setTimeout(function () {
      if (!self._sessionAlive(session)) return;
      self._flushPrimary(held.settleMs);
    }, wait);
  };

  Recorder.prototype._sessionAlive = function (session) {
    return session === this.session && this.mode === 'recording';
  };

  Recorder.prototype._flushPrimary = function (settleMs) {
    if (!this.pending) return;
    var held = this.pending;
    this.pending = null;
    clearTimeout(held.timer);
    this._finalize(held.step, settleMs);
  };

  /* 早期打断（新动作到来）：焦点立即定稿，主步骤按实际经过时长定稿。 */
  Recorder.prototype._flushAll = function () {
    if (this.pendingFocus) {
      var heldF = this.pendingFocus;
      this.pendingFocus = null;
      clearTimeout(heldF.timer);
      heldF.step.post = this._snapshot();
      this._finalize(heldF.step, 0);
    }
    this._interruptPrimary();
  };

  /* 停止录制：所有挂起步骤立即定稿（停止时刻即观察时刻）。 */
  Recorder.prototype._stopFlushAll = function () {
    if (this.pendingFocus) {
      var heldF = this.pendingFocus;
      this.pendingFocus = null;
      clearTimeout(heldF.timer);
      heldF.step.post = this._snapshot();
      this._finalize(heldF.step, 0);
    }
    this._flushPrimary(0);
  };

  Recorder.prototype._cancelPendingTimers = function () {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
    if (this.pendingFocus) { clearTimeout(this.pendingFocus.timer); this.pendingFocus = null; }
  };

  Recorder.prototype._finalize = function (step, settleMs) {
    step.post = this._snapshot();
    step.settleMs = settleMs || 0;
    this.activeTrack.steps.push(step);
    this.lastPost = clone(step.post);
    this._save(); // 每步定稿即持久化 —— 录制可跨刷新保存
    this._renderPanel();
  };

  // ------------------------------------------------ 录制控制
  Recorder.prototype.startRecording = function () {
    if (!this.pagePresent) return null;
    this._cancelPendingTimers();      // 旧待办全部作废，不允许写入新轨迹
    this.session++;                   // 持有旧令牌的迟到回调立即失效
    this.mode = 'recording';
    this.halt = null;
    this.lastReplayed = -1;

    var track = {
      id: 'trk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      pageId: this.pageId,
      startedAt: new Date().toISOString(),
      initialState: null,
      steps: []
    };
    this.activeTrack = track;
    this.tracks.push(track);

    // 录制从初始状态开始；与回放起点保持一致
    if (this.win.WalkthroughApp && typeof this.win.WalkthroughApp.reset === 'function') {
      this.win.WalkthroughApp.reset();
    }
    this.lastPost = this._snapshot();
    track.initialState = clone(this.lastPost);

    this._save();
    this._renderPanel();
    return track;
  };

  Recorder.prototype.stop = function () {
    if (this.mode === 'recording') {
      // 停止前把已发生但尚未定稿的动作同步定稿（它们属于本次录制）
      this._stopFlushAll();
      this.session++;                // 此后任何迟到回调都被令牌挡下
      this.mode = 'idle';
      if (this.activeTrack) {
        this.activeTrack.endedAt = new Date().toISOString();
        this._save();
      }
    } else if (this.mode === 'playing') {
      this.session++;                // 正在等待的回放循环会在下一 tick 退出
      this.mode = 'idle';
    }
    this._renderPanel();
  };

  // ------------------------------------------------ 回放
  Recorder.prototype.listTracks = function () { return this.tracks.slice(); };

  Recorder.prototype.replay = function (track) {
    if (!this.pagePresent) {
      return Promise.resolve({ status: 'no-page' });
    }
    if (this.mode === 'playing') return Promise.resolve({ status: 'already-playing' });

    if (!track) track = this.activeTrack || this.tracks[this.tracks.length - 1];
    if (!track || this.tracks.indexOf(track) < 0) track = (this.tracks[this.tracks.length - 1]) || null;
    if (!track) {
      this.halt = { stepIndex: null, type: null, target: null, phase: 'empty',
        diff: { path: '$', recorded: null, current: null } };
      this._renderPanel();
      return Promise.resolve({ status: 'empty' });
    }

    this._cancelPendingTimers();
    this.activeTrack = track;
    this.session++;
    this.playToken = this.session;
    this.mode = 'playing';
    this.halt = null;
    this.lastReplayed = -1;
    this._renderPanel();
    return this._runReplay(track, this.playToken);
  };

  Recorder.prototype._alive = function (token) {
    return this.mode === 'playing' && token === this.playToken;
  };

  Recorder.prototype._wait = function (ms, token) {
    var self = this;
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(self._alive(token)); }, ms);
    });
  };

  Recorder.prototype._runReplay = function (track, token) {
    var self = this;
    return Promise.resolve().then(function () {
      if (!self._alive(token)) return { status: 'stopped', stepsExecuted: 0 };
      // 回到录制起点
      if (self.win.WalkthroughApp && typeof self.win.WalkthroughApp.reset === 'function') {
        self.win.WalkthroughApp.reset();
      }
      var current0 = self._snapshot();
      // 初始状态本身也要核对：起点不符同样是首处分歧
      var d0 = firstDiff(track.initialState || {}, current0);
      if (d0) return self._halt(null, 'initial', d0, track, token);
      self._renderPanel();
      return self._playStep(track, 0, token);
    });
  };

  Recorder.prototype._playStep = function (track, i, token) {
    var self = this;
    if (i >= track.steps.length) {
      return Promise.resolve().then(function () {
        if (!self._alive(token)) return { status: 'stopped', stepsExecuted: i };
        self.mode = 'idle';
        self.session++;
        self.halt = null;
        self._renderPanel();
        return { status: 'completed', stepsExecuted: track.steps.length };
      });
    }

    var step = track.steps[i];

    // ① 目标必须存在（窗口滚动无 DOM 目标）
    var el = step.target === '__window__' ? null : self.doc.getElementById(step.target);
    if (step.target !== '__window__' && !el) {
      return Promise.resolve(self._halt(i, 'missing',
        { path: 'target', recorded: step.target, current: null }, track, token));
    }

    // ② 执行前条件必须与录制时一致
    var preNow = self._snapshot();
    var dPre = firstDiff(step.pre, preNow);
    if (dPre) return Promise.resolve(self._halt(i, 'pre', dPre, track, token));

    // ③ 执行动作
    try {
      self._applyAction(step, el);
    } catch (err) {
      return Promise.resolve(self._halt(i, 'apply-error',
        { path: '$', recorded: '<动作执行>', current: String((err && err.message) || err) }, track, token));
    }
    self.lastReplayed = i;
    self._renderPanel();

    // ④ 等待与录制时相同的异步沉淀时间（迟到回写在此时落地）
    return self._wait(step.settleMs || 0, token).then(function (alive) {
      if (!alive) return { status: 'stopped', stepsExecuted: i };
      // ⑤ 执行后状态摘要必须一致；首处分歧即停
      var postNow = self._snapshot();
      var dPost = firstDiff(step.post, postNow);
      if (dPost) return self._halt(i, 'post', dPost, track, token);
      return self._playStep(track, i + 1, token);
    });
  };

  Recorder.prototype._halt = function (i, phase, diff, track, token) {
    this.mode = 'idle';
    this.session++;                 // 后续动作不再发生，迟到回调全部作废
    var step = i != null && i >= 0 ? track.steps[i] : null;
    this.halt = {
      stepIndex: i,
      type: step ? step.type : (phase === 'initial' ? 'initial' : null),
      target: step ? step.target : null,
      phase: phase,
      diff: diff
    };
    this._renderPanel();
    return { status: 'halted', halt: this.halt };
  };

  Recorder.prototype._applyAction = function (step, el) {
    if (step.type === 'click') {
      // 录制时若该步并入了焦点，回放也先聚焦，保证 post.activeId 可观察一致
      if (step.absorbedFocus) el.focus();
      el.click();
    } else if (step.type === 'focus') {
      el.focus();
    } else if (step.type === 'input') {
      this._applyInput(step, el);
    } else if (step.type === 'scroll') {
      if (step.target === '__window__') this.win.scrollTo(0, step.pos);
      else el.scrollTop = step.pos;
    }
  };

  Recorder.prototype._applyInput = function (step, el) {
    var EventCtor = this.win.Event;
    if (step.absorbedFocus) el.focus();
    if (step.redacted) {
      // 密码字符未入库：回放仅把字段推进“已改变”状态。占位符不进入任何摘要/轨迹。
      if (!encodeFieldValue(el).changed) {
        this._setNativeValue(el, PASSWORD_REPLAY_PLACEHOLDER);
      }
      el.dispatchEvent(new EventCtor('input', { bubbles: true }));
      el.dispatchEvent(new EventCtor('change', { bubbles: true }));
      return;
    }
    if (el.tagName === 'SELECT') {
      el.value = step.value;
      el.dispatchEvent(new EventCtor('change', { bubbles: true }));
      return;
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      // 录制时 click 已先翻转状态再派发事件；回放直接设置成录制的目标勾选态，
      // 只补发 input/change，不再合成 click（否则 radio 会被二次翻转）。
      var wanted = step.post && step.post.values[step.target]
        ? !!step.post.values[step.target].checked : !el.checked;
      if (el.type === 'radio' && wanted && el.name) {
        // 程序化置位在部分环境（jsdom）不会自动清空同名单选组，显式对齐浏览器语义
        Array.prototype.forEach.call(
          this.root.querySelectorAll('input[type="radio"][name="' + el.name + '"]'),
          function (r) { if (r !== el) r.checked = false; });
      }
      if (el.checked !== wanted) el.checked = wanted;
      el.dispatchEvent(new EventCtor('input', { bubbles: true }));
      el.dispatchEvent(new EventCtor('change', { bubbles: true }));
      return;
    }
    this._setNativeValue(el, step.value);
    el.dispatchEvent(new EventCtor('input', { bubbles: true }));
    el.dispatchEvent(new EventCtor('change', { bubbles: true }));
  };

  Recorder.prototype._setNativeValue = function (el, value) {
    var proto = el.tagName === 'TEXTAREA' ? this.win.HTMLTextAreaElement.prototype
      : this.win.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value == null ? '' : String(value));
  };

  // ------------------------------------------------ 面板
  var TYPE_LABELS = { click: '点击', input: '输入', focus: '聚焦', scroll: '滚动' };
  var PHASE_LABELS = {
    missing: '目标元素缺失',
    pre: '执行前条件不符',
    post: '执行后状态分歧',
    initial: '初始状态不符',
    'apply-error': '动作执行异常',
    empty: '没有可回放的轨迹'
  };

  Recorder.prototype._mountPanel = function () {
    var self = this;
    var doc = this.doc;
    if (doc.getElementById('wt-recorder-panel')) return;

    var panel = doc.createElement('div');
    panel.id = 'wt-recorder-panel';
    panel.innerHTML =
      '<div id="wt-recorder-head">' +
      '  <span><span id="wt-recorder-dot" data-mode="idle"></span>交互录制器</span>' +
      '  <span class="wt-rec-badge">仅演练页可用</span>' +
      '</div>' +
      '<div id="wt-recorder-controls">' +
      '  <button type="button" id="wt-rec-record">开始新录制</button>' +
      '  <button type="button" id="wt-rec-stop">停止</button>' +
      '  <button type="button" id="wt-rec-replay">回放最新</button>' +
      '</div>' +
      '<div id="wt-recorder-body"></div>';
    doc.body.appendChild(panel);

    doc.getElementById('wt-rec-record').addEventListener('click', function () {
      self.startRecording();
    });
    doc.getElementById('wt-rec-stop').addEventListener('click', function () {
      self.stop();
    });
    doc.getElementById('wt-rec-replay').addEventListener('click', function () {
      self.replay();
    });
  };

  Recorder.prototype._renderPanel = function () {
    if (!this.pagePresent) return;
    var doc = this.doc;
    var dot = doc.getElementById('wt-recorder-dot');
    var body = doc.getElementById('wt-recorder-body');
    if (!dot || !body) return;

    var modeLabel = this.mode === 'recording' ? '录制中'
      : this.mode === 'playing' ? '回放中' : '空闲';
    dot.setAttribute('data-mode', this.mode);
    dot.title = modeLabel;

    var btnRecord = doc.getElementById('wt-rec-record');
    var btnStop = doc.getElementById('wt-rec-stop');
    var btnReplay = doc.getElementById('wt-rec-replay');
    btnRecord.disabled = this.mode !== 'idle';
    btnStop.disabled = this.mode === 'idle';
    btnReplay.disabled = this.mode !== 'idle' || !this.tracks.length;

    var html = '';
    var track = this.activeTrack;
    if (track) {
      html += '<div>轨迹 ' + track.id.slice(-6) + ' · ' + track.steps.length + ' 步 · ' + modeLabel + '</div>';
      if (this.mode === 'playing') {
        html += '<div>已执行到：第 ' + (this.lastReplayed + 1) + ' / ' + track.steps.length + ' 步</div>';
      }
      var shown = track.steps.slice(-6);
      var base = Math.max(0, track.steps.length - shown.length);
      shown.forEach(function (s, idx) {
        var extra = s.type === 'input'
          ? (s.redacted ? '（密码：' + (s.post && s.post.values[s.target] && s.post.values[s.target].changed ? '已改变' : '未改变') + '）'
                        : '= ' + JSON.stringify(s.value))
          : s.type === 'scroll' ? '→ ' + s.pos
          : '';
        html += '<div class="wt-rec-line">#' + (base + idx + 1) + ' ' +
          (TYPE_LABELS[s.type] || s.type) + ' ' + s.target + ' ' + extra + '</div>';
      });
    } else {
      html += '<div>暂无轨迹' + (this.mode === 'recording' ? '，录制中…' : '') + '</div>';
    }

    if (this.halt) {
      var h = this.halt;
      html += '<div class="wt-rec-halt"><h4>⛔ 停在第一处分歧</h4>';
      var where = h.stepIndex == null ? '初始状态' : ('第 ' + (h.stepIndex + 1) + ' 步' +
        (h.type && TYPE_LABELS[h.type] ? '（' + TYPE_LABELS[h.type] + ' ' + h.target + '）' : ''));
      html += '<div>位置：' + where + '</div>';
      html += '<div>原因：' + (PHASE_LABELS[h.phase] || h.phase) + '</div>';
      if (h.diff) {
        html += '<div>分歧字段：<span class="k">' + h.diff.path + '</span></div>';
        html += '<div class="wt-rec-kv"><span class="k">录制值</span>: ' + fmt(h.diff.recorded) + '</div>';
        html += '<div class="wt-rec-kv"><span class="k">当前值</span>: ' + fmt(h.diff.current) + '</div>';
      }
      html += '</div>';
    }
    body.innerHTML = html;
  };

  function fmt(v) {
    if (v === null) return '<span style="color:#fca5a5">（缺失）</span>';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return JSON.stringify(v);
    return JSON.stringify(v);
  }

  // ------------------------------------------------ 挂载
  Recorder.attach = function (win, options) {
    win = win || (typeof window !== 'undefined' ? window : null);
    if (!win) return null;
    if (win.__walkthroughRecorder) return win.__walkthroughRecorder;
    var rec = new Recorder(win, options);
    win.__walkthroughRecorder = rec;
    win.WalkthroughRecorderApi = rec;
    return rec;
  };

  var autoWin = typeof window !== 'undefined' ? window : null;
  if (autoWin && !autoWin.__WT_NO_AUTO_ATTACH__) {
    if (autoWin.document.readyState === 'loading') {
      autoWin.document.addEventListener('DOMContentLoaded', function () { Recorder.attach(autoWin); });
    } else {
      Recorder.attach(autoWin);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      Recorder: Recorder,
      buildSnapshot: buildSnapshot,
      firstDiff: firstDiff,
      valueAtPath: valueAtPath
    };
  }
})();
