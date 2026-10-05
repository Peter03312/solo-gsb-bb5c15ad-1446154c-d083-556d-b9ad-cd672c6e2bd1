'use strict';

/**
 * 说话人标注与署名版导出。
 *
 * 说话人名册：
 *   - 项目内维护“说话人编号 number（1 起、不回收、不可变）→ 显示名 display_name”；
 *   - 显示名可修改，修改推进归属版本 projects.attribution_version（归属标注写入同样推进）；
 *   - 显示名不得含换行或 WebVTT 标签界定符（<、>），保证署名标签语法合法。
 *
 * 归属标注：
 *   - 归属按字幕 ID 锚定，与展示序号无关：重排保留 ID 的行归属继续有效（仅 idx 变化、
 *     原地更新都不失效）；原行删除后归属留作历史（status=history, subtitle_id 置空），
 *     新行待标注，绝不按展示序号转移；
 *   - 提交按字幕 ID 携带读取时行版本 cue_version 与归属版本 attribution_version；
 *     speaker_number 必须存在；锁定行也可标注；过期（归属版本/行版本/行已删除）返回当前值。
 *
 * 署名版导出：
 *   - 请求携带字幕集版本 sub_version 与归属版本 attribution_version，同一事务内核对
 *     每条当前字幕均有有效归属（且说话人仍在名册、显示名可安全写入标签）；
 *   - 可选择原文（不带 lang）或一种目标语言（带 lang 与逐行译文版本清单 translations）；
 *     译文须逐行 current、版本未变且满足现行字数/字速，否则按行列原因，不生成快照；
 *   - 原文与译文共用源字幕时间轴；正文按 WebVTT 语法写 `<v 显示名>文本</v>`；
 *   - 快照存入 attributed_exports（独立序列，不可变、可查询、可下载），
 *     普通 exports / translation_exports 与旧下载内容保持不变。
 */

const { validateStructure, validateRules } = require('./layout');
const { normalizeLang, checkTranslationText, activeTranslationsByLang } = require('./translation');
const { getGlossary, checkTerms } = require('./glossary');

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_NAME_LEN = 64;

/**
 * 说话人显示名校验：非空、≤64 字、不含任何换行（\n \r 及其他 Unicode 行分隔符）
 * 与 WebVTT 标签界定符 <、>；不允许首尾空白。返回中文原因列表，空数组表示通过。
 */
function validateSpeakerName(name) {
  const reasons = [];
  if (typeof name !== 'string') {
    reasons.push('display_name（显示名）必须是非空字符串');
    return reasons;
  }
  const trimmed = name.trim();
  if (trimmed === '') {
    reasons.push('display_name（显示名）不能为空');
    return reasons;
  }
  if (trimmed !== name) {
    reasons.push('display_name 不得含首尾空白');
  }
  if (trimmed.length > MAX_NAME_LEN) {
    reasons.push(`display_name 长度 ${trimmed.length} 超过上限 ${MAX_NAME_LEN} 字`);
  }
  if (/[\n\r\u0085\u2028\u2029]/.test(name)) {
    reasons.push('display_name 不得包含换行符（署名版 WebVTT 的说话人标签必须单行）');
  }
  if (name.includes('<') || name.includes('>')) {
    reasons.push('display_name 不得包含 WebVTT 标签界定符 "<" 或 ">"');
  }
  return reasons;
}

/** 项目内说话人名册（编号升序），附当前有效归属条数 */
function listSpeakers(db, projectId) {
  const rows = db.prepare(
    `SELECT sp.id, sp.number, sp.display_name, sp.created_at, sp.updated_at,
            (SELECT COUNT(*) FROM attributions a
              WHERE a.speaker_id = sp.id AND a.status = 'active') AS attribution_count
       FROM speakers sp WHERE sp.project_id = ? ORDER BY sp.number`
  ).all(projectId);
  return rows;
}

/** 按编号取说话人（项目内），不存在返回 null */
function getSpeakerByNumber(db, projectId, number) {
  return db.prepare(
    'SELECT * FROM speakers WHERE project_id = ? AND number = ?'
  ).get(projectId, number) || null;
}

