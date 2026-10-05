'use strict';

/* 字幕校时工作台前端：项目/导入/规则/排版/锁定/导出，全部带乐观锁处理 */

const state = {
  projects: [],
  project: null,      // 当前项目完整载荷
  edits: new Map(),   // cueId -> { text, start_ms, end_ms } 未保存修改
  trLang: null,       // 当前译文语言
  trView: null,       // 该语言并列查询视图
  spView: null,       // 说话人归属并列视图（载入后存在）
  cmView: null,       // 逐词区间复核意见视图（随项目载入）
};

// ---------- 工具 ----------

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

// ---------- 数据加载 ----------

async function loadProjects(selectId) {
  const { body } = await api('/api/projects');
  state.projects = body || [];
  const sel = $('#project-select');
  sel.innerHTML = '';
  if (state.projects.length === 0) {
    sel.innerHTML = '<option value="">（无项目，请先导入）</option>';
    state.project = null;
    renderAll();
    return;
  }
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `#${p.id} ${p.name}（${p.word_count} 词 / ${p.cue_count} 字幕 / ${p.export_count} 导出）`;
    sel.appendChild(opt);
  }
  const id = selectId ?? state.projects[0].id;
  sel.value = id;
  state.trLang = null;
  state.trView = null;
  state.spView = null;
  $('#tr-panel').classList.add('hidden');
  $('#sp-panel').classList.add('hidden');
  await loadProject(Number(sel.value));
}

async function loadProject(id) {
  const { status, body } = await api(`/api/projects/${id}`);
  if (status !== 200) { toast(body?.error || '加载项目失败', true); return; }
  state.project = body;
  state.edits.clear();
  // 切换/刷新项目后重新载入当前语言视图（项目不同则收起面板）
  if (state.trLang) loadTranslation(state.trLang);
  else $('#tr-panel').classList.add('hidden');
  // 归属面板若已载入，则随字幕集刷新重新拉取（保持归属版本/行版本最新）
  if (state.spView) loadSpeakers(true);
  // 复核意见随字幕集刷新（重排/编辑/词修正后相交字幕与状态可能变化）
  loadComments();
  renderAll();
}

// ---------- 渲染 ----------

function renderAll() {
  renderRules();
  renderSubtitles();
  renderExports();
  renderRevisions();
  renderWordRevisions();
  renderSpeakerVersionTag();
  $('#force-row').classList.add('hidden');
}

function renderRules() {
  const p = state.project;
  $('#rules-version').textContent = p?.rules ? `v${p.rules.version}` : '';
  $('#rule-max-chars').value = p?.rules?.max_chars ?? '';
  $('#rule-min-duration').value = p?.rules?.min_duration_ms ?? '';
  $('#rule-max-cps').value = p?.rules?.max_cps ?? '';
}

function renderSubtitles() {
  const p = state.project;
  const box = $('#cue-table');
  box.innerHTML = '';
  $('#sub-version').textContent = p ? `字幕集 v${p.sub_version}` : '';
  if (!p || p.subtitles.length === 0) {
    box.innerHTML = '<div class="empty">暂无字幕：导入转写后点击「重新排版」。</div>';
    $('#cue-stats').textContent = p ? `（${p.words.length} 词 / ${p.cuts.length} 切点）` : '';
    return;
  }
  const maxChars = p.rules.max_chars;
  $('#cue-stats').textContent =
    `（${p.subtitles.length} 条，其中锁定 ${p.subtitles.filter((s) => s.locked).length} 条）`;

  p.subtitles.forEach((cue) => {
    const row = document.createElement('div');
    row.className = 'cue-row' + (cue.locked ? ' locked' : '');
    row.dataset.id = cue.id;

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.innerHTML = `${cue.idx + 1}<div class="word-ref">词${cue.word_start}–${cue.word_end} · v${cue.version}</div>`;

    const startInput = document.createElement('input');
    startInput.type = 'number'; startInput.min = '0'; startInput.value = cue.start_ms;
    startInput.title = `开始 ms（${fmtMs(cue.start_ms)}）`;
    const endInput = document.createElement('input');
    endInput.type = 'number'; endInput.min = '0'; endInput.value = cue.end_ms;
    endInput.title = `结束 ms（${fmtMs(cue.end_ms)}）`;

    const textInput = document.createElement('input');
    textInput.type = 'text'; textInput.value = cue.text; textInput.className = 'text-input';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const updateMeta = () => {
      const len = textInput.value.length;
      const dur = Number(endInput.value) - Number(startInput.value);
      const cps = dur > 0 ? (len / (dur / 1000)) : Infinity;
      const badLen = len > maxChars;
      const badDur = dur < p.rules.min_duration_ms;
      const badCps = cps > p.rules.max_cps;
      meta.innerHTML =
        `<span class="${badLen ? 'bad' : ''}">${len}/${maxChars} 字</span> · ` +
        `<span class="${badDur ? 'bad' : ''}">${dur}ms</span> · ` +
        `<span class="${badCps ? 'bad' : ''}">${cps.toFixed(1)}字/s</span>`;
    };
    updateMeta();

    const markDirty = () => {
      state.edits.set(cue.id, {
        text: textInput.value,
        start_ms: Number(startInput.value),
        end_ms: Number(endInput.value),
      });
      updateMeta();
    };
    textInput.addEventListener('input', markDirty);
    startInput.addEventListener('input', markDirty);
    endInput.addEventListener('input', markDirty);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'small'; saveBtn.textContent = '保存';
    saveBtn.onclick = () => saveCue(cue);
    const lockBtn = document.createElement('button');
    lockBtn.className = 'small secondary';
    lockBtn.textContent = cue.locked ? '🔒 解锁' : '🔓 锁定';
    lockBtn.title = cue.locked ? '已校对锁定，重排不会改动' : '锁定后重排不再改动此条';
    lockBtn.onclick = () => toggleLock(cue);
    ops.append(saveBtn, lockBtn);

    row.append(idx, startInput, endInput, textInput, meta, ops);
    box.appendChild(row);
  });
}

