#!/usr/bin/env bash
# 译者整批译文回填完整调用示例（一种目标语言整批写入当前字幕）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/translation-batches-api.sh [BASE_URL]
# 例如：bash examples/translation-batches-api.sh http://localhost:3000
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

echo "=== 0. 新建项目并排版（准备源字幕） ==="
WORDS='{"name":"整批回填 API 示例","words":[
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
echo "源字幕 id=$SID1 / $SID2，字幕集版本 sub_version=$SUBV，规则版本 rules_version=1"

echo
echo "=== 1. 整批回填英语（批次 B-EN-001；新建 version=0）→ 201 ==="
out="$(req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"B-EN-001\",
  \"sub_version\":$SUBV,
  \"rules_version\":1,
  \"items\":[
    {\"subtitle_id\":$SID1,\"cue_version\":1,\"version\":0,\"text\":\"Hello world\"},
    {\"subtitle_id\":$SID2,\"cue_version\":1,\"version\":0,\"text\":\"Welcome\"}
  ]}")"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -m json.tool --no-ensure-ascii

echo
echo "=== 2. 幂等：同编号同内容再提交 → 200 replayed=true，返回首次结果不再写入 ==="
out="$(req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"B-EN-001\",
  \"sub_version\":$SUBV,
  \"rules_version\":1,
  \"items\":[
    {\"subtitle_id\":$SID1,\"cue_version\":1,\"version\":0,\"text\":\"Hello world\"},
    {\"subtitle_id\":$SID2,\"cue_version\":1,\"version\":0,\"text\":\"Welcome\"}
  ]}")"
echo "HTTP $(echo "$out" | code_of) replayed=$(echo "$out" | body_of | jget replayed)"

echo
echo "=== 3. 冲突：同编号不同内容 → 409，失败批次不占编号 ==="
req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"B-EN-001\",
  \"sub_version\":$SUBV,
  \"rules_version\":1,
  \"items\":[
    {\"subtitle_id\":$SID1,\"cue_version\":1,\"version\":0,\"text\":\"Different text\"},
    {\"subtitle_id\":$SID2,\"cue_version\":1,\"version\":0,\"text\":\"Welcome\"}
  ]}" | body_of | python3 -m json.tool --no-ensure-ascii

echo
echo "=== 4. 非法请求 → 400（空清单 / 同批重复 ID / 字幕不存在 / 非法语言） ==="
echo "空清单："
req POST "/api/projects/$PID/translations/en/batches" \
  "{\"batch_no\":\"BAD\",\"sub_version\":$SUBV,\"rules_version\":1,\"items\":[]}" | body_of
echo "同批重复字幕 ID："
req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"BAD\",\"sub_version\":$SUBV,\"rules_version\":1,
  \"items\":[
    {\"subtitle_id\":$SID1,\"cue_version\":1,\"version\":0,\"text\":\"A\"},
    {\"subtitle_id\":$SID1,\"cue_version\":1,\"version\":0,\"text\":\"B\"}
  ]}" | body_of
echo "字幕不存在："
req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"BAD\",\"sub_version\":$SUBV,\"rules_version\":1,
  \"items\":[{\"subtitle_id\":99999,\"cue_version\":1,\"version\":0,\"text\":\"Ghost\"}]}" | body_of
echo "非法语言代号："
req POST "/api/projects/$PID/translations/zh%20CN/batches" "{
  \"batch_no\":\"BAD\",\"sub_version\":$SUBV,\"rules_version\":1,
  \"items\":[{\"subtitle_id\":$SID1,\"cue_version\":1,\"version\":0,\"text\":\"你好\"}]}" | body_of

echo
echo "=== 5. 过期/违规 → 409/422 按行返回当前值与原因，整批不写入 ==="
echo "字幕集版本漂移："
req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"B-EN-002\",\"sub_version\":999,\"rules_version\":1,
  \"items\":[{\"subtitle_id\":$SID1,\"cue_version\":1,\"version\":1,\"text\":\"Hi world\"}]}" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  ", d["error"])'
