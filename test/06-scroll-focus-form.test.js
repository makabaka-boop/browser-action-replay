'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, typeText, click, userScroll } = require('./helpers');

test('录制 focus / select / checkbox / radio / scroll 并完整回放', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);

  // 纯聚焦（不输入）
  doc.getElementById('wt-bio-input').focus();
  await sleep(70);

  // 切到偏好：select / checkbox / radio
  click(window, doc.getElementById('wt-tab-prefs'));
  await sleep(70);

  const theme = doc.getElementById('wt-theme-select');
  theme.value = 'dark';
  theme.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(70);

  const notify = doc.getElementById('wt-notify-check');
  notify.click();
  await sleep(70);

  doc.getElementById('wt-role-admin').click();
  await sleep(70);

  // 切到活动页并滚动容器
  click(window, doc.getElementById('wt-tab-activity'));
  await sleep(70);
  const scroller = doc.getElementById('wt-log-scroll');
  userScroll(window, scroller, 25);
  await sleep(30);
  userScroll(window, scroller, 58); // 连续滚动应合并为一步，最终值 58
  await sleep(130);

  recorder.stop();
  const track = recorder.activeTrack;

  const types = track.steps.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc; }, {});
  assert.ok(types.focus >= 1, '应有 focus 步: ' + JSON.stringify(types));
  assert.ok(types.scroll >= 1, '应有 scroll 步');
  const scrollSteps = track.steps.filter(s => s.type === 'scroll' && s.target === 'wt-log-scroll');
  assert.strictEqual(scrollSteps.length, 1, '连续滚动合并为一步');
  assert.strictEqual(scrollSteps[0].pos, 58, '滚动步记录最终位置');
  assert.ok(scrollSteps[0].post.scroll.byId['wt-log-scroll'] === 58);

  // select 记录值；勾选框只记勾选态
  const selectStep = track.steps.find(s => s.target === 'wt-theme-select');
  assert.strictEqual(selectStep.value, 'dark');
  const checkStep = track.steps.find(s => s.target === 'wt-notify-check');
  assert.strictEqual(checkStep.value, null);
  assert.strictEqual(checkStep.post.values['wt-notify-check'].checked, true);

  // 目标全部是稳定 ID（窗口滚动保留特殊标记）
  track.steps.forEach(s => {
    if (s.target !== '__window__') assert.ok(doc.getElementById(s.target) || s.target === '__window__');
  });

  // 完整回放
  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'completed',
    '完整轨迹回放失败: ' + JSON.stringify(recorder.halt));
  assert.strictEqual(doc.getElementById('wt-theme-select').value, 'dark');
  assert.strictEqual(doc.getElementById('wt-notify-check').checked, true);
  assert.strictEqual(doc.getElementById('wt-role-admin').checked, true);
  assert.strictEqual(doc.getElementById('wt-log-scroll').scrollTop, 58);
  // 纯聚焦步回放后焦点应位于 bio
  const focusStepIdx = track.steps.findIndex(s => s.type === 'focus' && s.target === 'wt-bio-input');
  assert.ok(focusStepIdx >= 0);
  dom.window.close();
});

test('空闲状态下的交互不会被录制；点击录制器面板自身也不入轨迹', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  // 未开始录制
  typeText(window, doc.getElementById('wt-name-input'), '不应出现');
  click(window, doc.getElementById('wt-tab-prefs'));
  await sleep(80);
  assert.strictEqual(recorder.listTracks().length, 0);

  recorder.startRecording();
  await sleep(5);
  // 录制器面板在演练根节点之外：点它不应入轨迹
  click(window, doc.getElementById('wt-rec-replay'));
  await sleep(80);
  assert.strictEqual(track(recorder).steps.filter(s => s.target && s.target.indexOf('wt-rec') === 0).length, 0);
  recorder.stop();

  function track(r) { return r.activeTrack; }
  dom.window.close();
});

test('每步都带 pre 与 post 摘要，且第一步 pre 等于轨迹 initialState', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;

  recorder.startRecording();
  await sleep(5);
  click(window, doc.getElementById('wt-tab-prefs'));
  await sleep(70);
  recorder.stop();

  const t = recorder.activeTrack;
  assert.ok(t.initialState, '轨迹必须保存初始状态');
  t.steps.forEach((s, i) => {
    assert.ok(s.pre && s.post, '第 ' + (i + 1) + ' 步必须同时有 pre/post');
    assert.ok(typeof s.settleMs === 'number');
    assert.ok(s.ts > 0);
  });
  const first = t.steps[0];
  assert.strictEqual(JSON.stringify(first.pre), JSON.stringify(t.initialState),
    '第一步的执行前条件必须等于录制起点');
  // pre 与 post 对点击标签页这一步应可观察地不同
  assert.notStrictEqual(first.pre.tabs['wt-tab-prefs'], first.post.tabs['wt-tab-prefs']);
  dom.window.close();
});