function renderExports() {
  const p = state.project;
  const ul = $('#export-list');
  ul.innerHTML = '';
  if (!p || p.exports.length === 0) {
    ul.innerHTML = '<li class="empty">尚无导出版本</li>';
    return;
  }
  for (const e of p.exports) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/api/projects/${p.id}/exports/${e.version}`;
    a.textContent = `⬇ v${e.version}.vtt`;
    a.download = `project-${p.id}-v${e.version}.vtt`;
    const info = document.createElement('span');
    info.className = 'hint';
    info.textContent = `${e.cue_count} 条 · ${e.created_at}`;
    li.append(a, info);
    ul.appendChild(li);
  }
}

// ---------- 批量修订提议 ----------

function renderRevisions() {
  const p = state.project;
  const box = $('#rev-list');
  box.innerHTML = '';
  $('#rev-detail-panel').classList.add('hidden');
  if (!p) return;
  const list = p.revisions || [];
  const pending = list.filter((r) => r.status === 'pending').length;
  $('#rev-stats').textContent = `（共 ${list.length} 组，待采纳 ${pending} 组）`;
  if (list.length === 0) {
    box.innerHTML = '<div class="empty">尚无修订提议。校对时可在左下角按 JSON 提交一组。</div>';
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'rev-head' + (r.status === 'accepted' ? ' accepted' : '');
    const title = document.createElement('div');
    title.className = 'rev-title';
    const note = r.note ? ` · ${escapeHtml(r.note)}` : '';
    title.innerHTML =
      `提议 #${r.id}${note}<div class="rev-note">` +
      `${r.item_count} 项 · 规则 v${r.rules_version_snapshot} · 字幕集 v${r.sub_version_snapshot} · ${r.created_at}` +
      (r.accepted_sub_version ? ` · 采纳于字幕集 v${r.accepted_sub_version}` : '') +
      '</div>';
    const tag = document.createElement('span');
    tag.className = 'status-tag' + (r.status === 'accepted' ? ' accepted' : '');
    tag.textContent = r.status === 'accepted' ? '✓ 已采纳' : '待采纳';
    const btn = document.createElement('button');
    btn.className = 'small secondary';
    btn.textContent = '查看/预览';
    btn.onclick = () => openRevision(r.id);
    row.append(title, tag, btn);
    box.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function revLine(label, value, cls) {
  const line = document.createElement('div');
  line.className = 'rev-line' + (cls ? ` ${cls}` : '');
  const k = document.createElement('span');
  k.className = 'k'; k.textContent = label;
  const v = document.createElement('span');
  v.className = 'v'; v.textContent = value;
  line.append(k, v);
  return line;
}

function renderRevItem(it) {
  const div = document.createElement('div');
  const hasProblems = it.state !== 'ok' || it.conflicts.length > 0;
  div.className = 'rev-item' + (hasProblems ? ' bad' : '');

  const head = document.createElement('div');
  head.className = 'rev-line';
  head.innerHTML =
    `<span class="k">第 ${it.ord + 1} 项</span>` +
    `<span class="v">字幕 #${it.subtitle_id}（读取版本 v${it.cue_version}）` +
    `<span class="state ${it.state === 'ok' ? 'ok' : ''}">${
      it.state === 'ok' ? '✓ 可采纳' :
      it.state === 'stale' ? '⚠ 行版本过期' :
      it.state === 'locked' ? '🔒 已锁定' : '✗ 已不存在'
    }</span></span>`;
  div.appendChild(head);

  div.appendChild(revLine('原值', `"${it.orig.text}" [${it.orig.start_ms}, ${it.orig.end_ms}]`));
  if (it.cue) {
    const changed = it.cue.text !== it.orig.text ||
      it.cue.start_ms !== it.orig.start_ms || it.cue.end_ms !== it.orig.end_ms;
    div.appendChild(revLine('当前值', `"${it.cue.text}" [${it.cue.start_ms}, ${it.cue.end_ms}]`,
      changed ? 'current' : ''));
  }
  div.appendChild(revLine('建议值', `"${it.proposed.text}" [${it.proposed.start_ms}, ${it.proposed.end_ms}]`,
    'proposed'));

  if (it.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of it.conflicts) {
      const li = document.createElement('li');
      li.textContent = '• ' + c.message;
      ul.appendChild(li);
    }
    div.appendChild(ul);
  }
  return div;
}

async function openRevision(rid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/revisions/${rid}/preview`, { method: 'POST' });
  if (status !== 200) return toast(body?.error || '预览失败', true);
  const { revision, evaluation } = body;
  const panel = $('#rev-detail-panel');
  const box = $('#rev-detail-body');
  box.innerHTML = '';
  $('#rev-detail-title').textContent =
    `提议 #${revision.id}（${revision.status === 'accepted' ? '✓ 已采纳' : '待采纳'}）${
      revision.note ? '：' + escapeHtml(revision.note) : ''
    }`;

  if (evaluation.already_accepted) {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `该提议已采纳（字幕集推进到 v${revision.accepted_sub_version}），重复提交不再改动字幕；以下为历史快照。`;
    box.appendChild(info);
  }

  const itemsBox = document.createElement('div');
  itemsBox.className = 'rev-items';
  for (const it of evaluation.items) itemsBox.appendChild(renderRevItem(it));
  box.appendChild(itemsBox);

  if (evaluation.conflicts && evaluation.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of evaluation.conflicts) {
      const li = document.createElement('li');
      li.textContent = `整版：词 ${c.word_start}${c.word_end !== c.word_start ? '–' + c.word_end : ''} ${c.message}`;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  if (revision.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'rev-actions';
    const verdict = document.createElement('span');
    verdict.className = 'hint';
    verdict.style.flex = '1';
    verdict.textContent = evaluation.ok
      ? `✓ 整组核对通过（当前规则 v${p.rules.version}），可整组采纳（原子写入）`
      : '✗ 存在冲突或过期项，采纳将被整组拒绝';
    verdict.style.color = evaluation.ok ? 'var(--ok)' : 'var(--danger)';
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = '整组采纳';
    acceptBtn.disabled = !evaluation.ok;
    acceptBtn.style.opacity = evaluation.ok ? 1 : 0.5;
    acceptBtn.onclick = () => acceptRevision(rid);
    actions.append(verdict, acceptBtn);
    box.appendChild(actions);
  }
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitRevision() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  let parsed;
  try {
    parsed = JSON.parse($('#rev-json').value || '{}');
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  const payload = { note: $('#rev-note').value.trim(), ...parsed };
  const { status, body } = await api(`/api/projects/${p.id}/revisions`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (status === 201) {
    toast(`提议 #${body.id} 已保存（${body.items.length} 项），未改动正式字幕，请预览核对`);
    await loadProject(p.id);
    openRevision(body.id);
  } else if (status === 400) {
    toast('请求非法：' + (body.errors || []).join('；'), true);
  } else if (status === 422) {
    toast('目标状态校验失败：' + (body.errors || []).join('；'), true);
  } else {
    toast(body?.error || '提交失败', true);
  }
}

async function acceptRevision(rid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/revisions/${rid}/accept`, { method: 'POST' });
  if (status === 200) {
    toast(`✓ 提议 #${rid} 已整组采纳（${body.applied} 项，字幕集 v${body.sub_version}）`);
    await loadProject(p.id);
    openRevision(rid);
  } else if (status === 409 || status === 422) {
    const itemReasons = (body.items || [])
      .map((i) => `#${i.subtitle_id}: ${(i.reasons || []).map((r) => r.message).join('；')}`);
    const groupReasons = (body.conflicts || []).map((c) => c.message);
    toast((body.error || '采纳失败') +
      (itemReasons.length || groupReasons.length ? '：' + [...itemReasons, ...groupReasons].join('｜') : ''), true);
    await loadProject(p.id);
    openRevision(rid);
  } else {
    toast(body?.error || '采纳失败', true);
  }
}

function fillRevisionTemplate() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const items = p.subtitles.filter((s) => !s.locked).map((s) => ({
    subtitle_id: s.id, cue_version: s.version, text: s.text,
    start_ms: s.start_ms, end_ms: s.end_ms,
  }));
  $('#rev-json').value = JSON.stringify({ items }, null, 2);
  toast('已填入全部未锁定行（按需删除/修改；时间字段可整段省略）');
}

// ---------- 逐词时间修正提议 ----------

function renderWordRevisions() {
  const p = state.project;
  const box = $('#wr-list');
  box.innerHTML = '';
  $('#wr-detail-panel').classList.add('hidden');
  if (!p) return;
  const list = p.word_revisions || [];
  const pending = list.filter((r) => r.status === 'pending').length;
  $('#wr-stats').textContent = `（共 ${list.length} 组，待确认 ${pending} 组）`;
  if (list.length === 0) {
    box.innerHTML = '<div class="empty">尚无逐词修正提议。校对发现词时间偏差时，可在左下角⑥按词序号提交。</div>';
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'rev-head' + (r.status === 'confirmed' ? ' accepted' : '');
    const title = document.createElement('div');
    title.className = 'rev-title';
    const note = r.note ? ` · ${escapeHtml(r.note)}` : '';
    title.innerHTML =
      `词修正 #${r.id}${note}<div class="rev-note">` +
      `${r.item_count} 词 · 基于字幕集 v${r.sub_version_snapshot} · ${r.created_at}` +
      (r.confirmed_sub_version ? ` · 确认于字幕集 v${r.confirmed_sub_version}` : '') +
      '</div>';
    const tag = document.createElement('span');
    tag.className = 'status-tag' + (r.status === 'confirmed' ? ' accepted' : '');
    tag.textContent = r.status === 'confirmed' ? '✓ 已确认' : '待确认';
    const btn = document.createElement('button');
    btn.className = 'small secondary';
    btn.textContent = '查看/预览';
    btn.onclick = () => openWordRevision(r.id);
    row.append(title, tag, btn);
    box.appendChild(row);
  }
}

