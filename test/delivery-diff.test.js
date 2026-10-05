'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');
const { toWebVtt } = require('../src/vtt');

let server;
let base;
let db;

before(async () => {
  db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

/**
 * 直接写入一组冻结交付批次（对照只依赖冻结快照，时间轴拆分/合并/移时
 * 无需经过当前字幕与交付核对流程）。
 * specs: [{ kind:'source'|'translation', lang?, cues:[{start_ms,end_ms,text}] }]
 * 返回批次 id。
 */
function insertBatch(projectId, specs, note = '') {
  const bid = db.prepare(
    'INSERT INTO delivery_batches (project_id, note, sub_version, rules_version, cue_count, lang_count) VALUES (?, ?, 1, 1, ?, ?)'
  ).run(projectId, note, specs[0].cues.length, specs.filter((s) => s.kind === 'translation').length).lastInsertRowid;

  specs.forEach((s, ord) => {
    const content = toWebVtt(s.cues);
    let exportId;
    let exportKind;
    let version;
    if (s.kind === 'source') {
      version = (db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM exports WHERE project_id = ?').get(projectId).v) + 1;
      exportKind = 'exports';
      exportId = db.prepare('INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, ?, ?, ?)')
        .run(projectId, version, content, s.cues.length).lastInsertRowid;
    } else {
      version = (db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM translation_exports WHERE project_id = ? AND lang = ?')
        .get(projectId, s.lang).v) + 1;
      exportKind = 'translation_exports';
      exportId = db.prepare('INSERT INTO translation_exports (project_id, lang, version, content, cue_count) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, s.lang, version, content, s.cues.length).lastInsertRowid;
    }
    db.prepare(
      'INSERT INTO delivery_files (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(bid, projectId, s.kind, s.lang ?? null, exportKind, exportId, version, s.cues.length, ord);
  });
  return bid;
}

async function diffReport(pid, b, t) {
  return api(`/api/projects/${pid}/deliveries/diff?base_id=${b}&target_id=${t}`);
}

/** 走真实交付流程造一个原文+英文批次 */
async function realDelivery(pid, cues, enTexts) {
  const line = cues.map((c) => ({ subtitle_id: c.id, version: 1 }));
  for (const [i, t] of enTexts.entries()) {
    const r = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[i].id}`, 'PUT', { text: t, cue_version: 1 });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  }
  const p = await api(`/api/projects/${pid}`);
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: p.body.sub_version, rules_version: 1,
    languages: ['en'],
    translations: { en: line },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test('同批比较（含自己）：快照完好 → 空差异、文件全部 unchanged', async () => {
  const created = await api('/api/projects', 'POST', { name: '同批对照', words: GOOD_WORDS, cuts: [1200] });
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  const batch = await realDelivery(pid, layout.body.subtitles, ['Hello world', 'Welcome']);

  const r = await diffReport(pid, batch.id, batch.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.same_batch, true);
  assert.deepEqual(r.body.languages.union, ['en']);
  assert.deepEqual(r.body.languages.base_only, []);
  assert.deepEqual(r.body.languages.target_only, []);
  assert.equal(r.body.summary.changed, 0);
  assert.equal(r.body.summary.unchanged, 2); // 原文 + 英文
  assert.equal(r.body.summary.difference_count, 0);
  for (const f of r.body.files) {
    assert.equal(f.status, 'both');
    assert.equal(f.diff_count, 0);
    assert.deepEqual(f.differences, []);
  }
});

test('文本变化：按时间区段列出起止毫秒、两侧文本与各自文件版本', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '文本变化', words: GOOD_WORDS, cuts: [1200] })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [
      { start_ms: 0, end_ms: 1000, text: '原文甲' },
      { start_ms: 1000, end_ms: 2000, text: '原文乙' },
    ] },
    { kind: 'translation', lang: 'en', cues: [
      { start_ms: 0, end_ms: 1000, text: 'Alpha' },
      { start_ms: 1000, end_ms: 2000, text: 'Beta' },
    ] },
  ], '基准');
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [
      { start_ms: 0, end_ms: 1000, text: '原文甲改' },
      { start_ms: 1000, end_ms: 2000, text: '原文乙' },
    ] },
    { kind: 'translation', lang: 'en', cues: [
      { start_ms: 0, end_ms: 1000, text: 'Alpha edited' },
      { start_ms: 1000, end_ms: 2000, text: 'Beta' },
    ] },
  ], '目标');

  const r = await diffReport(pid, b1, b2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const src = r.body.files.find((f) => f.kind === 'source');
  assert.equal(src.diff_count, 1);
  assert.deepEqual(src.differences[0], {
    start_ms: 0, end_ms: 1000,
    start: '00:00:00.000', end: '00:00:01.000',
    base_text: '原文甲', target_text: '原文甲改',
    base_version: 1, target_version: 2,
  });
  const en = r.body.files.find((f) => f.lang === 'en');
  assert.equal(en.diff_count, 1);
  assert.equal(en.differences[0].base_text, 'Alpha');
  assert.equal(en.differences[0].target_text, 'Alpha edited');
  assert.equal(r.body.summary.changed, 2);
  assert.equal(r.body.summary.unchanged, 0);
});

test('拆分：一侧一行、另一侧两行（不按行号配对）→ 以各自区段列出', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '拆分', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 3000, text: '整句' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [
      { start_ms: 0, end_ms: 1500, text: '上半' },
      { start_ms: 1500, end_ms: 3000, text: '下半' },
    ] },
  ]);
  const r = await diffReport(pid, b1, b2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const src = r.body.files[0];
  assert.deepEqual(src.differences.map((d) => [d.start_ms, d.end_ms, d.base_text, d.target_text]), [
    [0, 1500, '整句', '上半'],
    [1500, 3000, '整句', '下半'],
  ]);
});

test('合并：一侧两行、另一侧一行', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '合并', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [
      { start_ms: 0, end_ms: 1500, text: '上半' },
      { start_ms: 1500, end_ms: 3000, text: '下半' },
    ] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 3000, text: '合并后整句' }] },
  ]);
  const r = await diffReport(pid, b1, b2);
  const src = r.body.files[0];
  assert.deepEqual(src.differences.map((d) => [d.start_ms, d.end_ms, d.base_text, d.target_text]), [
    [0, 1500, '上半', '合并后整句'],
    [1500, 3000, '下半', '合并后整句'],
  ]);
});

test('整体移时：文本相同但时间位置变化 → 旧区段与新区段分别列出，不误报文本差异', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '移时', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '同一句' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 2000, end_ms: 3000, text: '同一句' }] },
  ]);
  const r = await diffReport(pid, b1, b2);
  const src = r.body.files[0];
  assert.deepEqual(src.differences.map((d) => [d.start_ms, d.end_ms, d.base_text, d.target_text]), [
    [0, 1000, '同一句', null],
    [2000, 3000, null, '同一句'],
  ]);
});

test('相邻差异区段合并：一侧文本跨切点不变时只报一条', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '合并区段', words: GOOD_WORDS })).body.id;
  // 基准侧两行同文本（实际不会这样，但用于检验“两侧各自文本跨边界均未变才合并”）：
  // 目标侧一整行另一句。期望：基准侧文本在 1500 处变化 → 不能合并。
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [
      { start_ms: 0, end_ms: 1500, text: '甲' },
      { start_ms: 1500, end_ms: 3000, text: '乙' },
    ] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 3000, text: '全新整句' }] },
  ]);
  const r1 = await diffReport(pid, b1, b2);
  assert.equal(r1.body.files[0].diff_count, 2, '基准侧文本跨边界变化，不得合并');

  // 基准侧一整行，目标侧拆成两行但两侧文本均不变 → 合并为一条
  const b3 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 3000, text: '不变的整句' }] },
  ]);
  const b4 = insertBatch(pid, [
    { kind: 'source', cues: [
      { start_ms: 0, end_ms: 1500, text: '不变的整句' },
      { start_ms: 1500, end_ms: 3000, text: '不变的整句' },
    ] },
  ]);
  // 文本完全相同 → 实际为空差异（拆分点两侧文本一致）
  const r2 = await diffReport(pid, b3, b4);
  assert.equal(r2.body.files[0].diff_count, 0);

  // 基准侧一整行 X，目标侧拆成两行同为 Y → 合并为一条 [0,3000]
  const b5 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 3000, text: 'X' }] },
  ]);
  const b6 = insertBatch(pid, [
    { kind: 'source', cues: [
      { start_ms: 0, end_ms: 1500, text: 'Y' },
      { start_ms: 1500, end_ms: 3000, text: 'Y' },
    ] },
  ]);
  const r3 = await diffReport(pid, b5, b6);
  assert.deepEqual(r3.body.files[0].differences.map((d) => [d.start_ms, d.end_ms]), [[0, 3000]]);
});

test('空白字幕与字幕的转换：空载荷与无字幕（空档）均如实列出', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '空白字幕', words: GOOD_WORDS })).body.id;
  // 基准：空文本字幕（空白字幕）；目标：同区间改为有文本字幕
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '补上的字幕' }] },
  ]);
  const r1 = await diffReport(pid, b1, b2);
  assert.equal(r1.body.files[0].diff_count, 1);
  assert.equal(r1.body.files[0].differences[0].base_text, '');
  assert.equal(r1.body.files[0].differences[0].target_text, '补上的字幕');

  // 空字幕 vs 该区间无任何字幕（整体删除空 cue）：'' 与 null 不同，必须报告
  const b3 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 5000, end_ms: 6000, text: '' }] },
  ]);
  const b4 = insertBatch(pid, [{ kind: 'source', cues: [] }]);
  const r2 = await diffReport(pid, b3, b4);
  assert.deepEqual(r2.body.files[0].differences.map((d) => [d.start_ms, d.end_ms, d.base_text, d.target_text]), [
    [5000, 6000, '', null],
  ]);
});

test('语言并集：单侧语言标 added/removed，并给出对应文件版本与下载地址', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '语言增减', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
    { kind: 'translation', lang: 'en', cues: [{ start_ms: 0, end_ms: 1000, text: 'English' }] },
    { kind: 'translation', lang: 'fr', cues: [{ start_ms: 0, end_ms: 1000, text: 'Français' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
    { kind: 'translation', lang: 'en', cues: [{ start_ms: 0, end_ms: 1000, text: 'English' }] },
    { kind: 'translation', lang: 'ja-JP', cues: [{ start_ms: 0, end_ms: 1000, text: '日本語' }] },
  ]);
  const r = await diffReport(pid, b1, b2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.languages.union, ['en', 'fr', 'ja-JP']);
  assert.deepEqual(r.body.languages.base_only, ['fr']);
  assert.deepEqual(r.body.languages.target_only, ['ja-JP']);

  const fr = r.body.files.find((f) => f.lang === 'fr');
  assert.equal(fr.status, 'removed');
  assert.equal(fr.base.version, 1);
  assert.equal(fr.target, null);
  assert.equal(fr.base.download_url, `/api/projects/${pid}/translations/fr/exports/1`);
  assert.deepEqual(fr.differences, []);

  const ja = r.body.files.find((f) => f.lang === 'ja-JP');
  assert.equal(ja.status, 'added');
  assert.equal(ja.base, null);
  assert.equal(ja.target.version, 1);
  assert.equal(ja.target.download_url, `/api/projects/${pid}/translations/ja-JP/exports/1`);

  const en = r.body.files.find((f) => f.lang === 'en');
  assert.equal(en.status, 'both');
  assert.equal(en.diff_count, 0);
  assert.equal(r.body.summary.added, 1);
  assert.equal(r.body.summary.removed, 1);
  assert.equal(r.body.summary.unchanged, 2); // 原文 + en
  assert.equal(r.body.summary.changed, 0);
});

test('拒绝：批次不存在 / 不属于该项目 / 参数非法', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '拒绝', words: GOOD_WORDS })).body.id;
  const other = (await api('/api/projects', 'POST', { name: '别的项目', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
  ]);
  const otherBatch = insertBatch(other, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
  ]);

  const missing = await diffReport(pid, 999999, b1);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.reason_code, 'batch_not_found');

  const cross = await diffReport(pid, b1, otherBatch);
  assert.equal(cross.status, 404);
  assert.equal(cross.body.reason_code, 'batch_other_project');
  assert.match(cross.body.error, /不属于项目/);

  const badParam = await api(`/api/projects/${pid}/deliveries/diff?base_id=${b1}&target_id=abc`);
  assert.equal(badParam.status, 400);
  const missingParam = await api(`/api/projects/${pid}/deliveries/diff?base_id=${b1}`);
  assert.equal(missingParam.status, 400);
});

test('快照缺失：指出批次和文件，整份报告失败（无部分结果）', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '快照缺失', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文1' }] },
    { kind: 'translation', lang: 'en', cues: [{ start_ms: 0, end_ms: 1000, text: 'One' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文2' }] },
    { kind: 'translation', lang: 'en', cues: [{ start_ms: 0, end_ms: 1000, text: 'Two' }] },
  ]);
  // 目标批英文快照行丢失（导出行不存在：用悬空 export_id 模拟存储丢失/行被清掉）
  db.prepare('UPDATE delivery_files SET export_id = ? WHERE batch_id = ? AND lang = ?')
    .run(999999, b2, 'en');

  const r = await diffReport(pid, b1, b2);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.ok(!('files' in r.body), '失败时不得返回部分结果');
  assert.equal(r.body.snapshot_problems.length, 1);
  const prob = r.body.snapshot_problems[0];
  assert.equal(prob.problem, 'snapshot_missing');
  assert.equal(prob.batch_id, b2);
  assert.equal(prob.file.lang, 'en');
  assert.match(prob.reason, /快照缺失/);
});

test('快照格式损坏：指出批次和文件，整份报告失败（不返回部分结果）', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '快照损坏', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文1' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文2' }] },
  ]);
  // 把目标批原文快照改成损坏内容
  const srcFile = db.prepare("SELECT export_id FROM delivery_files WHERE batch_id = ? AND kind = 'source'").get(b2);
  db.prepare('UPDATE exports SET content = ? WHERE id = ?').run('THIS IS NOT VTT', srcFile.export_id);

  const r = await diffReport(pid, b1, b2);
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.ok(!('files' in r.body));
  const prob = r.body.snapshot_problems.find((p) => p.problem === 'snapshot_corrupt');
  assert.ok(prob);
  assert.equal(prob.batch_id, b2);
  assert.equal(prob.file.kind, 'source');
  assert.match(prob.reason, /WEBVTT/);
});

test('损坏类型：时间戳非法 / cue 重叠 / cue 数不符 均判快照损坏', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '多种损坏', words: GOOD_WORDS })).body.id;
  const good = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
  ]);

  const corrupt = (content, cueCount) => {
    const bid = db.prepare(
      'INSERT INTO delivery_batches (project_id, note, sub_version, rules_version, cue_count, lang_count) VALUES (?, ?, 1, 1, ?, 0)'
    ).run(pid, '', cueCount).lastInsertRowid;
    const nextV = (db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM exports WHERE project_id = ?').get(pid).v) + 1;
    const eid = db.prepare('INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, ?, ?, ?)')
      .run(pid, nextV, content, cueCount).lastInsertRowid;
    db.prepare(
      "INSERT INTO delivery_files (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord) VALUES (?, ?, 'source', NULL, 'exports', ?, ?, ?, 0)"
    ).run(bid, pid, eid, nextV, cueCount);
    return bid;
  };

  const badTime = corrupt('WEBVTT\n\n1\n00:00:00.000 --> 00:00:xx.000\n坏', 1);
  const r1 = await diffReport(pid, good, badTime);
  assert.equal(r1.status, 500);
  assert.ok(r1.body.snapshot_problems.some((p) => /时间戳/.test(p.reason)));

  const overlap = corrupt(
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n甲\n\n00:00:01.000 --> 00:00:03.000\n乙', 2);
  const r2 = await diffReport(pid, good, overlap);
  assert.equal(r2.status, 500);
  assert.ok(r2.body.snapshot_problems.some((p) => /重叠/.test(p.reason)));

  const countMismatch = corrupt(toWebVtt([{ start_ms: 0, end_ms: 1000, text: '原文' }]), 2);
  const r3 = await diffReport(pid, good, countMismatch);
  assert.equal(r3.status, 500);
  assert.ok(r3.body.snapshot_problems.some((p) => /cue 数/.test(p.reason)));
});

test('只读：当前字幕/译文的后续修改不影响对照结果', async () => {
  const created = await api('/api/projects', 'POST', { name: '只读', words: GOOD_WORDS, cuts: [1200] });
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  const batch1 = await realDelivery(pid, layout.body.subtitles, ['Hello world', 'Welcome']);

  // 修改当前原文与译文（更新已有译文须携带译文 version）
  await api(`/api/projects/${pid}/subtitles/${layout.body.subtitles[0].id}`, 'PATCH',
    { version: 1, text: '被修改的原文，不影响冻结快照' });
  const rePut = await api(`/api/projects/${pid}/translations/en/subtitles/${layout.body.subtitles[0].id}`, 'PUT',
    { text: 'Edited now', cue_version: 2, version: 1 });
  assert.ok(rePut.status === 200, JSON.stringify(rePut.body));

  const same = await diffReport(pid, batch1.id, batch1.id);
  assert.equal(same.status, 200);
  assert.equal(same.body.summary.difference_count, 0);

  // 再走一次真实交付产生第二批后，对照只读、可重复
  const p = await api(`/api/projects/${pid}`);
  // 新译文以新源行版本保存（current）；两行均可参与交付
  const entries = (await api(`/api/projects/${pid}/translations/en`)).body.entries;
  const line = entries.filter((e) => e.state === 'current')
    .map((e) => ({ subtitle_id: e.cue.id, version: e.translation.version }));
  const second = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: p.body.sub_version, rules_version: 1,
    languages: ['en'], translations: { en: line },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const r1 = await diffReport(pid, batch1.id, second.body.id);
  const r2 = await diffReport(pid, batch1.id, second.body.id);
  assert.equal(r1.status, 200);
  assert.deepEqual(JSON.stringify(r1.body), JSON.stringify(r2.body), '重复查询结果一致');
  assert.ok(r1.body.summary.difference_count >= 1);
});
