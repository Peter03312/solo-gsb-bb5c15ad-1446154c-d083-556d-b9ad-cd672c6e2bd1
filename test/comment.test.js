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

/** 建项目（带切点）并排版：2 条字幕（词0-1 / 词2-3） */
async function setupProject() {
  const created = await api('/api/projects', 'POST', {
    name: '复核意见测试', words: GOOD_WORDS, cuts: [1200],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

/** 建项目（无切点）并排版：1 条字幕（词0-3） */
async function setupMergedProject() {
  const created = await api('/api/projects', 'POST', {
    name: '复核意见锚定测试', words: GOOD_WORDS, cuts: [],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pid = created.body.id;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  assert.equal(layout.body.subtitles.length, 1);
  return { pid, cues: layout.body.subtitles, sub_version: layout.body.sub_version };
}

async function createComment(pid, payload) {
  return api(`/api/projects/${pid}/comments`, 'POST', payload);
}
async function listComments(pid) {
  return api(`/api/projects/${pid}/comments`);
}
async function closeComment(pid, cid, version) {
  return api(`/api/projects/${pid}/comments/${cid}/close`, 'POST', { version });
}
async function reopenComment(pid, cid, version) {
  return api(`/api/projects/${pid}/comments/${cid}/reopen`, 'POST', { version });
}

// ---------- 创建：形状校验 ----------

test('创建：空意见/区间颠倒/缺字段/非法词序 → 400，不创建', async () => {
  const { pid } = await setupProject();
  const base1 = { import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '注意停顿' };

  const blank = await createComment(pid, { ...base1, text: '   ' });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /非法/);

  const reversed = await createComment(pid, { ...base1, word_start: 2, word_end: 1 });
  assert.equal(reversed.status, 400);

  const noVersion = await createComment(pid, { word_start: 0, word_end: 1, text: 'x' });
  assert.equal(noVersion.status, 400);

  const negative = await createComment(pid, { ...base1, word_start: -1 });
  assert.equal(negative.status, 400);

  const list = await listComments(pid);
  assert.equal(list.body.comments.length, 0);
  assert.equal(list.body.counts.open, 0);
});

test('创建：导入代次/字幕集版本过期 → 409 返回当前值且不创建', async () => {
  const { pid } = await setupProject();
  const staleSub = await createComment(pid, {
    import_version: 1, sub_version: 0, word_start: 0, word_end: 1, text: 'x',
  });
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.current.sub_version, 1);
  assert.equal(staleSub.body.current.import_version, 1);

  const staleImport = await createComment(pid, {
    import_version: 99, sub_version: 1, word_start: 0, word_end: 1, text: 'x',
  });
  assert.equal(staleImport.status, 409);
  assert.match(staleImport.body.error, /导入代次/);

  const list = await listComments(pid);
  assert.equal(list.body.comments.length, 0);
});

test('创建：词区间越界/未导入转写 → 422，不创建', async () => {
  const { pid } = await setupProject();
  const outOfRange = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 4, text: 'x',
  });
  assert.equal(outOfRange.status, 422);
  assert.match(outOfRange.body.errors[0], /超出范围/);

  // 未导入任何词的项目
  const empty = await api('/api/projects', 'POST', { name: '空项目' });
  const noWords = await createComment(empty.body.id, {
    import_version: 1, sub_version: 0, word_start: 0, word_end: 0, text: 'x',
  });
  assert.equal(noWords.status, 422);
  assert.match(noWords.body.errors[0], /尚未导入/);
});

// ---------- 创建成功与列表视图 ----------

test('创建成功 201：状态 open、版本 1、词段与相交字幕；列表返回状态/词段/相交字幕', async () => {
  const { pid, cues } = await setupProject();
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '「你好世界」连读自然',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.body.comment;
  assert.equal(c.status, 'open');
  assert.equal(c.version, 1);
  assert.equal(c.import_version, 1);
  assert.deepEqual(c.words.map((w) => w.text), ['你好', '世界']);
  assert.deepEqual(c.words_snapshot.map((w) => w.text), ['你好', '世界']);
  assert.equal(c.subtitles.length, 1);
  assert.equal(c.subtitles[0].id, cues[0].id);
  assert.equal(c.snapshot, null);

  // 跨两条字幕的区间
  const r2 = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 1, word_end: 2, text: '切点前后衔接',
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.comment.subtitles.length, 2);

  const list = await listComments(pid);
  assert.equal(list.body.import_version, 1);
  assert.equal(list.body.sub_version, 1);
  assert.equal(list.body.comments.length, 2);
  assert.equal(list.body.counts.open, 2);
  assert.equal(list.body.history.length, 0);
  const cross = list.body.comments.find((x) => x.id === r2.body.comment.id);
  assert.deepEqual(cross.subtitles.map((s) => s.id), [cues[0].id, cues[1].id]);
});

