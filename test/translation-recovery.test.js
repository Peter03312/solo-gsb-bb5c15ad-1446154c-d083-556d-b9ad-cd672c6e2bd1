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

// 紧凑 2 字词时间轴：单词行时长约 1s（1–2 字译文 cps 合规），合并行 2.5s（长译文也合规）。
// 切点 1500 把词 0/1 与词 2/3 分开。
const WORDS = [
  { text: '你好', start_ms: 0, end_ms: 900 },
  { text: '世界', start_ms: 950, end_ms: 1400 },
  { text: '欢迎', start_ms: 1600, end_ms: 2400 },
  { text: '光临', start_ms: 2450, end_ms: 3300 },
];
const CUTS = [1500];
const FINE_RULES = { max_chars: 2, min_duration_ms: 200, max_cps: 5 };
const WIDE_RULES = { max_chars: 40, min_duration_ms: 200, max_cps: 40 };

async function createProject(name, rules = FINE_RULES, words = WORDS, cuts = CUTS) {
  const created = await api('/api/projects', 'POST', { name, words, cuts, rules });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

async function layout(pid, subVersion) {
  const r = await api(`/api/projects/${pid}/layout`, 'POST', { sub_version: subVersion });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function putRules(pid, version, rules) {
  const r = await api(`/api/projects/${pid}/rules`, 'PUT', { version, ...rules });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function saveEn(pid, sid, text, cueVersion) {
  const r = await api(`/api/projects/${pid}/translations/en/subtitles/${sid}`,
    'PUT', { text, cue_version: cueVersion });
  return r;
}

/**
 * 可恢复场景：细分规则排版 → 4 条单词行 → 给前两行存译文 → 放宽规则重排
 * （细分行被合并删除，译文留历史，同导入代次）→ 再次收紧重排，重新出现
 * 同词区间同文本的缺译行。规则版本序列：建项 v1（细）→ v2（宽）→ v3（细），
 * sub_version 序列：排版 1 → 排版 2 → 排版 3（建项时为 0）。
 */
async function setupRecoverable() {
  const proj = await createProject('可恢复场景');
  const pid = proj.id;
  const fine = (await layout(pid, 0)).subtitles;
  assert.equal(fine.length, 4);
  const t0 = await saveEn(pid, fine[0].id, 'AB', fine[0].version);
  assert.equal(t0.status, 201, JSON.stringify(t0.body));
  const t1 = await saveEn(pid, fine[1].id, 'CD', fine[1].version);
  assert.equal(t1.status, 201, JSON.stringify(t1.body));

  await putRules(pid, 1, WIDE_RULES);
  const wide = (await layout(pid, 1)).subtitles;
  assert.ok(wide.length < fine.length, '放宽规则应合并删除细分行');

  await putRules(pid, 2, FINE_RULES);
  const fineAgain = (await layout(pid, 2)).subtitles;
  assert.equal(fineAgain.length, 4);
  return { pid, fine, fineAgain };
}

test('候选查询：缺译行列出空候选与导入代次；已有译文的行不出现', async () => {
  const proj = await createProject('空候选');
  await layout(proj.id, 0);
  const cand = await api(`/api/projects/${proj.id}/translations/en/recovery-candidates`);
  assert.equal(cand.status, 200);
  assert.equal(cand.body.import_version, 1);
  assert.equal(cand.body.sub_version, 1);
  assert.equal(cand.body.rules_version, 1);
  assert.equal(cand.body.targets.length, 4);
  for (const t of cand.body.targets) {
    assert.equal(t.candidates.length, 0);
    assert.equal(t.has_recoverable, false);
  }

  // 给一行存译文后，该行从候选 targets 消失
  const first = cand.body.targets[0].cue;
  const saved = await saveEn(proj.id, first.id, 'AB', first.version);
  assert.equal(saved.status, 201);
  const cand2 = await api(`/api/projects/${proj.id}/translations/en/recovery-candidates`);
  assert.equal(cand2.body.targets.length, 3);
  assert.ok(!cand2.body.targets.some((t) => t.cue.id === first.id));
});

test('非法语言代号 → 400', async () => {
  const r = await api('/api/projects/1/translations/en US/recovery-candidates');
  assert.equal(r.status, 400);
});

test('同代次重排：候选附三要素匹配依据，可恢复候选恢复为 v1 current 且历史保留', async () => {
  const { pid, fine, fineAgain } = await setupRecoverable();
  const first = fineAgain[0];
  assert.deepEqual([first.word_start, first.word_end], [fine[0].word_start, fine[0].word_end]);
  assert.equal(first.text, fine[0].text);

  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  assert.equal(cand.status, 200);
  assert.ok(cand.body.recoverable_target_count >= 1);
  const target = cand.body.targets.find((t) => t.cue.id === first.id);
  assert.ok(target, '缺译行应出现在 targets');

  const choice = target.candidates.find((c) => c.translation.text === 'AB');
  assert.ok(choice, 'AB 历史候选存在');
  assert.equal(choice.recoverable, true);
  assert.deepEqual(choice.matches, { same_import: true, same_word_span: true, same_text: true });

  // 另一条历史（词区间 1–1）对第一行不可恢复，原因定位到词区间
  const other = target.candidates.find((c) => c.translation.text === 'CD');
  assert.ok(other);
  assert.equal(other.recoverable, false);
  assert.equal(other.matches.same_word_span, false);
  assert.ok(other.reasons.some((r) => r.includes('词区间')));

  // 恢复
  const ok = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [{
      subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: choice.translation.version,
    }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.restored_count, 1);
  assert.equal(ok.body.items[0].version, 1);
  assert.equal(ok.body.items[0].text, 'AB');
  assert.equal(ok.body.items[0].restored_from, choice.translation.id);

  const view = await api(`/api/projects/${pid}/translations/en`);
  const entry = view.body.entries.find((e) => e.cue.id === first.id);
  assert.equal(entry.state, 'current');
  assert.equal(entry.translation.text, 'AB');
  assert.equal(entry.translation.version, 1);
  assert.equal(entry.translation.src_import_id, 1);
  // 原历史行保留不改（恢复是新建，不是搬移）
  assert.ok(view.body.history.some((h) => h.id === choice.translation.id));
});

test('恢复：一次选择多行，其中一行候选词区间不匹配 → 409 整组不写', async () => {
  const { pid, fineAgain } = await setupRecoverable();
  const [c0, c1] = fineAgain;
  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const ch0 = cand.body.targets.find((t) => t.cue.id === c0.id)
    .candidates.find((c) => c.translation.text === 'AB');
  assert.ok(ch0.recoverable);
  // 给第二行故意选第一行的历史候选（词区间不匹配）
  const wrong = ch0.translation;

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [
      { subtitle_id: c0.id, cue_version: c0.version, translation_id: ch0.translation.id, version: ch0.translation.version },
      { subtitle_id: c1.id, cue_version: c1.version, translation_id: wrong.id, version: wrong.version },
    ],
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.items.length, 1, '只返回有问题的行');
  assert.equal(r.body.items[0].subtitle_id, c1.id);
  assert.equal(r.body.items[0].state, 'candidate_mismatch');
  assert.ok(r.body.items[0].reasons.some((x) => x.includes('词区间')));

  // 整组未写：第一行仍缺译
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries.find((e) => e.cue.id === c0.id).state, 'missing');
  assert.equal(view.body.entries.find((e) => e.cue.id === c1.id).state, 'missing');
});

test('恢复：形状非法（空组/重复行/缺字段）→ 400', async () => {
  const { pid, fineAgain } = await setupRecoverable();
  const first = fineAgain[0];
  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const ch = cand.body.targets[0].candidates.find((c) => c.recoverable);

  const empty = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version, items: [],
  });
  assert.equal(empty.status, 400);

  const dup = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [
      { subtitle_id: first.id, cue_version: first.version, translation_id: ch.translation.id, version: ch.translation.version },
      { subtitle_id: first.id, cue_version: first.version, translation_id: ch.translation.id, version: ch.translation.version },
    ],
  });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.errors.join('；').includes('重复'));

  const missingFields = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [{ subtitle_id: first.id, cue_version: first.version }],
  });
  assert.equal(missingFields.status, 400);

  const badVersion = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    rules_version: cand.body.rules_version,
    items: [{ subtitle_id: first.id, cue_version: first.version, translation_id: ch.translation.id, version: 1 }],
  });
  assert.equal(badVersion.status, 400);
});