/** 新建说话人：编号取项目内 MAX(number)+1（不回收），返回新行 */
function createSpeaker(db, projectId, displayName) {
  const next = (db.prepare(
    'SELECT COALESCE(MAX(number), 0) AS n FROM speakers WHERE project_id = ?'
  ).get(projectId).n) + 1;
  const info = db.prepare(
    'INSERT INTO speakers (project_id, number, display_name) VALUES (?, ?, ?)'
  ).run(projectId, next, displayName);
  return db.prepare('SELECT * FROM speakers WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * 修改说话人显示名（改名推进归属版本）。
 * 返回 { speaker, attribution_version }。调用方须先完成 attribution_version 乐观锁核对。
 */
function renameSpeaker(db, projectId, speakerId, displayName) {
  db.prepare(
    `UPDATE speakers SET display_name = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(displayName, speakerId);
  const { bumpAttributionVersion } = require('./db');
  const attributionVersion = bumpAttributionVersion(db, projectId);
  return {
    speaker: db.prepare('SELECT * FROM speakers WHERE id = ?').get(speakerId),
    attribution_version: attributionVersion,
  };
}

/**
 * 源字幕行删除后的归属对账：active 归属若锚定的字幕行已不存在
 * （重排删除、词修正确认删除、重新导入），转 history 并置空 subtitle_id；
 * 保留 ID 的行（含仅顺序变化、原地更新）归属继续有效；绝不按展示序号转移。
 * 返回转历史的条数。
 */
function syncAttributions(db, projectId) {
  return db.prepare(
    `UPDATE attributions
        SET status = 'history', subtitle_id = NULL, updated_at = datetime('now')
      WHERE project_id = ? AND status = 'active'
        AND (subtitle_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM subtitles s WHERE s.id = subtitle_id))`
  ).run(projectId).changes;
}

/**
 * 归属批量提交请求形状校验（与项目当前状态无关的部分）。
 * 合法请求：{ attribution_version, items:[{subtitle_id, cue_version, speaker_number}] }
 * items 不得为空、同批字幕 ID 不得重复。
 */
function parseAttributionBatchBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.attribution_version) || b.attribution_version < 0) {
    errors.push('attribution_version（读取时归属版本）必须是 ≥0 的整数');
  }
  const items = [];
  if (!Array.isArray(b.items)) {
    errors.push('items 必须是非空数组：[{subtitle_id, cue_version, speaker_number}]');
  } else if (b.items.length === 0) {
    errors.push('items 不能为空：一次至少标注一条字幕');
  } else {
    const seen = new Set();
    b.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`items[${i}] 必须是对象 {subtitle_id, cue_version, speaker_number}`);
        return;
      }
      const itemErrors = [];
      if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
        itemErrors.push('subtitle_id 必须是 ≥1 的整数');
      }
      if (!isInt(it.cue_version) || it.cue_version < 1) {
        itemErrors.push('cue_version（读取时字幕行版本）必须是 ≥1 的整数');
      }
      if (!isInt(it.speaker_number) || it.speaker_number < 1) {
        itemErrors.push('speaker_number（说话人编号）必须是 ≥1 的整数');
      }
      if (itemErrors.length > 0) {
        errors.push(`items[${i}]：${itemErrors.join('；')}`);
        return;
      }
      if (seen.has(it.subtitle_id)) {
        errors.push(`items 中字幕 ${it.subtitle_id} 重复出现：同批每条字幕只能标注一次`);
        return;
      }
      seen.add(it.subtitle_id);
      items.push({
        subtitle_id: it.subtitle_id,
        cue_version: it.cue_version,
        speaker_number: it.speaker_number,
      });
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0 ? { attribution_version: b.attribution_version, items } : null,
  };
}

/**
 * 事务内整批核对（对权威当前状态执行）。
 *
 * project：loadProject 结果（含 attribution_version、subtitles、speakers、attributions）。
 * 返回：
 *   { attribution_version_stale,
 *     items: [{ ord, subtitle_id, cue_version, speaker_number,
 *               state: ok|cue_missing|cue_version_stale|speaker_missing,
 *               cue, speaker, existing, reasons }] }
 * cue_missing / cue_version_stale 属过期类（路由按 409 返回当前值）；
 * speaker_missing 为无效引用（路由按 400，附当前名册）。锁定行允许标注（无 locked 状态）。
 */
function evaluateAttributionBatch(project, request) {
  const cueById = new Map(project.subtitles.map((c) => [c.id, c]));
  const speakerByNumber = new Map(project.speakers.map((s) => [s.number, s]));
  const existingByCue = new Map(project.attributions.map((a) => [a.subtitle_id, a]));

  const items = request.items.map((it, ord) => {
    const out = {
      ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      speaker_number: it.speaker_number,
      state: 'ok',
      cue: null,
      speaker: null,
      existing: existingByCue.get(it.subtitle_id) || null,
      reasons: [],
    };
    const cue = cueById.get(it.subtitle_id);
    if (!cue) {
      out.state = 'cue_missing';
      out.reasons.push(
        `字幕 ${it.subtitle_id} 在当前字幕集（v${project.sub_version}）中不存在` +
        '（可能已被重排删除）：请刷新后按当前字幕 ID 重新标注'
      );
      return out;
    }
    out.cue = cue;
    if (it.cue_version !== cue.version) {
      out.state = 'cue_version_stale';
      out.reasons.push(
        `字幕行版本过期：提交基于 v${it.cue_version}，当前已是 v${cue.version}`
      );
    }
    const speaker = speakerByNumber.get(it.speaker_number);
    if (!speaker) {
      out.state = 'speaker_missing';
      out.reasons.push(
        `说话人编号 ${it.speaker_number} 不存在：请先用名册接口建立说话人，再提交标注`
      );
      return out;
    }
    out.speaker = speaker;
    return out;
  });

  return {
    attribution_version_stale: request.attribution_version !== project.attribution_version,
    attribution_version_current: project.attribution_version,
    items,
  };
}

/**
 * 写入整批归属（须在 evaluateAttributionBatch 全部通过后、同一事务内调用）：
 * 每条当前字幕 upsert 唯一一条 active 归属；整批成功后归属版本 +1（只推进一次）。
 * 返回 { items, attribution_version }。
 */
function applyAttributionBatch(db, projectId, evaluation) {
  const findActive = db.prepare(
    `SELECT id FROM attributions WHERE project_id = ? AND subtitle_id = ? AND status = 'active'`
  );
  const ins = db.prepare(
    `INSERT INTO attributions (project_id, subtitle_id, speaker_id, speaker_number, cue_version)
     VALUES (?, ?, ?, ?, ?)`
  );
  const upd = db.prepare(
    `UPDATE attributions SET speaker_id = ?, speaker_number = ?, cue_version = ?,
       updated_at = datetime('now') WHERE id = ?`
  );
  const applied = [];
  for (const it of evaluation.items) {
    const existing = it.existing;
    if (existing) {
      upd.run(it.speaker.id, it.speaker.number, it.cue.version, existing.id);
      applied.push({
        ord: it.ord, subtitle_id: it.subtitle_id, action: 'updated',
        attribution_id: existing.id, speaker_id: it.speaker.id,
        speaker_number: it.speaker.number, display_name: it.speaker.display_name,
      });
    } else {
      const info = ins.run(
        projectId, it.subtitle_id, it.speaker.id, it.speaker.number, it.cue.version
      );
      applied.push({
        ord: it.ord, subtitle_id: it.subtitle_id, action: 'created',
        attribution_id: Number(info.lastInsertRowid), speaker_id: it.speaker.id,
        speaker_number: it.speaker.number, display_name: it.speaker.display_name,
      });
    }
  }
  const { bumpAttributionVersion } = require('./db');
  const attributionVersion = bumpAttributionVersion(db, projectId);
  return { items: applied, attribution_version: attributionVersion };
}

/**
 * 归属并列查询视图：名册 + 逐行当前字幕与归属状态 + 历史归属。
 *   cues[].attribution 为 { speaker_id, number, display_name, cue_version（标注时行版本快照）} 或 null；
 *   history[] 为原行删除后留档的归属（subtitle_id 为 null，不按序号转移）。
 */
function buildAttributionView(db, projectId) {
  const project = db.prepare(
    'SELECT sub_version, attribution_version FROM projects WHERE id = ?'
  ).get(projectId);
  if (!project) return null;
  const speakers = listSpeakers(db, projectId);
  const cues = db.prepare(
    `SELECT id, idx, text, start_ms, end_ms, locked, version
       FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  const rows = db.prepare(
    `SELECT a.id, a.subtitle_id, a.speaker_id, a.speaker_number, a.cue_version,
            a.created_at, a.updated_at, sp.display_name AS speaker_name
       FROM attributions a JOIN speakers sp ON sp.id = a.speaker_id
      WHERE a.project_id = ? AND a.status = 'active'`
  ).all(projectId);
  const byCue = new Map(rows.map((r) => [r.subtitle_id, r]));

  const cueViews = cues.map((cue) => {
    const r = byCue.get(cue.id);
    return {
      subtitle_id: cue.id,
      idx: cue.idx,
      text: cue.text,
      start_ms: cue.start_ms,
      end_ms: cue.end_ms,
      locked: cue.locked,
      cue_version: cue.version,
      attribution: r
        ? {
            attribution_id: r.id,
            speaker_id: r.speaker_id,
            number: r.speaker_number,
            display_name: r.speaker_name,
            cue_version: r.cue_version,
            attributed_at: r.created_at,
            updated_at: r.updated_at,
          }
        : null,
    };
  });

  const history = db.prepare(
    `SELECT a.id, a.speaker_id, a.speaker_number, a.cue_version,
            a.created_at, a.updated_at, sp.display_name AS speaker_name
       FROM attributions a JOIN speakers sp ON sp.id = a.speaker_id
      WHERE a.project_id = ? AND a.status = 'history' ORDER BY a.id DESC`
  ).all(projectId).map((r) => ({
    attribution_id: r.id,
    speaker_id: r.speaker_id,
    number: r.speaker_number,
    display_name: r.speaker_name,
    cue_version: r.cue_version,
    attributed_at: r.created_at,
    history_at: r.updated_at,
  }));

  const attributedCount = cueViews.filter((c) => c.attribution !== null).length;
  return {
    sub_version: project.sub_version,
    attribution_version: project.attribution_version,
    speakers,
    counts: {
      cues: cueViews.length,
      speakers: speakers.length,
      attributed: attributedCount,
      unattributed: cueViews.length - attributedCount,
      history: history.length,
    },
    cues: cueViews,
    history,
  };
}

/**
 * 署名版导出请求形状校验（与项目当前状态无关的部分）。
 *   { sub_version, attribution_version, lang?, translations? }
 * 不带 lang（或 null）→ 原文；lang 合法 → 一种目标语言，此时 translations 为
 * 逐行译文版本清单 [{subtitle_id, version}]（逐行一一对应在事务内/路由预校验）。
 */
function parseAttributedExportBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.attribution_version) || b.attribution_version < 0) {
    errors.push('attribution_version（读取时归属版本）必须是 ≥0 的整数');
  }

  let lang = null;
  if (b.lang !== undefined && b.lang !== null) {
    lang = normalizeLang(b.lang);
    if (!lang || b.lang !== lang) {
      errors.push(`lang 语言代号 ${JSON.stringify(b.lang)} 非法：须非空、≤32 字、字母开头（如 en、ja-JP）`);
    }
  }

  let translations = [];
  if (lang) {
    if (!Array.isArray(b.translations)) {
      errors.push('选择目标语言时，translations 必须是逐行译文版本清单 [{subtitle_id, version}]');
    } else {
      const seen = new Set();
      b.translations.forEach((it, i) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          errors.push(`translations[${i}] 必须是对象 {subtitle_id, version}`);
          return;
        }
        if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
          errors.push(`translations[${i}].subtitle_id 必须是 ≥1 的整数`);
          return;
        }
        if (!isInt(it.version) || it.version < 1) {
          errors.push(`translations[${i}].version（逐行译文版本）必须是 ≥1 的整数`);
          return;
        }
        if (seen.has(it.subtitle_id)) {
          errors.push(`translations 中字幕 ${it.subtitle_id} 重复：逐行译文版本清单每行只能出现一次`);
          return;
        }
        seen.add(it.subtitle_id);
        translations.push({ subtitle_id: it.subtitle_id, version: it.version });
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? { sub_version: b.sub_version, attribution_version: b.attribution_version, lang, translations }
      : null,
  };
}

