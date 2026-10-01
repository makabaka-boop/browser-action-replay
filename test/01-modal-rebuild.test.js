'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, typeText, click } = require('./helpers');

/* 需求覆盖：弹窗每次打开整体重建 DOM，稳定 ID 仍然可定位，回放完整一致。 */
test('弹窗重建后按稳定 ID 重放成功（含异步回写沉淀）', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);

  // 打开弹窗（卡片重建为 v1，#wt-modal-note 是新节点）
  click(window, doc.getElementById('wt-open-modal-btn'));
  const noteV1 = doc.getElementById('wt-modal-note');
  await sleep(70);

  // 在重建后的节点里输入
  typeText(window, noteV1, '请通过');
  await sleep(70);

  // 确认：弹窗关闭，30ms 后异步回写底部状态
  click(window, doc.getElementById('wt-modal-confirm'));
  await sleep(70);

  // 再次打开：卡片再次重建（v2，又是一批新节点）
  click(window, doc.getElementById('wt-open-modal-btn'));
  const noteV2 = doc.getElementById('wt-modal-note');
  assert.notStrictEqual(noteV1, noteV2, '两次打开弹窗，备注输入框应是不同 DOM 节点');
  assert.strictEqual(noteV1.id, noteV2.id, '但元素 ID 保持稳定');
  assert.strictEqual(noteV2.value, '', '重建后备注应被清空');
  await sleep(70);

  click(window, doc.getElementById('wt-modal-cancel'));
  await sleep(70);
  recorder.stop();

  const track = recorder.activeTrack;
  assert.ok(track.steps.length >= 4, '应录到多个步骤，实际: ' + track.steps.length);
  // 弹窗版本号进入每一步摘要
  const openStep = track.steps.find(s => s.type === 'click' && s.target === 'wt-open-modal-btn');
  assert.strictEqual(openStep.post.modal.open, true);
  assert.strictEqual(openStep.post.modal.version, 1);
  // 确认步的 post 在 60ms 沉淀后应已包含异步回写
  const confirmStep = track.steps.find(s => s.type === 'click' && s.target === 'wt-modal-confirm');
  assert.match(confirmStep.post.text['wt-async-status'], /v1/);
  // 第二次打开时版本递增
  assert.strictEqual(track.steps.filter(s => s.target === 'wt-open-modal-btn').length, 2);

  // 回放：从初始状态逐步执行，全部通过
  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'completed',
    '弹窗被重建过，回放仍应全部成功: ' + JSON.stringify(recorder.halt));
  assert.strictEqual(result.stepsExecuted, track.steps.length);
  assert.strictEqual(doc.getElementById('wt-async-status').textContent,
    track.steps[track.steps.length - 1].post.text['wt-async-status']);

  dom.window.close();
});
