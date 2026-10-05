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
  return { status: res.status, body: json };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

/** 走真实交付流程造一个原文+英文批次（可指定英语译文与源字幕编辑后重排） */
async function realDelivery(pid, cues, enTexts, note = '') {
  for (const [i, t] of enTexts.entries()) {
    const r = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[i].id}`, 'PUT', { text: t, cue_version: cues[i].version ?? 1 });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  }
  const p = await api(`/api/projects/${pid}`);
  const line = cues.map((c) => {
    const g = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?')
      .get(pid, c.id);
    return { subtitle_id: c.id, version: g.version };
  });
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    note, sub_version: p.body.sub_version, rules_version: 1,
    languages: ['en'],
    translations: { en: line },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function setupProject(name = '返修意见') {
  const created = await api('/api/projects', 'POST', { name, words: GOOD_WORDS, cuts: [1200] });
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200);
  return { pid, cues: layout.body.subtitles };
}

/** 直接写入一组冻结交付批次（绕过当前字幕/交付核对，便于构造特殊快照场景） */
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

async function createComment(pid, bid, body) {
  return api(`/api/projects/${pid}/deliveries/${bid}/delivery-comments`, 'POST', body);
}

test('创建返修意见：记录命中的冻结文本与时间（跨两条 cue）', async () => {
  const { pid, cues } = await setupProject();
  const b = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const r = await createComment(pid, b.id, {
    kind: 'translation', lang: 'en', start_ms: 400, end_ms: 1600,
    text: '  这段翻译语气不对  ',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.comment;
  assert.equal(c.kind, 'translation');
  assert.equal(c.lang, 'en');
  assert.equal(c.batch_id, b.id);
  assert.equal(c.text, '这段翻译语气不对'); // trim
  assert.equal(c.version, 1);
  assert.equal(c.hits.length, 2);
  assert.deepEqual(
    { s: c.hits[0].clip_start_ms, e: c.hits[0].clip_end_ms, t: c.hits[0].text },
    { s: 400, e: 1000, t: 'Hello world' }
  );
  assert.deepEqual(
    { s: c.hits[1].clip_start_ms, e: c.hits[1].clip_end_ms, t: c.hits[1].text },
    { s: 1500, e: 1600, t: 'Welcome' }
  );
  assert.equal(c.hits[0].cue_start_ms, 0);
  assert.ok(c.hits[0].clip_start && c.hits[0].clip_end);
});

test('原文文件返修意见与空档区间（无 cue 命中）也允许创建', async () => {
  const { pid, cues } = await setupProject();
  const b = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  // 空档 1000..1500 在时间轴 [0,2500] 内
  const r = await createComment(pid, b.id, { kind: 'source', start_ms: 1100, end_ms: 1400, text: '空档过长' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.comment.hits, []);
  assert.equal(r.body.file.kind, 'source');
});

test('形状非法：kind/lang/区间/空意见 → 400，不创建', async () => {
  const { pid, cues } = await setupProject();
  const b = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const bad = [
    { start_ms: 0, end_ms: 10, text: 'x' },                       // 缺 kind
    { kind: 'translation', start_ms: 0, end_ms: 10, text: 'x' }, // 缺 lang
    { kind: 'translation', lang: 'en!!', start_ms: 0, end_ms: 10, text: 'x' },
    { kind: 'source', start_ms: -1, end_ms: 10, text: 'x' },
    { kind: 'source', start_ms: 10, end_ms: 10, text: 'x' },
    { kind: 'source', start_ms: 20, end_ms: 10, text: 'x' },
    { kind: 'source', start_ms: 0, end_ms: 10, text: '   ' },
  ];
  for (const body of bad) {
    const r = await createComment(pid, b.id, body);
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  const list = await api(`/api/projects/${pid}/delivery-comments`);
  assert.equal(list.body.comments.length, 0);
});

test('批次不存在 → 404；跨项目批次 → 404 batch_other_project', async () => {
  const { pid, cues } = await setupProject();
  const b = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const other = await setupProject('另一个项目');

  const r1 = await createComment(pid, 9999, { kind: 'source', start_ms: 0, end_ms: 100, text: 'x' });
  assert.equal(r1.status, 404);
  assert.equal(r1.body.reason_code, 'batch_not_found');

  const r2 = await createComment(other.pid, b.id, { kind: 'source', start_ms: 0, end_ms: 100, text: 'x' });
  assert.equal(r2.status, 404);
  assert.equal(r2.body.reason_code, 'batch_other_project');
  assert.equal(r2.body.actual_project_id, pid);
});

test('批次未交付所选语言 → 422 file_not_delivered，不创建意见', async () => {
  const { pid, cues } = await setupProject();
  const b = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const r = await createComment(pid, b.id, { kind: 'translation', lang: 'fr', start_ms: 0, end_ms: 100, text: '法语呢' });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.reason_code, 'file_not_delivered');
});

test('区间越出文件时间轴 → 422 interval_out_of_timeline，不创建', async () => {
  const { pid, cues } = await setupProject();
  const b = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const beyond = await createComment(pid, b.id, { kind: 'source', start_ms: 0, end_ms: 2600, text: 'x' });
  assert.equal(beyond.status, 422);
  assert.equal(beyond.body.reason_code, 'interval_out_of_timeline');
  assert.deepEqual(beyond.body.timeline, { start_ms: 0, end_ms: 2500 });
  // 构造首 cue 100 起的批次：起点早于首 cue 也属越界
  const custom = insertBatch(pid, [
    { kind: 'source', cues: [{ start_ms: 100, end_ms: 900, text: '甲' }, { start_ms: 1000, end_ms: 2000, text: '乙' }] },
    { kind: 'translation', lang: 'en', cues: [{ start_ms: 100, end_ms: 900, text: 'A' }, { start_ms: 1000, end_ms: 2000, text: 'B' }] },
  ], '自定义时间轴');
  const r2 = await createComment(pid, custom, { kind: 'source', start_ms: 0, end_ms: 50, text: '越界' });
  assert.equal(r2.status, 422);
  assert.deepEqual(r2.body.timeline, { start_ms: 100, end_ms: 2000 });
});

test('核对：目标批次区间内文本与覆盖均未变 → unchanged（未改动）', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome'], '第一批');
  const c = await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: '再自然些' });
  assert.equal(c.status, 201);
  // 区间外（1500..2500 第二条）改译文，重新交付
  const p = await api(`/api/projects/${pid}`);
  const upd = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`, 'PUT',
    { text: 'Welcome!', cue_version: cues[1].version ?? 1, version: 1 });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const p2 = await api(`/api/projects/${pid}`);
  const v2 = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?').get(pid, cues[1].id).version;
  const d2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: p2.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: [
      { subtitle_id: cues[0].id, version: 1 },
      { subtitle_id: cues[1].id, version: v2 },
    ] },
  });
  assert.equal(d2.status, 201, JSON.stringify(d2.body));
  const r = await api(`/api/projects/${pid}/delivery-comments/${c.body.comment.id}/check?target_id=${d2.body.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.auto.status, 'unchanged');
  assert.equal(r.body.auto.status_text, '未改动');
  assert.deepEqual(r.body.auto.differences, []);
  assert.equal(r.body.decision, null);
});

test('核对：区间内译文文本变化 → manual（待人工确认）并给差异区段', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const c = await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: '再自然些' });
  const upd = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Hello there', cue_version: 1, version: 1 });
  assert.equal(upd.status, 200);
  const p2 = await api(`/api/projects/${pid}`);
  const v2 = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?').get(pid, cues[0].id).version;
  const d2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: p2.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: [{ subtitle_id: cues[0].id, version: v2 }, { subtitle_id: cues[1].id, version: 1 }] },
  });
  assert.equal(d2.status, 201);
  const r = await api(`/api/projects/${pid}/delivery-comments/${c.body.comment.id}/check?target_id=${d2.body.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.auto.status, 'manual');
  assert.equal(r.body.auto.status_text, '待人工确认');
  assert.equal(r.body.auto.differences.length, 1);
  assert.deepEqual(
    { s: r.body.auto.differences[0].start_ms, e: r.body.auto.differences[0].end_ms },
    { s: 0, e: 1000 }
  );
  assert.equal(r.body.auto.differences[0].base_text, 'Hello world');
  assert.equal(r.body.auto.differences[0].target_text, 'Hello there');
});

