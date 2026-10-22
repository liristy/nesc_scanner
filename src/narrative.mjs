import { EVIDENCE_DEFAULTS } from './evidence.mjs';
import { LOW_VOLTAGE_RULE } from './audit-rules.mjs';

export function lowVoltageSummary(focus, settings = {}) {
  if(focus?.analysisSettings?.auditVersion===2) {
    const items=[...new Map((focus.items ?? []).filter(i=>i.lowVoltage).map(i=>[i.sn,i])).values()];
    const rule={auditVersion:2,...LOW_VOLTAGE_RULE,...settings,...focus.analysisSettings};
    const meets=items.filter(i=>i.lowVoltage.confirmed).length;
    const above=items.filter(i=>i.lowVoltage.minVoltage!==null && i.lowVoltage.minVoltage>=rule.lowVoltageThresholdV).length;
    const unknown=items.length-meets-above;
    return {total:items.length,meets,above,unknown,reasons:{},rule,text:`已确认需补电${meets}块；其余按低于${rule.lowVoltageThresholdV}V、连续${rule.lowVoltageDurationMinutes/1440}天的证据细则复核；SOC不作判据。`};
  }
  const rule = { ...EVIDENCE_DEFAULTS, ...settings, ...focus?.analysisSettings };
  const items = (focus?.items ?? []).filter(i => i.lowVoltage);
  const count = status => items.filter(i => i.lowVoltage.status === status).length;
  const meets = count('低压采样满足分析条件');
  const above = count('最新采样未满足低压条件');
  const unknown = items.length - meets - above;
  const reasons = { '记录太旧': 0, '数据缺失或异常': 0, '采样时长或连续性不足': 0 };
  for (const i of items.filter(i => i.lowVoltage.status === '证据不足')) {
    const text = i.lowVoltage.reason ?? '';
    const key = /距统计截止|过旧|相隔过久/.test(text) ? '记录太旧'
      : /跨度不足|时间缺口|跨事件|重新上线/.test(text) ? '采样时长或连续性不足' : '数据缺失或异常';
    reasons[key]++;
  }
  const text = items.length
    ? `低压保电核查：电量不足共${items.length}个SN。满足“最低单体电压低于${rule.lowVoltageThresholdV}V、采样持续至少${rule.lowVoltageDurationMinutes}分钟”的${meets}个；最新有效最低单体电压≥${rule.lowVoltageThresholdV}V的${above}个；其余${unknown}个因记录过旧、数据异常或连续采样时长不足，暂无法确认。上述结果不能直接证明是否已触发低压保电，也不代表设备已恢复。`
    : '低压保电核查：今日专项中没有需要核查的电量不足SN。';
  return { total: items.length, meets, above, unknown, reasons, rule, text };
}
