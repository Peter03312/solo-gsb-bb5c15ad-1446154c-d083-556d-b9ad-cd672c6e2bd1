'use strict';

/**
 * 重排后历史译文找回（按一种目标语言）：
 *
 * 重新排版会删除部分未锁定源字幕行，其译文按既有约定留作 history（绝不按序号自动挪用）。
 * 当新排版产生“词区间相同、源字幕文本相同”的缺译行时，只要历史译文与当前行来自
 * **同一次逐词导入**（projects.import_version === translations.src_import_id），
 * 校对者就可以显式把它恢复成一条普通 current 译文。
 *
 * 可恢复的三要素（缺一不可，读取候选时给出，恢复时在事务内重新核对）：
 *   1. 同一次逐词导入：history.src_import_id = 当前 projects.import_version（NULL 或
 *      旧代次都无法确认导入归属——重新导入留下的历史与旧库历史仅供查看，不能恢复）；
 *   2. 词区间一致：history.src_word_start/end = 当前行 word_start/end；
 *   3. 源字幕文本一致：history.src_text = 当前行 text。
 *
 * 组级恢复请求携带读取时的字幕集 sub_version、规则 rules_version 以及逐行选择
 * { subtitle_id, cue_version, translation_id, version }（translation_id + 候选译文版本
 * 双重定位，防止两条同版本历史混淆）。在同一事务内重新核对：
 *   - 目标行仍存在且仍缺译（无 current/review 译文）；
 *   - 候选仍是该项目该语言的 history，且三要素仍一致；
 *   - 候选译文文本满足现行 max_chars / max_cps（时长随当前源行）。
 * 任一失效按行给出 state 与中文原因，**整组不写入**（事务回滚）。恢复成功是 INSERT
 * 一条新的普通 current 译文（版本从 1 开始），原 history 行保持不变（历史记录不改）；
 * 不推进 sub_version，旧导出快照不受影响；术语缺失仍按既有译文视图提示并继续阻止导出。
 */

const { mapRow, checkTranslationText } = require('./translation');

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

const MAX_ITEMS = 1000;

/**
 * 恢复请求形状校验（与项目当前状态无关的部分）。
 * 合法请求：{ sub_version, rules_version,
 *             items:[{ subtitle_id, cue_version, translation_id, version }] }
 * 同批 subtitle_id 不得重复；items 必须非空。
 */
function parseRecoveryBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.rules_version) || b.rules_version < 1) {
    errors.push('rules_version（读取时规则版本）必须是 ≥1 的整数');
  }

  const items = [];
  if (!Array.isArray(b.items)) {
    errors.push('items 必须是非空数组：逐行选择 [{subtitle_id, cue_version, translation_id, version}]');
  } else if (b.items.length === 0) {
    errors.push('items 不能为空：恢复至少选择一行');
  } else if (b.items.length > MAX_ITEMS) {
    errors.push(`单组恢复项 ${b.items.length} 超过上限 ${MAX_ITEMS}`);
  } else {
    const seen = new Set();
    b.items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        errors.push(`items[${i}] 必须是对象 {subtitle_id, cue_version, translation_id, version}`);
        return;
      }
      const rowErrors = [];
      if (!isInt(it.subtitle_id) || it.subtitle_id < 1) {
        rowErrors.push('subtitle_id 必须是 ≥1 的整数');
      } else if (seen.has(it.subtitle_id)) {
        rowErrors.push(`字幕 ${it.subtitle_id} 在同一组内重复：每行只能选择一个候选`);
      }
      if (!isInt(it.cue_version) || it.cue_version < 1) {
        rowErrors.push('cue_version（读取时源字幕行版本）必须是 ≥1 的整数');
      }
      if (!isInt(it.translation_id) || it.translation_id < 1) {
        rowErrors.push('translation_id（候选历史译文 ID）必须是 ≥1 的整数');
      }
      if (!isInt(it.version) || it.version < 1) {
        rowErrors.push('version（候选历史译文版本）必须是 ≥1 的整数');
      }
      if (rowErrors.length > 0) {
        errors.push(`items[${i}]：${rowErrors.join('；')}`);
        return;
      }
      seen.add(it.subtitle_id);
      items.push({
        subtitle_id: it.subtitle_id,
        cue_version: it.cue_version,
        translation_id: it.translation_id,
        version: it.version,
      });
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    request: errors.length === 0
      ? { sub_version: b.sub_version, rules_version: b.rules_version, items }
      : null,
  };
}

