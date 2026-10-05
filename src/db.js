'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  sub_version INTEGER NOT NULL DEFAULT 0,   -- 字幕集每次变更（编辑/锁定/重排）都 +1，用于乐观锁
  -- 归属版本：说话人显示名修改或归属标注写入时 +1；归属标注与署名导出携带以防并发覆盖
  attribution_version INTEGER NOT NULL DEFAULT 0,
  -- 逐词导入代次：项目创建（首次导入）为 1，每次 /import 重新导入 +1。
  -- 词、字幕与译文源快照都记录所属代次；历史译文仅当与当前行同代次（同一次逐词导入）
  -- 且词区间、源字幕文本一致时才允许恢复，重新导入前的旧译文无法确认归属、仅供查看。
  import_version INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS shots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  cut_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS rules (
  project_id      INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,  -- 每次修改 +1，提交时携带以拒绝过期写入
  max_chars       INTEGER NOT NULL,
  min_duration_ms INTEGER NOT NULL,
  max_cps         REAL NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtitles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,               -- 展示顺序（按时间升序）
  word_start INTEGER NOT NULL,               -- 覆盖的词区间 [word_start, word_end]
  word_end   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,     -- 行级乐观锁
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,               -- 项目内递增，确认一次 +1
  content    TEXT NOT NULL,                  -- WebVTT 快照，确认后不再改变
  cue_count  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, version)
);

-- 校对者批量修订提议：一组针对未锁定字幕的待采纳修订
CREATE TABLE IF NOT EXISTS revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note                   TEXT NOT NULL DEFAULT '',   -- 校对说明
  rules_version_snapshot INTEGER NOT NULL,           -- 提议保存时的规则版本
  sub_version_snapshot   INTEGER NOT NULL,           -- 提议保存时的字幕集版本
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending（待采纳）/ accepted（已采纳）
  accepted_at            TEXT,
  accepted_sub_version   INTEGER,                    -- 采纳后字幕集推进到的版本
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revision_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id   INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,               -- 组内顺序
  subtitle_id   INTEGER NOT NULL,               -- 目标字幕 ID（提交时存在且未锁定）
  cue_version   INTEGER NOT NULL,               -- 校对者读取该行时的版本号
  orig_text     TEXT NOT NULL,                  -- 原值快照
  orig_start_ms INTEGER NOT NULL,
  orig_end_ms   INTEGER NOT NULL,
  proposed_text TEXT NOT NULL,                  -- 替代文本
  start_ms      INTEGER,                        -- 可选：替代开始毫秒，NULL 表示沿用原值
  end_ms        INTEGER,                        -- 可选：替代结束毫秒，NULL 表示沿用原值
  UNIQUE(revision_id, ord)
);

-- 校对者逐词时间修正提议：按词序号提交一组起止毫秒，确认后才更新 words 并重排受影响区间
CREATE TABLE IF NOT EXISTS word_revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note                   TEXT NOT NULL DEFAULT '',    -- 校对说明
  sub_version_snapshot   INTEGER NOT NULL,            -- 校对者读取字幕集时的 sub_version
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending（待确认）/ confirmed（已确认）
  confirmed_at           TEXT,
  confirmed_sub_version  INTEGER,                     -- 确认后字幕集推进到的版本
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS word_revision_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  word_revision_id INTEGER NOT NULL REFERENCES word_revisions(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,           -- 组内顺序
  word_idx        INTEGER NOT NULL,           -- 词序号（words.idx，词序与词文本不可变）
  orig_start_ms   INTEGER NOT NULL,           -- 读取时原开始毫秒快照
  orig_end_ms     INTEGER NOT NULL,           -- 读取时原结束毫秒快照
  start_ms        INTEGER NOT NULL,           -- 修正后开始毫秒
  end_ms          INTEGER NOT NULL,           -- 修正后结束毫秒
  UNIQUE(word_revision_id, ord)
);

