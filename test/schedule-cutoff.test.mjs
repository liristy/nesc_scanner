import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scheduledReportDecision } from '../scripts/report-schedule-gate.mjs';

async function fixture(t, collectionCutoff = '2026-09-30 16:00:00') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-cutoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'state'));
  await fs.writeFile(path.join(root, 'state/current_tracking.json'), JSON.stringify({ last_success_cutoff: '2026-09-30 16:00:00' }));
  await fs.writeFile(path.join(root, 'state/daily_collection.json'), JSON.stringify({ last_collection_cutoff: collectionCutoff }));
  return root;
}

function fakeTime(text) {
  let now = new Date(text);
  const waits = [], logs = [];
  return { waits, logs, clock: () => now, log: message => logs.push(message),
    sleep: async ms => { waits.push(ms); now = new Date(now.getTime() + ms); } };
}

test('10月1日15:58:03提前触发，等到真实16:00再采集当天，正式报告截止不变', async t => {
  const root = await fixture(t), time = fakeTime('2026-10-01T15:58:03+08:00');
  const before = await fs.readFile(path.join(root, 'state/current_tracking.json'), 'utf8');
  const decision = await scheduledReportDecision({ root, event: 'push', ...time });
  assert.equal(time.waits.reduce((a, b) => a + b, 0), 117_000);
  assert.ok(time.waits.every(ms => ms > 0 && ms <= 60_000));
  assert.equal(decision.should_run, true);
  assert.equal(decision.window.endText, '2026-10-01 16:00:00');
  assert.equal(decision.window.startText, '2026-09-30 16:00:00');
  assert.equal(decision.window.publishReport, false);
  assert.match(time.logs[0], /提前触发.*等待至 2026-10-01 16:00:00/);
  assert.equal(await fs.readFile(path.join(root, 'state/current_tracking.json'), 'utf8'), before);
});

test('10月8日提前手动触发同样等待16:00，正式报告保留完整国庆区间', async t => {
  const root = await fixture(t, '2026-10-07 16:00:00'), time = fakeTime('2026-10-08T15:59:59+08:00');
  const decision = await scheduledReportDecision({ root, event: 'workflow_dispatch', ...time });
  assert.deepEqual(time.waits, [1000]);
  assert.equal(decision.should_run, true);
  assert.equal(decision.window.publishReport, true);
  assert.equal(decision.window.startText, '2026-09-30 16:00:00');
  assert.equal(decision.window.endText, '2026-10-08 16:00:00');
});

test('16:00后假期采集不等待，完成后重触发才跳过，并明确实际截止', async t => {
  const root = await fixture(t), time = fakeTime('2026-10-01T16:00:00+08:00');
  const first = await scheduledReportDecision({ root, event: 'push', ...time });
  assert.equal(first.should_run, true);
  assert.deepEqual(time.waits, []);
  await fs.writeFile(path.join(root, 'state/daily_collection.json'), JSON.stringify({ last_collection_cutoff: first.window.endText }));
  const repeated = await scheduledReportDecision({ root, event: 'push', ...time });
  assert.equal(repeated.should_run, false);
  assert.match(repeated.reason, /截至 2026-10-01 16:00:00.*当前北京时间/);
});

test('上午手动检查不长时间占用runner，也不提前查询未来截止', async t => {
  const root = await fixture(t), time = fakeTime('2026-10-01T10:00:00+08:00');
  const decision = await scheduledReportDecision({ root, event: 'workflow_dispatch', ...time });
  assert.deepEqual(time.waits, []);
  assert.equal(decision.window.endText, '2026-09-30 16:00:00');
  assert.equal(decision.should_run, false);
});
