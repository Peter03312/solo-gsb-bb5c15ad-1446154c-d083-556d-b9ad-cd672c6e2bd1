#!/usr/bin/env bash
# 片方返修意见（交付批次冻结文件 → 起止毫秒区间 → 后续批次核对 → 人工判定）完整调用示例。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/rework-comments-api.sh [BASE_URL]
# 例如：bash examples/rework-comments-api.sh http://localhost:3000
#
# 流程：新建项目 → 交付批次一（原文+英语+法语）→ 在批次一的冻结文件上按起止毫秒
#       记录返修意见 → 修改原文与英语译文 → 交付批次二（原文+英语；法语未交付）→
#       对批次二核对（待人工确认/无法核对）→ 判定“已解决”/“仍待修”（结论绑定批次二）→
#       交付批次三后核对：批次二的结论仅作历史 → 各类拒绝（越界/空意见/批次不存在/
#       跨项目/语言未交付/未改动不可判定/意见版本过期）。
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
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（2 条源字幕：[0,1000) 你好世界 / [1500,2500) 欢迎光临） ==="
WORDS='{"name":"返修意见 API 示例","words":[
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

deliver() { # $1=note；其后为语言列表（各语言当前译文须 current）
  local note="$1"; shift
  local subv
  subv="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
  local BODY
  BODY="$(python3 - "$PID" "$subv" "$note" "$BASE" "$@" <<'PY'
import json, sys, urllib.request
pid, subv, note, base = sys.argv[1:5]
langs = sys.argv[5:]
trans = {}
for lang in langs:
    with urllib.request.urlopen(f"{base}/api/projects/{pid}/translations/{lang}") as r:
        view = json.load(r)
    trans[lang] = [
      {"subtitle_id": e["cue"]["id"], "version": e["translation"]["version"]}
      for e in view["entries"] if e["state"] == "current" and e["valid"]
    ]
print(json.dumps({"note": note, "sub_version": int(subv), "rules_version": 1,
                  "languages": langs, "translations": trans}))
PY
)"
  req POST "/api/projects/$PID/deliveries" "$BODY"
}

echo
echo "=== 1. 保存英语、法语译文并交付批次一（原文+en+fr） ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour le monde","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
out="$(deliver '第一批：原文+英+法' en fr)"
B1="$(echo "$out" | body_of | jget id)"
echo "批次一 id=$B1（languages: en, fr）"

echo
echo "=== 2. 在批次一的冻结文件上按起止毫秒记录返修意见 ==="
echo "--- 2a. 原文文件 [0,1000]ms ---"
out="$(req POST "/api/projects/$PID/deliveries/$B1/rework-comments" \
  '{"kind":"source","start_ms":0,"end_ms":1000,"text":"「你好世界」断句生硬，建议调整"}')"
echo "HTTP $(echo "$out" | tail -1)"
echo "$out" | body_of | python3 -c '
import json, sys
c = json.load(sys.stdin)["comment"]
print("  意见 id=%s version=%s 区间 [%s,%s]ms 文件版本 v%s" % (c["id"], c["version"], c["start_ms"], c["end_ms"], c["file_version"]))
for h in c["hits"]:
    print("  命中冻结文本：%s --> %s  %r" % (h["start"], h["end"], h["text"]))'
C_SRC="$(echo "$out" | body_of | jget comment.id)"

echo "--- 2b. 英语译文文件 [0,1000]ms ---"
out="$(req POST "/api/projects/$PID/deliveries/$B1/rework-comments" \
  '{"kind":"translation","lang":"en","start_ms":0,"end_ms":1000,"text":"Hello world 语气与画面不符"}')"
echo "HTTP $(echo "$out" | tail -1)"
C_EN="$(echo "$out" | body_of | jget comment.id)"
echo "  意见 id=$C_EN"

echo "--- 2c. 法语译文文件 [1500,2500]ms ---"
out="$(req POST "/api/projects/$PID/deliveries/$B1/rework-comments" \
  '{"kind":"translation","lang":"fr","start_ms":1500,"end_ms":2500,"text":"Bienvenue 拼写需复核"}')"
echo "HTTP $(echo "$out" | tail -1)"
C_FR="$(echo "$out" | body_of | jget comment.id)"
echo "  意见 id=$C_FR"

echo
echo "=== 3. 修改原文第一行与英语译文（第二批不含法语）并交付批次二 ==="
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好世界呀"}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello again","cue_version":2,"version":1}' >/dev/null
out="$(deliver '第二批：原文+英（法语未交付）' en)"
B2="$(echo "$out" | body_of | jget id)"
echo "批次二 id=$B2（languages: en）"

echo
echo "=== 4. 对目标批次二核对：GET …/deliveries/$B1/rework-comments/check?target_id=$B2 ==="
req GET "/api/projects/$PID/deliveries/$B1/rework-comments/check?target_id=$B2" | body_of \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("基准批次:", d["base"]["id"], " 目标批次:", d["target"]["id"], " 计数:", d["counts"])
for c in d["comments"]:
    name = "原文" if c["kind"] == "source" else "语言 " + c["lang"]
    print("  意见#%s [%s] [%s,%s]ms → %s" % (c["id"], name, c["start_ms"], c["end_ms"], c["status_label"]))
    if c["differences"]:
        for s in c["differences"]:
            print("      %s --> %s  基准: %r  目标: %r" % (s["start"], s["end"], s["base_text"], s["target_text"]))
    if c["verdict"]:
        print("      当前结论（绑定批次 %s）: %s" % (c["verdict"]["target_batch_id"], c["verdict"]["verdict_label"]))'

