import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubProgress,githubProgressPublisher,githubProgressOutput,finalProgressState } from '../src/github-progress.mjs';
const env={GITHUB_REPOSITORY:'owner/repo',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',JY_PROGRESS_TOKEN:'fixture-secret',JY_PROGRESS_CHECK_ID:'42'};
const state={status:'running',stage:'并发采集',completed:4,total:10,succeeded:3,failed:1,elapsed_seconds:60,active_workers:[{lane:1,sn:'SN',stage:'第2页'}]};
test('原生GitHub进度入口使用受限API，不把凭据放入页面或输出',async()=>{
  let call;
  const check=await createGithubProgress(env,async(url,options)=>{call={url,options};return {ok:true,json:async()=>({id:42,html_url:'https://github.com/owner/repo/runs/42'})};});
  assert.equal(check.id,42);assert.equal(call.url,'https://api.github.com/repos/owner/repo/check-runs');assert.equal(call.options.redirect,'error');
  const body=JSON.parse(call.options.body);assert.equal(body.head_sha,env.GITHUB_SHA);assert.equal(body.status,'in_progress');assert.ok(!JSON.stringify(body).includes(env.JY_PROGRESS_TOKEN));
  await assert.rejects(createGithubProgress({...env,GITHUB_REPOSITORY:'https://elsewhere'},()=>{throw Error('should not call');}),/配置不完整/);
});
test('更新限频、顺序写入；采集结束后待发布，工作流最终结果才结束检查',async()=>{
  let clock=0;const bodies=[];
  const p=githubProgressPublisher(env,{now:()=>clock,fetchImpl:async(url,options)=>{bodies.push(JSON.parse(options.body));return {ok:true,json:async()=>({})};}});
  p.update(state);p.update({...state,completed:5});clock=15000;p.update({...state,completed:6});
  await p.finish({...state,status:'completed',completed:10},{terminal:false});
  assert.equal(bodies.length,3);assert.equal(bodies[0].status,'in_progress');assert.equal(bodies[1].output.title,'并发采集 · 6/10');assert.equal(bodies[2].status,'in_progress');
  assert.match(bodies[2].output.summary,/等待工作流上传证据和发布/);
  assert.doesNotMatch(bodies[2].output.summary,/还需完成恢复复查/);
  await p.finish({...state,status:'error',error:'证据保存失败'});assert.equal(bodies.at(-1).status,'completed');assert.equal(bodies.at(-1).conclusion,'failure');assert.match(bodies.at(-1).output.summary,/证据保存失败/);
  assert.doesNotMatch(bodies.at(-1).output.summary,/还需完成/);
  await p.finish({...state,status:'completed',completed:10});assert.match(bodies.at(-1).output.summary,/后续步骤已完成/);
});
test('进度API失败不阻塞采集，错误不暴露请求头，缺少临时令牌时不请求',async()=>{
  const warnings=[];const p=githubProgressPublisher(env,{onError:x=>warnings.push(x),fetchImpl:async()=>{throw Error('Authorization fixture-secret');}});
  p.update(state);await p.finish({...state,status:'cancelled'});assert.ok(warnings.length);assert.ok(warnings.every(x=>!x.includes('fixture-secret')));
  const disabled=githubProgressPublisher({...env,JY_PROGRESS_TOKEN:''},{fetchImpl:()=>{throw Error('should not call');}});disabled.update(state);await disabled.finish(state);
});
test('GitHub页面含进度条、统计表和当前设备，标记百分百仍须保存',()=>{
  const output=githubProgressOutput(state);assert.match(output.summary,/40% 4\/10/);assert.match(output.summary,/\| 1 \| SN \| 第2页 \|/);assert.match(output.summary,/保存和发布/);
  const scoped=githubProgressOutput({...state,collection_scope:{current_window:3,history_only:7,total:10,skipped_recovered_normal:2}});
  assert.match(scoped.summary,/当日报警 3 块＋仅历史跟踪 7 块＝合并去重 10 块/);
  assert.match(scoped.summary,/免采集 2 块/);
  const light=githubProgressOutput({...state,collection_scope:{current_window:10,history_only:0,total:10,skipped_recovered_normal:2,history_recovery_only:100},historical_pending_count:60});
  assert.match(light.summary,/历史仅恢复复查 100 块/);assert.match(light.summary,/历史待确认 60 块/);
});

test('GitHub复查标题与进度条使用批次数，设备100%仍能看到复查百分比和当前批次',()=>{
  const s={...state,completed:10,recovery:{active:true,status:'running',stage:'截止范围内报警恢复复查',total:20,completed:5,succeeded:4,failed:1,skipped:0,issues:0,elapsed_seconds:125,
    active_batches:[{batch:6,date:'2026-09-28',sns:['<script>bad</script>','SN-2'],stage:'查询|校验'}]}};
  const output=githubProgressOutput(s);
  assert.match(output.title,/复查 5\/20批/);assert.match(output.summary,/复查 25% 5\/20批/);
  assert.match(output.summary,/\| 4 \| 1 \| 15 \| 0 \| 0 \| 2分5秒 \|/);
  assert.match(output.summary,/2026-09-28/);assert.match(output.summary,/&lt;script&gt;/);assert.doesNotMatch(output.summary,/<script>/);
  s.recovery={...s.recovery,active:false,status:'incomplete',completed:20,failed:1,succeeded:19,active_batches:[]};
  assert.match(githubProgressOutput(s).summary,/复查未完整/);assert.match(githubProgressOutput(s).summary,/失败或缺口未解决/);
});

test('复查中断和完成后主进度不跳回设备100%，保存后不再提示重新复查',()=>{
  const s={...state,phase:'recovery',audit_policy:'current_day_pending',completed:10,stage:'截止范围内报警恢复复查',
    recovery:{active:false,status:'interrupted',stage:'截止范围内报警恢复复查',total:20,completed:5,succeeded:4,failed:1,skipped:0,issues:0,elapsed_seconds:125,active_batches:[]}};
  let output=githubProgressOutput(s);
  assert.match(output.summary.split('```')[1],/复查 25% 5\/20批/);
  assert.doesNotMatch(output.summary.split('```')[1],/设备采集|100%/);
  assert.match(output.summary,/缺口归入待确认/);
  output=githubProgressOutput({...s,phase:'saving',stage:'保存报告与滚动证据'});
  assert.match(output.summary.split('```')[1],/保存报告与滚动证据/);
  assert.doesNotMatch(output.summary.split('```')[1],/复查 25%|100%/);
  output=githubProgressOutput({...s,phase:'completed',status:'completed',stage:'核查完成，1块待确认'});
  assert.match(output.summary,/等待工作流上传证据和发布/);
  assert.doesNotMatch(output.summary,/还需完成恢复复查/);
  output=githubProgressOutput({...s,phase:'completed',status:'completed',stage:'核查完成，4块待确认',
    heartbeat_complete:9,succeeded:7,failed:3,pending:3,pending_review_count:4});
  assert.match(output.summary,/\| 10 \/ 10 \| 9 \| 3 \|/);
  assert.match(output.summary.split('```')[1],/待确认 4/);
});

test('收尾保留已完成阶段和超时待验证数，不把失败改写为完成',()=>{
  const pending={status:'completed',phase:'completed',stage:'核查完成，1块待验证',completed:2,total:2,
    heartbeat_complete:1,failed:1,pending_review_count:1,pending_verification_count:1};
  const done=finalProgressState(pending,{PROGRESS_OUTCOME:'success'});
  assert.equal(done.stage,pending.stage);assert.match(githubProgressOutput(done).summary,/超时待验证：1台/);
  const failed=finalProgressState({...pending,status:'error',stage:'证据保存失败'},{PROGRESS_OUTCOME:'success'});
  assert.equal(failed.status,'error');assert.equal(failed.stage,'证据保存失败');
  assert.equal(finalProgressState(pending,{PROGRESS_OUTCOME:'failure'}).status,'error');
  assert.equal(finalProgressState(pending,{PROGRESS_OUTCOME:'cancelled'}).status,'cancelled');
});
