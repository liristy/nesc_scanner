import { md } from './utils.mjs';
import { shiftDay, AUDIT_CUTOFF_TEXT } from './calendar.mjs';
import { LOW_VOLTAGE_RULE, bmsSoftwareVersion } from './audit-rules.mjs';

const unique = rows => new Set(rows.map(r=>r.sn)).size;
export function buildTrends(alarms, window, history = [], complete = true) {
  const cutoffText=window.endText?.slice(11,19) || AUDIT_CUTOFF_TEXT;
  const cutoffTime=cutoffText.slice(0,5);
  const days = [];
  for (let date=window.startDate;date<=window.endDate;date=shiftDay(date,1)) {
    const end = `${date} ${cutoffText}`, start = `${shiftDay(date,-1)} ${cutoffText}`;
    if (end<=window.startText) continue;
    const subset = alarms.filter(a=>a.origin==='本区间新增' && a.time>start && a.time<=end && !a.excluded && !a.followupOnly);
    const groups = new Map();
    for (const a of subset) {const key=JSON.stringify([a.detail?.model || '型号缺失',a.type]); const g=groups.get(key) ?? new Set();g.add(a.sn);groups.set(key,g);}
    days.push({date,cutoffTime,complete:complete && start>=window.startText && end<=window.endText && subset.every(a=>a.detail?.model && a.difference?.status!=='待复核' && a.review?.kind!=='reading_pending'),
      groups:[...groups].map(([key,sns])=>({model:JSON.parse(key)[0],type:JSON.parse(key)[1],count:sns.size}))});
  }
  // Re-running the same window replaces that day's counts instead of adding them.
  const all = [...new Map([...history,...days].map(d=>[d.date,d])).values()].filter(d=>d.date>=shiftDay(window.endDate,-34) && d.date<=window.endDate).sort((a,b)=>a.date.localeCompare(b.date));
  const groups = days.flatMap(day=>day.groups.map(g=>{
    const baseline = all.filter(d=>d.date<day.date && d.date>=shiftDay(day.date,-30) && d.complete && (d.cutoffTime || '16:00')===cutoffTime).slice(-7);
    const average = baseline.length ? baseline.reduce((s,d)=>s+(d.groups.find(x=>x.model===g.model && x.type===g.type)?.count ?? 0),0)/baseline.length : null;
    const adequate = day.complete && g.model!=='型号缺失' && baseline.length>=3;
    const label = !adequate?'历史不足、型号缺失或覆盖不全':g.count>=3 && average===0?'新增集中出现':g.count>=3 && g.count>=average*3 && g.count-average>=3?'疑似突增':'未达突增阈值';
    return {...g,date:day.date,average,baselineDays:baseline.length,label};
  })).sort((a,b)=>b.count-a.count);
  return {history:all,groups};
}
export function buildAuditReports({window,alarms,recovered=[],warnings=[],trends,checkedAt,complete}) {
  const cutoffTime=(window.endText?.slice(11,19) || AUDIT_CUTOFF_TEXT).slice(0,5);
  const kept=alarms.filter(a=>!a.excluded && !a.followupOnly && !a.review?.recoveryPending), excluded=alarms.filter(a=>a.excluded);
  const reviews=alarms.filter(a=>a.review),reviewCount=unique(reviews);
  const timeoutCount=unique(reviews.filter(a=>a.review.status==='待验证'));
  const readingPending=window.auditPolicy==='current_day_pending';
  const reviewLabel=readingPending?'待确认':'离线电芯待复核';
  const completionText=reviewCount?`报告已生成，${reviewCount}块${readingPending?'待确认':'离线电池电芯待复核'}`:'核查完成';
  const low = [...new Map(alarms.filter(a=>a.lowVoltage).map(a=>[a.sn,a])).values()];
  const confirmed=low.filter(a=>!a.historicalReview && a.lowVoltage.confirmed), priority=low.filter(a=>!a.historicalReview && !a.lowVoltage.confirmed && a.lowVoltage.minVoltage!==null && a.lowVoltage.minVoltage<LOW_VOLTAGE_RULE.lowVoltageThresholdV);
  const historical=alarms.filter(a=>a.historicalReview),historicalRisks=low.filter(a=>a.historicalReview && (a.lowVoltage.historicalConfirmed || a.lowVoltage.minVoltage!==null && a.lowVoltage.minVoltage<2.8));
  const counts=[...new Set(kept.map(a=>a.type))].sort().map(type=>({type,count:kept.filter(a=>a.type===type).length,newCount:kept.filter(a=>a.type===type && a.origin==='本区间新增').length}));
  const brief=[`# 今日电池报警简报（${window.reportDate}）`,'',`统计区间：${window.startText}（不含）至${window.endText}（含）；${complete?completionText:'核查未完成，以下为暂存结果，成功截止未推进'}。`,'',
    '## 客户补电名单','',`已确认需补电：${confirmed.length}块；低于2.58V但尚未确认连续三天风险、需优先复核：${priority.length}块。`];
  for(const a of confirmed) brief.push(`- BMS：${md(a.detail?.bms || '缺失，需补录真实BMS')}；BMS软件版本：${md(bmsSoftwareVersion(a) || '缺失待核实')}；客户：${md(a.detail?.customer || '缺失待核实')}；最新有效最低电压：${a.lowVoltage.minVoltage}V（${a.lowVoltage.latestTime}）；证据跨度：${a.lowVoltage.spanHours.toFixed(1)}小时；待通知。`);
  if(historical.length)brief.push(`历史对象仅复查报警恢复：${unique(historical)}块；其中历史低压或已确认风险${historicalRisks.length}块，继续跟进。旧电压不作为今日最新电压，今日未重读心跳，不重新确认连续三天风险。`);
  for(const a of historicalRisks.filter(a=>a.lowVoltage.historicalConfirmed))brief.push(`- 历史已确认风险待跟进：BMS ${md(a.detail?.bms || '缺失')}；BMS软件版本 ${md(bmsSoftwareVersion(a) || '缺失待核实')}；客户 ${md(a.detail?.customer || '缺失待核实')}；上次电压${a.lowVoltage.minVoltage}V（${a.lowVoltage.latestTime || '时间未知'}）；${md(a.lowVoltage.notification || '待通知')}；今日未重读，需进一步复核。`);
  brief.push('','## 报警数量','',`共${counts.length}种、${kept.length}条，涉及${unique(kept)}块电池；本区间新增${kept.filter(a=>a.origin==='本区间新增').length}条，历史延续${kept.filter(a=>a.origin==='历史延续').length}条。`,
    ...counts.map(c=>`- ${md(c.type)}：${c.count}条（新增${c.newCount}，延续${c.count-c.newCount}）。`),
    `\n按同一电池、同一报警类型保留范围内最新一条未恢复记录；报警条数不等于实体故障数。压差读数越界另列复核${excluded.length}条，已恢复剔除${recovered.length}条。`,
    '', '## 同型号集中异常','');
  const highlighted=trends.groups.filter(g=>g.count>=3).slice(0,3);
  brief.push(...(highlighted.length?highlighted.map(g=>`- ${md(g.model)}／${md(g.type)}：${g.date}新增${g.count}块；${g.label}，历史日均${g.average===null?'暂无':g.average.toFixed(1)}块（${g.baselineDays}个有效日）。`):['未观察到单组新增达到3块的集中分布；历史是否充足以工程清单为准，不据此认定没有风险。']));
  brief.push('','## 工程重点','',`短路、高温相关保护${kept.filter(a=>/短路|高温|过温/.test(a.type)).length}条，优先核实现场工况和接线；低压证据不足及压差越界对象继续跟踪。`);
  if(timeoutCount)brief.push(`其中超时待验证：${timeoutCount}块，保留已取得证据，不计作完整或正常。`);
  if(warnings.length)brief.push(`数据缺口：${warnings.length}项，详见复核清单。`);
  if(reviewCount)brief.push(readingPending?`待确认：${reviewCount}块，读取失败原因已列入工程清单并保留跟踪；恢复状态未取得的记录不计入已核实未恢复数量；已核实报警仍保留，电压和风险不猜正常。`:`离线电芯待复核：${reviewCount}块，已保留跟踪，下次补读；对应未恢复压差报警暂保留统计，未判正常。`);
  if(window.initial)brief.push(readingPending?`本轮仅核查前一天${cutoffTime}至当天${cutoffTime}；更早存量只跟踪已有对象，不补跑历史区间。`:`首次按新规则核查：尚无成功截止基线，本轮从上一个法定工作日${cutoffTime}开始；更早存量仅覆盖已有跟踪对象。`);
  brief.push(`\n采集／复查完成时间：${checkedAt}。详情电芯和恢复状态可能晚于${cutoffTime}，不是${cutoffTime}现场快照。`);
  const engineer=[`# 电池报警复核清单（${window.reportDate}）`,'',`区间：(${window.startText}, ${window.endText}]；采集／复查：${checkedAt}。`,
    '同一电池同一报警类型保留最新未恢复记录；只统计厂商字段为JY的保护报警。忽略物联网模块已解绑、物联网卡号变更、BMS编号异常。',
    '补电默认细则：保护电量不足跨度≥72小时（连续三天），相邻间隔≤24小时且末条距截止≤24小时，段内无有效最低电压回升到2.8V，最新有效最低电压<2.58V，段内有进入低功耗事件。记录跨度不等于连续实时测量。',
    '', '## 读取缺口', '', ...(warnings.length?warnings.map(w=>`- ${md(w)}`):[readingPending && reviewCount?'当日报警覆盖已完成；对象读取与恢复状态缺口见待确认清单，不代表所有证据读取成功。':'报警覆盖、心跳读取与恢复复查已完成；对象级证据限制见下方。']),
    '', `## ${reviewLabel}`, '', ...(reviews.length?reviews.map(a=>`- ${md(a.sn)}／${md(a.type)}：${a.review.status==='待验证'?'待验证；':''}${md(a.review.reason)}；继续跟踪。`):['无。']),
    ''];
  for(const [title,objects] of [['正式统计及风险延续对象',alarms.filter(a=>!a.excluded)],['压差越界排除项（集中复核）',excluded]]) {
  engineer.push(`## ${title}`,'');
  if(!objects.length)engineer.push('无。','');
  if(title.startsWith('压差'))engineer.push('以下仅剔除对应的单体压差过大报警，同一电池其他保护仍保留。按约定统计规则处理，尚未通过现场检测确认故障原因。','');
  for(const a of objects) {
    const d=a.detail ?? {}, v=a.lowVoltage;
    engineer.push(`### ${md(a.sn)} · ${md(a.type)}`,'',`- 分类：${a.review?.kind==='reading_pending'?(a.review.status || '待确认'):a.followupOnly?'报警已恢复，风险继续复核':a.excluded?'压差排除待复核':'正式统计'}；${a.origin}；报警时间：${a.time}；厂商：JY。`,
      `- 基本信息BMS：${md(d.bms || '缺失')}；BMS软件版本：${md(bmsSoftwareVersion(a) || '缺失待核实')}；型号：${md(d.model || '缺失')}；客户／站点：${md(d.customer || '缺失')}／${md(d.site || '缺失')}。`,
      `- 平台详情：${d.url?`[打开电池详情](${d.url})`:'链接缺失'}；采集时间：${d.collectedAt || '缺失'}。`);
    if(a.historicalReview)engineer.push(`- 历史复核：今日仅查询原报警恢复状态；详情、电芯及心跳资料截至${a.historicalReview.lastEvidenceCutoff || '未知'}，未在今日重读。既有风险和读取缺口继续保留。`);
    if(d.customerError)engineer.push(`- 客户信息限制：${md(d.customerError)}；拥有者：${md(d.owner || '缺失')}，不代作客户。`);
    if(d.bmsSoftwareVersionError)engineer.push(`- BMS软件版本限制：${md(d.bmsSoftwareVersionError)}。`);
    if(d.cellsError)engineer.push(`- 电芯读取限制：${md(d.cellsError)}；未取得完整逐节电压，心跳证据单独核查。`);
    if(a.difference)engineer.push(`- 压差处理：${a.difference.status}，${a.difference.reason}；电芯读数：${(d.cells ?? []).map(c=>`${c.index}号=${c.voltage ?? '缺失'}V`).join('、') || '缺失'}。`);
    if(v)engineer.push(`- 低压结论：${v.status}；通知状态：${v.confirmed?'待通知':'待复核，未通知'}。`,
      `- 最低有效电压：${v.minimumVoltage ?? '缺失'}V；最新有效最低电压：${v.minVoltage ?? '缺失'}V（${v.latestTime || '缺失'}）。`,
      `- 报警证据跨度：${v.spanHours.toFixed(1)}小时（${v.start || '缺失'}—${v.end || '缺失'}）；历史覆盖：${v.coverage.from || '无'}—${v.coverage.to || '无'}。`,
      `- 进入低功耗：${v.lowPowerEvents.map(e=>e.time).join('、') || '未见'}；异常数据行：${v.abnormalCount}。`,
      `- 证据缺口：${v.gaps.join('；') || '满足默认连续三天细则，未作现场实测'}。`);
    engineer.push(`- 心跳索引：${md(a.evidenceIndex || '未取得')}；${md(a.evidenceSummary || '')}。`,'');
  }
  }
  engineer.push('## 已恢复剔除','',...recovered.map(a=>`- ${md(a.sn)}／${md(a.type)}；报警${a.time}，修复${a.repair}，复查${checkedAt}。`),'','## 同型号逐日完整分组','',
    `| 日期（前日${cutoffTime}至当日${cutoffTime}） | 型号 | 问题 | 新增电池数 | 历史日均 | 有效基线日 | 结论 |`,'|---|---|---|---:|---:|---:|---|',
    ...trends.groups.map(g=>`| ${g.date} | ${md(g.model)} | ${md(g.type)} | ${g.count} | ${g.average?.toFixed(1) ?? '无'} | ${g.baselineDays} | ${g.label} |`),
    '', '基线取此前30天最近7个同截止口径、完整且型号齐全的统计日，至少3日；单日≥3块、≥日均3倍且比日均至少多3块才提示疑似突增。日均为0且≥3块提示新增集中出现。历史延续量不参与新增突增判断。');
  return {brief:brief.join('\n')+'\n',engineer:engineer.join('\n')+'\n',confirmed:confirmed.length,counts,kept,low,reviewCount,completionText,oneLine:`已确认需补电${confirmed.length}块；未恢复保护${kept.length}条/${unique(kept)}块；低压优先复核${priority.length}块。${reviewCount?`${reviewLabel}${reviewCount}块，已保留跟踪。`:''}`};
}
export const escapeHtml = text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function reportHtml(markdown) {
  const inline = text=>escapeHtml(text).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2">$1</a>');
  const body=markdown.split('\n').map(line=>/^#{1,3} /.test(line)?`<h${line.indexOf(' ')}>${inline(line.slice(line.indexOf(' ')+1))}</h${line.indexOf(' ')}>`:`<div class="line">${inline(line) || '&nbsp;'}</div>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>JY电池日报</title><style>body{font:16px/1.7 'Microsoft YaHei',sans-serif;margin:36px auto;padding:0 24px;max-width:1100px;color:#22342f}h1{font-size:26px}h2{font-size:20px;border-bottom:1px solid #cddbd6;padding-bottom:8px}h3{font-size:17px}.line{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#08775b}</style>${body}</html>`;
}
