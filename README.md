# 字幕校时工作台（Subtitle Timing Workbench）

把**逐词转写**（带起止毫秒）与**镜头切点**排版成符合规则的字幕，在浏览器里校对、锁定、确认后导出 **WebVTT**。本地运行：Node.js + Express + SQLite（better-sqlite3）+ 原生前端，无外部服务依赖。

## 功能

- **导入**：逐词转写 `words: [{text, start_ms, end_ms}]` + 镜头切点 `cuts: [ms]`。
  时间无效（开始 ≥ 结束、负值、非整数）或**倒序/重叠**的词段一律**拒绝导入**并逐条说明。
- **排版规则**：单条最大字数、最短显示时长（ms）、每秒最多字数，可随时修改。
- **排版保证**：按原词序覆盖全部词（每词恰好一次）、字幕互不重叠、不跨镜头切点、不缩短任何词本身的时段（只在空闲间隙内向后/向前扩展）。
- **冲突报告**：规则无法同时满足时，列出**受影响词段 + 冲突条件**（如"切点落在词内部"、"可用空间 450ms 小于最短时长 1000ms"），**不输出貌似完整的结果**，也不改动现有字幕。
- **锁定**：已校对的字幕可锁定 🔒，重新排版只改未锁定部分，锁定条原样保留。
- **逐词时间修正**：校对者发现逐词转写的时间偏差时，可按**词序号**提交一组起止毫秒修正，携带读取时字幕集 `sub_version`；提交只存原值快照（不动词与字幕），预览并列**受影响字幕、逐词原值/当前值/建议值与候选整版**，确认在同一事务内再次核对并**原子**更新词时间、对受影响的未锁定区间重排、推进字幕集版本。词序与词文本永不变更；序号不重复、时间为非负整数且起点早于终点，修正后全部词仍按序不重叠。锁定字幕文本与时间原样保留；未受影响字幕保留 ID、行版本与人工文本，受影响行换用新 ID；满足词完整覆盖、切点隔离与现行字数/时长/字速规则。无法兼顾锁定或排版约束时返回定位到**词/字幕**的原因（词与字幕均不变），版本过期返回当前值；已确认提议重复提交不再生效，既有导出快照保持不变。
- **批量修订提议**：校对者可对**同一项目的一组未锁定字幕**提交待采纳修订（逐项给出字幕 ID、读取时行版本、替代文本、可选起止毫秒、附说明）；**提交只保存原值与当时规则版本，不动正式字幕**。预览并列原值/当前值/建议值，按当前规则核对整组候选（词区间、词时段、切点、相邻字幕、字数/时长/字速），逐处指出冲突；采纳时在**同一事务**内再次核对目标仍存在且未锁定、行版本与规则版本，通过后整版校验并原子写入全部修订、推进字幕集版本——**任一过期或违规则整组不生效**并返回当前值与原因；已采纳提议重复提交不再改字幕，提议历史可查。
- **乐观锁**：规则与每条字幕都带版本号，过期提交返回 `409` 与当前内容；字幕集整体有 `sub_version`，重排/导出携带以防并发覆盖。
- **导出**：确认后生成按时间升序的 WebVTT，存为**不可变版本快照**，可随时再次下载；后续修改不影响旧文件。导出前会完整校验（含锁定字幕），违规则拒绝并列出问题。
- **多语言译文字幕**：按原时间轴维护多语言译文。校对者以**非空目标语言代号、字幕 ID、读取时行版本 `cue_version` 与译文版本 `version`**（新建传 0/省略）保存译文；查询逐行并列原文、译文与状态（`current`/`review`/`missing`）。同一语言每条当前字幕最多一份译文。译文**沿用源字幕起止与词区间**，接口不接受任何时间/切点/原文字段，且须满足当前**最大字数与字速**规则（时长随源行）。源字幕**文本/时间/词区间**变化 → 译文自动转**待复核**；仅锁定或展示顺序变化不使译文失效；重排删除的原行译文**留作历史**，新行视为缺译，**不按序号自动挪用**。校对者可在当前源行上确认待复核译文，过期版本或无效译文返回当前值与原因且不改数据。按语言导出前须确认当前每行均有有效译文且整版符合时间与切点约束，否则分类列出缺漏/待复核/无效/冲突且**不生成快照**；成功导出的译文 WebVTT 快照**不可变**，与原文导出相互独立。
- **片方多语字幕交付（批次冻结）**：一次提交把**原文与选定的多种语言冻结为同一时间轴的一个批次**。请求携带当前字幕集版本 `sub_version`、规则版本 `rules_version`、**非空且不重复**的目标语言列表，以及各语言**逐行译文版本**清单。服务端在**同一个事务内**核对：提交版本仍有效（字幕集/规则漂移 → `409`）、源字幕整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则通过、每种语言每行译文均为 `current` 且满足字数/字速、译文版本与提交一致；任一语言**缺译/待复核/无效/版本漂移**都按语言和字幕行返回原因，**整批不生成快照、不消耗版本**。成功时在现有**原文导出序列与各语言导出序列**中各生成一个不可变 WebVTT 版本（因此文件直接经现有下载接口取得），并以**批次清单**关联文件、字幕集版本与规则版本；各文件时间轴完全一致，后续编辑不改变旧批次。既有原文导出、单语言导出及下载约定保持兼容。
- **译者整批译文回填（本轮新增）**：译者完成整批译文后，可按**一种目标语言**把整批译文回填到当前字幕。提交**批次编号** `batch_no`、读取时字幕集版本 `sub_version`、规则版本 `rules_version` 与**非空逐行清单**（字幕 ID、源行版本 `cue_version`、译文版本 `version`（新建 `0`/省略）、非空文本）。按字幕 ID 对齐，允许覆盖**待复核**译文；**同批重复 ID、无效语言、不存在的字幕**一律拒绝。提交时在事务内重新核对版本、源行及当前**字数/字速**规则：任一行过期（字幕集/规则/源行/译文版本）或违规，**按行返回当前值与原因，整批不写入**。通过后在**同一事务**保存全部译文——新建版本从 `1` 开始，更新版本递增并把源快照刷新为 `current`；**未列出的行与其他语言不变**，且回填只写译文、不推进 `sub_version`。**同项目同语言批次编号重复且内容相同**（内容指纹对清单按字幕 ID 排序，提交顺序不影响判定）→ 返回首次结果（`200 replayed`）而不再次写入；**编号相同但内容不同** → `409` 冲突；**失败批次不占编号**。回填结果就是普通译文，逐行译文操作、单语言导出与多语交付继续读取，**旧导出快照保持不变**。
- **说话人标注与署名版导出（本轮新增）**：项目内维护**说话人编号（服务端分配、不回收、不可变）→ 显示名**，显示名可修改，**改名推进归属版本** `attribution_version`（归属标注写入同样推进）。归属**按字幕 ID 锚定**：提交按字幕 ID 携带读取时**行版本** `cue_version` 与**归属版本**，`speaker_number` 必须存在；过期返回当前值，**锁定行也可标注**（单行或整批，整批任一过期/编号缺失则整批不写入）。**重排保留 ID 的行归属继续有效**（仅顺序变化或原地更新都不失效）；**原行删除后归属留作历史，新行待标注，绝不按展示序号转移**。署名版导出携带**字幕集版本与归属版本**，在**同一事务**内核对每条当前字幕均有有效归属（说话人仍在名册、显示名可安全写入标签）；可选择**原文**或**一种目标语言**，选择译文时携带**逐行译文版本**清单，译文须逐行 `current`、版本未变且满足现行字数/字速，否则**按行列原因且不生成快照**。署名版正文按 WebVTT 语法写**说话人标签** `<v 显示名>文本</v>`，并**拒绝含换行或标签界定符（`<`、`>`）的显示名**；**原文与译文共用同一时间轴**。**普通导出及旧下载内容保持兼容（不含标签）**，署名版**另存**为可查询、可下载的**不可变快照**（改名、改归属、改字幕都不影响旧快照）。
- **译审术语对照表（本轮新增）**：译审按**目标语言**维护「源词 → 规定译法」对照表，**整表修改**（整体替换词条）并携带读取时**术语版本**（未配置传 `0`），过期返回 `409` 与当前表；词与译法均为**非空文本**（无首尾空白、≤100 字），**同一语言源词不得重复**，允许提交空数组清空该语言术语。按**当前原文字幕文本精确匹配**源词（字面子串）：每条命中源词的译文都**必须包含对应规定译法**，**一行命中多词时每个规定译法都须满足**；**未配置术语的语言完全不受影响**。另有只读缺失查询，按**语言、字幕 ID 与源词**逐条列出缺失译法并附当前术语版本（无译文行也列出）。**译文即使缺失规定译法仍可保存供修正**（保存响应与并列视图附 `term_issues`），**术语变更不改变既有译文的 current/review 状态**。**单语言译文导出、多语言同版交付与译文署名版导出**在**原有事务内读取当前术语**并核对：任一缺失逐行（多语交付按语言+行，署名导出行内带 `translation_term_missing`）报错且**不生成快照、不消耗版本**；**原文导出、现有译文读写约定与旧导出快照保持兼容**（术语收紧后旧快照仍可下载且内容不变）。
- **重排后历史译文找回（本轮新增）**：重排删除源行后，译文按既有约定留作**历史**（绝不按序号自动挪用）。校对者可先按语言查询当前**缺译行**的历史候选及**匹配依据**（只读）：只有与当前行属于**同一次逐词导入**（导入代次 `import_version` 一致）且**词区间**与**源字幕文本**均一致的候选**可恢复**；**重新导入前的旧代次历史**、**无法确认导入归属的旧库历史**（`src_import_id` 为空）同样列出但只能查看、不能恢复。恢复请求携带读取时**字幕集版本** `sub_version`、**规则版本** `rules_version`、**目标行**及**候选译文 ID + 版本**，可一次选择多行；服务端在**同一事务内**重新核对目标仍缺译、候选三要素仍匹配以及候选文本满足**现行字数/字速**规则，任一失效都**按行说明原因且整组不写**。成功后为每行写成一条**普通 current 译文**（新版本从 1 开始），**原历史记录保留不改**、**不推进 `sub_version`**、**旧导出快照不变**；术语缺失仍按现有译文视图 `term_issues` 提示并继续阻止导出；恢复出的译文可继续使用逐行保存/确认、整批回填、单语言导出与多语交付等既有操作。
- **两批交付差异对照（本轮新增，只读）**：片方审阅同一项目两次交付的实际字幕差异时，输入**基准批次**与**目标批次** ID（`GET …/deliveries/diff?base_id=&target_id=`），返回**原文及两批语言并集**的对照。只在一侧出现的语言标**新增（added）/移除（removed）**；双方都有的文件以各自**冻结的 WebVTT** 为准，按字幕**起止时间构成的区段**比较**实际显示文本**，列出差异区段的**起止毫秒、两侧文本与对应文件版本**：**拆分、合并或整体移时按时间区段自然对齐，绝不按行号配对**；时间空档记 `null`、空白字幕记 `""`，**空白与字幕的转换不漏报**；相邻差异区段在两侧各自文本跨边界均未变时**合并**。文件快照完好时，**同批比较返回空差异**。批次**不存在或不属于该项目时明确拒绝**；任一文件**快照缺失或格式损坏**（签名/时间戳/时间轴/cue 数不符）时指出**批次和文件**，**整份报告失败、不返回部分结果**。查询**只读**，不受当前字幕、译文或术语修改影响，原有交付与下载约定保持兼容。
- **逐词区间复核意见（本轮新增）**：校对页管理锚定**逐词区间**的复核意见。校对者以**当前导入代次 `import_version`、字幕集版本 `sub_version`、起止词序与非空意见**创建记录，区间须落在现有逐词转写内；列表逐条返回**意见状态、词段与相交的当前字幕**。意见锚定**导入代次 + 词序**：重排拆并、逐词改时及字幕行更替后仍显示在相交字幕旁，**不按字幕 ID 或行号迁移**。**关闭**时须有相交的当前字幕，并保存其**文本、时间与词区间快照**；其后这些内容变化则自动转**待复核**，直到再次显式关闭；**锁定或仅展示顺序变化不触发**。**重新导入**后旧意见仅作**历史**查看，不附到新词段且不可关闭/重开。意见写入携带**意见版本**，创建或写入所带版本过期均返回当前值且不修改。页面支持查看、创建、关闭与重新打开。

