const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
const duration = seconds => seconds == null ? '计算中' : `${Math.floor(seconds / 60)}分${Math.floor(seconds % 60)}秒`;
const bar = percent => `[${'█'.repeat(Math.floor(percent/5))}${'░'.repeat(20-Math.floor(percent/5))}]`;
export function recoveryPercent(r) {return r.total?Math.floor(Math.min(r.total,r.completed)/r.total*100):r.status==='completed'?100:0;}
export function recoverySummary(state) {
  const r=state.recovery;if(!r)return '';
  const md=value=>esc(value).replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
  const status=({running:'复查中',completed:'批次处理完成',incomplete:'复查未完整',interrupted:'复查中断'})[r.status] || r.status;
  return `### 报警恢复复查 · ${md(status)}\n\n\`\`\`text\n${bar(recoveryPercent(r))} 复查 ${recoveryPercent(r)}% ${r.completed}/${r.total}批\n\`\`\`\n\n已处理批次包含失败批次。\n\n`+
    `| 复查通过 | 失败待核实 | 尚未处理 | 因限额未查询 | 其他缺口 | 复查耗时 | 复查预计剩余 |\n| --- | --- | --- | --- | --- | --- | --- |\n`+
    `| ${r.succeeded} | ${r.failed} | ${Math.max(0,r.total-r.completed)} | ${r.skipped} | ${r.issues} | ${duration(r.elapsed_seconds)} | ${duration(r.estimated_remaining_seconds)} |\n\n`+
    `| 批次 | 查询日期 | 电池数 | SN | 操作 |\n| --- | --- | --- | --- | --- |\n`+
    ((r.active_batches ?? []).map(b=>`| ${b.batch} | ${md(b.date)} | ${b.sns.length} | ${md(b.sns.slice(0,3).join('、'))}${b.sns.length>3?'等':''} | ${md(b.stage)} |`).join('\n') || '| — | — | — | 当前无查询批次 | '+md(status)+' |')+
    (state.audit_policy==='current_day_pending'?'\n\n复查100%表示所有批次已处理；读取失败或缺口归入待确认，保存后随报告列出。\n\n':'\n\n复查100%表示所有批次已处理；失败或缺口未解决时仍不能完成本次任务。\n\n');
}

export function progressText(state) {
  const total = Math.max(0, state.total ?? 0), done = Math.min(total, Math.max(0, state.completed ?? 0));
  const percent = total ? Math.floor(done / total * 100) : 0, filled = Math.floor(percent / 5);
  const r=state.recovery;
  if(r && (r.active || state.phase==='recovery' || state.stage===r.stage))return `${bar(recoveryPercent(r))} 复查 ${recoveryPercent(r)}% ${r.completed}/${r.total}批 | ${state.stage} | 通过 ${r.succeeded} | 失败 ${r.failed} | 未处理 ${Math.max(0,r.total-r.completed)} | 复查耗时 ${duration(r.elapsed_seconds)} | 复查预计剩余 ${duration(r.estimated_remaining_seconds)}`;
  if(['saving','completed','retry'].includes(state.phase))return `${state.stage} | 设备已处理 ${done}/${total} | 待确认 ${state.pending_review_count ?? state.pending ?? state.failed ?? 0}${state.pending_verification_count!=null?'（超时待验证 '+state.pending_verification_count+'）':''} | 耗时 ${duration(state.elapsed_seconds)}`;
  return `[${'█'.repeat(filled)}${'░'.repeat(20 - filled)}] ${total ? `${percent}% ${done}/${total}` : state.collection_scope?.history_recovery_only>0?'本轮无需设备完整采集':'准备中'} | ${state.stage || '启动'} | 心跳完整 ${state.heartbeat_complete ?? state.succeeded ?? 0} | ${state.audit_policy==='current_day_pending'?'待确认':'待补查'} ${state.audit_policy==='current_day_pending'?(state.failed ?? 0):(state.pending ?? (total - done + (state.failed ?? 0)))} | 耗时 ${duration(state.elapsed_seconds)} | 预计剩余 ${duration(state.estimated_remaining_seconds)}`;
}

export function progressSummary(state) {
  return `## 采集进度\n\n${progressText(state)}\n\n状态：${esc(state.status)}；截止：${esc(state.cutoff || '待确定')}；更新：${esc(state.updated_at)}\n\n${recoverySummary(state)}${(state.active_workers ?? []).map(w => `- 通道 ${w.lane}：${esc(w.sn)} — ${esc(w.stage)}`).join('\n')}\n\n${state.error ? `错误：${esc(state.error)}\n` : ''}`;
}

