'use strict';

/**
 * 片方交付批次对照（只读）：输入同一项目的基准批次与目标批次 ID，
 * 以两批各自冻结的 WebVTT 快照为准，按字幕起止时间区段比较实际显示文本。
 *
 * 规则：
 *   - 批次不存在或不属于该项目 → 明确拒绝（不做任何比较）；
 *   - 文件语言取两批并集：只在目标批出现的语言标 added（新增），
 *     只在基准批出现的语言标 removed（移除）；原文（source）两批必有；
 *   - 双方都有的文件严格解析各自冻结快照，按起止时间构成的区段比较显示文本，
 *     拆分/合并/整体移时按时间区段对齐，绝不按行号配对；空字幕（''）与无字幕
 *     （null，时间空档）之间的转换同样如实列出；
 *   - 相邻差异区段在两侧各自显示文本跨边界均未变化时合并为一条；
 *   - 任一文件快照缺失（导出行不存在）或格式损坏（WebVTT 解析失败、cue 数与
 *     冻结清单不符）→ 指出批次与文件，整份报告失败，不返回任何部分结果。
 *
 * 整个过程只执行 SELECT：不受当前字幕、译文、术语的后续修改影响。
 */

const { parseWebVtt, diffCueSegments, formatTimestamp } = require('./vtt');

