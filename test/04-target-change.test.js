'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, typeText, click } = require('./helpers');

/* 需求：目标使用稳定元素 ID。回放时若元素缺失，必须停在该步并明确报告，
 * 不能跳过、不能继续产生后续动作。 */
test('回放时目标元素缺失：停在缺失步，报告录制目标，后续步骤不执行', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);

  typeText(window, doc.getElementById('wt-name-input'), '李四');
  await sleep(70);
  click(window, doc.getElementById('wt-tab-prefs'));
  await sleep(70);
  click(window, doc.getElementById('wt-open-modal-btn'));
  await sleep(70);
  recorder.stop();

  const track = recorder.activeTrack;
  const tabIdx = track.steps.findIndex(s => s.type === 'click' && s.target === 'wt-tab-prefs');
  const modalBtnIdx = track.steps.findIndex(s => s.target === 'wt-open-modal-btn');
  assert.ok(tabIdx >= 0 && modalBtnIdx > tabIdx);

  // 回放开始前从页面中移除“打开弹窗”按钮
  const victim = doc.getElementById('wt-open-modal-btn');
  victim.parentNode.removeChild(victim);
  assert.strictEqual(doc.getElementById('wt-open-modal-btn'), null);

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  const h = recorder.halt;
  assert.strictEqual(h.phase, 'missing');
  assert.strictEqual(h.stepIndex, modalBtnIdx, '必须停在目标缺失的那一步');
  assert.strictEqual(h.target, 'wt-open-modal-btn');
  assert.strictEqual(h.diff.path, 'target');
  assert.strictEqual(h.diff.recorded, 'wt-open-modal-btn');
  assert.strictEqual(h.diff.current, null, '当前值必须明确展示为缺失(null)');
  // 缺失步之前的步骤照常执行了：标签页已切换
  assert.strictEqual(doc.getElementById('wt-panel-prefs').classList.contains('wt-hidden'), false);
  // 但缺失步及后续绝未执行：弹窗未打开
  assert.strictEqual(doc.getElementById('wt-modal-overlay').classList.contains('wt-hidden'), true);
  assert.strictEqual(recorder.lastReplayed, modalBtnIdx - 1);
  assert.strictEqual(recorder.mode, 'idle');
  dom.window.close();
});

/* 稳定 ID 的另一面：元素被重建为全新节点，只要 ID 不变就仍能回放成功
 * （输入框场景；弹窗场景见 01 测试）。 */
test('目标节点被替换但 ID 稳定：回放仍定位到新节点并成功', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  typeText(window, doc.getElementById('wt-email-input'), 'a@b.com');
  await sleep(70);
  recorder.stop();
  const track = recorder.activeTrack;
  assert.ok(track.steps.some(s => s.target === 'wt-email-input'));

  // 回放前用全新节点替换邮箱输入框（同 ID）
  const old = doc.getElementById('wt-email-input');
  const fresh = doc.createElement('input');
  fresh.type = 'email';
  fresh.id = 'wt-email-input';
  fresh.name = 'email';
  old.parentNode.replaceChild(fresh, old);

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'completed',
    'ID 稳定即可重放: ' + JSON.stringify(recorder.halt));
  assert.strictEqual(doc.getElementById('wt-email-input').value, 'a@b.com');
  dom.window.close();
});

/* 目标元素仍在但语义已变（例如按钮文本/行为不同导致结果不同）：
 * 通过 post 分歧捕捉，停在第一处。 */
test('目标存在但行为已变化：post 分歧停住并对照录制/当前值', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-open-modal-btn'));
  await sleep(70);
  recorder.stop();
  const track = recorder.activeTrack;

  // 让同 ID 按钮不再打开弹窗（行为变化），并保持弹窗关闭
  doc.getElementById('wt-modal-overlay').classList.add('wt-hidden');
  const btn = doc.getElementById('wt-open-modal-btn');
  const clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn); // 清掉应用层监听的副本
  // 不绑定任何打开逻辑：点击后弹窗保持关闭

  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'halted');
  assert.strictEqual(recorder.halt.phase, 'post');
  assert.strictEqual(recorder.halt.target, 'wt-open-modal-btn');
  assert.strictEqual(recorder.halt.diff.recorded, true, '录制时弹窗 open=true');
  assert.strictEqual(recorder.halt.diff.current, false, '当前弹窗保持关闭');
  dom.window.close();
});