function renderWrItem(it) {
  const div = document.createElement('div');
  const hasProblems = it.state !== 'ok' || it.conflicts.length > 0;
  div.className = 'rev-item' + (hasProblems ? ' bad' : '');

  const head = document.createElement('div');
  head.className = 'rev-line';
  const text = it.word_text ? ` "${escapeHtml(it.word_text)}"` : '';
  head.innerHTML =
    `<span class="k">第 ${it.ord + 1} 项</span>` +
    `<span class="v">词 #${it.word_idx}${text}` +
    `<span class="state ${it.state === 'ok' ? 'ok' : ''}">${
      it.state === 'ok' ? '✓ 可应用' :
      it.state === 'drifted' ? '⚠ 词时间已变动' : '✗ 词已不存在'
    }</span></span>`;
  div.appendChild(head);

  div.appendChild(revLine('原值', `[${it.orig.start_ms}, ${it.orig.end_ms}]`));
  if (it.current) {
    const changed = it.current.start_ms !== it.orig.start_ms || it.current.end_ms !== it.orig.end_ms;
    div.appendChild(revLine('当前值', `[${it.current.start_ms}, ${it.current.end_ms}]`, changed ? 'current' : ''));
  }
  div.appendChild(revLine('建议值', `[${it.proposed.start_ms}, ${it.proposed.end_ms}]`, 'proposed'));

  if (it.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of it.conflicts) {
      const li = document.createElement('li');
      li.textContent = '• ' + c.message;
      ul.appendChild(li);
    }
    div.appendChild(ul);
  }
  return div;
}

function renderWRCandidate(candidate) {
  const wrap = document.createElement('div');
  wrap.className = 'wr-candidate';
  const title = document.createElement('p');
  title.className = 'hint';
  title.textContent = '候选整版预览（确认后生效）：';
  wrap.appendChild(title);
  const table = document.createElement('div');
  table.className = 'cue-table';
  for (const c of candidate) {
    const row = document.createElement('div');
    row.className = 'cue-row wr-cue-' + c.origin + (c.locked ? ' locked' : '');
    row.innerHTML =
      `<div class="idx">词${c.word_start}–${c.word_end}</div>` +
      `<div>${c.start_ms}</div><div>${c.end_ms}</div>` +
      `<input class="text-input" value="${escapeHtml(c.text)}" readonly>` +
      `<div class="meta">${c.origin === 'kept'
        ? `保留 #${c.id} v${c.version}${c.locked ? ' 🔒' : ''}`
        : '重排新行（新 ID）'}</div><div></div>`;
    table.appendChild(row);
  }
  wrap.appendChild(table);
  return wrap;
}

async function openWordRevision(wrid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/word-revisions/${wrid}/preview`, { method: 'POST' });
  if (status !== 200) return toast(body?.error || '预览失败', true);
  const { revision, evaluation } = body;
  const panel = $('#wr-detail-panel');
  const box = $('#wr-detail-body');
  box.innerHTML = '';
  $('#wr-detail-title').textContent =
    `词修正 #${revision.id}（${revision.status === 'confirmed' ? '✓ 已确认' : '待确认'}）${
      revision.note ? '：' + escapeHtml(revision.note) : ''
    }`;

  if (evaluation.already_confirmed) {
    const info = document.createElement('p');
    info.className = 'hint';
    info.textContent = `该修正已确认（字幕集推进到 v${revision.confirmed_sub_version}），重复提交不再改动词与字幕；以下为历史快照。`;
    box.appendChild(info);
  }

  // 受影响字幕摘要
  if (revision.status === 'pending') {
    const sum = document.createElement('p');
    sum.className = 'hint';
    const rep = evaluation.replaced || [];
    const lk = evaluation.affected_locked || [];
    sum.innerHTML =
      `将重排 <strong>${rep.length}</strong> 条受影响未锁定字幕` +
      (rep.length ? `：${rep.map((s) => `#${s.id}`).join('、')}` : '') +
      `；含修正词的锁定字幕 <strong>${lk.length}</strong> 条` +
      (lk.length ? `：${lk.map((s) => `#${s.id}`).join('、')}（文本/时间原样保留）` : '') +
      `；其余字幕保留 ID、行版本与人工文本。`;
    box.appendChild(sum);
  }

  const itemsBox = document.createElement('div');
  itemsBox.className = 'rev-items';
  for (const it of evaluation.items) itemsBox.appendChild(renderWrItem(it));
  box.appendChild(itemsBox);

  if (evaluation.subtitles && evaluation.subtitles.length > 0) {
    box.appendChild(renderWRCandidate(evaluation.subtitles));
  }

  const allReasons = [];
  if (evaluation.conflicts && evaluation.conflicts.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'rev-reasons';
    for (const c of evaluation.conflicts) {
      const li = document.createElement('li');
      const range = c.word_start !== undefined
        ? `词 ${c.word_start}${c.word_end !== undefined && c.word_end !== c.word_start ? '–' + c.word_end : ''} `
        : '';
      li.textContent = `整版：${range}${c.message}`;
      ul.appendChild(li);
      allReasons.push(c.message);
    }
    box.appendChild(ul);
  }

  if (revision.status === 'pending') {
    const actions = document.createElement('div');
    actions.className = 'rev-actions';
    const verdict = document.createElement('span');
    verdict.className = 'hint';
    verdict.style.flex = '1';
    if (evaluation.stale) {
      verdict.textContent = '✗ 字幕集版本已过期（提交后字幕集被修改），请刷新后重新修正';
    } else {
      verdict.textContent = evaluation.ok
        ? '✓ 核对通过：确认后原子更新词时间、重排受影响区间并推进字幕集版本'
        : '✗ 存在冲突或失效项，确认将被整组拒绝（词与字幕均不变）';
    }
    verdict.style.color = evaluation.ok ? 'var(--ok)' : 'var(--danger)';
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '确认修正';
    confirmBtn.disabled = !evaluation.ok;
    confirmBtn.style.opacity = evaluation.ok ? 1 : 0.5;
    confirmBtn.onclick = () => confirmWordRevision(wrid);
    actions.append(verdict, confirmBtn);
    box.appendChild(actions);
  }
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function submitWordRevision() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  let parsed;
  try {
    parsed = JSON.parse($('#wr-json').value || '{}');
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  const payload = { note: $('#wr-note').value.trim(), ...parsed };
  if (parsed.sub_version === undefined) payload.sub_version = p.sub_version;
  const { status, body } = await api(`/api/projects/${p.id}/word-revisions`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (status === 201) {
    toast(`词修正 #${body.id} 已保存（${body.items.length} 词），未改动正式词与字幕，请预览核对`);
    await loadProject(p.id);
    openWordRevision(body.id);
  } else if (status === 400) {
    toast('请求非法：' + (body.errors || []).join('；'), true);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    toast('词序列校验失败：' + (body.errors || []).join('；'), true);
  } else {
    toast(body?.error || '提交失败', true);
  }
}

async function confirmWordRevision(wrid) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/word-revisions/${wrid}/confirm`, { method: 'POST' });
  if (status === 200) {
    toast(`✓ 词修正 #${wrid} 已确认：更新 ${body.words_updated} 词，重排 ${body.cues_replaced} 条字幕（字幕集 v${body.sub_version}）`);
    await loadProject(p.id);
    openWordRevision(wrid);
  } else if (status === 409 || status === 422) {
    const itemReasons = (body.items || []).map((i) =>
      `词${i.word_idx}: ${(i.reasons || []).map((r) => r.message).join('；')}`);
    const groupReasons = (body.conflicts || []).map((c) => c.message);
    toast((body.error || '确认失败') +
      (itemReasons.length || groupReasons.length ? '：' + [...itemReasons, ...groupReasons].slice(0, 3).join('｜') : ''), true);
    await loadProject(p.id);
    openWordRevision(wrid);
  } else {
    toast(body?.error || '确认失败', true);
  }
}

function fillWordRevisionTemplate() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const items = p.words.map((w) => ({
    word_idx: w.idx, start_ms: w.start_ms, end_ms: w.end_ms,
  }));
  $('#wr-json').value = JSON.stringify({ sub_version: p.sub_version, items }, null, 2);
  toast('已填入全部词的当前时间（按需删改；只保留要修正的词即可）');
}

