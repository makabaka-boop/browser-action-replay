'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, createMemoryStorage, sleep, typeText, click } = require('./helpers');

/* 需求：停止录制之后，迟到的异步界面更新不得写进旧轨迹。
 * 弹窗确认会在 30ms 后回写 #wt-async-status；录制沉淀为 60ms。
 * 场景：在 30ms 回写落地“之前”立刻停止录制 → 旧轨迹的最后一步 post
 *      必须保持停止瞬间的观察值，之后的回写不得回改轨迹。 */
test('停止录制后迟到的异步回写不得进入旧轨迹', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-open-modal-btn'));
  await sleep(70);
  typeText(window, doc.getElementById('wt-modal-note'), 'x');
  await sleep(70);

  // 确认：弹窗立即关闭，30ms 后才回写
  click(window, doc.getElementById('wt-modal-confirm'));
  // 抢在 30ms 回写之前停止（停止会立即定稿，post 捕获的是“尚未回写”状态）
  recorder.stop();

  const track = recorder.activeTrack;
  const confirmStep = track.steps.filter(s => s.target === 'wt-modal-confirm').pop();
  assert.ok(confirmStep, '应有确认步');
  const frozenAsync = confirmStep.post.text['wt-async-status'];
  assert.strictEqual(frozenAsync, '（无）', '定稿瞬间异步回写尚未发生');
  const frozenEndedAt = track.endedAt;

  // 等待远超回写延迟
  await sleep(120);
  // 应用界面确实收到了迟到更新
  assert.match(doc.getElementById('wt-async-status').textContent, /v1/);

  // 但旧轨迹必须原封不动：没有新增步骤、post 没有被回改
  const again = JSON.parse(JSON.stringify(recorder.storage.get('walkthrough-recorder:tracks:v1')))
    .find(t => t.id === track.id);
  assert.strictEqual(again.steps.length, track.steps.length, '迟到更新不得追加步骤');
  assert.strictEqual(again.steps[again.steps.length - 1].post.text['wt-async-status'], '（无）',
    '迟到更新不得回改最后一步的 post');
  assert.strictEqual(again.endedAt, frozenEndedAt);
  dom.window.close();
});

/* 开始新录制后，旧会话的迟到回调也不得写进新/旧轨迹。 */
test('开始新录制使旧轨迹的挂起回调全部作废', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  typeText(window, doc.getElementById('wt-name-input'), '甲');
  // 不等沉淀（60ms），立刻开始新录制
  const oldId = recorder.activeTrack.id;
  recorder.startRecording();
  assert.strictEqual(recorder.activeTrack.id !== oldId, true);
  await sleep(120);

  const tracks = recorder.listTracks();
  const oldTrack = tracks.find(t => t.id === oldId);
  // 旧轨迹在新录制开始时被立即定稿一次（已发生动作归旧轨迹），之后不再变化
  const oldStepsAfter = oldTrack.steps.length;
  await sleep(80);
  const oldTrack2 = recorder.listTracks().find(t => t.id === oldId);
  assert.strictEqual(oldTrack2.steps.length, oldStepsAfter, '旧轨迹在新录制后不得再增长');
  recorder.stop();
  dom.window.close();
});

/* 停止回放后，回放循环不得再继续执行后续步骤，迟到 settle 也不能产生“成功”。 */
test('停止回放后不得再执行后续步骤', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-prefs'));
  await sleep(70);
  click(window, doc.getElementById('wt-open-modal-btn'));
  await sleep(70);
  click(window, doc.getElementById('wt-modal-confirm'));
  await sleep(70);
  recorder.stop();
  const track = recorder.activeTrack;
  const total = track.steps.length;

  // 在第 1 步等待沉淀的间隙停止回放（用 microtask 后立即 stop）
  const playPromise = recorder.replay(track);
  await sleep(2);
  assert.strictEqual(recorder.mode, 'playing');
  recorder.stop();
  const result = await playPromise;

  assert.strictEqual(result.status, 'stopped');
  assert.ok(result.stepsExecuted < total, '不应跑完所有步骤');
  await sleep(200); // 熬过所有 settle / 30ms 异步窗口
  // 没有 halt 伪装成失败、也没有 completed；模式稳定 idle，步骤数不再推进
  assert.strictEqual(recorder.mode, 'idle');
  assert.ok(recorder.lastReplayed < total - 1);
  dom.window.close();
});

/* 录制可跨刷新保存：模拟“关闭页面 → 用同一份持久化重新打开页面”。 */
test('录制轨迹跨“刷新”持久化，刷新后可回放最新轨迹', async () => {
  const sharedStorage = createMemoryStorage();

  // —— 第一次页面会话：录制 ——
  const first = await bootPage(true, sharedStorage);
  first.recorder.startRecording();
  await sleep(5);
  typeText(first.window, first.window.document.getElementById('wt-name-input'), '王五');
  await sleep(70);
  click(first.window, first.window.document.getElementById('wt-tab-prefs'));
  await sleep(70);
  first.recorder.stop();
  const trackId = first.recorder.activeTrack.id;
  const stepsOnDisk = first.recorder.activeTrack.steps.length;
  assert.ok(stepsOnDisk >= 2);
  first.dom.window.close();

  // —— 刷新：新 JSDOM、新录制器实例，但读同一份 storage ——
  const second = await bootPage(true, sharedStorage);
  assert.strictEqual(second.recorder.pagePresent, true);
  const restored = second.recorder.listTracks();
  assert.strictEqual(restored.length, 1, '刷新后应读到此前持久化的轨迹');
  assert.strictEqual(restored[0].id, trackId);
  assert.strictEqual(restored[0].steps.length, stepsOnDisk);

  const result = await second.recorder.replay();
  assert.strictEqual(result.status, 'completed',
    '刷新后回放应成功: ' + JSON.stringify(second.recorder.halt));
  assert.strictEqual(result.stepsExecuted, stepsOnDisk);
  assert.strictEqual(second.window.document.getElementById('wt-name-input').value, '王五');
  assert.strictEqual(
    second.window.document.getElementById('wt-panel-prefs').classList.contains('wt-hidden'), false);
  second.dom.window.close();
});

/* 页面守卫：非演练页（无 data-walkthrough-page）录制器完全不工作。 */
test('非演练页不挂载录制器', async () => {
  const page = await bootPage(false);
  assert.strictEqual(page.recorder.pagePresent, false);
  assert.strictEqual(page.recorder.startRecording(), null);
  assert.strictEqual(page.window.document.getElementById('wt-recorder-panel'), null,
    '不应注入录制器面板');
  page.dom.window.close();
});
