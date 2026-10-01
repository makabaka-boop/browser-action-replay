/*
 * test/run.js —— 交互录制器自动化测试（jsdom）
 * 覆盖：
 *   1. 弹窗重建（节点销毁重建、id 不变）的录制与回放
 *   2. 密码输入脱敏（任何存储中不出现字符）
 *   3. 目标变化（元素缺失 / 同 id 换节点 / 前条件漂移）
 *   4. 首次分歧定位（前条件分歧、执行后元素分歧、执行后全局分歧）
 *   另含：跨刷新持久化与自动回放、迟到异步更新隔离、停止回放隔离、页面守卫
 */
'use strict';
const assert = require('assert');
const h = require('./helpers');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* 脚本在 vm 上下文中创建的对象/数组与 Node 主 realm 原型不同，深比较走 JSON */
function eq(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected),
    (message || '') + '\n  actual:   ' + JSON.stringify(actual) + '\n  expected: ' + JSON.stringify(expected));
}

function assertStoppedAt(res, index, reasonContains) {
  assert.strictEqual(res.status, 'stopped', '应停在分歧处，实际：' + res.status);
  assert.strictEqual(res.index, index, '应停在第 ' + (index + 1) + ' 步');
  if (reasonContains) assert.ok(String(res.reason).indexOf(reasonContains) >= 0,
    'reason=' + res.reason + ' 应包含 ' + reasonContains);
  res.steps.forEach(function (s, i) {
    if (i < index) assert.strictEqual(s.status, 'done');
    else if (i === index) assert.strictEqual(s.status, 'fail');
    else assert.strictEqual(s.status, 'blocked', '第 ' + (i + 1) + ' 步必须被阻止');
  });
}

/* ================================================================== */
/* 0. 冒烟：点击/输入/标签页/滚动全链路录制与回放                        */
/* ================================================================== */
test('冒烟：标签页切换 + 计数点击 + 文本输入 + 滚动，回放一致', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();

  h.setValue(document.getElementById('f-name'), 'Alice');
  await h.tick();
  h.click(document.getElementById('tab-security'));
  await h.tick();
  h.click(document.getElementById('bump-btn'));
  await h.tick();
  h.scrollTo(document.getElementById('scroll-box'), 60);
  await h.settleScroll();
  recorder.stop();

  const steps = recorder.getTrace().steps;
  eq(steps.map(s => s.kind + ':' + s.target),
    ['input:f-name', 'click:tab-security', 'click:bump-btn', 'scroll:scroll-box']);
  assert.strictEqual(steps[0].pre.el.value, '', '输入步骤的执行前值必须是空（旧值）');
  assert.strictEqual(steps[0].post.el.value, 'Alice');
  assert.strictEqual(steps[1].post.global['panel-security'], true);
  assert.strictEqual(steps[1].post.global['panel-profile'], false);
  assert.strictEqual(steps[2].post.global.bump, '1');
  eq(steps[3].pre.el, { scrollTop: 0 });
  eq(steps[3].post.el, { scrollTop: 60 });

  const res = await recorder.play();
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(document.getElementById('f-name').value, 'Alice');
  assert.strictEqual(document.getElementById('panel-security').hidden, false);
  assert.strictEqual(document.getElementById('bump-count').textContent, '1');
  assert.strictEqual(document.getElementById('scroll-box').scrollTop, 60);
});

/* ================================================================== */
/* 0b. 聚焦动作 & 停止时未结算滚动                                      */
/* ================================================================== */
test('聚焦：focusin/focus 不重复录制；前条件记录旧焦点、后摘要记录新焦点', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.focusEl(document.getElementById('f-name'));
  await h.tick();
  h.focusEl(document.getElementById('f-email'));
  await h.tick();
  recorder.stop();

  const steps = recorder.getTrace().steps;
  eq(steps.map(s => s.kind + ':' + s.target), ['focus:f-name', 'focus:f-email']);
  assert.strictEqual(steps[0].pre.global.activeId, null);
  assert.strictEqual(steps[0].post.global.activeId, 'f-name');
  assert.strictEqual(steps[1].pre.global.activeId, 'f-name', '第 2 次聚焦的前条件必须是旧焦点');
  assert.strictEqual(steps[1].post.global.activeId, 'f-email');

  const res = await recorder.play();
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(document.activeElement.id, 'f-email');
});

