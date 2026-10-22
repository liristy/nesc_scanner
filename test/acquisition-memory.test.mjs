import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { atomicWriteJson, readJson } from '../src/utils.mjs';
import { loadAcquisition } from '../src/audit-runner.mjs';
import { checkpointName, checkpointPath, hydrateEvidence } from '../src/evidence-store.mjs';
import { stageEvidence, importEvidence } from '../scripts/cloud-runtime.mjs';

const window={reportDate:'2026-10-04',endText:'2026-10-04 16:00:00'};
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-memory-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
const evidence={complete:true,historyComplete:false,records:[{time:'2026-10-04 16:00:00',minVoltage:'3.2',event:''}],detail:{detailVersion:2,bms:'F1-real'}};

test('64MB堆下恢复逐SN原始证据，跳过旧巨型整轮和重复历史检查点',async t=>{
  const root=await fixture(t);
  await atomicWriteJson(checkpointPath(root,'A'),{...window,snapshots:{A:{heartbeatTime:window.endText}},evidence:{A:evidence}});
  const giant=await fs.open(path.join(root,'run/acquisition/batch-report.json'),'w');
  try {
    await giant.write('{"padding":"');
    for(let i=0;i<80;i++)await giant.write('x'.repeat(1024*1024));
    await giant.write('"}');
  } finally {await giant.close();}
  const module=new URL('../src/audit-runner.mjs',import.meta.url).href;
  const probe=spawnSync(process.execPath,['--max-old-space-size=64','--input-type=module','-e',
    `import {loadAcquisition} from ${JSON.stringify(module)}; const result=await loadAcquisition(${JSON.stringify(root)},${JSON.stringify(window)},{compact:true}); console.log(JSON.stringify([...result.evidence]));`],{encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  const entries=JSON.parse(probe.stdout);
  assert.equal(entries.length,1);assert.equal(entries[0][1].records,undefined);
  assert.equal(entries[0][1].recordCount,1);assert.equal(entries[0][1].week.minVoltage,3.2);
  assert.deepEqual((await hydrateEvidence('A',entries[0][1])).records,evidence.records);
});

test('旧小批次兼容恢复，但不复用错误截止、失败证据或摘要自带的路径',async t=>{
  const root=await fixture(t);
  await atomicWriteJson(path.join(root,'run/acquisition/batch-0.json'),{...window,snapshots:{A:{}},evidence:{A:{...evidence,evidenceFile:'untrusted-path'},B:{...evidence,complete:false}}});
  const result=await loadAcquisition(root,window,{compact:true});
  assert.equal(result.evidence.size,1);
  assert.equal(result.evidence.get('A').evidenceFile,path.join(root,'run/acquisition/batch-0.json'));
  assert.equal((await loadAcquisition(root,{...window,endText:'2026-10-05 16:00:00'},{compact:true})).evidence.size,0);
  await fs.unlink(result.evidence.get('A').evidenceFile);
  await assert.rejects(hydrateEvidence('A',result.evidence.get('A')),/证据缺失/);
});

test('证据包只保存单份原始SN证据和失败历史，旧备份留在本地；缺少原始文件时保留旧备份',async t=>{
  const root=await fixture(t),dir=path.join(root,'run/acquisition');
  for(const sn of ['A','B'])await atomicWriteJson(checkpointPath(root,sn),{...window,evidence:{[sn]:evidence}});
  await atomicWriteJson(path.join(dir,'manifest.json'),{schema_version:1,devices:[{sn:'A',file:checkpointName('A'),complete:true},{sn:'B',file:checkpointName('B'),complete:false}]});
  for(const file of ['batch-report.json','batch-0.json','history-41.json','history-42.json'])await atomicWriteJson(path.join(dir,file),{kept:true});
  await stageEvidence(root);
  assert.deepEqual((await fs.readdir(path.join(root,'run/cloud-bundle/acquisition'))).sort(),[checkpointName('A'),checkpointName('B'),'history-42.json','manifest.json'].sort());
  assert.deepEqual(await readJson(path.join(dir,'batch-report.json')),{kept:true});
  await fs.mkdir(path.join(root,'run/restored'),{recursive:true});
  await fs.cp(path.join(root,'run/cloud-bundle/acquisition'),path.join(root,'run/restored/acquisition'),{recursive:true});
  await importEvidence(root);
  assert.equal((await loadAcquisition(root,window)).evidence.size,2);
  await fs.unlink(checkpointPath(root,'B'));await stageEvidence(root);
  assert.deepEqual(await readJson(path.join(root,'run/cloud-bundle/acquisition/batch-report.json')),{kept:true});
});
