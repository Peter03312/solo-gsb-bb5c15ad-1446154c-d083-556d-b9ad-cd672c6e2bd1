'use strict';

/**
 * 译审术语对照表（glossary）：按 项目 + 目标语言 维护“源词 → 规定译法”。
 *
 * 模型：
 *   - 每项目每语言至多一张术语表（glossaries 行），整表修改（整体替换词条），
 *     修改携带读取时术语版本 version：新建（未配置）传 0，过期返回 409 与当前表；
 *   - 词与译法均为非空文本（不允许首尾空白），同一语言表内源词不得重复；
 *   - 未配置术语的语言（无 glossaries 行）不受影响，查询术语版本按 0 处理；
 *   - 按当前原文字幕文本做源词精确匹配（字面子串匹配）：命中源词的译文必须包含
 *     对应规定译法；一行命中多个源词时每个规定译法都必须出现；
 *   - 术语变更不改变既有译文的 current/review 状态：核对在查询/导出时按当前表
 *     动态进行；译文即使不合术语也可以保存供后续修正。
 *
 * 术语核对仅影响：单语言译文导出、多语言同版交付、译文署名版导出——三类导出在
 * 原有事务内读取当前术语并核对，任一缺失按行报错且不生成快照。原文导出、现有
 * 译文读写约定与旧导出快照保持兼容。
 */

const { normalizeLang } = require('./translation');

const MAX_TERM_TEXT = 100;
const MAX_TERMS = 1000;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 整表修改请求形状校验（与项目当前状态无关的部分）。
 * 合法请求：{ version, terms:[{source, target}] }；terms 必须是数组（允许空数组，
 * 表示清空该语言术语表），逐项 source/target 为非空、无首尾空白、≤100 字文本，
 * 同批 source 不得重复。
 */
function parseGlossaryBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.version) || b.version < 0) {
    errors.push('version（读取时术语版本）必须是 ≥0 的整数；未配置术语传 0');
  }
  const terms = [];
  if (!Array.isArray(b.terms)) {
    errors.push('terms 必须是数组：[{source: 源词, target: 规定译法}]（允许空数组以清空术语表）');
  } else if (b.terms.length > MAX_TERMS) {
    errors.push(`terms 数量 ${b.terms.length} 超过上限 ${MAX_TERMS}`);
  } else {
    const seen = new Set();
    b.terms.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`terms[${i}] 必须是对象 {source, target}`);
        return;
      }
      const itemErrors = [];
      if (typeof it.source !== 'string' || it.source.trim() === '') {
        itemErrors.push('source（源词）必须是非空文本');
      } else if (it.source !== it.source.trim() || it.source.length > MAX_TERM_TEXT) {
        itemErrors.push(`source 不得含首尾空白且长度 ≤ ${MAX_TERM_TEXT} 字`);
      }
      if (typeof it.target !== 'string' || it.target.trim() === '') {
        itemErrors.push('target（规定译法）必须是非空文本');
      } else if (it.target !== it.target.trim() || it.target.length > MAX_TERM_TEXT) {
        itemErrors.push(`target 不得含首尾空白且长度 ≤ ${MAX_TERM_TEXT} 字`);
      }
      if (itemErrors.length > 0) {
        errors.push(`terms[${i}]：${itemErrors.join('；')}`);
        return;
      }
      if (seen.has(it.source)) {
        errors.push(`terms[${i}] 源词 ${JSON.stringify(it.source)} 重复：同一语言术语表内源词不得重复`);
        return;
      }
      seen.add(it.source);
      terms.push({ source: it.source, target: it.target });
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0 ? { version: b.version, terms } : null,
  };
}

/** 读取某语言术语表行（不存在返回 null） */
function getGlossaryRow(db, projectId, lang) {
  return db.prepare(
    'SELECT * FROM glossaries WHERE project_id = ? AND lang = ?'
  ).get(projectId, lang) || null;
}

/** 读取某语言术语表视图：{ configured, lang, version, term_count, terms:[{source, target}] } */
function getGlossary(db, projectId, lang) {
  const row = getGlossaryRow(db, projectId, lang);
  if (!row) {
    return { configured: false, lang, version: 0, term_count: 0, terms: [] };
  }
  const terms = db.prepare(
    'SELECT source, target FROM glossary_terms WHERE glossary_id = ? ORDER BY ord'
  ).all(row.id);
  return {
    configured: true,
    lang,
    version: row.version,
    term_count: terms.length,
    terms,
    updated_at: row.updated_at,
  };
}

/** 项目全部语言的术语表总览（倒序无意义，按语言排序） */
function listGlossaries(db, projectId) {
  const rows = db.prepare(
    'SELECT id, lang, version, updated_at FROM glossaries WHERE project_id = ? ORDER BY lang'
  ).all(projectId);
  const countStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM glossary_terms WHERE glossary_id = ?'
  );
  return rows.map((r) => ({
    lang: r.lang,
    version: r.version,
    term_count: countStmt.get(r.id).n,
    updated_at: r.updated_at,
  }));
}

