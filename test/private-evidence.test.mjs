import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { privateStore, restoreEvidence, saveEvidence } from '../scripts/private-evidence.mjs';
import { prepare, finalize } from '../scripts/cloud-runtime.mjs';
import { atomicWriteJson, readJson } from '../src/utils.mjs';
import { githubProgressOutput } from '../src/github-progress.mjs';

const env = {REPORT_REPOSITORY:'owner/private',GITHUB_REPOSITORY:'owner/public',REPORT_REPO_TOKEN:'fixture-secret',
  REPORT_BRANCH:'main',GITHUB_RUN_ID:'101',GITHUB_RUN_ATTEMPT:'1'};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'scanner-private-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true})); return root;
}
test('公开仓库及同仓配置均拒绝写入；下载签名URL不携带令牌',async()=>{
  assert.throws(()=>privateStore({...env,REPORT_REPOSITORY:env.GITHUB_REPOSITORY}),/配置不完整/);
  await assert.rejects(privateStore(env,async()=>({ok:true,status:200,json:async()=>({private:false,full_name:env.REPORT_REPOSITORY})})).verify(),/私有仓库/);
  const calls=[];
  const store=privateStore(env,async(url,options)=>{
    calls.push({url,options});
    return calls.length===1 ? {status:302,headers:new Map([['location','https://release-assets.githubusercontent.com/asset?sig=fixture']])}
      : {ok:true,arrayBuffer:async()=>new Uint8Array([1,2]).buffer};
  });
  assert.deepEqual(await store.call('/releases/assets/1',{binary:true}),Buffer.from([1,2]));
  assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-secret');
  assert.equal(calls[1].options.headers,undefined);
});
test('旧私有Actions附件恢复兼容，错误来源及路径不能导入',async t=>{
  const root=await fixture(t);
  await atomicWriteJson(path.join(root,'state/cloud-runtime.json'),{artifact_id:'12',run_id:'34'});
  const zip=new JSZip();zip.file(`tracking/${'a'.repeat(64)}.json`,'{"complete":true}');
  let wrong=false;
  const store={verify:async()=>{},call:async(suffix)=>suffix.endsWith('/zip')?zip.generateAsync({type:'nodebuffer'}):
    {name:'jy-audit-runtime-34',workflow_run:{id:wrong?35:34},expired:false}};
  assert.equal((await restoreEvidence(root,store)).count,1);
  wrong=true;await assert.rejects(restoreEvidence(root,store),/来源或有效期/);wrong=false;
  zip.file('../state/current_tracking.json','{}');await assert.rejects(restoreEvidence(root,store),/未授权路径/);
});
test('私有证据上传后必须回读校验；备份失败不允许提交成功截止',async t=>{
  const root=await fixture(t);
  await atomicWriteJson(path.join(root,'run/cloud-bundle/manifest.json'),{schema_version:2});
  await atomicWriteJson(path.join(root,'reports/report.json'),{fixture:true});
  const uploads=[];let corrupted=false,failBackup=false;
  const store={repository:env.REPORT_REPOSITORY,verify:async()=>{},call:async(suffix,options={})=>{
    if(suffix.startsWith('/git/ref/'))return {object:{sha:'a'.repeat(40)}};
    if(suffix==='/releases')return {id:50};
    if(options.upload){
      if(failBackup&&suffix.includes('reports-and'))throw Error('backup failed');
      uploads.push(options.body);return {id:uploads.length,state:'uploaded',size:options.body.length};
    }
    const assetId = Number(suffix.split('/').at(-1));
    return corrupted?Buffer.from('corrupt'):uploads[assetId-1];
  }};
  const pointer=await saveEvidence(root,{env,store});
  assert.equal(pointer.storage,'release_asset');
  assert.equal(pointer.sha256,createHash('sha256').update(uploads[0]).digest('hex'));
  await atomicWriteJson(path.join(root,'state/cloud-runtime.json'),pointer);
  assert.equal((await restoreEvidence(root,store)).count,1);
  corrupted=true;await assert.rejects(saveEvidence(root,{env,store}),/上传校验/);corrupted=false;
  failBackup=true;await assert.rejects(saveEvidence(root,{env,store}),/backup failed/);
});
test('新私有指针保存与截止回滚，未确认上传不取代旧证据',async t=>{
  const root=await fixture(t);
  await atomicWriteJson(path.join(root,'github-config.json'),{auditPolicy:'current_day_pending'});
  await atomicWriteJson(path.join(root,'state/current_tracking.json'),{last_success_cutoff:'2026-10-21 16:00:00'});
  await atomicWriteJson(path.join(root,'state/cloud-runtime.json'),{artifact_id:'12',run_id:'34'});
  await prepare(root,new Date('2026-10-22T09:00:00Z'));
  await atomicWriteJson(path.join(root,'run/last-result.json'),{status:'success'});
  await atomicWriteJson(path.join(root,'state/current_tracking.json'),{last_success_cutoff:'2026-10-22 16:00:00'});
  assert.equal((await finalize(root,{monitorOutcome:'success'})).complete,false);
  assert.equal((await readJson(path.join(root,'state/current_tracking.json'))).last_success_cutoff,'2026-10-21 16:00:00');
  assert.equal((await readJson(path.join(root,'state/cloud-runtime.json'))).artifact_id,'12');
  const before=process.env.REPORT_REPOSITORY;process.env.REPORT_REPOSITORY=env.REPORT_REPOSITORY;
  try {
    await prepare(root,new Date('2026-10-22T09:00:00Z'));
    await atomicWriteJson(path.join(root,'run/last-result.json'),{status:'success'});
    const pointer={schema_version:3,storage:'release_asset',repository:env.REPORT_REPOSITORY,asset_id:'99',sha256:'a'.repeat(64),size:123};
    assert.equal((await finalize(root,{monitorOutcome:'success',evidencePointer:pointer})).complete,true);
    assert.deepEqual(await readJson(path.join(root,'state/cloud-runtime.json')),pointer);
  } finally {if(before===undefined)delete process.env.REPORT_REPOSITORY;else process.env.REPORT_REPOSITORY=before;}
});
test('公开进度仅显示数值，SN、客户、恢复批次和异常原文不能外泄',()=>{
  const output=githubProgressOutput({stage:'客户 Secret SN123',phase:'recovery',error:'cookie=Secret',completed:3,total:5,
    active_workers:[{sn:'SN123'}],recovery:{completed:1,total:2,active_batches:[{sns:['SN123']}]},
    customer:'Secret'}, {publicOnly:true});
  assert.doesNotMatch(JSON.stringify(output),/Secret|SN123|cookie/);
  assert.match(output.summary,/3\/5/);assert.match(output.summary,/1\/2/);
});
