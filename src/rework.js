'use strict';

/**
 * 片方返修意见（交付批次冻结文件 → 起止毫秒区间 → 后续批次核对 → 人工判定）。
 *
 * 模型：
 *   - 片方收到多语交付后，对某批次的原文或指定语言冻结文件，按起止毫秒记录非空返修意见；
 *     区间须落在该冻结文件的时间轴内（[首 cue 开始, 末 cue 结束]），创建时记录命中的
 *     冻结文本与时间（hits）以及文件在其导出序列上的版本；
 *   - 对同项目后续目标批次核对时，只比较两份冻结文件（绝不读取当前编辑稿或词序，
 *     系统不自动判定“已修复”）：
 *       目标批次未交付所选语言           → cannot_check（无法核对）
 *       区间内文本与覆盖范围均未变       → unchanged（未改动）
 *       其余                             → pending（待人工确认）
 *   - 片方可对 pending 项显式判定 resolved（已解决）/ still_pending（仍待修），
 *     结论绑定该目标批次；换批核对时旧批次结论仅作历史；
 *   - 批次不存在/跨项目/清单所指文件缺失或快照损坏/区间越界 → 明确拒绝且不改意见；
 *   - 判定写入携带意见版本 version（乐观锁），过期返回当前状态且不修改。
 */

const { parseWebVtt, diffCueSegments, formatTimestamp } = require('./vtt');
const { normalizeLang } = require('./translation');

const MAX_COMMENT_LEN = 2000;
const VERDICTS = new Set(['resolved', 'still_pending']);
const VERDICT_LABELS = { resolved: '已解决', still_pending: '仍待修' };
const STATUS_LABELS = { cannot_check: '无法核对', unchanged: '未改动', pending: '待人工确认' };

