'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { bootPage, sleep, typeText } = require('./helpers');

/* 需求：密码输入只记录“已改变”，轨迹、pre/post 摘要、持久化数据中都不得出现字符。 */
test('密码输入全程脱敏：轨迹与持久化中不存在任何密码字符', async () => {
  const { window, recorder, dom } = await bootPage();
  const doc = window.document;
  const SECRET = 'S3cr3t!密碼';

  recorder.startRecording();
  await sleep(5);

  const pwd = doc.getElementById('wt-password-input');
  typeText(window, pwd, SECRET);
  await sleep(70);
  recorder.stop();

  const track = recorder.activeTrack;
  const pwdSteps = track.steps.filter(s => s.target === 'wt-password-input');
  assert.strictEqual(pwdSteps.length, 1, '连续输入应合并为一步');

  // 轨迹中不允许出现密码原文（用具有辨识度的片段，避免误伤时间戳中的数字）
  const serialized = JSON.stringify(track);
  ['S3cr3t', 'cr3t!', '密碼'].forEach(needle => {
    assert.ok(!serialized.includes(needle), '轨迹序列化结果不得包含密码片段: ' + needle);
  });

  // value 恒为 null，redacted 为真
  pwdSteps.forEach(s => {
    assert.strictEqual(s.redacted, true);
    assert.strictEqual(s.value, null, '密码步不得保存字符');
  });

  // pre/post 中密码字段只有 {type:'password', changed:boolean}（对象跨 jsdom realm，按 JSON 比较）
  pwdSteps.forEach(s => {
    assert.strictEqual(JSON.stringify(s.post.values['wt-password-input']),
      JSON.stringify({ type: 'password', changed: true }));
    assert.strictEqual(JSON.stringify(s.pre.values['wt-password-input']),
      JSON.stringify({ type: 'password', changed: false }));
  });

  // 持久化（跨刷新载体）中同样不含字符
  const persisted = recorder.storage.serialize();
  const persistedText = JSON.stringify(persisted);
  ['S3cr3t', 'cr3t!', '密碼'].forEach(needle => {
    assert.ok(!persistedText.includes(needle), '持久化数据不得包含密码片段: ' + needle);
  });

  // 回放：无字符可比对，仅推进“已改变”状态，整体一致
  const result = await recorder.replay(track);
  assert.strictEqual(result.status, 'completed',
    '密码轨迹应可回放: ' + JSON.stringify(recorder.halt));
  const lastPost = track.steps[track.steps.length - 1].post;
  assert.strictEqual(JSON.stringify(lastPost.values['wt-password-input']),
    JSON.stringify({ type: 'password', changed: true }));

  dom.window.close();
});
