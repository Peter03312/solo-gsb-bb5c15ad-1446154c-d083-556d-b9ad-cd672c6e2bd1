#!/usr/bin/env bash
# 译审术语对照表完整调用示例：
#   建表（乐观锁）→ 非法/过期示例 → 保存译文（缺术语不拦截）→ 缺失查询
#   → 单语言导出闸门 → 术语变更不改旧快照/状态 → 多语同版交付闸门 → 译文署名导出闸门。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/glossaries-api.sh [BASE_URL]
# 例如：bash examples/glossaries-api.sh http://localhost:3000
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

echo "=== 0. 新建项目并排版（2 行：你好世界 / 欢迎光临） ==="
WORDS='{"name":"术语 API 示例","words":[
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
echo "源字幕 id=$SID1（你好世界）/ $SID2（欢迎光临）"

echo
echo "=== 1. 未配置语言读取术语表 → configured=false, version=0 ==="
req GET "/api/projects/$PID/glossaries/en" | body_of

echo
echo "=== 2. 建立英语术语表（version=0 → 1；你好→Hello，世界→world） ==="
out="$(req PUT "/api/projects/$PID/glossaries/en" \
  '{"version":0,"terms":[{"source":"你好","target":"Hello"},{"source":"世界","target":"world"}]}')"
echo "HTTP $(echo "$out" | code_of)，术语版本 v$(echo "$out" | body_of | jget version)，词条 $(echo "$out" | body_of | jget term_count) 条"

echo
echo "=== 3. 非法/过期示例（不修改术语表） ==="
echo "--- 空译法 / 同语言源词重复 → 400 ---"
req PUT "/api/projects/$PID/glossaries/en" '{"version":1,"terms":[{"source":"你好","target":"  "}]}' | body_of
req PUT "/api/projects/$PID/glossaries/en" '{"version":1,"terms":[{"source":"你好","target":"A"},{"source":"你好","target":"B"}]}' | body_of
echo "--- 已配置仍按新建 version=0 → 409，current 为当前表 ---"
req PUT "/api/projects/$PID/glossaries/en" '{"version":0,"terms":[]}' | body_of

echo
echo "=== 4. 保存译文：缺规定译法仍可保存（供后续修正），响应附 term_issues ==="
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hi earth","cue_version":1}')"
echo "保存 HTTP $(echo "$out" | code_of)（201，状态 current，术语版本 v$(echo "$out" | body_of | jget glossary_version)），缺失："
echo "$out" | body_of | python3 -c 'import json,sys; [print(" -", m["reason"]) for m in json.load(sys.stdin)["term_issues"]]'
out="$(req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}')"
echo "第 2 行保存 HTTP $(echo "$out" | code_of)，term_issues=$(echo "$out" | body_of | jget term_issues)"

echo
echo "=== 5. 术语缺失查询（按语言/字幕 ID/源词列出） ==="
req GET "/api/projects/$PID/glossaries/en/missing" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("glossary_version =", d["glossary_version"])
for row in d["missing"]:
    for m in row["missing"]:
        print("  字幕 %(sid)s 源词 %(src)s → 缺规定译法 %(tgt)s" % {"sid": row["subtitle_id"], "src": m["source"], "tgt": m["target"]})'

echo
echo "=== 6. 单语言导出：术语缺失 → 422 逐行报错，不生成快照 ==="
req POST "/api/projects/$PID/translations/en/exports" '{}' | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(d["error"])
for row in d.get("term_missing", []):
    for m in row["missing"]: print(" -", m["reason"])'

echo "--- 修正译文（包含 Hello 与 world，顺序不限）后导出成功 ---"
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello world","cue_version":1,"version":1}' >/dev/null
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "导出 HTTP $(echo "$out" | code_of)，快照 v$(echo "$out" | body_of | jget version)，术语版本 v$(echo "$out" | body_of | jget glossary_version)"

