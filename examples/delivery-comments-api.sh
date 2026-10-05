#!/usr/bin/env bash
# 片方交付返修：冻结文件毫秒区间意见 → 后续目标批次自动核对 → 片方显式结论。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/delivery-comments-api.sh [BASE_URL]
# 例如：bash examples/delivery-comments-api.sh http://localhost:3000
#
# 流程：新建项目并交付批次一（原文+英语）→ 对英语冻结文件按毫秒区间记非空返修意见
#       （记录命中冻结文本/时间）→ 对批次一自查（未改动）→ 修改英语译文交付批次二
#       → 对批次二核对（待人工确认，列出区间差异）→ 显式判“已解决”（携带意见版本）
#       → 改交其他语言的批次三（英语未交付 → 无法核对）→ 批次级一次核对
#       → 各种拒绝：形状非法/区间越界/未交付语言/批次不存在/跨项目/版本过期/未改动项不得下结论。
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

echo "=== 0. 新建项目并排版（2 条源字幕，时间轴 0..2500ms） ==="
WORDS='{"name":"交付返修 API 示例","words":[
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
echo "源字幕 id=$SID1 / $SID2"

echo
echo "=== 1. 保存英语译文并交付批次一（原文+英语） ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
out="$(req POST "/api/projects/$PID/deliveries" "{\"note\":\"第一批\",\"sub_version\":1,\"rules_version\":1,\"languages\":[\"en\"],\"translations\":{\"en\":[{\"subtitle_id\":$SID1,\"version\":1},{\"subtitle_id\":$SID2,\"version\":1}]}}")"
B1="$(echo "$out" | body_of | jget id)"
echo "批次一 id=$B1（languages: en；既有下载地址保持不变）"

echo
echo "=== 2. 对英语冻结文件 0..1000ms 记非空返修意见 ==="
out="$(req POST "/api/projects/$PID/deliveries/$B1/delivery-comments" \
  '{"kind":"translation","lang":"en","start_ms":0,"end_ms":1000,"text":"这句语气请更自然"}')"
echo "HTTP $(echo "$out" | code_of)"
CID="$(echo "$out" | body_of | jget comment.id)"
echo "$out" | body_of | python3 -c '
import json, sys
c = json.load(sys.stdin)["comment"]
print("返修意见 id=%s v%s，锚定批次 %s 的 %s 文件 [%s..%sms]" %
      (c["id"], c["version"], c["batch_id"], c["lang"], c["start_ms"], c["end_ms"]))
for h in c["hits"]:
    print("  命中冻结文本 %r（cue %s..%sms，截取 %s..%sms）" %
          (h["text"], h["cue_start_ms"], h["cue_end_ms"], h["clip_start_ms"], h["clip_end_ms"]))
'

echo
echo "=== 3. 对批次一自查：同批区间文本与覆盖均未变 → 未改动 ==="
req GET "/api/projects/$PID/delivery-comments/$CID/check?target_id=$B1" | body_of \
  | python3 -c 'import json,sys; a=json.load(sys.stdin)["auto"]; print("结果：%s（%s）" % (a["status_text"], a["reason"]))'

echo
echo "=== 4. 修改英语译文第一条（当前编辑稿不改变旧批次），交付批次二 ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello there friend","cue_version":1,"version":1}' >/dev/null
out="$(req POST "/api/projects/$PID/deliveries" "{\"note\":\"第二批\",\"sub_version\":1,\"rules_version\":1,\"languages\":[\"en\"],\"translations\":{\"en\":[{\"subtitle_id\":$SID1,\"version\":2},{\"subtitle_id\":$SID2,\"version\":1}]}}")"
B2="$(echo "$out" | body_of | jget id)"
echo "批次二 id=$B2"