test('滚动：停止录制时仍在合并窗口内的滚动必须立即结算落盘', async () => {
  const p = await h.loadPage();
  const { document, recorder, storage } = p;
  recorder.start();
  h.scrollTo(document.getElementById('scroll-box'), 77);
  /* 不等待 debounce（16ms）立刻停止 */
  recorder.stop();
  const steps = recorder.getTrace().steps;
  eq(steps.map(s => s.kind), ['scroll']);
  assert.strictEqual(steps[0].pre.el.scrollTop, 0);
  assert.strictEqual(steps[0].post.el.scrollTop, 77);
  const persisted = JSON.parse(storage.getItem('walkthrough.recorder.trace.v1'));
  assert.strictEqual(persisted.steps[0].post.el.scrollTop, 77);
});

test('下拉框：真实浏览器语义下 change 事件被录为输入步骤并可回放', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.selectOption(document.getElementById('f-country'), 'sg');
  await h.tick();
  recorder.stop();
  const steps = recorder.getTrace().steps;
  eq(steps.map(s => s.kind + ':' + s.target), ['input:f-country']);
  assert.strictEqual(steps[0].pre.el.value, 'cn');
  assert.strictEqual(steps[0].post.el.value, 'sg');
  const res = await recorder.play();
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(document.getElementById('f-country').value, 'sg');
});

/* ================================================================== */
/* 1. 弹窗重建                                                          */
/* ================================================================== */
test('弹窗重建：销毁并重建内部节点后，稳定 id 仍能定位，回放一致', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();

  h.click(document.getElementById('open-modal'));
  await h.tick();
  const firstNode = document.getElementById('modal-confirm');
  assert.ok(firstNode, '弹窗内节点应已创建');

  /* 重建：旧节点被 innerHTML 销毁，重新创建的节点 id 相同 */
  h.click(document.getElementById('modal-rebuild'));
  await h.tick();
  const secondNode = document.getElementById('modal-confirm');
  assert.ok(secondNode && secondNode !== firstNode, '弹窗内部节点必须是重建出来的新节点');

  h.click(document.getElementById('modal-confirm'));
  await h.tick();
  assert.ok(!document.getElementById('modal-confirm'), '确认后弹窗应已关闭');
  recorder.stop();

  const steps = recorder.getTrace().steps;
  eq(steps.map(s => s.kind + ':' + s.target),
    ['click:open-modal', 'click:modal-rebuild', 'click:modal-confirm']);
  assert.strictEqual(steps[0].post.global.modalOpen, true);
  assert.strictEqual(steps[1].pre.global.modalOpen, true, '重建前弹窗必须开着（前条件）');
  assert.strictEqual(steps[1].post.global.modalRebuild, '2');
  assert.strictEqual(steps[2].post.global.modalOpen, false, '确认后执行后摘要：弹窗关闭');

  const res = await recorder.play();
  assert.strictEqual(res.status, 'ok', '回放重建序列应成功，实际：' + res.status +
    (res.where ? ' @ ' + res.where : ''));
  assert.strictEqual(p.app.getState().rebuild, 2);
  assert.strictEqual(document.getElementById('modal-root').hidden, true);
});

/* ================================================================== */
/* 2. 密码脱敏                                                          */
/* ================================================================== */
test('密码脱敏：轨迹/前条件/后摘要/存储中都不出现密码字符', async () => {
  const secret = 'S3cr3t-P@ss';
  const p = await h.loadPage();
  const { document, recorder, storage } = p;
  recorder.start();

  h.setValue(document.getElementById('f-password'), secret);
  await h.tick();
  recorder.stop();

  /* 真的输入了密码 */
  assert.strictEqual(document.getElementById('f-password').value, secret);

  const steps = recorder.getTrace().steps;
  assert.strictEqual(steps.length, 1);
  const s = steps[0];
  assert.strictEqual(s.kind, 'input');
  eq(s.pre.el, { secret: true, empty: true, changed: false },
    '执行前条件只记录脱敏结构');
  eq(s.post.el, { secret: true, empty: false, changed: true },
    '执行后摘要只记录“已改变”，不存字符');
  assert.ok(!('value' in s.pre.el) && !('value' in s.post.el));

  const raw = storage.getItem('walkthrough.recorder.trace.v1');
  assert.ok(raw.indexOf(secret) === -1, '持久化轨迹中不得出现密码字符');
  assert.ok(raw.indexOf('P@ss') === -1);

  /* 回放：不使用真实字符即可重放“已改变”，后摘要一致 */
  const res = await recorder.play();
  assert.strictEqual(res.status, 'ok', res.status === 'stopped' ? ('停在 ' + (res.index + 1) + ' @ ' + res.where) : res.status);
  const after = recorder.getTrace().steps; // 轨迹文件本身仍不含字符
  assert.ok(JSON.stringify(after).indexOf(secret) === -1);
});

