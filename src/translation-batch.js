'use strict';

/**
 * 译者整批译文回填（按一种目标语言一次回填到当前字幕）：
 *
 * 请求携带：
 *   - batch_no        译者批次编号（非空、≤64 字）；
 *   - lang            一种目标语言代号（路径参数，须合法）；
 *   - sub_version     读取字幕集时的字幕集版本；
 *   - rules_version   读取时的规则版本；
 *   - items[]         非空逐行清单，每项 { subtitle_id, cue_version, version, text }：
 *                     cue_version 为读取时源行版本；version 为译文版本（新建 0/省略），
 *                     text 为非空译文文本。同批 subtitle_id 不得重复。
 *
 * 处理规则：
 *   - 形状问题（空清单、重复 ID、字段非法、语言非法）→ 400，整批拒绝；
 *     字幕行不存在同样在写入前拒绝（不进入事务、不占编号）。
 *   - 提交时重新核对版本、源行与现行字数/字速规则：
 *       字幕集/规则版本漂移、源行版本过期、译文版本过期/已存在却按新建、
 *       源行不存在等“过期”类 → 409；
 *       译文文本超 max_chars / max_cps → 422。
 *     任一行过期或违规，按行返回当前值与原因，整批不写入。
 *   - 通过后在同一事务保存全部译文：新建版本从 1 开始；更新（允许覆盖待复核译文）
 *     版本递增并把源快照刷新为 current；未列出的行与其他语言不变。
 *   - 幂等：同项目同语言 batch_no 重复且内容相同 → 返回首次结果（200，不再写入）；
 *     batch_no 相同但内容不同 → 409 冲突；失败批次不占编号。
 *
 * 回填结果就是普通译文，现有逐行译文操作、单语言导出与多语交付继续读取；
 * 旧导出快照内容保持不变。
 */

const crypto = require('crypto');
const { normalizeLang, checkTranslationText } = require('./translation');

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_BATCH_NO_LEN = 64;

/**
 * 回填请求形状校验（与项目当前状态无关的部分）。lang 已由路径层归一化。
 * 返回 { ok, errors, request }；request 为归一化后的
 * { batch_no, note, sub_version, rules_version,
 *   items: [{ subtitle_id, cue_version, version, text }] }。
 */
function parseTranslationBatchBody(body, lang) {
  const errors = [];
  const b = body || {};

  if (typeof b.batch_no !== 'string') {
    errors.push('batch_no（译者批次编号）必须是非空字符串');
  } else {
    const batchNo = b.batch_no.trim();
    if (batchNo === '') {
      errors.push('batch_no（译者批次编号）不能为空');
    } else if (batchNo.length > MAX_BATCH_NO_LEN) {
      errors.push(`batch_no 长度 ${batchNo.length} 超过上限 ${MAX_BATCH_NO_LEN} 字`);
    } else if (batchNo !== b.batch_no) {
      errors.push(`batch_no 含首尾空白，请提交规范化形式 "${batchNo}"`);
    }
  }

  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.rules_version) || b.rules_version < 1) {
    errors.push('rules_version（读取时规则版本）必须是 ≥1 的整数');
  }
  const note = b.note !== undefined && b.note !== null ? String(b.note) : '';

  const items = [];
  if (!Array.isArray(b.items)) {
    errors.push('items 必须是非空数组：逐行清单 [{subtitle_id, cue_version, version, text}]');
  } else if (b.items.length === 0) {
    errors.push('items 不能为空：整批回填至少包含一行译文');
  } else {
    const seenCues = new Set();
    b.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`items[${i}] 必须是对象 {subtitle_id, cue_version, version, text}`);
        return;
      }
      const itemErrors = [];
      if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
        itemErrors.push('subtitle_id 必须是 ≥1 的整数');
      }
      if (!isInt(it.cue_version) || it.cue_version < 1) {
        itemErrors.push('cue_version（读取时源字幕行版本）必须是 ≥1 的整数');
      }
      let version = 0;
      if (it.version !== undefined && it.version !== null) {
        if (!isInt(it.version) || it.version < 0) {
          itemErrors.push('version（译文版本）必须是 ≥0 的整数；新建传 0 或省略，更新传当前版本');
        } else {
          version = it.version;
        }
      }
      if (typeof it.text !== 'string' || it.text.trim() === '') {
        itemErrors.push('text（译文文本）必须是非空字符串');
      }
      if (itemErrors.length > 0) {
        errors.push(`items[${i}]：${itemErrors.join('；')}`);
        return;
      }
      if (seenCues.has(it.subtitle_id)) {
        errors.push(`items 中字幕 ${it.subtitle_id} 重复出现：同批逐行清单每个字幕 ID 只能出现一次`);
        return;
      }
      seenCues.add(it.subtitle_id);
      items.push({
        subtitle_id: it.subtitle_id,
        cue_version: it.cue_version,
        version,
        text: it.text,
      });
    });
  }

  // 语言由路径层校验（getLang）；此处兜底，理论上不会走到
  if (!normalizeLang(lang)) errors.push('lang（目标语言代号）非法');

  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? { batch_no: b.batch_no.trim(), note, sub_version: b.sub_version,
          rules_version: b.rules_version, items }
      : null,
  };
}

/**
 * 归一化内容指纹：同项目同语言同批次编号下，用于判断“内容相同（幂等重放）”还是
 * “内容不同（冲突）”。指纹对清单按 subtitle_id 排序，使提交顺序不影响判定；
 * 覆盖语言、读取时版本与逐行（源行版本/译文版本/文本），不含 batch_no/note。
 */