echo
echo "=== 5. 以批次二为目标核对返修意见：区间有差异 → 待人工确认（不能自动判已修复） ==="
req GET "/api/projects/$PID/delivery-comments/$CID/check?target_id=$B2" | body_of | python3 -c '
import json, sys
d = json.load(sys.stdin); a = d["auto"]
print("结果：%s（%s）" % (a["status_text"], a["reason"]))
for x in a["differences"]:
    bt = x["base_text"] if x["base_text"] is not None else "（空档）"
    tt = x["target_text"] if x["target_text"] is not None else "（空档）"
    print("  差异区段 %s..%sms：基准 %r → 目标 %r" % (x["start_ms"], x["end_ms"], bt, tt))
print("该目标批次当前结论：", d["decision"])
'

echo
echo "=== 6. 片方显式判定为“已解决”（携带意见版本 v1，结论绑定批次二） ==="
echo -n "先故意带过期版本 v99 → "
req POST "/api/projects/$PID/delivery-comments/$CID/decisions?target_id=$B2" \
  '{"version":99,"verdict":"resolved"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
out="$(req POST "/api/projects/$PID/delivery-comments/$CID/decisions?target_id=$B2" \
  '{"version":1,"verdict":"resolved"}')"
echo "$out" | body_of | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("已写入：%s；意见版本推进到 v%s（幂等重放标记 replayed=%s）" %
      (d["decision"]["verdict_text"], d["comment"]["version"], d["replayed"]))
'
echo -n "同结论再次提交（幂等，旧版本也接受、不推进版本）→ "
req POST "/api/projects/$PID/delivery-comments/$CID/decisions?target_id=$B2" \
  '{"version":1,"verdict":"resolved"}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("replayed=%s，意见仍为 v%s" % (d["replayed"], d["comment"]["version"]))'
echo -n "改判“仍待修”须带当前版本 v2 → "
req POST "/api/projects/$PID/delivery-comments/$CID/decisions?target_id=$B2" \
  '{"version":2,"verdict":"outstanding"}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("%s，意见推进到 v%s" % (d["decision"]["verdict_text"], d["comment"]["version"]))'
# 再改回已解决，便于后续批次级核对展示
req POST "/api/projects/$PID/delivery-comments/$CID/decisions?target_id=$B2" \
  '{"version":3,"verdict":"resolved"}' >/dev/null

echo
echo "=== 7. 换批后旧结论仅作历史：对批次一核对仍为“未改动”，批次一无结论 ==="
req GET "/api/projects/$PID/delivery-comments/$CID/check?target_id=$B1" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("对批次一：%s；结论=%s（批次二的结论不挪用）" % (d["auto"]["status_text"], d["decision"]))'

echo
echo "=== 8. 批次三改交日语（不含英语）：对英语意见核对 → 无法核对 ==="
req PUT "/api/projects/$PID/translations/ja-JP/subtitles/$SID1" '{"text":"こんにちは世界","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/ja-JP/subtitles/$SID2" '{"text":"ようこそ","cue_version":1}' >/dev/null
out="$(req POST "/api/projects/$PID/deliveries" "{\"note\":\"第三批（仅日语）\",\"sub_version\":1,\"rules_version\":1,\"languages\":[\"ja-JP\"],\"translations\":{\"ja-JP\":[{\"subtitle_id\":$SID1,\"version\":1},{\"subtitle_id\":$SID2,\"version\":1}]}}")"
B3="$(echo "$out" | body_of | jget id)"
req GET "/api/projects/$PID/delivery-comments/$CID/check?target_id=$B3" | body_of \
  | python3 -c 'import json,sys; a=json.load(sys.stdin)["auto"]; print("结果：%s（%s）" % (a["status_text"], a["reason"]))'
echo -n "对“无法核对”项下结论 → 拒绝 "
req POST "/api/projects/$PID/delivery-comments/$CID/decisions?target_id=$B3" \
  '{"version":4,"verdict":"resolved"}' | code_of