/* ================================================================== */
/* 3. 目标变化                                                          */
/* ================================================================== */
test('目标变化 A：回放时目标元素缺失 → 停在该步，后续步骤全部 blocked', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.setValue(document.getElementById('f-name'), 'Bob');
  await h.tick();
  h.click(document.getElementById('bump-btn'));
  await h.tick();
  recorder.stop();

  /* 让初始状态仍一致，但在 reset 之后、执行之前删掉第 1 步的目标 */
  const originalReset = p.app.reset.bind(p.app);
  p.app.reset = function () {
    return originalReset().then(function () {
      const n = document.getElementById('f-name');
      n.parentNode.removeChild(n);
    });
  };
  const res = await recorder.play();
  assertStoppedAt(res, 0, 'missing');
  assert.strictEqual(res.currentValue.exists, false);
  /* 第 2 步绝不能产生副作用 */
  assert.strictEqual(document.getElementById('bump-count').textContent, '0');
});

test('目标变化 B：同 id 节点被换成不同类型元素 → 执行前元素摘要分歧', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.setValue(document.getElementById('f-name'), 'Carol');
  await h.tick();
  recorder.stop();

  const originalReset = p.app.reset.bind(p.app);
  p.app.reset = function () {
    return originalReset().then(function () {
      const old = document.getElementById('f-name');
      const div = document.createElement('div');
      div.id = 'f-name';
      div.textContent = '我不是输入框';
      old.parentNode.replaceChild(div, old);
    });
  };
  const res = await recorder.play();
  assertStoppedAt(res, 0, 'pre-element');
  assert.strictEqual(res.where, 'el.tag', '分歧应精确定位到 el.tag');
  assert.strictEqual(res.recordedValue.tag, 'INPUT');
  assert.strictEqual(res.currentValue.tag, 'DIV');
});

test('目标变化 C：页面已被手动改动（前条件漂移）→ 第 1 步即停', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.setValue(document.getElementById('f-name'), 'Dave');
  await h.tick();
  h.click(document.getElementById('bump-btn'));
  await h.tick();
  recorder.stop();

  /* 不 reset：在脏状态上回放 */
  h.setValue(document.getElementById('f-name'), 'Mallory');
  await h.tick();
  const bumpBefore = document.getElementById('bump-count').textContent;
  assert.strictEqual(bumpBefore, '1');

  const res = await recorder.play({ reset: false });
  assertStoppedAt(res, 0, 'pre-element');
  assert.strictEqual(res.where, 'el.value');
  assert.strictEqual(res.recordedValue.value, '');
  assert.strictEqual(res.currentValue.value, 'Mallory');
  /* 第 2 步不得执行：计数不得继续增加 */
  assert.strictEqual(document.getElementById('bump-count').textContent, bumpBefore);
});

/* ================================================================== */
/* 4. 首次分歧定位（执行后摘要）                                         */
/* ================================================================== */
test('首次分歧 A：执行后元素摘要被外部篡改 → 停在该处，展示录制值 vs 当前值', async () => {
  const p = await h.loadPage();
  const { window, document, recorder } = p;
  recorder.start();
  h.setValue(document.getElementById('f-name'), 'Eve');
  await h.tick();
  h.click(document.getElementById('bump-btn'));
  await h.tick();
  recorder.stop();

  /* 在第 1 步的 input 动作执行后、后摘要核对前，异步把值改掉 */
  document.addEventListener('input', function (ev) {
    if (ev.target.id === 'f-name' && recorder.getMode() === 'playing') {
      setTimeout(function () { ev.target.value = 'TAMPERED'; }, 0);
    }
  }, true);

  const res = await recorder.play();
  assertStoppedAt(res, 0, 'post-element');
  assert.strictEqual(res.where, 'el.value');
  assert.strictEqual(res.recordedValue.value, 'Eve', '录制值');
  assert.strictEqual(res.currentValue.value, 'TAMPERED', '当前值');
  /* 第 2 步未执行 */
  assert.strictEqual(document.getElementById('bump-count').textContent, '0');
});