// ---------- 锚定：重排拆并后仍按词区间显示在相交字幕旁 ----------

test('锚定：重排拆并、字幕行更替后意见仍按词区间相交（不按字幕 ID/行号迁移）', async () => {
  const { pid, cues } = await setupMergedProject();
  const onlyCue = cues[0];
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 1, word_end: 2, text: '中间两个词衔接',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.comment.subtitles.length, 1);
  assert.equal(r.body.comment.subtitles[0].id, onlyCue.id);

  // 改规则使整行拆成两条（字幕行更替：旧行删除、新行新 ID）
  const rules = (await api(`/api/projects/${pid}`)).body.rules;
  const put = await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: rules.version, max_chars: 4, min_duration_ms: 800, max_cps: 20,
  });
  assert.equal(put.status, 200);
  const cur = (await api(`/api/projects/${pid}`)).body;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: cur.sub_version });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  assert.equal(layout.body.subtitles.length, 2);
  assert.ok(layout.body.subtitles.every((s) => s.id !== onlyCue.id), '旧行应被替换为新 ID');

  // 意见 id 不变，仍锚定词区间 [1,2]，现在与两条新字幕相交
  const list = await listComments(pid);
  assert.equal(list.body.comments.length, 1);
  const c = list.body.comments[0];
  assert.equal(c.id, r.body.comment.id);
  assert.equal(c.word_start, 1);
  assert.equal(c.word_end, 2);
  assert.equal(c.subtitles.length, 2);
  assert.deepEqual(
    c.subtitles.map((s) => [s.word_start, s.word_end]),
    [[0, 1], [2, 3]]
  );
});

// ---------- 关闭 / 待复核 / 重新打开 ----------

test('关闭：无相交字幕（尚未排版）→ 422；版本过期 → 409 返回当前值且不修改', async () => {
  const created = await api('/api/projects', 'POST', { name: '未排版', words: GOOD_WORDS, cuts: [] });
  const pid = created.body.id;
  const r = await createComment(pid, {
    import_version: 1, sub_version: 0, word_start: 0, word_end: 1, text: '待排版后核对',
  });
  assert.equal(r.status, 201);
  const cid = r.body.comment.id;

  const noCue = await closeComment(pid, cid, 1);
  assert.equal(noCue.status, 422);
  assert.match(noCue.body.error, /没有相交的字幕/);

  // 排版后可以关闭
  await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: 0 });
  const stale = await closeComment(pid, cid, 99);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.comment.version, 1);
  assert.equal(stale.body.current.comment.status, 'open');

  const badField = await closeComment(pid, cid, 0);
  assert.equal(badField.status, 400);

  const ghost = await closeComment(pid, 99999, 1);
  assert.equal(ghost.status, 404);
});