test('核对：目标批次未交付所选语言 → unavailable（无法核对）', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const c = await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: 'x' });
  // 第二批只交付原文：直接构造只含原文的批次（当前交付接口至少要一种语言，故直接插库）
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: cues.map((x) => ({ start_ms: x.start_ms, end_ms: x.end_ms, text: x.text })) },
  ], '仅原文');
  const r = await api(`/api/projects/${pid}/delivery-comments/${c.body.comment.id}/check?target_id=${b2}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.auto.status, 'unavailable');
  assert.equal(r.body.auto.status_text, '无法核对');
  assert.equal(r.body.auto.target_file, null);
});

test('核对：覆盖范围变化（目标区间出现空档）→ manual', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '覆盖变化', words: GOOD_WORDS, cuts: [1200] })).body.id;
  const c1 = [
    { start_ms: 0, end_ms: 1000, text: '甲' },
    { start_ms: 1500, end_ms: 2500, text: '乙' },
  ];
  const c2 = [
    { start_ms: 200, end_ms: 1000, text: '甲' },      // 起点后移：0..200 变空档
    { start_ms: 1500, end_ms: 2500, text: '乙' },
  ];
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: c1 },
    { kind: 'translation', lang: 'en', cues: c1.map((c) => ({ ...c, text: c.text === '甲' ? 'A' : 'B' })) },
  ]);
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: c2 },
    { kind: 'translation', lang: 'en', cues: c2.map((c) => ({ ...c, text: c.text === '甲' ? 'A' : 'B' })) },
  ]);
  const cm = await createComment(pid, b1, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: '覆盖' });
  assert.equal(cm.status, 201);
  const r = await api(`/api/projects/${pid}/delivery-comments/${cm.body.comment.id}/check?target_id=${b2}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.auto.status, 'manual');
  // 0..200 目标侧为 null（空档），基准为 A
  const d = r.body.auto.differences[0];
  assert.deepEqual([d.start_ms, d.end_ms], [0, 200]);
  assert.equal(d.base_text, 'A');
  assert.equal(d.target_text, null);
});

