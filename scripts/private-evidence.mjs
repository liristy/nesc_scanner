import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { atomicWriteJson, readJson } from '../src/utils.mjs';

const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;
const positiveId = value => /^[1-9]\d*$/.test(String(value ?? ''));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function privateStore(env = process.env, fetchImpl = fetch) {
  const repository = env.REPORT_REPOSITORY, token = env.REPORT_REPO_TOKEN;
  if (!repositoryPattern.test(repository || '') || !token || repository === env.GITHUB_REPOSITORY)
    throw new Error('私有报告仓库配置不完整或指向当前公开仓库');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28' };
  const call = async (suffix, { method = 'GET', body, binary = false, upload = false } = {}) => {
    const response = await fetchImpl((upload ? `https://uploads.github.com/repos/${repository}` : base) + suffix, {
      method, redirect: 'manual', signal: AbortSignal.timeout(180_000),
      // Actions archive downloads require the API JSON media type even though
      // their redirect serves ZIP bytes. Release assets require octet-stream.
      headers: { ...headers, Accept: binary && !/^\/actions\/artifacts\/\d+\/zip$/.test(suffix) ? 'application/octet-stream' : headers.Accept,
        ...(body ? { 'Content-Type': upload ? 'application/zip' : 'application/json' } : {}) },
      body: body && (upload ? body : JSON.stringify(body)),
    });
    if (binary && [301, 302, 303, 307, 308].includes(response.status)) {
      const url = new URL(response.headers.get('location'));
      if (url.protocol !== 'https:' || url.username || url.password ||
          !['release-assets.githubusercontent.com', 'productionresultssa0.blob.core.windows.net'].includes(url.hostname) &&
          !url.hostname.endsWith('.blob.core.windows.net') && !url.hostname.endsWith('.actions.githubusercontent.com'))
        throw new Error('私有证据下载重定向目标无效');
      // Signed download URLs never receive the repository credential.
      const download = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
      if (!download.ok) throw new Error(`私有证据下载失败：HTTP ${download.status}`);
      return Buffer.from(await download.arrayBuffer());
    }
    if (!response.ok) throw new Error(`私有证据请求失败：HTTP ${response.status}`);
    if (binary) return Buffer.from(await response.arrayBuffer());
    return response.status === 204 ? null : response.json();
  };
  return { repository, call, async verify() {
    const metadata = await call('');
    if (metadata.private !== true || metadata.full_name.toLowerCase() !== repository.toLowerCase())
      throw new Error('报告与采集数据只能存放到已核验的私有仓库');
  } };
}

export async function archiveFolders(root, folders) {
  const zip = new JSZip();
  let count = 0;
  async function add(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    })) {
      const file = path.join(directory, entry.name), name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('证据目录不接受符号链接');
      if (entry.isDirectory()) await add(file, `${name}/`);
      else if (entry.isFile()) { zip.file(name, await fs.readFile(file)); count++; }
    }
  }
  for (const [directory, prefix] of folders) await add(path.join(root, directory), prefix);
  if (!count) throw new Error('没有可保存的私有证据');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } });
}

export async function restoreEvidence(root = '.', store = privateStore()) {
  await store.verify();
  const pointer = await readJson(path.join(root, 'state/cloud-runtime.json'), {});
  if (!pointer.asset_id && !pointer.artifact_id) return { restored: false };
  let bytes;
  if (pointer.storage === 'release_asset') {
    if (pointer.repository !== store.repository || !positiveId(pointer.asset_id) || !/^[a-f0-9]{64}$/.test(pointer.sha256 || ''))
      throw new Error('私有证据指针无效');
    bytes = await store.call(`/releases/assets/${pointer.asset_id}`, { binary: true });
    if (digest(bytes) !== pointer.sha256 || bytes.length !== pointer.size) throw new Error('私有证据校验不一致');
  } else {
    if (!positiveId(pointer.artifact_id) || !positiveId(pointer.run_id)) throw new Error('旧证据指针无效');
    const metadata = await store.call(`/actions/artifacts/${pointer.artifact_id}`);
    if (!metadata.name?.startsWith('jy-audit-runtime-') || String(metadata.workflow_run?.id) !== String(pointer.run_id) || metadata.expired)
      throw new Error('旧证据来源或有效期不符合要求');
    bytes = await store.call(`/actions/artifacts/${pointer.artifact_id}/zip`, { binary: true });
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  let count = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const name = entry.unsafeOriginalName || entry.name;
    if (name !== entry.name || !/^(?:manifest\.json|tracking\/[a-f0-9]{64}\.json|acquisition\/(?:(?:batch-|repair-|history-)[^/\\]+|manifest)\.json|daily\/collection\.json)$/.test(name))
      throw new Error('证据包含未授权路径');
    const file = path.join(root, 'run/restored', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await entry.async('nodebuffer')); count++;
  }
  return { restored: true, count };
}

