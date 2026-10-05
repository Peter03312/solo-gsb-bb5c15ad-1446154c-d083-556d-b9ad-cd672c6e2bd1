'use strict';

/**
 * 片方交付返修意见。
 *
 * 片方收到多语交付后，可对某批次的原文或指定语言冻结文件，按起止毫秒记录
 * 非空返修意见；区间必须落在该文件冻结时间轴内（first cue start .. last cue end），
 * 记录创建时命中的冻结文本与时间（hits）。
 *
 * 对同项目后续目标批次核对时，只按两份冻结文件在该毫秒区间上的时间区段比较：
 *   - 目标批次未交付所选语言        → unavailable（无法核对）
 *   - 区间内文本和覆盖范围均未变    → unchanged（未改动）
 *   - 其余                          → manual（待人工确认）
 * 不能由当前编辑稿或词序自动判定已修复——核对全程只读两份冻结快照。
 *
 * 片方仅可对 manual 项显式下结论 resolved（已解决）/ outstanding（仍待修），
 * 结论绑定该目标批次（delivery_comment_decisions）；换批后旧结论仅作历史。
 * 下结论携带意见版本 version（乐观锁），过期返回当前状态且不修改。
 */

const { parseWebVtt, formatTimestamp } = require('./vtt');
const { normalizeLang } = require('./translation');