test('核对：区间外变化不影响结论；拆分/移时按时间区段对齐', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '拆并', words: GOOD_WORDS, cuts: [1200] })).body.id;
  const a = [{ start_ms: 0, end_ms: 1000, text: '整句' }, { start_ms: 1500, end_ms: 2500, text: '后半' }];
  const b = [{ start_ms: 0, end_ms: 600, text: '整句' }, { start_ms: 600, end_ms: 1000, text: '整句' }, { start_ms: 1500, end_ms: 2500, text: '后半' }];
  const b1 = insertBatch(pid, [{ kind: 'source', cues: a }]);
  const b2 = insertBatch(pid, [{ kind: 'source', cues: b }]);
  const cm = await createComment(pid, b1, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'x' });
  const r = await api(`/api/projects/${pid}/delivery-comments/${cm.body.comment.id}/check?target_id=${b2}`);
  assert.equal(r.status, 200);
  // 文本相同、覆盖相同（相邻切点合并）→ 未改动
  assert.equal(r.body.auto.status, 'unchanged', JSON.stringify(r.body.auto.differences));
});

test('核对：参数非法 400、意见不存在 404、跨项目目标批次 404', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const c = await createComment(pid, b1.id, { kind: 'source', start_ms: 0, end_ms: 100, text: 'x' });
  const cid = c.body.comment.id;
  assert.equal((await api(`/api/projects/${pid}/delivery-comments/${cid}/check`)).status, 400);
  assert.equal((await api(`/api/projects/${pid}/delivery-comments/${cid}/check?target_id=abc`)).status, 400);
  assert.equal((await api(`/api/projects/${pid}/delivery-comments/9999/check?target_id=${b1.id}`)).status, 404);
  const other = await setupProject('跨项目');
  assert.ok(other.pid);
  const r = await api(`/api/projects/${pid}/delivery-comments/${cid}/check?target_id=9998`);
  assert.equal(r.status, 404);
  assert.equal(r.body.reason_code, 'batch_not_found');

  // 目标批次属于另一项目 → 跨项目拒绝
  const ob = await insertBatch(other.pid, [
    { kind: 'source', cues: [{ start_ms: 0, end_ms: 1000, text: '别项目' }] },
  ]);
  const rx = await api(`/api/projects/${pid}/delivery-comments/${cid}/check?target_id=${ob}`);
  assert.equal(rx.status, 404);
  assert.equal(rx.body.reason_code, 'batch_other_project');
});

