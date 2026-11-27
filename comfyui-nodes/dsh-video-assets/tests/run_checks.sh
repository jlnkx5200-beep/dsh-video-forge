#!/usr/bin/env bash
# tests/run_checks.sh —— 自动挑一个 python 跑 dsh-video-assets 自测，逐条打印 PASS/FAIL
#
# 用法：
#   bash tests/run_checks.sh                 # 自动发现
#   DSH_PY="/path/to/python" bash tests/run_checks.sh   # 指定
#
# 选择顺序：$DSH_PY
#           → $COMFYUI_DIR/venv/Scripts/python.exe（Windows 便携版 venv，有 numpy/torch，推荐）
#           → $COMFYUI_DIR/python/python.exe（无 numpy，张量测试会 skip）
#           → python3 → python → py -3
# 优先选「import numpy 成功」的解释器（否则张量测试全部 skip）。
set -u

cd "$(dirname "$0")/.." || { echo "FAIL: 无法进入包根目录"; exit 2; }

export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

candidates=(
  "${DSH_PY:-}"
  "${COMFYUI_DIR:-}/venv/Scripts/python.exe"
  "${COMFYUI_DIR:-}/python/python.exe"
  "python3"
  "python"
  "py -3"
)

run_py() {
  local py="$1"
  shift
  if [ -f "$py" ]; then
    "$py" "$@"
  else
    $py "$@"
  fi
}

chosen=""
fallback=""
for cand in "${candidates[@]}"; do
  [ -n "$cand" ] || continue
  if ! run_py "$cand" -c 'import sys' >/dev/null 2>&1; then
    continue
  fi
  if [ "$cand" = "${DSH_PY:-}" ] && [ -n "${DSH_PY:-}" ]; then
    chosen="$cand"   # 显式指定优先，用户说了算
    break
  fi
  [ -n "$fallback" ] || fallback="$cand"
  if run_py "$cand" -c 'import numpy' >/dev/null 2>&1; then
    chosen="$cand"
    break
  fi
done
[ -n "$chosen" ] || chosen="$fallback"

if [ -z "$chosen" ]; then
  echo "FAIL: 找不到任何可用的 python（试过: ${candidates[*]}）"
  exit 2
fi

ver=$(run_py "$chosen" -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])' 2>/dev/null || echo "?")
npv=$(run_py "$chosen" -c 'import numpy;print(numpy.__version__)' 2>/dev/null || echo "缺失")
thv=$(run_py "$chosen" -c 'import torch;print(torch.__version__)' 2>/dev/null || echo "缺失")

echo "=================================================================="
echo " dsh-video-assets 自测"
echo " package : $(pwd)"
echo " python  : $chosen  ($ver)"
echo " numpy   : $npv"
echo " torch   : $thv"
echo "=================================================================="

if [ "$npv" = "缺失" ]; then
  echo "注意: 该解释器没有 numpy —— 张量测试会被 skip，只有纯 Python 测试真实运行。"
  echo
fi

out=$(mktemp 2>/dev/null || echo "./.run_checks.out")
run_py "$chosen" -m unittest discover -s tests -t . -v >"$out" 2>&1
code=$?
cat "$out"

echo "------------------------------------------------------------------"
echo " 逐条结果"
echo "------------------------------------------------------------------"
pass=0
fail=0
skip=0
while IFS= read -r line; do
  case "$line" in
    *" ... ok"*)      printf 'PASS  %s\n' "${line% ... ok}"; pass=$((pass + 1)) ;;
    *" ... skipped"*) printf 'SKIP  %s\n' "${line%% ... skipped*}"; skip=$((skip + 1)) ;;
    *" ... FAIL"*)    printf 'FAIL  %s\n' "${line% ... FAIL}"; fail=$((fail + 1)) ;;
    *" ... ERROR"*)   printf 'FAIL  %s\n' "${line% ... ERROR}"; fail=$((fail + 1)) ;;
  esac
done <"$out"

echo "------------------------------------------------------------------"
echo " 合计: PASS=$pass  FAIL=$fail  SKIP=$skip"
if [ "$code" -eq 0 ] && [ "$fail" -eq 0 ]; then
  echo " 结果: 全部通过 ✅"
else
  echo " 结果: 有失败 ❌ (exit=$code)"
fi
echo "------------------------------------------------------------------"

# 清理临时文件
case "$out" in
  */.run_checks.out) rm -f "$out" 2>/dev/null ;;
  *) rm -f "$out" 2>/dev/null ;;
esac

if [ "$code" -ne 0 ] || [ "$fail" -ne 0 ]; then
  exit 1
fi
exit 0