const MAX_COMMENT_LEN = 2000;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 返修操作被明确拒绝：携带 HTTP 状态码与完整 payload，且不改任何意见 */
class DeliveryCommentError extends Error {
  constructor(statusCode, payload) {
    super(payload.error || '交付返修操作被拒绝');
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

/**
 * 创建返修意见请求形状校验（与项目/批次当前状态无关的部分）。
 * 合法项：{ kind:'source' } 或 { kind:'translation', lang }，start_ms/end_ms ≥0、
 * start < end，text 非空。
 */
function parseDeliveryCommentBody(body) {
  const errors = [];
  const b = body || {};

  let kind = null;
  let lang = null;
  if (b.kind !== 'source' && b.kind !== 'translation') {
    errors.push('kind 必须是 "source"（原文）或 "translation"（指定语言译文）');
  } else {
    kind = b.kind;
    if (kind === 'translation') {
      lang = normalizeLang(b.lang);
      if (!lang) {
        errors.push('kind=translation 时 lang 必须是合法语言代号（非空、≤32 字、字母开头，如 en、ja-JP）');
      } else if (b.lang !== lang) {
        errors.push(`lang 含有首尾空白，请提交规范化形式 "${lang}"`);
      }
    }
  }

  if (!isInt(b.start_ms) || b.start_ms < 0) {
    errors.push('start_ms（区间起始毫秒）必须是 ≥0 的整数');
  }
  if (!isInt(b.end_ms) || b.end_ms < 0) {
    errors.push('end_ms（区间结束毫秒）必须是 ≥0 的整数');
  }
  if (isInt(b.start_ms) && isInt(b.end_ms) && b.start_ms >= b.end_ms) {
    errors.push(`时间区间非法：起始毫秒 ${b.start_ms} 必须早于结束毫秒 ${b.end_ms}`);
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

/** 下结论请求：{ version（意见版本，必填 ≥1）, verdict: 'resolved'|'outstanding' } */
function parseDecisionBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.version) || b.version < 1) {
    errors.push('version（意见版本）必须是 ≥1 的整数');
  }
  let verdict = null;
  if (b.verdict !== 'resolved' && b.verdict !== 'outstanding') {
    errors.push('verdict 必须是 "resolved"（已解决）或 "outstanding"（仍待修）');
  } else {
    verdict = b.verdict;
  }
  return {
    ok: errors.length === 0,
    errors,
    version: isInt(b.version) ? b.version : null,
    verdict,
  };
}

/** 文件对外描述（下载地址沿用既有不可变快照下载约定） */
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

/** 取批次行（按全局 ID）：不存在返回 null */
function getBatch(db, batchId) {
  return db.prepare('SELECT * FROM delivery_batches WHERE id = ?').get(batchId) || null;
}

/** 取批次内某文件清单行：kind=source 或 kind=translation+lang */
function getBatchFile(db, batchId, kind, lang) {
  return kind === 'source'
    ? db.prepare('SELECT * FROM delivery_files WHERE batch_id = ? AND kind = \'source\'').get(batchId) || null
    : db.prepare('SELECT * FROM delivery_files WHERE batch_id = ? AND kind = \'translation\' AND lang = ?')
        .get(batchId, lang) || null;
}

/**
 * 按全局 ID 解析批次并校验归属。
 * role 仅用于中文提示（如“返修批次”“目标批次”）。
 * 不存在 → 404 batch_not_found；不属于该项目 → 404 batch_other_project（明确拒绝跨项目）。
 */
function resolveBatch(db, projectId, batchId, role) {
  const b = getBatch(db, batchId);
  if (!b) {
    throw new DeliveryCommentError(404, {
      error: `${role} ${batchId} 不存在，已拒绝`,
      reason_code: 'batch_not_found',
      batch_id: batchId,
    });
  }
  if (b.project_id !== projectId) {
    throw new DeliveryCommentError(404, {
      error: `${role} ${batchId} 不属于项目 ${projectId}（属于项目 ${b.project_id}），拒绝跨项目操作`,
      reason_code: 'batch_other_project',
      batch_id: batchId,
      actual_project_id: b.project_id,
    });
  }
  return b;
}

/**
 * 载入并严格校验某份交付文件的冻结快照。
 * 清单所指文件缺失（无清单行/导出行不存在）或快照损坏（未知导出序列/WebVTT 解析失败/
 * cue 数与清单不符）→ 500（明确指出批次与文件；调用方保证不返回部分结果、不改意见）。
 * 返回 { file, batch, cues }。
 */
function loadFrozenFile(db, batch, kind, lang) {
  const file = getBatchFile(db, batch.id, kind, lang);
  const label = kind === 'source' ? '原文' : `语言 ${lang}`;
  if (!file) {
    throw new DeliveryCommentError(500, {
      error: `批次 ${batch.id} 的${label}冻结文件清单缺失，操作中止且未修改意见`,
      reason_code: 'manifest_missing',
      batch_id: batch.id,
      file: { kind, lang },
    });
  }
  const ref = fileRef(file);
  if (file.export_kind !== 'exports' && file.export_kind !== 'translation_exports') {
    throw new DeliveryCommentError(500, {
      error: `批次 ${batch.id} 的${label}清单指向未知导出序列 ${JSON.stringify(file.export_kind)}（export_id=${file.export_id}）`,
      reason_code: 'manifest_corrupt',
      batch_id: batch.id,
      file: ref,
    });
  }
  const table = file.export_kind === 'exports' ? 'exports' : 'translation_exports';
  const row = db.prepare(`SELECT content, cue_count FROM ${table} WHERE id = ?`).get(file.export_id);
  if (!row) {
    throw new DeliveryCommentError(500, {
      error: `${label} v${file.version} 的冻结 WebVTT 快照缺失（${file.export_kind} id=${file.export_id} 行不存在），操作中止且未修改意见`,
      reason_code: 'snapshot_missing',
      batch_id: batch.id,
      file: ref,
    });
  }
  const parsed = parseWebVtt(row.content);
  if (!parsed.ok) {
    throw new DeliveryCommentError(500, {
      error: `${label} v${file.version} 的 WebVTT 快照格式损坏：${parsed.reason}`,
      reason_code: 'snapshot_corrupt',
      batch_id: batch.id,
      file: ref,
    });
  }
  if (parsed.cues.length !== file.cue_count) {
    throw new DeliveryCommentError(500, {
      error: `${label} v${file.version} 的快照实际 cue 数 ${parsed.cues.length} 与批次清单冻结的 ${file.cue_count} 不一致`,
      reason_code: 'snapshot_corrupt',
      batch_id: batch.id,
      file: ref,
    });
  }
  return { file, cues: parsed.cues };
}

/** 文件冻结时间轴：首 cue 起 .. 末 cue 止（无 cue 的文件视为损坏，正常交付不会产生） */
function timelineOf(cues) {
  if (cues.length === 0) return null;
  return { start_ms: cues[0].start_ms, end_ms: cues[cues.length - 1].end_ms };
}

/**
 * 区间命中的冻结文本与时间：每个与 [start,end] 相交的 cue 记录相交时间区段
 * （clip_start/clip_end）、该 cue 全文（text）及其原始起止（cue_start_ms/cue_end_ms）。
 * 区间可能全部落在时间空档（无 cue 相交），此时 hits 为空数组——空档也是要返修的对象。
 */
function hitsInRange(cues, start, end) {
  const hits = [];
  for (const c of cues) {
    if (c.end_ms <= start || c.start_ms >= end) continue;
    hits.push({
      cue_start_ms: c.start_ms,
      cue_end_ms: c.end_ms,
      clip_start_ms: Math.max(c.start_ms, start),
      clip_end_ms: Math.min(c.end_ms, end),
      clip_start: formatTimestamp(Math.max(c.start_ms, start)),
      clip_end: formatTimestamp(Math.min(c.end_ms, end)),
      text: c.text,
    });
  }
  return hits;
}

/**
 * 按毫秒区间比较两份冻结文件在“实际显示文本 + 覆盖范围”上是否一致。
 * 与全量对照同源（合并边界切分极小区段），但只取完全落在 [start,end) 内的区段；
 * 任一侧在该时刻正在显示的文本不同（含 空档 null 与 空文本 '' 的差异）即为差异。
 * 返回 [{ start_ms, end_ms, start, end, base_text, target_text }]（按时间升序，已合并）。
 */
function diffInterval(baseCues, targetCues, start, end) {
  const points = new Set([start, end]);
  for (const c of [...baseCues, ...targetCues]) {
    if (c.end_ms <= start || c.start_ms >= end) continue;
    points.add(Math.max(c.start_ms, start));
    points.add(Math.min(c.end_ms, end));
  }
  const bounds = [...points].sort((a, b) => a - b);

  const textAt = (cues, t) => {
    // cues 已升序非重叠；二分找到可能覆盖 t 的 cue
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (t < c.start_ms) hi = mid - 1;
      else if (t >= c.end_ms) lo = mid + 1;
      else return c.text;
    }
    return null;
  };