test('快照缺失/损坏 → 500 整份核对失败且不修改意见', async () => {
  const pid = (await api('/api/projects', 'POST', { name: '快照损坏', words: GOOD_WORDS, cuts: [1200] })).body.id;
  const cuesA = [{ start_ms: 0, end_ms: 1000, text: '甲' }];
  const b1 = insertBatch(pid, [
    { kind: 'source', cues: cuesA },
    { kind: 'translation', lang: 'en', cues: cuesA.map((c) => ({ ...c, text: 'A' })) },
  ]);
  const cm = await createComment(pid, b1, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: 'x' });
  assert.equal(cm.status, 201);

  // 目标批：en 快照导出行被删（snapshot_missing）
  const b2 = insertBatch(pid, [
    { kind: 'source', cues: cuesA },
    { kind: 'translation', lang: 'en', cues: cuesA.map((c) => ({ ...c, text: 'A' })) },
  ]);
  const f = db.prepare('SELECT export_id FROM delivery_files WHERE batch_id=? AND lang=\'en\'').get(b2);
  db.prepare('DELETE FROM translation_exports WHERE id=?').run(f.export_id);
  const r1 = await api(`/api/projects/${pid}/delivery-comments/${cm.body.comment.id}/check?target_id=${b2}`);
  assert.equal(r1.status, 500);
  assert.equal(r1.body.reason_code, 'snapshot_missing');

  // 目标批：en 快照内容损坏（snapshot_corrupt）
  const b3 = insertBatch(pid, [
    { kind: 'source', cues: cuesA },
    { kind: 'translation', lang: 'en', cues: cuesA.map((c) => ({ ...c, text: 'A' })) },
  ]);
  const f3 = db.prepare('SELECT export_id FROM delivery_files WHERE batch_id=? AND lang=\'en\'').get(b3);
  db.prepare('UPDATE translation_exports SET content=\'NOT A VTT\' WHERE id=?').run(f3.export_id);
  const r2 = await api(`/api/projects/${pid}/delivery-comments/${cm.body.comment.id}/check?target_id=${b3}`);
  assert.equal(r2.status, 500);
  assert.equal(r2.body.reason_code, 'snapshot_corrupt');

  // 意见未被修改
  const view = await api(`/api/projects/${pid}/delivery-comments/${cm.body.comment.id}`);
  assert.equal(view.body.comment.version, 1);
});

