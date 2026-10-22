import { shiftDay } from './calendar.mjs';
import { parseAlarmWorkbook } from './xlsx.mjs';

// The platform filters whole calendar dates. Split inclusive date ranges into
// disjoint days, then apply the original precise audit cutoff to every export.
export async function downloadAlarmRows(platform, window, parseOptions, { bmsNumbers = [] } = {}) {
  let queries = 0;
  const read = async (range, sns, attempt = 0) => {
    platform.config?.signal?.throwIfAborted();
    if (++queries > 127) throw Object.assign(new Error('报警分批查询达到127次上限，保留原截止续查'), { code: 'EXPORT_LIMIT' });
    let exported;
    try {
      exported = await platform.queryAlarmAndDownload(range, { bmsNumbers: sns });
    } catch (error) {
      if (error.code !== 'EXPORT_LIMIT') throw error;
      const days = (Date.parse(range.endDate) - Date.parse(range.startDate)) / 86400000;
      let children;
      if (Number.isInteger(days) && days > 0) {
        const middle = shiftDay(range.startDate, Math.floor(days / 2));
        children = [
          [{ ...range, endDate: middle }, sns],
          [{ ...range, startDate: shiftDay(middle, 1) }, sns],
        ];
      } else if (days === 0 && sns.length > 1) {
        const middle = Math.ceil(sns.length / 2);
        children = [[range, sns.slice(0, middle)], [range, sns.slice(middle)]];
      } else {
        throw Object.assign(new Error(`${range.startDate}单日报警仍超过单次导出上限，无法继续按日期拆分；${error.message}`), { code: 'EXPORT_LIMIT' });
      }
      platform.logger?.warn(`报警导出超限，拆分查询 ${range.startDate}～${range.endDate}；保留统计截止 ${window.endText ?? window.endDate}。`);
      const parts = [];
      for (const [child, childSNs] of children) {
        parts.push(await read({ ...child, reportDate: `${window.reportDate}_part_${queries + 1}` }, childSNs));
      }
      return { allRowCount: parts.reduce((sum, part) => sum + part.allRowCount, 0), rows: parts.flatMap(part => part.rows) };
    }
    const parsed = await parseAlarmWorkbook(exported.buffer, parseOptions);
    if (parsed.allRowCount !== exported.resultCount) {
      const error=Object.assign(new Error(`报警导出条数与页面不一致（${range.startDate}～${range.endDate}）：页面${exported.resultCount}条，文件${parsed.allRowCount}条`), {code:'ALARM_COUNT_MISMATCH'});
      // The whole-date query and export are separate reads of live data.
      // Discard both results and retry only this bucket, never accept a delta.
      if(attempt>=2)throw error;
      platform.logger?.warn(`${error.message}；丢弃本批结果，重新核对（${attempt+1}/2）。`);
      return read(range,sns,attempt+1);
    }
    platform.logger?.info(`报警导出已核对 ${range.startDate}～${range.endDate}：${parsed.allRowCount}条，统计区间内${parsed.rows.length}条。`);
    return parsed;
  };
  return read(window, [...new Set(bmsNumbers)]);
}
