import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCustomReport, validateTemplate, saveTemplate, loadTemplates, deleteTemplate, exportCustomReport, generateAutomaticReports } from '../src/custom-report.mjs';
import { parseReportRequest } from '../src/report-request.mjs';
const date='2026-09-10';
const record=(sn,voltage,time='15:00:00',extra={})=>({bms_number:sn,alarm:'保护：电量不足',alarm_time:`${date} ${time}`,min_cell_voltage_v:voltage,...extra});
const raw={period:{end_exclusive:`${date} 15:32:00`},records:[record('A','2.4'),record('A','2.3','15:01:00'),record('B','2.5'),record('C',''),record('D','2.2','15:00:00',{repair_time:`${date} 15:10:00`}),record('E','2.1','15:00:00',{repair_time:`${date} 16:00:00`})],today_heartbeat_evidence:{A:{complete:true,records:[0,5,10,15,20,25,30].map(m=>({time:`${date} 15:${String(m).padStart(2,'0')}:00`,minVoltage:'2.4'}))},B:{complete:true,records:[{time:`${date} 15:30:00`,minVoltage:'2.5'}]}}};
test('默认报警明细包含BMS软件版本；旧导出字段兼容，显式缺失不回退到冲突值',()=>{
  const r=buildCustomReport({...raw,records:[record('A','2.4','15:00:00',{bms_software_version:'SW-2',bms_version:'old'}),record('B','2.5','15:00:00',{bms_version:'SW-1'}),record('C','','15:00:00',{bms_software_version:null,bms_version:'conflict'})]},date,{});
  assert.match(r.markdown,/BMS 软件版本/);assert.match(r.markdown,/SW-2/);assert.match(r.markdown,/SW-1/);
  assert.match(r.markdown,/缺失待核实/);assert.doesNotMatch(r.markdown,/conflict/);
});
test('统计记录和SN分别去重；预览和明细限制不改变总数',()=>{
  const r=buildCustomReport(raw,date,{grouping:'sn',limit:2},{previewRows:1});
  assert.equal(r.summary.recordCount,5);assert.equal(r.summary.snCount,4);assert.equal(r.summary.displayRows,2);assert.equal(r.summary.previewRows,1);
  assert.deepEqual(r.summary.low,{meets:1,above:1,unknown:2});
  assert.equal(buildCustomReport(raw,date,{grouping:'records'}).summary.displayRows,5);
  assert.equal(buildCustomReport(raw,date,{recovery:'repaired'}).summary.snCount,1);
});
test('数值严格小于2.5且缺失值不能参与比较；心跳30分钟判据保持独立',()=>{
  assert.equal(buildCustomReport(raw,date,{filterRules:[{field:'min_voltage',operator:'lt',value:2.5}]}).summary.snCount,2);
  assert.equal(buildCustomReport(raw,date,{lowFilter:'meets'}).summary.snCount,1);
  assert.equal(buildCustomReport(raw,date,{lowFilter:'meets',overrideRule:true,threshold:2.5,duration:31}).summary.snCount,0);
  assert.equal(buildCustomReport(raw,date,{lowFilter:'above'}).summary.snCount,1);
  assert.equal(buildCustomReport(raw,date,{lowFilter:'unknown'}).summary.snCount,2);
});

test('历史复用资料在自定义报告中注明未重读，不归入今日低压已确认或正常',()=>{
  const historical={...raw,audit_version:2,records:[record('A','2.4')],today_heartbeat_evidence:{A:{complete:false,carried:true,coverageCutoff:'2026-09-09 16:00:00'}},
    today_focus:{items:[{sn:'A',lowVoltage:{confirmed:true,status:'低压采样满足分析条件',minVoltage:2.4,latestTime:'2026-09-09 15:00:00',sampledMinutes:180}}]}};
  for(const overrideRule of [false,true]) {
    const r=buildCustomReport(historical,date,{overrideRule,fields:['sn','evidence','low_status','low_reason']});
    assert.deepEqual(r.summary.low,{meets:0,above:0,unknown:1});
    assert.match(r.markdown,/历史资料，仅恢复复查/);assert.match(r.markdown,/2026-09-09 16:00:00/);
    assert.equal(buildCustomReport(historical,date,{overrideRule,lowFilter:'meets'}).summary.snCount,0);
  }
});
test('自定义文字安全转义；未知变量与无效文件标识不能保存',()=>{
  const r=buildCustomReport(raw,date,{title:'<script>alert(1)</script>',labels:{sn:'<img src=x onerror=alert(1)>'}});
  assert.ok(!r.html.includes('<script>'));assert.ok(r.html.includes('&lt;script&gt;'));assert.ok(!r.html.includes('<img'));
  assert.throws(()=>validateTemplate({title:'{password}'}),/不支持/);
  assert.throws(()=>validateTemplate({id:'../escape'}));
  assert.throws(()=>validateTemplate({filterRules:[{field:'min_voltage',operator:'lt',value:NaN}]}));
});
test('模板持久化、复制、完整导出与自动生成',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'jy-custom-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const saved=await saveTemplate(root,{automatic:true});assert.equal((await loadTemplates(root))[0].id,saved.id);
  const copy=await saveTemplate(root,saved,{copy:true});assert.notEqual(saved.id,copy.id);
  await deleteTemplate(root,copy.id);assert.equal((await loadTemplates(root)).length,1);
  const result=await exportCustomReport(root,raw,date,saved);assert.equal(result.summary.previewRows,result.summary.displayRows);
  assert.match(await fs.readFile(result.htmlPath,'utf8'),/数据说明/);
  assert.equal(JSON.parse(await fs.readFile(result.settingsPath,'utf8')).rule.lowVoltageDurationMinutes,30);
  assert.equal((await generateAutomaticReports(root,raw,date)).outputs.length,1);
  assert.equal((await generateAutomaticReports(root,{},date)).errors.length,1);
});
test('文字需求转换显示字段、去重、低压时间及严格数值条件',()=>{
  const r=parseReportRequest('只看今天未修复的电量不足，按 SN 去重，显示 SN、最低电压、持续时间、判定说明',{}, {date});
  assert.deepEqual(r.template.fields,['sn','min_voltage','sampled_minutes','low_reason']);assert.equal(r.template.grouping,'sn');assert.deepEqual(r.template.alarmTypes,['电量不足']);assert.deepEqual(r.warnings,[]);
  const low=parseReportRequest('电压低于2.5V且维持30分钟',{}, {date});assert.equal(low.template.lowFilter,'meets');assert.equal(low.template.duration,30);
  const numeric=parseReportRequest('压差大于0.2V，最低电压小于2.5V',{}, {date});assert.equal(numeric.template.filterRules.length,2);assert.equal(numeric.template.filterRules[0].operator,'lt');
  assert.deepEqual(parseReportRequest('显示首次报警时间、报警时间',{}).template.fields,['first_alarm_time','alarm_time']);
});
test('不支持的排除逻辑不能反向应用为包含；未知内容明确提示',()=>{
  const parsed=parseReportRequest('不要高温，或者电量不足',{});assert.equal(parsed.recognized.length,0);assert.ok(parsed.warnings.length);
  assert.ok(parseReportRequest('估算未来三个月寿命',{}).warnings.length);
});