  const segs = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const s = bounds[k];
    const e = bounds[k + 1];
    if (e <= s) continue;
    const tb = textAt(baseCues, s);
    const tt = textAt(targetCues, s);
    if (tb !== tt) {
      segs.push({ start_ms: s, end_ms: e, base_text: tb, target_text: tt });
    }
  }

  // 相邻差异区段：两侧各自跨边界文本均未变（含同为空档）时合并为一条
  const merged = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && last.end_ms === seg.start_ms &&
        last.base_text === seg.base_text && last.target_text === seg.target_text) {
      last.end_ms = seg.end_ms;
    } else {
      merged.push({ ...seg });
    }
  }
  for (const m of merged) {
    m.start = formatTimestamp(m.start_ms);
    m.end = formatTimestamp(m.end_ms);
  }
  return merged;
}

/**
 * 对一条返修意见执行“同项目后续目标批次”自动核对（只读两份冻结快照）。
 * 调用前已解析 comment 与其基准批次归属；本函数负责：
 *   - 目标批次同项目归属（resolveBatch）；
 *   - 基准文件与目标文件快照的载入与严格校验（损坏/缺失 → 500，不返回部分结果）；
 *   - 目标批次未交付所选语言 → unavailable（无法核对）；
 *   - 区间相对基准时间轴越界（清单/快照损坏导致）→ 500；
 *   - 区间内文本和覆盖范围均未变 → unchanged；其余 → manual（待人工确认）。
 * 返回核对结果对象（不读取当前编辑稿/词序）。
 */
function checkComment(db, projectId, comment, targetBatchId) {
  const baseBatch = resolveBatch(db, projectId, comment.batch_id, '返修意见所属批次');
  const targetBatch = resolveBatch(db, projectId, targetBatchId, '目标批次');

  const base = loadFrozenFile(db, baseBatch, comment.kind, comment.lang);
  const baseTimeline = timelineOf(base.cues);
  if (!baseTimeline || comment.start_ms < baseTimeline.start_ms || comment.end_ms > baseTimeline.end_ms) {
    throw new DeliveryCommentError(500, {
      error: `返修意见 ${comment.id} 的区间 [${comment.start_ms}, ${comment.end_ms}] 超出其基准文件冻结时间轴，基准快照或清单可能已损坏`,
      reason_code: 'snapshot_corrupt',
      batch_id: baseBatch.id,
      file: fileRef(base.file),
    });
  }

  const targetFile = getBatchFile(db, targetBatch.id, comment.kind, comment.lang);
  if (!targetFile) {
    return {
      status: 'unavailable',
      status_text: '无法核对',
      reason: `目标批次 ${targetBatch.id} 未交付所选${comment.kind === 'source' ? '原文' : `语言 ${comment.lang} 的`}文件`,
      base_batch: { id: baseBatch.id, note: baseBatch.note },
      target_batch: { id: targetBatch.id, note: targetBatch.note },
      base_file: fileRef(base.file),
      target_file: null,
      interval: intervalView(comment),
      differences: [],
    };
  }
  const target = loadFrozenFile(db, targetBatch, comment.kind, comment.lang);
  const targetTimeline = timelineOf(target.cues);
  const differences = diffInterval(base.cues, target.cues, comment.start_ms, comment.end_ms);

  // 区间必须落在目标文件时间轴内才可能“覆盖范围未变”；越界（含目标时间轴缩短/平移）
  // 一律待人工确认。
  const withinTarget = targetTimeline &&
    comment.start_ms >= targetTimeline.start_ms && comment.end_ms <= targetTimeline.end_ms;
  const status = differences.length === 0 && withinTarget ? 'unchanged' : 'manual';

  return {
    status,
    status_text: status === 'unchanged' ? '未改动' : '待人工确认',
    reason: status === 'unchanged'
      ? '区间内文本和覆盖范围均未变'
      : (!withinTarget
        ? `区间超出目标文件时间轴（${formatTimestamp(targetTimeline ? targetTimeline.start_ms : 0)} .. ${formatTimestamp(targetTimeline ? targetTimeline.end_ms : 0)}），需人工确认`
        : `区间内有 ${differences.length} 处文本或覆盖范围差异，需人工确认`),
    base_batch: { id: baseBatch.id, note: baseBatch.note },
    target_batch: { id: targetBatch.id, note: targetBatch.note },
    base_file: fileRef(base.file),
    target_file: fileRef(target.file),
    interval: {
      ...intervalView(comment),
      within_target_timeline: !!withinTarget,
      target_timeline: targetTimeline
        ? {
            start_ms: targetTimeline.start_ms, end_ms: targetTimeline.end_ms,
            start: formatTimestamp(targetTimeline.start_ms), end: formatTimestamp(targetTimeline.end_ms),
          }
        : null,
    },
    differences,
  };
}