echo "源行版本过期 + 已存在却按新建（version=0）："
req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"B-EN-002\",\"sub_version\":$SUBV,\"rules_version\":1,
  \"items\":[{\"subtitle_id\":$SID1,\"cue_version\":99,\"version\":0,\"text\":\"Hi world\"}]}" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
for it in d["items"]: print("  字幕", it["subtitle_id"], it["state"], it["reasons"])'
echo "译文超字数（31 字 > max_chars 30）→ 422："
req POST "/api/projects/$PID/translations/en/batches" "$(python3 -c "
import json
print(json.dumps({'batch_no':'B-EN-002','sub_version':$SUBV,'rules_version':1,
  'items':[{'subtitle_id':$SID1,'cue_version':1,'version':1,'text':'x'*31}]}))")" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
for it in d["items"]: print("  字幕", it["subtitle_id"], it["state"], it["reasons"])'

echo
echo "=== 6. 整批更新（覆盖含待复核；版本递增、源快照刷新为 current） ==="
# 改源行文本，使英语译文转待复核；回填直接覆盖
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好呀世界"}' >/dev/null
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
state="$(req GET "/api/projects/$PID/translations/en" | body_of | jget entries.0.state)"
echo "源行变更后第一行译文状态=$state（review，可被整批覆盖）"
out="$(req POST "/api/projects/$PID/translations/en/batches" "{
  \"batch_no\":\"B-EN-002\",
  \"sub_version\":$SUBV,
  \"rules_version\":1,
  \"items\":[
    {\"subtitle_id\":$SID1,\"cue_version\":2,\"version\":1,\"text\":\"Hello there world\"},
    {\"subtitle_id\":$SID2,\"cue_version\":1,\"version\":1,\"text\":\"Welcome!\"}
  ]}")"
echo "HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
for it in d["items"]: print("  字幕", it["subtitle_id"], it["action"], "-> v"+str(it["version"]), repr(it["text"]))'
req GET "/api/projects/$PID/translations/en" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  当前状态:", [e["state"] for e in d["entries"]])'

echo
echo "=== 7. 回填结果继续被逐行查询/单语言导出/多语交付读取 ==="
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "英语单语言导出 HTTP $(echo "$out" | code_of)（快照含回填译文）："
echo "$out" | body_of | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])'

# 法语用相同批次编号（编号按语言独立）整批回填后做多语交付
req POST "/api/projects/$PID/translations/fr/batches" "{
  \"batch_no\":\"B-EN-001\",\"sub_version\":$SUBV,\"rules_version\":1,
  \"items\":[
    {\"subtitle_id\":$SID1,\"cue_version\":2,\"version\":0,\"text\":\"Bonjour le monde\"},
    {\"subtitle_id\":$SID2,\"cue_version\":1,\"version\":0,\"text\":\"Bienvenue\"}
  ]}" >/dev/null
out="$(req POST "/api/projects/$PID/deliveries" "{
  \"note\":\"整批回填后的多语交付\",
  \"sub_version\":$SUBV,\"rules_version\":1,
  \"languages\":[\"en\",\"fr\"],
  \"translations\":{
    \"en\":[{\"subtitle_id\":$SID1,\"version\":2},{\"subtitle_id\":$SID2,\"version\":2}],
    \"fr\":[{\"subtitle_id\":$SID1,\"version\":1},{\"subtitle_id\":$SID2,\"version\":1}]
  }}")"
echo "多语交付 HTTP $(echo "$out" | code_of)，文件数：$(echo "$out" | body_of | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["files"]))')"

echo
echo "=== 8. 批次清单 / 单个批次 ==="
echo "英语回填批次："
req GET "/api/projects/$PID/translations/en/batches/list" | body_of | python3 -m json.tool --no-ensure-ascii
TBID="$(req GET "/api/projects/$PID/translation-batches" | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["batches"][0]["id"])')"
echo "单个批次 id=$TBID："
req GET "/api/projects/$PID/translation-batches/$TBID" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("  编号:", d["batch_no"], d["lang"], "新建", d["created_count"], "更新", d["updated_count"])
for it in d["items"]: print("   ", it)'

echo
echo "完成。旧导出快照内容不随后续回填改变（不可变）。"