echo
echo "=== 5. 判定“待人工确认”项（结论绑定批次二） ==="
echo "--- 5a. 英语意见判“已解决” ---"
req POST "/api/projects/$PID/deliveries/$B1/rework-comments/$C_EN/verdict" \
  "{\"version\":1,\"target_batch_id\":$B2,\"verdict\":\"resolved\"}" | body_of | python3 -c '
import json, sys
d = json.load(sys.stdin)
c = d["comment"]
print("  意见#%s version=%s 核对=%s 结论=%s（绑定批次 %s）" % (c["id"], c["version"], c["status_label"], c["verdict"]["verdict_label"], c["verdict"]["target_batch_id"]))'
echo "--- 5b. 原文意见判“仍待修” ---"
req POST "/api/projects/$PID/deliveries/$B1/rework-comments/$C_SRC/verdict" \
  "{\"version\":1,\"target_batch_id\":$B2,\"verdict\":\"still_pending\"}" | body_of \
  | python3 -c 'import json,sys; c=json.load(sys.stdin)["comment"]; print("  意见#%s version=%s 结论=%s" % (c["id"], c["version"], c["verdict"]["verdict_label"]))'
echo "--- 5c. 并发判定：携带过期意见版本 → 409 返回当前状态 ---"
req POST "/api/projects/$PID/deliveries/$B1/rework-comments/$C_EN/verdict" \
  "{\"version\":1,\"target_batch_id\":$B2,\"verdict\":\"still_pending\"}" | body_of | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("  " + d["error"])
print("  当前状态：version=%s 结论=%s" % (d["current"]["comment"]["version"], d["current"]["comment"]["verdicts"]))'

echo
echo "=== 6. 交付批次三（英语再改）→ 换批核对：批次二的结论仅作历史 ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello world!","cue_version":2,"version":2}' >/dev/null
out="$(deliver '第三批：原文+英' en)"
B3="$(echo "$out" | body_of | jget id)"
echo "批次三 id=$B3"
req GET "/api/projects/$PID/deliveries/$B1/rework-comments/check?target_id=$B3" | body_of \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("目标批次:", d["target"]["id"], " 计数:", d["counts"])
for c in d["comments"]:
    cur = c["verdict"]["verdict_label"] if c["verdict"] else "（无）"
    hist = "、".join("批次%s:%s" % (v["target_batch_id"], v["verdict_label"]) for v in c["verdict_history"]) or "（无）"
    print("  意见#%s → %s；本批结论=%s；历史结论=%s" % (c["id"], c["status_label"], cur, hist))'

echo
echo "=== 7. 拒绝场景（均明确拒绝且不改意见） ==="
echo -n "区间越界（[0,99999]ms 超出时间轴）→ "
req POST "/api/projects/$PID/deliveries/$B1/rework-comments" \
  '{"kind":"source","start_ms":0,"end_ms":99999,"text":"x"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
echo -n "空意见 → "
req POST "/api/projects/$PID/deliveries/$B1/rework-comments" \
  '{"kind":"source","start_ms":0,"end_ms":1000,"text":"  "}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["errors"][0])'
echo -n "批次不存在 → "
req POST "/api/projects/$PID/deliveries/999999/rework-comments" \
  '{"kind":"source","start_ms":0,"end_ms":1000,"text":"x"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
echo -n "批次一未交付日语 → "
req POST "/api/projects/$PID/deliveries/$B1/rework-comments" \
  '{"kind":"translation","lang":"ja-JP","start_ms":0,"end_ms":1000,"text":"x"}' | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
echo -n "未改动项不可判定（原文第二行两批一致）→ "
C_UNCHANGED="$(req POST "/api/projects/$PID/deliveries/$B1/rework-comments" \
  '{"kind":"source","start_ms":1500,"end_ms":2500,"text":"第二行确认无误"}' | body_of | jget comment.id)"
req POST "/api/projects/$PID/deliveries/$B1/rework-comments/$C_UNCHANGED/verdict" \
  "{\"version\":1,\"target_batch_id\":$B2,\"verdict\":\"resolved\"}" | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'

# 另建项目交付一批，演示跨项目拒绝
out="$(req POST /api/projects "$(echo "$WORDS" | sed 's/返修意见 API 示例/别的项目/')")"
PID2="$(echo "$out" | body_of | jget id)"
req POST "/api/projects/$PID2/layout" '{"sub_version":0}' >/dev/null
P2S1="$(req GET "/api/projects/$PID2" | body_of | jget subtitles.0.id)"
P2S2="$(req GET "/api/projects/$PID2" | body_of | jget subtitles.1.id)"
req PUT "/api/projects/$PID2/translations/en/subtitles/$P2S1" '{"text":"X","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID2/translations/en/subtitles/$P2S2" '{"text":"Y","cue_version":1}' >/dev/null
SV2="$(req GET "/api/projects/$PID2" | body_of | jget sub_version)"
OTHER_B="$(req POST "/api/projects/$PID2/deliveries" "{\"sub_version\":$SV2,\"rules_version\":1,\"languages\":[\"en\"],\"translations\":{\"en\":[{\"subtitle_id\":$P2S1,\"version\":1},{\"subtitle_id\":$P2S2,\"version\":1}]}}" | body_of | jget id)"
echo -n "跨项目核对（目标批次 $OTHER_B 属于项目 $PID2）→ "
req GET "/api/projects/$PID/deliveries/$B1/rework-comments/check?target_id=$OTHER_B" | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'

echo
echo "完成。返修意见只锚定冻结批次文件：原有交付、导出与下载行为保持兼容。"
