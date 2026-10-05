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

/** 新建项目 + 排版，返回 { pid, cues, sub_version }（2 条字幕） */
async function setupProject(name = '说话人标注测试') {
  const created = await api('/api/projects', 'POST', { name, words: GOOD_WORDS, cuts: [1200] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

async function makeSpeaker(pid, name) {
  const r = await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: name });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.speaker;
}

/** 提取快照正文里的说话人标签行（每行正文） */
function taggedLines(content) {
  return content.split('\n')
    .filter((l) => l.startsWith('<v '))
    .map((l) => {
      const m = l.match(/^<v ([^>]*)>([\s\S]*)<\/v>$/);
      return m ? { name: m[1], text: m[2] } : null;
    });
}

// ---------- 说话人名册 ----------

test('名册：编号服务端顺序分配、不回收', async () => {
  const { pid } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  const b = await makeSpeaker(pid, '乙');
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
  const list = await api(`/api/projects/${pid}/speakers`);
  assert.equal(list.body.speakers.length, 2);
  assert.equal(list.body.attribution_version, 0);
});

test('名册：显示名拒绝空、换行与标签界定符（400），不创建', async () => {
  const { pid } = await setupProject();
  for (const bad of ['', '   ', 'ab\ncd', 'ab>cd', 'x<y', '带\r回车', 'a b']) {
    const r = await api(`/api/projects/${pid}/speakers`, 'POST', { display_name: bad });
    assert.equal(r.status, 400, `应拒绝 ${JSON.stringify(bad)}`);
    assert.ok(r.body.errors.length > 0);
  }
  const list = await api(`/api/projects/${pid}/speakers`);
  assert.equal(list.body.speakers.length, 0);
});

test('改名：推进归属版本；过期版本 → 409 返回当前名册', async () => {
  const { pid } = await setupProject();
  const sp = await makeSpeaker(pid, '旧名');
  const ok = await api(`/api/projects/${pid}/speakers/${sp.number}`, 'PATCH', {
    attribution_version: 0, display_name: '新名',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.speaker.display_name, '新名');
  assert.equal(ok.body.attribution_version, 1);
  // 用旧归属版本再改 → 409
  const stale = await api(`/api/projects/${pid}/speakers/${sp.number}`, 'PATCH', {
    attribution_version: 0, display_name: '再改',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.attribution_version, 1);
  // 非法名 → 400（不推进版本）
  const bad = await api(`/api/projects/${pid}/speakers/${sp.number}`, 'PATCH', {
    attribution_version: 1, display_name: '带\n换行',
  });
  assert.equal(bad.status, 400);
  // 编号不存在 → 404
  const nf = await api(`/api/projects/${pid}/speakers/99`, 'PATCH', {
    attribution_version: 1, display_name: '谁',
  });
  assert.equal(nf.status, 404);
});

// ---------- 归属标注（单行 + 批量 + 乐观锁 + 锁定行） ----------

test('单行标注：首次 201、覆盖 200，推进归属版本；锁定行也可标注', async () => {
  const { pid, cues } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  const b = await makeSpeaker(pid, '乙');

  // 锁定第一条：锁定行仍可标注
  const lock = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, locked: true,
  });
  assert.equal(lock.status, 200);
  const lockedVersion = lock.body.subtitle.version;

  const r1 = await api(`/api/projects/${pid}/attributions/subtitles/${cues[0].id}`, 'PUT', {
    attribution_version: 0, cue_version: lockedVersion, speaker_number: a.number,
  });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.attribution_version, 1);

  // 覆盖为乙 → 200，版本再推进
  const r2 = await api(`/api/projects/${pid}/attributions/subtitles/${cues[0].id}`, 'PUT', {
    attribution_version: 1, cue_version: lockedVersion, speaker_number: b.number,
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.attribution.number, 2);
  assert.equal(r2.body.attribution_version, 2);
});

test('单行标注：归属版本/行版本过期 → 409 带当前值；编号不存在 → 400；字幕不存在 → 404', async () => {
  const { pid, cues } = await setupProject();
  const a = await makeSpeaker(pid, '甲');

  const good = await api(`/api/projects/${pid}/attributions/subtitles/${cues[0].id}`, 'PUT', {
    attribution_version: 0, cue_version: cues[0].version, speaker_number: a.number,
  });
  assert.equal(good.status, 201);

  // 归属版本过期
  const staleAttr = await api(`/api/projects/${pid}/attributions/subtitles/${cues[1].id}`, 'PUT', {
    attribution_version: 0, cue_version: cues[1].version, speaker_number: a.number,
  });
  assert.equal(staleAttr.status, 409);
  assert.equal(staleAttr.body.current.attribution_version, 1);

  // 行版本过期（先改文本推进第二行版本）
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[1].id}`, 'PATCH', {
    version: cues[1].version, text: '改过文本',
  });
  assert.equal(edit.status, 200);
  const staleCue = await api(`/api/projects/${pid}/attributions/subtitles/${cues[1].id}`, 'PUT', {
    attribution_version: 1, cue_version: cues[1].version, speaker_number: a.number,
  });
  assert.equal(staleCue.status, 409);
  assert.equal(staleCue.body.current.cue.version, cues[1].version + 1);

  // 编号不存在 → 400
  const noSpeaker = await api(`/api/projects/${pid}/attributions/subtitles/${cues[1].id}`, 'PUT', {
    attribution_version: 1, cue_version: cues[1].version + 1, speaker_number: 99,
  });
  assert.equal(noSpeaker.status, 400);

  // 字幕不存在 → 404
  const nf = await api(`/api/projects/${pid}/attributions/subtitles/9999`, 'PUT', {
    attribution_version: 1, cue_version: 1, speaker_number: a.number,
  });
  assert.equal(nf.status, 404);
});

test('批量标注：整批写入、版本只推进一次；任一过期/编号缺失整批不写入并按行返回', async () => {
  const { pid, cues } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  const b = await makeSpeaker(pid, '乙');

  // 成功批量（2 行）
  const ok = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: b.number },
    ],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.applied, 2);
  assert.equal(ok.body.attribution_version, 1);

  // 一行行版本过期 → 409，整批不写入（归属版本不变）
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, text: '改第一行',
  });
  assert.equal(edit.status, 200);
  const fail = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: b.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: a.number },
    ],
  });
  assert.equal(fail.status, 409);
  assert.equal(fail.body.items[0].state, 'cue_version_stale');
  const view = await api(`/api/projects/${pid}/attributions`);
  assert.equal(view.body.attribution_version, 1);
  // 第一行归属仍是甲（整批未写入）
  assert.equal(view.body.cues.find((c) => c.subtitle_id === cues[0].id).attribution.number, 1);

  // 编号不存在 → 400，整批不写入
  const noSp = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version + 1, speaker_number: 7 },
    ],
  });
  assert.equal(noSp.status, 400);
  assert.equal(noSp.body.items[0].state, 'speaker_missing');

  // 空组 / 重复 ID → 400
  assert.equal((await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 1, items: [],
  })).status, 400);
  assert.equal((await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 1,
    items: [
      { subtitle_id: cues[0].id, cue_version: 1, speaker_number: 1 },
      { subtitle_id: cues[0].id, cue_version: 1, speaker_number: 1 },
    ],
  })).status, 400);
});

test('归属视图：逐行并列 + 计数', async () => {
  const { pid, cues } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  await api(`/api/projects/${pid}/attributions/subtitles/${cues[0].id}`, 'PUT', {
    attribution_version: 0, cue_version: cues[0].version, speaker_number: a.number,
  });
  const view = await api(`/api/projects/${pid}/attributions`);
  assert.equal(view.body.counts.cues, 2);
  assert.equal(view.body.counts.attributed, 1);
  assert.equal(view.body.counts.unattributed, 1);
  assert.equal(view.body.cues[0].attribution.display_name, '甲');
  assert.equal(view.body.cues[1].attribution, null);
});

// ---------- 重排：保留 ID 归属继续有效；删除行留历史，新行待标注，不按序号转移 ----------

test('重排身份保持：保留 ID 归属有效；删除行归属留历史、新行待标注', async () => {
  const { pid, cues } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  const b = await makeSpeaker(pid, '乙');
  const batch = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: b.number },
    ],
  });
  assert.equal(batch.status, 201);
  const attrV = batch.body.attribution_version;

  // 改严规则，使第二段（词 2..3 '欢迎光临'）被拆成两行：
  // 第一条（词 0..1，锁定）保留 ID；第二段旧行被删（归属留历史），并新增两条新行（待标注）
  const lock = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, locked: true,
  });
  assert.equal(lock.status, 200);
  const rules = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: 1, max_chars: 3, min_duration_ms: 500, max_cps: 20,
  });
  assert.equal(rules.status, 200);

  const project = await api(`/api/projects/${pid}`);
  const relayout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: project.body.sub_version });
  assert.equal(relayout.status, 200, JSON.stringify(relayout.body));

  const view = await api(`/api/projects/${pid}/attributions`);
  const byId = new Map(view.body.cues.map((c) => [c.subtitle_id, c]));
  // 锁定的第一条 ID 保留，归属仍指向甲
  const kept = byId.get(cues[0].id);
  assert.ok(kept, '保留 ID 的锁定行应仍在');
  assert.equal(kept.attribution.number, a.number);
  // 新增的两行（欢迎/光临）待标注
  const fresh = view.body.cues.filter((c) => c.subtitle_id !== cues[0].id);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((c) => c.attribution === null), '新行不得按序号继承旧归属');
  // 旧第二行归属留作历史（恰有一条），不按展示序号转移到新第一行
  assert.equal(view.body.history.length, 1);
  assert.equal(view.body.history[0].number, b.number);
  // 归属版本不因重排而推进（没有标注写入）
  assert.equal(view.body.attribution_version, attrV);
});

// ---------- 署名版导出：原文 ----------

test('署名版原文导出：写说话人标签、时间轴与普通导出一致；普通导出不含标签', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const a = await makeSpeaker(pid, '茶客甲');
  const b = await makeSpeaker(pid, '掌柜乙');
  const batch = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: b.number },
    ],
  });
  assert.equal(batch.status, 201);
  const attrV = batch.body.attribution_version;

  const exp = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: attrV,
  });
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  assert.equal(exp.body.kind, 'source');
  assert.match(exp.body.content, /^WEBVTT/);
  const lines = taggedLines(exp.body.content);
  assert.deepEqual(lines.map((l) => l.name), ['茶客甲', '掌柜乙']);
  assert.equal(lines[0].text, cues[0].text);

  // 时间轴与普通导出一致
  const normal = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version });
  assert.equal(normal.status, 201);
  const timeline = (c) => [...c.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/gm)]
    .map((m) => `${m[1]} --> ${m[2]}`);
  assert.deepEqual(timeline(exp.body.content), timeline(normal.body.content));
  // 普通导出不含说话人标签
  assert.ok(!normal.body.content.includes('<v '));
});

test('署名版导出：缺归属 → 422 按行列原因且不生成快照', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  await api(`/api/projects/${pid}/attributions/subtitles/${cues[0].id}`, 'PUT', {
    attribution_version: 0, cue_version: cues[0].version, speaker_number: a.number,
  });
  const exp = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: 1,
  });
  assert.equal(exp.status, 422);
  assert.equal(exp.body.rows.length, 1);
  assert.deepEqual(exp.body.rows[0].codes, ['missing_attribution']);
  assert.equal(exp.body.rows[0].subtitle_id, cues[1].id);
  const list = await api(`/api/projects/${pid}/attributed-exports`);
  assert.equal(list.body.exports.length, 0);
});

test('署名版导出：字幕集/归属版本漂移 → 409', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: a.number },
    ],
  });
  // 归属版本漂移
  const staleAttr = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: 0,
  });
  assert.equal(staleAttr.status, 409);
  assert.equal(staleAttr.body.stale.attribution_version, true);
  // 字幕集版本漂移（改一条文本）
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, text: '文本变了',
  });
  assert.equal(edit.status, 200);
  const staleSub = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: 1,
  });
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.stale.sub_version, true);
});

test('署名版快照不可变：改名不改旧快照；旧快照可查询下载', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const a = await makeSpeaker(pid, '旧名');
  const b = await makeSpeaker(pid, '乙');
  await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: b.number },
    ],
  });
  const e1 = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: 1,
  });
  assert.equal(e1.status, 201);
  assert.ok(e1.body.content.includes('<v 旧名>'));

  // 改名推进归属版本
  const renamed = await api(`/api/projects/${pid}/speakers/${a.number}`, 'PATCH', {
    attribution_version: 1, display_name: '新名',
  });
  assert.equal(renamed.status, 200);

  // 旧快照内容不变，仍可下载
  const dl = await api(`/api/projects/${pid}/attributed-exports/${e1.body.version}`);
  assert.equal(dl.status, 200);
  assert.ok(dl.body.includes('<v 旧名>'));
  assert.ok(!dl.body.includes('新名'));

  // 新版本快照用新名
  const project = await api(`/api/projects/${pid}`);
  const e2 = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: project.body.sub_version, attribution_version: renamed.body.attribution_version,
  });
  assert.equal(e2.status, 201);
  assert.equal(e2.body.version, e1.body.version + 1);
  assert.ok(e2.body.content.includes('<v 新名>'));
});

// ---------- 署名版导出：译文（逐行译文版本、共用时间轴） ----------

test('署名版译文导出：携带逐行译文版本，时间轴与原文一致；译文问题按行列原因', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  const b = await makeSpeaker(pid, '乙');
  const attr = await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: b.number },
    ],
  });
  assert.equal(attr.status, 201);
  const attrV = attr.body.attribution_version;

  // 只翻译第一行 → 译文导出应 422：第二行缺译
  const t1 = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[0].id}`, 'PUT', {
    text: 'Hello world', cue_version: cues[0].version,
  });
  assert.equal(t1.status, 201);
  const miss = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: attrV, lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
  });
  assert.equal(miss.status, 422);
  const row1 = miss.body.rows.find((r) => r.subtitle_id === cues[1].id);
  assert.ok(row1.codes.includes('missing_translation'));

  // 补齐第二行译文
  const t2 = await api(`/api/projects/${pid}/translations/en/subtitles/${cues[1].id}`, 'PUT', {
    text: 'Welcome', cue_version: cues[1].version,
  });
  assert.equal(t2.status, 201);

  // 译文版本漂移 → 422 translation_version_stale
  const staleV = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: attrV, lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 9 }],
  });
  assert.equal(staleV.status, 422);
  const sv = staleV.body.rows.find((r) => r.subtitle_id === cues[1].id);
  assert.ok(sv.codes.includes('translation_version_stale'));

  // 清单漏行 → 400（形状）/ 422（缺版本）：此处少给一行 → 422 missing_translation_version
  const short = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: attrV, lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }],
  });
  assert.equal(short.status, 422);
  assert.ok(short.body.rows.some((r) => r.codes.includes('missing_translation_version')));

  // 正确导出：英文正文 + 说话人标签，时间轴与署名原文完全一致
  const ok = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: attrV, lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.kind, 'translation');
  assert.equal(ok.body.lang, 'en');
  const lines = taggedLines(ok.body.content);
  assert.deepEqual(lines.map((l) => ({ name: l.name, text: l.text })), [
    { name: '甲', text: 'Hello world' },
    { name: '乙', text: 'Welcome' },
  ]);

  const srcExp = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version, attribution_version: attrV,
  });
  assert.equal(srcExp.status, 201);
  const timeline = (c) => [...c.matchAll(/^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/gm)]
    .map((m) => `${m[1]} --> ${m[2]}`);
  assert.deepEqual(timeline(ok.body.content), timeline(srcExp.body.content), '原文与译文共用同一时间轴');

  // 快照清单可查询，原文/译文共用一个连续序列
  const list = await api(`/api/projects/${pid}/attributed-exports`);
  assert.equal(list.body.exports.length, 2);
  const kinds = list.body.exports.map((e) => e.kind);
  assert.ok(kinds.includes('source') && kinds.includes('translation'));
});

