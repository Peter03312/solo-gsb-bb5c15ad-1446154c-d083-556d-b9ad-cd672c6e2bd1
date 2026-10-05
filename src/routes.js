'use strict';

const express = require('express');
const {
  loadProject, listRevisions, loadRevision,
  listWordRevisions, loadWordRevision, bumpSubVersion, bumpAttributionVersion,
  bumpImportVersion,
  DEFAULT_RULES,
} = require('./db');
const { computeLayout, validateStructure, validateRules } = require('./layout');
const { validateWords, validateCuts, validateRules: validateRulesInput, validateSubtitleEdit } = require('./validate');
const { parseRevisionItems, evaluateRevision } = require('./revision');
const { parseWordRevisionItems, evaluateWordRevision } = require('./word-revision');
const {
  normalizeLang, parseTranslationBody, parseConfirmBody, checkTranslationText,
  syncTranslations, buildLangView, listLanguages, activeTranslationsByLang,
  evaluateExport, mapRow,
} = require('./translation');
const { parseDeliveryBody, evaluateDelivery, listBatches, loadBatch } = require('./delivery');
const { buildDeliveryDiff, BatchDiffError } = require('./delivery-diff');
const {
  parseTranslationBatchBody, contentHash, evaluateBatch,
  listBatches: listTranslationBatches, loadBatch: loadTranslationBatch,
} = require('./translation-batch');
const speakerMod = require('./speaker');
const {
  validateSpeakerName, listSpeakers, getSpeakerByNumber, createSpeaker, renameSpeaker,
  syncAttributions, parseAttributionBatchBody, evaluateAttributionBatch, applyAttributionBatch,
  buildAttributionView, parseAttributedExportBody, evaluateAttributedExport,
  insertAttributedExport, listAttributedExports, getAttributedExport,
} = speakerMod;
const glossaryMod = require('./glossary');
const {
  parseGlossaryBody, StaleGlossaryError, getGlossary, listGlossaries, replaceGlossary,
  evaluateTerms, checkTerms,
} = glossaryMod;
const {
  parseRecoveryBody, buildRecoveryView, evaluateRecovery,
  SHAPE_STATES: RECOVERY_SHAPE_STATES, STALE_STATES: RECOVERY_STALE_STATES,
} = require('./translation-recovery');
const {
  parseCommentBody, parseVersionBody, syncComments, buildCommentsView,
  getComment, loadCommentView, intersectingSubtitles, snapshotOf,
} = require('./comment');
const { toWebVtt } = require('./vtt');

/**
 * 挂载 API 路由。统一错误格式：
 *   400 { error }                 请求体非法
 *   404 { error }                 资源不存在
 *   409 { error, current }        版本过期，current 为当前内容
 *   422 { error, errors|conflicts } 校验失败 / 规则冲突
 */
