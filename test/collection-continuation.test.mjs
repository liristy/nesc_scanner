import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepare, finalize } from '../scripts/cloud-runtime.mjs';
import { reportScheduleDecision } from '../scripts/report-schedule-gate.mjs';
import { collectionContinuation, dispatchCollectionContinuation } from '../scripts/continue-collection.mjs';
import { atomicWriteJson, readJson } from '../src/utils.mjs';

const oct2 = new Date('2026-10-02T22:30:00+08:00');
const context = { repo: { owner: 'liristy', repo: 'nesc_report' }, runId: 123,
  payload: { repository: { default_branch: 'main' } } };
async function fixture(t, cutoff = '2026-10-01', formalCutoff = '2026-09-30') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-continuation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), {
    last_success_cutoff: `${formalCutoff} 16:00:00`, items: [] });
  await prepare(root, new Date(`${cutoff}T16:00:00+08:00`));
  return root;
}
async function finish(root, options = {}) {
  const { window } = await readJson(path.join(root, 'run/cloud-baseline.json'));
  await atomicWriteJson(path.join(root, 'state/daily_collection.json'), { last_collection_cutoff: window.endText });
  if (window.publishReport) await atomicWriteJson(path.join(root, 'state/current_tracking.json'), { last_success_cutoff: window.endText });
  await atomicWriteJson(path.join(root, 'run/last-result.json'), { status: 'success', period: { end_inclusive: window.endText } });
  return finalize(root, { artifactId: '11', runId: '123', monitorOutcome: 'success', ...options });
}
function fakeGitHub() {
  const calls = [], runs = [];
  return { calls, runs, rest: { actions: {
    listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
    createWorkflowDispatch: async request => {
      calls.push(request);
      runs.push({ display_title: request.inputs.trigger_id, head_branch: request.ref,
        event: 'workflow_dispatch', html_url: 'https://github.com/liristy/nesc_report/actions/runs/456' });
    },
  } } };
}

test('10月2日恢复1号失败区间：先保存1号，再追加2号；追平后停止', async t => {
  const root = await fixture(t);
  await finalize(root, { artifactId: '10', runId: '122', monitorOutcome: 'failure' });
  assert.equal((await reportScheduleDecision({ root, now: oct2 })).window.endText, '2026-10-01 16:00:00');
  await prepare(root, oct2);
  await finish(root);
  const github = fakeGitHub();
  const next = await dispatchCollectionContinuation({ root, now: oct2, github, context });
  assert.equal(next.dispatched, true);
  assert.deepEqual(github.calls[0], { owner: 'liristy', repo: 'nesc_report', workflow_id: 'daily-report.yml',
    ref: 'main', inputs: { trigger_id: 'nesc-catchup-2026-10-02-after-123' } });
  const nextWindow = await reportScheduleDecision({ root, now: oct2 });
  assert.equal(nextWindow.window.startText, '2026-09-30 16:00:00');
  assert.equal(nextWindow.window.endText, '2026-10-02 16:00:00');
  assert.equal(nextWindow.window.publishReport, false);
  await prepare(root, oct2);
  await finish(root);
  assert.equal((await collectionContinuation({ root, now: oct2 })).should_run, false);
  assert.equal((await readJson(path.join(root, 'state/current_tracking.json'))).last_success_cutoff, '2026-09-30 16:00:00');
});

test('3号上午只追到2号，16:00后才能追到3号；跨假期正式区间不变', async t => {
  const root = await fixture(t);
  await finish(root);
  for (const [time, expected] of [['2026-10-03T12:00:00+08:00', '2026-10-02'], ['2026-10-03T16:00:00+08:00', '2026-10-03']]) {
    const d = await collectionContinuation({ root, now: new Date(time) });
    assert.equal(d.should_run, true);
    assert.equal(d.window.endText, `${expected} 16:00:00`);
    assert.equal(d.window.publishReport, false);
  }
  const workday = await collectionContinuation({ root, now: new Date('2026-10-08T16:00:00+08:00') });
  assert.equal(workday.window.publishReport, true);
  assert.equal(workday.window.startText, '2026-09-30 16:00:00');
  assert.equal(workday.window.endText, '2026-10-08 16:00:00');
});

test('补完漏跑的正式报告后继续采集假期，正式截止不被假期覆盖', async t => {
  const root = await fixture(t, '2026-10-01', '2026-09-29');
  await finish(root);
  const d = await collectionContinuation({ root, now: oct2 });
  assert.equal(d.should_run, true);
  assert.equal(d.window.startText, '2026-09-30 16:00:00');
  assert.equal(d.window.endText, '2026-10-02 16:00:00');
  assert.equal(d.window.publishReport, false);
});

test('采集失败或证据上传失败不追加运行，不推进截止', async t => {
  for (const options of [{ monitorOutcome: 'failure' }, { artifactId: undefined }]) {
    const root = await fixture(t);
    assert.equal((await finish(root, options)).complete, false);
    const github = fakeGitHub();
    assert.equal((await dispatchCollectionContinuation({ root, now: oct2, github, context })).dispatched, false);
    assert.equal(github.calls.length, 0);
  }
});

test('截止未提交或最后结果属于别的区间，不能形成自动循环', async t => {
  const root = await fixture(t);
  await finish(root);
  await atomicWriteJson(path.join(root, 'state/daily_collection.json'), { last_collection_cutoff: '2026-09-30 16:00:00' });
  assert.equal((await collectionContinuation({ root, now: oct2 })).should_run, false);
  await finish(root);
  await atomicWriteJson(path.join(root, 'run/last-result.json'), { status: 'success', period: { end_inclusive: '2026-09-30 16:00:00' } });
  assert.equal((await collectionContinuation({ root, now: oct2 })).should_run, false);
});

test('重跑同一Actions任务发现已有后续运行，不重复dispatch', async t => {
  const root = await fixture(t), github = fakeGitHub();
  await finish(root);
  await dispatchCollectionContinuation({ root, now: oct2, github, context });
  const repeated = await dispatchCollectionContinuation({ root, now: oct2, github, context });
  assert.equal(repeated.dispatched, false);
  assert.match(repeated.url, /\/456$/);
  assert.equal(github.calls.length, 1);
});

test('dispatch结果未知时抛错，不自动重发或报告已完成采集', async t => {
  const root = await fixture(t), github = fakeGitHub();
  await finish(root);
  github.rest.actions.createWorkflowDispatch = async request => { github.calls.push(request); throw new Error('timeout'); };
  await assert.rejects(dispatchCollectionContinuation({ root, now: oct2, github, context }), /timeout/);
  assert.equal(github.calls.length, 1);
});
