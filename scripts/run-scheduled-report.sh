#!/usr/bin/env bash
set -euo pipefail
# 只检查已完成区间；迟到仍补采集，不按16:15或下班时间中断。
exec node src/main.mjs
