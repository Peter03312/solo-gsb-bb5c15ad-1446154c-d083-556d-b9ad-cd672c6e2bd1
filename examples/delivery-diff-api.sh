#!/usr/bin/env bash
# 片方审阅：同一项目两批交付字幕差异对照的完整调用示例（只读）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/delivery-diff-api.sh [BASE_URL]
# 例如：bash examples/delivery-diff-api.sh http://localhost:3000
#
# 流程：新建项目 → 交付批次一（原文+英语+法语）→ 修改原文与英语译文 →
#       交付批次二（原文+英语+日语：法语移除、日语新增）→ 调用批次对照接口
#       → 展示语言并集、原文/英语的时间区段差异、法语 removed / 日语 added
#       → 再做同批对照（返回空差异）→ 各种拒绝（参数非法/批次不存在/跨项目）。
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

echo "=== 0. 新建项目并排版（2 条源字幕） ==="
WORDS='{"name":"批次对照 API 示例","words":[
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
  # 直接从服务端读取各语言当前译文版本，组装交付请求
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
echo "=== 1. 保存英语、法语译文并交付批次一 ==="
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" '{"text":"Hello world","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" '{"text":"Welcome","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour le monde","cue_version":1}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
out="$(deliver '第一批：原文+英+法' en fr)"
B1="$(echo "$out" | body_of | jget id)"
echo "批次一 id=$B1（languages: en, fr）"

echo
echo "=== 2. 修改原文与英语译文（对照只读，旧批次不受影响） ==="
# 原文第一行改文本（sub_version 推进；英/法译文转待复核）
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好世界呀"}' >/dev/null
# 英语以新源行版本重新保存（version=1 覆盖待复核译文），法语不再处理
req PUT "/api/projects/$PID/translations/en/subtitles/$SID1" \
  '{"text":"Hello again","cue_version":2,"version":1}' >/dev/null
# 新增日语两行
req PUT "/api/projects/$PID/translations/ja-JP/subtitles/$SID1" '{"text":"こんにちは世界","cue_version":2}' >/dev/null
req PUT "/api/projects/$PID/translations/ja-JP/subtitles/$SID2" '{"text":"ようこそ","cue_version":1}' >/dev/null

echo
echo "=== 3. 交付批次二（原文+英语+日语；法语被移除、日语新增） ==="
out="$(deliver '第二批：原文+英+日' en ja-JP)"
echo "交付 HTTP $(echo "$out" | tail -1)"
B2="$(echo "$out" | body_of | jget id)"
echo "批次二 id=$B2（languages: en, ja-JP）"

echo
echo "=== 4. 批次对照：GET /api/projects/$PID/deliveries/diff?base_id=$B1&target_id=$B2 ==="
req GET "/api/projects/$PID/deliveries/diff?base_id=$B1&target_id=$B2" | body_of \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("基准批次:", d["base"]["id"], d["base"]["note"])
print("目标批次:", d["target"]["id"], d["target"]["note"])
print("语言并集:", d["languages"]["union"])
print("移除（仅基准有）:", d["languages"]["base_only"])
print("新增（仅目标有）:", d["languages"]["target_only"])
print("汇总:", d["summary"])
for f in d["files"]:
    name = "原文" if f["kind"] == "source" else "语言 " + f["lang"]
    if f["status"] == "added":
        t = f["target"]
        print("  [%s] 新增：目标文件 v%s %s" % (name, t["version"], t["download_url"]))
    elif f["status"] == "removed":
        b = f["base"]
        print("  [%s] 移除：基准文件 v%s %s" % (name, b["version"], b["download_url"]))
    else:
        b, t = f["base"], f["target"]
        print("  [%s] 双方都有：基准 v%s → 目标 v%s，差异区段 %s 段" % (name, b["version"], t["version"], f["diff_count"]))
        for s in f["differences"]:
            bt = s["base_text"] if s["base_text"] is not None else "（无字幕）"
            tt = s["target_text"] if s["target_text"] is not None else "（无字幕）"
            print("      %s --> %s（%s-%sms）" % (s["start"], s["end"], s["start_ms"], s["end_ms"]))
            print("        基准 v%s: %r" % (s["base_version"], bt))
            print("        目标 v%s: %r" % (s["target_version"], tt))
'

echo
echo "=== 5. 同批比较：快照完好 → 空差异 ==="
req GET "/api/projects/$PID/deliveries/diff?base_id=$B1&target_id=$B1" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" difference_count =", d["summary"]["difference_count"], " changed =", d["summary"]["changed"])'

echo
echo "=== 6. 拒绝场景 ==="
echo -n "参数非法（target_id 缺失）→ "
req GET "/api/projects/$PID/deliveries/diff?base_id=$B1" | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'
echo -n "批次不存在 → "
req GET "/api/projects/$PID/deliveries/diff?base_id=999999&target_id=$B2" | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'

# 另建一个项目并交付一批，演示跨项目拒绝
out="$(req POST /api/projects "$(echo "$WORDS" | sed 's/批次对照 API 示例/别的项目/')")"
PID2="$(echo "$out" | body_of | jget id)"
req POST "/api/projects/$PID2/layout" '{"sub_version":0}' >/dev/null
P2S1="$(req GET "/api/projects/$PID2" | body_of | jget subtitles.0.id)"
req PUT "/api/projects/$PID2/translations/en/subtitles/$P2S1" '{"text":"X","cue_version":1}' >/dev/null
P2S2="$(req GET "/api/projects/$PID2" | body_of | jget subtitles.1.id)"
req PUT "/api/projects/$PID2/translations/en/subtitles/$P2S2" '{"text":"Y","cue_version":1}' >/dev/null
out2="$(req GET "/api/projects/$PID2")"
SV2="$(echo "$out2" | body_of | jget sub_version)"
OTHER_B="$(req POST "/api/projects/$PID2/deliveries" "{\"sub_version\":$SV2,\"rules_version\":1,\"languages\":[\"en\"],\"translations\":{\"en\":[{\"subtitle_id\":$P2S1,\"version\":1},{\"subtitle_id\":$P2S2,\"version\":1}]}}" | body_of | jget id)"
echo -n "批次不属于项目（$OTHER_B 属于项目 $PID2，放到项目 $PID 下对照）→ "
req GET "/api/projects/$PID/deliveries/diff?base_id=$B1&target_id=$OTHER_B" | body_of \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["error"])'

echo
echo "完成。对照接口只读：旧交付与既有下载约定保持兼容。"