/**
 * 判断一条历史译文相对当前缺译行是否可恢复，并给出逐条匹配依据。
 *   cue       当前字幕行（须含 word_start/word_end/text）
 *   hist      历史译文行（mapRow 形式或原始行）
 *   importId  当前项目逐词导入代次 projects.import_version
 * 返回 { recoverable, matches:{same_import, same_word_span, same_text}, reasons:[] }。
 */
function matchHistory(cue, hist, importId) {
  const sameImport = hist.src_import_id !== null && hist.src_import_id === importId;
  const sameWordSpan =
    hist.src_word_start === cue.word_start && hist.src_word_end === cue.word_end;
  const sameText = hist.src_text === cue.text;
  const reasons = [];
  if (hist.src_import_id === null) {
    reasons.push('该历史译文无法确认逐词导入归属（早于导入代次记录的旧数据），仅供查看，不能恢复');
  } else if (!sameImport) {
    reasons.push(
      `导入代次不一致：历史译文来自第 ${hist.src_import_id} 次逐词导入，` +
      `当前为第 ${importId} 次（重新导入前的旧译文仅供查看，不能恢复）`
    );
  }
  if (!sameWordSpan) {
    reasons.push(
      `词区间不一致：历史快照为词 ${hist.src_word_start}–${hist.src_word_end}，` +
      `当前行为词 ${cue.word_start}–${cue.word_end}`
    );
  }
  if (!sameText) {
    reasons.push('源字幕文本不一致：历史快照原文与当前行文本不同');
  }
  return {
    recoverable: sameImport && sameWordSpan && sameText,
    matches: { same_import: sameImport, same_word_span: sameWordSpan, same_text: sameText },
    reasons,
  };
}

/**
 * 只读候选视图：对指定语言当前缺译字幕（无 current/review 译文的行）列出历史候选。
 * 每条候选给出匹配依据（same_import/same_word_span/same_text）与不可恢复原因；
 * recoverable=true 的候选才能提交给恢复接口。重新导入前的旧代次历史、归属未知
 * （src_import_id 为 NULL）的旧历史同样列出但 recoverable=false。
 *
 * 返回：
 *   { lang, import_version, sub_version, rules_version,
 *     targets:[{ cue, candidates:[{ translation, recoverable, matches, reasons }] }],
 *     recoverable_target_count }
 */
function buildRecoveryView(db, projectId, lang) {
  const project = db.prepare(
    'SELECT sub_version, import_version FROM projects WHERE id = ?'
  ).get(projectId);
  const rulesRow = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(projectId);
  const cues = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  const histories = db.prepare(
    `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND status = 'history'
     ORDER BY id DESC`
  ).all(projectId, lang).map(mapRow);

  const targets = [];
  let recoverableTargetCount = 0;
  for (const cue of cues) {
    const active = db.prepare(
      `SELECT id FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ?
       AND status != 'history' LIMIT 1`
    ).get(projectId, lang, cue.id);
    if (active) continue; // 已有 current/review 译文的行不是缺译行，不参与找回
    const candidates = histories.map((h) => {
      const m = matchHistory(cue, h, project.import_version);
      return { translation: h, ...m };
    });
    const hasRecoverable = candidates.some((c) => c.recoverable);
    if (hasRecoverable) recoverableTargetCount++;
    targets.push({ cue, candidates, has_recoverable: hasRecoverable });
  }

  return {
    lang,
    import_version: project.import_version,
    sub_version: project.sub_version,
    rules_version: rulesRow.version,
    targets,
    recoverable_target_count: recoverableTargetCount,
  };
}

/**
 * 事务内组级恢复核对（对权威当前状态执行）。
 *
 *   project  loadProject 结果；lang 已归一化；request 为 parseRecoveryBody 通过的请求。
 *
 * 逐行 state：
 *   ok                         可在本组写入；
 *   cue_missing                目标字幕已不存在（409 过期类）；
 *   cue_version_stale          读取的源行版本与当前不同（409）；
 *   not_missing                目标行已有 current/review 译文（409，不再是缺译行）；
 *   candidate_missing          候选译文不存在或不属于本项目（400 形状类）；
 *   candidate_wrong_lang       候选不属于请求语言（400）；
 *   candidate_not_history      候选不是 history（400）；
 *   candidate_version_stale    候选译文版本与提交不一致（409）；
 *   candidate_mismatch         候选仍在但三要素（导入代次/词区间/源文）失效（409）；
 *   invalid                    候选译文文本不满足现行字数/字速（422）。
 *
 * 任一非 ok 整组不写入；返回中带每行 cue/current/candidate 与中文 reasons。
 */