## 启动

### Docker（推荐，一条命令）

```bash
docker compose up --build
```

Dockerfile 负责安装依赖，启动时自动建表（`src/db.js`），数据库为空且 `SEED_DEMO=true` 时播种一个演示项目（含自动排版结果）。

### 本地开发

```bash
npm ci
npm start          # 或 PORT=8080 DB_PATH=./my.db node server.js
```

### 访问

打开 **http://localhost:3000**（本地 `npm start` 同理；`PORT` 环境变量可改端口）。

### 测试

```bash
npm test           # node:test，覆盖排版引擎与全部 API
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `./data/subtitles.db`（容器内 `/data/subtitles.db`） | SQLite 文件路径，启动时自动初始化表结构 |
| `SEED_DEMO` | `true` | 数据库为空时播种"演示项目：江边茶馆"；设 `false` 关闭 |

Compose 默认把 SQLite 挂到命名卷 `subtitle-data` 持久化（含所有导出版本快照）。

## 使用流程

1. **导入**：粘贴 JSON（或点"载入示例"），填项目名则新建项目，留空则导入当前项目（已有字幕时需勾选确认覆盖）。`examples/sample.json` 是同款示例。
2. **设规则**：最大字数 / 最短时长 / 每秒字数 → 保存（版本号 +1）。
3. **排版**：点"重新排版（仅未锁定字幕）"。有冲突时红色面板逐条列出词段与原因，修正数据或放宽规则后重试。
4. **校对**：直接在列表里改文本/时间（保存时校验：不得缩短词时段、不得重叠、不得跨切点），校对好的点"锁定"。
5. **逐词时间修正（校对者流程）**：在左侧 ⑥ 面板按 JSON 提交一组词时间修正（或"填入所有词"后只保留要改的词），必须携带读取时的 `sub_version`；提交后自动打开预览，查看**受影响字幕**（将重排的未锁定行 / 含修正词的锁定行）、逐词原值/当前值/建议值与候选整版，全部通过时点"确认修正"（原子更新词时间+重排+推进版本；失败整组不变）。也可用 `examples/word-revisions-api.sh` 走纯 HTTP 流程。
6. **批量修订提议（校对者流程）**：在左侧 ⑤ 面板按 JSON 提交一组字幕修订（或"填入所有行"后删改；只针对未锁定字幕），提交后自动打开预览，逐项并列**原值 / 当前值 / 建议值**并标注每处冲突；全部通过时点"整组采纳"（原子写入，失败整组不生效）。也可用 `examples/revisions-api.sh` 走纯 HTTP 流程。
7. **导出**：点"确认当前字幕并导出 WebVTT"，生成 v1、v2…… 任意版本可随时重新下载。词修正确认与字幕修订采纳均不影响已生成的旧快照。
8. **多语言译文（本轮新增）**：在左侧 ⑦ 面板填入语言代号（如 `en`）并"载入语言"，逐行对照原文保存译文；源行变更后状态变"待复核"，可"✓ 确认仍适用"或重新保存；全部有效后点"校验并导出该语言 WebVTT"，缺漏/冲突会分类列出且不生成快照。HTTP 流程见 `examples/translations-api.sh`。
9. **片方交付批次**：各语言译文都 current 且有效后，按 `POST /api/projects/:id/deliveries` 提交 `{sub_version, rules_version, languages, translations:{lang:[{subtitle_id, version}]}}`，服务端事务内整版核对，通过即把原文与各语言冻结为同一时间轴的一个批次（各序列生成不可变 WebVTT，文件走既有下载接口）；失败按语言和字幕行返回原因且不生成快照、不耗版本。清单用 `GET /api/projects/:id/deliveries` 查询。HTTP 流程见 `examples/deliveries-api.sh`。
10. **译者整批译文回填（本轮新增）**：整批译文完成后，按 `POST /api/projects/:id/translations/:lang/batches` 一次提交一种语言，携带 `batch_no`、`sub_version`、`rules_version` 与逐行 `items:[{subtitle_id, cue_version, version, text}]`（新建 `version=0`）；同批重复 ID/无效语言/不存在字幕 → `400`，版本过期 → `409`，超字数/字速 → `422`，均按行返回当前值与原因且整批不写入；成功后新建从 v1、更新版本 +1（可覆盖待复核）。同编号同内容重放返回首次结果（`200 replayed`），同编号不同内容 `409` 冲突，失败不占编号。回填结果直接被并列查询、单语言导出与多语交付读取。HTTP 流程见 `examples/translation-batches-api.sh`。
11. **说话人标注与署名版导出（本轮新增）**：在左侧 ⑧ 面板「新建说话人」建立编号→显示名，「载入归属」后逐行选择说话人并保存（锁定行也可标注）；改显示名用「改名」（推进归属版本）。点「署名版导出（原文）」或「署名版导出（当前译文语言）」生成带 `<v 名称>` 标签的不可变 WebVTT；逐行缺归属/译文问题会在提示中按行列出且不生成快照。也可走 HTTP（见下节与 `examples/speakers-api.sh`）。
12. **译审术语对照表（本轮新增）**：通过 HTTP 维护（见「译审术语对照表」一节与 `examples/glossaries-api.sh`）：`PUT …/glossaries/:lang` 整表提交 `{version, terms:[{source,target}]}`（未配置传 `version:0`）；保存译文或并列查询会显示每行 `term_issues`，`GET …/glossaries/:lang/missing` 按语言/字幕 ID/源词列出缺失；单语言导出、多语交付与译文署名导出在原事务内按当前术语核对，缺失逐行报错且不生成快照；术语变更不改译文状态、不影响旧快照。
13. **重排后历史译文找回（本轮新增）**：重排后出现缺译行时，`GET …/translations/:lang/recovery-candidates` 查看每行历史候选与匹配依据；只有**同一次逐词导入**（`import_version` 一致）且**词区间、源字幕文本均一致**的候选可恢复（重新导入留下的旧代次历史、归属未知的旧历史仅供查看）。`POST …/translations/:lang/recover` 携带 `{sub_version, rules_version, items:[{subtitle_id, cue_version, translation_id, version}]}` 一次可恢复多行，事务内重核目标仍缺译、候选匹配与现行字数/字速，任一失效按行说明且整组不写；成功写成普通 current 译文（新译文版本从 1 开始），历史记录与旧导出快照不改、不推进 `sub_version`，术语缺失仍提示并阻止导出。HTTP 流程见 `examples/translation-recovery-api.sh`。
14. **片方审阅两批交付差异（本轮新增，只读）**：`GET /api/projects/:id/deliveries/diff?base_id=<批次>&target_id=<批次>` 输入同一项目两个交付批次，以各自**冻结 WebVTT** 按字幕起止时间区段比较实际显示文本，返回原文及两批语言并集的对照：单侧语言标 `added`/`removed`；双方都有的文件列出差异区段起止毫秒、两侧文本（空档 `null`、空白字幕 `""`）与各自文件版本；拆分/合并/整体移时按时间对齐不按行号配对，相邻且两侧文本均未变的区段合并；同批比较返回空差异。批次不存在或不属于项目明确拒绝（`404`）；快照缺失/格式损坏指出批次与文件、整份报告失败不返回部分结果（`500`）。查询只读，不受当前字幕、译文或术语修改影响，旧交付与下载约定保持兼容。HTTP 流程见 `examples/delivery-diff-api.sh`。
15. **逐词区间复核意见（本轮新增）**：在左侧 ⑨ 面板填起止词序与意见「创建意见」（自动携带当前导入代次与字幕集版本），右侧「复核意见（逐词区间）」面板逐条查看状态、词段与相交的当前字幕，可「✓ 关闭」（保存相交字幕快照）或「↩ 重新打开」；相交字幕的文本/时间/词区间再变化时意见自动转**待复核**，核对后再次关闭即可。HTTP 流程见 `examples/comments-api.sh`。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/projects` | 项目列表 |
| `POST` | `/api/projects` | 新建项目（可同时带 `words`/`cuts`/`rules`） |
| `GET` | `/api/projects/:id` | 项目完整数据（词、切点、规则、字幕、导出列表） |
| `POST` | `/api/projects/:id/import` | 替换转写与切点；已有字幕时需 `{"force": true}`（会清空字幕） |
| `PUT` | `/api/projects/:id/rules` | 改规则，需带当前 `version`，过期返回 `409` + 当前规则 |
| `POST` | `/api/projects/:id/layout` | 重排未锁定字幕，需带 `sub_version`；冲突返回 `422` + `conflicts` |
| `PATCH` | `/api/projects/:id/subtitles/:sid` | 编辑/锁定单条，需带行 `version`，过期返回 `409` + 当前行 |
| `POST` | `/api/projects/:id/exports` | 校验并确认导出（可带 `sub_version` 防呆），生成新版本快照 |
| `GET` | `/api/projects/:id/exports` | 导出版本列表 |
| `GET` | `/api/projects/:id/exports/:version` | 下载某版本 `.vtt`（内容创建后不变） |
| `POST` | `/api/projects/:id/revisions` | 提交一组待采纳修订：`{note?, items:[{subtitle_id, cue_version, text, start_ms?, end_ms?}]}`，保存原值/规则版本快照，**不改正式字幕** |
| `GET` | `/api/projects/:id/revisions` | 提议历史（pending/accepted、项数、快照版本） |
| `GET` | `/api/projects/:id/revisions/:rid` | 单个提议：逐项 `orig`（提交时原值）与 `proposed`（建议值，时间为 `null` 表示沿用原值） |
| `POST` | `/api/projects/:id/revisions/:rid/preview` | 只读预览核对：并列原值/当前值/建议值，按整版候选逐处列冲突（`evaluation.items[].conflicts`） |
| `POST` | `/api/projects/:id/revisions/:rid/accept` | 事务内再次核对并原子采纳；过期类（行版本/规则版本/已锁定/已消失/重复采纳）→ `409`，规则/结构违规 → `422`，均带 `current` 与每项 `reasons` |
| `POST` | `/api/projects/:id/word-revisions` | 提交一组逐词时间修正：`{note?, sub_version, items:[{word_idx, start_ms, end_ms}]}`，保存原值快照，**不改词与字幕** |
| `GET` | `/api/projects/:id/word-revisions` | 词修正提议历史（pending/confirmed、词数、快照版本） |
| `GET` | `/api/projects/:id/word-revisions/:wrid` | 单个提议：逐项 `orig`（读取时原值）/`current`（当前词，含文本）/`proposed`（建议值） |
| `POST` | `/api/projects/:id/word-revisions/:wrid/preview` | 只读预览：受影响字幕（`replaced`/`affected_locked`）、候选整版 `subtitles`（`origin=kept/new`）、逐项与整版冲突 |
| `POST` | `/api/projects/:id/word-revisions/:wrid/confirm` | 事务内再次核对并原子确认；过期类（字幕集版本/词漂移/词缺失/重复确认）→ `409`，锁定或排版不可兼顾 → `422`，均带 `current` 与每项 `reasons` |
| `GET` | `/api/projects/:id/translations` | 译文语言总览（各语言 current/review/历史条数与导出数） |
| `GET` | `/api/projects/:id/translations/:lang` | 单语言并列查询：逐行原文/译文/状态（`missing`/`current`/`review`）、现行规则 `invalid_reasons`、导出列表与历史译文 |
| `PUT` | `/api/projects/:id/translations/:lang/subtitles/:sid` | 保存/更新译文：`{text, cue_version, version?}`；新建 201 / 更新 200，行版本或译文版本过期 → `409`，译文超字数/字速 → `422` |
| `POST` | `/api/projects/:id/translations/:lang/subtitles/:sid/confirm` | 确认待复核译文：`{version}`；非 review → `422`、版本过期 → `409`、规则不通过 → `422`（均返回当前值且不改数据） |
| `POST` | `/api/projects/:id/translations/:lang/exports` | 校验并按语言导出译文 WebVTT；缺译/待复核/无效/整版冲突 → `422` 分类列出不生成快照（可带 `sub_version` 防呆，过期 → `409`） |
| `GET` | `/api/projects/:id/translations/:lang/exports` | 某语言译文导出快照列表 |
| `GET` | `/api/projects/:id/translations/:lang/exports/:version` | 下载某语言某版本译文 `.vtt`（内容创建后不变） |
| `POST` | `/api/projects/:id/translations/:lang/batches` | **译者整批回填（一种语言）**：`{batch_no, sub_version, rules_version, items:[{subtitle_id, cue_version, version?(0=新建), text}]}`；首次 `201`，同编号同内容重放 `200 replayed`；形状非法 `400`、版本过期/编号冲突 `409`、字数/字速违规 `422`（按行返回 `current` 与原因，整批不写入，失败不占编号） |
| `GET` | `/api/projects/:id/translations/:lang/batches/list` | 某语言译文回填批次清单（倒序） |
| `GET` | `/api/projects/:id/translation-batches` | 全部语言译文回填批次清单（倒序） |
| `GET` | `/api/projects/:id/translation-batches/:tbid` | 单个回填批次：逐行清单与写入结果（`created`/`updated`、结果版本） |
| `POST` | `/api/projects/:id/deliveries` | **片方交付批次**：`{note?, sub_version, rules_version, languages:[...], translations:{lang:[{subtitle_id, version}]}}`；事务内核对版本/结构/规则/逐行译文，通过则原文与各语言各生成一个不可变 WebVTT 并关联批次 |
| `GET` | `/api/projects/:id/deliveries` | 交付批次清单（倒序，含每批文件清单、字幕集/规则版本） |
| `GET` | `/api/projects/:id/deliveries/:bid` | 单个批次清单（文件序列版本与既有下载地址；正文走下载接口） |
| `GET` | `/api/projects/:id/deliveries/diff?base_id=&target_id=` | **片方审阅：两批交付字幕差异对照（只读）**：以两批各自冻结的 WebVTT 为准按时间区段比较显示文本，语言取并集并标注新增/移除；参数非法 `400`、批次不存在或跨项目 `404`、快照缺失/格式损坏 `500`（指出批次与文件、整份报告失败不返回部分结果） |
| `GET` | `/api/projects/:id/speakers` | 说话人名册：编号→显示名（附每条有效归属数）与当前 `attribution_version` |
| `POST` | `/api/projects/:id/speakers` | 新建说话人：`{display_name}`（编号服务端分配、不回收；含换行/`<`/`>` → `400`） |
| `PATCH` | `/api/projects/:id/speakers/:number` | 改显示名：`{attribution_version, display_name}`；改名推进归属版本，版本过期 → `409`，编号不存在 → `404` |
| `GET` | `/api/projects/:id/attributions` | 归属并列视图：名册、逐行字幕与归属（编号/显示名/标注时行版本）、计数与历史归属 |
| `PUT` | `/api/projects/:id/attributions/subtitles/:sid` | 标注单行（锁定行也可）：`{attribution_version, cue_version, speaker_number}`；首次 `201`/覆盖 `200`；版本过期 → `409`，编号不存在 → `400`，字幕不存在 → `404` |
| `POST` | `/api/projects/:id/attributions/batch` | 批量标注：`{attribution_version, items:[{subtitle_id, cue_version, speaker_number}]}`；事务内整批核对，任一过期/编号缺失整批不写入（按行返回当前值与原因），通过后整批写入、归属版本只推进一次 |
| `POST` | `/api/projects/:id/attributed-exports` | **署名版导出**：`{sub_version, attribution_version, lang?, translations?:[{subtitle_id, version}]}`；不带 `lang` 为原文，带 `lang` 为一种译文；同一事务核对每行有效归属（译文另逐行核对版本/状态/规则），失败 `422` 按行列 `codes`/`reasons` 且不生成快照，版本漂移 → `409`；成功另存带 `<v 显示名>` 标签的不可变快照 |
| `GET` | `/api/projects/:id/attributed-exports` | 署名版快照清单（原文/译文同一连续序列，倒序，含字幕集/归属/规则版本） |
| `GET` | `/api/projects/:id/attributed-exports/:version` | 下载某版本署名版 `.vtt`（内容创建后不变） |
| `GET` | `/api/projects/:id/glossaries` | 译审术语表总览：各语言术语版本与词条数 |
| `GET` | `/api/projects/:id/glossaries/:lang` | 读取某语言当前术语表（未配置返回 `configured:false`、`version:0`、空词条） |
| `PUT` | `/api/projects/:id/glossaries/:lang` | **整表修改术语**：`{version, terms:[{source,target}]}`；未配置 `version:0`，过期 → `409`（带 `current` 当前表）；空词/空译法/同源词重复 → `400`；允许空数组清空 |
| `GET` | `/api/projects/:id/glossaries/:lang/missing` | **术语缺失查询**：按语言/字幕 ID/源词逐条列出缺失规定译法（含无译文行）与当前 `glossary_version` |
| `GET` | `/api/projects/:id/translations/:lang/recovery-candidates` | **历史译文找回候选（只读）**：列出该语言当前缺译行的全部历史候选与匹配依据（`same_import`/`same_word_span`/`same_text`、`recoverable` 与中文原因），附当前 `import_version`/`sub_version`/`rules_version` |
| `POST` | `/api/projects/:id/translations/:lang/recover` | **组级恢复历史译文**：`{sub_version, rules_version, items:[{subtitle_id, cue_version, translation_id, version}]}`，可一次多行；事务内重核目标仍缺译、候选三要素与现行字数/字速，任一失效按行返回原因且整组不写；成功 `201` 写成普通 current 译文（新版本从 1 开始），历史行保留不改 |
| `GET` | `/api/projects/:id/comments` | **复核意见列表**：逐条返回状态（`open`/`closed`/`review`/`history`）、词段（当前词段 + 创建时快照）与相交的当前字幕；历史意见（旧导入代次）单独列出，附当前 `import_version`/`sub_version` 与各状态计数 |
| `POST` | `/api/projects/:id/comments` | **创建复核意见**：`{import_version, sub_version, word_start, word_end, text}`；区间须落在现有逐词转写内；形状非法 `400`、词区间越界 `422`、导入代次/字幕集版本过期 `409`（均返回当前值且不创建） |
| `POST` | `/api/projects/:id/comments/:cid/close` | **关闭意见**：`{version}`（意见版本）；须有相交的当前字幕并保存其文本/时间/词区间快照；版本过期 `409`、历史意见或无相交字幕 `422`（返回当前值且不修改） |
| `POST` | `/api/projects/:id/comments/:cid/reopen` | **重新打开意见**：`{version}`；closed/review → open；版本过期 `409`、历史意见或已是待处理 `422`（返回当前值且不修改） |