function contentHash(projectId, lang, request) {
  const canonical = {
    project_id: projectId,
    lang,
    sub_version: request.sub_version,
    rules_version: request.rules_version,
    items: request.items
      .map((it) => ({
        subtitle_id: it.subtitle_id,
        cue_version: it.cue_version,
        version: it.version,
        text: it.text,
      }))
      .sort((a, b) => a.subtitle_id - b.subtitle_id),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * 事务内整批核对（对权威当前状态执行）。
 *
 * project：loadProject 结果；request：parseTranslationBatchBody 通过后的 request；
 * activeByCue：Map(subtitle_id -> translationRow)，该语言非历史译文。
 *
 * 返回：
 *   { sub_version_stale, rules_version_stale,
 *     items: [{ ord, subtitle_id, cue_version, version, text,
 *              state: ok|cue_missing|cue_version_stale|translation_missing|
 *                     translation_exists|translation_version_stale|invalid,
 *              action: created|updated|null, result_version, cue, current, reasons }] }
 *
 * 过期类（顶层版本漂移 / cue_missing / cue_version_stale / translation_missing /
 * translation_exists / translation_version_stale）由路由按 409 处理；
 * 仅 invalid（违反现行字数/字速）按 422 处理。任一行非 ok 整批不写入。
 */
function evaluateBatch(project, lang, request, activeByCue) {
  const cueById = new Map(project.subtitles.map((c) => [c.id, c]));

  const items = request.items.map((it, ord) => {
    const out = {
      ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      version: it.version,
      text: it.text,
      state: 'ok',
      action: null,
      result_version: null,
      cue: null,
      current: null,
      reasons: [],
    };
    const cue = cueById.get(it.subtitle_id);
    if (!cue) {
      out.state = 'cue_missing';
      out.reasons.push(
        `字幕 ${it.subtitle_id} 在当前字幕集（v${project.sub_version}）中不存在（可能已被重排删除），请刷新后重新提交`
      );
      return out;
    }
    out.cue = cue;
    if (it.cue_version !== cue.version) {
      out.state = 'cue_version_stale';
      out.reasons.push(
        `源字幕行版本过期：提交基于 v${it.cue_version}，当前已是 v${cue.version}`
      );
    }
    const row = activeByCue.get(it.subtitle_id);
    out.current = row || null;
    if (row) {
      if (it.version === 0) {
        out.state = 'translation_exists';
        out.reasons.push(
          `语言 ${lang} 在字幕 ${cue.id} 上已存在译文 v${row.version}` +
          `（${row.status === 'review' ? '待复核' : '当前'}）：覆盖更新须携带其 version`
        );
      } else if (it.version !== row.version) {
        out.state = 'translation_version_stale';
        out.reasons.push(
          `译文版本过期：提交基于 v${it.version}，当前已是 v${row.version}`
        );
      }
    } else if (it.version > 0) {
      out.state = 'translation_missing';
      out.reasons.push(
        `字幕 ${cue.id} 上没有可更新的当前译文：新建请把 version 传 0 或省略（旧译文可能已随源行删除留作历史，不按序号挪用）`
      );
    }
    // 过期类优先：已过期/失效的行不再重复报规则违规
    if (out.state === 'ok') {
      const ruleReasons = checkTranslationText(it.text, cue, project.rules);
      if (ruleReasons.length > 0) {
        out.state = 'invalid';
        out.reasons.push(...ruleReasons);
      }
    }
    return out;
  });

  return {
    sub_version_stale: request.sub_version !== project.sub_version,
    rules_version_stale: request.rules_version !== project.rules.version,
    sub_version_current: project.sub_version,
    rules_version_current: project.rules.version,
    items,
  };
}

const mapItemRow = (r) => ({
  ord: r.ord,
  subtitle_id: r.subtitle_id,
  cue_version: r.cue_version,
  version: r.version,
  text: r.text,
  action: r.action,
  result_version: r.result_version,
});

/** 项目下（可按语言过滤）回填批次摘要，按批次倒序 */
function listBatches(db, projectId, lang) {
  const rows = lang
    ? db.prepare(
      `SELECT * FROM translation_batches WHERE project_id = ? AND lang = ? ORDER BY id DESC`
    ).all(projectId, lang)
    : db.prepare(
      'SELECT * FROM translation_batches WHERE project_id = ? ORDER BY id DESC'
    ).all(projectId);
  return rows.map((b) => ({
    id: b.id,
    project_id: b.project_id,
    batch_no: b.batch_no,
    lang: b.lang,
    note: b.note,
    sub_version: b.sub_version,
    rules_version: b.rules_version,
    item_count: b.item_count,
    created_count: b.created_count,
    updated_count: b.updated_count,
    created_at: b.created_at,
  }));
}

/** 单个回填批次（含逐行清单与写入结果）。不存在返回 null。 */
function loadBatch(db, projectId, batchId) {
  const b = db.prepare(
    'SELECT * FROM translation_batches WHERE id = ? AND project_id = ?'
  ).get(batchId, projectId);
  if (!b) return null;
  const items = db.prepare(
    'SELECT * FROM translation_batch_items WHERE batch_id = ? ORDER BY ord'
  ).all(b.id).map(mapItemRow);
  return {
    id: b.id,
    project_id: b.project_id,
    batch_no: b.batch_no,
    lang: b.lang,
    note: b.note,
    sub_version: b.sub_version,
    rules_version: b.rules_version,
    item_count: b.item_count,
    created_count: b.created_count,
    updated_count: b.updated_count,
    created_at: b.created_at,
    items,
  };
}

module.exports = {
  MAX_BATCH_NO_LEN,
  parseTranslationBatchBody,
  contentHash,
  evaluateBatch,
  listBatches,
  loadBatch,
};
