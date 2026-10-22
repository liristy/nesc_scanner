#!/usr/bin/env bash
set -euo pipefail
: "${REPORT_BRANCH:?缺少目标分支}"
if [[ -n "${REPORT_REPOSITORY:-}" ]]; then
  remote_url="$(git remote get-url origin)"
  if [[ "$remote_url" != "https://github.com/$REPORT_REPOSITORY" && "$remote_url" != "https://github.com/$REPORT_REPOSITORY.git" ]]; then
    echo '目标远端不是指定私有报告仓库，拒绝提交。' >&2
    exit 1
  fi
fi
git check-ref-format --branch "$REPORT_BRANCH" >/dev/null
mkdir -p reports state
git add -- reports/
if [[ -f README.md ]]; then
  git add -- README.md
fi
for file in state/current_tracking.json state/daily_collection.json state/pending_audit.json state/cloud-runtime.json; do
  if [[ -f "$file" ]]; then git add -- "$file"; fi
done
if git diff --cached --quiet; then
  echo '报告及状态没有变化，无需提交。'
  exit 0
fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git commit -m "reports: 更新监测报告 $(date +%F)"
# 采集期间若有文档/代码更新，先变基后重试；同一报告冲突时明确失败，不强推。
for attempt in 1 2 3; do
  git fetch origin "$REPORT_BRANCH"
  git rebase "origin/$REPORT_BRANCH"
  if git push origin "HEAD:refs/heads/$REPORT_BRANCH"; then
    exit 0
  fi
done
echo '报告推送失败；请检查分支规则、写入权限，并从私有仓库草稿Release下载结果。' >&2
exit 1
