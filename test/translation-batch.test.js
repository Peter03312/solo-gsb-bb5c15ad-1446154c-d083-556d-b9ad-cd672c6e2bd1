'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
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

const enc = encodeURIComponent;

async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '整批回填测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

const batchBody = (cues, extra = {}) => ({
  batch_no: 'B-0001',
  sub_version: 1,
  rules_version: 1,
  items: [
    { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Hello world' },
    { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Welcome' },
  ],
  ...extra,
});

// ---------- 形状拒绝（400） ----------

test('形状：批次编号/版本/清单非法、空文本、重复 ID → 400', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;

  const noBatch = await api(url, 'POST', batchBody(cues, { batch_no: '   ' }));
  assert.equal(noBatch.status, 400);
  assert.ok(noBatch.body.errors.some((e) => e.includes('batch_no')));

  const badSub = await api(url, 'POST', batchBody(cues, { sub_version: -1 }));
  assert.equal(badSub.status, 400);
  const badRules = await api(url, 'POST', batchBody(cues, { rules_version: 0 }));
  assert.equal(badRules.status, 400);

  const empty = await api(url, 'POST', batchBody(cues, { items: [] }));
  assert.equal(empty.status, 400);
  assert.ok(empty.body.errors.some((e) => e.includes('items')));

  const blankText = await api(url, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Hello' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: '   ' },
    ],
  }));
  assert.equal(blankText.status, 400);

  const dup = await api(url, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Hello' },
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Hi' },
    ],
  }));
  assert.equal(dup.status, 400);
  assert.ok(dup.body.errors.some((e) => e.includes('重复')));
});

test('形状：无效语言 → 400；不存在的字幕 → 400', async () => {
  const { pid, cues } = await setupProject();

  const badLang = await api(`/api/projects/${pid}/translations/${enc('zh CN')}/batches`,
    'POST', batchBody(cues));
  assert.equal(badLang.status, 400);

  const ghost = await api(`/api/projects/${pid}/translations/en/batches`, 'POST',
    batchBody(cues, {
      items: [{ subtitle_id: 99999, cue_version: 1, version: 0, text: 'Ghost' }],
    }));
  assert.equal(ghost.status, 400);
  assert.ok(ghost.body.errors[0].includes('99999'));
});

// ---------- 成功写入 ----------

test('首次提交：整批新建（版本从 1 开始）→ 201，逐行视图/总览可读', async () => {
  const { pid, cues } = await setupProject();
  const r = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.replayed, false);
  assert.equal(r.body.item_count, 2);
  assert.equal(r.body.created_count, 2);
  assert.equal(r.body.updated_count, 0);
  assert.deepEqual(r.body.items.map((i) => i.version), [1, 1]);
  assert.deepEqual(r.body.items.map((i) => i.action), ['created', 'created']);

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.current, 2);
  assert.equal(view.body.entries[0].translation.text, 'Hello world');
  assert.equal(view.body.entries[0].translation.status, 'current');
  assert.equal(view.body.entries[0].translation.src_text, cues[0].text);

  const list = await api(`/api/projects/${pid}/translations/en/batches/list`);
  assert.equal(list.status, 200);
  assert.equal(list.body.batches.length, 1);
  assert.equal(list.body.batches[0].batch_no, 'B-0001');
  assert.equal(list.body.batches[0].created_count, 2);

  const one = await api(`/api/projects/${pid}/translation-batches/${r.body.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.items.length, 2);
  assert.equal(one.body.items[0].action, 'created');
  assert.equal(one.body.items[0].result_version, 1);

  const all = await api(`/api/projects/${pid}/translation-batches`);
  assert.equal(all.body.batches.length, 1);
});

test('成功提交不推进 sub_version（回填只写译文）', async () => {
  const { pid, cues, sub_version } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  const project = await api(`/api/projects/${pid}`);
  assert.equal(project.body.sub_version, sub_version);
});

// ---------- 更新：覆盖 current / review ----------

test('再次回填：版本递增、刷新源快照为 current，允许覆盖待复核译文', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  await api(url, 'POST', batchBody(cues, { batch_no: 'B1' }));

  // 改源行文本 → 该语言两行译文转 review
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`,
    'PATCH', { version: 1, text: '你好呀世界' });
  assert.equal(edit.status, 200);
  let view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'review');

  // 整批覆盖：cue0 行版本 2、译文版本 1；cue1 行版本 1、译文版本 1
  const r = await api(url, 'POST', {
    batch_no: 'B2',
    sub_version: edit.body.sub_version,
    rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 2, version: 1, text: 'Hello there world' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 1, text: 'Welcome!' },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((i) => i.action), ['updated', 'updated']);
  assert.deepEqual(r.body.items.map((i) => i.version), [2, 2]);

  view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].state, 'current');
  assert.equal(view.body.entries[0].translation.version, 2);
  assert.equal(view.body.entries[0].translation.src_text, '你好呀世界', '源快照刷新为当前源行');
  assert.equal(view.body.entries[1].translation.version, 2);
});