/**
 * 署名版导出前事务内核对（对权威当前状态执行）：
 *   1) 提交的 sub_version / attribution_version 仍是当前值；
 *   2) 源字幕整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则通过；
 *   3) 每条当前字幕均有 active 归属，且说话人仍在名册、显示名可安全写入标签；
 *   4) 选择译文时：逐行译文 current、提交版本与当前一致且满足现行字数/字速。
 * 任一不过：stale（版本漂移）/ conflicts（整版）/ rows（按行列原因，code 标明类别）。
 * 全部通过：{ ok:true, cues } —— 已按时间升序备好 [{start_ms,end_ms,text,speaker}]。
 */
function evaluateAttributedExport(db, project, request) {
  const stale = {
    sub_version: request.sub_version !== project.sub_version,
    attribution_version: request.attribution_version !== project.attribution_version,
    sub_version_current: project.sub_version,
    attribution_version_current: project.attribution_version,
  };

  const conflicts = [
    ...validateStructure(project.subtitles, project.words, project.cuts),
    ...validateRules(project.subtitles, project.rules),
  ];

  const attributionByCue = new Map(project.attributions.map((a) => [a.subtitle_id, a]));
  const speakerById = new Map(project.speakers.map((s) => [s.id, s]));
  const translationByCue = request.lang
    ? activeTranslationsByLang(db, project.id, request.lang)
    : new Map();
  const submittedVersionByCue = new Map(
    request.translations.map((t) => [t.subtitle_id, t.version])
  );
  // 译文署名导出还须按该语言当前术语核对（未配置术语的语言不受影响）
  const glossary = request.lang ? getGlossary(db, project.id, request.lang) : null;

  const rows = [];
  const cues = [];
  for (const cue of project.subtitles) {
    const reasons = [];
    const codes = [];
    let text = cue.text;
    let speakerName = null;

    // --- 归属核对（原文/译文都必须逐行有有效归属）---
    const attribution = attributionByCue.get(cue.id);
    if (!attribution) {
      codes.push('missing_attribution');
      reasons.push(`字幕 ${cue.id}（第 ${cue.idx + 1} 行）尚未标注说话人：署名版导出要求每行都有有效归属`);
    } else {
      const speaker = speakerById.get(attribution.speaker_id);
      if (!speaker) {
        codes.push('speaker_missing');
        reasons.push(`字幕 ${cue.id} 的归属指向编号 ${attribution.speaker_number}，但名册中已无该说话人`);
      } else {
        const nameReasons = validateSpeakerName(speaker.display_name);
        if (nameReasons.length > 0) {
          codes.push('invalid_speaker_name');
          reasons.push(`说话人编号 ${speaker.number} 的显示名无法写入 WebVTT 说话人标签：${nameReasons.join('；')}`);
        } else {
          speakerName = speaker.display_name;
        }
      }
    }

    // --- 译文逐行核对（仅选择目标语言时）---
    let termMissing = [];
    if (request.lang) {
      const submittedVersion = submittedVersionByCue.get(cue.id);
      if (submittedVersion === undefined) {
        codes.push('missing_translation_version');
        reasons.push(`逐行译文版本清单缺少字幕 ${cue.id}：译文导出须与当前字幕逐行一一对应`);
      } else {
        const tr = translationByCue.get(cue.id);
        if (!tr) {
          codes.push('missing_translation');
          reasons.push(
            `语言 ${request.lang} 在字幕 ${cue.id} 上没有当前译文` +
            '（旧译文可能已随源行删除留作历史，不按序号挪用）'
          );
        } else if (tr.version !== submittedVersion) {
          codes.push('translation_version_stale');
          reasons.push(`译文版本漂移：提交基于 v${submittedVersion}，当前已是 v${tr.version}`);
        } else if (tr.status === 'review') {
          codes.push('translation_review');
          reasons.push('该译文为待复核状态：源字幕文本/时间/词区间已变化，须确认或重新保存后再导出');
        } else {
          const ruleReasons = checkTranslationText(tr.text, cue, project.rules);
          if (ruleReasons.length > 0) {
            codes.push('translation_invalid');
            reasons.push(...ruleReasons);
          } else {
            // 版本/状态/规则均通过：按当前术语核对规定译法
            const termCheck = checkTerms(cue.text, tr.text, glossary ? glossary.terms : []);
            if (termCheck.missing.length > 0) {
              codes.push('translation_term_missing');
              termMissing = termCheck.missing;
              reasons.push(...termCheck.missing.map((m) => m.reason));
            } else {
              text = tr.text;
            }
          }
        }
      }
    }

    if (codes.length > 0) {
      rows.push({
        subtitle_id: cue.id,
        idx: cue.idx,
        text: cue.text,
        start_ms: cue.start_ms,
        end_ms: cue.end_ms,
        codes,
        reasons,
        ...(termMissing.length > 0 ? { term_missing: termMissing } : {}),
        attribution: attribution
          ? {
              speaker_id: attribution.speaker_id,
              number: attribution.speaker_number,
              display_name: (speakerById.get(attribution.speaker_id) || {}).display_name || null,
            }
          : null,
        ...(request.lang
          ? {
              translation: (() => {
                const tr = translationByCue.get(cue.id);
                return tr
                  ? { version: tr.version, status: tr.status, text: tr.text }
                  : null;
              })(),
              submitted_version: submittedVersionByCue.get(cue.id) ?? null,
            }
          : {}),
      });
    }
    cues.push({ start_ms: cue.start_ms, end_ms: cue.end_ms, text, speaker: speakerName });
  }

  const ok =
    !stale.sub_version && !stale.attribution_version &&
    conflicts.length === 0 && rows.length === 0;
  return {
    ok,
    lang: request.lang,
    stale,
    conflicts,
    rows,
    glossary_version: glossary ? glossary.version : null,
    cues: ok ? cues : null,
    sub_version_current: project.sub_version,
    attribution_version_current: project.attribution_version,
    rules_version_current: project.rules.version,
  };
}

