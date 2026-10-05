'use strict';

/** 毫秒 -> WebVTT 时间戳 HH:MM:SS.mmm */
function formatTimestamp(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (v, n) => String(v).padStart(n, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

/**
 * 生成 WebVTT 文件内容。cues 需已按时间升序：
 * [{ start_ms, end_ms, text, speaker? }]
 *
 * speaker 缺省时输出普通正文（与旧导出完全兼容）；给出时按 WebVTT 说话人标签语法输出
 * `<v 显示名>正文</v>`。显示名须事先通过 validateSpeakerName（不含换行/<、>），
 * 否则标签语法会被破坏，调用方不得传入。
 */
function toWebVtt(cues) {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const blocks = ['WEBVTT', ''];
  sorted.forEach((c, i) => {
    const body = c.speaker ? `<v ${c.speaker}>${c.text}</v>` : c.text;
    blocks.push(
      String(i + 1),
      `${formatTimestamp(c.start_ms)} --> ${formatTimestamp(c.end_ms)}`,
      body,
      ''
    );
  });
  return blocks.join('\n');
}

/**
 * 解析 WebVTT 时间戳为毫秒。支持 HH:MM:SS.mmm / MM:SS.mmm / SS.mmm（秒表至少 2 位）。
 * 非法输入返回 null。小时无上限，但分钟/秒必须在 [0,59]。
 */
function parseTimestamp(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/.exec(raw.trim());
  if (!m) return null;
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (mm > 59 || ss > 59) return null;
  const h = m[1] !== undefined ? Number(m[1]) : 0;
  return h * 3600000 + mm * 60000 + ss * 1000 + Number(m[4]);
}

const TIMING_RE = /^(.+?)\s+-->\s+(.+?)(?:\s+(.*))?$/;

/**
 * 严格解析一份冻结的 WebVTT 快照，只取比较所需信息：
 *   [{ start_ms, end_ms, text }]，text 为字幕实际显示文本（cue 载荷，空载荷记为 ''）。
 *
 * 设计取舍（比较必须以“实际显示文本”为准）：
 *   - 必须以 WEBVTT 签名开头（允许 UTF-8 BOM 与签名行尾部附加说明文字）；
 *   - 忽略 NOTE（含 NOTE:）、STYLE、REGION 块（不显示）；
 *   - cue 可带可选序号行与时间行设置（settings 不参与文本比较）；
 *   - cue 载荷按原样保留（含空白与空行结构），仅统一 CRLF/CR -> LF；
 *     空载荷是合法字幕（空白字幕与普通字幕之间的转换不得漏报）；
 *   - 本系统导出的快照时间轴非重叠、按时间升序、零时长无意义；
 *     重叠/逆序/零时长/时间戳非法均判为格式损坏。
 *
 * 返回 { ok: true, cues } 或 { ok: false, reason }（reason 为中文说明）。
 */
function parseWebVtt(content) {
  if (typeof content !== 'string') {
    return { ok: false, reason: '快照内容不是文本' };
  }
  // 统一换行，去掉 UTF-8 BOM
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rawLines = normalized.split('\n');

  if (rawLines.length === 0 || !/^WEBVTT([ \t].*)?$/.test(rawLines[0])) {
    return { ok: false, reason: '缺少 WEBVTT 签名行（必须以 "WEBVTT" 开头）' };
  }

  const cues = [];
  // 按空行切块；签名行之后开始
  let block = [];
  const blocks = [];
  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim() === '') {
      if (block.length) { blocks.push(block); block = []; }
    } else {
      block.push(line);
    }
  }
  if (block.length) blocks.push(block);

  for (const lines of blocks) {
    // NOTE / STYLE / REGION 块整块跳过（STYLE/REGION 内容允许含 -->，故先按首行剔除）
    const head = lines[0];
    if (/^NOTE([ \t:]|$)/.test(head) || /^STYLE([ \t]|$)/.test(head) || /^REGION([ \t]|$)/.test(head)) {
      continue;
    }
    let timingIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TIMING_RE.test(lines[i])) { timingIdx = i; break; }
    }
    if (timingIdx === -1) {
      return {
        ok: false,
        reason: `存在不含时间行的 cue 块（首行：${JSON.stringify(head.slice(0, 40))}）`,
      };
    }
    // 时间行之前只允许一行可选 cue 序号
    if (timingIdx > 1) {
      return { ok: false, reason: 'cue 时间行之前存在无法识别的行（只允许一行可选序号）' };
    }
    const tm = TIMING_RE.exec(lines[timingIdx]);
    const start = parseTimestamp(tm[1]);
    const end = parseTimestamp(tm[2]);
    if (start === null) {
      return { ok: false, reason: `时间行起始时间戳非法：${JSON.stringify(tm[1].trim())}` };
    }
    if (end === null) {
      return { ok: false, reason: `时间行结束时间戳非法：${JSON.stringify(tm[2].trim())}` };
    }
    if (end <= start) {
      return { ok: false, reason: `时间行结束时间必须晚于开始时间（${formatTimestamp(start)} --> ${formatTimestamp(end)}）` };
    }
    // 载荷原样保留（仅已统一换行）；空载荷即空白字幕
    const text = lines.slice(timingIdx + 1).join('\n');
    cues.push({ start_ms: start, end_ms: end, text });
  }

  // 时间轴完整性：升序且不重叠（相等端点首尾相接是允许的）
  for (let i = 1; i < cues.length; i++) {
    const prev = cues[i - 1];
    const cur = cues[i];
    if (cur.start_ms < prev.start_ms) {
      return { ok: false, reason: `cue 未按开始时间升序（${formatTimestamp(cur.start_ms)} 出现在 ${formatTimestamp(prev.start_ms)} 之后）` };
    }
    if (cur.start_ms < prev.end_ms) {
      return {
        ok: false,
        reason: `cue 时间区间重叠（${formatTimestamp(prev.start_ms)} --> ${formatTimestamp(prev.end_ms)} 与 ${formatTimestamp(cur.start_ms)} --> ${formatTimestamp(cur.end_ms)}）`,
      };
    }
  }

  return { ok: true, cues };
}

