import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepare, finalize, stageEvidence, importEvidence } from '../scripts/cloud-runtime.mjs';
import { reportScheduleDecision } from '../scripts/report-schedule-gate.mjs';
import { atomicWriteJson, readJson } from '../src/utils.mjs';
import { JYPlatform } from '../src/platform.mjs';
import { updateReadmeReport } from '../scripts/update-readme-report.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jy-cloud-'));
  await atomicWriteJson(path.join(root, 'github-config.json'), {});
  return root;
}
const now = new Date('2026-09-28T08:00:00Z');
const old = { last_success_cutoff: '2026-09-24 16:00:00', items: [{ sn: 'historical' }] };

test('主工作流不再强制历史测试日期，旧测试环境变量不能绕过法定日历',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/daily-report.yml',import.meta.url),'utf8');
  assert.doesNotMatch(workflow,/JY_TEST_FORCE|2026-09-27/);
  assert.equal((workflow.match(/ref: \$\{\{ github\.ref \}\}/g) || []).length,2);
  assert.match(workflow,/REPORT_BRANCH: \$\{\{ github\.ref_name \}\}/);
  assert.doesNotMatch(workflow,/upload-artifact|deleteArtifact|dispatchCollectionContinuation/);
  assert.match(workflow,/REPORT_REPOSITORY: liristy\/nesc_report/);
  const keys=['JY_TEST_FORCE_START','JY_TEST_FORCE_END','GITHUB_SHA'];
  const previous=keys.map(key=>process.env[key]);
  try {
    process.env.JY_TEST_FORCE_START='2026-09-26 16:00:00';process.env.JY_TEST_FORCE_END='2026-09-27 16:00:00';
    process.env.GITHUB_SHA='a00dfa84577026ed80e499fadeac68fae18462ee';
    const root=await fixture();
    const holiday=await reportScheduleDecision({root,now:new Date('2026-09-27T08:00:00Z'),event:'schedule'});
    assert.equal(holiday.should_run,true);
    assert.equal(holiday.window.publishReport,false);
    const d=await reportScheduleDecision({root,now,event:'workflow_dispatch'});
    assert.equal(d.window.endText,'2026-09-28 16:00:00');
    assert.equal(d.should_run,true);
  }finally{keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});}
});
test('迟到、跨午夜继续固定截止；成功去重；休息日和调休补班；漏跑连续覆盖', async () => {
  const root = await fixture();
  const decide = (time, event = 'schedule') => reportScheduleDecision({ root, now: new Date(time), event });
  assert.equal((await decide('2026-09-27T08:00:00Z')).window.publishReport, false);
  assert.equal((await decide('2026-09-20T08:00:00Z')).should_run, true);
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), old);
  for (const time of ['2026-09-28T08:45:00Z', '2026-09-28T10:30:00Z', '2026-09-28T13:48:00Z', '2026-09-28T17:00:00Z']) {
    const d = await decide(time);
    assert.equal(d.should_run, true);
    assert.equal(d.window.startText, old.last_success_cutoff);
    assert.equal(d.window.endText, '2026-09-28 16:00:00');
  }
  assert.equal((await decide('2026-09-28T07:59:59Z')).window.publishReport, false);
  await atomicWriteJson(path.join(root,'state/daily_collection.json'),{last_collection_cutoff:'2026-09-27 16:00:00'});
  assert.equal((await decide('2026-09-28T07:59:59Z')).should_run, false);
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), { ...old, last_success_cutoff: '2026-09-28 16:00:00' });
  assert.equal((await decide('2026-09-28T12:00:00Z')).should_run, false);
  assert.equal((await decide('2026-09-28T12:00:00Z', 'workflow_dispatch')).should_run, false);
  assert.equal((await decide('2026-10-08T12:00:00Z')).window.startText, '2026-09-28 16:00:00');
});
test('跨Actions失败续查同一截止；旧状态重验最后区间且保留全部对象', async () => {
  const root = await fixture();
  const legacy = { period: { start: '2026-09-24 16:00:00', end_exclusive: '2026-09-25 16:00:00' }, items: old.items };
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), legacy);
  await prepare(root, now);
  assert.deepEqual((await readJson(path.join(root, 'state/current_tracking.json'))).items, old.items);
  await finalize(root, { artifactId: '11', runId: '22', monitorOutcome: 'failure' });
  assert.deepEqual(await readJson(path.join(root, 'state/current_tracking.json')), legacy);
  const d = await reportScheduleDecision({ root, now: new Date('2026-09-30T09:00:00Z') });
  assert.equal(d.window.endText, '2026-09-28 16:00:00');
  assert.equal(d.window.startText, '2026-09-24 16:00:00');
});
test('证据上传失败回滚截止与趋势，上传并采集成功才推进，保留续查指针', async () => {
  const root = await fixture();
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), old);
  await atomicWriteJson(path.join(root, 'reports/型号趋势历史.json'), ['baseline']);
  await atomicWriteJson(path.join(root, 'state/cloud-runtime.json'), { artifact_id: '10', run_id: '20' });
  await prepare(root, now);
  const next = { ...old, last_success_cutoff: '2026-09-28 16:00:00',
    pending_reviews:[{sn:'OFFLINE',type:'单体压差过大',kind:'offline_cells',reason:'平台显示设备离线'}] };
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), next);
  await atomicWriteJson(path.join(root, 'reports/型号趋势历史.json'), ['new']);
  await atomicWriteJson(path.join(root, 'run/last-result.json'), { status: 'success' });
  assert.equal((await finalize(root, { monitorOutcome: 'success' })).complete, false);
  assert.deepEqual(await readJson(path.join(root, 'state/current_tracking.json')), old);
  assert.deepEqual(await readJson(path.join(root, 'reports/型号趋势历史.json')), ['baseline']);
  assert.equal((await readJson(path.join(root, 'state/cloud-runtime.json'))).artifact_id, '10');
  assert.equal((await readJson(path.join(root, 'run/last-result.json'))).status, 'error');
  await prepare(root, new Date('2026-09-29T10:00:00Z'));
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), next);
  await atomicWriteJson(path.join(root, 'run/last-result.json'), { status: 'success' });
  const result = await finalize(root, { artifactId: '11', runId: '21', monitorOutcome: 'success' });
  assert.equal(result.complete, true);
  assert.equal(result.previousArtifactId, '10');
  assert.deepEqual(await readJson(path.join(root, 'state/current_tracking.json')), next);
  assert.equal(await readJson(path.join(root, 'state/pending_audit.json')), null);
});
test('证据包只恢复原始证据和检查进度，不恢复会话或覆盖成功截止', async () => {
  const root = await fixture(), filename = 'a'.repeat(64) + '.json';
  await atomicWriteJson(path.join(root, 'run/restored/tracking', filename), { sn: 'A' });
  await atomicWriteJson(path.join(root, 'run/restored/acquisition/batch-report.json'), { pending: true });
  await atomicWriteJson(path.join(root, 'run/restored/acquisition/session.json'), { cookie: 'fixture' });
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), old);
  await importEvidence(root);
  await stageEvidence(root);
  assert.deepEqual(await readJson(path.join(root, '跟踪数据', filename)), { sn: 'A' });
  assert.deepEqual(await readJson(path.join(root, 'state/current_tracking.json')), old);
  assert.deepEqual(await fs.readdir(path.join(root, 'run/cloud-bundle/acquisition')), ['batch-report.json']);
  assert.deepEqual(await fs.readdir(path.join(root, 'run/cloud-bundle/tracking')), [filename]);
});
test('云端关闭浏览器不调用DPAPI或持久化Cookie', async () => {
  let closed = 0;
  const platform = new JYPlatform({ auditVersion: 2, runtime: 'github' }, { warn: () => assert.fail('不得尝试DPAPI') });
  platform.context = { storageState: () => assert.fail('不得导出会话'), close: async () => closed++ };
  platform.browser = { close: async () => closed++ };
  await platform.close();
  assert.equal(closed, 2);
});
test('新双报告有直接入口，未完整生成的后一期不掩盖前一期', async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, 'README.md'), '# 报告\n正文保留\n');
  for (const name of ['今日电池报警简报', '电池报警复核清单']) {
    await atomicWriteJson(path.join(root, 'reports/20260928-160000', name + '.md'), {});
  }
  await atomicWriteJson(path.join(root, 'reports/20260929-160000/今日电池报警简报.md'), {});
  await updateReadmeReport(root, { status: 'error' });
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /最新核查报告（2026-09-28）/);
  assert.match(readme, /今日电池报警简报/);
  assert.match(readme, /电池报警复核清单/);
  assert.match(readme, /正文保留/);
  for(const name of ['今日电池报警简报','电池报警复核清单'])await atomicWriteJson(path.join(root,'reports/20260928-163000',name+'.md'),{});
  await updateReadmeReport(root,{status:'success'});
  const shifted=await fs.readFile(path.join(root,'README.md'),'utf8');
  assert.match(shifted,/20260928-163000/);assert.doesNotMatch(shifted,/20260928-160000/);
});
