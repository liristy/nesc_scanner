import { progressText,recoverySummary } from './progress-view.mjs';

const md = value => String(value ?? '').replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[ch]).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

export function finalProgressState(state = {}, env = process.env) {
  const outcome=env.PROGRESS_OUTCOME;
  const status=outcome==='cancelled'?'cancelled':env.COLLECTION_SHOULD_RUN==='false'?'skipped':
    outcome==='success' && state.status!=='error'?'completed':'error';
  const stage=state.status===status && state.stage ? state.stage :
    status==='completed'?'采集及后续步骤完成':status==='skipped'?'本周期已完成，无需重复采集':status==='cancelled'?'工作流已取消':'工作流未完整完成';
  return {...state,status,stage};
}
export function githubProgressOutput(state, {terminal=false,publicOnly=false}={}) {
  if (publicOnly) {
    const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
    const completed = number(state.completed), total = number(state.total);
    const stage = ({recovery:'恢复复查',saving:'私有保存',completed:'采集已结束'})[state.phase] || '采集处理中';
    const recovery = state.recovery;
    return { title: `${stage} · ${completed}/${total}`, summary:
      `设备已处理 ${completed}/${total}；心跳完整 ${number(state.heartbeat_complete ?? state.succeeded)}；待确认 ${number(state.failed)}；耗时 ${number(state.elapsed_seconds)} 秒。\n\n` +
      (recovery ? `恢复复查已处理 ${number(recovery.completed)}/${number(recovery.total)} 批；通过 ${number(recovery.succeeded)}；失败 ${number(recovery.failed)}。\n\n` : '') +
      (terminal ? '工作流已结束，结果与诊断保存在私有报告仓库。' : '仍需完成恢复复查、证据保存和私有仓库发布。') };
  }
  const total=state.total ?? 0, completed=state.completed ?? 0;
  const workers=(state.active_workers ?? []).map(w=>`| ${w.lane} | ${md(w.sn)} | ${md(w.stage)} |`).join('\n');
  const summary=`\`\`\`text\n${progressText(state)}\n\`\`\`\n\n**当前阶段：${md(state.stage)}**\n\n`+
    recoverySummary(state)+
    (state.collection_scope ? `采集范围：当日报警 ${state.collection_scope.current_window} 块＋仅历史跟踪 ${state.collection_scope.history_only} 块＝合并去重 ${state.collection_scope.total} 块；已恢复且无独立风险免采集 ${state.collection_scope.skipped_recovered_normal} 块。\n\n` : '')+
    (state.collection_scope?.history_recovery_only!=null?`历史仅恢复复查 ${state.collection_scope.history_recovery_only} 块，复用既有资料，不计入设备完整采集总数。${state.historical_pending_count!=null?`历史待确认 ${state.historical_pending_count} 块。`:''}\n\n`:'')+
    `| 设备已处理 / 总数 | 心跳完整 | ${state.audit_policy==='current_day_pending'?'设备待确认':'失败待补查'} | 尚未开始 | 耗时 |\n| --- | --- | --- | --- | --- |\n`+
    `| ${completed} / ${total} | ${state.heartbeat_complete ?? state.succeeded ?? 0} | ${state.failed ?? 0} | ${Math.max(0,total-completed)} | ${state.elapsed_seconds ?? 0}秒 |\n\n`+
    `| 通道 | 当前设备 | 处理阶段 |\n| --- | --- | --- |\n${workers || '| — | 当前无处理设备 | '+md(state.stage)+' |'}\n\n`+
    `统计截止：${md(state.cutoff || '待确定')}；最近更新：${md(state.updated_at)}。刷新此GitHub页面可读取最新进度。\n\n`+
    (terminal ? (state.status==='completed' ? '本次采集及工作流后续步骤已完成。' : '本次工作流已结束，最终结果见页面检查状态。') :
      state.status==='completed'?'核查与报告保存完成，等待工作流上传证据和发布。':state.phase==='saving'?'正在保存报告与滚动证据，随后发布。':'百分比仅代表当前阶段的处理量；本次任务还需完成恢复复查、保存和发布。')+
    (state.pending_verification_count!=null?'\n\n超时待验证：'+state.pending_verification_count+'台；保留缺口，不计作验证通过。':'')+
    (state.error?'\n\n错误：'+md(state.error).slice(0,1500):'');
  return {title:state.recovery && (state.recovery.active || state.phase==='recovery' || state.stage===state.recovery.stage)?`${state.stage} · 复查 ${state.recovery.completed}/${state.recovery.total}批`:`${state.stage || '准备'} · ${completed}/${total}`,summary};
}

function settings(env) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '') || !env.JY_PROGRESS_TOKEN) return null;
  return {repo:env.GITHUB_REPOSITORY,token:env.JY_PROGRESS_TOKEN};
}
async function request(settings, method, suffix, body, fetchImpl) {
  const response=await fetchImpl(`https://api.github.com/repos/${settings.repo}/check-runs${suffix}`,{
    method,redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Authorization:`Bearer ${settings.token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:JSON.stringify(body)});
  if(!response.ok)throw new Error(`GitHub进度更新失败：HTTP ${response.status}`);
  return response.json();
}

export async function createGithubProgress(env, fetchImpl=fetch) {
  const config=settings(env);
  if(!config || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ''))throw new Error('GitHub进度入口配置不完整');
  const data=await request(config,'POST','',{name:env.JY_PROGRESS_LABEL || 'JY采集实时进度',head_sha:env.GITHUB_SHA,status:'in_progress',
    external_id:`nesc-progress-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,started_at:new Date().toISOString(),
    output:githubProgressOutput({stage:'等待采集任务启动',total:0,completed:0},{publicOnly:env.JY_PUBLIC_RUN==='true'})},fetchImpl);
  if(!Number.isInteger(data.id) || typeof data.html_url!=='string' || !data.html_url.startsWith(`https://github.com/${config.repo}/`))throw new Error('GitHub返回的进度入口无效');
  return {id:data.id,url:data.html_url};
}

export function githubProgressPublisher(env=process.env,{fetchImpl=fetch,intervalMs=15000,now=Date.now,onError=()=>{}}={}) {
  const config=settings(env),id=env.JY_PROGRESS_CHECK_ID;
  if(!config || !/^\d+$/.test(id || ''))return {update(){},async finish(){}};
  let latest,lastSent=-Infinity,inflight=Promise.resolve();
  const send=(state,conclude=false)=>{
    const terminal=conclude && state.status && state.status!=='running';
    const body={output:githubProgressOutput(state,{terminal,publicOnly:env.JY_PUBLIC_RUN==='true'}),status:terminal?'completed':'in_progress'};
    if(terminal){body.completed_at=new Date().toISOString();body.conclusion=({completed:'success',error:'failure',cancelled:'cancelled',skipped:'neutral'})[state.status] || 'failure';}
    return request(config,'PATCH',`/${id}`,body,fetchImpl).catch(error=>onError(error.message.startsWith('GitHub进度')?error.message:'GitHub进度暂时无法更新，采集继续'));
  };
  return {
    update(state){
      latest={...state};
      if(now()-lastSent < intervalMs)return;
      lastSent=now(); const snapshot=latest; inflight=inflight.then(()=>send(snapshot));
    },
    async finish(state,{terminal=true}={}){await inflight;await send({...state},terminal);},
  };
}
