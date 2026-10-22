import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, atomicWriteJson } from './utils.mjs';
import { chinaDate } from './calendar.mjs';
import { downloadAlarmRows } from './alarm-export.mjs';
import { evidenceSummary, trackingName } from './evidence-store.mjs';
import { analyzeWeek } from './audit-rules.mjs';

export const dailyCachePath = root => path.join(root, 'run/daily/collection.json');
export async function readDailyCache(root, window) {
  const marker = await readJson(path.join(root, 'state/daily_collection.json'), {});
  const saved = await readJson(dailyCachePath(root));
  return saved?.complete && saved.startText === window.startText && saved.endText === marker.last_collection_cutoff
    && saved.endText > window.startText && saved.endText <= window.endText && Array.isArray(saved.rows) ? saved : null;
}

// Statistical origins use the preceding day's baseline. A replay may restore
// a later accepted review list; use it for risk/reading state only.
export async function loadHistoricalReviewState(root, window, previousState) {
  const saved=await readJson(dailyCachePath(root));
  if(saved?.complete && Array.isArray(saved.items) && Number.isFinite(chinaDate(saved.endText).getTime()) &&
      saved.endText>(previousState.last_success_cutoff || '') && saved.endText<=window.endText)
    return {items:saved.items,last_success_cutoff:saved.endText};
  return previousState;
}
export async function collectDailyAlarmRows(platform, window, saved) {
  const startText = saved?.endText ?? window.startText;
  if (startText === window.endText) return { rows: saved.rows };
  const query = { ...window, start: chinaDate(startText), startText, startDate: startText.slice(0, 10) };
  const parsed = await downloadAlarmRows(platform, query, { vendor: 'JY', start: query.start, end: window.end, endInclusive: true });
  if (saved) platform.logger?.info(`复用每日报警统计至${saved.endText}，仅导出其后新增区间。`);
  return { ...parsed, rows: [...(saved?.rows ?? []), ...parsed.rows] };
}
export async function loadRollingEvidence(root, endText, {compact=false,sns}={}) {
  const evidence = new Map();
  const wanted=sns?new Set(sns.map(trackingName)):null;
  for (const name of await fs.readdir(path.join(root, '跟踪数据')).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    if(wanted&&!wanted.has(name))continue;
    const saved = await readJson(path.join(root, '跟踪数据', name));
    // Versioned partial evidence explicitly identifies fully validated days.
    // The platform still excludes the previous cutoff day and all missing days.
    if (saved?.cutoff < endText && (saved.evidence?.complete || saved.evidence?.historyCoverageVersion===1)
        && saved.sn && name===trackingName(saved.sn) && Array.isArray(saved.evidence.records)) {
      const item={ ...saved.evidence, coverageCutoff: saved.evidence.coverageCutoff ?? saved.cutoff };
      evidence.set(saved.sn, compact?evidenceSummary(item,endText,path.join(root,'跟踪数据',name),{analyze:false}):item);
    }
  }
  return evidence;
}

export async function loadHistoricalEvidence(root, cutoff, sns) {
  const snapshots=new Map(), evidence=new Map();
  for(const sn of sns) {
    const file=path.join(root,'跟踪数据',trackingName(sn));
    const saved=await readJson(file);
    const coverage=saved?.evidence && Object.hasOwn(saved.evidence,'coverageCutoff') ? saved.evidence.coverageCutoff : saved?.cutoff;
    const missingCoverage=saved?.evidence?.carried && saved.evidence.complete===false && coverage==null && saved.evidence.records?.length===0;
    if(saved && (saved.sn!==sn || (!missingCoverage && (!Number.isFinite(chinaDate(coverage).getTime()) || coverage>cutoff)) || !Array.isArray(saved.evidence?.records)))
      throw new Error(`历史证据身份、日期或结构无效：${sn}；保留原始文件，不覆盖跟踪`);
    if(saved?.snapshot)snapshots.set(sn,saved.snapshot);
    evidence.set(sn,saved?{...evidenceSummary(saved.evidence,coverage || cutoff,file,{analyze:false}),
      week:analyzeWeek(saved.evidence,coverage || cutoff),coverageCutoff:coverage,carried:true}
      :{sn,complete:false,records:[],carried:true,coverageCutoff:null,error:'历史原始证据未取得，保留既有缺口'});
  }
  return {snapshots,evidence};
}
export async function saveDailyCache(root, { window, rows, items, counts, pendingReviews }) {
  const formal = window.publishReport !== false;
  await atomicWriteJson(dailyCachePath(root), { schema_version: 1, complete: true,
    startText: formal ? window.endText : window.startText, endText: window.endText,
    rows: formal ? [] : rows, items, counts, pending_reviews: pendingReviews });
  await atomicWriteJson(path.join(root, 'state/daily_collection.json'), {
    schema_version: 1, last_collection_cutoff: window.endText, formal_report: formal,
    counts, pending_review_count: pendingReviews.length,
  });
}