function renderConflicts(conflicts, title) {
  const panel = $('#conflict-panel');
  const ul = $('#conflict-list');
  ul.innerHTML = '';
  panel.querySelector('h2').textContent = title || '⚠ 冲突报告';
  for (const c of conflicts) {
    const li = document.createElement('li');
    const range = document.createElement('span');
    range.className = 'word-range';
    range.textContent = `词 ${c.word_start}${c.word_end !== c.word_start ? '–' + c.word_end : ''}`;
    li.append(range, document.createTextNode(c.message));
    ul.appendChild(li);
  }
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearConflicts() {
  $('#conflict-panel').classList.add('hidden');
}

// ---------- 操作 ----------

async function saveCue(cue) {
  const edit = state.edits.get(cue.id);
  const payload = { version: cue.version };
  if (edit) Object.assign(payload, edit);
  const { status, body } = await api(
    `/api/projects/${state.project.id}/subtitles/${cue.id}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    const i = state.project.subtitles.findIndex((s) => s.id === cue.id);
    state.project.subtitles[i] = body.subtitle;
    state.edits.delete(cue.id);
    renderSubtitles();
    loadComments();
    toast(`字幕 #${cue.idx + 1} 已保存（v${body.subtitle.version}）`);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前内容', true);
    await loadProject(state.project.id);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function toggleLock(cue) {
  const { status, body } = await api(
    `/api/projects/${state.project.id}/subtitles/${cue.id}`,
    { method: 'PATCH', body: JSON.stringify({ version: cue.version, locked: !cue.locked }) }
  );
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    const i = state.project.subtitles.findIndex((s) => s.id === cue.id);
    state.project.subtitles[i] = body.subtitle;
    renderSubtitles();
    loadComments();
    toast(body.subtitle.locked ? `字幕 #${cue.idx + 1} 已锁定，重排不再改动` : `字幕 #${cue.idx + 1} 已解锁`);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前内容', true);
    await loadProject(state.project.id);
  } else {
    toast(body?.error || '操作失败', true);
  }
}

async function saveRules() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const payload = {
    version: p.rules.version,
    max_chars: Number($('#rule-max-chars').value),
    min_duration_ms: Number($('#rule-min-duration').value),
    max_cps: Number($('#rule-max-cps').value),
  };
  const { status, body } = await api(`/api/projects/${p.id}/rules`, {
    method: 'PUT', body: JSON.stringify(payload),
  });
  if (status === 200) {
    state.project.rules = body;
    renderRules();
    renderSubtitles();
    toast(`规则已保存（v${body.version}），点击「重新排版」应用`);
  } else if (status === 409) {
    state.project.rules = body.current;
    renderRules();
    toast(body.error + '，已载入当前规则', true);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function runLayout() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/layout`, {
    method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }),
  });
  if (status === 200) {
    state.project.sub_version = body.sub_version;
    state.project.subtitles = body.subtitles;
    state.edits.clear();
    renderSubtitles();
    loadComments();
    toast(`排版完成：${body.subtitles.length} 条字幕（字幕集 v${body.sub_version}）`);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    renderConflicts(body.conflicts || [], `⚠ ${body.error}`);
    toast(body.error, true);
  } else {
    toast(body?.error || '排版失败', true);
  }
}

async function doExport() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  clearConflicts();
  const { status, body } = await api(`/api/projects/${p.id}/exports`, {
    method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }),
  });
  if (status === 201) {
    toast(`已确认导出 v${body.version}（${body.cue_count} 条），旧版本不受影响`);
    await loadProject(p.id);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else if (status === 422) {
    renderConflicts(body.conflicts || [], `⚠ ${body.error}`);
    toast(body.error, true);
  } else {
    toast(body?.error || '导出失败', true);
  }
}

async function doImport() {
  const p = state.project;
  let data;
  try {
    data = JSON.parse($('#import-json').value);
  } catch (e) {
    return toast('JSON 解析失败：' + e.message, true);
  }
  const name = $('#import-name').value.trim();
  clearConflicts();

  if (name || !p) {
    // 新建项目
    const { status, body } = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: name || `项目 ${new Date().toLocaleString()}`, ...data }),
    });
    if (status === 201) {
      toast(`项目 #${body.id} 已创建（${body.words.length} 词 / ${body.cuts.length} 切点），请点击「重新排版」`);
      await loadProjects(body.id);
    } else {
      toast((body?.errors || [body?.error || '导入失败']).join('；'), true);
    }
    return;
  }

  // 导入当前项目
  const force = $('#import-force').checked;
  const { status, body } = await api(`/api/projects/${p.id}/import`, {
    method: 'POST', body: JSON.stringify({ ...data, force }),
  });
  if (status === 200) {
    toast(`已导入：${body.words.length} 词 / ${body.cuts.length} 切点，请点击「重新排版」`);
    await loadProject(p.id);
  } else if (status === 409) {
    $('#force-row').classList.remove('hidden');
    toast(body.error, true);
  } else {
    toast((body?.errors || [body?.error || '导入失败']).join('；'), true);
  }
}

async function newProject() {
  const name = prompt('新项目名称：', '未命名项目');
  if (!name) return;
  const { status, body } = await api('/api/projects', {
    method: 'POST', body: JSON.stringify({ name }),
  });
  if (status === 201) {
    toast(`项目 #${body.id} 已创建，请导入转写数据`);
    await loadProjects(body.id);
  } else {
    toast(body?.error || '创建失败', true);
  }
}

// ---------- 多语言译文字幕 ----------

async function loadTranslation(lang) {
  const p = state.project;
  if (!p || !lang) return;
  const { status, body } = await api(`/api/projects/${p.id}/translations/${encodeURIComponent(lang)}`);
  if (status !== 200) { toast(body?.error || '加载译文失败', true); return; }
  state.trLang = lang;
  state.trView = body;
  $('#tr-lang').value = lang;
  renderTranslations();
  loadGlossary();
}

function trStateTag(stateName, valid) {
  if (stateName === 'missing') return '<span class="state">✗ 缺译</span>';
  if (stateName === 'review') return '<span class="state" style="color:var(--warn,#b8860b)">⚠ 待复核</span>';
  return valid
    ? '<span class="state ok">✓ 当前有效</span>'
    : '<span class="state" style="color:var(--danger)">✗ 规则不通过</span>';
}