/**
 * 按字幕起止时间构成的区段比较两侧“实际显示文本”。
 *
 * a / b 为 parseWebVtt 得到的 cues（升序、非重叠）。把两侧全部起止时间戳合并切分为
 * 极小区段，逐段比较该时刻两侧正在显示的文本；显示文本不同的区段记为差异区段。
 * 拆分/合并/整体移时通过时间区段自然对齐，绝不按行号配对；空白字幕（''）与字幕的
 * 有无转换照常产生差异。
 *
 * 相邻差异区段在“各自侧的显示文本跨边界均未变化”时合并为一条（例如一条 cue 被整体
 * 改成另一文本，即使另一侧恰在中间有切点，也只报一条）。
 *
 * 返回 [{ start_ms, end_ms, base_text, target_text }]（按时间升序）。
 */
function diffCueSegments(a, b) {
  // 收集全部边界时间点（零时长 cue 理论上已被解析器排除，这里再去重保底）
  const points = new Set();
  for (const c of [...a, ...b]) {
    points.add(c.start_ms);
    points.add(c.end_ms);
  }
  const bounds = [...points].sort((x, y) => x - y);

  // 升序非重叠序列上用推进指针找覆盖某区段的 cue（同端相接时用半开区间 [start,end)）
  const textAt = (cues, t, cursor) => {
    while (cursor.i < cues.length && cues[cursor.i].end_ms <= t) cursor.i++;
    const c = cues[cursor.i];
    return c && c.start_ms <= t && t < c.end_ms ? c.text : null;
  };

  const segs = [];
  const ca = { i: 0 };
  const cb = { i: 0 };
  for (let k = 0; k + 1 < bounds.length; k++) {
    const s = bounds[k];
    const e = bounds[k + 1];
    if (e <= s) continue;
    const ta = textAt(a, s, ca);
    const tb = textAt(b, s, cb);
    if (ta !== tb) segs.push({ start_ms: s, end_ms: e, base_text: ta, target_text: tb });
  }

  // 合并相邻差异区段：两侧各自跨边界文本均未变（含同为 null）时合并
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
  return merged;
}

module.exports = { toWebVtt, formatTimestamp, parseTimestamp, parseWebVtt, diffCueSegments };