/** 操作拒绝：携带 HTTP 状态码与完整 payload（快照问题一次性全部给出） */
class ReworkError extends Error {
  constructor(statusCode, payload) {
    super(payload.error || '返修意见操作被拒绝');
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function isIntId(v) {
  return isInt(v) && v >= 1;
}

/** 路径/查询参数转 ≥1 的整数 ID，非法返回 null */
function toIntId(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return isIntId(n) ? n : null;
}

function fileLabel(kind, lang) {
  return kind === 'source' ? '原文文件' : `语言 ${lang} 的译文文件`;
}

/** 批次/文件的对外描述（下载地址沿用既有不可变快照下载约定，保持兼容） */
function fileRef(f) {
  return {
    ord: f.ord,
    kind: f.kind,
    lang: f.lang,
    version: f.version,
    cue_count: f.cue_count,
    download_url: f.kind === 'source'
      ? `/api/projects/${f.project_id}/exports/${f.version}`
      : `/api/projects/${f.project_id}/translations/${encodeURIComponent(f.lang)}/exports/${f.version}`,
  };
}

function batchSummary(b) {
  return {
    id: b.id,
    note: b.note,
    sub_version: b.sub_version,
    rules_version: b.rules_version,
    cue_count: b.cue_count,
    lang_count: b.lang_count,
    created_at: b.created_at,
  };
}

/**
 * 取批次并校验归属：ID 非法或不存在 → 404 batch_not_found；
 * 不属于该项目 → 404 batch_other_project（明确拒绝跨项目操作）。
 */
function resolveBatch(db, projectId, rawId, role) {
  const label = role === 'target' ? '目标批次' : '批次';
  const id = toIntId(rawId);
  if (id === null) {
    throw new ReworkError(404, {
      error: `${label} ${JSON.stringify(rawId)} 不存在，已拒绝`,
      reason_code: 'batch_not_found',
      role,
      batch_id: null,
    });
  }
  const b = db.prepare('SELECT * FROM delivery_batches WHERE id = ?').get(id);
  if (!b) {
    throw new ReworkError(404, {
      error: `${label} ${id} 不存在，已拒绝`,
      reason_code: 'batch_not_found',
      role,
      batch_id: id,
    });
  }
  if (b.project_id !== projectId) {
    throw new ReworkError(404, {
      error: `${label} ${id} 不属于项目 ${projectId}（属于项目 ${b.project_id}），拒绝跨项目操作`,
      reason_code: 'batch_other_project',
      role,
      batch_id: id,
      actual_project_id: b.project_id,
    });
  }
  return b;
}

/** 批次清单中的冻结文件：kind=source 取原文文件；kind=translation 取指定语言文件。无 → null */
function findFile(db, batchId, kind, lang) {
  if (kind === 'source') {
    return db.prepare(
      "SELECT * FROM delivery_files WHERE batch_id = ? AND kind = 'source' ORDER BY ord"
    ).get(batchId) || null;
  }
  return db.prepare(
    "SELECT * FROM delivery_files WHERE batch_id = ? AND kind = 'translation' AND lang = ?"
  ).get(batchId, lang) || null;
}

/**
 * 读取冻结文件的 WebVTT 快照并严格解析。
 * 返回 { ok:true, cues } 或 { ok:false, problem, reason }
 * （problem: snapshot_missing / snapshot_corrupt / manifest_corrupt）。
 */
function loadFileCues(db, file) {
  const label = `${file.kind === 'source' ? '原文' : `语言 ${file.lang}`} v${file.version}`;
  if (file.export_kind !== 'exports' && file.export_kind !== 'translation_exports') {
    return {
      ok: false, problem: 'manifest_corrupt',
      reason: `批次清单指向未知导出序列 ${JSON.stringify(file.export_kind)}（export_id=${file.export_id}）`,
    };
  }
  const table = file.export_kind === 'exports' ? 'exports' : 'translation_exports';
  const row = db.prepare(`SELECT content, cue_count FROM ${table} WHERE id = ?`).get(file.export_id);
  if (!row) {
    return {
      ok: false, problem: 'snapshot_missing',
      reason: `${label} 的冻结 WebVTT 快照缺失（${file.export_kind} id=${file.export_id} 行不存在）`,
    };
  }
  const r = parseWebVtt(row.content);
  if (!r.ok) {
    return { ok: false, problem: 'snapshot_corrupt', reason: `${label} 的 WebVTT 快照格式损坏：${r.reason}` };
  }
  if (r.cues.length !== file.cue_count) {
    return {
      ok: false, problem: 'snapshot_corrupt',
      reason: `${label} 的快照实际 cue 数 ${r.cues.length} 与批次清单冻结的 ${file.cue_count} 不一致`,
    };
  }
  return { ok: true, cues: r.cues };
}

/** 冻结文件时间轴：[首 cue 开始, 末 cue 结束]；无 cue（空文件）返回 null */
function timelineOf(cues) {
  if (cues.length === 0) return null;
  let s = Infinity;
  let e = -Infinity;
  for (const c of cues) {
    if (c.start_ms < s) s = c.start_ms;
    if (c.end_ms > e) e = c.end_ms;
  }
  return { start_ms: s, end_ms: e };
}

/** 命中区间 [s,e) 的冻结 cue（相交判定），返回其时间与文本（按时间升序） */
function hitsInInterval(cues, s, e) {
  return cues
    .filter((c) => c.start_ms < e && c.end_ms > s)
    .map((c) => ({ start_ms: c.start_ms, end_ms: c.end_ms, text: c.text }));
}

/** 把 cue 序列裁剪到区间 [s,e) 内（丢弃不相交部分），保持升序不重叠 */
function clipCues(cues, s, e) {
  const out = [];
  for (const c of cues) {
    const cs = Math.max(c.start_ms, s);
    const ce = Math.min(c.end_ms, e);
    if (ce > cs) out.push({ start_ms: cs, end_ms: ce, text: c.text });
  }
  return out;
}

/**
 * 区间内比较：把两份冻结文件的 cue 裁剪到意见区间后，按时间区段比较显示文本。
 * 返回差异区段列表（空数组 = 区间内文本与覆盖范围均未变）。
 */
function diffInterval(baseCues, targetCues, s, e) {
  return diffCueSegments(clipCues(baseCues, s, e), clipCues(targetCues, s, e));
}

/**
 * 创建返修意见请求形状校验（与项目当前状态无关的部分）。
 * 合法项：{ kind:'source' } 或 { kind:'translation', lang }，加 start_ms/end_ms/text。
 */
function parseCreateBody(body) {
  const errors = [];
  const b = body || {};
  const kind = b.kind;
  if (kind !== 'source' && kind !== 'translation') {
    errors.push('kind 必须是 "source"（批次原文文件）或 "translation"（批次指定语言译文文件）');
  }
  let lang = null;
  if (kind === 'translation') {
    const normalized = normalizeLang(b.lang);
    if (!normalized) {
      errors.push('kind=translation 时 lang 必须是非空语言代号（如 en、ja-JP、pt_BR）');
    } else if (b.lang !== normalized) {
      errors.push(`lang 含有首尾空白，请提交规范化形式 "${normalized}"`);
    } else {
      lang = normalized;
    }
  } else if (kind === 'source' && b.lang !== undefined && b.lang !== null) {
    errors.push('kind=source（原文文件）不接受 lang 字段');
  }
  if (!isInt(b.start_ms) || b.start_ms < 0) {
    errors.push('start_ms（区间起点毫秒）必须是 ≥0 的整数');
  }
  if (!isInt(b.end_ms) || b.end_ms < 0) {
    errors.push('end_ms（区间终点毫秒）必须是 ≥0 的整数');
  }
  if (isInt(b.start_ms) && isInt(b.end_ms) && b.start_ms >= b.end_ms) {
    errors.push(`区间非法：起点 ${b.start_ms}ms 必须早于终点 ${b.end_ms}ms`);
  }
  if (typeof b.text !== 'string' || b.text.trim() === '') {
    errors.push('text（返修意见）必须是非空字符串');
  } else if (b.text.trim().length > MAX_COMMENT_LEN) {
    errors.push(`text（返修意见）长度 ${b.text.trim().length} 超过上限 ${MAX_COMMENT_LEN} 字`);
  }
  return {
    ok: errors.length === 0,
    errors,
    item: errors.length === 0
      ? { kind, lang, start_ms: b.start_ms, end_ms: b.end_ms, text: b.text.trim() }
      : null,
  };
}

/** 判定请求：{ version, target_batch_id, verdict }（意见版本乐观锁 + 结论绑定目标批次） */
function parseVerdictBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.version) || b.version < 1) {
    errors.push('version（意见版本）必须是 ≥1 的整数');
  }
  if (!isIntId(b.target_batch_id)) {
    errors.push('target_batch_id（目标批次 ID）必须是 ≥1 的整数');
  }
  if (!VERDICTS.has(b.verdict)) {
    errors.push('verdict 必须是 "resolved"（已解决）或 "still_pending"（仍待修）');
  }
  return {
    ok: errors.length === 0,
    errors,
    item: errors.length === 0
      ? { version: b.version, target_batch_id: b.target_batch_id, verdict: b.verdict }
      : null,
  };
}

