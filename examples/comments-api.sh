#!/usr/bin/env bash
# 逐词区间复核意见完整调用示例（创建 → 列表 → 关闭 → 漂移待复核 → 重开/再关闭 → 重新导入历史）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/comments-api.sh [BASE_URL]
# 例如：bash examples/comments-api.sh http://localhost:3000
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

echo "=== 0. 新建项目并排版（准备词与字幕） ==="
WORDS='{"name":"复核意见 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SUBV="$(echo "$out" | body_of | jget sub_version)"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
echo "字幕集 v$SUBV，第一条字幕 id=$SID1（词 0-1）"

echo
echo "=== 1. 创建意见：携带当前导入代次 + 字幕集版本 + 起止词序 + 非空意见 ==="
out="$(req POST "/api/projects/$PID/comments" \
  "{\"import_version\":1,\"sub_version\":$SUBV,\"word_start\":0,\"word_end\":1,\"text\":\"「你好世界」连读略快，注意断句\"}")"
echo "HTTP $(echo "$out" | code_of)"
CID="$(echo "$out" | body_of | jget comment.id)"
echo "意见 id=$CID 状态=$(echo "$out" | body_of | jget comment.status) 版本=$(echo "$out" | body_of | jget comment.version)"

echo
echo "=== 2. 非法与过期示例（均不创建） ==="
out="$(req POST "/api/projects/$PID/comments" \
  '{"import_version":1,"sub_version":1,"word_start":0,"word_end":1,"text":"  "}')"
echo "空意见           → HTTP $(echo "$out" | code_of)（400）"
out="$(req POST "/api/projects/$PID/comments" \
  '{"import_version":1,"sub_version":1,"word_start":0,"word_end":9,"text":"x"}')"
echo "区间越界         → HTTP $(echo "$out" | code_of)（422）"
out="$(req POST "/api/projects/$PID/comments" \
  '{"import_version":1,"sub_version":0,"word_start":0,"word_end":1,"text":"x"}')"
echo "字幕集版本过期   → HTTP $(echo "$out" | code_of)（409，返回当前值 sub_version=$(echo "$out" | body_of | jget current.sub_version)）"

echo
echo "=== 3. 列表：状态 / 词段 / 相交的当前字幕 ==="
out="$(req GET "/api/projects/$PID/comments")"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("counts:", d["counts"])
for c in d["comments"]:
    seg = "".join(w["text"] for w in c["words"])
    subs = [(s["id"], s["text"]) for s in c["subtitles"]]
    print("  #%s [%s] 词%s-%s 词段: %s | 相交字幕: %s" % (
        c["id"], c["status"], c["word_start"], c["word_end"], seg, subs))'

echo
echo "=== 4. 关闭意见：保存相交字幕的文本/时间/词区间快照 ==="
out="$(req POST "/api/projects/$PID/comments/$CID/close" '{"version":1}')"
echo "HTTP $(echo "$out" | code_of) 状态=$(echo "$out" | body_of | jget comment.status) 意见版本=$(echo "$out" | body_of | jget comment.version)"
echo "快照：$(echo "$out" | body_of | jget comment.snapshot)"

echo
echo "=== 5. 相交字幕文本变化 → 自动转待复核；锁定切换不触发 ==="
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好，世界"}')"
echo "编辑字幕 HTTP $(echo "$out" | code_of)"
out="$(req GET "/api/projects/$PID/comments")"
echo "编辑后意见状态：$(echo "$out" | body_of | jget comments.0.status)（review=待复核）"
# 先再关闭，然后仅切换锁定
out="$(req POST "/api/projects/$PID/comments/$CID/close" '{"version":2}')"
echo "再次关闭 HTTP $(echo "$out" | code_of)"
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":2,"locked":true}')"
echo "锁定字幕 HTTP $(echo "$out" | code_of)"
out="$(req GET "/api/projects/$PID/comments")"
echo "锁定后意见状态：$(echo "$out" | body_of | jget comments.0.status)（仍为 closed，锁定不触发）"
out="$(req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":3,"locked":false}')"