function renderTranslations() {
  const panel = $('#tr-panel');
  const view = state.trView;
  if (!view) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  $('#tr-lang-tag').textContent = view.lang;
  const c = view.counts;
  $('#tr-stats').textContent =
    `共 ${c.cues} 条 · 当前 ${c.current}（有效 ${c.valid}）· 待复核 ${c.review} · 缺译 ${c.missing} · 历史 ${view.history.length}` +
    (c.term_missing ? ` · 术语缺失 ${c.term_missing} 行` : '');
  const glTag = $('#gl-version');
  if (glTag) {
    const g = view.glossary || { configured: false, version: 0 };
    glTag.textContent = g.configured ? `术语 v${g.version}` : '术语未配置 v0';
  }

  const box = $('#tr-table');
  box.innerHTML = '';
  for (const e of view.entries) {
    const cue = e.cue;
    const row = document.createElement('div');
    row.className = 'tr-row state-' + e.state + (e.valid ? ' valid' : '');

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.innerHTML = `${cue.idx + 1}<div class="word-ref">#${cue.id} · 词${cue.word_start}–${cue.word_end} · v${cue.version}${cue.locked ? ' 🔒' : ''}</div>`;

    const src = document.createElement('div');
    src.className = 'tr-src';
    src.innerHTML =
      `<div class="tr-meta">${fmtMs(cue.start_ms)} → ${fmtMs(cue.end_ms)}</div>` +
      `<div class="tr-src-text">${escapeHtml(cue.text)}</div>`;

    const wrap = document.createElement('div');
    wrap.className = 'tr-edit';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = e.translation ? e.translation.text : '';
    input.placeholder = e.state === 'missing' ? '输入译文后保存…' : '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const updateMeta = () => {
      const len = input.value.length;
      const dur = cue.end_ms - cue.start_ms;
      const cps = dur > 0 ? (len / (dur / 1000)) : Infinity;
      const badLen = len > view.rules.max_chars;
      const badCps = cps > view.rules.max_cps;
      meta.innerHTML =
        `<span class="${badLen ? 'bad' : ''}">${len}/${view.rules.max_chars} 字</span> · ` +
        `<span class="${badCps ? 'bad' : ''}">${isFinite(cps) ? cps.toFixed(1) : '∞'}字/s</span>`;
    };
    updateMeta();
    input.addEventListener('input', updateMeta);

    const tagLine = document.createElement('div');
    tagLine.className = 'tr-tagline';
    tagLine.innerHTML = trStateTag(e.state, e.valid) +
      (e.translation ? ` <span class="hint">译文 v${e.translation.version}</span>` : '');
    for (const reason of e.invalid_reasons) {
      tagLine.innerHTML += `<div class="tr-reason">• ${escapeHtml(reason)}</div>`;
    }
    for (const issue of (e.term_issues || [])) {
      tagLine.innerHTML +=
        `<div class="tr-reason term">📖 ${escapeHtml(issue.source)} → ${escapeHtml(issue.target)}</div>`;
    }
    wrap.append(input, meta, tagLine);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'small primary';
    saveBtn.textContent = '保存译文';
    saveBtn.onclick = () => saveTranslation(cue, e, input.value);
    ops.appendChild(saveBtn);
    if (e.state === 'review') {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'small secondary';
      confirmBtn.textContent = '✓ 确认仍适用';
      confirmBtn.onclick = () => confirmTranslation(cue, e);
      ops.appendChild(confirmBtn);
    }
    wrap.appendChild(ops);

    row.append(idx, src, wrap);
    box.appendChild(row);
  }

  // 导出快照列表
  const fillExports = (ul, list) => {
    ul.innerHTML = '';
    if (!list || list.length === 0) {
      ul.innerHTML = '<li class="empty">尚无译文导出快照</li>';
      return;
    }
    for (const ex of list) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/api/projects/${state.project.id}/translations/${encodeURIComponent(view.lang)}/exports/${ex.version}`;
      a.textContent = `⬇ ${ex.lang} v${ex.version}.vtt`;
      a.download = `project-${state.project.id}-${ex.lang}-v${ex.version}.vtt`;
      const info = document.createElement('span');
      info.className = 'hint';
      info.textContent = `${ex.cue_count} 条 · ${ex.created_at}`;
      li.append(a, info);
      ul.appendChild(li);
    }
  };
  fillExports($('#tr-export-list2'), view.exports || []);

  // 历史译文
  const hist = $('#tr-history');
  hist.innerHTML = '';
  if (view.history.length === 0) {
    hist.innerHTML = '<div class="empty">无历史译文。</div>';
  } else {
    for (const h of view.history) {
      const div = document.createElement('div');
      div.className = 'tr-hist-item';
      div.innerHTML =
        `<span class="hint">#${h.id} 译文 v${h.version}（源快照：${h.src_start_ms}–${h.src_end_ms}ms，词${h.src_word_start}–${h.src_word_end}）</span> ` +
        `“${escapeHtml(h.text)}”`;
      hist.appendChild(div);
    }
  }
}