function intervalView(comment) {
  return {
    start_ms: comment.start_ms,
    end_ms: comment.end_ms,
    start: formatTimestamp(comment.start_ms),
    end: formatTimestamp(comment.end_ms),
  };
}

/** 结论行对外视图 */
function decisionView(r) {
  return {
    id: r.id,
    comment_id: r.comment_id,
    target_batch_id: r.target_batch_id,
    verdict: r.verdict,
    verdict_text: r.verdict === 'resolved' ? '已解决' : '仍待修',
    comment_version: r.comment_version,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** 取某条意见在某目标批次上的结论行（无则 null） */
function getDecision(db, commentId, targetBatchId) {
  return db.prepare(
    'SELECT * FROM delivery_comment_decisions WHERE comment_id = ? AND target_batch_id = ?'
  ).get(commentId, targetBatchId) || null;
}

/** 一条意见的完整视图：锚定信息、命中冻结文本、全部批次结论（按目标批次倒序） */
function loadCommentView(db, projectId, commentId) {
  const row = db.prepare(
    'SELECT * FROM delivery_comments WHERE id = ? AND project_id = ?'
  ).get(commentId, projectId);
  if (!row) return null;
  const batch = getBatch(db, row.batch_id);
  const decisions = db.prepare(
    'SELECT * FROM delivery_comment_decisions WHERE comment_id = ? ORDER BY target_batch_id DESC, id DESC'
  ).all(row.id).map(decisionView);
  return {
    id: row.id,
    project_id: row.project_id,
    batch_id: row.batch_id,
    batch_note: batch ? batch.note : null,
    kind: row.kind,
    lang: row.lang,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    start: formatTimestamp(row.start_ms),
    end: formatTimestamp(row.end_ms),
    text: row.text,
    version: row.version,
    hits: JSON.parse(row.hits_json),
    decisions,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 项目下返修意见清单（按创建顺序），可按批次过滤。每条附其各目标批次结论历史。
 */
function listComments(db, projectId, batchId) {
  const rows = batchId
    ? db.prepare(
      'SELECT * FROM delivery_comments WHERE project_id = ? AND batch_id = ? ORDER BY id'
    ).all(projectId, batchId)
    : db.prepare(
      'SELECT * FROM delivery_comments WHERE project_id = ? ORDER BY id'
    ).all(projectId);
  return rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    batch_id: row.batch_id,
    kind: row.kind,
    lang: row.lang,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    start: formatTimestamp(row.start_ms),
    end: formatTimestamp(row.end_ms),
    text: row.text,
    version: row.version,
    hit_count: JSON.parse(row.hits_json).length,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

module.exports = {
  MAX_COMMENT_LEN,
  DeliveryCommentError,
  parseDeliveryCommentBody,
  parseDecisionBody,
  fileRef,
  getBatch,
  getBatchFile,
  resolveBatch,
  loadFrozenFile,
  timelineOf,
  hitsInRange,
  diffInterval,
  checkComment,
  getDecision,
  decisionView,
  loadCommentView,
  listComments,
};