-- 多语言译文字幕：译文沿用源字幕的起止时间与词区间，本身不携带任何时间/切点/原文。
-- 同一语言、每条当前字幕最多一份非历史译文（由下方部分唯一索引强制）。
--   current  当前有效（源文本/时间/词区间与快照一致且满足现行规则）
--   review   待复核（保存后源字幕文本、时间或词区间发生变化；仅锁定/展示顺序变化不进入此态）
--   history  历史（源字幕行被重排删除或重新导入；subtitle_id 置空，不自动挪用到新行）
-- src_import_id 记录该译文保存时源行所属的逐词导入代次（projects.import_version）；
--   历史译文恢复时必须与当前行所属代次相同——重排删除行的历史（同一次导入）可恢复，
--   重新导入前的历史（旧代次）与无法确认导入归属（NULL，旧库迁移）的历史仅供查看。
CREATE TABLE IF NOT EXISTS translations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lang                 TEXT NOT NULL,                -- 非空目标语言代号（如 en / ja-JP）
  subtitle_id          INTEGER REFERENCES subtitles(id) ON DELETE SET NULL, -- 当前源字幕；行删除后留空作历史
  text                 TEXT NOT NULL,                -- 译文文本（不改动源字幕的任何内容）
  status               TEXT NOT NULL DEFAULT 'current',
  version              INTEGER NOT NULL DEFAULT 1,   -- 译文版本（保存修改时携带，乐观锁）
  cue_version_snapshot INTEGER NOT NULL,             -- 保存/确认时读取的源字幕行版本
  src_text             TEXT NOT NULL,                -- 保存时源字幕文本快照
  src_start_ms         INTEGER NOT NULL,             -- 保存时源字幕开始毫秒快照
  src_end_ms           INTEGER NOT NULL,             -- 保存时源字幕结束毫秒快照
  src_word_start       INTEGER NOT NULL,             -- 保存时源字幕词区间快照
  src_word_end         INTEGER NOT NULL,
  src_import_id        INTEGER,                      -- 保存时源行所属逐词导入代次（可空：无法确认归属的旧数据）
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一语言每条当前字幕最多一份译文（历史行 subtitle_id 已置空，不参与唯一约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_translations_one_per_cue
  ON translations(project_id, lang, subtitle_id)
  WHERE status != 'history';
CREATE INDEX IF NOT EXISTS idx_translations_project_lang
  ON translations(project_id, lang, status);

-- 按语言导出的不可变 WebVTT 快照（与原文导出 exports 互不影响）
CREATE TABLE IF NOT EXISTS translation_exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lang       TEXT NOT NULL,
  version    INTEGER NOT NULL,               -- 项目内按语言递增，确认一次 +1
  content    TEXT NOT NULL,                  -- WebVTT 快照，确认后不再改变
  cue_count  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, lang, version)
);

-- 多语字幕片方交付：一次交付把原文与选定语言冻结为同一时间轴的一个批次。
-- 批次只记录提交时核对通过的字幕集版本与规则版本；任一语言缺译/待复核/无效/版本漂移
-- 时整批不生成记录（事务回滚），也不消耗原文/各语言导出序列上的版本号。
CREATE TABLE IF NOT EXISTS delivery_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note           TEXT NOT NULL DEFAULT '',
  sub_version    INTEGER NOT NULL,           -- 冻结时的字幕集版本
  rules_version  INTEGER NOT NULL,           -- 冻结时的规则版本
  cue_count      INTEGER NOT NULL,
  lang_count     INTEGER NOT NULL,           -- 参与交付的目标语言数
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 批次内文件清单：1 个原文文件 + 每种语言 1 个译文文件，全部共用同一时间轴。
-- 每个文件同时在既有导出序列（exports / translation_exports）中占一个普通版本，
-- 经既有下载接口取得；后续编辑不改旧批次（快照不可变）。
CREATE TABLE IF NOT EXISTS delivery_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    INTEGER NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- source（原文）/ translation（译文）
  lang        TEXT,                          -- kind=translation 时为语言代号；原文为 NULL
  export_kind TEXT NOT NULL,                 -- exports / translation_exports（序列名）
  export_id   INTEGER NOT NULL,              -- 对应导出表行 ID
  version     INTEGER NOT NULL,              -- 该导出序列上的版本号
  cue_count   INTEGER NOT NULL,
  ord         INTEGER NOT NULL,              -- 批次内顺序：0 为原文，其后按语言顺序
  UNIQUE(batch_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_delivery_batches_project
  ON delivery_batches(project_id, id);
CREATE INDEX IF NOT EXISTS idx_delivery_files_project
  ON delivery_files(project_id, batch_id);

-- 译者整批译文回填：译者完成整批译文后，按一种目标语言一次回填到当前字幕。
-- 批次编号（batch_no）由译者给出，同项目同语言唯一：编号重复且内容相同 → 幂等返回
-- 首次结果；编号相同内容不同 → 冲突拒绝。仅核对通过并成功写入的批次占编号，
-- 失败批次不留任何记录（不占编号）。
CREATE TABLE IF NOT EXISTS translation_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_no       TEXT NOT NULL,               -- 译者批次编号（同项目同语言唯一）
  lang           TEXT NOT NULL,               -- 目标语言代号（一次回填一种语言）
  note           TEXT NOT NULL DEFAULT '',    -- 可选说明
  sub_version    INTEGER NOT NULL,            -- 提交时读取的字幕集版本
  rules_version  INTEGER NOT NULL,            -- 提交时读取的规则版本
  item_count     INTEGER NOT NULL,
  created_count  INTEGER NOT NULL,            -- 新建译文行数
  updated_count  INTEGER NOT NULL,            -- 覆盖（含待复核）译文行数
  content_hash   TEXT NOT NULL,               -- 归一化内容指纹（编号重复时判重/冲突）
  result_json    TEXT NOT NULL,               -- 首次结果快照（编号重复且内容相同时原样返回）
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, lang, batch_no)
);