async function saveTranslation(cue, entry, text) {
  const p = state.project;
  const lang = state.trLang;
  const payload = {
    text,
    cue_version: cue.version,
    version: entry.translation ? entry.translation.version : 0,
  };
  const { status, body } = await api(
    `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/subtitles/${cue.id}`,
    { method: 'PUT', body: JSON.stringify(payload) }
  );
  if (status === 200 || status === 201) {
    toast(`字幕 #${cue.idx + 1} 译文已保存（v${body.translation.version}，当前有效）`);
    await loadTranslation(lang);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前值', true);
    await loadTranslation(lang);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

async function confirmTranslation(cue, entry) {
  const p = state.project;
  const lang = state.trLang;
  const { status, body } = await api(
    `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/subtitles/${cue.id}/confirm`,
    { method: 'POST', body: JSON.stringify({ version: entry.translation.version }) }
  );
  if (status === 200) {
    toast(`字幕 #${cue.idx + 1} 译文已确认（v${body.translation.version}，恢复当前有效）`);
    await loadTranslation(lang);
  } else if (status === 409) {
    toast(body.error + '，已刷新当前值', true);
    await loadTranslation(lang);
  } else {
    toast((body?.errors || [body?.error || '确认失败']).join('；'), true);
  }
}

async function exportTranslation() {
  const p = state.project;
  let lang = state.trLang || $('#tr-lang').value.trim();
  if (!lang) return toast('请先填写目标语言代号并「载入语言」', true);
  const { status, body } = await api(
    `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/exports`,
    { method: 'POST', body: JSON.stringify({ sub_version: p.sub_version }) }
  );
  if (status === 201) {
    toast(`✓ ${lang} 译文已导出 v${body.version}（${body.cue_count} 条），快照不可变`);
    state.trLang = lang;
    await loadTranslation(lang);
  } else if (status === 422) {
    const parts = [];
    if (body.missing?.length) parts.push(`缺译 ${body.missing.length} 条：${body.missing.slice(0, 4).map((m) => `#${m.subtitle_id}`).join('、')}`);
    if (body.review?.length) parts.push(`待复核 ${body.review.length} 条`);
    if (body.invalid?.length) parts.push(`规则不通过 ${body.invalid.length} 条`);
    if (body.term_missing?.length) {
      parts.push(`术语缺失 ${body.term_missing.length} 条：${body.term_missing.slice(0, 3)
        .flatMap((m) => m.missing.map((x) => `${x.source}→${x.target}`)).join('、')}`);
    }
    if (body.conflicts?.length) parts.push(`整版冲突 ${body.conflicts.length} 处：${body.conflicts.slice(0, 2).map((c) => c.message).join('｜')}`);
    toast(body.error + (parts.length ? '：' + parts.join('；') : ''), true);
    await loadTranslation(lang);
  } else if (status === 409) {
    toast(body.error, true);
    await loadProject(p.id);
  } else {
    toast(body?.error || '导出失败', true);
    if (status === 400) { /* 语言代号非法，不切换面板 */ }
  }
}

// ---------- 译审术语对照表（随当前译文语言读取/保存） ----------

async function glossaryLang() {
  const lang = state.trLang || $('#tr-lang').value.trim();
  if (!lang) toast('请先填写目标语言代号并「载入语言」', true);
  return lang;
}

async function loadGlossary() {
  const p = state.project;
  const lang = await glossaryLang();
  if (!lang) return;
  const { status, body } = await api(`/api/projects/${p.id}/glossaries/${encodeURIComponent(lang)}`);
  if (status !== 200) return toast(body?.error || '载入术语表失败', true);
  state.glossary = body;
  $('#gl-terms').value = body.terms.length ? JSON.stringify(body.terms, null, 2) : '[]';
  $('#gl-version').textContent = body.configured ? `术语 v${body.version}` : '术语未配置 v0';
  renderGlossaryMissing([]);
}

async function saveGlossary() {
  const p = state.project;
  const lang = await glossaryLang();
  if (!lang) return;
  let terms;
  try {
    terms = JSON.parse($('#gl-terms').value || '[]');
  } catch {
    return toast('术语 JSON 解析失败：须为 [{source,target}] 数组', true);
  }
  const base = state.glossary && state.glossary.lang === lang
    ? state.glossary.version
    : (await api(`/api/projects/${p.id}/glossaries/${encodeURIComponent(lang)}`)).body.version;
  const { status, body } = await api(
    `/api/projects/${p.id}/glossaries/${encodeURIComponent(lang)}`,
    { method: 'PUT', body: JSON.stringify({ version: base, terms }) }
  );
  if (status === 200) {
    state.glossary = body;
    $('#gl-terms').value = JSON.stringify(body.terms, null, 2);
    $('#gl-version').textContent = `术语 v${body.version}`;
    toast(`✓ ${lang} 术语表已保存（${body.term_count} 条，v${body.version}）；不改变既有译文状态`);
    await loadTranslation(lang);
  } else if (status === 409) {
    state.glossary = body.current;
    $('#gl-version').textContent = body.current.configured ? `术语 v${body.current.version}` : '术语未配置 v0';
    $('#gl-terms').value = JSON.stringify(body.current.terms, null, 2);
    toast(body.error + '，已载入当前表', true);
  } else {
    toast((body?.errors || [body?.error || '保存失败']).join('；'), true);
  }
}

function renderGlossaryMissing(rows) {
  const box = $('#gl-missing');
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = '<div class="empty">当前无术语缺失。</div>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'gl-missing-list';
  for (const r of rows) {
    const li = document.createElement('li');
    li.innerHTML =
      `<div><strong>#${r.subtitle_id}</strong> ${escapeHtml(r.source_text)}</div>` +
      r.missing.map((m) =>
        `<div class="tr-reason term">📖 ${escapeHtml(m.source)} → ${escapeHtml(m.target)}</div>`
      ).join('');
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

async function queryGlossaryMissing() {
  const p = state.project;
  const lang = await glossaryLang();
  if (!lang) return;
  const { status, body } = await api(
    `/api/projects/${p.id}/glossaries/${encodeURIComponent(lang)}/missing`
  );
  if (status !== 200) return toast(body?.error || '查询失败', true);
  if (!body.configured) {
    $('#gl-version').textContent = '术语未配置 v0';
    return renderGlossaryMissing([]);
  }
  $('#gl-version').textContent = `术语 v${body.glossary_version}`;
  renderGlossaryMissing(body.missing);
  toast(body.missing.length
    ? `术语缺失 ${body.missing.length} 行（术语 v${body.glossary_version}）`
    : `✓ 术语全部命中（v${body.glossary_version}）`);
}

// ---------- 示例数据 ----------

const SAMPLE_WORDS = [
  ['大家好',100,700],['欢迎收看',750,1450],['本期',1500,1900],['节目',1950,2400],
  ['今天',2500,2900],['我们',2950,3300],['来到',3350,3700],['了',3750,3950],
  ['江边',4000,4450],['的',4500,4650],['老',4700,4900],['茶馆',4950,5450],
  ['这里',6100,6500],['每天',6550,6950],['都',7000,7150],['有',7200,7350],
  ['很多',7400,7800],['茶客',7850,8300],['一边',8400,8800],['喝茶',8850,9250],
  ['一边',9300,9700],['聊天',9750,10200],['老板',11100,11500],['说',11550,11700],
  ['这',11750,11850],['壶',11900,12050],['茶',12100,12250],['泡',12300,12500],
  ['了',12550,12700],['三十年',12750,13300],['镜头',14100,14500],['转向',14550,14950],
  ['窗外',15000,15400],['的',15450,15550],['江面',15600,16000],['雾气',16100,16500],
  ['正在',16550,16950],['缓缓',17000,17400],['升起',17450,17900],['我们',19100,19500],
  ['下期',19550,19950],['再见',20000,20600],
];

function samplePayload(cuts) {
  return JSON.stringify({
    words: SAMPLE_WORDS.map(([text, start_ms, end_ms]) => ({ text, start_ms, end_ms })),
    cuts,
  }, null, 2);
}

// ---------- 事件绑定 ----------

$('#project-select').addEventListener('change', (e) => loadProject(Number(e.target.value)));
$('#btn-new-project').addEventListener('click', newProject);
$('#btn-refresh').addEventListener('click', () => state.project && loadProject(state.project.id));
$('#btn-save-rules').addEventListener('click', saveRules);
$('#btn-layout').addEventListener('click', runLayout);
$('#btn-export').addEventListener('click', doExport);
$('#btn-import').addEventListener('click', doImport);
$('#btn-sample').addEventListener('click', () => {
  $('#import-json').value = samplePayload([6000, 11000, 14000, 19000]);
  toast('已载入示例，点击「导入」');
});
$('#btn-sample-conflict').addEventListener('click', () => {
  // 切点 1300ms 落在词「欢迎收看」[750,1450] 内部 → 必然冲突，用于演示冲突报告
  $('#import-json').value = samplePayload([1300, 6000, 11000, 14000, 19000]);
  toast('已载入冲突示例（切点落在词内部），导入后点「重新排版」查看冲突报告');
});
$('#btn-rev-submit').addEventListener('click', submitRevision);
$('#btn-rev-fill').addEventListener('click', fillRevisionTemplate);
$('#btn-wr-submit').addEventListener('click', submitWordRevision);
$('#btn-wr-fill').addEventListener('click', fillWordRevisionTemplate);
$('#btn-tr-load').addEventListener('click', () => {
  const lang = $('#tr-lang').value.trim();
  if (!lang) return toast('请填写目标语言代号（如 en、ja-JP）', true);
  loadTranslation(lang);
});
$('#tr-lang').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btn-tr-load').click(); }
});
$('#btn-tr-export').addEventListener('click', exportTranslation);
$('#btn-gl-load').addEventListener('click', loadGlossary);
$('#btn-gl-save').addEventListener('click', saveGlossary);
$('#btn-gl-missing').addEventListener('click', queryGlossaryMissing);

loadProjects();

// ---------- ⑧ 说话人标注与署名版导出 ----------

function renderSpeakerVersionTag() {
  const p = state.project;
  $('#sp-version').textContent = p ? `归属 v${p.attribution_version}` : '';
}

async function createSpeaker() {
  if (!state.project) return;
  const display_name = $('#sp-new-name').value.trim();
  if (!display_name) return toast('请填写显示名', true);
  const { status, body } = await api(`/api/projects/${state.project.id}/speakers`, {
    method: 'POST', body: JSON.stringify({ display_name }),
  });
  if (status !== 201) return toast(body?.error || '创建失败', true);
  $('#sp-new-name').value = '';
  toast(`已建立说话人编号 ${body.speaker.number}：${body.speaker.display_name}`);
  await loadProject(state.project.id);
  await loadSpeakers(true);
}

async function loadSpeakers(keepPanel) {
  if (!state.project) return;
  const { status, body } = await api(`/api/projects/${state.project.id}/attributions`);
  if (status !== 200) { toast(body?.error || '载入归属失败', true); return; }
  state.spView = body;
  renderSpeakers();
  if (!keepPanel) $('#sp-panel').classList.remove('hidden');
}

function speakerOptions(selectedNumber) {
  const v = state.spView;
  let html = '<option value="">（未标注）</option>';
  for (const s of v.speakers) {
    html += `<option value="${s.number}"${s.number === selectedNumber ? ' selected' : ''}>${s.number}. ${escapeHtml(s.display_name)}</option>`;
  }
  return html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderSpeakers() {
  const v = state.spView;
  if (!v) return;
  $('#sp-stats').textContent =
    `字幕集 v${v.sub_version} / 归属 v${v.attribution_version}：已标注 ${v.counts.attributed}/${v.counts.cues}，历史 ${v.counts.history}`;

  // 名册（可改名）
  const reg = $('#speakers-registry');
  reg.innerHTML = '';
  v.speakers.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'sp-reg-row';
    div.innerHTML =
      `<span class="sp-num">#${s.number}</span>
       <input type="text" value="${escapeHtml(s.display_name)}" data-number="${s.number}" class="sp-rename-input">
       <button class="secondary sp-rename" data-number="${s.number}">改名</button>
       <span class="hint">${s.attribution_count} 条归属</span>`;
    reg.appendChild(div);
  });
  reg.querySelectorAll('.sp-rename').forEach((btn) => {
    btn.addEventListener('click', () => renameSpeaker(Number(btn.dataset.number)));
  });

  // 逐行归属
  const box = $('#sp-table');
  box.innerHTML = '';
  if (v.cues.length === 0) box.innerHTML = '<div class="empty">暂无字幕。</div>';
  v.cues.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'sp-row' + (c.locked ? ' locked' : '');
    row.innerHTML =
      `<div class="sp-cue">${c.locked ? '🔒 ' : ''}#${c.subtitle_id} ${escapeHtml(c.text)}
         <span class="hint">行 v${c.cue_version} · ${fmtMs(c.start_ms)}–${fmtMs(c.end_ms)}</span></div>
       <select class="sp-select" data-sid="${c.subtitle_id}">${speakerOptions(c.attribution?.number)}</select>
       <button class="primary sp-save" data-sid="${c.subtitle_id}">保存</button>`;
    box.appendChild(row);
  });
  box.querySelectorAll('.sp-save').forEach((btn) => {
    btn.addEventListener('click', () => saveAttribution(Number(btn.dataset.sid)));
  });

  // 快照清单（两处）
  const drawList = (el) => {
    el.innerHTML = '';
    listAttributedExports().then((rows) => {
      if (!rows) return;
      rows.forEach((e) => {
        const li = document.createElement('li');
        const label = e.kind === 'source' ? '原文' : `译文 ${e.lang}`;
        li.innerHTML = `<a href="/api/projects/${state.project.id}/attributed-exports/${e.version}">v${e.version}（${label}，${e.cue_count} 行）</a>
          <span class="hint">字幕 v${e.sub_version}/归属 v${e.attribution_version} · ${e.created_at}</span>`;
        el.appendChild(li);
      });
    });
  };
  drawList($('#sp-export-list2'));
  drawList($('#sp-export-list'));

  // 历史归属
  const hist = $('#sp-history');
  hist.innerHTML = v.history.length === 0
    ? '<div class="empty">无</div>'
    : v.history.map((h) =>
        `<div>#${h.number} ${escapeHtml(h.display_name)}（原行 v${h.cue_version}，留档于 ${h.history_at}）</div>`
      ).join('');
}

