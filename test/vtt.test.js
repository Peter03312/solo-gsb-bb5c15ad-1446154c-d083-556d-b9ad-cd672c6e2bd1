'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTimestamp, parseTimestamp, parseWebVtt, diffCueSegments, toWebVtt,
} = require('../src/vtt');

test('parseTimestamp：各种合法/非法时间戳', () => {
  assert.equal(parseTimestamp('00:00:00.000'), 0);
  assert.equal(parseTimestamp('00:00:01.500'), 1500);
  assert.equal(parseTimestamp('01:02:03.250'), 3723250);
  assert.equal(parseTimestamp('00:00.000'), 0);            // 省略小时
  assert.equal(parseTimestamp('0:00.000'), 0);
  // 分秒越界 / 格式错误
  assert.equal(parseTimestamp('00:60.000'), null);
  assert.equal(parseTimestamp('00:00.60'), null);
  assert.equal(parseTimestamp('00:00:00'), null);          // 缺毫秒
  assert.equal(parseTimestamp('00:00:00.00'), null);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(parseTimestamp(null), null);
});

test('parseWebVtt：系统导出文件可原样解析（序号行/多行正文/空行）', () => {
  const content = toWebVtt([
    { start_ms: 0, end_ms: 1000, text: '第一行\n第二行' },
    { start_ms: 1500, end_ms: 2500, text: '结尾' },
  ]);
  const r = parseWebVtt(content);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.cues, [
    { start_ms: 0, end_ms: 1000, text: '第一行\n第二行' },
    { start_ms: 1500, end_ms: 2500, text: '结尾' },
  ]);
});

test('parseWebVtt：BOM/CRLF/NOTE 块/时间行设置 均容忍', () => {
  const v = '\uFEFFWEBVTT\r\n\r\nNOTE 这是说明\r\n不应被解析\r\n\r\n' +
    '00:00:00.000 --> 00:00:01.000 align:start position:0%\r\n正文\r\n\r\n' +
    'NOTE\r\n\r\n' +
    '2\r\n00:00:02.000 --> 00:00:03.000\r\n第二条';
  const r = parseWebVtt(v);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.cues.length, 2);
  assert.equal(r.cues[0].text, '正文');
  assert.equal(r.cues[1].start_ms, 2000);
  assert.equal(r.cues[1].text, '第二条');
});

test('parseWebVtt：空载荷是合法 cue（空白字幕），空文件也合法', () => {
  const r1 = parseWebVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n');
  assert.equal(r1.ok, true);
  assert.equal(r1.cues.length, 1);
  assert.equal(r1.cues[0].text, '');

  const r2 = parseWebVtt('WEBVTT\n\nNOTE 只有说明\n');
  assert.equal(r2.ok, true);
  assert.equal(r2.cues.length, 0);
});

test('parseWebVtt：签名缺失/时间戳非法/零时长/逆序/重叠 → 损坏', () => {
  assert.equal(parseWebVtt('NOT VTT\n').ok, false);
  assert.equal(parseWebVtt('XWEBVTT\n').ok, false);
  const reversed = parseWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:00.000\nx');
  assert.equal(reversed.ok, false);
  assert.match(reversed.reason, /晚于/);
  const zero = parseWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:01.000\nx');
  assert.equal(zero.ok, false);
  assert.match(zero.reason, /晚于/);
  const badStamp = parseWebVtt('WEBVTT\n\n00:00:00.000 --> 00:00:xx.000\nx');
  assert.equal(badStamp.ok, false);
  const overlap = parseWebVtt(
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\na\n\n00:00:01.000 --> 00:00:03.000\nb');
  assert.equal(overlap.ok, false);
  assert.match(overlap.reason, /重叠/);
  const unordered = parseWebVtt(
    'WEBVTT\n\n00:00:02.000 --> 00:00:03.000\na\n\n00:00:00.000 --> 00:00:01.000\nb');
  assert.equal(unordered.ok, false);
  assert.match(unordered.reason, /升序/);
  const noTiming = parseWebVtt('WEBVTT\n\n1\n没有时间行\n');
  assert.equal(noTiming.ok, false);
});

test('diffCueSegments：完全相同 → 无差异', () => {
  const cues = [{ start_ms: 0, end_ms: 1000, text: 'a' }];
  assert.deepEqual(diffCueSegments(cues, cues.map((c) => ({ ...c }))), []);
});

test('diffCueSegments：文本局部修改只覆盖变化区段', () => {
  const a = [
    { start_ms: 0, end_ms: 1000, text: '一' },
    { start_ms: 1000, end_ms: 2000, text: '二' },
    { start_ms: 2000, end_ms: 3000, text: '三' },
  ];
  const b = [
    { start_ms: 0, end_ms: 1000, text: '一' },
    { start_ms: 1000, end_ms: 2000, text: '二改' },
    { start_ms: 2000, end_ms: 3000, text: '三' },
  ];
  assert.deepEqual(diffCueSegments(a, b), [
    { start_ms: 1000, end_ms: 2000, base_text: '二', target_text: '二改' },
  ]);
});

test('diffCueSegments：拆分合并两侧文本都不变时区段被合并为零差异', () => {
  // 同文本一拆为二 → 显示文本逐区段一致
  const a = [{ start_ms: 0, end_ms: 3000, text: '同' }];
  const b = [
    { start_ms: 0, end_ms: 1500, text: '同' },
    { start_ms: 1500, end_ms: 3000, text: '同' },
  ];
  assert.deepEqual(diffCueSegments(a, b), []);
});

test('diffCueSegments：仅一侧在切点切开且两侧文本均恒定 → 合并为一条整段', () => {
  const a = [{ start_ms: 0, end_ms: 3000, text: '旧' }];
  const b = [
    { start_ms: 0, end_ms: 1200, text: '新' },
    { start_ms: 1200, end_ms: 3000, text: '新' },
  ];
  assert.deepEqual(diffCueSegments(a, b), [
    { start_ms: 0, end_ms: 3000, base_text: '旧', target_text: '新' },
  ]);
});

test('diffCueSegments：相邻但一侧文本在边界变化 → 不得合并', () => {
  const a = [
    { start_ms: 0, end_ms: 1000, text: '甲' },
    { start_ms: 1000, end_ms: 2000, text: '乙' },
  ];
  const b = [{ start_ms: 0, end_ms: 2000, text: '整句' }];
  assert.deepEqual(diffCueSegments(a, b), [
    { start_ms: 0, end_ms: 1000, base_text: '甲', target_text: '整句' },
    { start_ms: 1000, end_ms: 2000, base_text: '乙', target_text: '整句' },
  ]);
});

test('diffCueSegments：移时产生两个单侧区段；空字幕与空档区分', () => {
  const a = [{ start_ms: 0, end_ms: 1000, text: '' }];
  const b = [{ start_ms: 0, end_ms: 1000, text: '有了' }];
  assert.deepEqual(diffCueSegments(a, b), [
    { start_ms: 0, end_ms: 1000, base_text: '', target_text: '有了' },
  ]);
  // 空字幕 vs 无字幕（null）
  const c = [{ start_ms: 0, end_ms: 1000, text: '' }];
  const d = [];
  assert.deepEqual(diffCueSegments(c, d), [
    { start_ms: 0, end_ms: 1000, base_text: '', target_text: null },
  ]);
});

test('formatTimestamp 往返一致', () => {
  for (const ms of [0, 1, 999, 3600000, 3723250]) {
    assert.equal(parseTimestamp(formatTimestamp(ms)), ms);
  }
});
