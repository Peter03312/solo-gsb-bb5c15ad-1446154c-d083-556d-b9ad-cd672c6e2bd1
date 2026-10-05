'use strict';

/**
 * 逐词区间复核意见（校对页）。
 *
 * 模型：
 *   - 意见锚定“逐词导入代次 import_version + 词序区间 [word_start, word_end]”，
 *     不锚定字幕 ID 或行号：重排拆并、逐词改时、字幕行更替后，意见仍按词区间
 *     显示在相交的当前字幕旁（相交 = 字幕词区间与意见词区间有重叠）；
 *   - 创建携带当前导入代次、字幕集版本 sub_version、起止词序与非空意见文本；
 *     区间必须落在现有逐词转写内；
 *   - 关闭时必须有相交的当前字幕，并保存其 文本/时间/词区间 快照（snapshot_json）；
 *     其后这些内容变化 → 意见自动转 review（待复核），直到再次显式关闭；
 *     仅锁定或展示顺序变化不触发（快照不含锁定标记与展示序号，比较按词序排序）；
 *   - 重新导入（导入代次推进）后，旧代次意见转 history：仅作历史查看，
 *     不附到新词段、不可关闭/重新打开；
 *   - 意见写入（关闭/重新打开）携带意见版本 version，过期返回当前值且不修改。
 */

const MAX_COMMENT_LEN = 2000;

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 创建意见请求形状校验（与项目当前状态无关的部分）。
 * 合法项：{ import_version, sub_version, word_start, word_end, text }。
 */
function parseCommentBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.import_version) || b.import_version < 1) {
    errors.push('import_version（当前导入代次）必须是 ≥1 的整数');
  }
  if (!isInt(b.sub_version) || b.sub_version < 0) {
    errors.push('sub_version（读取时字幕集版本）必须是 ≥0 的整数');
  }
  if (!isInt(b.word_start) || b.word_start < 0) {
    errors.push('word_start（起始词序）必须是 ≥0 的整数');
  }
  if (!isInt(b.word_end) || b.word_end < 0) {
    errors.push('word_end（结束词序）必须是 ≥0 的整数');
  }
  if (isInt(b.word_start) && isInt(b.word_end) && b.word_start > b.word_end) {
    errors.push(`词区间非法：起始词序 ${b.word_start} 晚于结束词序 ${b.word_end}`);
  }
  if (typeof b.text !== 'string' || b.text.trim() === '') {
    errors.push('text（复核意见）必须是非空字符串');
  } else if (b.text.trim().length > MAX_COMMENT_LEN) {
    errors.push(`text（复核意见）长度 ${b.text.trim().length} 超过上限 ${MAX_COMMENT_LEN} 字`);
  }
  return {
    ok: errors.length === 0,
    errors,
    item: errors.length === 0
      ? {
          import_version: b.import_version,
          sub_version: b.sub_version,
          word_start: b.word_start,
          word_end: b.word_end,
          text: b.text.trim(),
        }
      : null,
  };
}

/** 关闭 / 重新打开请求：{ version } 必填正整数（意见版本，乐观锁） */
function parseVersionBody(body) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.version) || b.version < 1) {
    errors.push('version（意见版本）必须是 ≥1 的整数');
  }
  return { ok: errors.length === 0, errors, version: isInt(b.version) ? b.version : null };
}

/** 与词区间 [wordStart, wordEnd] 相交的字幕（入参按 idx 排序，返回保持该顺序） */
function intersectingSubtitles(subtitles, wordStart, wordEnd) {
  return subtitles.filter((s) => s.word_start <= wordEnd && s.word_end >= wordStart);
}

/**
 * 关闭快照：相交字幕的 词区间/文本/起止，按词序排序。
 * 刻意不含字幕 ID、展示序号 idx 与锁定标记——意见锚定词区间而非字幕身份，
 * 仅锁定或展示顺序变化不会造成快照漂移。
 */
function snapshotOf(cues) {
  return cues
    .map((s) => ({
      word_start: s.word_start,
      word_end: s.word_end,
      text: s.text,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
    }))
    .sort((a, b) => (a.word_start - b.word_start) || (a.word_end - b.word_end));
}

/** 快照逐字段相等比较（a/b 均为 snapshotOf 产物或 null） */
function snapshotEquals(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.word_start !== y.word_start || x.word_end !== y.word_end ||
      x.text !== y.text || x.start_ms !== y.start_ms || x.end_ms !== y.end_ms
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 字幕集变更后的统一对账（与 syncTranslations 相同的调用时机）：
 *   1) 重新导入后旧代次意见 → history（仅作历史查看，不附到新词段、不可关闭/重开）；
 *   2) closed 意见：相交当前字幕的 文本/时间/词区间 相对关闭快照漂移 → review；
 *      仅锁定或展示顺序变化不处理；
 *   3) open / review / history 保持原状：review 只能由校对者再次显式关闭消解。
 * 返回 { history, review } 本次受影响数量。
 */
