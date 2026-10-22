import path from 'node:path';
import { readJson } from '../src/utils.mjs';
import { reportScheduleDecision } from './report-schedule-gate.mjs';
import { currentDayPending } from '../src/audit-policy.mjs';

// A resumed interval can finish successfully while still being behind today.
// Run only after its evidence AND repository state have been published.
export async function collectionContinuation({ root = '.', now = new Date() } = {}) {
  const config = await readJson(path.join(root, process.env.JY_ALARM_CONFIG || 'github-config.json'), {});
  if (currentDayPending(config)) return { should_run: false, reason: '只核查当天，不自动追加补跑。' };
  const baseline = await readJson(path.join(root, 'run/cloud-baseline.json'));
  const result = await readJson(path.join(root, 'run/last-result.json'));
  const pending = await readJson(path.join(root, 'state/pending_audit.json'));
  const completedCutoff = baseline?.window?.endText;
  if (!completedCutoff || result?.status !== 'success' || pending
      || result.period?.end_inclusive !== completedCutoff) return { should_run: false };
  const marker = await readJson(path.join(root, baseline.window.publishReport
    ? 'state/current_tracking.json' : 'state/daily_collection.json'), {});
  const savedCutoff = baseline.window.publishReport ? marker.last_success_cutoff : marker.last_collection_cutoff;
  if (!(savedCutoff >= completedCutoff)) return { should_run: false };
  const next = await reportScheduleDecision({ root, now });
  // Strict forward progress prevents a successful-looking stale result from
  // dispatching itself indefinitely. Before the daily cutoff the target is yesterday.
  return { ...next, completedCutoff,
    should_run: next.should_run && next.window.endText > completedCutoff };
}

export async function dispatchCollectionContinuation({ github, context, root = '.', now = new Date() }) {
  const decision = await collectionContinuation({ root, now });
  if (!decision.should_run) return { dispatched: false, message: decision.reason || '已追上当前采集截止，或本轮未成功保存；不自动追加运行。' };
  const branch = context.payload.repository.default_branch;
  const triggerId = `nesc-catchup-${decision.report_date}-after-${context.runId}`;
  const { data } = await github.rest.actions.listWorkflowRuns({ ...context.repo,
    workflow_id: 'daily-report.yml', branch, event: 'workflow_dispatch', per_page: 100 });
  const existing = data.workflow_runs.find(run => run.display_title === triggerId
    && run.head_branch === branch && run.event === 'workflow_dispatch');
  if (existing) return { dispatched: false, url: existing.html_url,
    message: `补采 ${decision.window.endText} 的后续运行已存在：${existing.html_url}` };
  // One write attempt only. A lost response must not trigger blind retries.
  await github.rest.actions.createWorkflowDispatch({ ...context.repo,
    workflow_id: 'daily-report.yml', ref: branch, inputs: { trigger_id: triggerId } });
  return { dispatched: true, triggerId,
    message: `已保存截至 ${decision.completedCutoff} 的补采结果，已请求继续采集至 ${decision.window.endText}；后续完成情况以对应 Actions 运行及采集截止为准。` };
}