async function listAttributedExports() {
  if (!state.project) return null;
  const { body } = await api(`/api/projects/${state.project.id}/attributed-exports`);
  return body.exports;
}

async function renameSpeaker(number) {
  const input = document.querySelector(`.sp-rename-input[data-number="${number}"]`);
  const display_name = input.value.trim();
  if (!display_name) return toast('显示名不能为空', true);
  const { status, body } = await api(
    `${state.project.id ? `/api/projects/${state.project.id}/speakers/${number}` : ''}`,
    { method: 'PATCH', body: JSON.stringify({ attribution_version: state.spView.attribution_version, display_name }) }
  );
  if (status !== 200) {
    toast(`${body?.error || '改名失败'}${body?.current ? '（版本过期，正在刷新）' : ''}`, true);
    if (status === 409) { await loadProject(state.project.id); await loadSpeakers(true); }
    return;
  }
  toast(`编号 ${number} 已改名，归属版本 v${body.attribution_version}`);
  await loadProject(state.project.id);
  await loadSpeakers(true);
}

async function saveAttribution(sid) {
  const select = document.querySelector(`.sp-select[data-sid="${sid}"]`);
  const number = Number(select.value);
  if (!number) return toast('请先在名册选择一位说话人（不支持在面板清除归属）', true);
  const cue = state.spView.cues.find((c) => c.subtitle_id === sid);
  const { status, body } = await api(
    `/api/projects/${state.project.id}/attributions/subtitles/${sid}`,
    { method: 'PUT', body: JSON.stringify({
      attribution_version: state.spView.attribution_version,
      cue_version: cue.cue_version,
      speaker_number: number,
    }) }
  );
  if (status !== 200 && status !== 201) {
    toast(`${body?.error || '保存失败'}（${status}），已刷新当前值`, true);
    await loadProject(state.project.id);
    await loadSpeakers(true);
    return;
  }
  toast(`已保存 #${sid} → 编号 ${body.attribution.number} ${body.attribution.display_name}`);
  await loadProject(state.project.id);
  await loadSpeakers(true);
}

