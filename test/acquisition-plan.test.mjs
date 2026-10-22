import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAlarms, analyzeWeek } from '../src/audit-rules.mjs';
import { buildAcquisitionPlan, needsHistoricalRiskFollowup } from '../src/acquisition-plan.mjs';

const window = { startText:'2026-10-12 16:00:00', endText:'2026-10-13 16:00:00' };
const old = { sn:'old', type:'电量不足', time:'2026-10-12 12:00:00', vendor:'JY', level:'保护',
  lowVoltage:analyzeWeek({complete:true, records:[{time:'2026-10-12 15:00:00', minVoltage:3.4, maxVoltage:3.5}]}, window.startText) };
const recovered = a => ({...a, repair:'2026-10-13 10:00:00'});
const plan = (items, rows=[], refresh=items.map(recovered)) => buildAcquisitionPlan(
  collectAlarms(rows, items, refresh, window, '2026-10-13 16:03:00'), items, [], window);

test('已恢复且最新有效电压正常的电量不足对象不再采集；2.8V边界包含', () => {
  for (const voltage of [2.8,3.4]) {
    const item = {...old,lowVoltage:{...old.lowVoltage,minVoltage:voltage}};
    assert.deepEqual(plan([item]).sns, []);
    assert.equal(plan([item]).scope.skipped_recovered_normal, 1);
  }
});
test('未恢复、恢复未知、同SN其他未恢复保护仍需采集', () => {
  assert.deepEqual(plan([old], [], []).sns, ['old']);
  const other = {...old,type:'短路',lowVoltage:null};
  assert.deepEqual(plan([old,other], [], [recovered(old)]).sns, ['old']);
});
test('已恢复但低压、异常电压、过旧/缺失样本或未知证据缺口均继续跟踪', () => {
  for (const changes of [{minVoltage:2.79},{minVoltage:null},{minVoltage:0},{minVoltage:6},{minVoltage:'3.4'},
    {latestTime:undefined},{latestTime:'2026-10-11 15:59:59'}, {latestTime:'2026-10-12 16:00:01'},
    {gaps:['分页未完整读取']},{gaps:['有效最低电压缺失或同刻读数冲突']},{gaps:undefined}]) {
    const item = {...old,lowVoltage:{...old.lowVoltage,...changes}};
    assert.equal(needsHistoricalRiskFollowup(item,window.startText),true,JSON.stringify(changes));
    assert.deepEqual(plan([item]).sns, ['old']);
  }
});
test('离线电芯、待确认、压差越界和历史压差缺口不因报警恢复被删除', () => {
  for (const changes of [{review:{kind:'reading_pending'}},{review:{kind:'offline_cells'}},
    {type:'单体压差过大',difference:{status:'排除待复核'}},{type:'单体压差过大',difference:{status:'待复核'}}]) {
    assert.deepEqual(plan([{...old,...changes}]).sns, ['old']);
  }
});
test('当日报警与仅历史跟踪分别计数，同SN重叠去重，非JY不进入历史风险', () => {
  const low = {...old,lowVoltage:{...old.lowVoltage,minVoltage:2.4}};
  const fresh = {...old,time:'2026-10-13 12:00:00'};
  const result = plan([low,{...low,sn:'history'},{...low,sn:'other',vendor:'OTHER'}], [fresh]);
  assert.deepEqual(new Set(result.sns),new Set(['old','history']));
  assert.deepEqual(result.scope,{current_window:1,history_only:1,total:2,skipped_recovered_normal:0});
});

test('缓存中的正常分析不能覆盖另一份状态中的待确认缺口', () => {
  const unresolved = {...old,review:{kind:'reading_pending'}};
  const selection = collectAlarms([], [unresolved], [recovered(unresolved)], window, '2026-10-13 16:03:00');
  assert.deepEqual(buildAcquisitionPlan(selection,[unresolved],[old],window).sns,['old']);
});

test('恢复复查模式仅采集当日报警；历史低压和缺口留在恢复队列，同SN当日报警仍采集',()=>{
  const low={...old,lowVoltage:{...old.lowVoltage,minVoltage:2.4}},pending={...old,sn:'pending',review:{kind:'reading_pending'}};
  const latest={...old,time:'2026-10-13 12:00:00'};
  const prior=[low,{...low,sn:'historical'},pending];
  const selection=collectAlarms([latest],prior,[],window,'2026-10-13 16:03:00');
  const result=buildAcquisitionPlan(selection,prior,[],window,{historicalReviewMode:'recovery_only'});
  assert.deepEqual(result.sns,['old']);assert.deepEqual(new Set(result.historicalSNS),new Set(['historical','pending']));
  assert.equal(result.scope.total,1);assert.equal(result.scope.history_recovery_only,2);
});
