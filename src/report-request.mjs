import { validateTemplate, REPORT_FIELDS } from './custom-report.mjs';

// A local, explicit rules parser. It never executes user text or invents data.
// Unconsumed conditions are shown to the user before applying the configuration.
export function parseReportRequest(text,current,{date,dates=[]}={}) {
  if(typeof text!=='string'||!text.trim()||text.length>3000)throw new Error('请输入1～3000字的报告需求');
  const template=validateTemplate(current),recognized=[],warnings=[];
  if(/排除|不看|不要|除了|或者/.test(text)) return {template,date,recognized:[],warnings:['这段需求包含暂不支持的排除或复杂逻辑，尚未应用任何变更。请在设计器中勾选需要保留的项目，或分开描述条件。']};
  let remaining=text,requestedDate=date;
  const consume=(regex,fn)=>{remaining=remaining.replace(regex,(...args)=>{fn?.(...args);return ' ';});};
  const set=(key,value,label)=>{template[key]=value;recognized.push(label);};
  consume(/\b(20\d{2}-\d{2}-\d{2})\b/g,(_m,value)=>{if(dates.includes(value)){requestedDate=value;recognized.push(`报告日期：${value}`);}else warnings.push(`没有 ${value} 的已保存数据，未切换日期。`);});
  consume(/(?:整个|全部|本)(?:统计)?周期/g,()=>set('scope','window','范围：所选报告整个周期'));
  consume(/今天|今日|本日/g,()=>set('scope','today','范围：今天首次发生'));
  consume(/未修复|无修复记录|没有修复记录|不含已修复/g,()=>set('recovery','unrepaired','状态：平台无有效修复时间'));
  consume(/未恢复/g,()=>{set('recovery','unrepaired','状态：平台无有效修复时间');warnings.push('“未恢复”按平台无有效修复时间筛选，不等同于设备当前实际异常。');});
  consume(/包含已修复|含已修复|所有修复状态/g,()=>set('recovery','all','状态：包含全部修复状态'));
  consume(/已修复|有修复记录/g,()=>set('recovery','repaired','状态：平台有有效修复时间'));
  const ruleMatch=remaining.match(/(?:单体(?:电压)?|电压)?\s*(?:低于|小于|<)\s*(\d+(?:\.\d+)?)\s*[vV伏]?\s*(?:且|并)?\s*(?:维持|持续|保持|连续)(?:至少)?\s*(\d+(?:\.\d+)?)\s*(?:分钟|分|min)/);
  if(ruleMatch){template.overrideRule=true;template.threshold=Number(ruleMatch[1]);template.duration=Number(ruleMatch[2]);template.lowFilter='meets';recognized.push(`筛选符合低压采样判据的SN：<${template.threshold}V，至少${template.duration}分钟`);remaining=remaining.replace(ruleMatch[0],' ');}
  const numericFields=[['心跳最新最低单体电压|心跳最低电压|最新最低电压','latest_voltage'],['最低单体电压|最低电压','min_voltage'],['最高单体电压|最高电压','max_voltage'],['单体压差|压差','voltage_difference'],['MOS温度|MOS 温度','mos_temperature'],['最高温度|温度','temperature'],['低压持续时间|采样跨度','sampled_minutes']];
  for(const [words,field]of numericFields){
    const regex=new RegExp(`(?:${words})\\s*(大于等于|小于等于|不低于|不高于|至少|超过|高于|大于|低于|小于|等于|>=|<=|≥|≤|>|<|=)\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:[vV伏℃]|分钟|分)?`,'g');
    consume(regex,(_m,operator,number)=>{
      const op=({'大于等于':'gte','不低于':'gte','至少':'gte','>=':'gte','≥':'gte','小于等于':'lte','不高于':'lte','<=':'lte','≤':'lte','超过':'gt','高于':'gt','大于':'gt','>':'gt','低于':'lt','小于':'lt','<':'lt','等于':'eq','=':'eq'})[operator];
      template.filterRules.push({field,operator:op,value:Number(number)});recognized.push(`${REPORT_FIELDS.find(f=>f.key===field).label} ${operator} ${number}`);
    });
  }
  consume(/暂无法确认|证据不足/g,()=>set('lowFilter','unknown','低压判定：暂无法确认'));
  consume(/符合低压判据|满足低压条件/g,()=>set('lowFilter','meets','低压判定：符合采样判据'));
  consume(/(?:按)?\s*SN\s*(?:去重|汇总|合并)/gi,()=>set('grouping','sn','明细：按SN合并'));
  consume(/(?:按)?\s*SN\s*(?:和|加|\+)\s*(?:报警类型|保护项目)\s*(?:去重|汇总|合并)/gi,()=>set('grouping','sn_alarm','明细：按SN＋保护项目合并'));
  consume(/逐条(?:显示|报警|记录)?|不去重/g,()=>set('grouping','records','明细：逐条报警记录'));
  consume(/按(?:报警类型|保护项目)分组/g,()=>set('summaryGroup','alarm_type','分组统计：保护项目'));
  consume(/按(?:报警)?日期分组/g,()=>set('summaryGroup','alarm_date','分组统计：报警日期'));
  consume(/按(?:电池)?型号分组/g,()=>set('summaryGroup','model','分组统计：电池型号'));
  consume(/(?:只显示|保留|前)\s*(\d+)\s*(?:行|条)/g,(_m,count)=>set('limit',Number(count),`明细最多${count}行`));
  consume(/(?:电压)?从低到高|升序/g,()=>{template.sortBy='min_voltage';set('sortDirection','asc','按报警最低单体电压升序');});
  consume(/(?:电压)?从高到低/g,()=>{template.sortBy='min_voltage';set('sortDirection','desc','按报警最低单体电压降序');});
  consume(/(?:按)?(?:报警)?时间(?:倒序|降序)|最新(?:的)?在前/g,()=>{template.sortBy='alarm_time';set('sortDirection','desc','按报警时间倒序');});
  consume(/横版|横向/g,()=>set('orientation','landscape','版式：横向'));
  consume(/竖版|纵向/g,()=>set('orientation','portrait','版式：纵向'));
  consume(/紧凑(?:版式|排版)?/g,()=>set('density','compact','排版：紧凑'));
  consume(/自动生成|每天自动出报告/g,()=>set('automatic',true,'自动任务后生成此模板'));
  const fieldAliases=[['SN编码|SN码|SN|设备编号','sn'],['保护项目|报警类型','alarm_type'],['报警记录数|记录数','record_count'],['首次报警时间','first_alarm_time'],['最新报警时间|报警时间','alarm_time'],['修复状态','recovery_status'],['修复时间','repair_time'],['电池型号|型号','model'],['心跳最新最低单体电压|心跳最低电压|最新最低电压','latest_voltage'],['最低单体电压|最低电压','min_voltage'],['最高单体电压|最高电压','max_voltage'],['单体压差|压差','voltage_difference'],['MOS温度','mos_temperature'],['最高温度|温度','temperature'],['持续时间|持续时长|采样跨度','sampled_minutes'],['判定说明|原因|说明','low_reason'],['判定结果|核查结果','low_status'],['心跳采集情况|采集情况','evidence']];
  const fieldStart=remaining.search(/显示(?:字段)?|字段(?:为|是|：|:)|列出/);
  const prefix=fieldStart<0?remaining:remaining.slice(0,fieldStart);
  const suffix=fieldStart<0?'':remaining.slice(fieldStart).replace(/^(显示(?:字段)?|字段(?:为|是|：|:)|列出)/,'');
  let typePart=prefix;
  if(/全部(?:报警|保护项目)|所有(?:报警|项目)/.test(typePart)){template.alarmTypes=[];recognized.push('项目：全部保护报警');typePart=typePart.replace(/全部(?:报警|保护项目)|所有(?:报警|项目)/g,' ');}
  else{
    const selected=[];
    for(const [regex,type,label]of [[/单体压差过大|压差过大|压差/,'单体压差过大','压差过大'],[/电量不足|低电量/,'电量不足','电量不足'],[/高温相关保护|高温保护|高温|过温/,'@hot','高温相关保护']]){
      if(regex.test(typePart)){selected.push(type);recognized.push(`项目：${label}`);typePart=typePart.replace(new RegExp(regex.source,'g'),' ');}
    }
    if(selected.length)template.alarmTypes=selected;
  }
  let fieldPart=suffix;
  if(suffix){
    const matches=[];
    for(const [pattern,field]of fieldAliases){const m=new RegExp(pattern,'i').exec(fieldPart);if(m){matches.push({field,index:m.index});fieldPart=fieldPart.replace(new RegExp(pattern,'gi'),s=>' '.repeat(s.length));}}
    if(matches.length){template.fields=[...new Set(matches.sort((a,b)=>a.index-b.index).map(m=>m.field))];recognized.push(`显示${template.fields.length}列：${template.fields.map(k=>REPORT_FIELDS.find(f=>f.key===k).label).join('、')}`);if(!template.modules.includes('details'))template.modules.push('details');}
  }
  remaining=(typePart+' '+fieldPart).replace(/请帮我|帮我|我想要|给我|生成|一份|报告|只看|只要|筛选|需要|查看|电池|报警|的|以及|并且|和|且|与|按|仅|个|条|，|,|。|、|；|;|：|:|\s/g,'').trim();
  if(remaining)warnings.push(`未自动应用的文字：“${remaining}”。请检查是否需要补充筛选条件。`);
  if(/排除|不看|不要|除了|或者/.test(text))warnings.push('包含排除或复杂逻辑，请逐项核对后再应用配置。');
  return {template:validateTemplate(template),date:requestedDate,recognized:[...new Set(recognized)],warnings};
}