-- 回填批次逐行清单：字幕 ID、提交的源行版本、源行版本、提交的译文版本（0=新建）与译文文本，
-- 以及写入结果（created/updated 与写入后的译文版本）。
CREATE TABLE IF NOT EXISTS translation_batch_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL REFERENCES translation_batches(id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,            -- 提交清单内顺序
  subtitle_id    INTEGER NOT NULL,
  cue_version    INTEGER NOT NULL,            -- 提交时源字幕行版本
  version        INTEGER NOT NULL,            -- 提交时译文版本（0 表示新建）
  text           TEXT NOT NULL,               -- 回填译文文本
  action         TEXT NOT NULL,               -- created（新建，结果版本 1）/ updated（覆盖，版本 +1）
  result_version INTEGER NOT NULL,            -- 写入后的译文版本
  UNIQUE(batch_id, ord)
);

-- 说话人名册：项目内维护“说话人编号（number）→ 显示名（display_name）”。
-- 编号由服务端按项目顺序分配（不回收），显示名可修改（修改推进归属版本 attribution_version）；
-- 编号一经建立不删除（历史归属仍可解析）。显示名不得含换行或 WebVTT 标签界定符（< >），
-- 以保证署名版 WebVTT 的说话人标签语法合法。
CREATE TABLE IF NOT EXISTS speakers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,              -- 项目内说话人编号（1 起，不回收）
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, number)
);

-- 字幕行归属（按字幕 ID 锚定，与展示序号无关）：
--   锁定行也可标注；重排中保留 ID 的行（无论是否仅顺序变化）归属继续有效；
--   原行被删除（重排/重新导入）后归属留作历史（status=history），新行待标注，绝不按序号转移。
-- 每条当前字幕最多一条有效归属（由下方部分唯一索引强制）。
-- cue_version 记录标注时读取的行版本（乐观锁：过期 → 409 返回当前值）；
-- speaker_number 为标注时说话人编号快照（编号不删除、不可变，仅显示名可改）。
CREATE TABLE IF NOT EXISTS attributions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subtitle_id    INTEGER REFERENCES subtitles(id) ON DELETE SET NULL, -- 行删除后留空作历史
  speaker_id     INTEGER NOT NULL REFERENCES speakers(id),
  speaker_number INTEGER NOT NULL,             -- 标注时编号快照
  cue_version    INTEGER NOT NULL,             -- 提交时读取的字幕行版本
  status         TEXT NOT NULL DEFAULT 'active', -- active（有效）/ history（原行删除，留档）
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attributions_one_per_cue
  ON attributions(project_id, subtitle_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_attributions_project
  ON attributions(project_id, status, subtitle_id);

-- 署名版导出的不可变 WebVTT 快照（与普通 exports / translation_exports 相互独立）：
-- 普通导出与旧下载内容保持兼容（不含说话人标签）；署名版另存此序列，可查询、可下载，
-- 内容一经生成不再改变（说话人改名、归属变更、字幕修订均不影响旧快照）。
CREATE TABLE IF NOT EXISTS attributed_exports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,            -- source（原文）/ translation（译文）
  lang              TEXT,                     -- kind=translation 时为语言代号；原文为 NULL
  version           INTEGER NOT NULL,         -- 项目内该序列递增（不分语言）
  content           TEXT NOT NULL,            -- 含说话人标签的 WebVTT 快照，创建后不变
  cue_count         INTEGER NOT NULL,
  sub_version       INTEGER NOT NULL,         -- 快照时字幕集版本
  attribution_version INTEGER NOT NULL,       -- 快照时归属版本
  rules_version     INTEGER NOT NULL,         -- 快照时规则版本
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, version)
);

