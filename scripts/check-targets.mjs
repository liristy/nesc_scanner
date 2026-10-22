import path from 'node:path';
import { readJson } from '../src/utils.mjs';

const validSN = sn => typeof sn === 'string' && /^[A-Za-z0-9_-]+$/.test(sn);

export async function readOnlyCheckTargets(root, explicit = '') {
  if (explicit.trim()) {
    const sns = explicit.trim().split(/\s+/);
    if (sns.length > 5 || sns.some(sn => !validSN(sn))) throw new Error('只读验收应为1至5个有效SN');
    return [...new Set(sns)];
  }
  // The list stays in the private checkout. Never store device identities in
  // public-repository inputs, variables, Secrets, logs or workflow outputs.
  const state = await readJson(path.join(root, 'state/current_tracking.json'));
  if (!Array.isArray(state?.items)) throw new Error('私有跟踪状态缺失，无法选择只读验收对象');
  const candidates = state.items.filter(item => validSN(item.sn)).sort((a, b) =>
    String(b.time || '').localeCompare(String(a.time || '')));
  const sns = [...new Set(candidates.map(item => item.sn))].slice(0, 2);
  if (!sns.length) throw new Error('私有跟踪状态中没有明确SN，不能猜测验收对象');
  return sns;
}