test('下结论：manual 项判“已解决”，结论绑定目标批次并推进意见版本', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const c = await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: 'x' });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Hello there', cue_version: 1, version: 1 });
  const p2 = await api(`/api/projects/${pid}`);
  const v2 = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?').get(pid, cues[0].id).version;
  const d2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: p2.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: [{ subtitle_id: cues[0].id, version: v2 }, { subtitle_id: cues[1].id, version: 1 }] },
  });
  const cid = c.body.comment.id;
  const r = await api(`/api/projects/${pid}/delivery-comments/${cid}/decisions?target_id=${d2.body.id}`, 'POST',
    { version: 1, verdict: 'resolved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.decision.verdict, 'resolved');
  assert.equal(r.body.decision.verdict_text, '已解决');
  assert.equal(r.body.decision.target_batch_id, d2.body.id);
  assert.equal(r.body.comment.version, 2);

  // 单条视图带结论历史
  const view = await api(`/api/projects/${pid}/delivery-comments/${cid}`);
  assert.equal(view.body.comment.decisions.length, 1);
  assert.equal(view.body.comment.decisions[0].target_batch_id, d2.body.id);

  // 核对接口回显该目标批次结论
  const chk = await api(`/api/projects/${pid}/delivery-comments/${cid}/check?target_id=${d2.body.id}`);
  assert.equal(chk.body.decision.verdict, 'resolved');
});

test('下结论：改判“仍待修”须携带新版本；旧批次结论仅作历史不影响新批次', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const c = await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: 'x' });

  // 第二批（manual）下 resolved
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Hello there', cue_version: 1, version: 1 });
  let pp = await api(`/api/projects/${pid}`);
  let vv = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?').get(pid, cues[0].id).version;
  const d2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: pp.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: [{ subtitle_id: cues[0].id, version: vv }, { subtitle_id: cues[1].id, version: 1 }] },
  });
  const cid = c.body.comment.id;
  const dec1 = await api(`/api/projects/${pid}/delivery-comments/${cid}/decisions?target_id=${d2.body.id}`, 'POST',
    { version: 1, verdict: 'resolved' });
  assert.equal(dec1.status, 200);

  // 第三批再改（manual），旧结论不挪用：新批次 decision=null
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Hello buddy', cue_version: cues[0].version ?? 1, version: 2 });
  pp = await api(`/api/projects/${pid}`);
  vv = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?').get(pid, cues[0].id).version;
  const d3 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: pp.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: [{ subtitle_id: cues[0].id, version: vv }, { subtitle_id: cues[1].id, version: 1 }] },
  });
  const chk3 = await api(`/api/projects/${pid}/delivery-comments/${cid}/check?target_id=${d3.body.id}`);
  assert.equal(chk3.body.auto.status, 'manual');
  assert.equal(chk3.body.decision, null);

  // 对第二批改判：旧版本号过期 → 409 返回当前状态
  const stale = await api(`/api/projects/${pid}/delivery-comments/${cid}/decisions?target_id=${d2.body.id}`, 'POST',
    { version: 1, verdict: 'outstanding' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.comment.version, 2);
  assert.equal(stale.body.current.decision.verdict, 'resolved');

  // 携带当前版本改判成功
  const ok = await api(`/api/projects/${pid}/delivery-comments/${cid}/decisions?target_id=${d2.body.id}`, 'POST',
    { version: 2, verdict: 'outstanding' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.decision.verdict, 'outstanding');
  assert.equal(ok.body.comment.version, 3);
  // 第三批仍无结论
  assert.equal((await api(`/api/projects/${pid}/delivery-comments/${cid}/check?target_id=${d3.body.id}`)).body.decision, null);
});

test('下结论：同目标批次同结论幂等重放（不校验版本、不推进版本）', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const c = await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: 'x' });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Hello there', cue_version: 1, version: 1 });
  const p2 = await api(`/api/projects/${pid}`);
  const v2 = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?').get(pid, cues[0].id).version;
  const d2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: p2.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: [{ subtitle_id: cues[0].id, version: v2 }, { subtitle_id: cues[1].id, version: 1 }] },
  });
  const cid = c.body.comment.id;
  await api(`/api/projects/${pid}/delivery-comments/${cid}/decisions?target_id=${d2.body.id}`, 'POST',
    { version: 1, verdict: 'resolved' });
  const replay = await api(`/api/projects/${pid}/delivery-comments/${cid}/decisions?target_id=${d2.body.id}`, 'POST',
    { version: 1, verdict: 'resolved' }); // 故意带旧版本
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.comment.version, 2);
});