echo
echo "=== 7. 收紧术语（新增 世界→Earth）：既有译文仍 current，但新导出被拦；旧快照不变 ==="
req PUT "/api/projects/$PID/glossaries/en" \
  '{"version":1,"terms":[{"source":"你好","target":"Hello"},{"source":"世界","target":"Earth"}]}' >/dev/null
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
e=d["entries"][0]
print("既有译文状态:", e["state"], "（术语变更不改变 current/review），当前术语版本 v%d" % d["glossary"]["version"])'
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "再导出 HTTP $(echo "$out" | code_of)：$(echo "$out" | body_of | jget term_missing.0.missing.0.reason)"
echo "旧快照 v1 仍可下载："
req GET "/api/projects/$PID/translations/en/exports/1" | body_of | grep -E 'Hello world|WEBVTT' | head -2
# 恢复合规译文（world 与 Earth 都包含即可）
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello world (Earth)","cue_version":1,"version":2}' >/dev/null

echo
echo "=== 8. 多语同版交付：法语术语缺失 → 整批 422 不生成任何快照；修正后成功 ==="
req PUT "/api/projects/$PID/glossaries/fr" \
  '{"version":0,"terms":[{"source":"你好","target":"Bonjour"}]}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" \
  '{"text":"Salut le monde","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" \
  '{"text":"Bienvenue","cue_version":1}' >/dev/null
DELIVERY='{"sub_version":1,"rules_version":1,"languages":["en","fr"],
  "translations":{
    "en":[{"subtitle_id":'$SID1',"version":3},{"subtitle_id":'$SID2',"version":1}],
    "fr":[{"subtitle_id":'$SID1',"version":1},{"subtitle_id":'$SID2',"version":1}]}}'
out="$(req POST "/api/projects/$PID/deliveries" "$DELIVERY")"
echo "首次交付 HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
for l in d.get("languages", []):
    for row in l.get("term_missing", []):
        for m in row["missing"]:
            print("  语言 %(lang)s 字幕 %(sid)s：%(reason)s" % {"lang": l["lang"], "sid": row["subtitle_id"], "reason": m["reason"]})'
echo "--- 修正法语后重交（fr 第 1 行译文版本变为 2）---"
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" \
  '{"text":"Bonjour le monde","cue_version":1,"version":1}' >/dev/null
DELIVERY='{"sub_version":1,"rules_version":1,"languages":["en","fr"],
  "translations":{
    "en":[{"subtitle_id":'$SID1',"version":3},{"subtitle_id":'$SID2',"version":1}],
    "fr":[{"subtitle_id":'$SID1',"version":2},{"subtitle_id":'$SID2',"version":1}]}}'
out="$(req POST "/api/projects/$PID/deliveries" "$DELIVERY")"
echo "交付 HTTP $(echo "$out" | code_of)，批次 #$(echo "$out" | body_of | jget id)，文件 $(echo "$out" | body_of | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["files"]))') 个（原文+en+fr）"

echo
echo "=== 9. 译文署名版导出同样按当前术语核对（原文署名导出不核对术语） ==="
req POST "/api/projects/$PID/speakers" '{"display_name":"甲"}' >/dev/null
ATTRV=0
for SID in $SID1 $SID2; do
  out="$(req PUT "/api/projects/$PID/attributions/subtitles/$SID" \
    "{\"attribution_version\":$ATTRV,\"cue_version\":1,\"speaker_number\":1}")"
  ATTRV="$(echo "$out" | body_of | jget attribution_version)"
done
# 英语再改缺一个术语（去掉 Earth；术语为子串匹配）→ 署名译文导出 422
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello globe","cue_version":1,"version":3}' >/dev/null
SIGNED='{"sub_version":1,"attribution_version":'$ATTRV',"lang":"en",
  "translations":[{"subtitle_id":'$SID1',"version":4},{"subtitle_id":'$SID2',"version":1}]}'
out="$(req POST "/api/projects/$PID/attributed-exports" "$SIGNED")"
echo "译文署名导出 HTTP $(echo "$out" | code_of)：$(echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["rows"][0]["codes"], d["rows"][0]["term_missing"][0]["reason"])')"
out="$(req POST "/api/projects/$PID/attributed-exports" \
  "{\"sub_version\":1,\"attribution_version\":$ATTRV}")"
echo "原文署名导出（不核对术语）HTTP $(echo "$out" | code_of)，快照 v$(echo "$out" | body_of | jget version)"

echo
echo "=== 10. 术语表总览 ==="
req GET "/api/projects/$PID/glossaries" | body_of
echo
echo "完成。"
