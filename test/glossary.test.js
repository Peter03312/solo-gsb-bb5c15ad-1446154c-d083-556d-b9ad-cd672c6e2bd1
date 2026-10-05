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

async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '术语测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles };
}

const enc = encodeURIComponent;

// ---------- 术语表管理 ----------

test('术语：未配置语言读取返回 configured=false / version=0；总览为空', async () => {
  const { pid } = await setupProject();
  const g = await api(`/api/projects/${pid}/glossaries/en`);
  assert.equal(g.status, 200);
  assert.equal(g.body.configured, false);
  assert.equal(g.body.version, 0);
  assert.deepEqual(g.body.terms, []);

  const list = await api(`/api/projects/${pid}/glossaries`);
  assert.deepEqual(list.body.glossaries, []);
});

test('术语：非法语言代号 → 400', async () => {
  const { pid } = await setupProject();
  const r = await api(`/api/projects/${pid}/glossaries/${enc('bad lang')}`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  assert.equal(r.status, 400);
});

test('术语：空源词/空译法/重复源词/版本字段非法 → 400', async () => {
  const { pid } = await setupProject();
  const cases = [
    { version: 0, terms: [{ source: '  ', target: 'Hello' }] },
    { version: 0, terms: [{ source: '你好', target: '' }] },
    { version: 0, terms: [{ source: ' 你好', target: 'Hello' }] },
    { version: 0, terms: [{ source: '你好', target: 'Hello' }, { source: '你好', target: 'Hi' }] },
    { terms: [{ source: '你好', target: 'Hello' }] },
    { version: -1, terms: [] },
    { version: 0 },
  ];
  for (const body of cases) {
    const r = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(Array.isArray(r.body.errors));
  }
  // 任何拒绝都不得建表
  const g = await api(`/api/projects/${pid}/glossaries/en`);
  assert.equal(g.body.configured, false);
});

test('术语：首版 version=0 创建 → 版本 1；再改须带当前版本，过期 → 409 返回当前表', async () => {
  const { pid } = await setupProject();
  const r1 = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.version, 1);
  assert.equal(r1.body.term_count, 1);

  // 已存在却仍按新建 version=0 → 409，current 为当前表
  const stale0 = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '世界', target: 'world' }],
  });
  assert.equal(stale0.status, 409);
  assert.equal(stale0.body.current.version, 1);
  assert.equal(stale0.body.current.terms[0].source, '你好');

  // 基于旧版本 99 → 409
  const stale99 = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 99, terms: [],
  });
  assert.equal(stale99.status, 409);

  // 正确版本 → 200，版本推进到 2
  const r2 = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 1, terms: [
      { source: '你好', target: 'Hello' },
      { source: '世界', target: 'world' },
    ],
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.version, 2);
  assert.equal(r2.body.term_count, 2);

  const list = await api(`/api/projects/${pid}/glossaries`);
  assert.equal(list.body.glossaries.length, 1);
  assert.equal(list.body.glossaries[0].version, 2);
});

test('术语：整表替换以提交内容为准（旧词删除）；空数组允许清空', async () => {
  const { pid } = await setupProject();
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }, { source: '世界', target: 'world' }],
  });
  const r = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 1, terms: [{ source: '欢迎', target: 'Welcome' }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.terms.map((t) => t.source), ['欢迎']);

  const cleared = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', { version: 2, terms: [] });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.version, 3);
  assert.equal(cleared.body.configured, true);
  assert.deepEqual(cleared.body.terms, []);
});

test('术语：各语言术语表独立（同项目不同语言互不影响）', async () => {
  const { pid } = await setupProject();
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  const ja = await api(`/api/projects/${pid}/glossaries/ja`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'こんにちは' }],
  });
  assert.equal(ja.status, 200);
  const en = await api(`/api/projects/${pid}/glossaries/en`);
  assert.equal(en.body.version, 1);
  assert.equal(en.body.terms[0].target, 'Hello');
});

// ---------- 保存译文时术语不拦截、并列视图呈现术语缺失 ----------

test('术语：译文缺失规定译法仍可保存（201/200），响应与并列查询列出 term_issues', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0,
    terms: [
      { source: '你好', target: 'Hello' },
      { source: '世界', target: 'world' },
    ],
  });
  // 译文“Hi earth”两个规定译法都不含 → 保存成功但带 term_issues
  const saved = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi earth', cue_version: 1 });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.translation.status, 'current');
  assert.equal(saved.body.glossary_version, 1);
  const missingSources = saved.body.term_issues.map((m) => m.source).sort();
  assert.deepEqual(missingSources, ['世界', '你好']);

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.glossary.configured, true);
  assert.equal(view.body.glossary.version, 1);
  const e0 = view.body.entries.find((e) => e.cue.id === cues[0].id);
  assert.equal(e0.state, 'current');
  assert.equal(e0.valid, true, '术语问题不影响规则有效判定');
  assert.equal(e0.term_issues.length, 2);
  assert.equal(view.body.counts.term_missing, 1);

  // 改成合规译文后 term_issues 清空
  const fixed = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1, version: 1 });
  assert.equal(fixed.status, 200);
  assert.deepEqual(fixed.body.term_issues, []);
});

