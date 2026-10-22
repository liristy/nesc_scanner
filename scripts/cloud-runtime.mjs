import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWrite, atomicWriteJson, readJson } from '../src/utils.mjs';
import { effectiveState, reportScheduleDecision } from './report-schedule-gate.mjs';
import { checkpointName } from '../src/evidence-store.mjs';

const baselineFiles = ['state/current_tracking.json', 'reports/型号趋势历史.json', 'state/daily_collection.json'];
async function copyEvidence(from, to, pattern) {
  for (const entry of await fs.readdir(from, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    await fs.mkdir(to, { recursive: true });
    await fs.copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}
export async function prepare(root = '.', now = new Date(), event = process.env.GITHUB_EVENT_NAME) {
  const decision = await reportScheduleDecision({ root, now, event });
  if (!decision.should_run) throw new Error('本区间无需采集');
  const files = {};
  for (const name of baselineFiles) files[name] = await fs.readFile(path.join(root, name), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const pointer = await readJson(path.join(root, 'state/cloud-runtime.json'), {});
  await atomicWriteJson(path.join(root, 'run/cloud-baseline.json'), { files, window: decision.window, pointer });
  await atomicWriteJson(path.join(root, 'state/current_tracking.json'), effectiveState(JSON.parse(files[baselineFiles[0]] || '{}')));
  await atomicWriteJson(path.join(root, 'run/pending-audit.json'), decision.window);
  await atomicWriteJson(path.join(root, 'state/pending_audit.json'), decision.window);
  return pointer;
}
export async function importEvidence(root = '.') {
  // Restore data only; repository state remains the authoritative cutoff.
  await copyEvidence(path.join(root, 'run/restored/tracking'), path.join(root, '跟踪数据'), /^[a-f0-9]{64}\.json$/);
  await copyEvidence(path.join(root, 'run/restored/acquisition'), path.join(root, 'run/acquisition'), /^(?:(batch-|repair-|history-).+|manifest)\.json$/);
  await copyEvidence(path.join(root, 'run/restored/daily'), path.join(root, 'run/daily'), /^collection\.json$/);
}
export async function stageEvidence(root = '.') {
  await copyEvidence(path.join(root, '跟踪数据'), path.join(root, 'run/cloud-bundle/tracking'), /^[a-f0-9]{64}\.json$/);
  const directory=path.join(root,'run/acquisition');
  const manifest=await readJson(path.join(directory,'manifest.json'));
  let pattern=/^(?:(batch-|repair-|history-).+|manifest)\.json$/;
  if(manifest?.schema_version===1 && Array.isArray(manifest.devices) && manifest.devices.length &&
      manifest.devices.every(d=>typeof d.sn==='string' && d.file===checkpointName(d.sn))) {
    const ready=(await Promise.all(manifest.devices.map(d=>fs.stat(path.join(directory,d.file)).then(s=>s.isFile(),()=>false)))).every(Boolean);
    if(ready) {
      const keep=new Set(['manifest.json',...manifest.devices.map(d=>d.file)]);
      const completedHistory=new Set(manifest.devices.filter(d=>d.complete).map(d=>`history-${Buffer.from(d.sn).toString('hex')}.json`));
      // Old duplicates remain on disk until success, but need not be uploaded
      // again when every SN has a canonical raw file. Keep unfinished history.
      pattern={test:name=>keep.has(name)||/^history-[a-f0-9]+\.json$/.test(name)&&!completedHistory.has(name)};
    }
  }
  await copyEvidence(directory,path.join(root,'run/cloud-bundle/acquisition'),pattern);
  await copyEvidence(path.join(root, 'run/daily'), path.join(root, 'run/cloud-bundle/daily'), /^collection\.json$/);
  await atomicWriteJson(path.join(root, 'run/cloud-bundle/manifest.json'), { schema_version: 2, pending: await readJson(path.join(root, 'run/pending-audit.json')) });
}
export async function finalize(root = '.', { artifactId, runId, monitorOutcome, evidencePointer } = {}) {
  const baseline = await readJson(path.join(root, 'run/cloud-baseline.json'));
  if (!baseline) throw new Error('缺少本轮提交基线，停止发布');
  const result = await readJson(path.join(root, 'run/last-result.json'), {});
  const privateUpload = evidencePointer?.storage === 'release_asset' && evidencePointer.schema_version === 3 &&
    /^[1-9]\d*$/.test(String(evidencePointer.asset_id ?? '')) && /^[a-f0-9]{64}$/.test(evidencePointer.sha256 || '') &&
    evidencePointer.repository === process.env.REPORT_REPOSITORY && evidencePointer.size > 0;
  const uploaded = Boolean(privateUpload || /^\d+$/.test(String(artifactId ?? '')) && /^\d+$/.test(String(runId ?? '')));
  const complete = uploaded && monitorOutcome === 'success' && result.status === 'success';
  if (!complete) {
    for (const [name, contents] of Object.entries(baseline.files)) {
      if (contents === null) await fs.unlink(path.join(root, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      else await atomicWrite(path.join(root, name), contents);
    }
  }
  await atomicWriteJson(path.join(root, 'state/pending_audit.json'), complete ? null : baseline.window);
  if (uploaded) await atomicWriteJson(path.join(root, 'state/cloud-runtime.json'), privateUpload ? evidencePointer : { schema_version: 2, artifact_id: String(artifactId), run_id: String(runId) });
  if (!uploaded) await atomicWriteJson(path.join(root, 'run/last-result.json'), { ...result, status: 'error', message: `云端证据未保存成功；成功截止未推进，${baseline.window.auditPolicy==='current_day_pending'?'下次定时只核查当天，不补跑。':'下次重新补查。'}` });
  return { complete, previousArtifactId: uploaded ? baseline.pointer.artifact_id : null };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (mode === 'prepare') {
    const pointer = await prepare();
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${pointer.artifact_id || ''}\nrun_id=${pointer.run_id || ''}\n`);
  } else if (mode === 'import') await importEvidence();
  else if (mode === 'stage') await stageEvidence();
  else if (mode === 'finalize') {
    const evidencePointer = process.env.RUNTIME_UPLOAD_OUTCOME === 'success' ? await readJson('run/evidence-upload.json') : undefined;
    const result = await finalize('.', { artifactId: process.env.RUNTIME_ARTIFACT_ID, runId: process.env.GITHUB_RUN_ID, monitorOutcome: process.env.MONITOR_OUTCOME, evidencePointer });
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `previous_artifact_id=${result.previousArtifactId || ''}\n`);
  } else throw new Error('未知云端状态操作');
}