function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const getProject = (req, res) => {
    const p = loadProject(db, Number(req.params.id));
    if (!p) {
      res.status(404).json({ error: `项目 ${req.params.id} 不存在` });
      return null;
    }
    return p;
  };

  // ---------- 项目 ----------

  app.get('/api/projects', (req, res) => {
    const rows = db.prepare(
      `SELECT p.id, p.name, p.created_at,
              (SELECT COUNT(*) FROM words w WHERE w.project_id = p.id)  AS word_count,
              (SELECT COUNT(*) FROM subtitles s WHERE s.project_id = p.id) AS cue_count,
              (SELECT COUNT(*) FROM exports e WHERE e.project_id = p.id)   AS export_count
       FROM projects p ORDER BY p.id DESC`
    ).all();
    res.json(rows);
  });

  app.post('/api/projects', (req, res) => {
    const { name, words, cuts, rules } = req.body || {};
    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name 必须是非空字符串' });
    }
    let wordRows = null;
    let cutList = [];
    if (words !== undefined) {
      const w = validateWords(words);
      if (!w.ok) return res.status(422).json({ error: '逐词转写校验失败，拒绝导入', errors: w.errors });
      wordRows = words.map((x) => ({ text: x.text.trim(), start_ms: x.start_ms, end_ms: x.end_ms }));
    }
    const c = validateCuts(cuts);
    if (!c.ok) return res.status(422).json({ error: '镜头切点校验失败，拒绝导入', errors: c.errors });
    cutList = c.cuts;
    const ruleValues = rules !== undefined ? rules : DEFAULT_RULES;
    const rv = validateRulesInput(ruleValues);
    if (!rv.ok) return res.status(422).json({ error: '排版规则校验失败', errors: rv.errors });

    const tx = db.transaction(() => {
      const info = db.prepare('INSERT INTO projects (name) VALUES (?)').run(name.trim());
      const pid = info.lastInsertRowid;
      db.prepare(
        'INSERT INTO rules (project_id, max_chars, min_duration_ms, max_cps) VALUES (?, ?, ?, ?)'
      ).run(pid, ruleValues.max_chars, ruleValues.min_duration_ms, ruleValues.max_cps);
      if (wordRows) {
        const ins = db.prepare('INSERT INTO words (project_id, idx, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
        wordRows.forEach((w, i) => ins.run(pid, i, w.text, w.start_ms, w.end_ms));
      }
      const insCut = db.prepare('INSERT INTO shots (project_id, idx, cut_ms) VALUES (?, ?, ?)');
      cutList.forEach((ms, i) => insCut.run(pid, i, ms));
      return pid;
    });
    const pid = tx();
    res.status(201).json(loadProject(db, pid));
  });

  app.get('/api/projects/:id', (req, res) => {
    const p = getProject(req, res);
    if (p) res.json(p);
  });

  // ---------- 导入（替换转写与切点） ----------

  app.post('/api/projects/:id/import', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { words, cuts, force } = req.body || {};
    const w = validateWords(words);
    if (!w.ok) return res.status(422).json({ error: '逐词转写校验失败，拒绝导入', errors: w.errors });
    const c = validateCuts(cuts);
    if (!c.ok) return res.status(422).json({ error: '镜头切点校验失败，拒绝导入', errors: c.errors });

    const cueCount = db.prepare('SELECT COUNT(*) AS n FROM subtitles WHERE project_id = ?').get(p.id).n;
    if (cueCount > 0 && !force) {
      return res.status(409).json({
        error: `项目已有 ${cueCount} 条字幕，重新导入将清空全部字幕（含已锁定）。确认请携带 {"force": true}`,
        cue_count: cueCount,
      });
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM subtitles WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM words WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM shots WHERE project_id = ?').run(p.id);
      const ins = db.prepare('INSERT INTO words (project_id, idx, text, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)');
      words.forEach((x, i) => ins.run(p.id, i, x.text.trim(), x.start_ms, x.end_ms));
      const insCut = db.prepare('INSERT INTO shots (project_id, idx, cut_ms) VALUES (?, ?, ?)');
      c.cuts.forEach((ms, i) => insCut.run(p.id, i, ms));
      bumpSubVersion(db, p.id);
      // 逐词整体替换 → 新的导入代次：旧代次译文即使词区间/文本相同也无法确认导入归属，
      // 只留作历史、不可恢复。
      bumpImportVersion(db, p.id);
    });
    tx();
    // 旧字幕行已全部删除：各语言译文全部留作历史（不按序号挪用到新排版的行）；
    // 说话人归属同样留作历史（不按展示序号转移，新排版的行待标注）。
    syncTranslations(db, p.id);
    syncAttributions(db, p.id);
    // 导入代次已推进：旧代次复核意见转历史（仅查看，不附到新词段、不可关闭）
    syncComments(db, p.id);
    res.json(loadProject(db, p.id));
  });

  // ---------- 规则（版本号拒绝过期提交） ----------

  app.put('/api/projects/:id/rules', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { version, max_chars, min_duration_ms, max_cps } = req.body || {};
    const current = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(p.id);
    if (version !== current.version) {
      return res.status(409).json({
        error: `规则版本过期：你基于 v${version} 修改，但当前已是 v${current.version}`,
        current: {
          version: current.version, max_chars: current.max_chars,
          min_duration_ms: current.min_duration_ms, max_cps: current.max_cps,
        },
      });
    }
    const rv = validateRulesInput({ max_chars, min_duration_ms, max_cps });
    if (!rv.ok) return res.status(422).json({ error: '排版规则校验失败', errors: rv.errors });
    db.prepare(
      `UPDATE rules SET version = version + 1, max_chars = ?, min_duration_ms = ?, max_cps = ?,
       updated_at = datetime('now') WHERE project_id = ?`
    ).run(max_chars, min_duration_ms, max_cps, p.id);
    res.json(loadProject(db, p.id).rules);
  });

  // ---------- 重排（只改未锁定部分） ----------

  app.post('/api/projects/:id/layout', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { sub_version } = req.body || {};
    if (sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后重试`,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }
    if (p.words.length === 0) {
      return res.status(422).json({ error: '尚未导入逐词转写，无法排版', conflicts: [] });
    }
    const locked = p.subtitles.filter((s) => s.locked === 1);
    const result = computeLayout({ words: p.words, cuts: p.cuts, rules: p.rules, locked });
    if (!result.ok) {
      return res.status(422).json({
        error: `排版规则无法同时满足，共 ${result.conflicts.length} 处冲突；未改动任何字幕`,
        conflicts: result.conflicts,
      });
    }
    const tx = db.transaction(() => {
      // 身份保持：以词区间为身份。
      //   锁定行与内容完全一致的行 → 保留 ID/版本，只更新展示顺序 idx
      //     （仅锁定或展示顺序变化不使译文失效）；
      //   词区间相同但文本/时间变化的未锁定行 → 原地更新，行版本 +1
      //     （事务提交后由 syncTranslations 把其译文转待复核）；
      //   旧版中存在、候选整版已消失的未锁定行 → 删除（其译文留作历史）；
      //   候选整版中的新行 → INSERT 新 ID（视为缺译，绝不按序号挪用旧译文）。
      const lockedByKey = new Map(locked.map((s) => [`${s.word_start}:${s.word_end}`, s]));
      const oldUnlockedByKey = new Map(
        p.subtitles.filter((s) => s.locked === 0)
          .map((s) => [`${s.word_start}:${s.word_end}`, s])
      );
      const ins = db.prepare(
        `INSERT INTO subtitles (project_id, idx, word_start, word_end, text, start_ms, end_ms, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      );
      const updIdx = db.prepare('UPDATE subtitles SET idx = ? WHERE id = ?');
      const updCue = db.prepare(
        `UPDATE subtitles SET idx = ?, text = ?, start_ms = ?, end_ms = ?, version = version + 1
         WHERE id = ?`
      );
      // 先把全部现存行 idx 挪到负临时值，避免 UNIQUE(project_id, idx) 与 0 起正式 idx 撞号
      db.prepare('UPDATE subtitles SET idx = -id - 1 WHERE project_id = ?').run(p.id);
      const usedIds = new Set();
      result.cues.forEach((cue, i) => {
        const key = `${cue.word_start}:${cue.word_end}`;
        const keptLocked = lockedByKey.get(key);
        if (keptLocked) {
          usedIds.add(keptLocked.id);
          updIdx.run(i, keptLocked.id);
          return;
        }
        const oldCue = oldUnlockedByKey.get(key);
        if (oldCue &&
            oldCue.text === cue.text &&
            oldCue.start_ms === cue.start_ms &&
            oldCue.end_ms === cue.end_ms) {
          usedIds.add(oldCue.id);
          updIdx.run(i, oldCue.id);
        } else if (oldCue) {
          usedIds.add(oldCue.id);
          updCue.run(i, cue.text, cue.start_ms, cue.end_ms, oldCue.id);
        } else {
          ins.run(p.id, i, cue.word_start, cue.word_end, cue.text, cue.start_ms, cue.end_ms);
        }
      });
      // 已消失的旧未锁定行：删除（其译文在 syncTranslations 中留作历史，不按序号挪用）
      const stale = p.subtitles.filter((s) => s.locked === 0 && !usedIds.has(s.id));
      const del = db.prepare('DELETE FROM subtitles WHERE id = ? AND project_id = ? AND locked = 0');
      stale.forEach((s) => del.run(s.id, p.id));
      bumpSubVersion(db, p.id);
    });
    tx();
    syncTranslations(db, p.id);
    // 重排删除行的归属留作历史；保留 ID 的行（仅 idx 变化或原地更新）归属继续有效
    syncAttributions(db, p.id);
    // 重排拆并/字幕行更替后：已关闭意见的相交字幕快照若漂移则转待复核；
    // 意见锚定词区间，不按字幕 ID 或行号迁移
    syncComments(db, p.id);
    const fresh = loadProject(db, p.id);
    res.json({ sub_version: fresh.sub_version, subtitles: fresh.subtitles });
  });

  // ---------- 单条字幕编辑 / 锁定（行级版本号） ----------

  app.patch('/api/projects/:id/subtitles/:sid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const sid = Number(req.params.sid);
    const row = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!row) return res.status(404).json({ error: `字幕 ${req.params.sid} 不存在` });

    const { version, text, start_ms, end_ms, locked } = req.body || {};
    if (version !== row.version) {
      return res.status(409).json({
        error: `字幕版本过期：你基于 v${version} 修改，但当前已是 v${row.version}`,
        current: row,
      });
    }

    const newText = text !== undefined ? String(text) : row.text;
    const newStart = start_ms !== undefined ? start_ms : row.start_ms;
    const newEnd = end_ms !== undefined ? end_ms : row.end_ms;
    const newLocked = locked !== undefined ? (locked ? 1 : 0) : row.locked;

    if (newText.trim() === '') {
      return res.status(422).json({ error: '字幕文本不能为空', errors: ['字幕文本不能为空'] });
    }
    if (start_ms !== undefined || end_ms !== undefined) {
      const neighbors = {
        prev: db.prepare(
          'SELECT start_ms, end_ms FROM subtitles WHERE project_id = ? AND idx < ? ORDER BY idx DESC LIMIT 1'
        ).get(p.id, row.idx) || null,
        next: db.prepare(
          'SELECT start_ms, end_ms FROM subtitles WHERE project_id = ? AND idx > ? ORDER BY idx LIMIT 1'
        ).get(p.id, row.idx) || null,
      };
      const errors = validateSubtitleEdit(
        { start_ms: newStart, end_ms: newEnd },
        { word_start: row.word_start, word_end: row.word_end },
        p.words, p.cuts, neighbors
      );
      if (errors.length > 0) {
        return res.status(422).json({ error: '字幕时间校验失败', errors });
      }
    }

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE subtitles SET text = ?, start_ms = ?, end_ms = ?, locked = ?, version = version + 1
         WHERE id = ?`
      ).run(newText, newStart, newEnd, newLocked, sid);
      bumpSubVersion(db, p.id);
    });
    tx();
    // 源字幕文本/时间变化 → 各语言该条译文转待复核；仅锁定切换（内容一致）不失效
    syncTranslations(db, p.id);
    // 同理：已关闭意见的相交字幕快照漂移 → 待复核；仅锁定/展示顺序变化不触发
    syncComments(db, p.id);
    const fresh = loadProject(db, p.id);
    res.json({ sub_version: fresh.sub_version, subtitle: fresh.subtitles.find((s) => s.id === sid) });
  });

  // ---------- 导出（确认后生成不可变快照） ----------

  app.post('/api/projects/:id/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    // 可选的乐观锁：携带 sub_version 时校验，防止导出与界面不一致的内容
    const { sub_version } = req.body || {};
    if (sub_version !== undefined && sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后再确认导出`,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }
    if (p.subtitles.length === 0) {
      return res.status(422).json({ error: '没有字幕可导出，请先排版', conflicts: [] });
    }
    if (p.words.length === 0) {
      return res.status(422).json({ error: '尚未导入逐词转写', conflicts: [] });
    }
    const structural = validateStructure(p.subtitles, p.words, p.cuts);
    const ruleProblems = validateRules(p.subtitles, p.rules);
    const conflicts = [...structural, ...ruleProblems];
    if (conflicts.length > 0) {
      return res.status(422).json({
        error: `字幕未通过导出校验（${conflicts.length} 处问题），未生成文件`,
        conflicts,
      });
    }
    const content = toWebVtt(p.subtitles);
    const tx = db.transaction(() => {
      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM exports WHERE project_id = ?')
        .get(p.id).v) + 1;
      db.prepare(
        'INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, ?, ?, ?)'
      ).run(p.id, next, content, p.subtitles.length);
      return next;
    });
    const version = tx();
    res.status(201).json({
      version,
      cue_count: p.subtitles.length,
      download_url: `/api/projects/${p.id}/exports/${version}`,
      content,
    });
  });

  app.get('/api/projects/:id/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(db.prepare(
      'SELECT version, cue_count, created_at FROM exports WHERE project_id = ? ORDER BY version DESC'
    ).all(p.id));
  });

  app.get('/api/projects/:id/exports/:version', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const row = db.prepare(
      'SELECT * FROM exports WHERE project_id = ? AND version = ?'
    ).get(p.id, Number(req.params.version));
    if (!row) return res.status(404).json({ error: `导出版本 ${req.params.version} 不存在` });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="project-${p.id}-v${row.version}.vtt"`
    );
    res.send(row.content);
  });

  // ---------- 说话人名册与归属标注（署名版导出） ----------
  //
  // 项目内维护说话人编号（服务端分配、不回收、不可变）→ 显示名（可改，改名推进
  // 归属版本 attribution_version）。归属按字幕 ID 锚定：提交携带读取时行版本
  // cue_version 与归属版本 attribution_version，编号须存在；过期返回当前值；
  // 锁定行也可标注。重排保留 ID 的行归属继续有效；原行删除后归属留作历史，
  // 新行待标注，不按展示序号转移。署名版导出携带字幕集版本与归属版本，在同一
  // 事务内核对每行都有有效归属（译文另须逐行 current、版本未变），通过才生成
  // 带 <v 显示名> 标签的不可变快照；普通导出与旧下载内容保持兼容。

  /** 说话人名册（编号升序，附当前有效归属条数） */
  app.get('/api/projects/:id/speakers', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json({ project_id: p.id, attribution_version: p.attribution_version, speakers: listSpeakers(db, p.id) });
  });

  /** 新建说话人：服务端分配项目内下一个编号（不回收），不推进归属版本 */
  app.post('/api/projects/:id/speakers', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const { display_name } = req.body || {};
    const reasons = validateSpeakerName(display_name);
    if (reasons.length > 0) {
      return res.status(400).json({ error: '说话人显示名非法，未创建', errors: reasons });
    }
    const speaker = createSpeaker(db, p.id, display_name.trim());
    res.status(201).json({
      speaker,
      attribution_version: p.attribution_version,
    });
  });

  /**
   * 修改说话人显示名：携带读取时归属版本 attribution_version（改名会推进它）；
   * 过期 → 409 返回当前名册与归属版本。显示名含换行或 <、> → 400。
   */
  app.patch('/api/projects/:id/speakers/:number', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const number = Number(req.params.number);
    const speaker = getSpeakerByNumber(db, p.id, number);
    if (!speaker) return res.status(404).json({ error: `说话人编号 ${number} 不存在` });

    const { attribution_version, display_name } = req.body || {};
    if (!Number.isInteger(attribution_version) || attribution_version < 0) {
      return res.status(400).json({
        error: '请求非法',
        errors: ['attribution_version（读取时归属版本）必须是 ≥0 的整数'],
      });
    }
    if (attribution_version !== p.attribution_version) {
      return res.status(409).json({
        error: `归属版本过期：你基于 v${attribution_version} 读取，当前已是 v${p.attribution_version}，请刷新后重试`,
        current: { attribution_version: p.attribution_version, speakers: listSpeakers(db, p.id) },
      });
    }
    const reasons = validateSpeakerName(display_name);
    if (reasons.length > 0) {
      return res.status(400).json({ error: '说话人显示名非法，未修改', errors: reasons });
    }
    const done = renameSpeaker(db, p.id, speaker.id, display_name.trim());
    res.json({ speaker: done.speaker, attribution_version: done.attribution_version });
  });

  /** 归属并列查询：名册 + 逐行字幕/归属状态 + 历史归属（只读） */
  app.get('/api/projects/:id/attributions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(buildAttributionView(db, p.id));
  });

  /**
   * 标注单条字幕归属（锁定行也可标注）。
   *   { attribution_version, cue_version, speaker_number }
   * 201 首次标注 / 200 覆盖更新；400 形状非法或编号不存在；404 字幕不存在；
   * 409 归属版本或行版本过期（返回当前值）。
   */
  app.put('/api/projects/:id/attributions/subtitles/:sid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const sid = Number(req.params.sid);
    const b = req.body || {};
    const errors = [];
    if (!Number.isInteger(b.attribution_version) || b.attribution_version < 0) {
      errors.push('attribution_version（读取时归属版本）必须是 ≥0 的整数');
    }
    if (!Number.isInteger(b.cue_version) || b.cue_version < 1) {
      errors.push('cue_version（读取时字幕行版本）必须是 ≥1 的整数');
    }
    if (!Number.isInteger(b.speaker_number) || b.speaker_number < 1) {
      errors.push('speaker_number（说话人编号）必须是 ≥1 的整数');
    }
    if (errors.length > 0) return res.status(400).json({ error: '归属标注请求非法', errors });

    const cue = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!cue) return res.status(404).json({ error: `字幕 ${req.params.sid} 不存在（可能已被重排删除），请按当前行重新标注` });

    if (b.attribution_version !== p.attribution_version) {
      return res.status(409).json({
        error: `归属版本过期：你基于 v${b.attribution_version} 读取，当前已是 v${p.attribution_version}，请刷新后重试`,
        current: buildAttributionView(db, p.id),
      });
    }
    if (b.cue_version !== cue.version) {
      return res.status(409).json({
        error: `字幕行版本过期：你基于 v${b.cue_version} 读取，当前已是 v${cue.version}`,
        current: { cue, attribution_version: p.attribution_version },
      });
    }
    const speaker = getSpeakerByNumber(db, p.id, b.speaker_number);
    if (!speaker) {
      return res.status(400).json({
        error: `说话人编号 ${b.speaker_number} 不存在：请先用名册接口建立说话人`,
        speakers: listSpeakers(db, p.id),
      });
    }

    const existing = db.prepare(
      `SELECT * FROM attributions WHERE project_id = ? AND subtitle_id = ? AND status = 'active'`
    ).get(p.id, sid);
    const tx = db.transaction(() => {
      if (existing) {
        db.prepare(
          `UPDATE attributions SET speaker_id = ?, speaker_number = ?, cue_version = ?,
             updated_at = datetime('now') WHERE id = ?`
        ).run(speaker.id, speaker.number, cue.version, existing.id);
      } else {
        db.prepare(
          `INSERT INTO attributions (project_id, subtitle_id, speaker_id, speaker_number, cue_version)
           VALUES (?, ?, ?, ?, ?)`
        ).run(p.id, sid, speaker.id, speaker.number, cue.version);
      }
      return bumpAttributionVersion(db, p.id);
    });
    const attributionVersion = tx();
    const row = db.prepare(
      `SELECT a.id, a.subtitle_id, a.speaker_id, a.speaker_number, a.cue_version,
              sp.display_name AS speaker_name
         FROM attributions a JOIN speakers sp ON sp.id = a.speaker_id
        WHERE a.project_id = ? AND a.subtitle_id = ? AND a.status = 'active'`
    ).get(p.id, sid);
    res.status(existing ? 200 : 201).json({
      attribution: {
        attribution_id: row.id, subtitle_id: row.subtitle_id,
        speaker_id: row.speaker_id, number: row.speaker_number,
        display_name: row.speaker_name, cue_version: row.cue_version,
      },
      attribution_version: attributionVersion,
    });
  });

  /**
   * 批量标注归属（一组字幕，锁定行也可标注）。
   *   { attribution_version, items:[{subtitle_id, cue_version, speaker_number}] }
   * 同一事务内核对归属版本/行版本/编号存在；任一行过期或编号缺失则整批不写入，
   * 按行返回当前值与原因。全部通过后整批写入，归属版本只推进一次。
   *   400 形状非法/编号不存在；409 归属版本或行版本过期/行已删除（带 current）。
   */
  app.post('/api/projects/:id/attributions/batch', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const parsed = parseAttributionBatchBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '归属批量标注请求非法，未写入', errors: parsed.errors });
    }

    class AttributionReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '归属标注被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      const fresh = loadProject(db, p.id);
      const evaluation = evaluateAttributionBatch(fresh, parsed.request);

      if (evaluation.attribution_version_stale) {
        throw new AttributionReject(409, {
          error: `归属版本过期：你基于 v${parsed.request.attribution_version} 读取，当前已是 v${fresh.attribution_version}，请刷新后重试`,
          attribution_version_stale: true,
          current: buildAttributionView(db, fresh.id),
        });
      }

      const bad = evaluation.items.filter((it) => it.state !== 'ok');
      if (bad.length > 0) {
        const missingSpeaker = bad.some((it) => it.state === 'speaker_missing');
        const staleCue = bad.some(
          (it) => it.state === 'cue_missing' || it.state === 'cue_version_stale'
        );
        // 编号不存在属请求内容问题（400）；行缺失/行版本过期属过期（409）。两类同时存在按 400 会掩盖
        // 过期信息，这里若有任一过期项按 409（编号问题也在该行 reasons 中给出）。
        const code = staleCue ? 409 : 400;
        throw new AttributionReject(code, {
          error: staleCue
            ? `归属批量标注存在 ${bad.length} 行过期/失效项，整批未写入，请刷新后重新提交`
            : `归属批量标注有 ${bad.length} 行引用了不存在的说话人编号，整批未写入`,
          attribution_version: fresh.attribution_version,
          items: bad.map((it) => ({
            ord: it.ord,
            subtitle_id: it.subtitle_id,
            cue_version: it.cue_version,
            speaker_number: it.speaker_number,
            state: it.state,
            cue: it.cue,
            existing: it.existing
              ? {
                  attribution_id: it.existing.id,
                  number: it.existing.speaker_number,
                  speaker_name: it.existing.speaker_name,
                }
              : null,
            reasons: it.reasons,
          })),
          current: buildAttributionView(db, fresh.id),
          speakers: listSpeakers(db, fresh.id),
        });
      }

      const done = applyAttributionBatch(db, fresh.id, evaluation);
      return done;
    });

    try {
      const done = tx();
      res.status(201).json({
        applied: done.items.length,
        items: done.items,
        attribution_version: done.attribution_version,
      });
    } catch (err) {
      if (err instanceof AttributionReject) return res.status(err.statusCode).json(err.payload);
      throw err;
    }
  });

  /**
   * 署名版导出：携带 sub_version 与 attribution_version，同一事务内核对
   * 每条当前字幕均有有效归属（说话人名册存在、显示名可安全写入标签）。
   * 不带 lang → 原文；带 lang + translations（逐行 [{subtitle_id, version}]）→ 一种
   * 目标语言，译文须逐行 current、版本未变且满足现行字数/字速。
   * 失败按行列原因（codes）且不生成快照；成功另存 attributed_exports 不可变快照，
   * 普通 exports/translation_exports 与旧下载内容不变。原文与译文共用同一时间轴。
   */
  app.post('/api/projects/:id/attributed-exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const parsed = parseAttributedExportBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '署名版导出请求非法，未生成快照', errors: parsed.errors });
    }

    class ExportReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '署名版导出被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      const fresh = loadProject(db, p.id);
      const result = evaluateAttributedExport(db, fresh, parsed.request);

      if (result.stale.sub_version || result.stale.attribution_version) {
        const why = [];
        if (result.stale.sub_version) {
          why.push(`字幕集版本漂移：提交基于 v${parsed.request.sub_version}，当前已是 v${fresh.sub_version}`);
        }
        if (result.stale.attribution_version) {
          why.push(`归属版本漂移：提交基于 v${parsed.request.attribution_version}，当前已是 v${fresh.attribution_version}`);
        }
        throw new ExportReject(409, {
          error: `${why.join('；')}；未生成快照，请刷新后重新提交`,
          stale: result.stale,
          current: {
            sub_version: fresh.sub_version,
            attribution_version: fresh.attribution_version,
            rules_version: fresh.rules.version,
          },
        });
      }
      if (result.conflicts.length > 0 || result.rows.length > 0) {
        throw new ExportReject(422, {
          error: result.lang
            ? `署名版译文导出（${result.lang}）未通过核对：整版冲突 ${result.conflicts.length} 处，逐行问题 ${result.rows.length} 行；未生成快照`
            : `署名版原文导出未通过核对：整版冲突 ${result.conflicts.length} 处，逐行问题 ${result.rows.length} 行；未生成快照`,
          sub_version: fresh.sub_version,
          attribution_version: fresh.attribution_version,
          rules_version: fresh.rules.version,
          glossary_version: result.glossary_version,
          conflicts: result.conflicts,
          rows: result.rows,
        });
      }

      // 全部通过：用当前显示名与（原文或译文）文本生成带说话人标签的 WebVTT
      const content = toWebVtt(result.cues);
      const saved = insertAttributedExport(db, fresh.id, {
        kind: result.lang ? 'translation' : 'source',
        lang: result.lang,
        content,
        cue_count: result.cues.length,
        sub_version: fresh.sub_version,
        attribution_version: fresh.attribution_version,
        rules_version: fresh.rules.version,
      });
      return { saved, content, glossary_version: result.glossary_version };
    });

    try {
      const done = tx();
      res.status(201).json({
        version: done.saved.version,
        kind: done.saved.kind,
        lang: done.saved.lang,
        cue_count: done.saved.cue_count,
        sub_version: done.saved.sub_version,
        attribution_version: done.saved.attribution_version,
        rules_version: done.saved.rules_version,
        glossary_version: done.glossary_version,
        download_url: `/api/projects/${p.id}/attributed-exports/${done.saved.version}`,
        content: done.content,
      });    } catch (err) {
      if (err instanceof ExportReject) return res.status(err.statusCode).json(err.payload);
      throw err;
    }
  });

  /** 署名版快照清单（倒序，原文与译文共用一个序列） */
  app.get('/api/projects/:id/attributed-exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json({ project_id: p.id, exports: listAttributedExports(db, p.id) });
  });

  /** 下载某版本署名版 WebVTT（内容创建后不变） */
  app.get('/api/projects/:id/attributed-exports/:version', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const row = getAttributedExport(db, p.id, Number(req.params.version));
    if (!row) return res.status(404).json({ error: `署名版快照版本 ${req.params.version} 不存在` });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    const suffix = row.kind === 'source' ? 'src' : row.lang;
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="project-${p.id}-signed-${suffix}-v${row.version}.vtt"`
    );
    res.send(row.content);
  });

  // ---------- 校对者批量修订提议（提交 → 预览 → 采纳） ----------
  //
  // 一组针对同一项目“未锁定字幕”的待采纳修订：
  //   提交只保存原值快照与当时规则版本，绝不动正式字幕；
  //   预览并列原值/当前值/建议值并按整版候选核对冲突；
  //   采纳时在同一事务中再次核对（存在、未锁定、行版本、规则版本、整版校验），
  //   全部通过才写入全部修订并推进 sub_version；任一不过则整组不生效。

  function getRevision(req, res) {
    const p = getProject(req, res);
    if (!p) return null;
    const rid = Number(req.params.rid);
    const revision = loadRevision(db, p.id, rid);
    if (!revision) {
      res.status(404).json({ error: `修订提议 ${req.params.rid} 不存在` });
      return null;
    }
    return { p, revision };
  }

  /** 提交修订提议 */
  app.post('/api/projects/:id/revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const body = req.body || {};
    const note = body.note !== undefined ? String(body.note) : '';
    // 1. 形状校验：空组 / 重复 ID / 空文本 / 非法时间 / 字段类型 → 400
    const parsed = parseRevisionItems(body);
    if (!parsed.ok) return res.status(400).json({ error: '修订请求非法，未保存提议', errors: parsed.errors });

    // 2. 状态校验（逐项）：目标须仍存在且未锁定；单侧时间与原值合并后仍须 start < end
    const cueById = new Map(p.subtitles.map((s) => [s.id, s]));
    const stateErrors = [];
    for (const it of parsed.items) {
      const cue = cueById.get(it.subtitle_id);
      if (!cue) {
        stateErrors.push(`字幕 ${it.subtitle_id} 不存在，无法提议修订`);
        continue;
      }
      if (cue.locked === 1) {
        stateErrors.push(`字幕 ${it.subtitle_id}（"${cue.text}"）已锁定，锁定字幕不能提交修订提议`);
        continue;
      }
      const s = it.start_ms !== null ? it.start_ms : cue.start_ms;
      const e = it.end_ms !== null ? it.end_ms : cue.end_ms;
      if (s >= e) {
        stateErrors.push(`字幕 ${it.subtitle_id} 合并单侧时间后为 [${s}, ${e}]，开始必须早于结束`);
      }
    }
    if (stateErrors.length > 0) {
      return res.status(422).json({ error: '修订请求未通过目标状态校验，未保存提议', errors: stateErrors });
    }

    const tx = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO revisions (project_id, note, rules_version_snapshot, sub_version_snapshot)
         VALUES (?, ?, ?, ?)`
      ).run(p.id, note, p.rules.version, p.sub_version);
      const rid = info.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO revision_items
           (revision_id, ord, subtitle_id, cue_version, orig_text, orig_start_ms, orig_end_ms,
            proposed_text, start_ms, end_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      parsed.items.forEach((it, i) => {
        const cue = cueById.get(it.subtitle_id);
        ins.run(
          rid, i, it.subtitle_id, it.cue_version,
          cue.text, cue.start_ms, cue.end_ms,
          it.text, it.start_ms, it.end_ms
        );
      });
      return rid;
    });
    const rid = tx();
    res.status(201).json(loadRevision(db, p.id, rid));
  });

  /** 提议历史列表 */
  app.get('/api/projects/:id/revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(listRevisions(db, p.id));
  });

  /** 单个提议（逐项并列原值与建议值） */
  app.get('/api/projects/:id/revisions/:rid', (req, res) => {
    const got = getRevision(req, res);
    if (got) res.json(got.revision);
  });

  /**
   * 预览核对：按“整组应用后的候选整版”检查
   * 词区间、词时段、切点、相邻字幕、字数/时长/字速，以及行/规则版本与锁定状态。
   * 只读，不改任何数据。
   */
  app.post('/api/projects/:id/revisions/:rid/preview', (req, res) => {
    const got = getRevision(req, res);
    if (!got) return;
    const { revision } = got;
    if (revision.status === 'accepted') {
      return res.json({
        revision,
        evaluation: {
          ok: false, rule_version_stale: false, items: [], conflicts: [],
          already_accepted: true, accepted_sub_version: revision.accepted_sub_version,
        },
      });
    }
    const evaluation = evaluateRevision({ project: got.p, revision });
    res.json({ revision, evaluation });
  });

  /**
   * 采纳：同一事务内再次核对目标仍存在且未锁定、各行版本、规则版本与整版校验；
   * 通过后写入全部修订、推进每行版本与字幕集版本、标记提议已采纳。
   * 任一过期或违规则整组不生效，返回当前值与原因。
   */
  app.post('/api/projects/:id/revisions/:rid/accept', (req, res) => {
    const got = getRevision(req, res);
    if (!got) return;
    const { p, revision } = got;
    if (revision.status === 'accepted') {
      return res.status(409).json({
        error: `修订提议 ${revision.id} 已采纳（字幕集推进到 v${revision.accepted_sub_version}），重复提交不得再改字幕`,
        already_accepted: true,
        accepted_sub_version: revision.accepted_sub_version,
        current: { sub_version: p.sub_version, subtitles: p.subtitles },
      });
    }

    class AcceptReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '采纳被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 事务内读取权威当前状态
      const fresh = loadProject(db, p.id);
      const evaluation = evaluateRevision({ project: fresh, revision });

      if (!evaluation.ok) {
        const staleTypes = new Set([
          'cue_version_stale', 'subtitle_missing', 'subtitle_locked', 'rules_version_stale',
        ]);
        const isStale =
          evaluation.rule_version_stale ||
          evaluation.items.some(
            (r) => r.state !== 'ok' || r.conflicts.some((c) => staleTypes.has(c.type))
          );
        const items = evaluation.items
          .filter((r) => r.state !== 'ok' || r.conflicts.length > 0)
          .map((r) => ({
            ord: r.ord,
            subtitle_id: r.subtitle_id,
            state: r.state,
            cue_version: r.cue_version,
            current: r.cue,
            proposed: r.proposed,
            reasons: r.conflicts,
          }));
        throw new AcceptReject(isStale ? 409 : 422, {
          error: isStale
            ? `修订提议 ${revision.id} 存在过期/失效项，整组未生效，请刷新后重新提议`
            : `修订提议 ${revision.id} 共 ${items.length} 项核对未通过（当前规则 v${fresh.rules.version}），整组未生效`,
          rules_version: fresh.rules.version,
          current: { sub_version: fresh.sub_version, subtitles: fresh.subtitles },
          items,
          conflicts: evaluation.conflicts,
        });
      }

      // 全部通过：写入全部修订（WHERE version 兜底防并发）、行版本 +1、推进字幕集版本
      const upd = db.prepare(
        `UPDATE subtitles
           SET text = ?, start_ms = ?, end_ms = ?, version = version + 1
         WHERE id = ? AND project_id = ? AND locked = 0 AND version = ?`
      );
      for (const it of revision.items) {
        const cue = fresh.subtitles.find((s) => s.id === it.subtitle_id);
        const s = it.proposed.has_start_ms ? it.proposed.start_ms : cue.start_ms;
        const e = it.proposed.has_end_ms ? it.proposed.end_ms : cue.end_ms;
        const info = upd.run(it.proposed.text, s, e, it.subtitle_id, fresh.id, it.cue_version);
        if (info.changes !== 1) {
          throw new AcceptReject(409, {
            error: `字幕 ${it.subtitle_id} 在采纳瞬间发生变化，请刷新后重试`,
            current: { sub_version: fresh.sub_version },
          });
        }
      }

      // 写入后整版自检（结构 + 当前规则，含锁定行），失败即回滚
      const updated = loadProject(db, fresh.id);
      const finalProblems = [
        ...validateStructure(updated.subtitles, updated.words, updated.cuts),
        ...validateRules(updated.subtitles, updated.rules),
      ];
      if (finalProblems.length > 0) {
        throw new AcceptReject(422, {
          error: `采纳后整版校验发现 ${finalProblems.length} 处问题，整组已回滚`,
          conflicts: finalProblems,
        });
      }
      const subVersion = bumpSubVersion(db, fresh.id);
      // 源字幕文本/时间变化 → 相关译文转待复核（同事务，与采纳原子一致）
      syncTranslations(db, fresh.id);
      // 已关闭复核意见的相交字幕快照漂移 → 待复核（同事务）
      syncComments(db, fresh.id);
      db.prepare(
        `UPDATE revisions SET status = 'accepted', accepted_at = datetime('now'),
           accepted_sub_version = ? WHERE id = ?`
      ).run(subVersion, revision.id);
      return subVersion;
    });

    try {
      const subVersion = tx();
      const after = loadProject(db, p.id);
      const accepted = after.subtitles.filter((s) =>
        revision.items.some((it) => it.subtitle_id === s.id)
      );
      res.json({
        revision_id: revision.id,
        status: 'accepted',
        sub_version: subVersion,
        applied: revision.items.length,
        subtitles: accepted,
      });
    } catch (err) {
      if (err instanceof AcceptReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  // ---------- 校对者逐词时间修正提议（提交 → 预览 → 确认） ----------
  //
  // 按词序号提交一组起止毫秒修正，携带读取时字幕集 sub_version：
  //   提交只保存原词时间快照，绝不动正式词/字幕；
  //   预览只读核对：受影响字幕、锁定冲突、词序重叠与受影响区间重排候选；
  //   确认时在同一事务里重新读取权威状态再次核对，通过后原子地
  //   更新词时间、删除受影响未锁定字幕并重排、推进字幕集版本。
  //   锁定字幕文本与时间原样保留；未受影响字幕保留 ID/行版本/人工文本。

  function getWordRevision(req, res) {
    const p = getProject(req, res);
    if (!p) return null;
    const wrid = Number(req.params.wrid);
    const revision = loadWordRevision(db, p.id, wrid);
    if (!revision) {
      res.status(404).json({ error: `逐词修正提议 ${req.params.wrid} 不存在` });
      return null;
    }
    return { p, revision };
  }

  /** 提交逐词修正提议（只保存快照，不动正式数据） */
  app.post('/api/projects/:id/word-revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const body = req.body || {};
    if (body.sub_version === undefined || !Number.isInteger(body.sub_version) || body.sub_version < 0) {
      return res.status(400).json({
        error: '请求非法，未保存提议',
        errors: ['sub_version（读取时字幕集版本）必须是 ≥0 的整数'],
      });
    }
    // 1. 形状校验：空组 / 重复序号 / 非法时间 / 字段类型 → 400
    const parsed = parseWordRevisionItems(body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '修正请求非法，未保存提议', errors: parsed.errors });
    }

    // 2. 字幕集乐观锁：携带的 sub_version 必须是当前值，过期直接返回当前值
    if (body.sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（你基于 v${body.sub_version} 读取，当前已是 v${p.sub_version}），请刷新后重新修正`,
        current: { sub_version: p.sub_version, words: p.words, subtitles: p.subtitles },
      });
    }

    // 3. 状态校验：词序号须存在；修正后（与未修正词合并）全部词仍按序互不重叠。
    //    锁定字幕是否容得下、重排是否可行等复杂核对留给预览/确认（保留提议供查看）。
    const stateErrors = [];
    const merged = p.words.map((w) => ({ ...w }));
    for (const it of parsed.items) {
      if (it.word_idx >= p.words.length) {
        stateErrors.push(`词序号 ${it.word_idx} 超出范围（当前共 ${p.words.length} 个词，序号 0..${p.words.length - 1}）`);
        continue;
      }
      merged[it.word_idx] = { ...merged[it.word_idx], start_ms: it.start_ms, end_ms: it.end_ms };
    }
    if (stateErrors.length === 0) {
      for (let k = 0; k + 1 < merged.length; k++) {
        if (merged[k + 1].start_ms < merged[k].end_ms) {
          const touched = parsed.items.some((it) => it.word_idx === k || it.word_idx === k + 1);
          if (touched) {
            stateErrors.push(
              `应用修正后词 ${k} "${merged[k].text}" [${merged[k].start_ms}, ${merged[k].end_ms}] 与 ` +
              `词 ${k + 1} "${merged[k + 1].text}" [${merged[k + 1].start_ms}, ${merged[k + 1].end_ms}] ` +
              '重叠或倒序：修正后全部词仍须按序且互不重叠'
            );
          }
        }
      }
    }
    if (stateErrors.length > 0) {
      return res.status(422).json({ error: '修正请求未通过词序列校验，未保存提议', errors: stateErrors });
    }

    const note = body.note !== undefined ? String(body.note) : '';
    const tx = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO word_revisions (project_id, note, sub_version_snapshot) VALUES (?, ?, ?)'
      ).run(p.id, note, p.sub_version);
      const wrid = info.lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO word_revision_items
           (word_revision_id, ord, word_idx, orig_start_ms, orig_end_ms, start_ms, end_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      parsed.items.forEach((it, i) => {
        const w = p.words[it.word_idx];
        ins.run(wrid, i, it.word_idx, w.start_ms, w.end_ms, it.start_ms, it.end_ms);
      });
      return wrid;
    });
    const wrid = tx();
    res.status(201).json(loadWordRevision(db, p.id, wrid));
  });

  /** 提议历史列表 */
  app.get('/api/projects/:id/word-revisions', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(listWordRevisions(db, p.id));
  });

  /** 单个提议（逐项原值/当前值/建议值） */
  app.get('/api/projects/:id/word-revisions/:wrid', (req, res) => {
    const got = getWordRevision(req, res);
    if (got) res.json(got.revision);
  });

  /**
   * 只读预览核对：受影响字幕（将被重排的未锁定行 / 含修正词的锁定行）、
   * 逐项原词/当前词/建议词时间、候选整版与逐处中文冲突。
   */
  app.post('/api/projects/:id/word-revisions/:wrid/preview', (req, res) => {
    const got = getWordRevision(req, res);
    if (!got) return;
    const { revision } = got;
    if (revision.status === 'confirmed') {
      return res.json({
        revision,
        evaluation: {
          ok: false, stale: false, items: [], conflicts: [],
          subtitles: [], replaced: [], affected_locked: [],
          already_confirmed: true, confirmed_sub_version: revision.confirmed_sub_version,
        },
      });
    }
    const evaluation = evaluateWordRevision({ project: got.p, revision });
    res.json({ revision, evaluation });
  });

  /**
   * 确认：同一事务内重新读取权威状态并再次执行全部核对；
   * 通过则原子写入词时间、删除受影响未锁定字幕并按候选重排（新 ID/新版本）、
   * 更新保留行 idx（ID/行版本不变）、推进字幕集版本、标记提议已确认。
   * 过期/失效（sub_version、词漂移、词缺失）→ 409；
   * 锁定或排版规则不可兼顾 → 422；词与字幕均不变（事务回滚）。
   */
  app.post('/api/projects/:id/word-revisions/:wrid/confirm', (req, res) => {
    const got = getWordRevision(req, res);
    if (!got) return;
    const { p, revision } = got;
    if (revision.status === 'confirmed') {
      return res.status(409).json({
        error: `逐词修正提议 ${revision.id} 已确认（字幕集推进到 v${revision.confirmed_sub_version}），重复提交不得再改词与字幕`,
        already_confirmed: true,
        confirmed_sub_version: revision.confirmed_sub_version,
        current: { sub_version: p.sub_version, words: p.words, subtitles: p.subtitles },
      });
    }

    class ConfirmReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '确认被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 事务内读取权威当前状态（修订明细自身不变，freshRevision 取最新当前词时间）
      const fresh = loadProject(db, p.id);
      const freshRevision = loadWordRevision(db, fresh.id, revision.id);
      const evaluation = evaluateWordRevision({ project: fresh, revision: freshRevision });

      if (!evaluation.ok) {
        const isStale =
          evaluation.stale ||
          evaluation.items.some((r) => r.state !== 'ok');
        const items = evaluation.items
          .filter((r) => r.state !== 'ok' || r.conflicts.length > 0)
          .map((r) => ({
            ord: r.ord, word_idx: r.word_idx, state: r.state,
            orig: r.orig, current: r.current, proposed: r.proposed,
            reasons: r.conflicts,
          }));
        throw new ConfirmReject(isStale ? 409 : 422, {
          error: isStale
            ? `逐词修正提议 ${revision.id} 基于过期字幕集/词时间，请刷新后重新修正（整组未生效）`
            : `逐词修正提议 ${revision.id} 无法兼顾锁定或排版约束，共 ` +
              `${items.length + evaluation.conflicts.length} 处问题；词与字幕均未改动`,
          current: {
            sub_version: fresh.sub_version,
            words: fresh.words,
            subtitles: fresh.subtitles,
          },
          items,
          conflicts: evaluation.conflicts,
          replaced: evaluation.replaced,
          affected_locked: evaluation.affected_locked,
        });
      }

      // 全部通过：1) 更新词时间（带原值 WHERE 兜底；词序/文本不动）
      const updWord = db.prepare(
        `UPDATE words SET start_ms = ?, end_ms = ?
          WHERE project_id = ? AND idx = ? AND start_ms = ? AND end_ms = ?`
      );
      for (const it of freshRevision.items) {
        const info = updWord.run(
          it.proposed.start_ms, it.proposed.end_ms,
          fresh.id, it.word_idx, it.orig.start_ms, it.orig.end_ms
        );
        if (info.changes !== 1) {
          throw new ConfirmReject(409, {
            error: `词 ${it.word_idx} 在确认瞬间发生变化，请刷新后重试`,
            current: { sub_version: fresh.sub_version },
          });
        }
      }

      // 2) 删除受影响的未锁定字幕（带 locked=0 兜底；这些行随后以新 ID/新版本重排）
      const replacedIds = evaluation.replaced.map((s) => s.id);
      if (replacedIds.length > 0) {
        const placeholders = replacedIds.map(() => '?').join(',');
        const delInfo = db.prepare(
          `DELETE FROM subtitles WHERE project_id = ? AND locked = 0 AND id IN (${placeholders})`
        ).run(fresh.id, ...replacedIds);
        if (delInfo.changes !== replacedIds.length) {
          throw new ConfirmReject(409, {
            error: '受影响字幕在确认瞬间发生变化（已锁定/已消失），请刷新后重试',
            current: { sub_version: fresh.sub_version },
          });
        }
      }

      // 3) 按候选整版写入：新行 INSERT；保留行（含锁定行）仅更新 idx（ID/行版本不变）。
      //    先把全部保留行 idx 挪到负的临时值（-id-1，必然互不相同），
      //    避免 UNIQUE(project_id, idx) 在重排时与 0 起的正式 idx 临时撞号。
      db.prepare('UPDATE subtitles SET idx = -id - 1 WHERE project_id = ?').run(fresh.id);
      const insCue = db.prepare(
        `INSERT INTO subtitles (project_id, idx, word_start, word_end, text, start_ms, end_ms, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      );
      const updIdx = db.prepare('UPDATE subtitles SET idx = ? WHERE id = ? AND project_id = ?');
      evaluation.subtitles.forEach((c, i) => {
        if (c.origin === 'kept') updIdx.run(i, c.id, fresh.id);
        else insCue.run(fresh.id, i, c.word_start, c.word_end, c.text, c.start_ms, c.end_ms);
      });

      // 4) 写入后整版终检（结构 + 当前规则，含锁定行），失败即回滚
      const updated = loadProject(db, fresh.id);
      const finalProblems = [
        ...validateStructure(updated.subtitles, updated.words, updated.cuts),
        ...validateRules(updated.subtitles, updated.rules),
      ];
      if (finalProblems.length > 0) {
        throw new ConfirmReject(422, {
          error: `确认后整版校验发现 ${finalProblems.length} 处问题，词与字幕已全部回滚`,
          conflicts: finalProblems,
        });
      }

      const subVersion = bumpSubVersion(db, fresh.id);
      // 词时间/受影响区间重排导致的源行变化：受影响行译文转待复核，被删行译文留历史；
      // 被删行的说话人归属同样留作历史，新行待标注（不按展示序号转移）。
      syncTranslations(db, fresh.id);
      syncAttributions(db, fresh.id);
      // 逐词改时/字幕行更替后：已关闭意见的相交字幕快照漂移 → 待复核
      syncComments(db, fresh.id);
      db.prepare(
        `UPDATE word_revisions SET status = 'confirmed', confirmed_at = datetime('now'),
           confirmed_sub_version = ? WHERE id = ?`
      ).run(subVersion, revision.id);
      return { subVersion, replacedCount: replacedIds.length };
    });

    try {
      const summary = tx();
      const after = loadProject(db, p.id);
      res.json({
        word_revision_id: revision.id,
        status: 'confirmed',
        sub_version: summary.subVersion,
        words_updated: revision.items.length,
        cues_replaced: summary.replacedCount,
        words: after.words,
        subtitles: after.subtitles,
      });
    } catch (err) {
      if (err instanceof ConfirmReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  // ---------- 多语言译文字幕 ----------
  //
  // 译文沿用源字幕的起止时间与词区间：接口不接受任何时间/词区间/原文字段，
  // 也不改词、切点、原文。保存携带 语言代号、字幕 ID、读取时行版本 cue_version、
  // 译文版本 version（新建省略/0）；同一语言每条当前字幕最多一份非历史译文。
  // 源字幕文本/时间/词区间变化 → 译文待复核（syncTranslations 统一对账）；
  // 仅锁定/展示顺序变化不失效；源行删除 → 译文留历史，新行视为缺译，不按序号挪用。

  /** 解析路径中的语言代号，非法直接回 400 */
  function getLang(req, res) {
    const lang = normalizeLang(req.params.lang);
    if (!lang) {
      res.status(400).json({
        error: `语言代号 ${JSON.stringify(req.params.lang)} 非法：须非空、≤32 字、字母开头（字母/数字/-/_），如 en、ja-JP、pt_BR`,
      });
      return null;
    }
    return lang;
  }

  /** 项目语言总览（各语言译文状态分布 + 导出数） */
  app.get('/api/projects/:id/translations', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json({
      project_id: p.id,
      sub_version: p.sub_version,
      rules_version: p.rules ? p.rules.version : null,
      cue_count: p.subtitles.length,
      languages: listLanguages(db, p.id),
    });
  });

  /**
   * 单语言并列查询：原文、译文与状态（missing/current/review）逐行并列，
   * 附现行规则原因 invalid_reasons、术语缺失 term_issues 与该语言历史译文；只读。
   */
  app.get('/api/projects/:id/translations/:lang', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    res.json(buildLangView(db, p.id, lang));
  });

  // ---------- 重排后历史译文找回（候选查看 → 组级恢复） ----------
  //
  // 重排删除源行后，译文留作 history（绝不按序号自动挪用）。新排版产生的缺译行，
  // 若历史译文与当前行来自同一次逐词导入（projects.import_version）、词区间与源字幕
  // 文本均一致，校对者可显式恢复为一条普通 current 译文。重新导入留下的旧代次历史、
  // 无法确认导入归属（src_import_id 为 NULL）的旧历史仅供查看、不能恢复。
  //
  // 恢复请求携带读取时字幕集 sub_version、规则 rules_version 与逐行选择
  // {subtitle_id, cue_version, translation_id, version}，一次可选择多行；服务端在同一
  // 事务内重新核对目标仍缺译、候选三要素匹配与现行字数/字速，任一失效按行说明且整组
  // 不写。恢复是 INSERT 新的普通 current 译文（版本 1），原 history 行保留不改；
  // 不推进 sub_version、不改历史记录与旧导出快照；术语缺失仍在译文视图提示并阻止导出。

  /**
   * 候选查询（只读）：列出该语言当前缺译行的全部历史候选及匹配依据。
   * GET …/translations/:lang/recovery-candidates
   */
  app.get('/api/projects/:id/translations/:lang/recovery-candidates', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    res.json(buildRecoveryView(db, p.id, lang));
  });

  /**
   * 组级恢复：
   * POST …/translations/:lang/recover
   *   {sub_version, rules_version,
   *    items:[{subtitle_id, cue_version, translation_id, version}]}
   * 201 整组恢复成功（每行新建 current 译文 v1；原历史行保留）；
   * 400 请求形状非法或候选译文不属于本项目/本语言/不是历史；
   * 409 字幕集或规则版本漂移、行版本过期、目标已不缺译、候选版本/匹配失效；
   * 422 候选译文违反现行字数/字速。任一失败按行返回当前值与原因，整组不写入。
   */
  app.post('/api/projects/:id/translations/:lang/recover', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;

    const parsed = parseRecoveryBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '历史译文恢复请求非法，未恢复任何译文', errors: parsed.errors });
    }
    const request = parsed.request;

    class RecoveryReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '历史译文恢复被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 事务内读取权威当前状态重新核对（防止读取后字幕集/规则/译文发生变化）
      const fresh = loadProject(db, p.id);
      const evaluation = evaluateRecovery(db, fresh, lang, request);

      // 顶层版本漂移（字幕集/规则）→ 409，带当前值
      if (evaluation.sub_version_stale || evaluation.rules_version_stale) {
        const why = [];
        if (evaluation.sub_version_stale) {
          why.push(`字幕集版本漂移：提交基于 v${request.sub_version}，当前已是 v${fresh.sub_version}`);
        }
        if (evaluation.rules_version_stale) {
          why.push(`规则版本漂移：提交基于 v${request.rules_version}，当前已是 v${fresh.rules.version}`);
        }
        throw new RecoveryReject(409, {
          error: `${why.join('；')}；整组未恢复，请刷新候选后重新提交`,
          sub_version_stale: evaluation.sub_version_stale,
          rules_version_stale: evaluation.rules_version_stale,
          current: {
            sub_version: fresh.sub_version,
            rules_version: fresh.rules.version,
            rules: fresh.rules,
            subtitles: fresh.subtitles,
          },
          items: evaluation.items
            .filter((it) => it.state !== 'ok')
            .map((it) => ({
              ord: it.ord, subtitle_id: it.subtitle_id, state: it.state,
              cue: it.cue, current: it.current,
              candidate: it.candidate, reasons: it.reasons,
            })),
        });
      }

      const bad = evaluation.items.filter((it) => it.state !== 'ok');
      if (bad.length > 0) {
        // 候选本身不存在/不属于该语言/不是历史 → 400（请求指向了无效资源）；
        // 其余过期/失效类 → 409；仅规则违规（invalid）→ 422。一行 400 整组按 400。
        const hasShape = bad.some((it) => RECOVERY_SHAPE_STATES.has(it.state));
        const hasStale = bad.some((it) => RECOVERY_STALE_STATES.has(it.state));
        const statusCode = hasShape ? 400 : (hasStale ? 409 : 422);
        throw new RecoveryReject(statusCode, {
          error: hasShape
            ? `恢复请求包含无效候选，整组未恢复（共 ${bad.length} 行有问题），请重新拉取候选列表`
            : hasStale
              ? `恢复组存在 ${bad.length} 行过期/失效项，整组未恢复，请刷新候选后重新提交`
              : `恢复组有 ${bad.length} 行候选译文不满足当前字数/字速规则，整组未恢复`,
          sub_version: fresh.sub_version,
          rules_version: fresh.rules.version,
          items: bad.map((it) => ({
            ord: it.ord,
            subtitle_id: it.subtitle_id,
            cue_version: it.cue_version,
            translation_id: it.translation_id,
            version: it.version,
            state: it.state,
            cue: it.cue,
            current: it.current,
            candidate: it.candidate,
            reasons: it.reasons,
          })),
        });
      }

      // 全部通过：逐行 INSERT 一条新的普通 current 译文（版本从 1 开始）。
      // 原 history 行保持不变（历史记录不改）；不推进 sub_version（只写译文，与回填一致）。
      const currentImportId = fresh.import_version;
      const ins = db.prepare(
        `INSERT INTO translations
           (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
            src_text, src_start_ms, src_end_ms, src_word_start, src_word_end, src_import_id)
         VALUES (?, ?, ?, ?, 'current', 1, ?, ?, ?, ?, ?, ?, ?)`
      );
      const glossary = getGlossary(db, fresh.id, lang);
      const applied = [];
      for (const it of evaluation.items) {
        const cue = it.cue;
        const info = ins.run(
          fresh.id, lang, cue.id, it.text, cue.version, cue.text,
          cue.start_ms, cue.end_ms, cue.word_start, cue.word_end, currentImportId
        );
        // 部分唯一索引兜底：并发写入导致该语言该字幕已有非历史译文 → 整组回滚
        if (info.changes !== 1) {
          throw new RecoveryReject(409, {
            error: `字幕 ${cue.id} 在恢复瞬间出现了译文，请刷新候选后重新提交整组`,
            current: { sub_version: fresh.sub_version },
          });
        }
        const row = db.prepare('SELECT * FROM translations WHERE id = ?').get(info.lastInsertRowid);
        const termCheck = checkTerms(cue.text, row.text, glossary.terms);
        applied.push({
          ord: it.ord,
          subtitle_id: cue.id,
          translation_id: row.id,
          restored_from: it.translation_id,
          version: 1,
          text: row.text,
          // 术语缺失只作提示：仍可恢复，但继续按既有译文视图/导出闸门阻止导出
          glossary_version: glossary.version,
          term_issues: termCheck.missing,
        });
      }

      return { applied, import_version: currentImportId, glossary_version: glossary.version };
    });

    try {
      const done = tx();
      const after = loadProject(db, p.id);
      return res.status(201).json({
        lang,
        sub_version: after.sub_version,
        rules_version: after.rules.version,
        import_version: done.import_version,
        restored_count: done.applied.length,
        items: done.applied,
      });
    } catch (err) {
      if (err instanceof RecoveryReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  // ---------- 译审术语对照表（按项目 + 目标语言维护源词 → 规定译法） ----------
  //
  // 整表修改（整体替换词条）并携带读取时术语版本 version：未配置传 0，已配置须传
  // 当前版本；过期返回 409 与当前表。词与译法均为非空文本（无首尾空白、≤100 字），
  // 同一语言源词不得重复；允许空词条数组（清空该语言术语，未配置语言不受影响）。
  // 按当前原文字幕文本精确匹配源词：命中源词的译文须包含对应规定译法，一行命中多词
  // 全部满足。术语变更不改变既有译文 current/review 状态；术语缺失只在三类导出
  // （单语言导出/多语交付/译文署名导出）的事务内拦截，译文仍可保存供修正。

  /** 项目全部语言术语表总览（语言/版本/词条数） */
  app.get('/api/projects/:id/glossaries', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json({ project_id: p.id, glossaries: listGlossaries(db, p.id) });
  });

  /** 读取某语言当前术语表（未配置返回 configured:false, version:0, terms:[]） */
  app.get('/api/projects/:id/glossaries/:lang', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    res.json(getGlossary(db, p.id, lang));
  });

  /**
   * 整表修改某语言术语：{ version, terms:[{source, target}] }。
   * 200 替换成功（新建首版同样返回 200）；400 形状非法；409 术语版本过期（带 current 当前表）。
   */
  app.put('/api/projects/:id/glossaries/:lang', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const parsed = parseGlossaryBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '术语表请求非法，未修改', errors: parsed.errors });
    }
    try {
      const saved = db.transaction(() => replaceGlossary(db, p.id, lang, parsed.request))();
      res.json(saved);
    } catch (err) {
      if (err instanceof StaleGlossaryError) {
        return res.status(409).json({
          error: `术语版本过期：你基于 v${parsed.request.version} 修改，当前已是 v${err.current.version}，请刷新后重试`,
          current: err.current,
        });
      }
      throw err;
    }
  });

  /**
   * 术语缺失查询（只读）：按语言列出当前字幕中命中术语源词、但译文缺失规定译法的行。
   * 按语言、字幕 ID 与源词逐条列出，并给出当前术语版本；未配置术语的语言返回空列表。
   * 无译文的行同样列出（供补译）；不改变任何数据与状态。
   */
  app.get('/api/projects/:id/glossaries/:lang/missing', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const cues = db.prepare(
      `SELECT id, idx, text FROM subtitles WHERE project_id = ? ORDER BY idx`
    ).all(p.id);
    const glossary = getGlossary(db, p.id, lang);
    const byCue = activeTranslationsByLang(db, p.id, lang);
    const evalRes = evaluateTerms(cues, byCue, glossary);
    res.json({
      project_id: p.id,
      lang,
      configured: glossary.configured,
      glossary_version: glossary.version,
      cue_count: cues.length,
      missing: evalRes.rows,
    });
  });

  /**
   * 保存/更新一条译文（按语言+字幕身份 upsert）。
   * 新建返回 201，更新返回 200。
   *   - cue_version 必须等于当前源行版本，否则 409 返回当前值；
   *   - 译文 version 新建传 0/省略，更新必须等于当前译文版本，否则 409；
   *   - 译文须满足现行 max_chars / max_cps（时长随源行），否则 422 且不改数据。
   * 保存成功即为 current 并刷新源快照（校对者可直接在漂移后重新保存来消解待复核）。
   */
  app.put('/api/projects/:id/translations/:lang/subtitles/:sid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const sid = Number(req.params.sid);

    const parsed = parseTranslationBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: '译文请求非法，未保存', errors: parsed.errors });

    const cue = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!cue) return res.status(404).json({ error: `字幕 ${req.params.sid} 不存在（可能已被重排删除，请按当前行重新翻译）` });

    if (parsed.item.cue_version !== cue.version) {
      return res.status(409).json({
        error: `源字幕行版本过期：你基于 v${parsed.item.cue_version} 读取，当前已是 v${cue.version}`,
        current: { cue, rules: p.rules },
      });
    }

    const ruleErrors = checkTranslationText(parsed.item.text, cue, p.rules);
    if (ruleErrors.length > 0) {
      return res.status(422).json({ error: '译文未通过当前字数/字速规则，未保存', errors: ruleErrors, current: { cue } });
    }

    const existing = db.prepare(
      `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ? AND status != 'history'`
    ).get(p.id, lang, sid);

    if (existing && parsed.item.version === 0) {
      return res.status(409).json({
        error: `语言 ${lang} 在字幕 ${sid} 上已存在译文 v${existing.version}（${existing.status === 'review' ? '待复核' : '当前'}）：更新须携带其 version`,
        current: { translation: mapRow(existing) },
      });
    }
    if (existing && parsed.item.version !== existing.version) {
      return res.status(409).json({
        error: `译文版本过期：你基于 v${parsed.item.version} 修改，当前已是 v${existing.version}`,
        current: { cue, translation: mapRow(existing) },
      });
    }

    let statusCode = 200;
    const tx = db.transaction(() => {
      const importId = db.prepare('SELECT import_version FROM projects WHERE id = ?').get(p.id).import_version;
      if (existing) {
        db.prepare(
          `UPDATE translations SET text = ?, version = version + 1, status = 'current',
             cue_version_snapshot = ?, src_text = ?, src_start_ms = ?, src_end_ms = ?,
             src_word_start = ?, src_word_end = ?, src_import_id = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          parsed.item.text, cue.version, cue.text, cue.start_ms, cue.end_ms,
          cue.word_start, cue.word_end, importId, existing.id
        );
      } else {
        db.prepare(
          `INSERT INTO translations
             (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
              src_text, src_start_ms, src_end_ms, src_word_start, src_word_end, src_import_id)
           VALUES (?, ?, ?, ?, 'current', 1, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          p.id, lang, sid, parsed.item.text, cue.version, cue.text,
          cue.start_ms, cue.end_ms, cue.word_start, cue.word_end, importId
        );
        statusCode = 201;
      }
    });
    tx();
    const row = db.prepare(
      `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ? AND status != 'history'`
    ).get(p.id, lang, sid);
    // 术语核对仅作提示：译文即使缺失规定译法也可保存供后续修正，不改变 current 状态
    const glossary = getGlossary(db, p.id, lang);
    const termCheck = checkTerms(cue.text, row.text, glossary.terms);
    res.status(statusCode).json({
      translation: mapRow(row), cue, valid: true,
      glossary_version: glossary.version,
      term_issues: termCheck.missing,
    });
  });

  /**
   * 确认待复核译文：校对者核对当前源行后，认为译文仍适用。
   *   - 译文必须存在且处于 review；current/历史 → 422 且不改数据；
   *   - version 必须等于当前译文版本，否则 409 返回当前值与原因；
   *   - 译文须满足现行字数/字速规则，否则 422 返回当前值与原因。
   * 通过后刷新源快照、转 current、译文版本 +1（源行版本/时间本身不变）。
   */
  app.post('/api/projects/:id/translations/:lang/subtitles/:sid/confirm', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const sid = Number(req.params.sid);

    const parsed = parseConfirmBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: '确认请求非法', errors: parsed.errors });

    const row = db.prepare(
      `SELECT * FROM translations WHERE project_id = ? AND lang = ? AND subtitle_id = ? AND status != 'history'`
    ).get(p.id, lang, sid);
    if (!row) {
      const cue = db.prepare('SELECT id, text, version FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
      return res.status(404).json({
        error: `语言 ${lang} 在字幕 ${sid} 上没有可确认的译文`,
        current: { cue: cue || null },
      });
    }
    if (row.status !== 'review') {
      return res.status(422).json({
        error: `该译文当前为 ${row.status === 'current' ? '当前有效' : row.status} 状态，无需确认`,
        current: { translation: mapRow(row) },
      });
    }
    if (parsed.version !== row.version) {
      return res.status(409).json({
        error: `译文版本过期：你基于 v${parsed.version} 确认，当前已是 v${row.version}`,
        current: { translation: mapRow(row) },
      });
    }
    const cue = db.prepare('SELECT * FROM subtitles WHERE id = ? AND project_id = ?').get(sid, p.id);
    if (!cue) {
      return res.status(404).json({ error: `字幕 ${sid} 已不存在`, current: { translation: mapRow(row) } });
    }
    const ruleErrors = checkTranslationText(row.text, cue, p.rules);
    if (ruleErrors.length > 0) {
      return res.status(422).json({
        error: '待复核译文不满足当前字数/字速规则，请先修改译文再确认（数据未改动）',
        errors: ruleErrors,
        current: { cue, translation: mapRow(row) },
      });
    }

    db.transaction(() => {
      const importId = db.prepare('SELECT import_version FROM projects WHERE id = ?').get(p.id).import_version;
      db.prepare(
        `UPDATE translations SET status = 'current', cue_version_snapshot = ?,
           src_text = ?, src_start_ms = ?, src_end_ms = ?, src_word_start = ?, src_word_end = ?,
           src_import_id = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`
      ).run(cue.version, cue.text, cue.start_ms, cue.end_ms, cue.word_start, cue.word_end,
        importId, row.id);
    })();
    const updated = db.prepare('SELECT * FROM translations WHERE id = ?').get(row.id);
    const confirmGlossary = getGlossary(db, p.id, lang);
    const confirmTermCheck = checkTerms(cue.text, updated.text, confirmGlossary.terms);
    res.json({
      translation: mapRow(updated), cue, valid: true,
      glossary_version: confirmGlossary.version,
      term_issues: confirmTermCheck.missing,
    });
  });

  /**
   * 按语言确认导出：先整版核对——
   *   源字幕结构（覆盖/重叠/切点/词时段）与现行规则通过，且当前每行都有
   *   current 且满足字数/字速的译文；否则列出 missing/review/invalid/conflicts，
   *   不生成快照。成功则生成按时间升序、不可变的译文 WebVTT 快照。
   * 可携带 sub_version 防呆（与当前不一致 → 409）。
   */
  app.post('/api/projects/:id/translations/:lang/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const { sub_version } = req.body || {};
    if (sub_version !== undefined && sub_version !== p.sub_version) {
      return res.status(409).json({
        error: `字幕集已被修改（当前版本 ${p.sub_version}），请刷新后再确认导出`,
        current: { sub_version: p.sub_version },
      });
    }

    class TranslationExportReject extends Error {
      constructor(payload) {
        super(payload.error || '译文导出被拒绝');
        this.payload = payload;
      }
    }

    // 在同一事务内读取权威状态并按当前术语核对：任一缺失逐行报错且不生成快照
    const txExport = db.transaction(() => {
      const check = evaluateExport(db, p.id, lang);
      if (!check.ok) {
        const problems =
          check.missing.length + check.review.length + check.invalid.length +
          check.term_missing.length + check.conflicts.length;
        throw new TranslationExportReject({
          status: 422,
          body: {
            error: `语言 ${lang} 未通过导出核对（${problems} 处问题），未生成快照`,
            missing: check.missing,
            review: check.review,
            invalid: check.invalid,
            term_missing: check.term_missing,
            glossary_version: check.glossary_version,
            conflicts: check.conflicts,
          },
        });
      }

      // 译文沿用源字幕起止：按 idx（时间升序）取译文文本生成 WebVTT
      const cues = check.entries.map((e, i) => ({
        start_ms: e.cue.start_ms, end_ms: e.cue.end_ms, text: e.translation.text, idx: i,
      }));
      const content = toWebVtt(cues);
      const next = (db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS v FROM translation_exports WHERE project_id = ? AND lang = ?'
      ).get(p.id, lang).v) + 1;
      db.prepare(
        'INSERT INTO translation_exports (project_id, lang, version, content, cue_count) VALUES (?, ?, ?, ?, ?)'
      ).run(p.id, lang, next, content, cues.length);
      return { version: next, content, cueCount: cues.length, glossaryVersion: check.glossary_version };
    });

    try {
      const done = txExport();
      res.status(201).json({
        lang, version: done.version, cue_count: done.cueCount,
        glossary_version: done.glossaryVersion,
        download_url: `/api/projects/${p.id}/translations/${encodeURIComponent(lang)}/exports/${done.version}`,
        content: done.content,
      });
    } catch (err) {
      if (err instanceof TranslationExportReject) {
        return res.status(err.payload.status).json(err.payload.body);
      }
      throw err;
    }
  });

  /** 某语言译文导出快照列表 */
  app.get('/api/projects/:id/translations/:lang/exports', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    res.json(db.prepare(
      'SELECT lang, version, cue_count, created_at FROM translation_exports WHERE project_id = ? AND lang = ? ORDER BY version DESC'
    ).all(p.id, lang));
  });

  /** 下载某语言某版本译文 WebVTT（内容创建后不变） */
  app.get('/api/projects/:id/translations/:lang/exports/:version', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    const row = db.prepare(
      'SELECT * FROM translation_exports WHERE project_id = ? AND lang = ? AND version = ?'
    ).get(p.id, lang, Number(req.params.version));
    if (!row) return res.status(404).json({ error: `语言 ${lang} 的译文导出版本 ${req.params.version} 不存在` });
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="project-${p.id}-${lang}-v${row.version}.vtt"`);
    res.send(row.content);
  });

  // ---------- 译者整批译文回填（一种目标语言整批写入当前字幕） ----------
  //
  // 译者完成整批译文后，按一种目标语言一次回填：提交 批次编号、读取时字幕集版本
  // 与规则版本，以及非空逐行清单（字幕 ID、源行版本、译文版本[0=新建] 与非空文本）。
  // 同批重复 ID / 无效语言 / 不存在的字幕在写入前拒绝；提交时在同一事务内重新核对
  // 版本、源行与现行字数/字速：任一行过期或违规，按行返回当前值与原因，整批不写入。
  // 通过后原子保存全部译文（新建版本 1；更新版本 +1 并刷新源快照为 current），
  // 允许覆盖待复核译文；未列出的行与其他语言不变。
  // 幂等：同项目同语言 batch_no 重复且内容相同 → 返回首次结果（不再写入）；
  //       编号相同内容不同 → 409 冲突；失败批次不占编号。
  // 回填结果即普通译文，逐行操作/单语言导出/多语交付继续读取；旧快照不变。

  /**
   * 提交整批回填。
   *   {batch_no, note?, sub_version, rules_version,
   *    items:[{subtitle_id, cue_version, version?(0=新建), text}]}
   * 201 首次写入成功；200 同编号同内容幂等重放（返回首次结果）；
   * 400 形状非法（含语言非法/同批重复 ID/字幕不存在）；
   * 409 版本漂移/源行或译文版本过期/编号冲突（带每行 current 与原因）；
   * 422 译文违反现行字数/字速（整批不写入）。
   */
  app.post('/api/projects/:id/translations/:lang/batches', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;

    // 1. 形状校验（纯请求问题，不触碰数据、不占编号）
    const parsed = parseTranslationBatchBody(req.body, lang);
    if (!parsed.ok) {
      return res.status(400).json({ error: '整批回填请求非法，未写入译文', errors: parsed.errors });
    }
    const request = parsed.request;

    // 2. 清单中的字幕行必须存在（不存在的字幕拒绝；事务内还会兜底再核对）
    const cueIds = new Set(p.subtitles.map((c) => c.id));
    const missingCues = request.items
      .map((it) => it.subtitle_id)
      .filter((sid) => !cueIds.has(sid));
    if (missingCues.length > 0) {
      return res.status(400).json({
        error: '整批回填请求非法，未写入译文',
        errors: [...new Set(missingCues)].map(
          (sid) => `字幕 ${sid} 在当前字幕集（v${p.sub_version}）中不存在（可能已被重排删除），请按当前行重新提交`
        ),
      });
    }

    class BatchReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '整批回填被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const hash = contentHash(p.id, lang, request);

    const tx = db.transaction(() => {
      // 3. 幂等/冲突：同项目同语言 batch_no 已存在
      const prior = db.prepare(
        'SELECT * FROM translation_batches WHERE project_id = ? AND lang = ? AND batch_no = ?'
      ).get(p.id, lang, request.batch_no);
      if (prior) {
        if (prior.content_hash === hash) {
          // 内容相同：幂等返回首次结果，不再写入任何译文
          return { replayed: true, status: 200, result: JSON.parse(prior.result_json) };
        }
        // 编号相同内容不同：冲突；不新增批次、不占编号
        throw new BatchReject(409, {
          error:
            `语言 ${lang} 的批次编号 "${request.batch_no}" 已被占用且本次内容不同：` +
            '请改用新的批次编号，或提交与首次完全相同的内容以取得首次结果',
          conflict: 'batch_no_content_conflict',
          existing_batch: {
            id: prior.id, batch_no: prior.batch_no, lang: prior.lang,
            sub_version: prior.sub_version, rules_version: prior.rules_version,
            item_count: prior.item_count, created_at: prior.created_at,
          },
          submitted: {
            sub_version: request.sub_version, rules_version: request.rules_version,
            item_count: request.items.length,
            content_hash: hash,
          },
        });
      }

      // 4. 事务内读取权威当前状态，整批重新核对
      const fresh = loadProject(db, p.id);
      const activeByCue = activeTranslationsByLang(db, fresh.id, lang);
      const evaluation = evaluateBatch(fresh, lang, request, activeByCue);

      // 4a. 顶层版本漂移（字幕集/规则）→ 409，带当前值，整批不写入
      if (evaluation.sub_version_stale || evaluation.rules_version_stale) {
        const why = [];
        if (evaluation.sub_version_stale) {
          why.push(`字幕集版本漂移：提交基于 v${request.sub_version}，当前已是 v${fresh.sub_version}`);
        }
        if (evaluation.rules_version_stale) {
          why.push(`规则版本漂移：提交基于 v${request.rules_version}，当前已是 v${fresh.rules.version}`);
        }
        throw new BatchReject(409, {
          error: `${why.join('；')}；整批未写入，请刷新后重新提交`,
          sub_version_stale: evaluation.sub_version_stale,
          rules_version_stale: evaluation.rules_version_stale,
          current: {
            sub_version: fresh.sub_version,
            rules_version: fresh.rules.version,
            rules: fresh.rules,
            subtitles: fresh.subtitles,
          },
          items: evaluation.items
            .filter((it) => it.state !== 'ok')
            .map((it) => ({
              ord: it.ord, subtitle_id: it.subtitle_id, state: it.state,
              cue: it.cue, current: it.current ? mapRow(it.current) : null, reasons: it.reasons,
            })),
        });
      }

      // 4b. 逐行核对：过期类 → 409；规则违规类 → 422；任一不过整批不写入
      const bad = evaluation.items.filter((it) => it.state !== 'ok');
      if (bad.length > 0) {
        const staleTypes = new Set([
          'cue_missing', 'cue_version_stale', 'translation_missing',
          'translation_exists', 'translation_version_stale',
        ]);
        const isStale = bad.some((it) => staleTypes.has(it.state));
        throw new BatchReject(isStale ? 409 : 422, {
          error: isStale
            ? `整批回填存在 ${bad.length} 行过期/失效项，整批未写入，请刷新后重新提交`
            : `整批回填有 ${bad.length} 行译文不满足当前字数/字速规则，整批未写入`,
          sub_version: fresh.sub_version,
          rules_version: fresh.rules.version,
          items: bad.map((it) => ({
            ord: it.ord,
            subtitle_id: it.subtitle_id,
            cue_version: it.cue_version,
            version: it.version,
            state: it.state,
            text: it.text,
            cue: it.cue,
            current: it.current ? mapRow(it.current) : null,
            reasons: it.reasons,
          })),
        });
      }

      // 5. 全部通过：同一事务保存全部译文。
      //    新建 → INSERT 版本 1；更新（含覆盖待复核）→ UPDATE 版本 +1、源快照刷新为 current。
      //    WHERE 条件带 version 兜底，防止核对与写入之间的并发改动。
      const currentImportId = db.prepare(
        'SELECT import_version FROM projects WHERE id = ?'
      ).get(fresh.id).import_version;
      const ins = db.prepare(
        `INSERT INTO translations
           (project_id, lang, subtitle_id, text, status, version, cue_version_snapshot,
            src_text, src_start_ms, src_end_ms, src_word_start, src_word_end, src_import_id)
         VALUES (?, ?, ?, ?, 'current', 1, ?, ?, ?, ?, ?, ?, ?)`
      );
      const upd = db.prepare(
        `UPDATE translations SET text = ?, version = version + 1, status = 'current',
           cue_version_snapshot = ?, src_text = ?, src_start_ms = ?, src_end_ms = ?,
           src_word_start = ?, src_word_end = ?, src_import_id = ?, updated_at = datetime('now')
         WHERE id = ? AND project_id = ? AND version = ?`
      );

      const applied = [];
      let createdCount = 0;
      let updatedCount = 0;
      for (const it of evaluation.items) {
        const cue = it.cue;
        const existing = it.current;
        if (existing) {
          const info = upd.run(
            it.text, cue.version, cue.text, cue.start_ms, cue.end_ms,
            cue.word_start, cue.word_end, currentImportId, existing.id, fresh.id, existing.version
          );
          if (info.changes !== 1) {
            throw new BatchReject(409, {
              error: `字幕 ${cue.id} 的译文在回填瞬间发生变化，请刷新后重新提交整批`,
              current: { sub_version: fresh.sub_version },
            });
          }
          it.action = 'updated';
          it.result_version = existing.version + 1;
          updatedCount++;
        } else {
          ins.run(
            fresh.id, lang, cue.id, it.text, cue.version, cue.text,
            cue.start_ms, cue.end_ms, cue.word_start, cue.word_end, currentImportId
          );
          it.action = 'created';
          it.result_version = 1;
          createdCount++;
        }
        applied.push({
          ord: it.ord, subtitle_id: cue.id, action: it.action,
          version: it.result_version, text: it.text,
        });
      }

      // 6. 写入批次与逐行清单（占编号）；首次结果存为快照供幂等重放原样返回。
      //    回填只写译文、不改源字幕，因此不推进 sub_version。
      const result = {
        batch_no: request.batch_no,
        lang,
        note: request.note,
        sub_version: fresh.sub_version,
        rules_version: fresh.rules.version,
        item_count: applied.length,
        created_count: createdCount,
        updated_count: updatedCount,
        items: applied,
      };
      const batchId = db.prepare(
        `INSERT INTO translation_batches
           (project_id, batch_no, lang, note, sub_version, rules_version,
            item_count, created_count, updated_count, content_hash, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        fresh.id, request.batch_no, lang, request.note,
        fresh.sub_version, fresh.rules.version, applied.length,
        createdCount, updatedCount, hash, JSON.stringify(result)
      ).lastInsertRowid;
      const insItem = db.prepare(
        `INSERT INTO translation_batch_items
           (batch_id, ord, subtitle_id, cue_version, version, text, action, result_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      evaluation.items.forEach((it) => {
        insItem.run(
          batchId, it.ord, it.subtitle_id, it.cue_version, it.version,
          it.text, it.action, it.result_version
        );
      });
      result.id = batchId;
      result.created_at = db.prepare('SELECT created_at FROM translation_batches WHERE id = ?')
        .get(batchId).created_at;
      // 回填后把含 id/created_at 的最终结果也固化（重放返回值与首次一致）
      db.prepare('UPDATE translation_batches SET result_json = ? WHERE id = ?')
        .run(JSON.stringify(result), batchId);

      return { replayed: false, status: 201, result };
    });

    try {
      const done = tx();
      return res.status(done.status).json({ replayed: done.replayed, ...done.result });
    } catch (err) {
      if (err instanceof BatchReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  /** 回填批次清单（可按语言过滤；倒序） */
  app.get('/api/projects/:id/translations/:lang/batches/list', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const lang = getLang(req, res);
    if (!lang) return;
    res.json({ project_id: p.id, batches: listTranslationBatches(db, p.id, lang) });
  });

  /** 全部语言回填批次清单（倒序） */
  app.get('/api/projects/:id/translation-batches', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json({ project_id: p.id, batches: listTranslationBatches(db, p.id, null) });
  });

  /** 单个回填批次（逐行清单与写入结果） */
  app.get('/api/projects/:id/translation-batches/:tbid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const batch = loadTranslationBatch(db, p.id, Number(req.params.tbid));
    if (!batch) return res.status(404).json({ error: `译文回填批次 ${req.params.tbid} 不存在` });
    res.json(batch);
  });

  // ---------- 片方多语字幕交付（原文 + 多语言冻结为同一时间轴的一个批次） ----------
  //
  // 一次提交把当前源字幕与选定语言冻结为一个批次：携带字幕集版本、规则版本、
  // 非空且不重复的语言列表，以及各语言逐行译文版本。服务端在一个事务内核对
  // 源整版结构与现行规则、每行译文 current 且满足字数/字速、提交版本仍有效；
  // 任一语言缺译/待复核/无效/版本漂移，按语言和字幕行返回原因，整批不生成快照
  // 或消耗版本。成功时在现有原文与各语言导出序列中各生成一个不可变 WebVTT 版本，
  // 并以批次清单关联。文件经既有下载接口取得，旧批次不随后续编辑改变。

  /**
   * 提交交付批次。
   *   {note?, sub_version, rules_version, languages:[...],
   *    translations: { "<lang>": [{subtitle_id, version}, ...] }}
   * 400 请求非法；409 字幕集/规则版本漂移（带 current）；422 源整版冲突或按语言/行核对失败；
   * 201 整批冻结成功（事务内），返回批次清单与各文件下载地址。
   */
  app.post('/api/projects/:id/deliveries', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;

    // 1. 形状校验（事务外，纯请求问题不触碰任何数据）
    const parsed = parseDeliveryBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '交付请求非法，未生成批次', errors: parsed.errors });
    }
    const request = parsed.request;

    // 2. 清单覆盖性快速校验：每种语言的逐行条目必须与当前字幕行一一对应。
    //    （事务内会对权威状态再核对一次；此处给出更早、更明确的中文原因。）
    if (p.subtitles.length === 0) {
      return res.status(422).json({ error: '没有字幕可交付，请先排版', conflicts: [] });
    }
    const cueIds = new Set(p.subtitles.map((c) => c.id));
    const coverageErrors = [];
    for (const lang of request.languages) {
      const ids = request.itemsByLang.get(lang).map((it) => it.subtitle_id);
      if (ids.length !== cueIds.size) {
        coverageErrors.push(
          `语言 ${lang} 的逐行译文版本清单为 ${ids.length} 行，当前字幕为 ${cueIds.size} 行：须逐行一一对应`
        );
        continue;
      }
      const unknown = ids.filter((sid) => !cueIds.has(sid));
      if (unknown.length > 0) {
        coverageErrors.push(`语言 ${lang} 的清单含当前字幕集不存在的字幕行：${unknown.join(', ')}`);
      }
    }
    if (coverageErrors.length > 0) {
      return res.status(400).json({ error: '交付请求非法，未生成批次', errors: coverageErrors });
    }

    class DeliveryReject extends Error {
      constructor(statusCode, payload) {
        super(payload.error || '交付被拒绝');
        this.statusCode = statusCode;
        this.payload = payload;
      }
    }

    const tx = db.transaction(() => {
      // 3. 事务内读取权威当前状态
      const fresh = loadProject(db, p.id);
      const activeByLang = new Map(
        request.languages.map((lang) => [lang, activeTranslationsByLang(db, fresh.id, lang)])
      );
      // 术语在本事务内读取当前表：未配置术语的语言得到空表（不受影响）
      const glossaryByLang = new Map(
        request.languages.map((lang) => [lang, getGlossary(db, fresh.id, lang)])
      );
      const result = evaluateDelivery(fresh, request, activeByLang, glossaryByLang);

      // 4. 版本漂移（字幕集/规则）：整批拒绝，带当前值；不消耗任何版本
      if (result.sub_version_stale || result.rules_version_stale) {
        const why = [];
        if (result.sub_version_stale) {
          why.push(`字幕集版本漂移：提交基于 v${request.sub_version}，当前已是 v${fresh.sub_version}`);
        }
        if (result.rules_version_stale) {
          why.push(`规则版本漂移：提交基于 v${request.rules_version}，当前已是 v${fresh.rules.version}`);
        }
        throw new DeliveryReject(409, {
          error: `${why.join('；')}；整批未生成快照，请刷新后重新提交`,
          sub_version_stale: result.sub_version_stale,
          rules_version_stale: result.rules_version_stale,
          current: {
            sub_version: fresh.sub_version,
            rules_version: fresh.rules.version,
            rules: fresh.rules,
            subtitles: fresh.subtitles,
          },
        });
      }

      // 5. 源整版结构/规则冲突，或任一语言缺译/待复核/无效/译文版本漂移/术语缺失：整批拒绝
      const langProblems = result.languages.filter((l) => l.problem_count > 0);
      if (result.conflicts.length > 0 || langProblems.length > 0) {
        throw new DeliveryReject(422, {
          error:
            `交付核对未通过（源整版冲突 ${result.conflicts.length} 处，` +
            `${langProblems.length}/${request.languages.length} 种语言存在缺译/待复核/无效/版本漂移/术语缺失），整批未生成快照或消耗版本`,
          sub_version: fresh.sub_version,
          rules_version: fresh.rules.version,
          conflicts: result.conflicts,
          languages: result.languages.map((l) => ({
            lang: l.lang,
            problem_count: l.problem_count,
            missing: l.missing,
            review: l.review,
            invalid: l.invalid,
            version_stale: l.version_stale,
            term_missing: l.term_missing,
            glossary_version: l.glossary_version,
          })),
        });
      }

      // 6. 全部通过：同一事务内生成原文与各语言不可变 WebVTT，并写入批次与清单。
      //    快照全部使用当前源行起止（按 idx 时间升序），保证各文件时间轴一致。
      const sourceContent = toWebVtt(fresh.subtitles);
      const contents = new Map();
      for (const lang of request.languages) {
        const byCue = activeByLang.get(lang);
        const cues = fresh.subtitles.map((cue) => ({
          start_ms: cue.start_ms, end_ms: cue.end_ms, text: byCue.get(cue.id).text,
        }));
        contents.set(lang, toWebVtt(cues));
      }

      const batchInfo = db.prepare(
        `INSERT INTO delivery_batches (project_id, note, sub_version, rules_version, cue_count, lang_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(fresh.id, request.note, fresh.sub_version, fresh.rules.version,
        fresh.subtitles.length, request.languages.length);
      const batchId = batchInfo.lastInsertRowid;

      // 原文：在现有 exports 序列占一个普通版本
      const srcVersion = (db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS v FROM exports WHERE project_id = ?'
      ).get(fresh.id).v) + 1;
      const srcExportId = db.prepare(
        'INSERT INTO exports (project_id, version, content, cue_count) VALUES (?, ?, ?, ?)'
      ).run(fresh.id, srcVersion, sourceContent, fresh.subtitles.length).lastInsertRowid;
      db.prepare(
        `INSERT INTO delivery_files
           (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord)
         VALUES (?, ?, 'source', NULL, 'exports', ?, ?, ?, 0)`
      ).run(batchId, fresh.id, srcExportId, srcVersion, fresh.subtitles.length);

      // 各语言：在现有 translation_exports 序列（按语言独立）各占一个普通版本
      const insLang = db.prepare(
        'INSERT INTO translation_exports (project_id, lang, version, content, cue_count) VALUES (?, ?, ?, ?, ?)'
      );
      const insFile = db.prepare(
        `INSERT INTO delivery_files
           (batch_id, project_id, kind, lang, export_kind, export_id, version, cue_count, ord)
         VALUES (?, ?, 'translation', ?, 'translation_exports', ?, ?, ?, ?)`
      );
      request.languages.forEach((lang, i) => {
        const next = (db.prepare(
          'SELECT COALESCE(MAX(version), 0) AS v FROM translation_exports WHERE project_id = ? AND lang = ?'
        ).get(fresh.id, lang).v) + 1;
        const exportId = insLang.run(fresh.id, lang, next, contents.get(lang), fresh.subtitles.length).lastInsertRowid;
        insFile.run(batchId, fresh.id, lang, exportId, next, fresh.subtitles.length, i + 1);
      });

      return { batchId, sourceContent, contents };
    });

    try {
      const done = tx();
      const batch = loadBatch(db, p.id, done.batchId);
      // 快照正文随响应一并给出便于直接取用；权威再次下载走既有接口（内容一致且不可变）
      res.status(201).json({
        ...batch,
        files: batch.files.map((f) => ({ ...f, content: f.kind === 'source' ? done.sourceContent : done.contents.get(f.lang) })),
      });
    } catch (err) {
      if (err instanceof DeliveryReject) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  /** 交付批次清单（按时间倒序） */
  app.get('/api/projects/:id/deliveries', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json({ project_id: p.id, batches: listBatches(db, p.id) });
  });

  /**
   * 片方审阅：两批交付字幕差异对照（只读）。
   *   GET /api/projects/:id/deliveries/diff?base_id=<基准批次>&target_id=<目标批次>
   * 以两批各自冻结的 WebVTT 为准，按字幕起止时间区段比较实际显示文本；语言取两批并集，
   * 单侧出现的语言标 added/removed。快照缺失或格式损坏时指出批次和文件、整份报告失败
   * （500，snapshot_problems 全量列出，不返回部分结果）；批次不存在/不属于项目 → 404，
   * 参数非法 → 400。不受当前字幕、译文或术语修改影响。
   */
  app.get('/api/projects/:id/deliveries/diff', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    try {
      const report = buildDeliveryDiff(db, p.id, req.query.base_id, req.query.target_id);
      res.json(report);
    } catch (err) {
      if (err instanceof BatchDiffError) {
        return res.status(err.statusCode).json(err.payload);
      }
      throw err;
    }
  });

  /** 单个交付批次清单（关联文件、字幕集版本、规则版本；文件正文走既有下载接口） */
  app.get('/api/projects/:id/deliveries/:bid', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const batch = loadBatch(db, p.id, Number(req.params.bid));
    if (!batch) return res.status(404).json({ error: `交付批次 ${req.params.bid} 不存在` });
    res.json(batch);
  });

  // ---------- 逐词区间复核意见（校对页） ----------
  //
  // 意见锚定“逐词导入代次 + 词序区间”，不锚定字幕 ID 或行号：重排拆并、逐词改时、
  // 字幕行更替后仍显示在相交的当前字幕旁。创建携带当前导入代次、字幕集版本、
  // 起止词序与非空意见；区间须落在现有逐词转写内。关闭时须有相交的当前字幕，
  // 并保存其文本/时间/词区间快照；其后这些内容变化 → 自动转待复核，直到再次
  // 显式关闭；仅锁定或展示顺序变化不触发。重新导入后旧代次意见仅作历史查看，
  // 不附到新词段且不可关闭/重开。意见写入携带意见版本 version（乐观锁），
  // 创建或写入所带版本过期均返回当前值且不修改。

  class CommentReject extends Error {
    constructor(statusCode, payload) {
      super(payload.error || '复核意见操作被拒绝');
      this.statusCode = statusCode;
      this.payload = payload;
    }
  }

  /** 意见列表：状态、词段与相交的当前字幕；历史意见（旧导入代次）单独列出，只读 */
  app.get('/api/projects/:id/comments', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    res.json(buildCommentsView(db, p.id));
  });

  /**
   * 创建复核意见。
   *   { import_version, sub_version, word_start, word_end, text }
   * 201 创建成功；400 形状非法（缺字段/空意见/区间颠倒）；
   * 409 导入代次或字幕集版本过期（带当前值，不创建）；422 词区间超出当前逐词转写。
   */
  app.post('/api/projects/:id/comments', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const parsed = parseCommentBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '复核意见请求非法，未创建', errors: parsed.errors });
    }
    const it = parsed.item;
    // 创建所带版本（导入代次 / 字幕集版本）过期 → 返回当前值且不修改
    if (it.import_version !== p.import_version || it.sub_version !== p.sub_version) {
      const why = [];
      if (it.import_version !== p.import_version) {
        why.push(`逐词导入代次已推进：你基于第 ${it.import_version} 代，当前已是第 ${p.import_version} 代`);
      }
      if (it.sub_version !== p.sub_version) {
        why.push(`字幕集已被修改：你基于 v${it.sub_version} 读取，当前已是 v${p.sub_version}`);
      }
      return res.status(409).json({
        error: `${why.join('；')}，请刷新后重新提交`,
        current: {
          import_version: p.import_version,
          sub_version: p.sub_version,
          word_count: p.words.length,
          subtitles: p.subtitles,
        },
      });
    }
    // 区间须落在现有逐词转写内
    if (p.words.length === 0 || it.word_end >= p.words.length) {
      return res.status(422).json({
        error: '词区间超出当前逐词转写范围，未创建',
        errors: [p.words.length === 0
          ? '当前项目尚未导入逐词转写，无法锚定词区间'
          : `词区间 [${it.word_start}, ${it.word_end}] 超出范围（当前共 ${p.words.length} 个词，序号 0..${p.words.length - 1}）`],
        current: {
          import_version: p.import_version,
          sub_version: p.sub_version,
          word_count: p.words.length,
        },
      });
    }
    const segment = p.words
      .filter((w) => w.idx >= it.word_start && w.idx <= it.word_end)
      .map((w) => ({ idx: w.idx, text: w.text, start_ms: w.start_ms, end_ms: w.end_ms }));
    const cid = db.transaction(() => {
      return db.prepare(
        `INSERT INTO review_comments
           (project_id, import_version, word_start, word_end, text, sub_version_snapshot, words_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(p.id, p.import_version, it.word_start, it.word_end, it.text,
        p.sub_version, JSON.stringify(segment)).lastInsertRowid;
    })();
    res.status(201).json({
      comment: loadCommentView(db, p.id, cid),
      import_version: p.import_version,
      sub_version: p.sub_version,
    });
  });

  /**
   * 关闭意见：须有相交的当前字幕，并保存其文本/时间/词区间快照。
   *   { version }（意见版本，乐观锁）
   * 200 关闭成功（open/review/closed 均可显式关闭，closed 为刷新快照）；
   * 400 版本字段非法；404 意见不存在；409 意见版本过期（带当前意见，不修改）；
   * 422 历史意见（旧导入代次，不可关闭）或当前无相交字幕。
   */
  app.post('/api/projects/:id/comments/:cid/close', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const parsed = parseVersionBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '关闭请求非法，未修改', errors: parsed.errors });
    }
    const cid = Number(req.params.cid);
    const row = getComment(db, p.id, cid);
    if (!row) return res.status(404).json({ error: `复核意见 ${req.params.cid} 不存在` });
    if (row.status === 'history' || row.import_version !== p.import_version) {
      return res.status(422).json({
        error: `复核意见 ${cid} 属于第 ${row.import_version} 代逐词导入（当前第 ${p.import_version} 代），仅作历史查看，不可关闭`,
        current: { comment: loadCommentView(db, p.id, cid) },
      });
    }
    if (parsed.version !== row.version) {
      return res.status(409).json({
        error: `意见版本过期：你基于 v${parsed.version} 操作，当前已是 v${row.version}，请刷新后重试`,
        current: { comment: loadCommentView(db, p.id, cid) },
      });
    }
    // 关闭时须有相交的当前字幕
    const intersecting = intersectingSubtitles(p.subtitles, row.word_start, row.word_end);
    if (intersecting.length === 0) {
      return res.status(422).json({
        error: `词区间 [${row.word_start}, ${row.word_end}] 当前没有相交的字幕（可能尚未排版），无法关闭；请先排版生成相交字幕`,
        current: { comment: loadCommentView(db, p.id, cid), subtitles: p.subtitles },
      });
    }
    const snapshot = snapshotOf(intersecting);
    try {
      db.transaction(() => {
        const info = db.prepare(
          `UPDATE review_comments
              SET status = 'closed', version = version + 1, snapshot_json = ?,
                  closed_at = datetime('now'), closed_sub_version = ?, updated_at = datetime('now')
            WHERE id = ? AND version = ?`
        ).run(JSON.stringify(snapshot), p.sub_version, cid, parsed.version);
        if (info.changes !== 1) {
          throw new CommentReject(409, {
            error: `复核意见 ${cid} 在关闭瞬间发生变化，请刷新后重试`,
            current: { comment: loadCommentView(db, p.id, cid) },
          });
        }
      })();
    } catch (err) {
      if (err instanceof CommentReject) return res.status(err.statusCode).json(err.payload);
      throw err;
    }
    res.json({ comment: loadCommentView(db, p.id, cid), sub_version: p.sub_version });
  });

  /**
   * 重新打开意见（closed/review → open）。
   *   { version }（意见版本，乐观锁）
   * 200 重开成功；400 版本字段非法；404 意见不存在；409 意见版本过期（带当前意见）；
   * 422 历史意见（不可重开）或意见本就处于待处理。
   */
  app.post('/api/projects/:id/comments/:cid/reopen', (req, res) => {
    const p = getProject(req, res);
    if (!p) return;
    const parsed = parseVersionBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: '重新打开请求非法，未修改', errors: parsed.errors });
    }
    const cid = Number(req.params.cid);
    const row = getComment(db, p.id, cid);
    if (!row) return res.status(404).json({ error: `复核意见 ${req.params.cid} 不存在` });
    if (row.status === 'history' || row.import_version !== p.import_version) {
      return res.status(422).json({
        error: `复核意见 ${cid} 属于第 ${row.import_version} 代逐词导入（当前第 ${p.import_version} 代），仅作历史查看，不可重新打开`,
        current: { comment: loadCommentView(db, p.id, cid) },
      });
    }
    if (parsed.version !== row.version) {
      return res.status(409).json({
        error: `意见版本过期：你基于 v${parsed.version} 操作，当前已是 v${row.version}，请刷新后重试`,
        current: { comment: loadCommentView(db, p.id, cid) },
      });
    }
    if (row.status === 'open') {
      return res.status(422).json({
        error: `复核意见 ${cid} 当前已是待处理状态，无需重新打开`,
        current: { comment: loadCommentView(db, p.id, cid) },
      });
    }
    try {
      db.transaction(() => {
        const info = db.prepare(
          `UPDATE review_comments
              SET status = 'open', version = version + 1, updated_at = datetime('now')
            WHERE id = ? AND version = ?`
        ).run(cid, parsed.version);
        if (info.changes !== 1) {
          throw new CommentReject(409, {
            error: `复核意见 ${cid} 在重新打开瞬间发生变化，请刷新后重试`,
            current: { comment: loadCommentView(db, p.id, cid) },
          });
        }
      })();
    } catch (err) {
      if (err instanceof CommentReject) return res.status(err.statusCode).json(err.payload);
      throw err;
    }
    res.json({ comment: loadCommentView(db, p.id, cid), sub_version: p.sub_version });
  });

  return app;
}

module.exports = { createApp };
