#!/usr/bin/env bash
set -euo pipefail
# 只检查已完成区间；迟到仍补采集，不按16:15或下班时间中断。
# 程序在公开库，调用目录及数据目录可位于私有报告库；不要改变 cwd。
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/../src/main.mjs"
