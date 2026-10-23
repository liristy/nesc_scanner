import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzeLowVoltage, numericReading, EVIDENCE_DEFAULTS } from './evidence.mjs';
import { alarmTypeOf, parsePlatformDateTime, atomicWrite, atomicWriteJson, readJson, md } from './utils.mjs';

export const REPORT_FIELDS = [
  ['sn','SN 编码','text'], ['bms_software_version','BMS 软件版本','text'], ['alarm_type','保护项目','text'], ['record_count','报警记录数','number'],
  ['alarm_time','最新报警时间','text'], ['first_alarm_time','首次报警时间','text'], ['recovery_status','平台修复记录','text'],
  ['repair_time','修复时间','text'], ['processing_status','处理状态','text'], ['model','电池型号','text'],
  ['min_voltage','报警最低单体 / V','number'], ['max_voltage','报警最高单体 / V','number'], ['voltage_difference','报警压差 / V','number'],
  ['temperature','报警最高温度 / ℃','number'], ['mos_temperature','报警 MOS 温度 / ℃','number'],
  ['current','报警电流 / A','number'], ['total_voltage','报警总电压 / V','number'], ['soc','平台 SOC / %','number'],
  ['evidence','心跳采集情况','text'], ['low_status','低压采样判定','text'], ['latest_voltage','心跳最新最低单体 / V','number'],
  ['sampled_minutes','低压采样跨度 / 分钟','number'], ['low_reason','低压判定说明','text'], ['latest_telemetry','最新有效电压时间','text'],
].map(([key,label,type])=>({key,label,type}));
export const REPORT_MODULES = [ ['summary','统计摘要'], ['groups','分组统计'], ['low','低压采样核查'], ['details','SN 明细'], ['note','自定义说明'] ].map(([key,label])=>({key,label}));
export const BASE_TEMPLATE = {
  name:'我的重点日报', title:'{date} 电池重点监测报告', introduction:'本报告涉及 {snCount} 个 SN、{recordCount} 条报警记录。',
  scope:'today', alarmTypes:['单体压差过大','电量不足','@hot'], recovery:'unrepaired', snSearch:'', lowFilter:'all',
  minVoltage:null, maxVoltage:null, minDifference:null, minTemperature:null, filterRules:[],
  grouping:'sn_alarm', summaryGroup:'alarm_type', sortBy:'alarm_time', sortDirection:'desc', limit:0,
  fields:['sn','bms_software_version','alarm_type','record_count','alarm_time','min_voltage','voltage_difference','evidence'], labels:{},
  modules:['summary','groups','low','details','note'], note:'请优先核查上述设备。平台修复记录不等同于现场恢复证明。',
  theme:'teal', density:'comfortable', orientation:'landscape', automatic:false,
  overrideRule:false, threshold:2.5, duration:30,
};
export const PRESETS = [
  {key:'focus',name:'重点专项简报',description:'单体压差过大、电量不足 · 今日无有效修复记录',template:BASE_TEMPLATE},
  {key:'all',name:'全部保护报警',description:'查看整个统计周期，包含平台已记录修复的项目',template:{...BASE_TEMPLATE,name:'保护报警总览',title:'{date} 保护报警总览',scope:'window',alarmTypes:[],recovery:'all',modules:['summary','groups','details'],fields:['sn','alarm_type','record_count','alarm_time','recovery_status','min_voltage','temperature']}},
  {key:'low',name:'低压采样专项',description:'按 SN 去重，查看低压结论与数据限制',template:{...BASE_TEMPLATE,name:'低压采样专项',title:'{date} 低压采样核查',alarmTypes:['电量不足'],grouping:'sn',modules:['summary','low','details','note'],fields:['sn','low_status','latest_voltage','sampled_minutes','latest_telemetry','low_reason']}},
];
const fieldsByKey=new Map(REPORT_FIELDS.map(f=>[f.key,f]));
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const enumerate=(value,values,key)=>{if(!values.includes(value))throw new Error(`${key} 选项无效`);return value;};
function boundedText(value,key,max){if(typeof value!=='string'||value.length>max)throw new Error(`${key} 最多${max}个字符`);return value;}
export function validateTemplate(input={}) {
  const value={...BASE_TEMPLATE,...input}, result={};
  for(const key of ['name','title','introduction','note','snSearch']) result[key]=boundedText(value[key],key,key==='note'?5000:key==='introduction'?2000:key==='snSearch'?2000:100);
  for(const key of ['title','introduction','note']) templateText(result[key],Object.fromEntries(['date','snCount','recordCount','threshold','duration','cutoff'].map(k=>[k,''])));
  if(!result.name.trim()||!result.title.trim())throw new Error('请填写模板名称和报告标题');
  for(const [key,allowed] of Object.entries({scope:['today','window'],recovery:['all','unrepaired','repaired'],lowFilter:['all','meets','above','unknown'],grouping:['records','sn_alarm','sn'],summaryGroup:['alarm_type','alarm_date','model'],sortBy:REPORT_FIELDS.map(f=>f.key),sortDirection:['asc','desc'],theme:['teal','navy','sand'],density:['comfortable','compact'],orientation:['landscape','portrait']}))result[key]=enumerate(value[key],allowed,key);
  for(const [key,allowed,max] of [['fields',REPORT_FIELDS.map(f=>f.key),REPORT_FIELDS.length],['modules',REPORT_MODULES.map(f=>f.key),REPORT_MODULES.length]]){
    if(!Array.isArray(value[key])||!value[key].length||value[key].length>max||new Set(value[key]).size!==value[key].length||value[key].some(k=>!allowed.includes(k)))throw new Error(`${key} 至少选择一项，不可重复`);
    result[key]=[...value[key]];
  }
  if(!Array.isArray(value.alarmTypes)||value.alarmTypes.length>100)throw new Error('保护项目选择无效');
  result.alarmTypes=[...new Set(value.alarmTypes.map(v=>boundedText(v,'保护项目',100)))];
  result.labels={};
  if(!value.labels||typeof value.labels!=='object'||Array.isArray(value.labels))throw new Error('列名配置无效');
  for(const key of result.fields) if(Object.hasOwn(value.labels,key)) result.labels[key]=boundedText(value.labels[key],'列名',80).trim()||fieldsByKey.get(key).label;
  for(const key of ['minVoltage','maxVoltage','minDifference','minTemperature']){
    const v=value[key]; if(v!==null&&(!Number.isFinite(v)||Math.abs(v)>10000))throw new Error('数值筛选条件无效'); result[key]=v;
  }
  if(result.minVoltage!==null&&result.maxVoltage!==null&&result.minVoltage>result.maxVoltage)throw new Error('最低电压下限不能大于上限');
  if(!Number.isInteger(value.limit)||value.limit<0||value.limit>20000)throw new Error('明细行数应为0～20000的整数，0表示全部');
  result.limit=value.limit;
  if(!Array.isArray(value.filterRules)||value.filterRules.length>20)throw new Error('最多配置20条数值条件');
  result.filterRules=value.filterRules.map(r=>{
    if(!r||!REPORT_FIELDS.some(f=>f.key===r.field&&f.type==='number'&&f.key!=='record_count')||!['lt','lte','gt','gte','eq','neq'].includes(r.operator)||!Number.isFinite(r.value))throw new Error('数值条件无效');
    return {field:r.field,operator:r.operator,value:r.value};
  });
  for(const key of ['automatic','overrideRule']){if(typeof value[key]!=='boolean')throw new Error('开关配置无效');result[key]=value[key];}
  for(const [key,max] of [['threshold',5],['duration',1440]]){if(!Number.isFinite(value[key])||value[key]<=0||value[key]>max)throw new Error('低压判据无效');result[key]=value[key];}
  if(input.id!==undefined){if(!/^[a-zA-Z0-9-]{1,80}$/.test(input.id))throw new Error('模板标识无效');result.id=input.id;}
  return result;
}
function templateText(text,variables) {
  const unknown=[...text.matchAll(/\{([^{}]+)\}/g)].map(m=>m[1]).filter(k=>!Object.hasOwn(variables,k));
  if(unknown.length)throw new Error(`不支持的文字变量：${[...new Set(unknown)].join('、')}`);
  return text.replace(/\{([^{}]+)\}/g,(_m,key)=>String(variables[key]));
}
function normalize(raw,date,template) {
  const rule={...EVIDENCE_DEFAULTS,...raw.analysis_settings,...raw.today_focus?.analysisSettings};
  if(template.overrideRule){rule.lowVoltageThresholdV=template.threshold;rule.lowVoltageDurationMinutes=template.duration;}
  const cutoff=raw.period?.end_inclusive ?? raw.period?.end_exclusive;
  if(!parsePlatformDateTime(cutoff))throw new Error('原报告缺少有效统计截止时间');
  const lowCache=new Map();
  const getLow=sn=>{
    if(raw.today_heartbeat_evidence?.[sn]?.carried) {
      const old=raw.today_focus?.items.find(i=>i.sn===sn && i.lowVoltage)?.lowVoltage ?? {};
      const result={...old,confirmed:false,status:'证据不足',historical:true,
        reason:`历史资料截至${raw.today_heartbeat_evidence[sn].coverageCutoff || '未知'}；今日仅复查恢复，未重读心跳`};
      lowCache.set(sn,result);return result;
    }
    if(raw.audit_version===2 && !template.overrideRule) return raw.today_focus?.items.find(i=>i.sn===sn && i.lowVoltage)?.lowVoltage ?? {status:'证据不足',reason:'该对象无低压判断证据',sampledMinutes:0};
    if(!lowCache.has(sn))lowCache.set(sn,analyzeLowVoltage(raw.today_heartbeat_evidence?.[sn],{reportDate:date,endText:cutoff,...rule}));
    return lowCache.get(sn);
  };
  const types=template.alarmTypes;
  const snQueries=template.snSearch.trim().toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  const rows=(raw.records??[]).map(r=>{
    const alarm=parsePlatformDateTime(r.alarm_time), repair=parsePlatformDateTime(r.repair_time), end=parsePlatformDateTime(cutoff);
    const repaired=!!(repair&&alarm&&repair>=alarm&&repair<=end);
    return {...r,bms_software_version:(Object.hasOwn(r,'bms_software_version')?r.bms_software_version:r.bms_version) || '缺失待核实',sn:String(r.bms_number??''),alarm_type:alarmTypeOf(r.alarm),record_count:1,first_alarm_time:r.alarm_time,
      alarm_date:String(r.alarm_time).slice(0,10),repaired,recovery_status:repaired?'平台已有有效修复时间':'平台无有效修复时间',
      min_voltage:numericReading(r.min_cell_voltage_v),max_voltage:numericReading(r.max_cell_voltage_v),voltage_difference:numericReading(r.voltage_difference_v),
      temperature:numericReading(r.max_temperature_c),mos_temperature:numericReading(r.mos_temperature_c),current:numericReading(r.current_a),total_voltage:numericReading(r.total_voltage_v),soc:numericReading(r.soc)};
  }).filter(r=>{
    if(!r.sn||!parsePlatformDateTime(r.alarm_time)||(raw.audit_version===2?r.alarm_time>cutoff:r.alarm_time>=cutoff))return false;
    if(template.scope==='today'&&r.alarm_date!==date)return false;
    if(types.length&&!types.includes(r.alarm_type)&&!(types.includes('@hot')&&/高温|过温|温度过高/.test(r.alarm_type)))return false;
    if(template.recovery==='unrepaired'&&r.repaired||template.recovery==='repaired'&&!r.repaired)return false;
    if(snQueries.length&&!snQueries.some(q=>r.sn.toLowerCase().includes(q)))return false;
    if(template.minVoltage!==null&&(r.min_voltage===null||r.min_voltage<template.minVoltage))return false;
    if(template.maxVoltage!==null&&(r.min_voltage===null||r.min_voltage>=template.maxVoltage))return false;
    if(template.minDifference!==null&&(r.voltage_difference===null||r.voltage_difference<template.minDifference))return false;
    if(template.minTemperature!==null&&(r.temperature===null||r.temperature<template.minTemperature))return false;
    if(template.lowFilter!=='all'){
      const status=getLow(r.sn).status;
      if(status!=={meets:'低压采样满足分析条件',above:'最新采样未满足低压条件',unknown:'证据不足'}[template.lowFilter])return false;
    }
    return true;
  });
  for(const row of rows){
    const low=getLow(row.sn), evidence=raw.today_heartbeat_evidence?.[row.sn];
    Object.assign(row,{low_status:low.historical?'历史资料，今日未重读':{'低压采样满足分析条件':'符合采样判据','最新采样未满足低压条件':`最新电压≥${rule.lowVoltageThresholdV}V`,'证据不足':'暂无法确认'}[low.status],
      latest_voltage:low.minVoltage,sampled_minutes:low.sampledMinutes,low_reason:low.reason,latest_telemetry:low.latestTime,evidence:evidence?.carried?'历史资料，仅恢复复查':evidence?.complete?'已完整读取':evidence?'采集未完整':'未采集详细心跳'});
  }
  const filtered=rows.filter(row=>template.filterRules.every(r=>{
    const v=row[r.field];if(v===null||v===undefined||!Number.isFinite(v))return false;
    return {lt:()=>v<r.value,lte:()=>v<=r.value,gt:()=>v>r.value,gte:()=>v>=r.value,eq:()=>v===r.value,neq:()=>v!==r.value}[r.operator]();
  }));
  return {rows:filtered,rule,lowCache,cutoff};
}
function groupRows(rows,grouping) {
  if(grouping==='records')return rows;
  const groups=new Map();
  for(const row of rows){const key=grouping==='sn'?row.sn:`${row.sn}\0${row.alarm_type}`;const group=groups.get(key)??[];group.push(row);groups.set(key,group);}
  return [...groups.values()].map(list=>{
    const sorted=list.slice().sort((a,b)=>String(a.alarm_time).localeCompare(String(b.alarm_time)));
    const repaired=list.filter(r=>r.repaired).length;
    return {...sorted.at(-1),record_count:list.length,first_alarm_time:sorted[0].alarm_time,
      alarm_type:[...new Set(list.map(r=>r.alarm_type))].join('、'),
      recovery_status:repaired===list.length?'所选记录均有平台修复时间':repaired?'部分记录无平台修复时间':'平台无有效修复时间'};
  });
}
const valueText=v=>v===null||v===undefined||v===''?'—':typeof v==='number'?String(Number(v.toFixed(3))):String(v);
export function buildCustomReport(raw,date,input,{previewRows=0}={}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('报告日期无效');
  const template=validateTemplate(input);
  const {rows,rule,lowCache,cutoff}=normalize(raw,date,template);
  const sns=[...new Set(rows.map(r=>r.sn))];
  let displayed=groupRows(rows,template.grouping);
  const beforeLimit=displayed.length;
  const fieldType=fieldsByKey.get(template.sortBy).type;
  displayed.sort((a,b)=>{
    const av=a[template.sortBy],bv=b[template.sortBy];
    if(av==null&&bv!=null)return 1;if(bv==null&&av!=null)return -1;
    const cmp=fieldType==='number'?Number(av??0)-Number(bv??0):String(av??'').localeCompare(String(bv??''),'zh-CN');
    return (template.sortDirection==='desc'?-cmp:cmp)||a.sn.localeCompare(b.sn);
  });
  if(template.limit)displayed=displayed.slice(0,template.limit);
  const exportedRows=displayed.length;
  if(previewRows)displayed=displayed.slice(0,previewRows);
  const complete=sns.filter(sn=>raw.today_heartbeat_evidence?.[sn]?.complete).length;
  const low={meets:0,above:0,unknown:0};
  for(const sn of sns)low[{'低压采样满足分析条件':'meets','最新采样未满足低压条件':'above','证据不足':'unknown'}[lowCache.get(sn).status]]++;
  const variables={date,snCount:sns.length,recordCount:rows.length,threshold:rule.lowVoltageThresholdV,duration:rule.lowVoltageDurationMinutes,cutoff};
  const title=templateText(template.title,variables),introduction=templateText(template.introduction,variables),note=templateText(template.note,variables);
  const groups=new Map();
  for(const row of rows){const key=row[template.summaryGroup]||'未填写';const item=groups.get(key)??{name:key,count:0,sns:new Set()};item.count++;item.sns.add(row.sn);groups.set(key,item);}
  const groupItems=[...groups.values()].map(g=>({name:g.name,count:g.count,snCount:g.sns.size})).sort((a,b)=>b.count-a.count);
  const filterDescription=[template.scope==='today'?'今天首次发生的报警':'所选报告整个统计周期的报警',
    {all:'包含所有修复状态',unrepaired:'仅平台无有效修复时间',repaired:'仅平台有有效修复时间'}[template.recovery],
    template.alarmTypes.length?`项目：${template.alarmTypes.map(t=>t==='@hot'?'高温相关保护':t).join('、')}`:'全部保护项目',
    ...(template.snSearch?[`SN包含：${template.snSearch}`]:[]),
    ...(template.minVoltage!==null?[`报警最低单体≥${template.minVoltage}V`]:[]),...(template.maxVoltage!==null?[`报警最低单体<${template.maxVoltage}V`]:[]),
    ...(template.minDifference!==null?[`报警压差≥${template.minDifference}V`]:[]),...(template.minTemperature!==null?[`报警最高温度≥${template.minTemperature}℃`]:[]),
    ...template.filterRules.map(r=>`${fieldsByKey.get(r.field).label}${{lt:'<',lte:'≤',gt:'>',gte:'≥',eq:'=',neq:'≠'}[r.operator]}${r.value}`),
    ...(template.lowFilter!=='all'?[`低压判定：${{meets:'符合采样判据',above:'最新电压不低于阈值',unknown:'暂无法确认'}[template.lowFilter]}`]:[])].join('；');
  const quality=`数据说明：基于已保存报告，统计截止 ${cutoff}。所选${sns.length}个SN中，${complete}个已完整读取今日可见心跳，${sns.length-complete}个缺少完整心跳证据。数值筛选按所选字段分别使用报警读数或心跳分析结果；缺失值不当作0。心跳读取完整、单点电压或平台修复时间均不能单独证明设备已恢复。`;
  const columnNames=template.fields.map(k=>template.labels[k]||fieldsByKey.get(k).label);
  const htmlTable=(headers,body)=>`<div class="table-scroll"><table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${body.map(row=>`<tr>${row.map(v=>`<td>${escape(valueText(v))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${headers.length}">没有符合筛选条件的记录</td></tr>`}</tbody></table></div>`;
  const mdTable=(headers,body)=>['| '+headers.map(md).join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |',...body.map(row=>'| '+row.map(v=>md(valueText(v))).join(' | ')+' |')].join('\n');
  const detailBody=displayed.map(r=>template.fields.map(k=>r[k]));
  const lowText=`在所选${sns.length}个SN中，符合“最低单体低于${rule.lowVoltageThresholdV}V、连续可见采样至少${rule.lowVoltageDurationMinutes}分钟”判据的${low.meets}个；最新有效电压≥${rule.lowVoltageThresholdV}V的${low.above}个；其余${low.unknown}个暂无法确认。仅核查所选报告日期的心跳，相邻采样间隔不超过${rule.maxSampleGapMinutes}分钟，最新电压有效期${rule.maxEvidenceAgeMinutes}分钟。不能据此直接证明已触发低压保电。`;
  const displayedNote=`明细方式：${{records:'逐条报警记录',sn_alarm:'按SN＋保护项目合并',sn:'按SN合并'}[template.grouping]}；共${beforeLimit}行${template.limit?`，按配置保留前${exportedRows}行`:''}。${previewRows&&displayed.length<exportedRows?`当前仅预览前${displayed.length}行，导出包含${exportedRows}行。`:''}摘要统计始终基于全部筛选结果。合并后的测量值来自该组最新报警记录。`;
  const sections={
    summary:{title:'统计摘要',html:`<div class="metrics"><div><b>${sns.length}</b><span>去重 SN</span></div><div><b>${rows.length}</b><span>报警记录</span></div><div><b>${rows.filter(r=>r.repaired).length}</b><span>有平台修复时间的记录</span></div></div>`,text:`去重SN：${sns.length}个；报警记录：${rows.length}条；有平台有效修复时间：${rows.filter(r=>r.repaired).length}条。`},
    groups:{title:'分组统计',html:htmlTable(['分组','报警记录','去重SN'],groupItems.map(g=>[g.name,g.count,g.snCount])),text:mdTable(['分组','报警记录','去重SN'],groupItems.map(g=>[g.name,g.count,g.snCount]))},
    low:{title:'低压采样核查',html:`<p>${escape(lowText)}</p>`,text:lowText},
    details:{title:'SN 明细',html:`<p class="hint">${escape(displayedNote)}</p>${htmlTable(columnNames,detailBody)}`,text:displayedNote+'\n\n'+mdTable(columnNames,detailBody)},
    note:{title:'补充说明',html:`<p class="pre">${escape(note)}</p>`,text:note},
  };
  const accent={teal:'#137e70',navy:'#355585',sand:'#9c773d'}[template.theme];
  const css=`*{box-sizing:border-box}body{font:13px/1.85 'Microsoft YaHei UI','Segoe UI',sans-serif;color:#344c58;margin:0;background:#edf1f3}article{background:#fff;margin:24px auto;padding:38px;max-width:${template.orientation==='landscape'?'1120':'790'}px;min-height:700px;border-top:5px solid ${accent}}h1{font-size:25px;line-height:1.5;color:${accent};margin:0 0 10px}h2{font-size:16px;margin:28px 0 12px;padding-left:10px;border-left:3px solid ${accent}}p{overflow-wrap:anywhere}.eyebrow{letter-spacing:2px;font-size:10px;color:#96a5ac}.scope,.quality{background:#f5f8f9;border:1px solid #e4ebee;padding:12px 16px;border-radius:6px;font-size:11px}.quality{margin-top:28px}.pre{white-space:pre-wrap}.hint{font-size:11px;color:#8c9ba3}.metrics{display:flex;gap:12px}.metrics>div{flex:1;border:1px solid #e2e9ec;border-radius:8px;padding:15px}.metrics b{display:block;font-size:28px;color:${accent};font-weight:600}.metrics span{font-size:11px;color:#889ba4}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:${template.density==='compact'?'10':'11'}px}th{text-align:left;background:#f0f5f5;font-weight:600;white-space:nowrap}td,th{padding:${template.density==='compact'?'5px 7px':'9px 10px'};border:1px solid #e3e9ec;vertical-align:top;overflow-wrap:anywhere}footer{font-size:10px;color:#9aabb2;margin-top:20px}@media print{body{background:#fff}article{margin:0;padding:10px;max-width:none;min-height:0}.table-scroll{overflow:visible}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}}@page{size:A4 ${template.orientation};margin:12mm}`;
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escape(title)}</title><style>${css}</style></head><body><article><div class="eyebrow">JY MONITOR · CUSTOM REPORT</div><h1>${escape(title)}</h1><p class="pre">${escape(introduction)}</p><div class="scope">${escape(filterDescription)}</div>${template.modules.map(k=>`<section><h2>${sections[k].title}</h2>${sections[k].html}</section>`).join('')}<div class="quality">${escape(quality)}</div><footer>模板：${escape(template.name)} · 报告日期：${date} · 分析参数随本报告保存</footer></article></body></html>`;
  const markdown=[`# ${title}`,'',introduction,'',`统计口径：${filterDescription}`,'',...template.modules.flatMap(k=>[`## ${sections[k].title}`,'',sections[k].text,'']),quality].join('\n');
  return {html,markdown,template,summary:{recordCount:rows.length,snCount:sns.length,completeSN:complete,displayRows:exportedRows,previewRows:displayed.length,low},filterDescription,rule};
}

export async function loadTemplates(root) {
  const stored=await readJson(path.join(root,'report-templates.json'),{version:1,templates:[]});
  if(!Array.isArray(stored.templates))throw new Error('自定义模板文件格式无效');
  return stored.templates.map(validateTemplate);
}
export async function saveTemplate(root,input,{copy=false}={}) {
  const template=validateTemplate(input),templates=await loadTemplates(root);
  if(copy||!template.id)template.id=randomUUID();
  const index=templates.findIndex(t=>t.id===template.id);
  if(index<0){if(templates.length>=100)throw new Error('最多保存100个模板');templates.push(template);}else templates[index]=template;
  await atomicWriteJson(path.join(root,'report-templates.json'),{version:1,templates});
  return template;
}
export async function deleteTemplate(root,id) {
  if(!/^[a-zA-Z0-9-]{1,80}$/.test(id))throw new Error('模板标识无效');
  await atomicWriteJson(path.join(root,'report-templates.json'),{version:1,templates:(await loadTemplates(root)).filter(t=>t.id!==id)});
}
export async function exportCustomReport(root,raw,date,template) {
  const report=buildCustomReport(raw,date,template);
  const directory=path.join(root,'reports','custom',date);
  await fs.mkdir(directory,{recursive:true});
  const id=report.template.id||randomUUID();
  const basename=`${id}-${Date.now()}-${randomUUID().slice(0,8)}`;
  const htmlPath=path.join(directory,`${basename}.html`),markdownPath=path.join(directory,`${basename}.md`),settingsPath=path.join(directory,`${basename}.json`);
  await atomicWrite(htmlPath,report.html);await atomicWrite(markdownPath,report.markdown);
  await atomicWriteJson(settingsPath,{date,title:report.template.name,createdAt:new Date().toISOString(),template:report.template,summary:report.summary,rule:report.rule});
  return {date,name:report.template.name,htmlPath,markdownPath,settingsPath,summary:report.summary};
}
export async function generateAutomaticReports(root,raw,date) {
  const outputs=[],errors=[];
  let templates;
  try{templates=await loadTemplates(root);}catch(e){return {outputs,errors:[e.message]};}
  for(const template of templates.filter(t=>t.automatic)){
    try{outputs.push(await exportCustomReport(root,raw,date,template));}catch(e){errors.push(`${template.name}：${e.message}`);}
  }
  return {outputs,errors};
}
