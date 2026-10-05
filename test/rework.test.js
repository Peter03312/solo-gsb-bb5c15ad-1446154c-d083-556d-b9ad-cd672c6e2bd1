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

/** 建项目并排版：2 条字幕（[0,1000) 你好世界 / [1500,2500) 欢迎光临） */
async function setupProject(name = '返修意见测试') {
  const created = await api('/api/projects', 'POST', { name, words: GOOD_WORDS, cuts: [1200] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles };
}

/** 走真实交付流程造一个 原文+英语 批次（译文文本可指定） */
async function realDelivery(pid, cues, enTexts, note = '') {
  const view = (await api(`/api/projects/${pid}/translations/en`)).body;
  const entries = [];
  for (const [i, t] of enTexts.entries()) {
    const entry = view.entries.find((e) => e.cue.id === cues[i].id);
    const existing = entry.translation;
    const body = existing
      ? { text: t, cue_version: entry.cue.version, version: existing.version }
      : { text: t, cue_version: entry.cue.version };
    const r = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[i].id}`, 'PUT', body);
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    entries.push({ subtitle_id: cues[i].id, version: r.body.translation.version });
  }
  const p = await api(`/api/projects/${pid}`);
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    note, sub_version: p.body.sub_version, rules_version: 1,
    languages: ['en'], translations: { en: entries },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

/**
 * 直接写入一组冻结交付批次（核对只依赖冻结快照）。
 * specs: [{ kind:'source'|'translation', lang?, cues:[{start_ms,end_ms,text}] }]
 */
function insertBatch(projectId, specs, note = '') {
  const bid = db.prepare(
    'INSERT INTO delivery_batches (project_id, note, sub_version, rules_version, cue_count, lang_count) VALUES (?, ?, 1, 1, ?, ?)'
  ).run(projectId, note, specs[0].cues.length, specs.filter((s) => s.kind === 'translation').length).lastInsertRowid;
  specs.forEach((s, ord) => {
    const content = toWebVtt(s.cues);
    let exportId; let exportKind; let version;
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

const createComment = (pid, bid, body) =>
  api(`/api/projects/${pid}/deliveries/${bid}/rework-comments`, 'POST', body);
const listComments = (pid, bid) => api(`/api/projects/${pid}/deliveries/${bid}/rework-comments`);
const checkComments = (pid, bid, tid) =>
  api(`/api/projects/${pid}/deliveries/${bid}/rework-comments/check?target_id=${tid}`);
const verdict = (pid, bid, cid, body) =>
  api(`/api/projects/${pid}/deliveries/${bid}/rework-comments/${cid}/verdict`, 'POST', body);

test('创建返修意见：记录命中的冻结文本与时间，列表可查', async () => {
  const { pid, cues } = await setupProject();
  const batch = await realDelivery(pid, cues, ['Hello world', 'Welcome'], '第一批');

  // 原文文件区间 [0,1000]：命中第一条 cue
  const r1 = await createComment(pid, batch.id, {
    kind: 'source', start_ms: 0, end_ms: 1000, text: '「你好世界」应断为两句',
  });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.comment.version, 1);
  assert.equal(r1.body.comment.kind, 'source');
  assert.equal(r1.body.comment.lang, null);
  assert.equal(r1.body.comment.file_version, 1);
  assert.equal(r1.body.comment.start, '00:00:00.000');
  assert.equal(r1.body.comment.end, '00:00:01.000');
  assert.deepEqual(
    r1.body.comment.hits.map((h) => [h.start_ms, h.end_ms, h.text]),
    [[0, 1000, '你好世界']],
  );

  // 英语译文文件区间 [500,2000]：命中两条译文 cue
  const r2 = await createComment(pid, batch.id, {
    kind: 'translation', lang: 'en', start_ms: 500, end_ms: 2000, text: 'Hello world 语气不符',
  });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.deepEqual(
    r2.body.comment.hits.map((h) => [h.start_ms, h.end_ms, h.text]),
    [[0, 1000, 'Hello world'], [1500, 2500, 'Welcome']],
  );

  // 区间落在字幕空档内（时间轴内但不命中任何 cue）：允许，hits 为空
  const r3 = await createComment(pid, batch.id, {
    kind: 'source', start_ms: 1000, end_ms: 1500, text: '空档处建议加过渡字幕',
  });
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  assert.deepEqual(r3.body.comment.hits, []);

  const list = await listComments(pid, batch.id);
  assert.equal(list.status, 200);
  assert.equal(list.body.counts.total, 3);
  assert.equal(list.body.comments.length, 3);
  assert.deepEqual(list.body.comments[0].verdicts, []);
  assert.equal(list.body.batch.id, batch.id);
});

test('创建形状非法 400：空意见/非法 kind/缺 lang/原文带 lang/区间颠倒/负值', async () => {
  const { pid, cues } = await setupProject('形状非法');
  const batch = await realDelivery(pid, cues, ['Hello world', 'Welcome']);

  const cases = [
    [{ kind: 'source', start_ms: 0, end_ms: 1000, text: '' }, /非空/],
    [{ kind: 'source', start_ms: 0, end_ms: 1000, text: '   ' }, /非空/],
    [{ kind: 'audio', start_ms: 0, end_ms: 1000, text: 'x' }, /kind/],
    [{ kind: 'translation', start_ms: 0, end_ms: 1000, text: 'x' }, /lang/],
    [{ kind: 'source', lang: 'en', start_ms: 0, end_ms: 1000, text: 'x' }, /不接受 lang/],
    [{ kind: 'translation', lang: ' en', start_ms: 0, end_ms: 1000, text: 'x' }, /规范化/],
    [{ kind: 'source', start_ms: 1000, end_ms: 1000, text: 'x' }, /早于终点/],
    [{ kind: 'source', start_ms: 2000, end_ms: 1000, text: 'x' }, /早于终点/],
    [{ kind: 'source', start_ms: -1, end_ms: 1000, text: 'x' }, /≥0/],
    [{ kind: 'source', start_ms: 0, end_ms: 1000.5, text: 'x' }, /整数/],
  ];
  for (const [body, re] of cases) {
    const r = await createComment(pid, batch.id, body);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.ok(r.body.errors.some((e) => re.test(e)), JSON.stringify(r.body));
  }
  const list = await listComments(pid, batch.id);
  assert.equal(list.body.counts.total, 0, '全部拒绝，未创建任何意见');
});

test('区间越界 422：超出冻结文件时间轴 / 空文件无时间轴', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '越界', words: GOOD_WORDS })).body.id;
  const bid = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 500, end_ms: 1000, text: '甲' }] },
  ]);
  // 终点超出时间轴末（1000）
  const r1 = await createComment(pid, bid, { kind: 'source', start_ms: 500, end_ms: 1001, text: 'x' });
  assert.equal(r1.status, 422, JSON.stringify(r1.body));
  assert.equal(r1.body.reason_code, 'interval_out_of_timeline');
  assert.deepEqual(r1.body.timeline, { start_ms: 500, end_ms: 1000 });
  // 起点早于时间轴首（500）
  const r2 = await createComment(pid, bid, { kind: 'source', start_ms: 0, end_ms: 600, text: 'x' });
  assert.equal(r2.status, 422);
  // 边界贴齐时间轴：允许
  const ok = await createComment(pid, bid, { kind: 'source', start_ms: 500, end_ms: 1000, text: '贴边' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  // 空文件（无 cue）：时间轴为空，任何区间都越界
  const emptyBatch = insertBatch(pid, [{ kind: 'source', cues: [] }]);
  const r3 = await createComment(pid, emptyBatch, { kind: 'source', start_ms: 0, end_ms: 100, text: 'x' });
  assert.equal(r3.status, 422, JSON.stringify(r3.body));
  assert.match(r3.body.error, /时间轴为空/);
});

test('拒绝：批次不存在 / 跨项目 / 批次未交付该语言', async () => {
  const { pid, cues } = await setupProject('拒绝场景');
  const other = (await api('/api/projects', 'POST', { name: '别的项目', words: GOOD_WORDS })).body.id;
  const batch = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const otherBatch = insertBatch(other, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
  ]);

  // 批次不存在
  const r1 = await createComment(pid, 999999, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' });
  assert.equal(r1.status, 404);
  assert.equal(r1.body.reason_code, 'batch_not_found');
  const r1b = await listComments(pid, 999999);
  assert.equal(r1b.status, 404);

  // 跨项目：批次属于别的项目
  const r2 = await createComment(pid, otherBatch, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' });
  assert.equal(r2.status, 404);
  assert.equal(r2.body.reason_code, 'batch_other_project');
  assert.equal(r2.body.actual_project_id, other);
  const r2b = await listComments(pid, otherBatch);
  assert.equal(r2b.status, 404);
  assert.equal(r2b.body.reason_code, 'batch_other_project');

  // 批次未交付法语：无法在法语文件上记录意见
  const r3 = await createComment(pid, batch.id, {
    kind: 'translation', lang: 'fr', start_ms: 0, end_ms: 1000, text: 'x',
  });
  assert.equal(r3.status, 404);
  assert.equal(r3.body.reason_code, 'file_not_in_batch');
});

test('清单所指文件缺失或快照损坏 500：明确拒绝且不创建意见', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '快照问题', words: GOOD_WORDS })).body.id;
  // 快照缺失：清单指向不存在的导出行
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '甲' }] },
  ]);
  db.prepare('UPDATE delivery_files SET export_id = 999999 WHERE batch_id = ?').run(b1);
  const r1 = await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' });
  assert.equal(r1.status, 500, JSON.stringify(r1.body));
  assert.equal(r1.body.snapshot_problems[0].problem, 'snapshot_missing');

  // 快照损坏：内容不是 WebVTT
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '甲' }] },
  ]);
  const f = db.prepare("SELECT export_id FROM delivery_files WHERE batch_id = ? AND kind = 'source'").get(b2);
  db.prepare('UPDATE exports SET content = ? WHERE id = ?').run('NOT VTT', f.export_id);
  const r2 = await createComment(pid, b2, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' });
  assert.equal(r2.status, 500);
  assert.equal(r2.body.snapshot_problems[0].problem, 'snapshot_corrupt');

  const list = await listComments(pid, b1);
  assert.equal(list.body.counts.total, 0, '拒绝后未留下任何意见');
});

test('核对：未改动 / 文本变化待人工确认 / 区间外变化不计', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '核对基本', words: GOOD_WORDS })).body.id;
  const src = (t1, t2) => [{ start_ms: 0, end_ms: 1000, text: t1 }, { start_ms: 1500, end_ms: 2500, text: t2 }];
  const b1 = insertBatch(pid, [{ kind: 'source', cues: src('甲', '乙') }], '基准');
  const b2 = insertBatch(pid, [{ kind: 'source', cues: src('甲改', '乙') }], '目标');

  // 区间一：[0,1000] 覆盖第一条（变了）；区间二：[1500,2500] 覆盖第二条（没变）
  const c1 = (await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: '第一条要改' })).body.comment;
  const c2 = (await createComment(pid, b1, { kind: 'source', start_ms: 1500, end_ms: 2500, text: '第二条别动' })).body.comment;

  const r = await checkComments(pid, b1, b2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.same_batch, false);
  assert.equal(r.body.counts.total, 2);
  assert.equal(r.body.counts.pending, 1);
  assert.equal(r.body.counts.unchanged, 1);

  const i1 = r.body.comments.find((c) => c.id === c1.id);
  assert.equal(i1.status, 'pending');
  assert.equal(i1.status_label, '待人工确认');
  assert.deepEqual(
    i1.differences.map((d) => [d.start_ms, d.end_ms, d.base_text, d.target_text]),
    [[0, 1000, '甲', '甲改']],
  );
  assert.equal(i1.verdict, null);

  const i2 = r.body.comments.find((c) => c.id === c2.id);
  assert.equal(i2.status, 'unchanged');
  assert.equal(i2.status_label, '未改动');
  assert.deepEqual(i2.differences, []);

  // 同批核对：全部未改动
  const same = await checkComments(pid, b1, b1);
  assert.equal(same.body.same_batch, true);
  assert.equal(same.body.counts.unchanged, 2);
});

test('核对：覆盖范围变化（空档/移时）→ 待人工确认；同文拆分 → 未改动', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '覆盖范围', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '整句' }] },
  ]);
  const cid = (await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' })).body.comment.id;

  // 目标把 cue 缩短一半：后半覆盖消失 → 待人工确认
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 500, text: '整句' }] },
  ]);
  const r1 = await checkComments(pid, b1, b2);
  const d1 = r1.body.comments[0];
  assert.equal(d1.status, 'pending');
  assert.deepEqual(
    d1.differences.map((d) => [d.start_ms, d.end_ms, d.base_text, d.target_text]),
    [[500, 1000, '整句', null]],
  );

  // 目标拆成两条同文 cue：文本与覆盖范围均未变 → 未改动
  const b3 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 500, text: '整句' }, { start_ms: 500, end_ms: 1000, text: '整句' }] },
  ]);
  const r2 = await checkComments(pid, b1, b3);
  assert.equal(r2.body.comments[0].status, 'unchanged');

  // 整体移时：覆盖范围变化 → 待人工确认
  const b4 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 2000, end_ms: 3000, text: '整句' }] },
  ]);
  const r3 = await checkComments(pid, b1, b4);
  assert.equal(r3.body.comments[0].status, 'pending');
  assert.deepEqual(
    r3.body.comments[0].differences.map((d) => [d.start_ms, d.end_ms, d.base_text, d.target_text]),
    [[0, 1000, '整句', null]],
  );
  assert.ok(cid > 0);
});

test('核对：目标批次未交付所选语言 → 无法核对', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '无法核对', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
    { kind: 'translation', lang: 'en', cues: [{ start_ms: 0, end_ms: 1000, text: 'English' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '原文' }] },
  ]); // 目标批只交付原文

  await createComment(pid, b1, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: '译文问题' });
  await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: '原文问题' });

  const r = await checkComments(pid, b1, b2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const enItem = r.body.comments.find((c) => c.kind === 'translation');
  assert.equal(enItem.status, 'cannot_check');
  assert.equal(enItem.status_label, '无法核对');
  assert.match(enItem.reason, /未交付/);
  assert.equal(enItem.target_file, null);
  assert.equal(enItem.differences, null);
  const srcItem = r.body.comments.find((c) => c.kind === 'source');
  assert.equal(srcItem.status, 'unchanged');
  assert.equal(r.body.counts.cannot_check, 1);
});

test('核对拒绝：参数非法 / 目标批次不存在 / 跨项目 / 快照损坏（整份失败）', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '核对拒绝', words: GOOD_WORDS })).body.id;
  const other = (await api('/api/projects', 'POST', { name: '另一项目', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '甲' }] }]);
  const b2 = insertBatch(pid, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '乙' }] }]);
  const otherBatch = insertBatch(other, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '丙' }] }]);
  await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' });

  const badParam = await api(`/api/projects/${pid}/deliveries/${b1}/rework-comments/check`);
  assert.equal(badParam.status, 400);
  const missing = await checkComments(pid, b1, 999999);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.reason_code, 'batch_not_found');
  const cross = await checkComments(pid, b1, otherBatch);
  assert.equal(cross.status, 404);
  assert.equal(cross.body.reason_code, 'batch_other_project');
  const baseMissing = await checkComments(pid, 999999, b2);
  assert.equal(baseMissing.status, 404);

  // 目标批快照损坏：整份失败，指出批次与文件，不返回部分结果
  const f = db.prepare("SELECT export_id FROM delivery_files WHERE batch_id = ? AND kind = 'source'").get(b2);
  db.prepare('UPDATE exports SET content = ? WHERE id = ?').run('GARBAGE', f.export_id);
  const corrupt = await checkComments(pid, b1, b2);
  assert.equal(corrupt.status, 500, JSON.stringify(corrupt.body));
  assert.ok(!('comments' in corrupt.body), '失败时不得返回部分结果');
  assert.equal(corrupt.body.snapshot_problems.length, 1);
  assert.equal(corrupt.body.snapshot_problems[0].batch_id, b2);
  assert.equal(corrupt.body.snapshot_problems[0].side, 'target');
  assert.equal(corrupt.body.snapshot_problems[0].problem, 'snapshot_corrupt');

  // 核对失败不改意见：版本与结论保持原样
  const list = await listComments(pid, b1);
  assert.equal(list.body.comments[0].version, 1);
  assert.deepEqual(list.body.comments[0].verdicts, []);
});

test('判定：已解决/仍待修、结论绑定目标批次、意见版本推进', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '判定流程', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '甲' }] }]);
  const b2 = insertBatch(pid, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '乙' }] }]);
  const cid = (await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: '这里译错' })).body.comment.id;

  // 待人工确认 → 判“已解决”
  const v1 = await verdict(pid, b1, cid, { version: 1, target_batch_id: b2, verdict: 'resolved' });
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  assert.equal(v1.body.comment.version, 2, '判定推进意见版本');
  assert.equal(v1.body.comment.status, 'pending', '核对结果仍是待人工确认（系统不自动判已修复）');
  assert.equal(v1.body.comment.verdict.verdict, 'resolved');
  assert.equal(v1.body.comment.verdict.verdict_label, '已解决');
  assert.equal(v1.body.comment.verdict.target_batch_id, b2);
  assert.deepEqual(v1.body.comment.verdict_history, []);

  // 同一目标批次改判“仍待修”（覆盖结论）
  const v2 = await verdict(pid, b1, cid, { version: 2, target_batch_id: b2, verdict: 'still_pending' });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  assert.equal(v2.body.comment.version, 3);
  assert.equal(v2.body.comment.verdict.verdict, 'still_pending');
  assert.equal(v2.body.comment.verdict.verdict_label, '仍待修');

  // 核对报告：该目标批次上显示当前结论
  const chk = await checkComments(pid, b1, b2);
  assert.equal(chk.body.comments[0].verdict.verdict, 'still_pending');
  assert.equal(chk.body.counts.still_pending, 1);

  // 结论只绑定该目标批次：列表里可见全部结论
  const list = await listComments(pid, b1);
  assert.equal(list.body.comments[0].verdicts.length, 1);
  assert.equal(list.body.comments[0].verdicts[0].target_batch_id, b2);
});

test('判定拒绝：版本过期 409 返回当前状态；未改动/无法核对 422；形状非法 400', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '判定拒绝', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '甲' }, { start_ms: 1500, end_ms: 2500, text: '乙' }] },
    { kind: 'translation', lang: 'en', cues: [{ start_ms: 0, end_ms: 1000, text: 'A' }, { start_ms: 1500, end_ms: 2500, text: 'B' }] },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '甲改' }, { start_ms: 1500, end_ms: 2500, text: '乙' }] },
  ]); // 目标批未交付 en
  const cPending = (await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: '会变' })).body.comment;
  const cUnchanged = (await createComment(pid, b1, { kind: 'source', start_ms: 1500, end_ms: 2500, text: '不变' })).body.comment;
  const cNoLang = (await createComment(pid, b1, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: '无目标语言' })).body.comment;

  // 未改动 → 不可判定
  const r1 = await verdict(pid, b1, cUnchanged.id, { version: 1, target_batch_id: b2, verdict: 'resolved' });
  assert.equal(r1.status, 422, JSON.stringify(r1.body));
  assert.match(r1.body.error, /未改动/);
  assert.equal(r1.body.current.comment.version, 1, '未修改');

  // 无法核对 → 不可判定
  const r2 = await verdict(pid, b1, cNoLang.id, { version: 1, target_batch_id: b2, verdict: 'resolved' });
  assert.equal(r2.status, 422);
  assert.match(r2.body.error, /无法核对/);

  // 意见版本过期 → 409 返回当前状态
  await verdict(pid, b1, cPending.id, { version: 1, target_batch_id: b2, verdict: 'resolved' });
  const stale = await verdict(pid, b1, cPending.id, { version: 1, target_batch_id: b2, verdict: 'still_pending' });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(stale.body.error, /意见版本过期/);
  assert.equal(stale.body.current.comment.version, 2, '返回当前意见版本');
  assert.equal(stale.body.current.comment.verdicts.length, 1);
  assert.equal(stale.body.current.comment.verdicts[0].verdict, 'resolved', '旧结论未被覆盖');

  // 形状非法
  const bad1 = await verdict(pid, b1, cPending.id, { version: 2, target_batch_id: b2, verdict: 'fixed' });
  assert.equal(bad1.status, 400);
  const bad2 = await verdict(pid, b1, cPending.id, { version: 2, verdict: 'resolved' });
  assert.equal(bad2.status, 400);

  // 目标批次不存在 / 跨项目
  const nf = await verdict(pid, b1, cPending.id, { version: 2, target_batch_id: 999999, verdict: 'resolved' });
  assert.equal(nf.status, 404);
  assert.equal(nf.body.reason_code, 'batch_not_found');

  // 意见不存在
  const noComment = await verdict(pid, b1, 999999, { version: 1, target_batch_id: b2, verdict: 'resolved' });
  assert.equal(noComment.status, 404);
});

test('换批后旧结论仅作历史：新目标批次需重新判定', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '换批历史', words: GOOD_WORDS })).body.id;
  const b1 = insertBatch(pid, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '甲' }] }]);
  const b2 = insertBatch(pid, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '乙' }] }]);
  const b3 = insertBatch(pid, [{ kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '丙' }] }]);
  const cid = (await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' })).body.comment.id;

  // 对批次二判“已解决”
  const v = await verdict(pid, b1, cid, { version: 1, target_batch_id: b2, verdict: 'resolved' });
  assert.equal(v.status, 200, JSON.stringify(v.body));

  // 对批次三核对：仍是待人工确认，批次二的结论仅作历史
  const chk3 = await checkComments(pid, b1, b3);
  const item3 = chk3.body.comments[0];
  assert.equal(item3.status, 'pending');
  assert.equal(item3.verdict, null, '结论绑定批次二，对批次三不生效');
  assert.equal(item3.verdict_history.length, 1);
  assert.equal(item3.verdict_history[0].target_batch_id, b2);
  assert.equal(item3.verdict_history[0].verdict, 'resolved');

  // 对批次二核对：结论仍是已解决
  const chk2 = await checkComments(pid, b1, b2);
  assert.equal(chk2.body.comments[0].verdict.verdict, 'resolved');

  // 对批次三可独立判定（携带当前意见版本 2）
  const v3 = await verdict(pid, b1, cid, { version: 2, target_batch_id: b3, verdict: 'still_pending' });
  assert.equal(v3.status, 200, JSON.stringify(v3.body));
  assert.equal(v3.body.comment.verdict.target_batch_id, b3);
  assert.equal(v3.body.comment.verdict_history.length, 1, '批次二结论转为历史');
});

test('只读冻结文件：当前编辑稿与词序变化不影响核对，也不自动判已修复', async () => {
  const { pid, cues } = await setupProject('只读冻结');
  const batch1 = await realDelivery(pid, cues, ['Hello world', 'Welcome'], '第一批');
  const cid = (await createComment(pid, batch1.id, {
    kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: 'Hello world 要改',
  })).body.comment.id;

  // 修改当前编辑稿（译文与原文），再交付第二批（译文已改）
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Hi there', cue_version: 1, version: 1 });
  const batch2 = await realDelivery(pid, cues, ['Hi there', 'Welcome'], '第二批');

  const r1 = await checkComments(pid, batch1.id, batch2.id);
  assert.equal(r1.body.comments[0].status, 'pending', '冻结文件已变 → 待人工确认，而非自动判已修复');
  assert.equal(r1.body.comments[0].verdict, null);

  // 继续修改当前编辑稿（不交付）：核对结果不变（只读冻结文件，不看当前稿）
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Completely different now', cue_version: 1, version: 2 });
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH',
    { version: 1, text: '当前稿随便改' });
  const r2 = await checkComments(pid, batch1.id, batch2.id);
  assert.deepEqual(r2.body.comments[0].differences, r1.body.comments[0].differences);
  assert.equal(r2.body.comments[0].status, 'pending');
});

test('原有交付与下载行为维持：批次文件仍经既有接口下载且不可变', async () => {
  const { pid, cues } = await setupProject('兼容');
  const batch = await realDelivery(pid, cues, ['Hello world', 'Welcome'], '第一批');
  await createComment(pid, batch.id, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' });

  // 批次清单与既有下载接口不变
  const detail = await api(`/api/projects/${pid}/deliveries/${batch.id}`);
  assert.equal(detail.status, 200);
  const srcFile = detail.body.files.find((f) => f.kind === 'source');
  const dl = await api(srcFile.download_url);
  assert.equal(dl.status, 200);
  assert.match(dl.body, /WEBVTT/);
  assert.match(dl.body, /你好世界/);
  const enFile = detail.body.files.find((f) => f.lang === 'en');
  const dlEn = await api(enFile.download_url);
  assert.equal(dlEn.status, 200);
  assert.match(dlEn.body, /Hello world/);

  // 两批对照（既有功能）不受返修意见影响
  const batch2 = await realDelivery(pid, cues, ['Hello world', 'Welcome'], '第二批');
  const diff = await api(`/api/projects/${pid}/deliveries/diff?base_id=${batch.id}&target_id=${batch2.id}`);
  assert.equal(diff.status, 200);
  assert.equal(diff.body.summary.difference_count, 0);
});