/**
 * 写入署名版快照（须在 evaluateAttributedExport 通过后、同一事务内调用）。
 * 版本号在 attributed_exports 序列内项目级递增（原文与译文共用一个序列）。
 */
function insertAttributedExport(db, projectId, fields) {
  const next = (db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM attributed_exports WHERE project_id = ?'
  ).get(projectId).v) + 1;
  const info = db.prepare(
    `INSERT INTO attributed_exports
       (project_id, kind, lang, version, content, cue_count,
        sub_version, attribution_version, rules_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    fields.kind,
    fields.lang,
    next,
    fields.content,
    fields.cue_count,
    fields.sub_version,
    fields.attribution_version,
    fields.rules_version
  );
  return db.prepare('SELECT * FROM attributed_exports WHERE id = ?').get(info.lastInsertRowid);
}

/** 署名版快照清单（倒序） */
function listAttributedExports(db, projectId) {
  return db.prepare(
    `SELECT id, kind, lang, version, cue_count, sub_version, attribution_version,
            rules_version, created_at
       FROM attributed_exports WHERE project_id = ? ORDER BY version DESC`
  ).all(projectId);
}

/** 按版本取署名版快照（含正文），不存在返回 null */
function getAttributedExport(db, projectId, version) {
  return db.prepare(
    'SELECT * FROM attributed_exports WHERE project_id = ? AND version = ?'
  ).get(projectId, version) || null;
}

module.exports = {
  MAX_NAME_LEN,
  validateSpeakerName,
  listSpeakers,
  getSpeakerByNumber,
  createSpeaker,
  renameSpeaker,
  syncAttributions,
  parseAttributionBatchBody,
  evaluateAttributionBatch,
  applyAttributionBatch,
  buildAttributionView,
  parseAttributedExportBody,
  evaluateAttributedExport,
  insertAttributedExport,
  listAttributedExports,
  getAttributedExport,
};