/**
 * 整表替换术语表（须在事务内调用）。
 *   - 不存在且 version=0 → 建表（版本 1）并写入词条；
 *   - 已存在且 version 等于当前版本 → 替换全部词条，版本 +1（允许空数组，即清空）；
 *   - 版本不符 → 抛出 StaleGlossaryError，调用方按 409 返回当前表。
 * 返回写入后的术语表视图。
 */
class StaleGlossaryError extends Error {
  constructor(current) {
    super('术语版本过期');
    this.name = 'StaleGlossaryError';
    this.current = current;
  }
}

function replaceGlossary(db, projectId, lang, request) {
  const existing = getGlossaryRow(db, projectId, lang);
  if (!existing && request.version !== 0) {
    throw new StaleGlossaryError(getGlossary(db, projectId, lang));
  }
  if (existing && request.version !== existing.version) {
    throw new StaleGlossaryError(getGlossary(db, projectId, lang));
  }

  let glossaryId;
  let nextVersion;
  if (existing) {
    db.prepare(
      `UPDATE glossaries SET version = version + 1, updated_at = datetime('now') WHERE id = ?`
    ).run(existing.id);
    db.prepare('DELETE FROM glossary_terms WHERE glossary_id = ?').run(existing.id);
    glossaryId = existing.id;
    nextVersion = existing.version + 1;
  } else {
    glossaryId = db.prepare(
      'INSERT INTO glossaries (project_id, lang, version) VALUES (?, ?, 1)'
    ).run(projectId, lang).lastInsertRowid;
    nextVersion = 1;
  }
  const ins = db.prepare(
    'INSERT INTO glossary_terms (glossary_id, ord, source, target) VALUES (?, ?, ?, ?)'
  );
  request.terms.forEach((t, i) => ins.run(glossaryId, i, t.source, t.target));
  return getGlossary(db, projectId, lang);
}

/**
 * 按当前原文字幕文本精确匹配源词，核对一条译文的术语合规情况。
 *   sourceText 当前原文字幕文本；translationText 译文文本（无译文传 null）；
 *   terms      [{source, target}]（未配置/空表 → 返回空结果）。
 * 返回 { matched:[{source, target}], missing:[{source, target, reason}] }：
 *   matched 源文命中的全部术语（一行命中多词全部列出）；
 *   missing 译文缺失（无译文或未包含规定译法）的术语，逐条带中文原因。
 */
function checkTerms(sourceText, translationText, terms) {
  const matched = [];
  const missing = [];
  if (!Array.isArray(terms) || terms.length === 0) return { matched, missing };
  for (const t of terms) {
    if (sourceText.includes(t.source)) {
      matched.push({ source: t.source, target: t.target });
      if (translationText === null || translationText === undefined) {
        missing.push({
          source: t.source,
          target: t.target,
          reason: `原文命中源词 ${JSON.stringify(t.source)}，但该字幕尚无译文，规定译法 ${JSON.stringify(t.target)} 缺失`,
        });
      } else if (!translationText.includes(t.target)) {
        missing.push({
          source: t.source,
          target: t.target,
          reason: `原文命中源词 ${JSON.stringify(t.source)}，译文须包含规定译法 ${JSON.stringify(t.target)}`,
        });
      }
    }
  }
  return { matched, missing };
}

/**
 * 导出/交付前术语核对：对一组字幕逐行检查（未配置术语的语言直接通过）。
 *   cues         当前字幕行（按展示顺序），每行至少 {id, idx, text}；
 *   translationByCue  Map(subtitle_id -> 译文行 {text, status, version})（无译文可缺键）；
 *   glossary     getGlossary 结果。
 * 仅报告“其余条件已满足”的行上的术语缺失：无译文/待复核/规则无效等问题由各自的
 * 既有分类负责，术语不重复拦截（修正这些问题后会再次按当前术语核对）。即调用方
 * 传入 onlyCueIds（通过既有核对的字幕 ID 集合）；省略则核对全部行（专用查询接口用）。
 * 返回 { version, configured, rows:[{subtitle_id, idx, source_text, matched, missing}] }，
 * rows 仅含存在缺失术语的行。
 */
function evaluateTerms(cues, translationByCue, glossary, onlyCueIds) {
  const rows = [];
  if (!glossary || !glossary.configured || glossary.terms.length === 0) {
    return { configured: false, version: (glossary && glossary.version) || 0, rows };
  }
  for (const cue of cues) {
    if (onlyCueIds && !onlyCueIds.has(cue.id)) continue;
    const tr = translationByCue && translationByCue.get ? translationByCue.get(cue.id) : null;
    const { matched, missing } = checkTerms(cue.text, tr ? tr.text : null, glossary.terms);
    if (missing.length > 0) {
      rows.push({
        subtitle_id: cue.id,
        idx: cue.idx,
        source_text: cue.text,
        ...(tr ? { translation: { version: tr.version, status: tr.status, text: tr.text } } : {}),
        matched,
        missing,
      });
    }
  }
  return { configured: true, version: glossary.version, rows };
}

module.exports = {
  MAX_TERM_TEXT,
  MAX_TERMS,
  normalizeLang,
  parseGlossaryBody,
  StaleGlossaryError,
  getGlossaryRow,
  getGlossary,
  listGlossaries,
  replaceGlossary,
  checkTerms,
  evaluateTerms,
};