function mapVerdictRow(v) {
  return {
    target_batch_id: v.target_batch_id,
    verdict: v.verdict,
    verdict_label: VERDICT_LABELS[v.verdict] || v.verdict,
    created_at: v.created_at,
    updated_at: v.updated_at,
  };
}

/** 意见基础视图：区间、文本、意见版本、创建时命中的冻结文本与时间 */
function commentView(row) {
  const hits = JSON.parse(row.hits_json).map((h) => ({
    start_ms: h.start_ms,
    end_ms: h.end_ms,
    start: formatTimestamp(h.start_ms),
    end: formatTimestamp(h.end_ms),
    text: h.text,
  }));
  return {
    id: row.id,
    batch_id: row.batch_id,
    kind: row.kind,
    lang: row.lang,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    start: formatTimestamp(row.start_ms),
    end: formatTimestamp(row.end_ms),
    text: row.text,
    version: row.version,
    file_version: row.file_version,
    hits,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 读取批次内单条意见行，不存在返回 null */
function getComment(db, batchId, commentId) {
  return db.prepare(
    'SELECT * FROM rework_comments WHERE id = ? AND batch_id = ?'
  ).get(commentId, batchId) || null;
}

/** 批量取意见的判定结论：Map(comment_id -> [verdictRow,...])（按写入顺序） */
function listVerdicts(db, commentIds) {
  const map = new Map();
  if (commentIds.length === 0) return map;
  const marks = commentIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM rework_verdicts WHERE comment_id IN (${marks}) ORDER BY id`
  ).all(...commentIds);
  for (const r of rows) {
    if (!map.has(r.comment_id)) map.set(r.comment_id, []);
    map.get(r.comment_id).push(r);
  }
  return map;
}

/** 意见当前状态视图（基础视图 + 全部判定结论），用于列表与过期响应的 current */
function commentStateView(db, row) {
  const verdicts = listVerdicts(db, [row.id]).get(row.id) || [];
  return { ...commentView(row), verdicts: verdicts.map(mapVerdictRow) };
}

/**
 * 装载单条意见核对所需的冻结文件与 cue（基准批次 + 目标批次各一份）。
 * 返回 { problems, baseFile, baseCues, targetFile, targetCues }：
 *   - 清单所指文件缺失或快照损坏 → problems 非空（调用方整份拒绝，不改任何数据）；
 *   - 目标批次未交付所选语言（译文文件缺失）→ targetFile 为 null（合法情形，核对为“无法核对”）。
 */
function inspectCommentFiles(db, baseBatch, targetBatch, comment) {
  const problems = [];
  const out = { problems, baseFile: null, baseCues: null, targetFile: null, targetCues: null };

  const baseFile = findFile(db, baseBatch.id, comment.kind, comment.lang);
  if (!baseFile) {
    // 意见创建时文件必在清单内；找不到说明清单损坏
    problems.push({
      side: 'base', batch_id: baseBatch.id, file: null, problem: 'manifest_corrupt',
      reason: `批次清单中找不到返修意见 ${comment.id} 锚定的${fileLabel(comment.kind, comment.lang)}（清单损坏）`,
    });
    return out;
  }
  out.baseFile = baseFile;
  const baseSnap = loadFileCues(db, baseFile);
  if (!baseSnap.ok) {
    problems.push({
      side: 'base', batch_id: baseBatch.id, file: fileRef(baseFile),
      problem: baseSnap.problem, reason: baseSnap.reason,
    });
  } else {
    out.baseCues = baseSnap.cues;
  }

  const targetFile = findFile(db, targetBatch.id, comment.kind, comment.lang);
  if (!targetFile) {
    if (comment.kind === 'source') {
      problems.push({
        side: 'target', batch_id: targetBatch.id, file: null, problem: 'manifest_corrupt',
        reason: '目标批次清单缺少原文文件（kind=source），清单损坏',
      });
    }
    // 译文文件缺失 = 目标批次未交付该语言（合法，核对结果为“无法核对”）
    return out;
  }
  out.targetFile = targetFile;
  const targetSnap = loadFileCues(db, targetFile);
  if (!targetSnap.ok) {
    problems.push({
      side: 'target', batch_id: targetBatch.id, file: fileRef(targetFile),
      problem: targetSnap.problem, reason: targetSnap.reason,
    });
  } else {
    out.targetCues = targetSnap.cues;
  }
  return out;
}

/**
 * 单条意见对目标批次的核对结果（只比较两份冻结文件）。
 * targetFile 为 null（目标批次未交付所选语言）→ cannot_check；
 * 区间内无差异 → unchanged；有差异 → pending。
 */
function evaluateComment(comment, baseCues, targetFile, targetCues) {
  if (!targetFile) {
    return {
      status: 'cannot_check',
      status_label: STATUS_LABELS.cannot_check,
      reason: `目标批次未交付${fileLabel(comment.kind, comment.lang)}，无法核对`,
      target_file: null,
      differences: null,
    };
  }
  const differences = diffInterval(baseCues, targetCues, comment.start_ms, comment.end_ms)
    .map((d) => ({
      start_ms: d.start_ms,
      end_ms: d.end_ms,
      start: formatTimestamp(d.start_ms),
      end: formatTimestamp(d.end_ms),
      base_text: d.base_text,
      target_text: d.target_text,
    }));
  if (differences.length === 0) {
    return {
      status: 'unchanged',
      status_label: STATUS_LABELS.unchanged,
      reason: null,
      target_file: fileRef(targetFile),
      differences: [],
    };
  }
  return {
    status: 'pending',
    status_label: STATUS_LABELS.pending,
    reason: null,
    target_file: fileRef(targetFile),
    differences,
  };
}

/** 核对结果 + 结论 组装成单条意见条目（check 报告与判定响应共用） */
function commentCheckItem(db, comment, evaluation, targetBatchId) {
  const vAll = listVerdicts(db, [comment.id]).get(comment.id) || [];
  const current = vAll.find((v) => v.target_batch_id === targetBatchId) || null;
  const history = vAll.filter((v) => v.target_batch_id !== targetBatchId);
  return {
    ...commentView(comment),
    ...evaluation,
    verdict: current ? mapVerdictRow(current) : null,
    verdict_history: history.map(mapVerdictRow),
  };
}

/**
 * 核对报告（只读）：基准批次（意见锚定批次）的全部返修意见 × 目标批次。
 * 批次不存在/跨项目 → 404；清单所指文件缺失或快照损坏 → 500
 * （snapshot_problems 一次性指出全部问题批次与文件，整份失败不返回部分结果）。
 */
function buildCheckReport(db, projectId, rawBaseId, rawTargetId) {
  const targetId = toIntId(rawTargetId);
  if (targetId === null) {
    throw new ReworkError(400, {
      error: '核对参数非法：target_id 必须是 ≥1 的整数批次 ID',
    });
  }
  const baseBatch = resolveBatch(db, projectId, rawBaseId, 'base');
  const targetBatch = resolveBatch(db, projectId, targetId, 'target');

  const comments = db.prepare(
    'SELECT * FROM rework_comments WHERE batch_id = ? ORDER BY id'
  ).all(baseBatch.id);

  // 按冻结文件（kind+lang）分组，同一份文件只解析一次快照
  const groups = new Map();
  const problems = [];
  for (const c of comments) {
    const key = `${c.kind}|${c.lang || ''}`;
    if (!groups.has(key)) {
      const inspect = inspectCommentFiles(db, baseBatch, targetBatch, c);
      problems.push(...inspect.problems);
      groups.set(key, { inspect, comments: [] });
    }
    groups.get(key).comments.push(c);
  }

  if (problems.length > 0) {
    throw new ReworkError(500, {
      error:
        `返修核对（批次 ${baseBatch.id} → ${targetBatch.id}）因快照问题整份失败` +
        `（${problems.length} 处）：清单所指文件缺失或快照损坏，未返回任何核对结果`,
      project_id: projectId,
      base_id: baseBatch.id,
      target_id: targetBatch.id,
      snapshot_problems: problems,
    });
  }

  const counts = {
    total: comments.length,
    cannot_check: 0,
    unchanged: 0,
    pending: 0,
    resolved: 0,
    still_pending: 0,
  };
  const items = [];
  for (const { inspect, comments: groupComments } of groups.values()) {
    for (const c of groupComments) {
      const evaluation = evaluateComment(c, inspect.baseCues, inspect.targetFile, inspect.targetCues);
      counts[evaluation.status] += 1;
      const item = commentCheckItem(db, c, evaluation, targetBatch.id);
      if (item.verdict) counts[item.verdict.verdict] += 1;
      items.push(item);
    }
  }
  items.sort((a, b) => a.id - b.id);

  return {
    project_id: projectId,
    base: batchSummary(baseBatch),
    target: batchSummary(targetBatch),
    same_batch: baseBatch.id === targetBatch.id,
    counts,
    comments: items,
  };
}

/** 批次返修意见列表（只读；不含核对结果，核对走 check） */
function buildCommentsList(db, projectId, batch) {
  const comments = db.prepare(
    'SELECT * FROM rework_comments WHERE batch_id = ? ORDER BY id'
  ).all(batch.id);
  return {
    project_id: projectId,
    batch: batchSummary(batch),
    counts: { total: comments.length },
    comments: comments.map((c) => commentStateView(db, c)),
  };
}

module.exports = {
  MAX_COMMENT_LEN,
  STATUS_LABELS,
  VERDICT_LABELS,
  ReworkError,
  toIntId,
  fileLabel,
  fileRef,
  batchSummary,
  resolveBatch,
  findFile,
  loadFileCues,
  timelineOf,
  hitsInInterval,
  clipCues,
  diffInterval,
  parseCreateBody,
  parseVerdictBody,
  mapVerdictRow,
  commentView,
  getComment,
  listVerdicts,
  commentStateView,
  inspectCommentFiles,
  evaluateComment,
  commentCheckItem,
  buildCheckReport,
  buildCommentsList,
};