test('术语：一行命中多词时每个规定译法都必须出现；全部满足才不缺失', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0,
    terms: [
      { source: '你好', target: 'Hello' },
      { source: '世界', target: 'world' },
    ],
  });
  // 只满足一个
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello there', cue_version: 1 });
  let view = await api(`/api/projects/${pid}/translations/en`);
  const issues = view.body.entries.find((e) => e.cue.id === cues[0].id).term_issues;
  assert.deepEqual(issues.map((m) => m.source), ['世界']);

  // 两个都满足（顺序不限、作为子串出现即可）
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'world, Hello!', cue_version: 1, version: 1 });
  view = await api(`/api/projects/${pid}/translations/en`);
  assert.deepEqual(view.body.entries.find((e) => e.cue.id === cues[0].id).term_issues, []);
});

test('术语：未配置术语的语言不受影响（无 term_issues，导出照常）', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi earth', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.glossary.configured, false);
  for (const e of view.body.entries) assert.deepEqual(e.term_issues, []);

  const exported = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(exported.status, 201, JSON.stringify(exported.body));
  assert.equal(exported.body.glossary_version, 0);
});

test('术语：缺失查询按语言/字幕 ID/源词列出（含无译文行）并带术语版本', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0,
    terms: [
      { source: '你好', target: 'Hello' },
      { source: '欢迎', target: 'Welcome' },
    ],
  });
  // cue0 有译文但不含 Hello；cue1 无译文且命中“欢迎”
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Good day', cue_version: 1 });
  const r = await api(`/api/projects/${pid}/glossaries/en/missing`);
  assert.equal(r.status, 200);
  assert.equal(r.body.glossary_version, 1);
  assert.equal(r.body.configured, true);
  const byCue = new Map(r.body.missing.map((m) => [m.subtitle_id, m]));
  assert.ok(byCue.has(cues[0].id));
  assert.ok(byCue.has(cues[1].id));
  assert.deepEqual(byCue.get(cues[0].id).missing.map((m) => m.source), ['你好']);
  assert.deepEqual(byCue.get(cues[1].id).missing.map((m) => m.source), ['欢迎']);
  assert.ok(byCue.get(cues[1].id).missing[0].reason.includes('尚无译文'));

  // 修正后查询清空
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello', cue_version: 1, version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  const r2 = await api(`/api/projects/${pid}/glossaries/en/missing`);
  assert.deepEqual(r2.body.missing, []);
});

// ---------- 术语变更不改状态，导出三类闸门 ----------

test('术语：术语变更不改变既有译文 current/review 状态', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  // 事后新增严格术语：译文仍 current
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '世界', target: 'WORLD' }],
  });
  let view = await api(`/api/projects/${pid}/translations/en`);
  const e = view.body.entries.find((x) => x.cue.id === cues[0].id);
  assert.equal(e.state, 'current');
  assert.equal(e.term_issues.length, 1);

  // 让译文进入 review：编辑源行
  await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: 1, text: '你好世界呀',
  });
  view = await api(`/api/projects/${pid}/translations/en`);
  const e2 = view.body.entries.find((x) => x.cue.id === cues[0].id);
  assert.equal(e2.state, 'review');
  // 再改术语（换规定译法）→ 仍 review，不自动回 current
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 1, terms: [{ source: '世界', target: 'Earth' }],
  });
  view = await api(`/api/projects/${pid}/translations/en`);
  const e3 = view.body.entries.find((x) => x.cue.id === cues[0].id);
  assert.equal(e3.state, 'review');
});

test('术语：单语言导出术语缺失 → 422 term_missing 且不生成快照/不耗版本', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi world', cue_version: 1 });   // 缺 Hello
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });

  const r = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.term_missing.length, 1);
  assert.equal(r.body.term_missing[0].subtitle_id, cues[0].id);
  assert.equal(r.body.term_missing[0].missing[0].source, '你好');
  assert.equal(r.body.glossary_version, 1);
  // 没有任何快照
  const list = await api(`/api/projects/${pid}/translations/en/exports`);
  assert.deepEqual(list.body, []);

  // 修正译文后导出成功，响应带术语版本
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1, version: 1 });
  const ok = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.version, 1);
  assert.equal(ok.body.glossary_version, 1);
});

