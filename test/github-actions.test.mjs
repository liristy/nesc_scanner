import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { updateReadmeReport } from '../scripts/update-readme-report.mjs';
import { reportScheduleDecision } from '../scripts/report-schedule-gate.mjs';

test('README链接随实际日报日期更新；失败保留已有入口，正文不丢失，不生成不存在的链接', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-readme-test-'));
  await fs.mkdir(path.join(directory, 'reports'));
  const file = path.join(directory, 'README.md');
  await fs.writeFile(file, '# 报告\n\n部署说明保留\n');
  await updateReadmeReport(directory, { status: 'error' });
  assert.match(await fs.readFile(file, 'utf8'), /尚未生成/);
  for (const date of ['2026-09-24', '2026-09-25']) {
    await fs.writeFile(path.join(directory, 'reports', `${date}_JY报警监测日报.md`), '# 日报');
    await updateReadmeReport(directory, { status: 'success' });
    const readme = await fs.readFile(file, 'utf8');
    assert.ok(readme.includes(`查看最新日报（${date}）`));
    assert.ok(readme.includes(`reports/${encodeURIComponent(`${date}_JY报警监测日报.md`)}`));
    assert.ok(readme.endsWith('部署说明保留\n'));
    assert.equal(readme.split('<!-- daily-report:start -->').length, 2);
    assert.ok(!readme.includes('文字简报'));
  }
  await updateReadmeReport(directory, { status: 'error' });
  const readme = await fs.readFile(file, 'utf8');
  assert.match(readme, /查看最新日报（2026-09-25）/);
  assert.match(readme, /失败，当前链接可能为此前报告/);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const summaryScript = path.join(root, 'scripts/github-summary.mjs');

test('休息日采集状态单独保存，不覆盖正式报告状态、README或创建假期报告链接', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-collection-summary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'run'));
  await fs.mkdir(path.join(directory, 'reports'));
  const previous = JSON.stringify({ status: 'success', report_date: '2026-09-30' });
  await fs.writeFile(path.join(directory, 'reports/last-run.json'), previous);
  await fs.writeFile(path.join(directory, 'README.md'), '9月30日正式报告入口');
  await fs.writeFile(path.join(directory, 'run/last-result.json'), JSON.stringify({ status: 'success', mode: 'collection', collection_date: '2026-10-01', message: '每日采集与统计已完成' }));
  const env = { ...process.env, MONITOR_OUTCOME: 'success', GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md') };
  assert.equal(spawnSync(process.execPath, [summaryScript], { cwd: directory, env }).status, 0);
  assert.equal(spawnSync(process.execPath, [summaryScript, '--check'], { cwd: directory, env }).status, 0);
  assert.equal(await fs.readFile(path.join(directory, 'reports/last-run.json'), 'utf8'), previous);
  assert.equal(await fs.readFile(path.join(directory, 'README.md'), 'utf8'), '9月30日正式报告入口');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'reports/last-collection.json'))).collection_date, '2026-10-01');
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'summary.md'), 'utf8'), /20261001-160000/);
});

test('成功、部分完成、失败、超时均保存真实状态；不把进程成功误当数据完整', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-summary-test-'));
  await fs.mkdir(path.join(directory, 'run'));
  for (const [outcome, resultStatus, expected, exitCode] of [
    ['success', 'success', 'success', 0],
    ['success', 'partial_success', 'partial_success', 1],
    ['failure', 'error', 'error', 1],
    ['failure', 'success', 'error', 1],
    ['failure', null, 'error', 1],
    ['success', 'cancelled', 'error', 1],
  ]) {
    const resultPath = path.join(directory, 'run/last-result.json');
    if (resultStatus) await fs.writeFile(resultPath, JSON.stringify({ status: resultStatus, report_date: '2026-09-26', period: { start: '2026-09-25 16:00:00', end_exclusive: '2026-09-26 16:00:00' } }));
    else await fs.unlink(resultPath);
    const env = { ...process.env, MONITOR_OUTCOME: outcome, GITHUB_STEP_SUMMARY: path.join(directory, 'summary.md') };
    assert.equal(spawnSync(process.execPath, [summaryScript], { cwd: directory, env }).status, 0);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'reports/last-run.json'), 'utf8'));
    assert.equal(saved.status, expected);
    assert.equal(saved.report_date, resultStatus ? '2026-09-26' : null);
    assert.equal(saved.period?.end_exclusive ?? null, resultStatus ? '2026-09-26 16:00:00' : null);
    assert.equal(spawnSync(process.execPath, [summaryScript, '--check'], { cwd: directory, env }).status, exitCode);
  }
});

test('报告提交保留历史跟踪，排除原始数据和会话，兼容远端同时更新，无变化时不重复提交', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-publish-test-'));
  const remote = path.join(directory, 'remote.git');
  const workspace = path.join(directory, 'workspace');
  const other = path.join(directory, 'other');
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return result.stdout.trim();
  };
  git(directory, 'init', '--bare', remote);
  git(directory, 'init', '-b', 'main', workspace);
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(workspace, 'README.md'), 'Test repository\n');
  for (const name of ['reports', 'state', 'data', 'browser-profile']) await fs.mkdir(path.join(workspace, name));
  await fs.writeFile(path.join(workspace, 'state/current_tracking.json'), '{"items":[{"bms_number":"test-sn"}]}\n');
  git(workspace, 'add', 'README.md', 'state/current_tracking.json');
  git(workspace, 'commit', '-m', 'initial');
  git(workspace, 'remote', 'add', 'origin', remote);
  git(workspace, 'push', '-u', 'origin', 'main');
  git(directory, 'clone', '-b', 'main', remote, other);
  git(other, 'config', 'user.name', 'Test');
  git(other, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(other, 'README.md'), 'Concurrent documentation update\n');
  git(other, 'add', 'README.md');
  git(other, 'commit', '-m', 'update docs');
  git(other, 'push');
  await fs.writeFile(path.join(workspace, 'reports/error.md'), '本周期数据获取不完整\n');
  await fs.writeFile(path.join(workspace, 'state/daily_collection.json'), '{"last_collection_cutoff":"2026-10-01 16:00:00"}');
  await fs.writeFile(path.join(workspace, 'data/raw.json'), '{}');
  await fs.writeFile(path.join(workspace, 'browser-profile/session'), 'test-session');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const publish = () => {
    const result = spawnSync(bash, [path.join(root, 'scripts/publish-reports.sh').replaceAll('\\', '/')], {
      cwd: workspace, encoding: 'utf8', env: { ...process.env, REPORT_BRANCH: 'main', REPORT_REPOSITORY: '' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  publish();
  const files = git(directory, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main');
  assert.ok(files.includes('reports/error.md'));
  assert.ok(files.includes('state/current_tracking.json'));
  assert.ok(files.includes('state/daily_collection.json'));
  assert.ok(!files.includes('data/'));
  assert.ok(!files.includes('browser-profile/'));
  assert.equal((await fs.readFile(path.join(workspace, 'README.md'), 'utf8')).trim(), 'Concurrent documentation update');
  assert.match(git(directory, '--git-dir', remote, 'show', 'main:state/current_tracking.json'), /test-sn/);
  const head = git(workspace, 'rev-parse', 'HEAD');
  publish();
  assert.equal(git(workspace, 'rev-parse', 'HEAD'), head);
});