function evaluateRecovery(db, project, lang, request) {
  const items = request.items.map((it, ord) => {
    const out = {
      ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      translation_id: it.translation_id,
      version: it.version,
      state: 'ok',
      cue: null,
      current: null,
      candidate: null,
      text: null,
      reasons: [],
    };

    const cue = project.subtitles.find((s) => s.id === it.subtitle_id);
    if (!cue) {
      out.state = 'cue_missing';
      out.reasons.push(
        `字幕 ${it.subtitle_id} 在当前字幕集（v${project.sub_version}）中不存在（可能已被重排删除），请刷新后重新选择`
      );
      return out;
    }
    out.cue = cue;
    if (it.cue_version !== cue.version) {
      out.state = 'cue_version_stale';
      out.reasons.push(`源字幕行版本过期：提交基于 v${it.cue_version}，当前已是 v${cue.version}`);
    }

    // 目标行必须仍缺译（无 current/review 译文）；恢复是“新建一条译文”，不覆盖既有译文
    const active = db.prepare(
      `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ?
       AND status != 'history' LIMIT 1`
    ).get(project.id, lang, cue.id);
    if (active) {
      if (out.state === 'ok') out.state = 'not_missing';
      out.current = mapRow(active);
      out.reasons.push(
        `字幕 ${cue.id} 已有${active.status === 'review' ? '待复核' : '当前'}译文 v${active.version}，` +
        '不再是缺译行（历史译文不会覆盖既有译文，请直接编辑或确认现有译文）'
      );
    }

    // 候选定位：必须是本项目的译文行
    const hist = db.prepare('SELECT * FROM translations WHERE id = ? AND project_id = ?')
      .get(it.translation_id, project.id);
    if (!hist) {
      out.state = 'candidate_missing';
      out.reasons.push(`候选历史译文 ${it.translation_id} 不存在（或不属于本项目），请重新拉取候选列表`);
      return out;
    }
    if (hist.lang !== lang) {
      out.state = 'candidate_wrong_lang';
      out.reasons.push(`候选历史译文 ${hist.id} 属于语言 ${hist.lang}，与请求语言 ${lang} 不符`);
      return out;
    }
    if (hist.status !== 'history') {
      out.state = 'candidate_not_history';
      out.current = mapRow(hist);
      out.reasons.push(`候选译文 ${hist.id} 当前为 ${hist.status} 状态，不是历史译文，不能作为恢复来源`);
      return out;
    }
    out.candidate = mapRow(hist);
    out.text = hist.text;
    if (it.version !== hist.version) {
      out.state = 'candidate_version_stale';
      out.reasons.push(
        `候选译文版本不一致：提交选择 v${it.version}，候选当前为 v${hist.version}，请重新拉取候选列表`
      );
    }

    // 三要素：同一次逐词导入 + 词区间一致 + 源字幕文本一致
    const m = matchHistory(cue, hist, project.import_version);
    if (!m.recoverable) {
      if (out.state === 'ok') out.state = 'candidate_mismatch';
      out.reasons.push(...m.reasons);
      out.matches = m.matches;
    }

    // 现行字数/字速（时长随当前源行）；仅在其余核对通过时报告，避免原因堆叠
    if (out.state === 'ok') {
      const ruleReasons = checkTranslationText(hist.text, cue, project.rules);
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

/** 400 形状/归属类状态（候选本身不存在或不是该语言的历史行） */
const SHAPE_STATES = new Set([
  'candidate_missing', 'candidate_wrong_lang', 'candidate_not_history',
]);
/** 409 过期/失效类状态 */
const STALE_STATES = new Set([
  'cue_missing', 'cue_version_stale', 'not_missing',
  'candidate_version_stale', 'candidate_mismatch',
]);

module.exports = {
  MAX_ITEMS,
  parseRecoveryBody,
  matchHistory,
  buildRecoveryView,
  evaluateRecovery,
  SHAPE_STATES,
  STALE_STATES,
};