test('首次分歧 B：回放中途某标签页面板被移除 → 执行后全局摘要分歧，只停该步', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.click(document.getElementById('tab-security'));
  await h.tick();
  h.click(document.getElementById('bump-btn'));
  await h.tick();
  recorder.stop();

  /* 让切标签页动作的“执行后”全局状态分歧：面板消失 */
  const origSwitch = document.getElementById('tab-security');
  origSwitch.addEventListener('click', function () {
    if (recorder.getMode() === 'playing') {
      setTimeout(function () {
        const panel = document.getElementById('panel-security');
        if (panel) panel.parentNode.removeChild(panel);
      }, 0);
    }
  }, true);

  const res = await recorder.play();
  assertStoppedAt(res, 0, 'post-global');
  assert.strictEqual(res.where, 'global.panel-security');
  assert.strictEqual(res.recordedValue['panel-security'], true);
  assert.strictEqual(res.currentValue['panel-security'], null);
  /* 第 2 步（计数）绝不能执行 */
  assert.strictEqual(document.getElementById('bump-count').textContent, '0');
});

test('首次分歧 C：分歧在第 2 步时，第 1 步必须真实执行并保留副作用', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.setValue(document.getElementById('f-email'), 'one@example.com');
  await h.tick();
  h.setValue(document.getElementById('f-email'), 'two@example.com');
  await h.tick();
  recorder.stop();

  /* 仅在第 2 步的输入发生后篡改成别的值 */
  let seenInputs = 0;
  document.addEventListener('input', function (ev) {
    if (ev.target.id !== 'f-email' || recorder.getMode() !== 'playing') return;
    seenInputs += 1;
    if (seenInputs === 2) setTimeout(function () { ev.target.value = 'other@example.com'; }, 0);
  }, true);

  const res = await recorder.play();
  assertStoppedAt(res, 1, 'post-element');
  assert.strictEqual(res.recordedValue.value, 'two@example.com');
  assert.strictEqual(res.currentValue.value, 'other@example.com');
  /* 第 1 步确实执行过（先经过 one 才到 two） */
  assert.ok(seenInputs >= 2);
});

/* ================================================================== */
/* 5. 跨刷新持久化 + 自动回放                                            */
/* ================================================================== */
test('跨刷新：录制经共享 localStorage 保存；新页面加载后轨迹仍在并自动回放', async () => {
  const shared = h.createMemoryStorage();
  const p1 = await h.loadPage({ storage: shared });
  p1.recorder.start();
  h.setValue(p1.document.getElementById('f-name'), 'Refresh');
  await h.tick();
  h.click(p1.document.getElementById('bump-btn'));
  await h.tick();
  p1.recorder.stop();
  assert.ok(shared().getItem('walkthrough.recorder.trace.v1'), '轨迹应已写入存储');
  await p1.close();

  /* 要求新页面自动回放（模拟用户刷新后点“继续回放”的持久化意图） */
  const store2 = shared();
  store2.setItem('walkthrough.recorder.autoplay.v1', '1');
  const p2 = await h.loadPage({ storage: function () { return store2; } });
  assert.strictEqual(p2.recorder.getTrace().steps.length, 2, '刷新后轨迹必须恢复');

  await h.wait(80);
  const res = p2.recorder.getResult();
  assert.ok(res, '自动回放应已产生结果');
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(p2.document.getElementById('f-name').value, 'Refresh');
  assert.strictEqual(p2.document.getElementById('bump-count').textContent, '1');
  assert.ok(!store2.getItem('walkthrough.recorder.autoplay.v1'), '自动回放标记应被消费');
});

/* ================================================================== */
/* 6. 迟到的异步界面更新不得写进旧轨迹                                    */
/* ================================================================== */
test('迟到更新：停止录制后触发的滚动不得进入旧轨迹', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.scrollTo(document.getElementById('scroll-box'), 20);
  await h.settleScroll();
  recorder.stop();
  const before = recorder.getTrace().steps.length;
  assert.strictEqual(before, 1);

  /* 停止之后才到达的滚动事件（异步界面更新） */
  h.scrollTo(document.getElementById('scroll-box'), 90);
  await h.settleScroll();
  assert.strictEqual(recorder.getTrace().steps.length, before, '迟到滚动不得写入旧轨迹');
});