echo
echo "=== 9. 批次级一次核对：批次二为目标、批次一为意见来源 ==="
req GET "/api/projects/$PID/deliveries/$B2/delivery-comments/check?base_id=$B1" | body_of \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("汇总：", d["summary"])
for i in d["items"]:
    dec = i["decision"]["verdict_text"] if i["decision"] else "无结论"
    print("  意见 %s [%s]：%s，结论：%s" % (i["comment_id"], i["lang"], i["auto_status_text"], dec))
'

echo
echo "=== 10. 拒绝场景（均不修改意见） ==="
echo -n "形状非法（空意见）→ "
req POST "/api/projects/$PID/deliveries/$B1/delivery-comments" \
  '{"kind":"translation","lang":"en","start_ms":0,"end_ms":10,"text":"   "}' | code_of
echo -n "区间越界（0..9999ms 超出时间轴 0..2500）→ "
req POST "/api/projects/$PID/deliveries/$B1/delivery-comments" \
  '{"kind":"source","start_ms":0,"end_ms":9999,"text":"越界"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
echo -n "批次未交付所选语言（fr）→ "
req POST "/api/projects/$PID/deliveries/$B1/delivery-comments" \
  '{"kind":"translation","lang":"fr","start_ms":0,"end_ms":10,"text":"法语呢"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
echo -n "批次不存在 → "
req POST "/api/projects/$PID/deliveries/999999/delivery-comments" \
  '{"kind":"source","start_ms":0,"end_ms":10,"text":"x"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
echo -n "对“未改动”目标批次下结论（批次一）→ "
req POST "/api/projects/$PID/delivery-comments/$CID/decisions?target_id=$B1" \
  '{"version":4,"verdict":"resolved"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"][:50], "…")'

# 另建项目演示跨项目拒绝
out="$(req POST /api/projects "$(echo "$WORDS" | sed 's/交付返修 API 示例/别的项目/')")"
PID2="$(echo "$out" | body_of | jget id)"
req POST "/api/projects/$PID2/layout" '{"sub_version":0}' >/dev/null
P2S1="$(req GET "/api/projects/$PID2" | body_of | jget subtitles.0.id)"
P2S2="$(req GET "/api/projects/$PID2" | body_of | jget subtitles.1.id)"
req PUT "/api/projects/$PID2/translations/en/subtitles/$P2S1" '{"text":"X","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID2/translations/en/subtitles/$P2S2" '{"text":"Y","cue_version":1}' >/dev/null
OTHER_B="$(req POST "/api/projects/$PID2/deliveries" "{\"sub_version\":1,\"rules_version\":1,\"languages\":[\"en\"],\"translations\":{\"en\":[{\"subtitle_id\":$P2S1,\"version\":1},{\"subtitle_id\":$P2S2,\"version\":1}]}}" | body_of | jget id)"
echo -n "跨项目核对（批次 $OTHER_B 属于项目 $PID2）→ "
req GET "/api/projects/$PID/delivery-comments/$CID/check?target_id=$OTHER_B" | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'

echo
echo "=== 11. 既有下载行为维持（批次一英语 v1 原文仍可下载，内容不可变） ==="
curl -s "$BASE/api/projects/$PID/translations/en/exports/1" | sed -n '1,4p'

echo
echo "完成。返修相关接口："
echo "  POST   /api/projects/:id/deliveries/:bid/delivery-comments           记录返修意见"
echo "  GET    /api/projects/:id/delivery-comments[?batch_id=]               意见清单"
echo "  GET    /api/projects/:id/delivery-comments/:dcid                     单条意见（含命中/结论历史）"
echo "  GET    /api/projects/:id/delivery-comments/:dcid/check?target_id=    对后续批次核对（只读）"
echo "  GET    /api/projects/:id/deliveries/:bid/delivery-comments/check?base_id= 批次级核对（只读）"
echo "  POST   /api/projects/:id/delivery-comments/:dcid/decisions?target_id= 显式结论（版本乐观锁）"