修订请求与核对说明：

- **提交拒绝（`400`）**：`items` 空组/缺字段、`subtitle_id` 重复、`text` 空、`start_ms/end_ms` 非非负整数或 `start ≥ end`（双侧给出时）。
- **提交状态校验（`422`）**：目标字幕不存在或已锁定；只给单侧时间时与原值合并后仍要求 `start < end`。
- **预览/采纳核对维度**：建议时间合法、不得缩短词区间对应词时段（开始 ≤ 首词开始、结束 ≥ 末词结束）、不与整组应用后的相邻字幕重叠、不跨镜头切点；以及当前规则的字数、最短时长、字速。还会核对行版本（`cue_version`）与规则版本（提交时快照 vs 当前）。
- **采纳原子性**：全部项通过才写入（每行 `version +1`、字幕集 `sub_version +1`、提议标记 `accepted`）；任一项失败整组回滚，响应里只含出问题的项及其 `current` 当前行与中文 `reasons`。
- **重复采纳**：已 `accepted` 的提议再次调用返回 `409 {already_accepted:true}`，不会再改字幕；历史与旧导出快照均可随时回看。
- 完整 curl 调用示例：`examples/revisions-api.sh`（新建项目→提交→预览→非法示例→冲突示例→采纳→重复采纳→历史）。

