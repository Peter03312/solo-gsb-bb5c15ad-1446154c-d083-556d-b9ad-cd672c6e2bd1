#!/usr/bin/env bash
# 说话人标注与署名版导出完整调用示例：
#   名册（编号/显示名）→ 单行/批量归属（乐观锁、锁定行）→ 重排身份保持
#   → 署名版原文导出 → 改名推进归属版本 → 署名版译文导出（逐行译文版本）→ 快照查询下载。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/speakers-api.sh [BASE_URL]
# 例如：bash examples/speakers-api.sh http://localhost:3000
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
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（准备源字幕，2 行） ==="
WORDS='{"name":"说话人标注 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
SUBV="$(echo "$out" | body_of | jget sub_version)"
echo "字幕 id=$SID1 / $SID2，sub_version=$SUBV"

echo
echo "=== 1. 说话人名册：建立编号 1=茶客甲、编号 2=掌柜乙 ==="
req POST "/api/projects/$PID/speakers" '{"display_name":"茶客甲"}' | body_of
req POST "/api/projects/$PID/speakers" '{"display_name":"掌柜乙"}' | body_of
echo "--- 非法显示名（含换行 / 尖括号）→ 400，不创建 ---"
req POST "/api/projects/$PID/speakers" '{"display_name":"带\n换行"}' | body_of

echo
echo "=== 2. 单行归属：第 1 行→甲（携带 cue_version=1, attribution_version=0） ==="
out="$(req PUT "/api/projects/$PID/attributions/subtitles/$SID1" \
  "{\"attribution_version\":0,\"cue_version\":1,\"speaker_number\":1}")"
echo "$out" | body_of
ATTRV="$(echo "$out" | body_of | jget attribution_version)"
echo "归属版本推进到 attribution_version=$ATTRV"

echo
echo "=== 3. 批量归属：第 1 行→乙(覆盖)、第 2 行→甲，携带当前归属版本 ==="
out="$(req POST "/api/projects/$PID/attributions/batch" "{
  \"attribution_version\":$ATTRV,
  \"items\":[
    {\"subtitle_id\":$SID1,\"cue_version\":1,\"speaker_number\":2},
    {\"subtitle_id\":$SID2,\"cue_version\":1,\"speaker_number\":1}
  ]}")"
echo "$out" | body_of
ATTRV="$(echo "$out" | body_of | jget attribution_version)"
echo "归属并列查询："
req GET "/api/projects/$PID/attributions" | body_of

echo
echo "=== 4. 过期示例：用旧归属版本再标注 → 409 返回当前值 ==="
req PUT "/api/projects/$PID/attributions/subtitles/$SID2" \
  '{"attribution_version":0,"cue_version":1,"speaker_number":2}' | body_of
echo "--- 编号不存在 → 400 ---"
req PUT "/api/projects/$PID/attributions/subtitles/$SID2" \
  "{\"attribution_version\":$ATTRV,\"cue_version\":1,\"speaker_number\":99}" | body_of

echo
echo "=== 5. 锁定行也可标注：锁定第 2 行后仍归属给乙 ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID2" '{"version":1,"locked":true}')"
LOCKED_CUE_V="$(echo "$out" | body_of | jget subtitle.version)"
out="$(req PUT "/api/projects/$PID/attributions/subtitles/$SID2" \
  "{\"attribution_version\":$ATTRV,\"cue_version\":$LOCKED_CUE_V,\"speaker_number\":2}")"
echo "$out" | body_of
ATTRV="$(echo "$out" | body_of | jget attribution_version)"
# 锁定是一次字幕集变更：重新读取当前 sub_version
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"

echo
echo "=== 6. 署名版原文导出（携带 sub_version 与 attribution_version） ==="
out="$(req POST "/api/projects/$PID/attributed-exports" \
  "{\"sub_version\":$SUBV,\"attribution_version\":$ATTRV}")"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])'

echo
echo "=== 7. 改显示名推进归属版本：编号 2 掌柜乙 → 掌柜 ==="
out="$(req PATCH "/api/projects/$PID/speakers/2" \
  "{\"attribution_version\":$ATTRV,\"display_name\":\"掌柜\"}")"
echo "$out" | body_of
ATTRV="$(echo "$out" | body_of | jget attribution_version)"
echo "旧快照不随改名变化（仍是“掌柜乙”），新快照才用“掌柜”。"

echo
echo "=== 8. 署名版译文导出：先保存英语译文，再携带逐行译文版本 ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello world","cue_version":1}' | body_of
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" \
  "{\"text\":\"Welcome\",\"cue_version\":$LOCKED_CUE_V}" | body_of
out="$(req POST "/api/projects/$PID/attributed-exports" "{
  \"sub_version\":$SUBV,
  \"attribution_version\":$ATTRV,
  \"lang\":\"en\",
  \"translations\":[
    {\"subtitle_id\":$SID1,\"version\":1},
    {\"subtitle_id\":$SID2,\"version\":1}
  ]}")"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])'
echo "--- 译文版本漂移（第二行传 version=9）→ 422 按行列原因，不生成快照 ---"
req POST "/api/projects/$PID/attributed-exports" "{
  \"sub_version\":$SUBV,
  \"attribution_version\":$ATTRV,
  \"lang\":\"en\",
  \"translations\":[
    {\"subtitle_id\":$SID1,\"version\":1},
    {\"subtitle_id\":$SID2,\"version\":9}
  ]}" | body_of

echo
echo "=== 9. 快照清单查询与下载（原文/译文同一连续序列，不可变） ==="
req GET "/api/projects/$PID/attributed-exports" | body_of
echo "--- 下载 v1（旧名“掌柜乙”，不随后续改名变化）---"
curl -s "$BASE/api/projects/$PID/attributed-exports/1"

echo
echo "=== 10. 普通导出保持兼容（不含说话人标签），与署名序列互不影响 ==="
req POST "/api/projects/$PID/exports" "{\"sub_version\":$SUBV}" \
  | body_of | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])'

echo
echo "完成。"