test('关闭保存相交字幕快照；文本/时间/词区间变化自动转待复核；锁定与仅顺序变化不触发', async () => {
  const { pid, cues } = await setupProject();
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '核对第一条',
  });
  const cid = r.body.comment.id;

  // 关闭：保存快照（词区间/文本/起止）
  const closed = await closeComment(pid, cid, 1);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.comment.status, 'closed');
  assert.equal(closed.body.comment.version, 2);
  assert.deepEqual(closed.body.comment.snapshot, [{
    word_start: 0, word_end: 1, text: cues[0].text,
    start_ms: cues[0].start_ms, end_ms: cues[0].end_ms,
  }]);
  assert.equal(closed.body.comment.closed_sub_version, 1);

  // 仅锁定切换：不触发待复核
  const cue0 = (await api(`/api/projects/${pid}`)).body.subtitles.find((s) => s.id === cues[0].id);
  const lock = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cue0.version, locked: true,
  });
  assert.equal(lock.status, 200);
  let view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'closed');
  const unlock = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: lock.body.subtitle.version, locked: false,
  });
  assert.equal(unlock.status, 200);
  view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'closed');

  // 同样规则重排（身份保持，仅展示顺序维护）：不触发待复核
  const cur1 = (await api(`/api/projects/${pid}`)).body;
  const relay = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: cur1.sub_version });
  assert.equal(relay.status, 200);
  view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'closed');

  // 不相交字幕（第二条）文本变化：不影响本条意见
  const cue1 = (await api(`/api/projects/${pid}`)).body.subtitles.find((s) => s.id === cues[1].id);
  const editOther = await api(`/api/projects/${pid}/subtitles/${cues[1].id}`, 'PATCH', {
    version: cue1.version, text: '欢迎再来',
  });
  assert.equal(editOther.status, 200);
  view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'closed');

  // 相交字幕文本变化：自动转待复核
  const cue0b = (await api(`/api/projects/${pid}`)).body.subtitles.find((s) => s.id === cues[0].id);
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cue0b.version, text: '你好，世界',
  });
  assert.equal(edit.status, 200);
  view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'review');
  assert.equal(view.body.counts.review, 1);

  // 待复核保持到再次显式关闭；重新打开 → open
  const reopened = await reopenComment(pid, cid, view.body.comments[0].version);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.comment.status, 'open');
  assert.equal(reopened.body.comment.version, 3);

  // 再次显式关闭：刷新为新快照
  const reclosed = await closeComment(pid, cid, 3);
  assert.equal(reclosed.status, 200);
  assert.equal(reclosed.body.comment.status, 'closed');
  assert.equal(reclosed.body.comment.snapshot[0].text, '你好，世界');
  assert.equal(reclosed.body.comment.version, 4);
});

test('相交字幕时间变化与词区间变化（重排拆并）同样触发待复核', async () => {
  const { pid, cues } = await setupProject();
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '第一条',
  });
  const cid = r.body.comment.id;
  await closeComment(pid, cid, 1);

  // 时间变化（延长结束时间，仍在词时段与下条之前的间隙内）
  const cue0 = (await api(`/api/projects/${pid}`)).body.subtitles.find((s) => s.id === cues[0].id);
  const edit = await api(`/api/projects/${pid}/subtitles/${cues[0].id}`, 'PATCH', {
    version: cue0.version, end_ms: 1100,
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  let view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'review');

  // 再关闭后，重排拆并（词区间变化）→ 待复核
  await closeComment(pid, cid, view.body.comments[0].version);
  const rules = (await api(`/api/projects/${pid}`)).body.rules;
  await api(`/api/projects/${pid}/rules`, 'PUT', {
    version: rules.version, max_chars: 2, min_duration_ms: 400, max_cps: 20,
  });
  const cur = (await api(`/api/projects/${pid}`)).body;
  const layout = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: cur.sub_version });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  assert.equal(layout.body.subtitles.length, 4);
  view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'review');
  // 意见仍锚定词区间 [0,1]，与拆出的两条新字幕相交
  assert.equal(view.body.comments[0].subtitles.length, 2);
});

test('逐词改时确认后：意见仍锚定词区间，相交字幕快照漂移 → 待复核', async () => {
  const { pid } = await setupProject();
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '第一条时间',
  });
  const cid = r.body.comment.id;
  await closeComment(pid, cid, 1);

  // 提交并确认逐词修正：词 1 结束 1000 → 1100（相交字幕随重排换 ID、时间变化）
  const wr = await api(`/api/projects/${pid}/word-revisions`, 'POST', {
    sub_version: 1, items: [{ word_idx: 1, start_ms: 550, end_ms: 1100 }],
  });
  assert.equal(wr.status, 201, JSON.stringify(wr.body));
  const confirm = await api(`/api/projects/${pid}/word-revisions/${wr.body.id}/confirm`, 'POST', {});
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const view = await listComments(pid);
  const c = view.body.comments[0];
  assert.equal(c.id, cid);
  assert.equal(c.status, 'review');
  assert.deepEqual([c.word_start, c.word_end], [0, 1]);
  assert.equal(c.subtitles.length, 1);
  assert.equal(c.subtitles[0].end_ms, 1100);
  // 词段时间随当前转写展示
  assert.equal(c.words[1].end_ms, 1100);
});

test('重新打开：open 状态 → 422；版本过期 → 409；历史意见 → 422', async () => {
  const { pid } = await setupProject();
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: 'x',
  });
  const cid = r.body.comment.id;

  const alreadyOpen = await reopenComment(pid, cid, 1);
  assert.equal(alreadyOpen.status, 422);
  assert.match(alreadyOpen.body.error, /待处理/);

  await closeComment(pid, cid, 1);
  const stale = await reopenComment(pid, cid, 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.comment.version, 2);
  assert.equal(stale.body.current.comment.status, 'closed');

  const ok = await reopenComment(pid, cid, 2);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.comment.status, 'open');
  assert.equal(ok.body.comment.version, 3);
});

