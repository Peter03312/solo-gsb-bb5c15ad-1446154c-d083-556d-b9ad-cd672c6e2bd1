#!/usr/bin/env bash
# 重排后历史译文找回完整调用示例（候选查看 → 组级恢复 → 各类拒绝 → 重新导入不可恢复）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/translation-recovery-api.sh [BASE_URL]
# 例如：bash examples/translation-recovery-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
# 显式 HTTP POST（避免与系统 ImageMagick 的 import 命令同名时的 shell 歧义）
http_post() {
  local path="$1"; local body="$2"
  curl -s -w '\n%{http_code}' -X POST "$BASE$path" \
    -H 'Content-Type: application/json' -d "$body"
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并以细分规则排版（每条词一行，4 行） ==="
# 紧凑时间轴：单词行约 0.9s；max_chars=2 保证逐词分段。
WORDS='{"name":"历史找回 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":900},
  {"text":"世界","start_ms":950,"end_ms":1400},
  {"text":"欢迎","start_ms":1600,"end_ms":2400},
  {"text":"光临","start_ms":2450,"end_ms":3300}
],"cuts":[1500],"rules":{"max_chars":2,"min_duration_ms":200,"max_cps":5}}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID（导入代次 import_version=1）"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID_F1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID_F2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "细分源字幕：$SID_F1（词0）/ $SID_F2（词1）……"

echo
echo "=== 1. 给前两行保存英语译文 ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID_F1" \
  '{"text":"AB","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID_F2" \
  '{"text":"CD","cue_version":1}' >/dev/null
echo "已保存 AB / CD（均为 current v1，src_import_id=1）"

echo
echo "=== 2. 放宽规则重排：细分行被合并删除 → 译文留历史（同导入代次） ==="
req PUT "/api/projects/$PID/rules" \
  '{"version":1,"max_chars":40,"min_duration_ms":200,"max_cps":40}' >/dev/null
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":1}')"
echo "合并后行数：$(echo "$out" | body_of | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["subtitles"]))')（译文随删除行留 history）"

echo
echo "=== 3. 再次收紧重排：重新出现同词区间、同源文的缺译行（新 ID） ==="
req PUT "/api/projects/$PID/rules" \
  '{"version":2,"max_chars":2,"min_duration_ms":200,"max_cps":5}' >/dev/null
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":2}')"
SID_N1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID_N2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "重新细分：$SID_N1（词0）/ $SID_N2（词1），均为缺译"

echo
echo "=== 4. 候选查询：列出缺译行的历史候选与匹配依据（只读） ==="
out="$(req GET "/api/projects/$PID/translations/en/recovery-candidates")"
echo "当前 sub_version=$(echo "$out" | body_of | jget sub_version) \
rules_version=$(echo "$out" | body_of | jget rules_version) \
import_version=$(echo "$out" | body_of | jget import_version)"
echo "有可恢复候选的缺译行数：$(echo "$out" | body_of | jget recoverable_target_count)"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
for t in d["targets"][:2]:
    c=t["cue"]
    print("  缺译行 #%s 词%s-%s 「%s」:" % (c["id"], c["word_start"], c["word_end"], c["text"]))
    for x in t["candidates"]:
        h=x["translation"]; m=x["matches"]
        print("    候选 #%s v%s 「%s」 recoverable=%s 同导入=%s 同词区间=%s 同源文=%s" % (
            h["id"], h["version"], h["text"], x["recoverable"],
            m["same_import"], m["same_word_span"], m["same_text"]))
        for r in x["reasons"]:
            print("      · " + r)
'

# 从候选 JSON 中提取某缺译行上某条可恢复候选的 (id, version)。
# 参数经环境变量传入，避免在子 shell 里嵌套引号（曾被误解析成系统 import 命令）。
pick_candidate() {
  local sid="$1"; local text="$2"
  CAND_SID="$sid" CAND_TEXT="$text" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
sid=int(os.environ["CAND_SID"]); want=os.environ["CAND_TEXT"]
t=[x for x in d["targets"] if x["cue"]["id"]==sid][0]
ch=[c for c in t["candidates"] if c["recoverable"] and c["translation"]["text"]==want][0]
sys.stdout.write("%s %s" % (ch["translation"]["id"], ch["translation"]["version"]))
'
}
# shellcheck disable=SC2046
set -- $(echo "$out" | body_of | pick_candidate "$SID_N1" AB); T1="$1"; V1="$2"
# shellcheck disable=SC2046
set -- $(echo "$out" | body_of | pick_candidate "$SID_N2" CD); T2="$1"; V2="$2"

echo
echo "=== 5. 形状非法 / 版本漂移 / 候选失效 均被拒绝（整组不写） ==="
out="$(req POST "/api/projects/$PID/translations/en/recover" '{"sub_version":3,"rules_version":3,"items":[]}')"
echo "空 items → HTTP $(echo "$out" | code_of)"

