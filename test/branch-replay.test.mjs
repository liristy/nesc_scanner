import test from 'node:test';
import assert from 'node:assert/strict';
import { auditWindowNow,currentDayWindow } from '../src/audit-policy.mjs';
import { collectAlarms } from '../src/audit-rules.mjs';
import { reportArchiveName } from '../src/calendar.mjs';
const context={date:'2026-10-13',event:'workflow_dispatch',refName:'codex/trim-recovered-collection',defaultBranch:'main'};
test('16:00截止前后窗口正确，旧16:30状态与归档保留真实截止，边界左开右闭',()=>{
  const old={last_success_cutoff:'2026-10-13 16:30:00'};
  const before=currentDayWindow(new Date('2026-10-14T15:59:59+08:00'),old);
  assert.equal(before.endText,'2026-10-13 16:00:00');
  assert.equal(before.alreadyComplete,true);
  const window=currentDayWindow(new Date('2026-10-14T16:00:00+08:00'),old);
  assert.equal(window.startText,'2026-10-13 16:00:00');assert.equal(window.endText,'2026-10-14 16:00:00');
  assert.equal(window.alreadyComplete,false);
  const rows=[window.startText,'2026-10-14 15:45:00',window.endText,'2026-10-14 16:00:01'].map((time,i)=>({sn:String(i),type:'电量不足',vendor:'JY',level:'保护',time}));
  assert.deepEqual(collectAlarms(rows,[],[],window,'2026-10-14 17:00:00').alarms.map(a=>a.sn),['1','2']);
  assert.equal(reportArchiveName('2026-10-14',window.endText),'20261014-160000');
  assert.equal(reportArchiveName('2026-10-13',old.last_success_cutoff),'20261013-163000');
  assert.equal(old.last_success_cutoff,'2026-10-13 16:30:00');
});
test('分支指定日期跨天后仍固定13号区间，未指定日期沿用日常调度',()=>{
  const now=new Date('2026-10-14T17:00:00+08:00');
  const selected=auditWindowNow(now,context),window=currentDayWindow(selected,{last_success_cutoff:'2026-10-12 16:30:00'});
  assert.equal(window.startText,'2026-10-12 16:00:00');assert.equal(window.endText,'2026-10-13 16:00:00');
  assert.equal(window.alreadyComplete,false);assert.equal(auditWindowNow(now,{}),now);
});
test('主线、自动触发、未来和无效日期不能指定日期重跑',()=>{
  const now=new Date('2026-10-14T00:00:00+08:00');
  for(const changed of [{refName:'main'},{event:'push'},{defaultBranch:''}])assert.throws(()=>auditWindowNow(now,{...context,...changed}),/非主线分支/);
  assert.throws(()=>auditWindowNow(now,{...context,date:'2026-10-14'}),/尚未到达/);
  assert.throws(()=>auditWindowNow(now,{...context,date:'2026-02-30'}),/无效/);
  assert.throws(()=>auditWindowNow(now,{...context,date:'13'}),/YYYY-MM-DD/);
  assert.throws(()=>auditWindowNow(new Date('2026-10-13T15:59:59+08:00'),context),/16:00尚未到达/);
  assert.equal(auditWindowNow(new Date('2026-10-13T16:00:00+08:00'),context).getTime(),Date.parse('2026-10-13T16:00:00+08:00'));
});