// ---------- 重新导入：旧意见仅作历史查看 ----------

test('重新导入后旧意见转历史：不附到新词段、不可关闭/重开；新代次可正常创建', async () => {
  const { pid } = await setupProject();
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '旧代次意见',
  });
  const cid = r.body.comment.id;
  await closeComment(pid, cid, 1);
  const r2 = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 2, word_end: 3, text: '另一条未关闭',
  });
  assert.equal(r2.status, 201);

  // 重新导入（不同的词），旧字幕清空
  const reimport = await api(`/api/projects/${pid}/import`, 'POST', {
    force: true,
    words: [
      { text: '全新', start_ms: 0, end_ms: 400 },
      { text: '内容', start_ms: 500, end_ms: 900 },
    ],
    cuts: [],
  });
  assert.equal(reimport.status, 200);
  assert.equal(reimport.body.import_version, 2);

  const view = await listComments(pid);
  assert.equal(view.body.import_version, 2);
  assert.equal(view.body.comments.length, 0);
  assert.equal(view.body.history.length, 2);
  assert.equal(view.body.counts.history, 2);
  const h = view.body.history.find((x) => x.id === cid);
  assert.equal(h.status, 'history');
  assert.equal(h.import_version, 1);
  assert.equal(h.words, null, '历史意见不附到新词段');
  assert.deepEqual(h.subtitles, []);
  assert.deepEqual(h.words_snapshot.map((w) => w.text), ['你好', '世界']);
  assert.ok(Array.isArray(h.snapshot), '关闭时的快照保留供历史查看');

  // 历史意见不可关闭/重新打开
  const closeH = await closeComment(pid, cid, h.version);
  assert.equal(closeH.status, 422);
  assert.match(closeH.body.error, /历史/);
  const reopenH = await reopenComment(pid, cid, h.version);
  assert.equal(reopenH.status, 422);

  // 旧代次版本创建 → 409；新代次可正常创建
  const staleImport = await createComment(pid, {
    import_version: 1, sub_version: reimport.body.sub_version, word_start: 0, word_end: 0, text: 'x',
  });
  assert.equal(staleImport.status, 409);
  await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: reimport.body.sub_version });
  const cur = (await api(`/api/projects/${pid}`)).body;
  const fresh = await createComment(pid, {
    import_version: cur.import_version, sub_version: cur.sub_version,
    word_start: 0, word_end: 1, text: '新代次意见',
  });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  assert.equal(fresh.body.comment.import_version, 2);
  assert.deepEqual(fresh.body.comment.words.map((w) => w.text), ['全新', '内容']);
  assert.equal(fresh.body.comment.subtitles.length, 1);
});

// ---------- 既有导出快照不受影响 ----------

test('意见操作不影响既有导出快照与导出流程', async () => {
  const { pid } = await setupProject();
  const exp = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: 1 });
  assert.equal(exp.status, 201);
  const contentV1 = exp.body.content;

  // 创建 → 关闭 → 文本变更转待复核 → 重新打开，全程不碰字幕
  const r = await createComment(pid, {
    import_version: 1, sub_version: 1, word_start: 0, word_end: 1, text: '导出兼容',
  });
  const cid = r.body.comment.id;
  await closeComment(pid, cid, 1);
  const proj = (await api(`/api/projects/${pid}`)).body;
  await api(`/api/projects/${pid}/subtitles/${proj.subtitles[0].id}`, 'PATCH', {
    version: proj.subtitles[0].version, text: '你好世界呀',
  });
  const view = await listComments(pid);
  assert.equal(view.body.comments[0].status, 'review');
  await reopenComment(pid, cid, view.body.comments[0].version);

  // 旧导出快照内容不变；新导出照常生成
  const dl = await api(`/api/projects/${pid}/exports/1`);
  assert.equal(dl.status, 200);
  assert.equal(dl.body, contentV1);
  const cur = (await api(`/api/projects/${pid}`)).body;
  const exp2 = await api(`/api/projects/${pid}/exports`, 'POST', { sub_version: cur.sub_version });
  assert.equal(exp2.status, 201);
  assert.equal(exp2.body.version, 2);
});