test('术语：导出后修改术语不影响旧快照；新导出按新术语核对', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  const v1 = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(v1.status, 201);
  const oldContent = v1.body.content;

  // 收紧术语：新增“世界 → Earth”，现有译文只有 world 不合新术语
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 1,
    terms: [
      { source: '你好', target: 'Hello' },
      { source: '世界', target: 'Earth' },
    ],
  });
  const blocked = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.term_missing.length, 1);
  assert.equal(blocked.body.glossary_version, 2);

  // 旧快照仍可下载且内容不变
  const dl = await api(`/api/projects/${pid}/translations/en/exports/1`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body, oldContent);
});

test('术语：多语同版交付——任一语言术语缺失按语言/行报错且整批不生成快照', async () => {
  const { pid, cues } = await setupProject();
  // 英语：cue0 合规；法语：cue0 缺规定译法
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  await api(`/api/projects/${pid}/glossaries/fr`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Bonjour' }],
  });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Salut le monde', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[1].id}`,
    'PUT', { text: 'Bienvenue', cue_version: 1 });

  const body = {
    sub_version: 1, rules_version: 1, languages: ['en', 'fr'],
    translations: {
      en: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
      fr: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
    },
  };
  const r = await api(`/api/projects/${pid}/deliveries`, 'POST', body);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  const langs = new Map(r.body.languages.map((l) => [l.lang, l]));
  assert.equal(langs.get('en').term_missing.length, 0);
  assert.equal(langs.get('fr').term_missing.length, 1);
  assert.equal(langs.get('fr').term_missing[0].subtitle_id, cues[0].id);
  assert.equal(langs.get('fr').glossary_version, 1);

  // 整批未生成任何快照
  const batches = await api(`/api/projects/${pid}/deliveries`);
  assert.deepEqual(batches.body.batches, []);
  const enExports = await api(`/api/projects/${pid}/translations/en/exports`);
  const frExports = await api(`/api/projects/${pid}/translations/fr/exports`);
  assert.deepEqual(enExports.body, []);
  assert.deepEqual(frExports.body, []);

  // 修正法语后整批成功
  await api(`/api/projects/${pid}/translations/fr/subtitles/${cues[0].id}`,
    'PUT', { text: 'Bonjour le monde', cue_version: 1, version: 1 });
  body.translations.fr[0].version = 2;
  const ok = await api(`/api/projects/${pid}/deliveries`, 'POST', body);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.files.length, 3);
});

test('术语：译文署名导出术语缺失 → 422 行内 translation_term_missing 且不生成快照', async () => {
  const { pid, cues } = await setupProject();
  // 说话人 + 归属（每行写入都推进归属版本，须随写随取）
  const sp = await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: '甲' });
  assert.equal(sp.status, 201);
  let attrVersion = 0;
  for (const c of cues) {
    const a = await api(`/api/projects/${pid}/attributions/subtitles/${c.id}`, 'PUT', {
      attribution_version: attrVersion, cue_version: 1, speaker_number: 1,
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    attrVersion = a.body.attribution_version;
  }
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hi world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });

  // 归属版本随每条写入推进（2 行 → v2），直接使用最后一次响应的版本
  const r = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1,
    attribution_version: attrVersion,
    lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.rows.length, 1);
  assert.ok(r.body.rows[0].codes.includes('translation_term_missing'));
  assert.equal(r.body.rows[0].term_missing[0].source, '你好');
  assert.equal(r.body.glossary_version, 1);
  const list = await api(`/api/projects/${pid}/attributed-exports`);
  assert.deepEqual(list.body.exports, []);

  // 原文署名导出不做术语核对，正常成功
  const src = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1, attribution_version: attrVersion,
  });
  assert.equal(src.status, 201, JSON.stringify(src.body));
});

test('术语：译文署名导出术语合规时成功，正文含说话人标签', async () => {
  const { pid, cues } = await setupProject();
  await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: '甲' });
  let attrVersion2 = 0;
  for (const c of cues) {
    const a = await api(`/api/projects/${pid}/attributions/subtitles/${c.id}`, 'PUT', {
      attribution_version: attrVersion2, cue_version: 1, speaker_number: 1,
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    attrVersion2 = a.body.attribution_version;
  }
  await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hello' }],
  });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`,
    'PUT', { text: 'Hello world', cue_version: 1 });
  await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`,
    'PUT', { text: 'Welcome', cue_version: 1 });
  const r = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: 1,
    attribution_version: attrVersion2,
    lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.content, /<v 甲>Hello world<\/v>/);
  assert.equal(r.body.glossary_version, 1);
});