-- 译审术语对照表：按 项目 + 目标语言 各维护一张“源词 → 规定译法”表。
-- 整表修改（整体替换词条）并携带术语版本 version（乐观锁）；同语言源词唯一，
-- 词与译法均为非空文本。未配置术语的语言（无 glossaries 行或词条为空）不做术语核对；
-- 术语变更不触碰既有译文（current/review 状态均不改变），只在查询/导出时按当前表动态核对。
CREATE TABLE IF NOT EXISTS glossaries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lang       TEXT NOT NULL,                -- 目标语言代号（与译文语言代号同规则）
  version    INTEGER NOT NULL DEFAULT 1,  -- 每次整表修改 +1；提交携带以拒绝过期写入
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, lang)
);

CREATE TABLE IF NOT EXISTS glossary_terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  glossary_id INTEGER NOT NULL REFERENCES glossaries(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,           -- 提交顺序
  source      TEXT NOT NULL,              -- 源词（非空；同一语言术语表内唯一）
  target      TEXT NOT NULL,              -- 规定译法（非空；命中源词的译文须包含此文本）
  UNIQUE(glossary_id, ord)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_terms_source
  ON glossary_terms(glossary_id, source);

-- 逐词区间复核意见（校对页）：锚定“逐词导入代次 + 词序区间”，不锚定字幕 ID 或行号。
-- 重排拆并、逐词改时、字幕行更替后，意见仍按词区间显示在相交的当前字幕旁。
--   open    待处理（创建后尚未关闭）
--   closed  已关闭（关闭时保存相交当前字幕的文本/时间/词区间快照 snapshot_json）
--   review  待复核（已关闭但相交字幕的文本/时间/词区间随后变化；仅锁定或展示顺序
--           变化不触发；只能由校对者再次显式关闭回到 closed）
--   history 历史（重新导入后旧代次意见仅作历史查看：不附到新词段、不可关闭/重开）
-- 意见版本 version 为行级乐观锁：关闭/重新打开必须携带读取时的版本。
CREATE TABLE IF NOT EXISTS review_comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_version INTEGER NOT NULL,           -- 创建时锚定的逐词导入代次
  word_start     INTEGER NOT NULL,           -- 意见词区间 [word_start, word_end]（词序号）
  word_end       INTEGER NOT NULL,
  text           TEXT NOT NULL,              -- 非空复核意见
  status         TEXT NOT NULL DEFAULT 'open', -- open / closed / review / history
  version        INTEGER NOT NULL DEFAULT 1, -- 意见版本（关闭/重新打开携带，乐观锁）
  sub_version_snapshot INTEGER NOT NULL,     -- 创建时读取的字幕集版本
  words_json     TEXT NOT NULL,              -- 创建时词段快照（重新导入后供历史查看）
  snapshot_json  TEXT,                       -- 关闭时相交字幕快照（词区间/文本/起止，按词序）
  closed_at      TEXT,
  closed_sub_version INTEGER,                -- 最近一次关闭时的字幕集版本
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_review_comments_project
  ON review_comments(project_id, status);

-- 片方返修意见：锚定“交付批次 + 冻结文件（原文/指定语言）+ 起止毫秒区间”。
-- 区间须落在冻结文件时间轴内；创建时记录命中的冻结文本与时间（hits_json）及文件版本。
-- 对同项目后续目标批次核对时只比较两份冻结文件（绝不读取当前编辑稿或词序）：
--   目标批次未交付所选语言 → 无法核对；区间内文本与覆盖范围均未变 → 未改动；
--   其余 → 待人工确认（系统不自动判定已修复）。
-- 意见版本 version 为行级乐观锁：判定（结论）写入必须携带读取时的版本，过期返回当前状态。
CREATE TABLE IF NOT EXISTS rework_comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id       INTEGER NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,              -- source（原文文件）/ translation（指定语言译文文件）
  lang           TEXT,                       -- kind=translation 时为语言代号；原文为 NULL
  start_ms       INTEGER NOT NULL,           -- 返修区间 [start_ms, end_ms)（冻结文件时间轴内）
  end_ms         INTEGER NOT NULL,
  text           TEXT NOT NULL,              -- 非空返修意见
  version        INTEGER NOT NULL DEFAULT 1, -- 意见版本（判定携带，乐观锁）
  file_version   INTEGER NOT NULL,           -- 创建时冻结文件在其导出序列上的版本
  hits_json      TEXT NOT NULL,              -- 创建时命中的冻结文本与时间 [{start_ms,end_ms,text}]
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rework_comments_batch
  ON rework_comments(batch_id, id);
CREATE INDEX IF NOT EXISTS idx_rework_comments_project
  ON rework_comments(project_id, id);

-- 返修判定结论：片方对“待人工确认”项显式判为 已解决(resolved) / 仍待修(still_pending)。
-- 结论绑定目标批次（每意见每目标批次至多一条）；换批核对时旧批次结论仅作历史。
CREATE TABLE IF NOT EXISTS rework_verdicts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id      INTEGER NOT NULL REFERENCES rework_comments(id) ON DELETE CASCADE,
  target_batch_id INTEGER NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE,
  verdict         TEXT NOT NULL,             -- resolved（已解决）/ still_pending（仍待修）
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(comment_id, target_batch_id)
);
`;

const DEFAULT_RULES = { max_chars: 30, min_duration_ms: 800, max_cps: 20 };

function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * 轻量迁移：CREATE TABLE IF NOT EXISTS 只负责新表；旧库已存在的表需要手动加列。
 *   - projects.attribution_version（说话人功能引入）
 *   - projects.import_version（历史译文恢复引入：逐词导入代次，旧库当前词集视为第 1 代）
 *   - translations.src_import_id（保存时源行所属导入代次；旧译文留 NULL 表示无法确认
 *     导入归属——仍在并列视图与历史中可见，但不能通过恢复接口写回）
 */
function migrate(db) {
  const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (!projectCols.includes('attribution_version')) {
    db.exec('ALTER TABLE projects ADD COLUMN attribution_version INTEGER NOT NULL DEFAULT 0');
  }
  if (!projectCols.includes('import_version')) {
    db.exec('ALTER TABLE projects ADD COLUMN import_version INTEGER NOT NULL DEFAULT 1');
  }
  const trCols = db.prepare('PRAGMA table_info(translations)').all().map((c) => c.name);
  if (!trCols.includes('src_import_id')) {
    db.exec('ALTER TABLE translations ADD COLUMN src_import_id INTEGER');
  }
}

/** 项目完整载荷：项目 + 词 + 切点 + 规则 + 字幕 + 导出版本列表 */
function loadProject(db, id) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return null;
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? ORDER BY idx'
  ).all(id);
  const cuts = db.prepare(
    'SELECT cut_ms FROM shots WHERE project_id = ? ORDER BY idx'
  ).all(id).map((r) => r.cut_ms);
  const rules = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(id);
  const subtitles = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(id);
  const speakers = db.prepare(
    'SELECT id, number, display_name, created_at, updated_at FROM speakers WHERE project_id = ? ORDER BY number'
  ).all(id);
  // 当前归属（每条当前字幕最多一条 active；按字幕 ID 锚定，与展示序号无关）
  const attributions = db.prepare(
    `SELECT a.id, a.subtitle_id, a.speaker_id, a.speaker_number, a.cue_version,
            a.created_at, a.updated_at, sp.display_name AS speaker_name
       FROM attributions a JOIN speakers sp ON sp.id = a.speaker_id
      WHERE a.project_id = ? AND a.status = 'active'
      ORDER BY a.subtitle_id`
  ).all(id);
  const exportsList = db.prepare(
    'SELECT version, cue_count, created_at FROM exports WHERE project_id = ? ORDER BY version DESC'
  ).all(id);
  const revisions = listRevisions(db, id);
  const wordRevisions = listWordRevisions(db, id);
  return {
    id: project.id,
    name: project.name,
    sub_version: project.sub_version,
    attribution_version: project.attribution_version,
    import_version: project.import_version,
    created_at: project.created_at,
    words,
    cuts,
    rules: rules
      ? { version: rules.version, max_chars: rules.max_chars,
          min_duration_ms: rules.min_duration_ms, max_cps: rules.max_cps }
      : null,
    subtitles,
    speakers,
    attributions,
    exports: exportsList,
    revisions,
    word_revisions: wordRevisions,
  };
}

/** 项目下全部修订提议摘要（不含逐项明细），按时间倒序 */
function listRevisions(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.note, r.status, r.rules_version_snapshot, r.sub_version_snapshot,
            r.accepted_sub_version, r.created_at, r.accepted_at,
            (SELECT COUNT(*) FROM revision_items i WHERE i.revision_id = r.id) AS item_count
     FROM revisions r WHERE r.project_id = ? ORDER BY r.id DESC`
  ).all(projectId);
}