错误格式统一：`400` 请求非法（修订提交的空组/重复 ID/空文本/非法时间等，带 `errors`）；`404` 不存在；`409` 版本过期或重复采纳（带 `current` 与每项 `reasons`）；`422` 校验/冲突失败（带 `errors` 或 `conflicts`，每项含 `word_start`/`word_end` 与中文说明）。

## 排版约束与冲突处理

对每条字幕强制满足：文本 ≤ `max_chars` 字、时长 ≥ `min_duration_ms`、字数/秒 ≤ `max_cps`；
对整版强制满足：词全覆盖且顺序不变、字幕不重叠、不跨切点、词时段不被缩短。
词是不可拆分的最小单元，因此会出现规则确实无法同时满足的情况，例如：

- 切点落在某个词的时段内部（跨切点 ↔ 缩短词时段，二者必违其一）→ 报 `cut_inside_word`；
- 单个词超过最大字数 → 报 `max_chars`；
- 词段太密，最短时长/每秒字数在相邻字幕与切点夹出的空间内放不下 → 报 `duration`（含所需毫秒数与可用空间）。

此时接口返回 `422` 与完整冲突列表，**不写入任何字幕**；调整切点、规则或转写后重新排版即可。

## 批量修订提议（校对 → 预览 → 采纳）

面向校对者的**组级、乐观锁、原子采纳**流程，与既有单条编辑接口并存、互不影响：

1. **提交** `POST /api/projects/:id/revisions`
   `{note?, items:[{subtitle_id, cue_version, text, start_ms?, end_ms?}, ...]}`
   - 仅针对**未锁定**字幕；`start_ms`/`end_ms` 可省略（表示沿用该行当前起止，单侧给出时另一侧也按原值）。
   - 空组、重复 `subtitle_id`、空 `text`、非法时间（非整数、负值、`start ≥ end`）→ `400`，逐项中文说明；目标不存在/已锁定 → `422`。
   - 服务端保存每项的**原值快照**（文本/起止）、行版本 `cue_version` 与当时**规则版本**、字幕集版本；此步**绝不修改正式字幕**。
2. **预览** `POST /api/projects/:id/revisions/:rid/preview`（只读）
   把整组建议应用到当前字幕形成"候选整版"，逐项并列 `orig`（提交时原值）/`cue`（当前行）/`proposed`（建议值），并核对：
   建议时间合法、**词区间**不被缩短（开始 ≤ 首词开始、结束 ≥ 末词结束）、不与候选整版的**相邻字幕**重叠、不跨**镜头切点**、文本字数 ≤ `max_chars`、时长 ≥ `min_duration_ms`、字速 ≤ `max_cps`；
   同时标注行版本过期（`stale`）、规则版本过期、目标已锁定（`locked`）、目标已消失（`missing`）。每处冲突都带中文说明。
3. **采纳** `POST /api/projects/:id/revisions/:rid/accept`
   在**同一个 SQLite 事务**里重新读取权威当前状态并再次执行第 2 步的全部核对，外加写入后的整版结构/规则自检：
   - 全部通过 → 写入全部修订、每行 `version +1`、字幕集 `sub_version +1`、提议置为 `accepted`；
   - 任一过期/失效（行版本、规则版本、已锁定、已消失、重复采纳）→ `409`，带 `current` 当前整版与每项当前值、原因；
   - 任一规则/结构违规 → `422`，同样逐项给出原因；两种失败都**整组不生效（事务回滚）**。
4. **历史** `GET …/revisions`、`GET …/revisions/:rid`：提议与原值快照长期可查；已采纳提议重复 accept 返回 `409 {already_accepted:true}`，不会再改字幕；此前的导出快照内容不变。

前端在左侧 ⑤ 面板可直接提交（"填入所有行"会把未锁定行连同当前行版本生成模板），右侧查看历史、预览差异并一键整组采纳；纯 HTTP 流程见 `examples/revisions-api.sh`。

## 逐词时间修正（校对 → 预览 → 确认）

面向校对者修正**逐词转写本身**的时间偏差（与字幕文本无关，词序、词文本永不变更），同样是组级、乐观锁、原子流程：

1. **提交** `POST /api/projects/:id/word-revisions`
   `{note?, sub_version, items:[{word_idx, start_ms, end_ms}, ...]}`
   - `sub_version` 为校对者读取字幕集时的版本；`word_idx` 是词序号（从 0 开始），同组不得重复；
     `start_ms/end_ms` 必须是非负整数且 `start < end`；应用到当前词序列后全部词仍须按序、互不重叠。
   - 形状非法 → `400`（逐项中文说明）；`sub_version` 过期 → `409`（返回当前词与字幕）；
     词序号越界 / 修正后词序重叠 → `422`。三类拒绝都**不保存提议**。
   - 服务端保存每词的**原值快照**与字幕集版本；此步**绝不修改正式词与字幕**。
2. **预览** `POST /api/projects/:id/word-revisions/:wrid/preview`（只读）
   - 逐项并列 `orig`（读取时原值）/`current`（当前词文本与时间）/`proposed`（建议值），标注 `ok`/`drifted`（词在读取后被改过）/`missing`（重新导入后词序号不存在）；
   - 给出**受影响字幕**：`replaced`（词区间含修正词、将被删除重排的未锁定行）与 `affected_locked`（含修正词、须原样保留的锁定行）；
   - `subtitles` 为应用后的**候选整版**：`origin=kept` 的行保留 ID/行版本/人工文本/时间（锁定行与未受影响行），`origin=new` 的行为受影响区间按当前规则重排出的新行（新 ID）。
   - 逐处冲突定位到词：`locked_word_span`（修正把词推出锁定字幕边界）、`locked_cut_inside_word`（修正把镜头切点包入锁定字幕覆盖的词内）、`cut_inside_word`、`duration`、`max_chars`、`max_cps`、`word_overlap` 等。
3. **确认** `POST /api/projects/:id/word-revisions/:wrid/confirm`
   在**同一 SQLite 事务**里重新读取权威当前状态并再次执行第 2 步全部核对，外加写入后的整版结构/规则自检：
   - 全部通过 → 更新修正词时间、删除受影响未锁定字幕并按候选重排（新行新 ID/新版本）、保留行仅更新 `idx`（ID/行版本不变）、`sub_version +1`、提议置为 `confirmed`；
   - 过期/失效（字幕集版本、词漂移、词缺失、重复确认）→ `409`，带当前词与字幕及每项原因；
   - 锁定或排版规则不可兼顾 → `422`，原因定位到词/字幕。两种失败都**整组回滚，词与字幕均不变**。
4. **历史** `GET …/word-revisions`、`GET …/word-revisions/:wrid`：提议与原值快照长期可查；已确认提议重复 confirm 返回 `409 {already_confirmed:true}`；此前的导出快照内容不变。

前端在左侧 ⑥ 面板提交（"填入所有词"会带当前 `sub_version` 与全部词的当前时间，删掉不改的词即可），右侧查看历史、受影响字幕与候选整版差异后一键确认；纯 HTTP 流程见 `examples/word-revisions-api.sh`。

## 多语言译文字幕（保存 → 复核 → 按语言导出）

译文**按原时间轴**维护：不复制/编辑时间，不携带词、切点、原文，只锚定"当前源字幕行"。同一项目可维护任意多种语言（代号如 `en`、`ja-JP`、`pt_BR`），同一语言每条当前字幕最多一份非历史译文。

### 状态机

| 状态 | 含义 | 可否导出 |
|---|---|---|
| `current` | 已保存且源文本/时间/词区间与保存快照一致 | 还须满足现行字数/字速规则才可导出 |
| `review` | 保存后源字幕**文本/时间/词区间**发生变化（单条编辑、修订采纳、词修正确认、重排更新） | 否，须校对者确认或重新保存 |
| `history` | 源行被重排删除或项目重新导入（`subtitle_id` 置空） | 否，仅留档；新排版的行是**缺译**，绝不按序号挪用 |