async function exportAttributed(useLang) {
  if (!state.project) return;
  // 先确保归属已载入并全部标注
  await loadSpeakers(true);
  const v = state.spView;
  const payload = {
    sub_version: state.project.sub_version,
    attribution_version: v.attribution_version,
  };
  let langDesc = '原文';
  if (useLang) {
    if (!state.trLang || !state.trView) return toast('请先在 ⑦ 面板载入一种目标语言译文', true);
    payload.lang = state.trLang;
    payload.translations = state.trView.entries
      .filter((e) => e.translation)
      .map((e) => ({ subtitle_id: e.cue.id, version: e.translation.version }));
    langDesc = `译文 ${state.trLang}`;
  }
  const { status, body } = await api(`/api/projects/${state.project.id}/attributed-exports`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (status === 409) {
    toast(`${body.error}（版本过期，已刷新）`, true);
    await loadProject(state.project.id);
    await loadSpeakers(true);
    return;
  }
  if (status === 422) {
    const parts = [];
    if (body.conflicts?.length) parts.push(`整版冲突 ${body.conflicts.length}`);
    if (body.rows?.length) parts.push(body.rows.slice(0, 5).map((r) =>
      `#${r.subtitle_id}: ${r.codes.join(',')}`).join('；') + (body.rows.length > 5 ? ' …' : ''));
    return toast(`署名版导出未通过：${parts.join(' / ')}`, true);
  }
  if (status !== 201) return toast(body?.error || '导出失败', true);
  toast(`署名版${langDesc}快照 v${body.version} 已生成（${body.cue_count} 行）`);
  renderSpeakers();
}

$('#btn-sp-create').addEventListener('click', createSpeaker);
$('#btn-sp-load').addEventListener('click', () => loadSpeakers(false));
$('#btn-sp-export-src').addEventListener('click', () => exportAttributed(false));
$('#btn-sp-export-tr').addEventListener('click', () => exportAttributed(true));

// ---------- 逐词区间复核意见 ----------
//
// 意见锚定“导入代次 + 词序区间”（不按字幕 ID/行号）：列表随字幕集刷新，
// 每条显示状态、词段与相交的当前字幕；关闭/重新打开携带意见版本（乐观锁）。

const CM_STATUS = {
  open: ['待处理', 'cm-open'],
  closed: ['已关闭', 'cm-closed'],
  review: ['待复核', 'cm-review'],
  history: ['历史', 'cm-history'],
};

async function loadComments() {
  const p = state.project;
  if (!p) { state.cmView = null; renderComments(); return; }
  const { status, body } = await api(`/api/projects/${p.id}/comments`);
  if (status !== 200) { toast(body?.error || '加载复核意见失败', true); return; }
  state.cmView = body;
  renderComments();
}

function cmWordText(c) {
  const seg = c.words || c.words_snapshot || [];
  return seg.map((w) => w.text).join('');
}

function renderComments() {
  const view = state.cmView;
  const box = $('#cm-list');
  const hbox = $('#cm-history');
  box.innerHTML = '';
  hbox.innerHTML = '';
  if (!view || !state.project) {
    $('#cm-stats').textContent = '';
    return;
  }
  const n = view.counts;
  $('#cm-stats').textContent =
    `（待处理 ${n.open} · 待复核 ${n.review} · 已关闭 ${n.closed} · 历史 ${n.history}）`;
  box.appendChild(renderCommentGroup(view.comments, false,
    '尚无复核意见：在左侧 ⑨ 面板按词序区间创建。'));
  hbox.appendChild(renderCommentGroup(view.history, true,
    '无历史意见（重新导入后旧代次意见会列在这里，仅查看）。'));
}

function renderCommentGroup(list, isHistory, emptyText) {
  const frag = document.createDocumentFragment();
  if (!list || list.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = emptyText;
    frag.appendChild(div);
    return frag;
  }
  for (const c of list) frag.appendChild(renderComment(c, isHistory));
  return frag;
}

function renderComment(c, isHistory) {
  const row = document.createElement('div');
  const [label, cls] = CM_STATUS[c.status] || [c.status, ''];
  row.className = 'cm-item' + (c.status === 'review' ? ' needs-review' : '') +
    (c.status === 'closed' ? ' is-closed' : '');

  const head = document.createElement('div');
  head.className = 'cm-head';
  const tag = document.createElement('span');
  tag.className = `status-tag ${cls}`;
  tag.textContent = label;
  const title = document.createElement('div');
  title.className = 'cm-title';
  title.innerHTML =
    `<strong>#${c.id}</strong> 词 ${c.word_start}–${c.word_end}「${escapeHtml(cmWordText(c))}」` +
    `<span class="rev-note">意见 v${c.version} · 第 ${c.import_version} 代导入 · ${c.created_at}</span>`;
  head.append(tag, title);

  const text = document.createElement('div');
  text.className = 'cm-text';
  text.textContent = c.text;

  const subs = document.createElement('div');
  subs.className = 'cm-subs';
  if (isHistory) {
    subs.innerHTML = '<span class="rev-note">旧导入代次意见，仅作历史查看：不附到新词段，不可关闭/重新打开。</span>';
  } else if (c.subtitles.length === 0) {
    subs.innerHTML = '<span class="rev-note">当前无相交字幕（尚未排版覆盖该词段），须先排版才能关闭。</span>';
  } else {
    subs.innerHTML = '相交字幕：' + c.subtitles.map((s) =>
      `<span class="cm-cue">#${s.idx + 1}「${escapeHtml(s.text)}」` +
      `<i>${fmtMs(s.start_ms)}–${fmtMs(s.end_ms)} · 词${s.word_start}–${s.word_end}${s.locked ? ' · 🔒' : ''}</i></span>`
    ).join('');
  }

  row.append(head, text, subs);

  if (!isHistory && c.snapshot) {
    const snap = document.createElement('div');
    snap.className = 'cm-snapshot';
    snap.innerHTML = `关闭快照（${c.closed_at}，字幕集 v${c.closed_sub_version}）：` +
      c.snapshot.map((s) =>
        `<span class="cm-cue"><i>词${s.word_start}–${s.word_end}</i>「${escapeHtml(s.text)}」` +
        `<i>${fmtMs(s.start_ms)}–${fmtMs(s.end_ms)}</i></span>`
      ).join('');
    row.appendChild(snap);
  }

  if (!isHistory) {
    const ops = document.createElement('div');
    ops.className = 'ops';
    if (c.status === 'open' || c.status === 'review') {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'small';
      closeBtn.textContent = '✓ 关闭';
      closeBtn.title = '关闭须当前有相交字幕；保存其文本/时间/词区间快照';
      closeBtn.onclick = () => closeComment(c);
      ops.appendChild(closeBtn);
    }
    if (c.status === 'closed' || c.status === 'review') {
      const reopenBtn = document.createElement('button');
      reopenBtn.className = 'small secondary';
      reopenBtn.textContent = '↩ 重新打开';
      reopenBtn.onclick = () => reopenComment(c);
      ops.appendChild(reopenBtn);
    }
    row.appendChild(ops);
  }
  return row;
}

async function createComment() {
  const p = state.project;
  if (!p) return toast('请先选择项目', true);
  const ws = $('#cm-word-start').value;
  const we = $('#cm-word-end').value;
  if (ws === '' || we === '') return toast('请填写起止词序', true);
  const payload = {
    import_version: p.import_version,
    sub_version: p.sub_version,
    word_start: Number(ws),
    word_end: Number(we),
    text: $('#cm-text').value,
  };
  const { status, body } = await api(`/api/projects/${p.id}/comments`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (status === 201) {
    toast(`意见 #${body.comment.id} 已创建（词 ${body.comment.word_start}–${body.comment.word_end}）`);
    $('#cm-text').value = '';
    await loadComments();
  } else if (status === 409) {
    toast(body.error + '，已刷新当前值', true);
    await loadProject(p.id);
  } else {
    toast((body?.errors || [body?.error || '创建失败']).join('；'), true);
  }
}

async function closeComment(c) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/comments/${c.id}/close`, {
    method: 'POST', body: JSON.stringify({ version: c.version }),
  });
  if (status === 200) {
    toast(`意见 #${c.id} 已关闭（保存相交字幕快照，意见 v${body.comment.version}）`);
    await loadComments();
  } else if (status === 409) {
    toast(body.error + '，已刷新当前值', true);
    await loadComments();
  } else {
    toast(body?.error || '关闭失败', true);
    if (status === 422) await loadComments();
  }
}

async function reopenComment(c) {
  const p = state.project;
  const { status, body } = await api(`/api/projects/${p.id}/comments/${c.id}/reopen`, {
    method: 'POST', body: JSON.stringify({ version: c.version }),
  });
  if (status === 200) {
    toast(`意见 #${c.id} 已重新打开（待处理，意见 v${body.comment.version}）`);
    await loadComments();
  } else if (status === 409) {
    toast(body.error + '，已刷新当前值', true);
    await loadComments();
  } else {
    toast(body?.error || '重新打开失败', true);
    if (status === 422) await loadComments();
  }
}

$('#btn-cm-create').addEventListener('click', createComment);

