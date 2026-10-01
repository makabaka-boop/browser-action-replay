'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, typeText, click, userScroll } = require('./helpers');

async function recordHappyPath(window, recorder) {
  const doc = window.document;
  recorder.startRecording();
  await sleep(5);

  // 1) 切到偏好标签页
  click(window, doc.getElementById('wt-tab-prefs'));
  await sleep(70);
  // 2) 打开弹窗
  click(window, doc.getElementById('wt-open-modal-btn'));
  await sleep(70);
  // 3) 填备注并确认（触发 30ms 异步回写）
  typeText(window, doc.getElementById('wt-modal-note'), '已核实');
  await sleep(70);
  click(window, doc.getElementById('wt-modal-confirm'));
  await sleep(70);
  // 4) 滚动活动日志（先切过去）
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(70);
  userScroll(window, doc.getElementById('wt-log-scroll'), 42);
  await sleep(130);
  recorder.stop();
  return recorder.activeTrack;
}

/* 核心需求：回放必须停在第一处分歧，展示录制值与当前值，后续步骤不得再执行。 */
test('回放停在第一处 pre 分歧，不产生后续“看似成功”的步骤', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const track = await recordHappyPath(window, recorder);
  const total = track.steps.length;
  assert.ok(total >= 5, '录制步骤数: ' + total);

  // 初始状态由回放负责复位，因此这里篡改“录制的初始状态”本身
  track.initialState.tabs['wt-tab-profile'] = false;
  track.initialState.tabs['wt-tab-activity'] = true;

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  assert.strictEqual(recorder.halt.phase, 'initial');
  assert.ok(recorder.halt.diff, '必须带分歧详情');
  assert.ok(typeof recorder.halt.diff.path === 'string');
  assert.notStrictEqual(recorder.halt.diff.recorded, recorder.halt.diff.current);
  // 一步都不允许执行
  assert.ok(recorder.lastReplayed === -1);
  dom.window.close();
});

test('回放停在中途的第一处 pre 不符：录制值/当前值齐备，后续步骤未执行', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const track = await recordHappyPath(window, recorder);
  const total = track.steps.length;

  // 直接篡改轨迹第 2 步（wt-open-modal-btn）的 pre：
  // 录制时 pre 的活动标签页是“偏好”，篡改为“个人资料”
  const openStepIndex = track.steps.findIndex(s => s.target === 'wt-open-modal-btn');
  assert.ok(openStepIndex > 0);
  track.steps[openStepIndex].pre.tabs['wt-tab-prefs'] = false;
  track.steps[openStepIndex].pre.tabs['wt-tab-profile'] = true;

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  const h = recorder.halt;
  assert.strictEqual(h.phase, 'pre');
  assert.strictEqual(h.stepIndex, openStepIndex, '必须停在被篡改的这一步（第一处）');
  assert.ok(h.diff.path.indexOf('tabs.') === 0, '分歧字段应定位到 tabs: ' + h.diff.path);
  assert.strictEqual(h.type, 'click');
  assert.strictEqual(h.target, 'wt-open-modal-btn');
  // 录制值 false / 当前值 true 同时展示
  assert.strictEqual(h.diff.recorded, false);
  assert.strictEqual(h.diff.current, true);
  // 关键：后续步骤绝没有执行 —— 弹窗没有打开
  assert.strictEqual(doc.getElementById('wt-modal-overlay').classList.contains('wt-hidden'), true);
  // 已执行数恰好停在分歧步之前
  assert.strictEqual(recorder.lastReplayed, openStepIndex - 1);

  // 之后即使等待远超所有异步/沉淀时间，也不会冒出“成功”的后续状态
  await sleep(200);
  assert.strictEqual(doc.getElementById('wt-modal-overlay').classList.contains('wt-hidden'), true);
  assert.strictEqual(recorder.halt.stepIndex, openStepIndex);
  dom.window.close();
});

test('回放停在第一处 post 分歧（动作结果与录制不一致）', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const track = await recordHappyPath(window, recorder);

  // 篡改滚动步的 post：录制时停在 42，改成 99
  const scrollStepIndex = track.steps.findIndex(s => s.type === 'scroll');
  assert.ok(scrollStepIndex >= 0);
  track.steps[scrollStepIndex].post.scroll.byId['wt-log-scroll'] = 99;

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  const h = recorder.halt;
  assert.strictEqual(h.phase, 'post');
  assert.strictEqual(h.stepIndex, scrollStepIndex);
  assert.strictEqual(h.diff.recorded, 99);
  assert.strictEqual(h.diff.current, 42);
  assert.strictEqual(h.target, 'wt-log-scroll');
  // 是轨迹最后一步；确认停住且模式回到空闲（不能继续产生动作）
  assert.strictEqual(recorder.mode, 'idle');
  dom.window.close();
});

test('firstDiff 返回结构的第一处分歧（单元级）', async () => {
  const mod = require('../public/recorder.js');
  const a = { values: { x: '1', y: '2' }, nested: { ok: true } };
  const b = { values: { x: '1', y: '不同' }, nested: { ok: false } };
  const d = mod.firstDiff(a, b);
  // 对象按键名字典序遍历：nested < values，第一处分歧是 nested.ok
  assert.strictEqual(d.path, 'nested.ok');
  assert.strictEqual(d.recorded, true);
  assert.strictEqual(d.current, false);
  assert.strictEqual(mod.firstDiff(a, JSON.parse(JSON.stringify(a))), null);
  // 深层数组+缺失键
  const d2 = mod.firstDiff({ list: [{ k: 1 }, { k: 2 }] }, { list: [{ k: 1 }, { k: 3, z: 0 }] });
  assert.strictEqual(d2.path, 'list[1].k');
});