test('署名版译文导出：待复核译文 → 422 translation_review，不生成快照', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: a.number },
    ],
  });
  for (const c of cues) {
    await api(`/api/projects/${pid}/translations/en/subtitles/${c.id}`, 'PUT', {
      text: c.id === cues[0].id ? 'Hello world' : 'Welcome', cue_version: c.version,
    });
  }
  // 修改第一行源文本（未锁定），使其译文转待复核
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cues[0].version, text: '你好呀世界',
  });
  assert.equal(edit.status, 200);
  const project = await api(`/api/projects/${pid}`);
  // 重新标注第一行（行版本已变），归属版本 +1
  const reattr = await api(`/api/projects/${pid}/attributions/subtitles/${cues[0].id}`, 'PUT', {
    attribution_version: 1, cue_version: cues[0].version + 1, speaker_number: a.number,
  });
  assert.equal(reattr.status, 200);

  const exp = await api(`/api/projects/${pid}/attributed-exports`, 'POST', {
    sub_version: project.body.sub_version, attribution_version: reattr.body.attribution_version, lang: 'en',
    translations: [{ subtitle_id: cues[0].id, version: 1 }, { subtitle_id: cues[1].id, version: 1 }],
  });
  assert.equal(exp.status, 422);
  const r0 = exp.body.rows.find((r) => r.subtitle_id === cues[0].id);
  assert.ok(r0.codes.includes('translation_review'));
});

test('普通导出与下载内容保持兼容（不含标签），且与署名序列互不影响', async () => {
  const { pid, cues, sub_version } = await setupProject();
  const a = await makeSpeaker(pid, '甲');
  await api(`/api/projects/${pid}/attributions/batch`, 'POST', {
    attribution_version: 0,
    items: [
      { subtitle_id: cues[0].id, cue_version: cues[0].version, speaker_number: a.number },
      { subtitle_id: cues[1].id, cue_version: cues[1].version, speaker_number: a.number },
    ],
  });
  // 普通导出（即便已全部归属）也不写说话人标签
  const normal = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version });
  assert.equal(normal.status, 201);
  assert.ok(!normal.body.content.includes('<v'));
  // 署名快照不占普通导出序列
  await api(`/api/projects/${pid}/attributed-exports`, 'POST', { sub_version, attribution_version: 1 });
  const normalList = await api(`/api/projects/${pid}/exports`);
  assert.deepEqual(normalList.body.map((e) => e.version), [1]);
});