> 重排删除（同一次逐词导入）留下的历史，在新排版出现**同词区间、同源字幕文本**的缺译行时，可经「[重排后历史译文找回](#重排后历史译文找回候选查看--组级恢复)」显式恢复；重新导入（导入代次变化）与归属未知的旧历史只能查看、不能恢复。

仅**锁定切换**（`locked`）或**展示顺序**（`idx`）变化不会使译文失效；重排时词区间相同且文本/时间一致的未锁定行会保留 ID 与行版本（身份保持），词区间相同但内容被重排改变的行版本 +1 并令译文转 `review`。规则本身收紧不会立即改写状态，但查询/导出会按现行规则动态把译文标记为无效（`invalid_reasons`），此时导出同样被拒绝。

### API 流程

1. **保存/更新** `PUT /api/projects/:id/translations/:lang/subtitles/:sid`
   `{"text":"Hello world","cue_version":1,"version":0}`
   - `cue_version` 为读取时源字幕行版本；`version` 为译文版本，新建省略或传 `0`，更新必须传当前值。
   - 成功：新建 `201`、更新 `200`，译文状态为 `current` 并记录源快照（原文/起止/词区间/行版本）。
   - `400` 语言代号非法/空译文/缺行版本；`404` 字幕不存在；`409` 行版本或译文版本过期（带 `current`）；
     `422` 译文超 `max_chars` 或沿用源行时间算出超 `max_cps`（不改任何数据）。
2. **并列查询** `GET …/translations/:lang`（只读）
   返回 `entries[]`：`cue`（原文/起止/词区间/行版本）、`translation`（无则 `null`）、`state`、`valid`、
   `invalid_reasons`（现行字数/字速中文原因），以及 `counts`、该语言 `exports` 与 `history` 历史译文。
3. **源变更联动**：单条编辑、重新排版、批量修订采纳、逐词修正确认、重新导入都会在事务内统一对账：
   变化行译文转 `review`、删除行译文留 `history`。
4. **确认待复核** `POST …/translations/:lang/subtitles/:sid/confirm`，`{"version":1}`
   校对者对照当前原文核对后确认：刷新源快照、转回 `current`、译文版本 +1；
   非 `review` → `422`；译文版本过期 → `409`；译文按现行规则无效 → `422`（返回当前值与原因，不改数据）。
   也可不确认、直接重新 `PUT` 一版新译文（带行版本与当前译文版本）。
5. **按语言导出** `POST …/translations/:lang/exports`（可带 `sub_version` 防呆）
   - 先做源整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则校验，再核对每行均有 `current` 且合规的译文；
   - 不通过 → `422` 分类返回 `missing`（缺译）、`review`（待复核）、`invalid`（译文超规则）、`conflicts`（整版冲突），**不生成快照**；
   - 通过 → 译文沿用源行起止生成按时间升序的 WebVTT，存为该语言独立递增的不可变快照；
     `GET …/translations/:lang/exports` 列版本、`GET …/translations/:lang/exports/:version` 下载，
     后续修订不影响旧文件。各语言版本号独立；原文导出 `POST /api/projects/:id/exports` 流程保持不变。
6. **语言总览** `GET …/translations`：每种语言的 current/review/历史条数与导出数。

纯 HTTP 完整示例：`examples/translations-api.sh`（新建项目→保存→乐观锁与非法示例→并列查询→锁定/源变更失效→确认→重排历史与缺译→导出拒绝→双语言导出与快照下载）。浏览器内使用左侧 ⑦ 面板：填语言代号「载入语言」后逐行保存/确认，右上按钮校验并导出。

## 译者整批译文回填（一种目标语言整批写入当前字幕）

译者完成整批译文后，可以按**一种目标语言**把整批译文一次回填到当前字幕，而不必逐行 `PUT`。回填是组级、乐观锁、**原子**写入，结果就是普通译文——既有逐行操作、并列查询、单语言导出与多语交付全部照常读取。

- 提交内容：**批次编号** `batch_no`（非空、≤64 字；同项目同语言唯一）、读取时的**字幕集版本** `sub_version` 与**规则版本** `rules_version`、可选 `note`，以及**非空逐行清单** `items[]`；每行 `{subtitle_id, cue_version, version, text}`：`cue_version` 为读取时源行版本，`version` 为译文版本（新建传 `0` 或省略，覆盖更新传当前值），`text` 为非空译文文本。
- **写入前拒绝（`400`，不触碰数据、不占编号）**：清单为空、字段缺失/类型错误、译文文本空白、**同批字幕 ID 重复**、语言代号非法、清单指向**当前字幕集不存在的字幕行**（可能已被重排删除）。
- **提交时事务内重新核对**：
  1. `sub_version` / `rules_version` 仍是当前值——漂移 → `409`，带当前规则与字幕；
  2. 逐行核对源行存在、源行版本 `cue_version` 仍是当前值（过期 → `cue_version_stale`）；
  3. 逐行核对译文版本：无当前译文却按更新（`version>0`）→ `translation_missing`；已存在译文却按新建（`version=0`）→ `translation_exists`；译文版本不匹配 → `translation_version_stale`。以上过期类 → `409`；
  4. 译文沿用源行起止，须满足当前 **max_chars / max_cps**——违规 → `invalid`，按 `422` 处理。
  - **任一行过期或违规，按行返回当前值（`cue`、当前译文 `current`）与中文 `reasons`，整批不写入**（事务回滚）。
- **通过后同一事务保存全部译文**：
  - 无当前译文的行 → 新建，译文版本从 **`1`** 开始，状态 `current` 并记录源快照；
  - 已有当前译文的行（含 **review 待复核**，即允许覆盖）→ 译文**版本 +1**、文本更新、状态转 `current`，**源快照刷新为当前源行**；
  - **未列出的行不变、其他语言不变**；回填只写译文，**不推进** 字幕集 `sub_version`；写入 `WHERE version=?` 兜底防并发。
- **批次编号与幂等**：内容指纹（SHA-256，对清单按 `subtitle_id` 排序，故提交顺序不影响；覆盖语言/读取版本/逐行源行版本/译文版本/文本，不含 `batch_no`/`note`）。
  - **同项目同语言编号重复且内容相同** → `200 {"replayed":true,...}` 原样返回**首次结果**，不再写入任何译文、不增加版本；
  - **编号相同但内容不同** → `409 {conflict:"batch_no_content_conflict"}`，附首次批次摘要与本次指纹；
  - 批次编号**按语言独立**（不同语言可复用同一编号）；**失败的核对（400/409/422）不留批次记录、不占编号**，修正后可用同一编号重新提交。
- **下游读取**：回填后的译文直接出现在 `GET …/translations/:lang` 的并列视图（`current`）、语言总览、按语言导出与多语交付核对中；回填前已生成的原文/译文导出快照**内容不变**。

### API 流程

1. **整批回填** `POST /api/projects/:id/translations/:lang/batches`

   ```json
   {
     "batch_no": "B-EN-2026-001",
     "note": "译者甲交付的第一批英语",
     "sub_version": 3,
     "rules_version": 1,
     "items": [
       {"subtitle_id": 1, "cue_version": 2, "version": 0, "text": "Hello world"},
       {"subtitle_id": 2, "cue_version": 1, "version": 1, "text": "Welcome"}
     ]
   }
   ```

   - `201` 首次写入：`{replayed:false, id, batch_no, lang, sub_version, rules_version,
     item_count, created_count, updated_count, items:[{ord, subtitle_id, action, version, text}]}`，
     `action` 为 `created`（结果版本 1）/ `updated`（结果版本 = 旧版本 +1）。
   - `200 {"replayed":true,...}`：同编号同内容重放，其余字段与首次响应逐字一致。
   - `400`：形状非法（空清单/重复 ID/非法语言/字幕不存在/空文本/非法版本字段，附 `errors`）。
   - `409`：`sub_version_stale`/`rules_version_stale`（带 `current`）、逐行过期类（`items[].state` 为
     `cue_missing`/`cue_version_stale`/`translation_missing`/`translation_exists`/`translation_version_stale`，
     每行附 `cue`、`current` 与 `reasons`），或编号冲突 `batch_no_content_conflict`。
   - `422`：一行或多行 `state:"invalid"`（超 max_chars/max_cps，附 `reasons`），整批不写入。
2. **批次清单**：某语言 `GET …/translations/:lang/batches/list`；全部语言 `GET …/translation-batches`（倒序）。
3. **单个批次** `GET …/translation-batches/:tbid`（不存在 → `404`）：逐行提交值与写入结果（`action`/`result_version`）。

完整 curl 示例：`examples/translation-batches-api.sh`（新建项目排版→整批新建→幂等重放→编号冲突→非法/过期/违规各类拒绝→覆盖待复核整批更新→单语言导出与多语交付读取→批次清单）。

## 片方多语字幕交付（一个批次冻结原文 + 多语言）

片方交付需要把**原文与若干选定语言冻结在同一时间轴**上。批量交付接口在**一个 SQLite 事务**内完成"再核对 + 整批冻结"，与既有原文/单语言导出共用同一套不可变快照与下载能力：

- 提交内容：当前**字幕集版本** `sub_version`、**规则版本** `rules_version`、**非空且不重复**的语言代号列表 `languages`，以及 `translations` 中**每种语言逐行译文版本**清单（每条 `{subtitle_id, version}`，与当前字幕行一一对应）；可附 `note`。
- 事务内核对：
  1. `sub_version` 仍是当前字幕集版本、`rules_version` 仍是当前规则版本——任一漂移 → `409`，带当前规则与字幕；
  2. 源字幕整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则（字数/最短时长/字速，含锁定行）通过，否则 `conflicts` → `422`；
  3. 每种语言的每条字幕都有一份 `current`、`version` 与提交一致且满足现行**字数/字速**的译文。
- 失败原因**按语言和字幕行**分类返回：`missing`（清单漏行/无当前译文）、`review`（待复核）、`invalid`（current 但违反现行字数/字速，附中文原因）、`version_stale`（译文版本漂移，附提交版本与当前版本/文本）。任一语言任一行失败，**整批回滚：不生成任何快照、不占用任何序列版本号**。
- 成功：在现有**原文导出序列** `exports` 与**各语言导出序列** `translation_exports` 上各取下一个版本写入 WebVTT（各文件的 cue 数与起止时间完全一致，正文为原文或对应译文），再写入批次与文件清单 `delivery_batches` / `delivery_files`。响应与清单只给序列版本与**既有下载地址**（外加本次快照正文便于直接取用）；文件统一经既有接口下载：
  - 原文：`GET /api/projects/:id/exports/:version`
  - 译文：`GET /api/projects/:id/translations/:lang/exports/:version`
- **不可变**：快照一经生成不再改变；之后编辑原文、采纳修订、确认词修正、重排或改译文，都只影响后续交付，旧批次及其文件保持原样。
- **兼容**：批次文件就是普通的原文/单语言导出快照，会同时出现在既有导出列表中，版本号在各序列内连续递增；单独使用 `POST …/exports` 或 `POST …/translations/:lang/exports` 的旧流程与下载约定不变。

### API 流程

1. **提交交付** `POST /api/projects/:id/deliveries`

   ```json
   {
     "note": "片方交付第一批",
     "sub_version": 3,
     "rules_version": 1,
     "languages": ["en", "fr"],
     "translations": {
       "en": [{"subtitle_id": 1, "version": 2}, {"subtitle_id": 2, "version": 1}],
       "fr": [{"subtitle_id": 1, "version": 2}, {"subtitle_id": 2, "version": 1}]
     }
   }
   ```

   - `201` 返回批次清单：`id`、冻结的 `sub_version`/`rules_version`/`cue_count`/`languages`，以及 `files[]`
     （`ord` 0 为 `source` 原文，其后按语言顺序为 `translation`；每个文件给 `kind`/`lang`/`version`/`cue_count`/`download_url` 与本次 `content`）。
   - `400` 请求形状非法（语言为空/重复/非法代号、`translations` 与 `languages` 不对应、清单行数与字幕不一致、指向不存在的字幕行、`version` 非正整数、清单内字幕行重复等）。
   - `409` 字幕集或规则版本漂移（`sub_version_stale`/`rules_version_stale` + `current`）。
   - `422` 源整版 `conflicts` 或逐语言 `languages[].missing/review/invalid/version_stale`；整批不生效。
2. **批次清单** `GET /api/projects/:id/deliveries` → `{project_id, batches:[...]}`（按批次倒序）。
3. **单个批次** `GET /api/projects/:id/deliveries/:bid`（不存在 → `404`）；文件正文用其中 `download_url` 经既有下载接口取得（`text/vtt` 附件下载，内容不可变）。

完整 curl 示例：`examples/deliveries-api.sh`（准备双语译文→非法/漂移/缺译/待复核/译文版本漂移各类失败→成功批次→清单查询→既有接口下载→后续编辑不改旧批次→第二批在各序列取新版本）。

## 片方审阅：两批交付字幕差异对照（只读）

片方审阅同一项目**两次交付的实际字幕差异**时，输入**基准批次**与**目标批次** ID，服务端只读取两批各自**冻结的 WebVTT 快照**做对照——不碰当前字幕、译文或术语表，因此对照结果不受交付之后任何编辑影响，可重复查询。

```
GET /api/projects/:id/deliveries/diff?base_id=<基准批次ID>&target_id=<目标批次ID>
```

### 对照口径

- **语言取两批并集**：原文（`source`）两批必有；只在目标批出现的语言标 `status:"added"`（新增），只在基准批出现的语言标 `status:"removed"`（移除），双方都有的文件标 `"both"`。`languages.union/base_only/target_only` 同时给出并集与单侧语言清单（顺序：基准批语言顺序在前，目标批独有的按目标批顺序追加）。
- **双方都有的文件**：严格解析各自冻结快照，以**字幕起止时间构成的区段**比较“实际显示文本”：
  - 把两侧全部 cue 的起止时间合并切分为极小区段，逐段比较该时刻两侧正在显示的文本，不同即为一个差异区段；
  - **拆分、合并或整体移时均按时间区段自然对齐，绝不按行号配对**——例如一批一条整句、另一批在中间切开，会在切开点两侧分别给出同一条基准文本对两条目标文本；整句平移则旧区段报 `目标=null`、新区段报 `基准=null`；
  - **空白与字幕的转换不漏报**：空 cue 载荷记为空字符串 `""`，时间空档（该区间无字幕）记为 `null`，二者互不相等；
  - **相邻差异区段合并**：相邻两段在两侧各自的显示文本跨边界均未变化（含同为空档）时合并为一条（一批一整句、另一批仅因切点拆成两段时不会被切点切碎报告）。
- 每个差异区段给出：`start_ms`/`end_ms`（毫秒）与 `start`/`end`（`HH:MM:SS.mmm`）、`base_text`/`target_text`（`null` 表示该侧此区间无字幕）、以及 `base_version`/`target_version`（两侧对应文件在其导出序列上的冻结版本）；文件级还给出两侧 `version`、`cue_count` 与既有 `download_url`。
- **同批比较**（`base_id == target_id`）：快照完好时返回空差异（各文件 `diff_count:0`，`same_batch:true`）。

### 拒绝与失败（不返回部分结果）

- `400`：`base_id`/`target_id` 缺失或不是 ≥1 的整数；
- `404`：任一批次**不存在**（`reason_code:"batch_not_found"`）或**不属于该项目**（`reason_code:"batch_other_project"`，并指出其实际所属项目），明确拒绝跨项目对照；
- `500`：任一文件**快照缺失**（清单指向的导出快照行不存在，`snapshot_missing`）或**格式损坏**（WebVTT 签名缺失、时间戳非法、cue 重叠/逆序/零时长、实际 cue 数与冻结清单不符等，`snapshot_corrupt`；批次清单本身异常为 `manifest_corrupt`）。响应的 `snapshot_problems[]` **一次性指出全部**有问题的**批次（`batch_id`、`side`）与文件（kind/lang/version/download_url）及中文原因**；整份报告失败，**不返回 `files` 等任何部分结果**。

### 响应示例（节选）

```json
{
  "project_id": 2,
  "base": { "id": 3, "note": "第一批", "sub_version": 2, "rules_version": 1, "cue_count": 2 },
  "target": { "id": 4, "note": "第二批", "sub_version": 3, "rules_version": 1, "cue_count": 2 },
  "same_batch": false,
  "languages": { "union": ["en", "fr", "ja-JP"], "base_only": ["fr"], "target_only": ["ja-JP"] },
  "summary": { "file_count": 4, "changed": 2, "unchanged": 0, "added": 1, "removed": 1, "difference_count": 2 },
  "files": [
    {
      "kind": "source", "lang": null, "status": "both",
      "base": { "version": 1, "download_url": "/api/projects/2/exports/1", "...": "..." },
      "target": { "version": 2, "download_url": "/api/projects/2/exports/2", "...": "..." },
      "diff_count": 1,
      "differences": [{
        "start_ms": 0, "end_ms": 1000,
        "start": "00:00:00.000", "end": "00:00:01.000",
        "base_text": "你好世界", "target_text": "你好世界呀",
        "base_version": 1, "target_version": 2
      }]
    },
    { "kind": "translation", "lang": "fr", "status": "removed", "base": { "version": 1, "...": "..." }, "target": null, "diff_count": 0, "differences": [] },
    { "kind": "translation", "lang": "ja-JP", "status": "added", "base": null, "target": { "version": 1, "...": "..." }, "diff_count": 0, "differences": [] }
  ]
}
```

完整 curl 示例：`examples/delivery-diff-api.sh`（连续两批交付（含语言新增/移除与文本修改）→ 对照并展示语言并集与时间区段差异（毫秒/文本/两侧版本）→ 同批比较空差异 → 参数非法/批次不存在/跨项目拒绝）。该接口**只读**：不改变任何批次、快照、当前字幕、译文或术语；既有交付与 `exports`/`translations/:lang/exports` 下载约定完全保持兼容。


## 说话人标注与署名版导出（名册 → 按字幕 ID 归属 → 带标签不可变快照）

审校人员在现有字幕上标明发言者，并导出带说话人标签的 WebVTT。归属**按字幕 ID 锚定**（不按展示序号），普通导出与旧下载内容保持兼容，署名版另存独立的不可变快照序列。

### 数据模型与版本

- **说话人名册** `speakers`：项目内「编号 `number`（服务端按顺序分配，1 起、**不回收、不可变**）→ 显示名 `display_name`」。显示名可改，**改名推进归属版本** `projects.attribution_version`；显示名不得含换行（`\n`/`\r` 及 Unicode 行/段分隔符）或 WebVTT 标签界定符 `<`、`>`，不得含首尾空白，最长 64 字。
- **归属** `attributions`：每条当前字幕最多一条 `active` 归属（部分唯一索引），记录 `speaker_id`、标注时编号快照 `speaker_number` 与读取时**行版本** `cue_version`。
- **归属版本** `attribution_version`：改名或归属写入时 `+1`；重排本身**不**推进它。归属标注与署名导出都携带它做乐观锁。
- **历史归属**：原字幕行被重排/词修正确认/重新导入删除后，其 `active` 归属在对账中转 `history` 并置空 `subtitle_id`，仅留档；**新排版的行待标注，绝不按展示序号挪用**。重排中**保留 ID** 的行（仅 `idx` 变化或原地更新）归属继续有效。

### 生命周期与锁定

- 归属提交同时携带读取时**归属版本**与该行**行版本**：归属版本漂移或行版本过期 → `409`，响应 `current` 给出当前归属视图/当前行；说话人编号不存在 → `400`（附当前名册）。
- **锁定行也可标注**：锁定只约束排版与字幕修订，不约束归属；标注归属不改字幕文本/时间，也不推进 `sub_version`。
- 单行 `PUT` 支持首次标注（`201`）与覆盖更新（`200`）；批量 `POST …/attributions/batch` 在一个事务内整批核对，**任一行过期或编号缺失则整批不写入**（按行返回 `state` 与中文原因），全部通过后整批写入且归属版本只 `+1`。

### 署名版导出（同一事务核对，失败按行列原因）

`POST /api/projects/:id/attributed-exports`，请求 `{sub_version, attribution_version}`：

- **原文**：不带 `lang`。
- **一种目标语言**：`{..., lang:"en", translations:[{subtitle_id, version}, ...]}`，`translations` 为逐行译文版本清单。

服务端在**同一个 SQLite 事务**内重新读取权威状态并核对：

1. `sub_version` 与 `attribution_version` 仍是当前值——漂移 → `409`（带当前值），不生成快照；
2. 源字幕整版结构（词覆盖/不重叠/不跨切点/不缩短词时段）与现行规则通过——否则 `conflicts` → `422`；
3. **每条当前字幕都有有效归属**：缺归属 `missing_attribution`、名册中已无该说话人 `speaker_missing`、显示名无法写入标签 `invalid_speaker_name`；
4. 选择译文时逐行核对：清单漏行 `missing_translation_version`、无当前译文 `missing_translation`、版本漂移 `translation_version_stale`、待复核 `translation_review`、违反现行字数/字速 `translation_invalid`。

任一整版冲突或逐行问题都在 `422.rows[]` 中**按行**给出 `codes` 与中文 `reasons`，**不生成快照、不占用版本号**。通过后用当前显示名与原文（或译文）文本生成按时间升序的 WebVTT，正文写说话人标签：

```vtt
WEBVTT

1
00:00:00.000 --> 00:00:01.000
<v 茶客甲>你好世界</v>
```

- **原文与译文共用源字幕时间轴**（起止完全一致）；快照记录 `sub_version`、`attribution_version`、`rules_version`。
- 快照写入独立序列 `attributed_exports`（原文/译文共用项目内连续版本号），可 `GET` 列表/下载，**创建后不可变**：之后改名、改归属、编辑字幕、采纳修订、重排都不影响旧快照。
- **兼容**：普通原文导出 `POST …/exports` 与单语言导出 `POST …/translations/:lang/exports` 及其下载内容**不含说话人标签、完全不变**，署名快照也不占用普通导出序列的版本号。

### API 流程

1. 建说话人：`POST /api/projects/:id/speakers` `{"display_name":"茶客甲"}` → `201 {speaker:{number:1,...}}`。
2. （可选）改名：`PATCH /api/projects/:id/speakers/1` `{"attribution_version":0,"display_name":"新名"}` → 归属版本 `+1`。
3. 查询并列视图：`GET /api/projects/:id/attributions`（名册、逐行归属、计数、历史）。
4. 标注：单行 `PUT /api/projects/:id/attributions/subtitles/:sid`
   `{"attribution_version":0,"cue_version":1,"speaker_number":1}`；或整批
   `POST /api/projects/:id/attributions/batch`
   `{"attribution_version":0,"items":[{"subtitle_id":1,"cue_version":1,"speaker_number":1}]}`。
5. 署名导出（原文）：`POST …/attributed-exports` `{"sub_version":1,"attribution_version":1}`；
   署名导出（译文）：再带 `"lang":"en"` 与 `"translations":[{"subtitle_id":1,"version":1}]`。
6. 查询/下载：`GET …/attributed-exports` 与 `GET …/attributed-exports/:version`。

完整 curl 示例：`examples/speakers-api.sh`（名册→单行/批量标注→过期与编号错误→锁定行标注→重排身份保持→原文署名导出→改名与快照不可变→译文署名导出及逐行版本漂移→清单/下载→普通导出兼容）。浏览器内使用左侧 ⑧ 面板。

## 译审术语对照表（源词 → 规定译法；查询提示，导出拦截）

译审为项目的每个目标语言维护一张**整表版本化**的术语对照表。术语只约束**译文内容是否包含规定译法**，不改动原文、时间轴或译文状态机：

- **表结构与版本**：每项目每语言至多一张表（`glossaries`），词条为 `{source 源词, target 规定译法}`。修改是**整表替换**（提交内容即修改后的完整词条），必须携带读取时**术语版本** `version`：该语言从未配置时传 `0`（创建后版本为 1）；之后每次修改版本 `+1`，过期提交返回 `409` 与 `current` 当前表。
- **词条约束**：`source`/`target` 均为**非空文本**，不允许首尾空白、长度 ≤100 字；**同一语言术语表内源词不得重复**（整批内唯一，由数据库唯一索引兜底）；允许提交**空词条数组**（清空该语言术语，表与版本保留）。未配置术语（或词条为空）的语言**不受任何影响**。
- **精确匹配规则**：以**当前原文字幕文本**对源词做字面子串精确匹配（大小写敏感、不做分词）；每条命中源词的译文都必须**包含对应规定译法**（同样为子串匹配），**一行命中多个源词时每个规定译法都必须出现**。例：原文「你好世界」配置 `你好→Hello`、`世界→world` 时，译文 `Hello world`、`world, Hello!` 均合规，`Hello there` 缺 `world`。
- **保存不拦截、状态不联动**：译文即使缺失规定译法也可以正常 `PUT`/整批回填保存（供译者随后修正），保存响应与单语言并列查询在每行附 `term_issues`（逐条 `{source,target,reason}`）；**术语新增/修改/清空绝不改变既有译文的 `current`/`review` 状态**，也不影响确认、锁定、重排等既有约定。
- **缺失查询**：`GET …/glossaries/:lang/missing` 只读，按**语言、字幕 ID 与源词**逐条列出当前缺失（无译文的行同样列出），并给当前 `glossary_version`，供译者逐行补译后复查。

### 导出闸门（在原有事务内读取当前术语）

以下三类导出/交付保持原有事务与乐观锁不变，在**同一事务内读取当前术语表**并追加术语核对；任一缺失都**逐行报错且不生成快照、不占用任何序列版本号**：

1. **单语言译文导出** `POST …/translations/:lang/exports`：失败 `422` 新增 `term_missing[]`（每行附命中源词、缺失术语、当前译文与逐条原因）与 `glossary_version`；成功响应同样带 `glossary_version`。
2. **多语言同版交付** `POST …/deliveries`：每种语言结果新增 `term_missing[]` 与 `glossary_version`；任一语言任一行缺术语，整批回滚（原文/译文快照均不生成）。
3. **译文署名版导出** `POST …/attributed-exports`（带 `lang`）：问题行 `codes` 增加 `translation_term_missing` 并附 `term_missing[]`，响应带 `glossary_version`；**原文署名导出不做术语核对**。

术语闸门只作用于“其余条件已满足”的行（已有 `current`、版本一致、字数/字速合规），避免与 `missing`/`review`/`invalid`/`version_stale` 重复报错；这些问题修正后再次导出时会按**当时**的术语重新核对。**原文导出 `POST …/exports` 完全不涉及术语；既有译文读写接口形状与语义不变；已生成的一切快照（原文/译文/署名版/交付批次文件）不可变，术语随后收紧也不影响旧文件下载。**

### API 流程

1. 读取：`GET …/glossaries`（总览）、`GET …/glossaries/en`（单语言，含 `version`/`terms`）。
2. 建表/修改：`PUT …/glossaries/en`
   ```json
   {"version": 0, "terms": [{"source": "你好", "target": "Hello"}]}
   ```
   - `200` 返回修改后的表（`version`/`term_count`/`terms`）；`400` 形状非法（附逐项 `errors`，不修改）；`409` 术语版本过期（`current` 为当前表）。
3. 保存译文时查看响应 `term_issues`，或用 `GET …/translations/en` 的逐行 `term_issues` / `counts.term_missing`。
4. 缺失查询：`GET …/glossaries/en/missing` → `{glossary_version, missing:[{subtitle_id, idx, source_text, matched:[...], missing:[{source,target,reason}]}]}`。
5. 照常调用三类导出；术语缺失时按行修正译文后重试（术语版本无需调用方传入——导出始终在事务内读取当前版本）。

完整 curl 示例：`examples/glossaries-api.sh`（建表/非法与过期示例→缺术语译文可保存→缺失查询→单语言导出拦截→术语收紧不改状态与旧快照→多语交付整批拦截与成功→译文署名导出拦截/原文署名不受影响）。

## 重排后历史译文找回（候选查看 → 组级恢复）

重新排版会删除部分未锁定源字幕行，其译文按状态机约定留作 `history`——**绝不按展示序号自动挪用**到新行。但当重新排版又产生了「**词区间相同、源字幕文本相同**」的缺译行时，旧译文的内容往往仍然可用。找回流程让校对者**显式、带核对地**把它们恢复成普通 current 译文，而不是靠序号猜测。

### 导入代次（恢复资格）

项目维护逐词**导入代次** `import_version`：项目创建（首次导入）为 `1`，每次 `POST …/import` 重新导入 `+1`。每条译文保存时记录源行当时所属代次（`translations.src_import_id`）。历史候选可恢复必须**同时**满足三要素：

1. **同一次逐词导入**：历史的 `src_import_id` 等于当前 `import_version`；
2. **词区间一致**：历史快照 `src_word_start/src_word_end` 等于当前行 `word_start/word_end`；
3. **源字幕文本一致**：历史快照 `src_text` 等于当前行文本。

因此：**重排**删除行留下的历史（同一次导入、词与原文可重现）在重新细分排版后**可以恢复**；**重新导入**留下的历史即使词区间与文本恰好相同，也因导入代次不一致而**仅供查看、不能恢复**（无法保证词与旧译文同源）；旧库迁移来的、`src_import_id` 为空（无法确认导入归属）的历史同样**仅供查看**。

### 候选查询（只读）

`GET /api/projects/:id/translations/:lang/recovery-candidates`

对该语言**当前缺译**（没有 current/review 译文）的每行列出全部历史候选：

```json
{
  "lang": "en",
  "import_version": 1,
  "sub_version": 3,
  "rules_version": 3,
  "recoverable_target_count": 2,
  "targets": [
    {
      "cue": {"id": 7, "idx": 0, "word_start": 0, "word_end": 0, "text": "你好", "version": 1, "...": "..."},
      "has_recoverable": true,
      "candidates": [
        {
          "translation": {"id": 1, "text": "AB", "version": 1, "status": "history",
                          "src_text": "你好", "src_word_start": 0, "src_word_end": 0,
                          "src_import_id": 1, "...": "..."},
          "recoverable": true,
          "matches": {"same_import": true, "same_word_span": true, "same_text": true},
          "reasons": []
        },
        {
          "translation": {"id": 2, "text": "CD", "...": "..."},
          "recoverable": false,
          "matches": {"same_import": true, "same_word_span": false, "same_text": false},
          "reasons": ["词区间不一致：历史快照为词 1–1，当前行为词 0–0", "源字幕文本不一致：……"]
        }
      ]
    }
  ]
}
```

- 不可恢复的候选（旧代次、归属未知、词区间/文本不符）**仍然列出**，逐条给出 `matches` 与中文 `reasons`，但不能提交恢复；
- 已有 current/review 译文的行不是缺译行，不出现在 `targets` 中（恢复只补缺译，不覆盖既有译文）。

### 组级恢复（同一事务重核，整组原子）

`POST /api/projects/:id/translations/:lang/recover`

```json
{
  "sub_version": 3,
  "rules_version": 3,
  "items": [
    {"subtitle_id": 7, "cue_version": 1, "translation_id": 1, "version": 1},
    {"subtitle_id": 8, "cue_version": 1, "translation_id": 2, "version": 1}
  ]
}
```

- 每行四元组定位：**目标行**（`subtitle_id` + 读取时 `cue_version`）与**候选译文**（`translation_id` + 候选 `version`，双重定位防止同版本历史混淆）；同批 `subtitle_id` 不得重复。
- 服务端在**同一个 SQLite 事务**内重新读取权威状态并逐行重核：
  - `sub_version` / `rules_version` 漂移 → `409`（带当前规则与字幕）；
  - 目标行已消失 `cue_missing`、行版本过期 `cue_version_stale`、目标已不缺译 `not_missing`（已有他人补的 current/review 译文，返回该译文且不覆盖）；
  - 候选不存在/不属于本项目 `candidate_missing`（`400`）、候选属于其他语言 `candidate_wrong_lang`（`400`）、候选不是历史 `candidate_not_history`（`400`）、候选版本漂移 `candidate_version_stale`（`409`）；
  - 三要素失效 `candidate_mismatch`（`409`，按导入代次/词区间/源文逐条说明）；
  - 候选译文文本不满足**现行 max_chars / max_cps**（时长随当前源行）→ `invalid`（`422`）。
- **任一行失效，整组不写入**（事务回滚），响应只列出有问题的行及其当前 `cue`、当前译文 `current`、候选 `candidate` 与中文 `reasons`。

成功返回 `201`：

```json
{
  "lang": "en", "sub_version": 3, "rules_version": 3, "import_version": 1,
  "restored_count": 2,
  "items": [
    {"ord": 0, "subtitle_id": 7, "translation_id": 3, "restored_from": 1,
     "version": 1, "text": "AB", "glossary_version": 0, "term_issues": []}
  ]
}
```

### 恢复后的语义（与既有功能的关系）

- 恢复是 **INSERT 一条新的普通 current 译文**（版本从 **1** 开始，源快照为当前行、`src_import_id` 为当前代次）；**原 history 行原样保留**（历史记录不改，可反复作为其他同词区间缺译行的候选）；
- 恢复**只写译文**，**不推进** `sub_version`（与整批回填一致），不改词、切点、源字幕；
- 恢复出的译文就是普通译文：逐行 `PUT`/`confirm`、并列查询、语言总览、整批回填、单语言导出、多语交付、译文署名导出全部照常读取；
- **术语缺失不阻塞恢复**：响应与并列视图照常给 `term_issues`，并继续在三类导出的事务闸门中**阻止导出**直到补正；
- **旧导出快照不可变**，恢复不影响任何已生成的原文/译文/署名/交付文件。

完整 curl 示例：`examples/translation-recovery-api.sh`（细分排版→存译文→合并删除留历史→重新细分→候选查询（含不可恢复候选依据）→非法/漂移/错配各类拒绝→两行组级恢复→重复恢复被拒→重新导入换代次后旧历史不可恢复）。

## 逐词区间复核意见（创建 → 关闭 → 漂移待复核 → 历史）

校对页管理锚定**逐词区间**的复核意见：意见针对的是「词序列上的一段」，而不是某条字幕行——因此重排拆并、逐词改时、字幕行更替（旧行删除、新行新 ID）之后，意见仍按词区间显示在**相交的当前字幕**旁，**绝不按字幕 ID 或展示行号迁移**。

### 锚定与状态机

- **锚定**：每条意见记录创建时的**逐词导入代次** `import_version` 与**词序区间** `[word_start, word_end]`（词序号，与逐词修正同一套序号）。相交判定：字幕词区间与意见词区间有重叠即为相交。
- **状态机**：

| 状态 | 含义 | 迁移 |
|---|---|---|
| `open` | 待处理（创建后尚未关闭） | 显式关闭 → `closed` |
| `closed` | 已关闭（关闭时保存相交字幕快照） | 相交字幕的文本/时间/词区间变化 → 自动 `review` |
| `review` | 待复核（关闭后相交字幕内容又变化） | 只能由校对者再次显式关闭 → `closed`；或重新打开 → `open` |
| `history` | 历史（重新导入后的旧代次意见） | 终态：仅查看，不可关闭/重开 |

- **关闭快照**：关闭时必须有**相交的当前字幕**（尚未排版覆盖该词段时无法关闭），并保存相交字幕的**文本、起止毫秒与词区间**快照（按词序排序，不含字幕 ID/展示序号/锁定标记）。此后单条编辑、批量修订采纳、逐词修正确认、重新排版导致这些内容变化时，对账（`syncComments`，与译文 `syncTranslations` 同一调用时机）自动把意见转 `review`；**仅锁定切换或展示顺序变化不触发**（快照不含这些维度）。
- **重新导入**：`POST …/import` 推进导入代次后，旧代次意见全部转 `history`——列表中单独成区**仅作历史查看**（`words` 为 `null`、`subtitles` 为 `[]`，创建时的词段快照 `words_snapshot` 与关闭快照保留供查），**不附到新词段、不可关闭/重新打开**；新代次可照常创建新意见。
- **乐观锁**：创建携带当前 `import_version` 与 `sub_version`；关闭/重新打开携带**意见版本** `version`（每次写入 +1）。**创建或写入所带版本过期均返回 `409` 与当前值，且不修改任何数据**。

### API 流程

1. **创建** `POST /api/projects/:id/comments`
   `{"import_version":1,"sub_version":1,"word_start":0,"word_end":1,"text":"「你好世界」连读略快"}`
   - `201` 创建成功（状态 `open`、意见版本 `1`），响应含完整意见视图。
   - `400` 形状非法（缺字段、空意见、区间颠倒、非法词序）；`422` 词区间超出当前逐词转写（含尚未导入）；
     `409` 导入代次或字幕集版本过期（`current` 返回当前代次/字幕集版本/词数/字幕，不创建）。
2. **列表** `GET /api/projects/:id/comments`（只读）
   返回 `import_version`/`sub_version`（供创建携带）、`counts`（各状态计数）、`comments`（当前代次意见，按创建顺序）与 `history`（旧代次，倒序）。每条意见含：
   - `status`/`version`/`text`/`word_start`/`word_end`；
   - `words`：当前词段（词序/文本/起止；历史意见为 `null`）；`words_snapshot`：创建时词段快照；
   - `subtitles`：**相交的当前字幕**（id/idx/词区间/文本/起止/锁定/行版本；历史意见为 `[]`）；
   - `snapshot`：关闭时相交字幕快照（未关闭过为 `null`）与 `closed_at`/`closed_sub_version`。
3. **关闭** `POST …/comments/:cid/close`，`{"version":1}`
   - `200` 关闭成功：状态 `closed`、意见版本 +1、`snapshot` 为当前相交字幕快照；
   - `409` 意见版本过期（`current.comment` 为当前意见，不修改）；`422` 历史意见（不可关闭）或当前无相交字幕。
   - `open`/`review`/`closed` 状态都可显式关闭（`closed` 下为刷新快照的幂等操作）。
4. **重新打开** `POST …/comments/:cid/reopen`，`{"version":2}`
   - `200`：`closed`/`review` → `open`、意见版本 +1（保留关闭快照供对照）；
   - `409` 意见版本过期；`422` 历史意见或意见本就处于 `open`。

### 与既有功能的关系

- 意见是**校对批注**，不改动词、切点、字幕、译文与规则，也**不推进** `sub_version`；导出（原文/译文/署名/交付）不读取意见，**既有导出快照与全部既有接口行为保持不变**。
- 页面：左侧 ⑨ 面板创建（自动携带当前导入代次与字幕集版本），右侧「复核意见（逐词区间）」面板查看/关闭/重新打开，历史意见单独成区只读。

完整 curl 示例：`examples/comments-api.sh`（创建→非法/越界/版本过期→列表（词段+相交字幕）→关闭快照→文本变化转待复核/锁定不触发→重开与再关闭→重排拆并后仍锚定词区间→重新导入转历史且不可关闭→新代次再创建）。


## 目录结构

```
server.js            入口：初始化 SQLite、播种演示数据、启动 HTTP
src/db.js            连接与建表（projects[含 sub_version/attribution_version/import_version]/words/shots/rules/subtitles/exports/revisions/revision_items/word_revisions/word_revision_items/translations[含 src_import_id]/translation_exports/delivery_batches/delivery_files/translation_batches/translation_batch_items/speakers/attributions/attributed_exports/glossaries/glossary_terms/review_comments；旧库迁移补 attribution_version/import_version/src_import_id）
src/layout.js        排版引擎（纯函数）：切点分析 → 分段 → 定时 → 结构自检
src/validate.js      导入与编辑校验
src/revision.js      批量字幕修订提议：请求解析 + 整组候选核对（词区间/时间/切点/相邻/规则/版本）
src/word-revision.js 逐词时间修正：请求解析 + 候选整版核对（词序重叠/锁定边界/受影响区间重排/规则/版本）
src/translation.js   多语言译文字幕：解析/规则校验/并列视图/失效对账（current→review/history）/导出核对
src/translation-batch.js 译者整批译文回填：请求解析/内容指纹/事务内逐行版本与规则核对/幂等与批次清单
src/delivery.js      片方多语交付批次：请求解析 + 事务内整版/逐语言逐行核对 + 批次清单视图
src/delivery-diff.js 片方审阅两批交付差异（只读）：批次归属校验/冻结快照完整性预检/语言并集/区段对照报告组装
src/speaker.js       说话人标注：名册/显示名校验/归属批量与单行乐观锁核对/删除行历史对账/署名版导出事务核对
src/glossary.js      译审术语表：整表替换与乐观锁/词条校验（非空/同语言源词唯一）/源词精确匹配核对/缺失查询与导出/交付/署名导出的术语闸门
src/translation-recovery.js 重排后历史译文找回：缺译行候选视图（同导入代次+词区间+源文三要素匹配依据）/组级恢复请求解析与事务内重核（目标仍缺译/候选失效/现行字数字速，整组原子）
src/comment.js       逐词区间复核意见：请求解析/相交字幕计算与关闭快照/字幕变更对账（closed→review、旧代次→history）/列表视图（词段+相交字幕）
src/vtt.js           WebVTT 序列化（普通正文与署名版 <v 显示名> 说话人标签）+ 严格解析（时间戳/cue/时间轴校验）与按时间区段的字幕文本差异（区段切分+相邻合并）
src/routes.js        Express API
public/              前端（原生 HTML/CSS/JS 单页，含字幕修订、逐词修正、多语言译文、说话人标注与逐词区间复核意见面板）
examples/sample.json 示例转写与切点
examples/revisions-api.sh 批量字幕修订提议的完整 curl 调用示例
examples/word-revisions-api.sh 逐词时间修正（提交→预览→确认）的完整 curl 调用示例
examples/translations-api.sh 多语言译文字幕（保存→查询→失效/复核→确认→按语言导出）的完整 curl 调用示例
examples/translation-batches-api.sh 译者整批译文回填（整批写入→幂等/冲突→过期/违规→覆盖待复核→下游读取）的完整 curl 调用示例
examples/deliveries-api.sh 片方多语交付批次（核对→整批冻结→清单查询→既有接口下载）的完整 curl 调用示例
examples/delivery-diff-api.sh 片方审阅两批交付差异（两批交付含语言增减→区段对照→同批空差异→参数/不存在/跨项目拒绝）的完整 curl 调用示例（只读）
examples/speakers-api.sh 说话人标注与署名版导出（名册→归属→重排身份保持→原文/译文署名快照→兼容普通导出）的完整 curl 调用示例
examples/glossaries-api.sh 译审术语对照表（建表/乐观锁→缺失查询→单语言导出/多语交付/译文署名导出三类闸门→旧快照兼容）的完整 curl 调用示例
examples/translation-recovery-api.sh 重排后历史译文找回（候选查看与匹配依据→非法/漂移/错配拒绝→组级恢复→重新导入后旧历史不可恢复）的完整 curl 调用示例
examples/comments-api.sh 逐词区间复核意见（创建→关闭快照→漂移待复核→重开/再关闭→重排锚定→重新导入历史）的完整 curl 调用示例
test/                node:test 单元 + API 集成测试（revision / word-revision / translation / translation-batch / translation-recovery / delivery / delivery-diff / speaker / glossary / comment 覆盖十类流程）
Dockerfile / docker-compose.yml
```