/**
 * 读取一个修订提议（含逐项明细）。不存在或不属于该项目返回 null。
 * 每项同时给出 orig_*（提交时原值）、proposed_*（建议值，start_ms/end_ms 为 null 表示沿用原值）。
 */
function loadRevision(db, projectId, revisionId) {
  const head = db.prepare('SELECT * FROM revisions WHERE id = ? AND project_id = ?')
    .get(revisionId, projectId);
  if (!head) return null;
  const items = db.prepare(
    'SELECT * FROM revision_items WHERE revision_id = ? ORDER BY ord'
  ).all(revisionId);
  return {
    id: head.id,
    project_id: head.project_id,
    note: head.note,
    status: head.status,
    rules_version_snapshot: head.rules_version_snapshot,
    sub_version_snapshot: head.sub_version_snapshot,
    accepted_sub_version: head.accepted_sub_version,
    created_at: head.created_at,
    accepted_at: head.accepted_at,
    items: items.map((it) => ({
      ord: it.ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      orig: { text: it.orig_text, start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
      proposed: {
        text: it.proposed_text,
        start_ms: it.start_ms,
        end_ms: it.end_ms,
        has_start_ms: it.start_ms !== null,
        has_end_ms: it.end_ms !== null,
      },
    })),
  };
}

function bumpSubVersion(db, projectId) {
  db.prepare('UPDATE projects SET sub_version = sub_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId).sub_version;
}

/** 归属版本 +1（说话人改名或归属标注写入成功时调用），返回推进后的版本 */
function bumpAttributionVersion(db, projectId) {
  db.prepare('UPDATE projects SET attribution_version = attribution_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT attribution_version FROM projects WHERE id = ?').get(projectId).attribution_version;
}

/** 逐词导入代次 +1（重新导入转写时调用），返回推进后的代次 */
function bumpImportVersion(db, projectId) {
  db.prepare('UPDATE projects SET import_version = import_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT import_version FROM projects WHERE id = ?').get(projectId).import_version;
}

/** 项目下全部逐词修正提议摘要（不含逐项明细），按时间倒序 */
function listWordRevisions(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.note, r.status, r.sub_version_snapshot,
            r.confirmed_sub_version, r.created_at, r.confirmed_at,
            (SELECT COUNT(*) FROM word_revision_items i WHERE i.word_revision_id = r.id) AS item_count
     FROM word_revisions r WHERE r.project_id = ? ORDER BY r.id DESC`
  ).all(projectId);
}

/**
 * 读取一个逐词修正提议（含逐项明细，并附带各词当前文本/时间，便于预览并列原值/当前值）。
 * 不存在或不属于该项目返回 null。
 */
function loadWordRevision(db, projectId, revisionId) {
  const head = db.prepare('SELECT * FROM word_revisions WHERE id = ? AND project_id = ?')
    .get(revisionId, projectId);
  if (!head) return null;
  const items = db.prepare(
    `SELECT i.ord, i.word_idx, i.orig_start_ms, i.orig_end_ms, i.start_ms, i.end_ms,
            w.text AS word_text, w.start_ms AS cur_start_ms, w.end_ms AS cur_end_ms
       FROM word_revision_items i
       LEFT JOIN words w ON w.project_id = ? AND w.idx = i.word_idx
      WHERE i.word_revision_id = ? ORDER BY i.ord`
  ).all(projectId, revisionId);
  return {
    id: head.id,
    project_id: head.project_id,
    note: head.note,
    status: head.status,
    sub_version_snapshot: head.sub_version_snapshot,
    confirmed_sub_version: head.confirmed_sub_version,
    created_at: head.created_at,
    confirmed_at: head.confirmed_at,
    items: items.map((it) => ({
      ord: it.ord,
      word_idx: it.word_idx,
      word_text: it.word_text ?? null,        // 重新导入后可能已不存在
      orig: { start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
      proposed: { start_ms: it.start_ms, end_ms: it.end_ms },
      current: it.word_text === null
        ? null
        : { text: it.word_text, start_ms: it.cur_start_ms, end_ms: it.cur_end_ms },
    })),
  };
}

module.exports = {
  initDb, loadProject, listRevisions, loadRevision,
  listWordRevisions, loadWordRevision, bumpSubVersion, bumpAttributionVersion,
  bumpImportVersion,
  DEFAULT_RULES,
};
