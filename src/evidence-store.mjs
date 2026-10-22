import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson } from './utils.mjs';
import { analyzeWeek } from './audit-rules.mjs';

export const checkpointName = sn => `batch-sn-${createHash('sha256').update(sn).digest('hex').slice(0, 24)}.json`;
export const trackingName = sn => createHash('sha256').update(sn).digest('hex') + '.json';

// A summary never owns raw heartbeat rows. Its path is generated locally, not
// accepted from a restored JSON file. Only one device is hydrated at a time.
export function evidenceSummary(evidence, endText, evidenceFile, {analyze=true}={}) {
  const { records, evidenceFile: ignored, ...fields } = evidence;
  return { ...fields, recordCount: records?.length ?? fields.recordCount ?? 0,
    abnormalCount: records?.filter(r => r.abnormal).length ?? fields.abnormalCount ?? 0,
    week: records && analyze ? analyzeWeek(evidence, endText) : fields.week, evidenceFile };
}

export async function hydrateEvidence(sn, summary) {
  if (!summary?.evidenceFile) return summary;
  const saved = await readJson(summary.evidenceFile);
  const evidence = saved?.evidence?.[sn] ?? (saved?.sn === sn ? saved.evidence : null);
  if (!evidence || !Array.isArray(evidence.records)) throw new Error(`${sn}已保存的心跳证据缺失，不能使用摘要代替原始记录`);
  return { ...evidence, coverageCutoff: Object.hasOwn(summary,'coverageCutoff') ? summary.coverageCutoff
      :Object.hasOwn(evidence,'coverageCutoff') ? evidence.coverageCutoff :saved.endText ?? saved.cutoff,
    ...(summary.carried?{carried:true}:{}) };
}

export const checkpointPath = (root, sn) => path.join(root, 'run/acquisition', checkpointName(sn));