echo
echo "=== 6. 重新打开 → 再次显式关闭（携带意见版本，过期 409） ==="
out="$(req POST "/api/projects/$PID/comments/$CID/reopen" '{"version":1}')"
echo "旧版本重开 → HTTP $(echo "$out" | code_of)（409 版本过期，返回当前意见）"
CURV="$(echo "$out" | body_of | jget current.comment.version)"
out="$(req POST "/api/projects/$PID/comments/$CID/reopen" "{\"version\":$CURV}")"
echo "重新打开   → HTTP $(echo "$out" | code_of) 状态=$(echo "$out" | body_of | jget comment.status)"
CURV="$(echo "$out" | body_of | jget comment.version)"
out="$(req POST "/api/projects/$PID/comments/$CID/close" "{\"version\":$CURV}")"
echo "再次关闭   → HTTP $(echo "$out" | code_of) 状态=$(echo "$out" | body_of | jget comment.status)"

echo
echo "=== 7. 重排拆并：意见仍锚定词区间，显示在相交的新字幕旁（不按字幕 ID 迁移） ==="
out="$(req GET "/api/projects/$PID")"
RV="$(echo "$out" | body_of | jget rules.version)"
out="$(req PUT "/api/projects/$PID/rules" \
  "{\"version\":$RV,\"max_chars\":2,\"min_duration_ms\":400,\"max_cps\":20}")"
echo "改规则（单条 2 字）HTTP $(echo "$out" | code_of)"
out="$(req GET "/api/projects/$PID")"
SUBV="$(echo "$out" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/layout" "{\"sub_version\":$SUBV}")"
echo "重排 HTTP $(echo "$out" | code_of)，字幕数=$(echo "$out" | body_of | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["subtitles"]))')"
out="$(req GET "/api/projects/$PID/comments")"
echo "$out" | body_of | python3 -c '
import json,sys
c=json.load(sys.stdin)["comments"][0]
print("意见 #%s 状态=%s（相交字幕快照已漂移→待复核）" % (c["id"], c["status"]))
subs = [(s["id"], s["text"], [s["word_start"], s["word_end"]]) for s in c["subtitles"]]
print("  仍锚定词区间", c["word_start"], "-", c["word_end"], "；相交当前字幕:", subs)'

echo
echo "=== 8. 重新导入：旧意见转历史（仅查看、不附新词段、不可关闭） ==="
out="$(req GET "/api/projects/$PID")"
SUBV="$(echo "$out" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/import" '{"force":true,"words":[
  {"text":"全新","start_ms":0,"end_ms":400},
  {"text":"内容","start_ms":500,"end_ms":900}
],"cuts":[]}')"
echo "重新导入 HTTP $(echo "$out" | code_of)，导入代次=$(echo "$out" | body_of | jget import_version)"
out="$(req GET "/api/projects/$PID/comments")"
echo "$out" | body_of | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("counts:", d["counts"])
for h in d["history"]:
    seg = "".join(w["text"] for w in h["words_snapshot"])
    print("  历史 #%s 第%s代 词%s-%s 当前词段: %s 相交字幕: %s 创建时词段: %s" % (
        h["id"], h["import_version"], h["word_start"], h["word_end"],
        h["words"], h["subtitles"], seg))'
out="$(req POST "/api/projects/$PID/comments/$CID/close" '{"version":9}')"
echo "关闭历史意见 → HTTP $(echo "$out" | code_of)（422 不可关闭）"

echo
echo "=== 9. 新代次可正常创建（携带新导入代次与字幕集版本） ==="
out="$(req GET "/api/projects/$PID")"
IMPV="$(echo "$out" | body_of | jget import_version)"
SUBV="$(echo "$out" | body_of | jget sub_version)"
out="$(req POST "/api/projects/$PID/comments" \
  "{\"import_version\":$IMPV,\"sub_version\":$SUBV,\"word_start\":0,\"word_end\":1,\"text\":\"新转写整体偏快\"}")"
echo "HTTP $(echo "$out" | code_of) 状态=$(echo "$out" | body_of | jget comment.status) 代次=$(echo "$out" | body_of | jget comment.import_version)"

echo
echo "完成。页面侧：左侧 ⑨ 面板创建，右侧「复核意见（逐词区间）」面板查看/关闭/重新打开。"
