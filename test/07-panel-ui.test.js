'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, click } = require('./helpers');

/* 面板集成：通过真实面板按钮开始/停止/回放；分歧时面板展示停点、录制值与当前值。 */
test('录制器面板：开始/停止/回放，分歧时渲染停点与对照值', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  // 通过面板按钮开始
  doc.getElementById('wt-rec-record').click();
  assert.strictEqual(recorder.mode, 'recording');
  assert.strictEqual(doc.getElementById('wt-recorder-dot').getAttribute('data-mode'), 'recording');

  click(window, doc.getElementById('wt-open-modal-btn'));
  await sleep(70);
  doc.getElementById('wt-rec-stop').click();
  assert.strictEqual(recorder.mode, 'idle');

  const track = recorder.activeTrack;
  // 制造 post 分歧
  track.steps[tick()].post.modal.open = false;
  function tick() { return track.steps.findIndex(s => s.target === 'wt-open-modal-btn'); }

  // 面板回放
  doc.getElementById('wt-rec-replay').click();
  await sleep(120);

  const haltBox = doc.querySelector('.wt-rec-halt');
  assert.ok(haltBox, '面板必须渲染停驻框');
  const text = haltBox.textContent;
  assert.ok(text.includes('停在第一处分歧'));
  assert.ok(text.includes('wt-open-modal-btn'));
  assert.ok(text.includes('录制值'), '需展示录制值: ' + text);
  assert.ok(text.includes('当前值'), '需展示当前值: ' + text);
  // false（录制）/ true（当前）
  assert.ok(/false/.test(text) && /true/.test(text));

  // 按钮状态回到可再次录制/回放
  assert.strictEqual(doc.getElementById('wt-rec-record').disabled, false);
  assert.strictEqual(doc.getElementById('wt-rec-stop').disabled, true);
  dom.window.close();
});