/** 对照失败：携带 HTTP 状态码与完整 payload（快照问题一次性全部给出） */
class BatchDiffError extends Error {
  constructor(statusCode, payload) {
    super(payload.error || '交付批次对照失败');
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function isIntId(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
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

/** 取某份交付文件对应的冻结快照行；导出行缺失返回 undefined */
function getSnapshotRow(db, f) {
  if (f.export_kind !== 'exports' && f.export_kind !== 'translation_exports') {
    throw new UnknownExportKindError(f.export_kind);
  }
  const table = f.export_kind === 'exports' ? 'exports' : 'translation_exports';
  return db.prepare(`SELECT content, cue_count FROM ${table} WHERE id = ?`).get(f.export_id);
}
class UnknownExportKindError extends Error {
  constructor(kind) {
    super(`未知导出序列 ${JSON.stringify(kind)}`);
    this.name = 'UnknownExportKindError';
  }
}

/**
 * 构造批次对照报告。
 * @returns 报告对象（见路由文档 / README）；失败抛 BatchDiffError
 */
function buildDeliveryDiff(db, projectId, rawBaseId, rawTargetId) {
  // 1. 入参：两个正整数批次 ID
  const baseId = typeof rawBaseId === 'number' ? rawBaseId : Number(rawBaseId);
  const targetId = typeof rawTargetId === 'number' ? rawTargetId : Number(rawTargetId);
  if (!isIntId(baseId) || !isIntId(targetId)) {
    throw new BatchDiffError(400, {
      error: '批次对照参数非法：base_id 与 target_id 必须是 ≥1 的整数批次 ID',
    });
  }

  // 2. 批次存在性与归属（先按全局 ID 取行，以便区分“不存在”与“不属于该项目”）
  const resolveBatch = (id, role) => {
    const b = db.prepare('SELECT * FROM delivery_batches WHERE id = ?').get(id);
    if (!b) {
      throw new BatchDiffError(404, {
        error: `${role === 'base' ? '基准' : '目标'}批次 ${id} 不存在，已拒绝对照`,
        reason_code: 'batch_not_found',
        role,
        batch_id: id,
      });
    }
    if (b.project_id !== projectId) {
      throw new BatchDiffError(404, {
        error: `${role === 'base' ? '基准' : '目标'}批次 ${id} 不属于项目 ${projectId}（属于项目 ${b.project_id}），拒绝跨项目对照`,
        reason_code: 'batch_other_project',
        role,
        batch_id: id,
        actual_project_id: b.project_id,
      });
    }
    return b;
  };
  const baseBatch = resolveBatch(baseId, 'base');
  const targetBatch = resolveBatch(targetId, 'target');

  const listFiles = (batchId) => db.prepare(
    'SELECT * FROM delivery_files WHERE batch_id = ? ORDER BY ord'
  ).all(batchId);
  const baseFilesAll = listFiles(baseBatch.id);
  const targetFilesAll = listFiles(targetBatch.id);

  // 3. 快照完整性预检：任何一份缺失/损坏 → 整份报告失败，不返回部分结果。
  //    先收集全部问题一次性指出（批次 + 文件 + 原因）。
  const problems = [];
  const parsed = new Map(); // side + ':' + ord -> cues

  const inspectSide = (side, batch, filesAll) => {
    const files = filesAll.filter((f) => f.kind === 'source' || f.kind === 'translation');
    const sourceCount = filesAll.filter((f) => f.kind === 'source').length;
    const transCount = filesAll.filter((f) => f.kind === 'translation').length;
    if (sourceCount !== 1) {
      problems.push({
        side, batch_id: batch.id, file: null, problem: 'manifest_corrupt',
        reason: `批次清单原文文件数为 ${sourceCount}（每批必须恰好 1 个 kind=source 文件）`,
      });
    }
    if (transCount !== batch.lang_count) {
      problems.push({
        side, batch_id: batch.id, file: null, problem: 'manifest_corrupt',
        reason: `批次清单译文文件数 ${transCount} 与冻结的 lang_count=${batch.lang_count} 不一致`,
      });
    }
    const ordZero = filesAll.find((f) => f.ord === 0);
    if (ordZero && ordZero.kind !== 'source') {
      problems.push({
        side, batch_id: batch.id, file: fileRef(ordZero), problem: 'manifest_corrupt',
        reason: 'ord=0 必须是原文文件（kind=source）',
      });
    }
    // ord 重复 / 异常 kind / 译文语言缺失或重复 也是清单损坏
    const ords = new Set();
    const langs = new Set();
    for (const f of filesAll) {
      if (ords.has(f.ord)) {
        problems.push({
          side, batch_id: batch.id, file: fileRef(f), problem: 'manifest_corrupt',
          reason: `批次清单 ord=${f.ord} 重复`,
        });
      }
      ords.add(f.ord);
      if (f.kind !== 'source' && f.kind !== 'translation') {
        problems.push({
          side, batch_id: batch.id, file: fileRef(f), problem: 'manifest_corrupt',
          reason: `文件 kind=${JSON.stringify(f.kind)} 非法（只允许 source/translation）`,
        });
      }
      if (f.kind === 'translation') {
        if (!f.lang) {
          problems.push({
            side, batch_id: batch.id, file: fileRef(f), problem: 'manifest_corrupt',
            reason: `译文文件 ord=${f.ord} 缺少语言代号 lang`,
          });
        } else if (langs.has(f.lang)) {
          problems.push({
            side, batch_id: batch.id, file: fileRef(f), problem: 'manifest_corrupt',
            reason: `批次清单中语言 ${f.lang} 重复出现`,
          });
        }
        langs.add(f.lang);
      }
    }
    for (const f of files) {
      const ref = fileRef(f);
      const label = `${f.kind === 'source' ? '原文' : `语言 ${f.lang}`} v${f.version}`;
      let row;
      try {
        row = getSnapshotRow(db, f);
      } catch (err) {
        if (err instanceof UnknownExportKindError) {
          problems.push({
            side, batch_id: batch.id, file: ref, problem: 'manifest_corrupt',
            reason: `批次清单指向未知导出序列 ${JSON.stringify(f.export_kind)}（export_id=${f.export_id}）`,
          });
          continue;
        }
        throw err;
      }
      if (!row) {
        problems.push({
          side, batch_id: batch.id, file: ref, problem: 'snapshot_missing',
          reason: `${label} 的冻结 WebVTT 快照缺失（${f.export_kind} id=${f.export_id} 行不存在）`,
        });
        continue;
      }
      const r = parseWebVtt(row.content);
      if (!r.ok) {
        problems.push({
          side, batch_id: batch.id, file: ref, problem: 'snapshot_corrupt',
          reason: `${label} 的 WebVTT 快照格式损坏：${r.reason}`,
        });
        continue;
      }
      if (r.cues.length !== f.cue_count) {
        problems.push({
          side, batch_id: batch.id, file: ref, problem: 'snapshot_corrupt',
          reason: `${label} 的快照实际 cue 数 ${r.cues.length} 与批次清单冻结的 ${f.cue_count} 不一致`,
        });
        continue;
      }
      parsed.set(`${side}:${f.ord}`, r.cues);
    }
  };

  inspectSide('base', baseBatch, baseFilesAll);
  inspectSide('target', targetBatch, targetFilesAll);

  if (problems.length > 0) {
    throw new BatchDiffError(500, {
      error:
        `交付批次 ${baseBatch.id} → ${targetBatch.id} 的对照因快照问题整份失败` +
        `（${problems.length} 处）：快照缺失或格式损坏，未返回任何对照结果`,
      project_id: projectId,
      base_id: baseBatch.id,
      target_id: targetBatch.id,
      snapshot_problems: problems,
    });
  }

  // 4. 组装两批文件并集（原文 + 语言并集）。语言顺序：基准批顺序在前，
  //    目标批独有的语言按目标批顺序追加。
  const baseSource = baseFilesAll.find((f) => f.kind === 'source');
  const targetSource = targetFilesAll.find((f) => f.kind === 'source');
  const baseLangFiles = baseFilesAll.filter((f) => f.kind === 'translation');
  const targetLangFiles = targetFilesAll.filter((f) => f.kind === 'translation');
  const baseLangMap = new Map(baseLangFiles.map((f) => [f.lang, f]));
  const targetLangMap = new Map(targetLangFiles.map((f) => [f.lang, f]));

  const orderedLangs = [];
  for (const f of baseLangFiles) {
    if (!orderedLangs.includes(f.lang)) orderedLangs.push(f.lang);
  }
  for (const f of targetLangFiles) {
    if (!orderedLangs.includes(f.lang)) orderedLangs.push(f.lang);
  }

  const files = [];

  // 原文：两批都有
  files.push(buildFileEntry('source', null, baseSource, targetSource, parsed));

  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;

  for (const lang of orderedLangs) {
    const bf = baseLangMap.get(lang) || null;
    const tf = targetLangMap.get(lang) || null;
    const entry = buildFileEntry('translation', lang, bf, tf, parsed);
    files.push(entry);
    if (entry.status === 'added') addedCount++;
    else if (entry.status === 'removed') removedCount++;
    else if (entry.diff_count > 0) changedCount++;
    else unchangedCount++;
  }

  // 原文状态计入统计
  if (files[0].diff_count > 0) changedCount++;
  else unchangedCount++;

  const differenceCount = files.reduce((n, f) => n + (f.differences ? f.differences.length : 0), 0);

  return {
    project_id: projectId,
    base: batchSummary(baseBatch),
    target: batchSummary(targetBatch),
    same_batch: baseBatch.id === targetBatch.id,
    languages: {
      union: orderedLangs,
      base_only: orderedLangs.filter((l) => baseLangMap.has(l) && !targetLangMap.has(l)),
      target_only: orderedLangs.filter((l) => !baseLangMap.has(l) && targetLangMap.has(l)),
    },
    summary: {
      file_count: files.length,
      changed: changedCount,        // 双方都有且存在差异区段的文件数
      unchanged: unchangedCount,    // 双方都有且无差异的文件数
      added: addedCount,            // 目标批新增语言数
      removed: removedCount,        // 目标批移除语言数
      difference_count: differenceCount, // 差异区段总数（不含整文件新增/移除）
    },
    files,
  };
}

/**
 * 构造单个文件（原文或某语言）的对照条目。
 * 双侧都有：按时间区段比较；单侧：标 added/removed，不产生区段明细。
 */
function buildFileEntry(kind, lang, baseFile, targetFile, parsed) {
  if (!baseFile && targetFile) {
    return {
      kind, lang, status: 'added',
      base: null,
      target: fileRef(targetFile),
      diff_count: 0,
      differences: [],
    };
  }
  if (baseFile && !targetFile) {
    return {
      kind, lang, status: 'removed',
      base: fileRef(baseFile),
      target: null,
      diff_count: 0,
      differences: [],
    };
  }

  const baseCues = parsed.get(`base:${baseFile.ord}`);
  const targetCues = parsed.get(`target:${targetFile.ord}`);
  const segments = diffCueSegments(baseCues, targetCues);
  const differences = segments.map((s) => ({
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    start: formatTimestamp(s.start_ms),
    end: formatTimestamp(s.end_ms),
    base_text: s.base_text,
    target_text: s.target_text,
    base_version: baseFile.version,
    target_version: targetFile.version,
  }));

  return {
    kind,
    lang,
    status: 'both',
    base: fileRef(baseFile),
    target: fileRef(targetFile),
    diff_count: differences.length,
    differences,
  };
}

module.exports = { buildDeliveryDiff, BatchDiffError };