test('部分回填：未列出的行与其他语言不变', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  // 先整批写两行
  await api(url, 'POST', batchBody(cues, { batch_no: 'B1' }));
  // 再只回填第一行
  const r = await api(url, 'POST', {
    batch_no: 'B2', sub_version: 1, rules_version: 1,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, version: 1, text: 'Hi world' }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.item_count, 1);
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].translation.text, 'Hi world');
  assert.equal(view.body.entries[0].translation.version, 2);
  assert.equal(view.body.entries[1].translation.text, 'Welcome', '未列出行不变');
  assert.equal(view.body.entries[1].translation.version, 1);
});

// ---------- 过期 / 违规：整批不写入（409/422） ----------

test('版本漂移：sub_version / rules_version 过期 → 409 带当前值，整批不写入', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  const staleSub = await api(url, 'POST', batchBody(cues, { sub_version: 99 }));
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.sub_version_stale, true);
  assert.equal(staleSub.body.current.sub_version, 1);

  const staleRules = await api(url, 'POST', batchBody(cues, { rules_version: 99 }));
  assert.equal(staleRules.status, 409);
  assert.equal(staleRules.body.rules_version_stale, true);
});

test('行过期：源行版本过期 / 译文版本过期 / 已存在按新建 / 无译文却更新 → 409 按行返回当前值', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  await api(url, 'POST', batchBody(cues, { batch_no: 'B1' }));

  const cueStale = await api(url, 'POST', {
    batch_no: 'B2', sub_version: 1, rules_version: 1,
    items: [{ subtitle_id: cues[0].id, cue_version: 99, version: 1, text: 'Hi' }],
  });
  assert.equal(cueStale.status, 409);
  assert.equal(cueStale.body.items[0].state, 'cue_version_stale');
  assert.equal(cueStale.body.items[0].cue.version, 1);

  const trStale = await api(url, 'POST', {
    batch_no: 'B3', sub_version: 1, rules_version: 1,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, version: 99, text: 'Hi' }],
  });
  assert.equal(trStale.status, 409);
  assert.equal(trStale.body.items[0].state, 'translation_version_stale');
  assert.equal(trStale.body.items[0].current.version, 1);

  const exists = await api(url, 'POST', {
    batch_no: 'B4', sub_version: 1, rules_version: 1,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Hi' }],
  });
  assert.equal(exists.status, 409);
  assert.equal(exists.body.items[0].state, 'translation_exists');

  // cue1 上还没有 fr 译文却按更新提交
  const missing = await api(`/api/projects/${pid}/translations/fr/batches`, 'POST', {
    batch_no: 'B1', sub_version: 1, rules_version: 1,
    items: [{ subtitle_id: cues[1].id, cue_version: 1, version: 3, text: 'Bienvenue' }],
  });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.items[0].state, 'translation_missing');
});

test('违规：译文超 max_chars / max_cps → 422 按行返回原因，整批不写入', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;

  const long = await api(url, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'x'.repeat(31) },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Welcome' },
    ],
  }));
  assert.equal(long.status, 422);
  assert.equal(long.body.items.length, 1);
  assert.equal(long.body.items[0].state, 'invalid');
  assert.ok(long.body.items[0].reasons.some((r) => r.includes('最大字数')));

  // 21 字 / ~1s → 超过默认 max_cps=20
  const cps = await api(url, 'POST', {
    batch_no: 'B2', sub_version: 1, rules_version: 1,
    items: [{ subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'x'.repeat(21) }],
  });
  assert.equal(cps.status, 422);
  assert.ok(cps.body.items[0].reasons.some((r) => r.includes('字/秒')));

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.counts.missing, 2, '422 整批不得写入');
});

test('混合：一行过期一行违规 → 整批不写入，按行返回当前值与原因', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  await api(url, 'POST', batchBody(cues, { batch_no: 'B1' }));
  const r = await api(url, 'POST', {
    batch_no: 'B2', sub_version: 1, rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 99, version: 1, text: 'Hi' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 1, text: 'x'.repeat(31) },
    ],
  });
  assert.equal(r.status, 409, '含过期行 → 409');
  assert.equal(r.body.items.length, 2);
  const states = new Set(r.body.items.map((i) => i.state));
  assert.ok(states.has('cue_version_stale'));
  assert.ok(states.has('invalid'));
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.deepEqual(view.body.entries.map((e) => e.translation.version), [1, 1], '原译文未变');
});

// ---------- 幂等 / 冲突 ----------

test('幂等：同项目同语言同编号同内容 → 返回首次结果不再写入；顺序不同也算相同', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  const first = await api(url, 'POST', batchBody(cues));
  assert.equal(first.status, 201);
  assert.equal(first.body.replayed, false);

  // 完全相同的重复提交
  const replay = await api(url, 'POST', batchBody(cues));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(replay.body.created_count, 2);
  assert.deepEqual(replay.body.items, first.body.items);

  // 清单行顺序不同：内容指纹按 subtitle_id 排序，仍视为同一内容
  const reordered = await api(url, 'POST', batchBody(cues, {
    items: [...batchBody(cues).items].reverse(),
  }));
  assert.equal(reordered.status, 200);
  assert.equal(reordered.body.replayed, true);

  // 重放不再写入：译文仍为 v1，批次仍只有一个
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.ok(view.body.entries.every((e) => e.translation.version === 1));
  const list = await api(`/api/projects/${pid}/translations/en/batches/list`);
  assert.equal(list.body.batches.length, 1);
});