export async function saveEvidence(root = '.', { env = process.env, store = privateStore(env), smoke = false } = {}) {
  await store.verify();
  if (!positiveId(env.GITHUB_RUN_ID) || !positiveId(env.GITHUB_RUN_ATTEMPT)) throw new Error('运行标识无效');
  const branch = env.REPORT_BRANCH;
  if (!branch || !/^[\w./-]+$/.test(branch)) throw new Error('目标分支无效');
  // Pin the release to the private branch; never create a tag from a public SHA.
  const ref = await store.call(`/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
  const release = await store.call('/releases', { method: 'POST', body: {
    tag_name: `scanner-${smoke ? 'check' : 'runtime'}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    target_commitish: ref.object.sha, name: `Scanner ${smoke ? 'check' : 'runtime'} ${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}`,
    body: 'Private collection evidence and diagnostics. Do not publish outside this repository.', draft: true,
  } });
  const folders = smoke ? [['run/speed-check', 'speed-check/'], ['run/heartbeat-diagnostics', 'diagnostics/'], ['run/private-logs', 'logs/']]
    : [['run/cloud-bundle', '']];
  const bytes = await archiveFolders(root, folders);
  const asset = await store.call(`/releases/${release.id}/assets?name=${smoke ? 'check' : 'runtime'}.zip`, { method: 'POST', body: bytes, upload: true });
  if (!positiveId(asset.id) || asset.state !== 'uploaded' || asset.size !== bytes.length) throw new Error('私有证据上传未确认');
  // Read back and hash before allowing the cutoff to advance.
  const saved = await store.call(`/releases/assets/${asset.id}`, { binary: true });
  if (digest(saved) !== digest(bytes)) throw new Error('私有证据上传校验失败');
  const pointer = { schema_version: 3, storage: 'release_asset', repository: store.repository,
    release_id: String(release.id), asset_id: String(asset.id), sha256: digest(bytes), size: bytes.length,
    run_id: String(env.GITHUB_RUN_ID), branch };
  await atomicWriteJson(path.join(root, smoke ? 'run/check-upload.json' : 'run/evidence-upload.json'), pointer);
  if (!smoke) {
    const backup = await archiveFolders(root, [['reports', 'reports/'], ['state', 'state/'], ['run/private-logs', 'logs/'], ['run/heartbeat-diagnostics', 'diagnostics/']]);
    const backupAsset = await store.call(`/releases/${release.id}/assets?name=reports-and-diagnostics.zip`, { method: 'POST', body: backup, upload: true });
    if (!positiveId(backupAsset.id) || backupAsset.state !== 'uploaded' || backupAsset.size !== backup.length)
      throw new Error('私有报告备份未保存');
  }
  return pointer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    if (mode === 'verify') await privateStore().verify();
    else if (mode === 'restore') await restoreEvidence();
    else if (mode === 'save' || mode === 'smoke') await saveEvidence('.', { smoke: mode === 'smoke' });
    else throw new Error('未知私有证据操作');
    console.info('私有证据操作完成。');
  } catch {
    // Arbitrary API errors, URLs, ZIP paths and credentials stay off public logs.
    console.error('私有证据操作失败，成功截止不得推进。请检查私有仓库权限和受控诊断。');
    process.exitCode = 1;
  }
}