test('下结论：无法核对/未改动不得下结论 → 422；形状非法 → 400', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  const cUnchanged = await createComment(pid, b1.id, { kind: 'source', start_ms: 0, end_ms: 1000, text: 'u' });
  const cUnavail = await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: 'n' });
  const onlySrc = insertBatch(pid, [
    { kind: 'source', cues: cues.map((x) => ({ start_ms: x.start_ms, end_ms: x.end_ms, text: x.text })) },
  ], '仅原文');

  // 未改动
  const r1 = await api(`/api/projects/${pid}/delivery-comments/${cUnchanged.body.comment.id}/decisions?target_id=${b1.id}`, 'POST',
    { version: 1, verdict: 'resolved' });
  assert.equal(r1.status, 422);
  assert.match(r1.body.error, /未改动/);
  // 无法核对
  const r2 = await api(`/api/projects/${pid}/delivery-comments/${cUnavail.body.comment.id}/decisions?target_id=${onlySrc}`, 'POST',
    { version: 1, verdict: 'outstanding' });
  assert.equal(r2.status, 422);
  assert.match(r2.body.error, /无法核对/);
  // 形状非法
  const r3 = await api(`/api/projects/${pid}/delivery-comments/${cUnchanged.body.comment.id}/decisions?target_id=${b1.id}`, 'POST',
    { version: 0, verdict: 'resolved' });
  assert.equal(r3.status, 400);
  const r4 = await api(`/api/projects/${pid}/delivery-comments/${cUnchanged.body.comment.id}/decisions?target_id=${b1.id}`, 'POST',
    { version: 1, verdict: 'maybe' });
  assert.equal(r4.status, 400);
});

test('批次级核对：一次返回该来源批次全部意见对目标批次的自动结果与结论', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome'], '第一批');
  await createComment(pid, b1.id, { kind: 'translation', lang: 'en', start_ms: 0, end_ms: 1000, text: '要改' });
  await createComment(pid, b1.id, { kind: 'source', start_ms: 1500, end_ms: 2500, text: '原文没问题段' });

  // 改第一条英文后交付第二批
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT',
    { text: 'Hello there', cue_version: 1, version: 1 });
  const p2 = await api(`/api/projects/${pid}`);
  const v2 = db.prepare('SELECT version FROM translations WHERE project_id=? AND lang=\'en\' AND subtitle_id=?').get(pid, cues[0].id).version;
  const d2 = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: p2.body.sub_version, rules_version: 1, languages: ['en'],
    translations: { en: [{ subtitle_id: cues[0].id, version: v2 }, { subtitle_id: cues[1].id, version: 1 }] },
  });

  const r = await api(`/api/projects/${pid}/deliveries/${d2.body.id}/delivery-comments/check?base_id=${b1.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.total, 2);
  assert.equal(r.body.summary.manual, 1);
  assert.equal(r.body.summary.unchanged, 1);
  const byStatus = Object.fromEntries(r.body.items.map((i) => [i.comment_id, i.auto_status]));
  assert.deepEqual(Object.values(byStatus).sort(), ['manual', 'unchanged']);
});

test('清单查询与按批次过滤；过滤参数跨项目 → 404', async () => {
  const { pid, cues } = await setupProject();
  const b1 = await realDelivery(pid, cues, ['Hello world', 'Welcome']);
  await createComment(pid, b1.id, { kind: 'source', start_ms: 0, end_ms: 100, text: 'a' });
  const all = await api(`/api/projects/${pid}/delivery-comments`);
  assert.equal(all.body.comments.length, 1);
  assert.equal(all.body.comments[0].hit_count, 1);
  assert.equal((await api(`/api/projects/${pid}/delivery-comments?batch_id=${b1.id}`)).body.comments.length, 1);
  assert.equal((await api(`/api/projects/${pid}/delivery-comments?batch_id=9999`)).status, 404);
  assert.equal((await api(`/api/projects/${pid}/delivery-comments?batch_id=xyz`)).status, 400);
});