test('冲突：编号相同内容不同 → 409，失败批次不占编号（随后新编号可成功）', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  await api(url, 'POST', batchBody(cues));

  const conflict = await api(url, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Different text' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Welcome' },
    ],
  }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.conflict, 'batch_no_content_conflict');
  assert.equal(conflict.body.existing_batch.batch_no, 'B-0001');

  // 冲突未写入：第一行仍是首次译文
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries[0].translation.text, 'Hello world');

  // 换编号 → 成功（此时两行已有 v1 译文，按更新携带 version=1）；
  // 说明冲突的失败提交没有产生额外副作用，正常编号空间不受影响
  const other = await api(url, 'POST', {
    batch_no: 'B-0002', sub_version: 1, rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 1, text: 'Hello again world' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 1, text: 'Welcome back' },
    ],
  });
  assert.equal(other.status, 201);
  assert.deepEqual(other.body.items.map((i) => i.action), ['updated', 'updated']);
  // 两个编号各对应一个批次
  const list = await api(`/api/projects/${pid}/translations/en/batches/list`);
  assert.equal(list.body.batches.length, 2);
});

test('批次编号按语言独立：不同语言可使用相同编号', async () => {
  const { pid, cues } = await setupProject();
  const en = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  const frBody = batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Bonjour le monde' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Bienvenue' },
    ],
  });
  const fr = await api(`/api/projects/${pid}/translations/fr/batches`, 'POST', frBody);
  assert.equal(en.status, 201);
  assert.equal(fr.status, 201);
  assert.equal(fr.body.batch_no, en.body.batch_no);
  // 两种语言互不影响
  const view = await api(`/api/projects/${pid}/translations/fr`);
  assert.equal(view.body.entries[0].translation.text, 'Bonjour le monde');
});

test('失败的核对（409/422）不占编号：修正后用同一编号重新提交可成功', async () => {
  const { pid, cues } = await setupProject();
  const url = `/api/projects/${pid}/translations/en/batches`;
  // 先以违规内容提交 → 422，不留批次
  const bad = await api(url, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'x'.repeat(31) },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Welcome' },
    ],
  }));
  assert.equal(bad.status, 422);
  // 同编号、合规内容重新提交 → 201
  const ok = await api(url, 'POST', batchBody(cues));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const list = await api(`/api/projects/${pid}/translations/en/batches/list`);
  assert.equal(list.body.batches.length, 1);
});

// ---------- 与既有读取路径联动 ----------

test('回填结果可参与单语言导出与多语交付；旧导出快照不变', async () => {
  const { pid, cues } = await setupProject();
  // 整批回填英语两行
  const en = await api(`/api/projects/${pid}/translations/en/batches`, 'POST', batchBody(cues));
  assert.equal(en.status, 201);

  // 单语言导出成功且内容为回填译文
  const exp = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  assert.ok(exp.body.content.includes('Hello world') && exp.body.content.includes('Welcome'));

  // 再整批更新译文后导出 v2；v1 快照保持不变
  await api(`/api/projects/${pid}/translations/en/batches`, 'POST', {
    batch_no: 'B-0002', sub_version: 1, rules_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 1, text: 'Hi world' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 1, text: 'Welcome!' },
    ],
  });
  const exp2 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exp2.status, 201);
  assert.equal(exp2.body.version, 2);
  const dl1 = await api(`/api/projects/${pid}/translations/en/exports/1`);
  assert.equal(dl1.status, 200);
  assert.ok(dl1.body.includes('Hello world') && !dl1.body.includes('Hi world'), '旧快照不可变');

  // 法语也整批回填，随后多语交付可读取回填结果
  await api(`/api/projects/${pid}/translations/fr/batches`, 'POST', batchBody(cues, {
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, version: 0, text: 'Bonjour le monde' },
      { subtitle_id: cues[1].id, cue_version: 1, version: 0, text: 'Bienvenue' },
    ],
  }));
  const delivery = await api(`/api/projects/${pid}/deliveries`, 'POST', {
    sub_version: 1,
    rules_version: 1,
    languages: ['en', 'fr'],
    translations: {
      en: cues.map((c) => ({ subtitle_id: c.id, version: 2 })),
      fr: cues.map((c) => ({ subtitle_id: c.id, version: 1 })),
    },
  });
  assert.equal(delivery.status, 201, JSON.stringify(delivery.body));
  assert.equal(delivery.body.files.length, 3);
});

test('404：项目或批次不存在', async () => {
  const { pid } = await setupProject();
  const noProject = await api('/api/projects/99999/translation-batches/1');
  assert.equal(noProject.status, 404);
  const noBatch = await api(`/api/projects/${pid}/translation-batches/99999`);
  assert.equal(noBatch.status, 404);
});
