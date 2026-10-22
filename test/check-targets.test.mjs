import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readOnlyCheckTargets } from '../scripts/check-targets.mjs';

test('只读验收名单读取私有跟踪状态，去重限两台且不猜测BMS或缺失SN',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'scanner-check-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'state'));
  await assert.rejects(readOnlyCheckTargets(root),/状态缺失/);
  await fs.writeFile(path.join(root,'state/current_tracking.json'),JSON.stringify({items:[
    {bms_number:'BMS-ONLY'},{sn:'invalid/id'},{sn:'SN-A'},{sn:'SN-A'},{sn:'SN-B'},{sn:'SN-C'},
  ]}));
  assert.deepEqual(await readOnlyCheckTargets(root),['SN-A','SN-B']);
  await fs.writeFile(path.join(root,'state/current_tracking.json'),JSON.stringify({items:[{bms_number:'BMS-ONLY'}]}));
  await assert.rejects(readOnlyCheckTargets(root),/不能猜测/);
});

test('本地显式只读名单仍限制有效SN和最多五台，公开工作流不传设备Secret或输入',async()=>{
  assert.deepEqual(await readOnlyCheckTargets('.', 'SN-A SN-B SN-A'),['SN-A','SN-B']);
  await assert.rejects(readOnlyCheckTargets('.', 'SN-A invalid/id'),/有效SN/);
  await assert.rejects(readOnlyCheckTargets('.', 'A B C D E F'),/有效SN/);
  const workflow=await fs.readFile(new URL('../.github/workflows/heartbeat-check.yml',import.meta.url),'utf8');
  assert.doesNotMatch(workflow,/secrets\.JY_CHECK_SNS|inputs\.sns/);
});