test('迟到更新：停止录制后开始新录制，弹窗的迟到异步关闭不得污染任何轨迹', async () => {
  const p = await h.loadPage();
  const { document, recorder, storage } = p;
  recorder.start();
  h.click(document.getElementById('open-modal'));
  await h.tick();
  h.click(document.getElementById('async-close')); // 安排 120ms 后关闭
  await h.tick();
  recorder.stop();
  const oldTrace = JSON.parse(storage.getItem('walkthrough.recorder.trace.v1'));
  eq(oldTrace.steps.map(s => s.target), ['open-modal', 'async-close']);

  /* 立刻开始新录制（新 epoch）；旧轨迹在存储中已被新轨迹替换 */
  recorder.start();
  await h.wait(160); // 等待迟到的异步关闭发生（它只改 DOM，不产生用户事件）
  recorder.stop();

  /* 新轨迹中绝不允许凭空出现“关闭弹窗”之类的步骤 */
  const trace = recorder.getTrace();
  eq(trace.steps.map(s => s.kind + ':' + s.target), []);
  const persisted = JSON.parse(storage.getItem('walkthrough.recorder.trace.v1'));
  eq(persisted.steps.map(s => s.kind + ':' + s.target), []);
});

test('迟到更新：停止后、未开始新录制前，旧轨迹保持停止时的内容不变', async () => {
  const shared = h.createMemoryStorage();
  const p = await h.loadPage({ storage: shared });
  p.recorder.start();
  h.click(p.document.getElementById('open-modal'));
  await h.tick();
  h.click(p.document.getElementById('async-close')); // 120ms 后迟到关闭
  await h.tick();
  p.recorder.stop();
  await p.close();

  /* 迟到定时器在旧页面里触发后，立即用新页面读取存储：轨迹必须仍是停止时的两步 */
  await h.wait(160);
  const p2 = await h.loadPage({ storage: shared });
  eq(p2.recorder.getTrace().steps.map(s => s.target), ['open-modal', 'async-close']);
});

test('停止回放：中途停止后，挂起的后续步骤与迟到异步回调都不得继续', async () => {
  const p = await h.loadPage();
  const { document, recorder } = p;
  recorder.start();
  h.setValue(document.getElementById('f-name'), 'StopMe');
  await h.tick();
  h.click(document.getElementById('bump-btn'));
  await h.tick();
  recorder.stop();

  const promise = recorder.play({ delay: 40 });
  await h.wait(10); // 第 1 步执行中
  assert.strictEqual(recorder.getMode(), 'playing');
  recorder.stopPlayback();
  const res = await promise;
  assert.strictEqual(res, null, '停止后挂起的 play 链应作废（返回 null）');
  assert.strictEqual(recorder.getMode(), 'idle');
  await h.wait(80);
  /* 第 2 步永不执行 */
  assert.strictEqual(document.getElementById('bump-count').textContent, '0');
});

/* ================================================================== */
/* 7. 页面守卫：录制器只在演练页面工作                                    */
/* ================================================================== */
test('页面守卫：非演练页面不创建 app/录制器，录制 API 拒绝工作', async () => {
  const dom = await h.loadBarePage('other');
  assert.ok(!dom.window.__walkthroughApp, '非演练页不得自启动 app');
  assert.ok(!dom.window.__walkthroughRecorder, '非演练页不得自启动录制器');

  /* 显式调用 boot 也返回 null */
  const r = dom.window.WalkthroughRecorder.bootIfWalkthrough(dom.window);
  assert.strictEqual(r, null);
});

test('页面守卫：演练页面才自启动并可录制', async () => {
  const p = await h.loadPage();
  assert.ok(p.app, '演练页应自启动 app');
  assert.ok(p.recorder, '演练页应自启动录制器');

  /* 在非演练页面文档上创建的录制器：init 不挂载，start 抛错 */
  const doc2 = p.document.implementation.createHTMLDocument('');
  doc2.documentElement.setAttribute('data-page', 'other');
  const fakeWin = {
    document: doc2, WeakSet: WeakSet, setTimeout: setTimeout,
    clearTimeout: clearTimeout, Promise: Promise
  };
  const other = p.window.WalkthroughRecorder.createRecorder(fakeWin);
  assert.strictEqual(other.init(), null, '非演练页 init 返回 null 且不绑定事件');
  assert.throws(() => other.start(), /只在演练页面/);
});

/* ---- 运行器 ---- */
(async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('  ✓ ' + t.name);
    } catch (err) {
      failed += 1;
      console.error('  ✗ ' + t.name);
      console.error('    ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + tests.length + ' total');
  process.exit(failed ? 1 : 0);
})();