function syncComments(db, projectId) {
  const historic = db.prepare(
    `UPDATE review_comments
        SET status = 'history', updated_at = datetime('now')
      WHERE project_id = ? AND status != 'history'
        AND import_version != (SELECT import_version FROM projects WHERE id = ?)`
  ).run(projectId, projectId).changes;

  const closedRows = db.prepare(
    `SELECT id, word_start, word_end, snapshot_json FROM review_comments
      WHERE project_id = ? AND status = 'closed'`
  ).all(projectId);
  let reviewed = 0;
  if (closedRows.length > 0) {
    const subtitles = db.prepare(
      `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
         FROM subtitles WHERE project_id = ? ORDER BY idx`
    ).all(projectId);
    const upd = db.prepare(
      `UPDATE review_comments SET status = 'review', updated_at = datetime('now')
        WHERE id = ? AND status = 'closed'`
    );
    for (const row of closedRows) {
      const current = snapshotOf(intersectingSubtitles(subtitles, row.word_start, row.word_end));
      const snap = row.snapshot_json ? JSON.parse(row.snapshot_json) : null;
      if (!snapshotEquals(snap, current)) {
        upd.run(row.id);
        reviewed++;
      }
    }
  }
  return { history: historic, review: reviewed };
}

/**
 * 单条意见视图：状态、词段与相交的当前字幕。
 *   words          当前代次的词段（历史意见为 null：不附到新词段）
 *   words_snapshot 创建时词段快照（始终保留，供历史查看）
 *   subtitles      相交的当前字幕（历史意见为 []）
 *   snapshot       关闭时相交字幕快照（未关闭过为 null）
 */
function commentView(row, ctx) {
  const live = row.status !== 'history' && row.import_version === ctx.currentImportVersion;
  const segment = live
    ? ctx.words
        .filter((w) => w.idx >= row.word_start && w.idx <= row.word_end)
        .map((w) => ({ idx: w.idx, text: w.text, start_ms: w.start_ms, end_ms: w.end_ms }))
    : null;
  const intersecting = live ? intersectingSubtitles(ctx.subtitles, row.word_start, row.word_end) : [];
  return {
    id: row.id,
    import_version: row.import_version,
    word_start: row.word_start,
    word_end: row.word_end,
    text: row.text,
    status: row.status,
    version: row.version,
    sub_version_snapshot: row.sub_version_snapshot,
    words: segment,
    words_snapshot: JSON.parse(row.words_json),
    subtitles: intersecting,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) : null,
    closed_at: row.closed_at,
    closed_sub_version: row.closed_sub_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** 读取项目内单条意见行，不存在返回 null */
function getComment(db, projectId, commentId) {
  return db.prepare(
    'SELECT * FROM review_comments WHERE id = ? AND project_id = ?'
  ).get(commentId, projectId) || null;
}

function loadCtx(db, projectId) {
  const project = db.prepare('SELECT import_version FROM projects WHERE id = ?').get(projectId);
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? ORDER BY idx'
  ).all(projectId);
  const subtitles = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
       FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(projectId);
  return { words, subtitles, currentImportVersion: project.import_version };
}

/** 单条意见视图（含词段与相交字幕），不存在返回 null */
function loadCommentView(db, projectId, commentId) {
  const row = getComment(db, projectId, commentId);
  if (!row) return null;
  return commentView(row, loadCtx(db, projectId));
}

/**
 * 意见列表视图：当前代次意见（按创建顺序）与历史意见（倒序）分列，
 * 附当前导入代次与字幕集版本（供创建时携带）及各状态计数。
 */
function buildCommentsView(db, projectId) {
  const project = db.prepare(
    'SELECT id, import_version, sub_version FROM projects WHERE id = ?'
  ).get(projectId);
  if (!project) return null;
  const ctx = loadCtx(db, projectId);
  const rows = db.prepare(
    'SELECT * FROM review_comments WHERE project_id = ? ORDER BY id'
  ).all(projectId);
  const comments = [];
  const history = [];
  const counts = { open: 0, closed: 0, review: 0, history: 0 };
  for (const row of rows) {
    const view = commentView(row, ctx);
    if (row.status === 'history') history.push(view);
    else comments.push(view);
    counts[row.status] = (counts[row.status] || 0) + 1;
  }
  history.reverse();
  return {
    project_id: projectId,
    import_version: project.import_version,
    sub_version: project.sub_version,
    counts,
    comments,
    history,
  };
}

module.exports = {
  MAX_COMMENT_LEN,
  parseCommentBody,
  parseVersionBody,
  intersectingSubtitles,
  snapshotOf,
  snapshotEquals,
  syncComments,
  commentView,
  getComment,
  loadCommentView,
  buildCommentsView,
};