export function progressPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>电池核查实时进度</title>
<style>body{font:16px system-ui;background:#f3f6fa;color:#182a40;margin:0}main{max-width:1000px;margin:48px auto;padding:24px}h1{font-size:28px}header{display:flex;justify-content:space-between;align-items:center}#status{padding:8px 16px;background:#e4edff;border-radius:20px}.panel{background:white;border:1px solid #dce4ed;border-radius:14px;padding:24px;margin:18px 0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:16px}.number{font-size:28px;font-weight:700;margin:6px 0}.muted{color:#526578}progress{width:100%;height:28px;accent-color:#2378d9}.lane{display:grid;grid-template-columns:80px 1fr;gap:16px;padding:16px 0;border-bottom:1px solid #edf0f4}.sn{font-family:monospace;overflow-wrap:anywhere}.error{color:#b42525;white-space:pre-wrap}#updated{font-size:14px}@media(max-width:600px){main{margin:12px auto;padding:12px}h1{font-size:21px}}</style>
<main><header><h1>电池核查实时进度</h1><span id="status">等待启动</span></header><p id="updated" class="muted">每2秒刷新</p>
<section class="panel"><h2 id="stage">读取进度…</h2><progress id="bar" max="100" value="0"></progress><p id="count" class="muted"></p><p id="scope" class="muted"></p><div class="metrics" id="metrics"></div></section>
<section class="panel" id="recovery" hidden><h2 id="recovery-title">报警恢复复查</h2><progress id="recovery-bar" max="100" value="0"></progress><p id="recovery-count" class="muted"></p><div id="recovery-metrics" class="metrics"></div><h3>正在复查的批次</h3><div id="recovery-batches"></div><p class="muted">批次处理完包含失败批次；有失败或缺口时，任务仍未完成。</p></section>
<section class="panel"><h2>正在处理</h2><div id="workers"></div></section><p id="error" class="error"></p><p class="muted">进度条表示电池核查覆盖量；100%后仍需完成恢复复查及保存。待补查包含未开始和已失败的电池。平台离线缺少实时电芯会保留复核标记，单独列入报告。</p></main>
<script>
const text=(id,value)=>document.getElementById(id).textContent=value??'';
const time=s=>s==null?'计算中':Math.floor(s/60)+'分'+Math.floor(s%60)+'秒';
function node(tag,value,cls){const n=document.createElement(tag);n.textContent=value;if(cls)n.className=cls;return n;}
async function refresh(){try{const r=await fetch('/progress.json',{cache:'no-store'});if(!r.ok)throw Error('等待采集程序启动');const s=await r.json();const total=s.total||0,done=Math.min(total,s.completed||0),pct=total?Math.floor(100*done/total):0;
text('status',({running:'运行中',completed:'已完成',error:'失败',cancelled:'已停止',skipped:'本次跳过'})[s.status]||s.status);text('stage',s.stage);text('count',total?pct+'% · 已核查 '+done+' / '+total+' 块电池':'准备统计范围');document.getElementById('bar').value=pct;
text('updated','统计截止 '+(s.cutoff||'待确定')+' · 最近更新 '+s.updated_at+' · 每2秒刷新');
const scope=s.collection_scope;text('scope',scope?'采集范围：当日报警 '+scope.current_window+' 块＋仅历史跟踪 '+scope.history_only+' 块＝合并去重 '+scope.total+' 块；已恢复且无独立风险免采集 '+scope.skipped_recovered_normal+' 块。':'');
if(scope&&scope.history_recovery_only!=null)text('scope',document.getElementById('scope').textContent+' 历史仅恢复复查 '+scope.history_recovery_only+' 块，不计入完整采集。'+(s.historical_pending_count!=null?'历史待确认 '+s.historical_pending_count+' 块。':''));
document.getElementById('bar').hidden=!!scope&&scope.total===0;if(scope&&scope.total===0)text('count','本轮无需设备完整采集；历史仅恢复复查 '+(scope.history_recovery_only||0)+' 块');
const metrics=document.getElementById('metrics');metrics.replaceChildren();for(const [k,v] of [['心跳完整',s.heartbeat_complete??s.succeeded??0],['设备证据缺口',s.failed??0],...(s.pending_verification_count!=null?[['超时待验证',s.pending_verification_count]]:[]),['尚未核查',Math.max(0,total-done)],['累计耗时',time(s.elapsed_seconds)],['预计剩余',time(s.estimated_remaining_seconds)]]){const n=node('div','');n.append(node('span',k,'muted'),node('p',v,'number'));metrics.append(n);}
const q=s.recovery;document.getElementById('recovery').hidden=!q;if(q){const pct=q.total?Math.floor(Math.min(q.total,q.completed)/q.total*100):q.status==='completed'?100:0;
text('recovery-title',q.stage+' · '+({running:'复查中',completed:'批次处理完成',incomplete:'复查未完整',interrupted:'复查中断'}[q.status]||q.status));document.getElementById('recovery-bar').value=pct;
text('recovery-count',pct+'% · 已处理 '+q.completed+' / '+q.total+' 批（含失败批次）');
const rm=document.getElementById('recovery-metrics');rm.replaceChildren();for(const [k,v] of [['复查通过',q.succeeded],['失败待核实',q.failed],['尚未处理',Math.max(0,q.total-q.completed)],['因限额未查询',q.skipped],['其他缺口',q.issues],['复查耗时',time(q.elapsed_seconds)],['复查预计剩余',time(q.estimated_remaining_seconds)]]){const n=node('div','');n.append(node('span',k,'muted'),node('p',v,'number'));rm.append(n);}
const rb=document.getElementById('recovery-batches');rb.replaceChildren();for(const b of q.active_batches||[]){const n=node('div','','lane'),d=node('div','');d.append(node('div',b.date+' · '+b.sns.length+'块 · '+b.sns.slice(0,3).join('、')+(b.sns.length>3?'等':''),'sn'),node('p',b.stage,'muted'));n.append(node('strong','批次 '+b.batch),d);rb.append(n);}if(!rb.children.length)rb.append(node('p',q.active?'正在准备查询页面':'本阶段无进行中的批次','muted'));}
const workers=document.getElementById('workers');workers.replaceChildren();for(const w of s.active_workers||[]){const n=node('div','','lane');const d=node('div','');d.append(node('div',w.sn,'sn'),node('p',w.stage,'muted'));n.append(node('strong','通道 '+w.lane),d);workers.append(n);}if(!workers.children.length)workers.append(node('p',s.status==='running'?'正在执行 '+s.stage:'当前无正在处理的设备','muted'));text('error',s.error||'');
}catch(e){text('error',e.message);}}refresh();setInterval(refresh,2000);
</script></html>`;
}