out="$(req POST "/api/projects/$PID/translations/en/recover" \
  "{\"sub_version\":2,\"rules_version\":3,\"items\":[
    {\"subtitle_id\":$SID_N1,\"cue_version\":1,\"translation_id\":$T1,\"version\":$V1}]}")"
echo "sub_version 过期 → HTTP $(echo "$out" | code_of)（$(echo "$out" | body_of | jget error)）"

# 给第二行错选第一行的候选（词区间不一致）→ 409 candidate_mismatch
out="$(req POST "/api/projects/$PID/translations/en/recover" \
  "{\"sub_version\":3,\"rules_version\":3,\"items\":[
    {\"subtitle_id\":$SID_N2,\"cue_version\":1,\"translation_id\":$T1,\"version\":$V1}]}")"
echo "词区间不匹配 → HTTP $(echo "$out" | code_of) state=$(echo "$out" | body_of | jget items.0.state)"

# 候选译文不存在 → 400
out="$(req POST "/api/projects/$PID/translations/en/recover" \
  "{\"sub_version\":3,\"rules_version\":3,\"items\":[
    {\"subtitle_id\":$SID_N1,\"cue_version\":1,\"translation_id\":999999,\"version\":1}]}")"
echo "候选不存在 → HTTP $(echo "$out" | code_of) state=$(echo "$out" | body_of | jget items.0.state)"

echo
echo "=== 6. 成功组级恢复（一次选择两行） → 201，写成普通 current 译文 ==="
out="$(req POST "/api/projects/$PID/translations/en/recover" \
  "{\"sub_version\":3,\"rules_version\":3,\"items\":[
    {\"subtitle_id\":$SID_N1,\"cue_version\":1,\"translation_id\":$T1,\"version\":$V1},
    {\"subtitle_id\":$SID_N2,\"cue_version\":1,\"translation_id\":$T2,\"version\":$V2}]}")"
echo "HTTP $(echo "$out" | code_of)，restored_count=$(echo "$out" | body_of | jget restored_count)"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
for it in d["items"]:
    print("  字幕 #%s ← 新译文 #%s v%s 「%s」（来自历史 #%s）" % (
        it["subtitle_id"], it["translation_id"], it["version"],
        it["text"], it["restored_from"]))
'

echo
echo "=== 7. 恢复后即普通译文：并列视图 current；原历史行仍保留；sub_version 未推进 ==="
out="$(req GET "/api/projects/$PID/translations/en")"
echo "current=$(echo "$out" | body_of | jget counts.current) / \
history=$(echo "$out" | body_of | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["history"]))')"
proj="$(req GET "/api/projects/$PID")"
echo "项目 sub_version 仍为 $(echo "$proj" | body_of | jget sub_version)（恢复只写译文，不推进字幕集）"

echo
echo "=== 8. 重复恢复同一行 → 409 not_missing（目标已不缺译，历史不会覆盖现有译文） ==="
out="$(req POST "/api/projects/$PID/translations/en/recover" \
  "{\"sub_version\":3,\"rules_version\":3,\"items\":[
    {\"subtitle_id\":$SID_N1,\"cue_version\":1,\"translation_id\":$T1,\"version\":$V1}]}")"
echo "HTTP $(echo "$out" | code_of) state=$(echo "$out" | body_of | jget items.0.state)"

echo
echo "=== 9. 重新导入后：导入代次 +1，旧历史可见但不可恢复 ==="
# 重新导入需要 force（项目已有字幕）；用与建项完全相同的词与切点
out="$(http_post "/api/projects/$PID/import" \
  '{"force":true,"words":[
    {"text":"你好","start_ms":0,"end_ms":900},
    {"text":"世界","start_ms":950,"end_ms":1400},
    {"text":"欢迎","start_ms":1600,"end_ms":2400},
    {"text":"光临","start_ms":2450,"end_ms":3300}],
    "cuts":[1500]}')"
echo "HTTP $(echo "$out" | code_of)；重新导入后 import_version=$(echo "$out" | body_of | jget import_version)"
SV="$(echo "$out" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SV}")"
SID_R1="$(echo "$out" | body_of | jget subtitles.0.id)"
out="$(req GET "/api/projects/$PID/translations/en/recovery-candidates")"
echo "可恢复缺译行数：$(echo "$out" | body_of | jget recoverable_target_count)（旧代次历史不可恢复）"
# shellcheck disable=SC2046
set -- $(CAND_SID="$SID_R1" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
sid=int(os.environ["CAND_SID"])
t=[x for x in d["targets"] if x["cue"]["id"]==sid][0]
h=t["candidates"][0]["translation"]
sys.stdout.write("%s %s" % (h["id"], h["version"]))
' <<<"$(echo "$out" | body_of)")
OLD="$1"; OLDV="$2"
out="$(req POST "/api/projects/$PID/translations/en/recover" \
  "{\"sub_version\":$SV,\"rules_version\":3,\"items\":[
    {\"subtitle_id\":$SID_R1,\"cue_version\":1,\"translation_id\":$OLD,\"version\":$OLDV}]}")"
echo "强行恢复旧代次历史 → HTTP $(echo "$out" | code_of) \
state=$(echo "$out" | body_of | jget items.0.state)"

echo
echo "完成。历史记录与旧导出快照全程未被修改；恢复出的译文可直接用"
echo "PUT /api/projects/$PID/translations/en/subtitles/<sid> 继续编辑，或走单语言/交付导出。"