test('恢复：目标行已被他人补译（不再缺译）→ not_missing 409，不覆盖且整组不写', async () => {
  const { pid, fineAgain } = await setupRecoverable();
  const first = fineAgain[0];
  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const choice = cand.body.targets.find((t) => t.cue.id === first.id)
    .candidates.find((c) => c.translation.text === 'AB');

  const manual = await saveEn(pid, first.id, 'ZZ', first.version);
  assert.equal(manual.status, 201);

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [{
      subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: choice.translation.version,
    }],
  });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.items[0].state, 'not_missing');
  assert.equal(r.body.items[0].current.text, 'ZZ');

  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries.find((e) => e.cue.id === first.id).translation.text, 'ZZ');
});

test('恢复：cue_version 过期 / 候选译文版本不一致 / 目标行消失 → 409', async () => {
  const { pid, fineAgain } = await setupRecoverable();
  const first = fineAgain[0];
  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const choice = cand.body.targets.find((t) => t.cue.id === first.id)
    .candidates.find((c) => c.translation.text === 'AB');
  const sv = cand.body.sub_version;
  const rv = cand.body.rules_version;

  const staleCue = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: sv, rules_version: rv,
    items: [{ subtitle_id: first.id, cue_version: 999,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(staleCue.status, 409);
  assert.equal(staleCue.body.items[0].state, 'cue_version_stale');

  const staleVer = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: sv, rules_version: rv,
    items: [{ subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: 999 }],
  });
  assert.equal(staleVer.status, 409);
  assert.equal(staleVer.body.items[0].state, 'candidate_version_stale');

  const ghostCue = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: sv, rules_version: rv,
    items: [{ subtitle_id: 999999, cue_version: 1,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(ghostCue.status, 409);
  assert.equal(ghostCue.body.items[0].state, 'cue_missing');
});

test('恢复：sub_version / rules_version 漂移 → 409 带当前值', async () => {
  const { pid, fineAgain } = await setupRecoverable();
  const first = fineAgain[0];
  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const choice = cand.body.targets[0].candidates.find((c) => c.recoverable);

  const staleSub = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version - 1, rules_version: cand.body.rules_version,
    items: [{ subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(staleSub.status, 409);
  assert.equal(staleSub.body.sub_version_stale, true);
  assert.equal(staleSub.body.current.sub_version, cand.body.sub_version);

  const staleRules = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version - 1,
    items: [{ subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(staleRules.status, 409);
  assert.equal(staleRules.body.rules_version_stale, true);
});

test('恢复：候选译文超现行 max_chars/max_cps → 422 整组不写', async () => {
  // 保存阶段细分规则允许 3 字（单词行仍逐词分段），存 3 字译文；
  // 经“放宽合并删除 → 收紧重排”让该行留历史并重新出现同词区间同文本缺译行；
  // 恢复阶段规则为 max_chars=2（原文“你好”2 字合规、细分不变），候选 3 字超长 → invalid。
  const saveRules = { max_chars: 3, min_duration_ms: 200, max_cps: 40 };
  const tightRules = { max_chars: 2, min_duration_ms: 200, max_cps: 40 };
  const proj = await createProject('规则违规', saveRules);
  const pid = proj.id;
  const first = (await layout(pid, 0)).subtitles[0];
  assert.deepEqual([first.word_start, first.word_end], [0, 0]);
  const saved = await saveEn(pid, first.id, 'ABC', first.version);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));

  // 放宽合并：细分行被删除 → 译文留历史（同代次）
  await putRules(pid, 1, WIDE_RULES);
  const wide = (await layout(pid, 1)).subtitles;
  assert.ok(wide.length < 4);
  // 收紧字数重排：同词区间同文本新行（新 ID、缺译）
  await putRules(pid, 2, tightRules);
  const tight = (await layout(pid, 2)).subtitles;
  const target0 = tight.find((c) => c.word_start === 0 && c.word_end === 0);
  assert.ok(target0);

  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const target = cand.body.targets.find((t) => t.cue.id === target0.id);
  assert.ok(target);
  const choice = target.candidates.find((c) =>
    c.recoverable && c.translation.text === 'ABC');
  assert.ok(choice, '三要素仍匹配（同代次/同词区间/同源文），仅规则收紧');

  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [{ subtitle_id: target.cue.id, cue_version: target.cue.version,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.items[0].state, 'invalid');
  assert.ok(r.body.items[0].reasons.some((x) => x.includes('最大字数')));
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries.find((e) => e.cue.id === target0.id).state, 'missing');
});

test('恢复成功后：普通 current 译文可继续 PUT；不推进 sub_version；历史不被消费', async () => {
  const { pid, fineAgain } = await setupRecoverable();
  const first = fineAgain[0];
  const proj = await api(`/api/projects/${pid}`, 'GET');
  const svBefore = proj.body.sub_version;

  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const choice = cand.body.targets.find((t) => t.cue.id === first.id)
    .candidates.find((c) => c.translation.text === 'AB');
  const ok = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [{ subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.sub_version, svBefore, '恢复不推进字幕集版本');

  const upd = await api(`/api/projects/${pid}/translations/en/subtitles/${first.id}`,
    'PUT', { text: 'XY', cue_version: first.version, version: 1 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.translation.version, 2);

  // 语言总览计数正确
  const overview = await api(`/api/projects/${pid}/translations`);
  const en = overview.body.languages.find((l) => l.lang === 'en');
  assert.equal(en.current_count, 1);

  // 历史行仍在（未删除、未改），可再次用于另一同词区间缺译行（这里仅验证仍存在）
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.ok(view.body.history.some((h) => h.id === choice.translation.id && h.text === 'AB'));
});

test('重新导入：导入代次 +1，旧历史可见但 same_import=false、不可恢复', async () => {
  const proj = await createProject('重新导入场景', WIDE_RULES);
  const pid = proj.id;
  const wide1 = (await layout(pid, 0)).subtitles;
  assert.equal(wide1.length, 2);
  await saveEn(pid, wide1[0].id, 'HELLO', wide1[0].version);
  await saveEn(pid, wide1[1].id, 'WELCOME', wide1[1].version);

  // 相同词/切点重新导入（force）：旧行删除→译文留历史，代次 +1；重新排版生成相同新行
  const reimport = await api(`/api/projects/${pid}/import`, 'POST', {
    force: true, words: WORDS, cuts: CUTS,
  });
  assert.equal(reimport.status, 200);
  assert.equal(reimport.body.import_version, 2);

  const wide2 = (await layout(pid, reimport.body.sub_version)).subtitles;
  assert.equal(wide2.length, 2);
  assert.equal(wide2[0].text, wide1[0].text);
  assert.deepEqual([wide2[0].word_start, wide2[0].word_end],
    [wide1[0].word_start, wide1[0].word_end]);

  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  assert.equal(cand.body.import_version, 2);
  assert.equal(cand.body.recoverable_target_count, 0);
  const target = cand.body.targets.find((t) => t.cue.id === wide2[0].id);
  assert.ok(target.candidates.length >= 1, '旧代次历史仍列出供查看');
  for (const c of target.candidates) {
    assert.equal(c.recoverable, false);
    assert.equal(c.matches.same_import, false);
    assert.ok(c.reasons.some((r) => r.includes('导入代次')));
  }
  // 词区间与源文其实一致，但代次不一致：matches 里这两项为 true
  const old = target.candidates.find((c) => c.translation.text === 'HELLO');
  assert.equal(old.matches.same_word_span, true);
  assert.equal(old.matches.same_text, true);

  // 强行提交 → 409 candidate_mismatch，整组不写
  const r = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [{ subtitle_id: wide2[0].id, cue_version: wide2[0].version,
      translation_id: old.translation.id, version: old.translation.version }],
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.items[0].state, 'candidate_mismatch');
  const view = await api(`/api/projects/${pid}/translations/en`);
  assert.equal(view.body.entries.find((e) => e.cue.id === wide2[0].id).state, 'missing');
  assert.ok(view.body.history.some((h) => h.id === old.translation.id));
});

test('恢复：候选不存在/跨语言/不是历史 → 400 按行说明', async () => {
  const { pid, fineAgain } = await setupRecoverable();
  const first = fineAgain[0];
  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const choice = cand.body.targets[0].candidates.find((c) => c.recoverable);
  const sv = cand.body.sub_version;
  const rv = cand.body.rules_version;

  const ghost = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: sv, rules_version: rv,
    items: [{ subtitle_id: first.id, cue_version: first.version, translation_id: 999999, version: 1 }],
  });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.items[0].state, 'candidate_missing');

  const wrongLang = await api(`/api/projects/${pid}/translations/ja/recover`, 'POST', {
    sub_version: sv, rules_version: rv,
    items: [{ subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(wrongLang.status, 400);
  assert.equal(wrongLang.body.items[0].state, 'candidate_wrong_lang');

  // 先恢复成功，再拿新 current 译文当候选 → candidate_not_history
  const ok = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: sv, rules_version: rv,
    items: [{ subtitle_id: first.id, cue_version: first.version,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const newId = ok.body.items[0].translation_id;
  const notHist = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: sv, rules_version: rv,
    items: [{ subtitle_id: fineAgain[1].id, cue_version: fineAgain[1].version,
      translation_id: newId, version: 1 }],
  });
  assert.equal(notHist.status, 400);
  assert.equal(notHist.body.items[0].state, 'candidate_not_history');
});

test('恢复：术语缺失在恢复响应与译文视图提示，并继续阻止导出', async () => {
  // 细分（允许 3 字）下在词 0–0 行保存缺术语译文 → 放宽合并删除（历史）→ 再细分出现
  // 同词区间缺译行 → 恢复成功但 term_issues 仍提示，导出闸门继续拦截。
  const saveRules = { max_chars: 3, min_duration_ms: 200, max_cps: 40 };
  const proj = await createProject('术语+恢复', saveRules);
  const pid = proj.id;
  const first = (await layout(pid, 0)).subtitles[0];
  assert.deepEqual([first.word_start, first.word_end], [0, 0]);
  // 术语：你好 → Hello；保存不含规定译法的译文（允许保存）
  const g = await api(`/api/projects/${pid}/glossaries/en`, 'PUT', {
    version: 0, terms: [{ source: '你好', target: 'Hi' }],
  });
  assert.equal(g.status, 200);
  const saved = await saveEn(pid, first.id, 'Bye', first.version);
  assert.equal(saved.status, 201);
  assert.ok(saved.body.term_issues.length >= 1);

  // 放宽合并删除 → 收紧重排重新出现同词区间同文本缺译行（译文留历史，同代次）
  await putRules(pid, 1, WIDE_RULES);
  await layout(pid, 1);
  await putRules(pid, 2, saveRules);
  const fine = (await layout(pid, 2)).subtitles;
  const target0 = fine.find((c) => c.word_start === 0 && c.word_end === 0);
  assert.ok(target0);

  const cand = await api(`/api/projects/${pid}/translations/en/recovery-candidates`);
  const target = cand.body.targets.find((t) => t.cue.id === target0.id);
  assert.ok(target);
  const choice = target.candidates.find((c) =>
    c.recoverable && c.translation.text === 'Bye');
  assert.ok(choice, '存在 Bye! 的可恢复候选');
  const ok = await api(`/api/projects/${pid}/translations/en/recover`, 'POST', {
    sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
    items: [{ subtitle_id: target.cue.id, cue_version: target.cue.version,
      translation_id: choice.translation.id, version: choice.translation.version }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok(ok.body.items[0].term_issues.some((i) => i.target === 'Hi'));

  const view = await api(`/api/projects/${pid}/translations/en`);
  const entry = view.body.entries.find((e) => e.cue.id === target.cue.id);
  assert.equal(entry.state, 'current');
  assert.ok(entry.term_issues.some((i) => i.target === 'Hi'));

  // 导出仍被术语闸门拦截，不生成快照
  const blocked = await api(`/api/projects/${pid}/translations/en/exports`, 'POST', {});
  assert.equal(blocked.status, 422);
  assert.ok(blocked.body.term_missing.length >= 1);
  const exportsList = await api(`/api/projects/${pid}/translations/en/exports`);
  assert.equal(exportsList.body.length, 0);
});

test('旧库迁移：src_import_id 为 NULL 的历史译文仅供查看不可恢复', async () => {
  // 独立内存库模拟旧库迁移：历史行 src_import_id=NULL（无法确认导入归属）。
  const { initDb: initDb2 } = require('../src/db');
  const { createApp: createApp2 } = require('../src/routes');
  const db2 = initDb2(':memory:');
  const app2 = createApp2(db2);
  const server2 = app2.listen(0);
  await new Promise((r) => server2.once('listening', r));
  const b2 = `http://127.0.0.1:${server2.address().port}`;
  async function api2(path, method = 'GET', body) {
    const res = await fetch(b2 + path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  try {
    const created = await api2('/api/projects', 'POST', {
      name: '旧库', words: WORDS, cuts: CUTS, rules: WIDE_RULES,
    });
    const pid2 = created.body.id;
    const wide = (await api2(`/api/projects/${pid2}/layout`, 'POST', { sub_version: 0 })).body.subtitles;
    const cue = wide[0];
    const saved = await saveEn2(api2, pid2, cue.id, 'LEGACY', cue.version);
    assert.equal(saved.status, 201);
    const tid = saved.body.translation.id;

    // 模拟旧库迁移后的历史：subtitle_id 置空、status=history、src_import_id=NULL
    db2.prepare(
      `UPDATE translations SET status='history', subtitle_id=NULL, src_import_id=NULL WHERE id=?`
    ).run(tid);
    // 构造一条同词区间同文本的缺译行（把当前合并行删掉后重排同参数即同区间新行）
    db2.prepare('DELETE FROM subtitles WHERE project_id=?').run(pid2);
    db2.prepare('UPDATE projects SET sub_version=sub_version+1 WHERE id=?').run(pid2);
    const re = await api2(`/api/projects/${pid2}`, 'GET');
    const relaid = (await api2(`/api/projects/${pid2}/layout`, 'POST', {
      sub_version: re.body.sub_version,
    })).body.subtitles;
    const targetCue = relaid.find((c) =>
      c.word_start === cue.word_start && c.word_end === cue.word_end && c.text === cue.text);
    assert.ok(targetCue, '存在同词区间同文本缺译行');

    const cand = await api2(`/api/projects/${pid2}/translations/en/recovery-candidates`);
    const target = cand.body.targets.find((t) => t.cue.id === targetCue.id);
    assert.ok(target);
    const legacy = target.candidates.find((c) => c.translation.id === tid);
    assert.ok(legacy, 'NULL 归属历史仍列出供查看');
    assert.equal(legacy.recoverable, false);
    assert.equal(legacy.matches.same_import, false);
    assert.ok(legacy.reasons.some((x) => x.includes('无法确认')));

    // 强行恢复 → 409 candidate_mismatch，整组不写
    const r = await api2(`/api/projects/${pid2}/translations/en/recover`, 'POST', {
      sub_version: cand.body.sub_version, rules_version: cand.body.rules_version,
      items: [{ subtitle_id: targetCue.id, cue_version: targetCue.version,
        translation_id: tid, version: legacy.translation.version }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.items[0].state, 'candidate_mismatch');
  } finally {
    server2.close();
  }
});

async function saveEn2(apiFn, pid, sid, text, cueVersion) {
  return apiFn(`/api/projects/${pid}/translations/en/subtitles/${sid}`,
    'PUT', { text, cue_version: cueVersion });
}

test('matchHistory 纯函数：NULL 归属 / 旧代次 / 词区间 / 文本 四类不可恢复原因', async () => {
  // 通过模块直接单测（无需 HTTP）
  const { matchHistory } = require('../src/translation-recovery');
  const cue = { word_start: 0, word_end: 1, text: '你好世界' };
  const base = { src_import_id: 1, src_word_start: 0, src_word_end: 1, src_text: '你好世界' };
  assert.equal(matchHistory(cue, base, 1).recoverable, true);
  assert.equal(matchHistory(cue, { ...base, src_import_id: null }, 1).recoverable, false);
  assert.ok(matchHistory(cue, { ...base, src_import_id: null }, 1)
    .reasons.some((r) => r.includes('无法确认')));
  assert.equal(matchHistory(cue, { ...base, src_import_id: 2 }, 1).recoverable, false);
  assert.ok(matchHistory(cue, { ...base, src_import_id: 2 }, 1)
    .reasons.some((r) => r.includes('导入代次')));
  assert.equal(matchHistory(cue, { ...base, src_word_end: 2 }, 1).recoverable, false);
  assert.equal(matchHistory(cue, { ...base, src_text: '别的' }, 1).recoverable, false);
});
