import fs from 'node:fs/promises';
import { updateReadmeReport } from './update-readme-report.mjs';
import { reportArchiveName } from '../src/calendar.mjs';

let result;
try {
  result = JSON.parse(await fs.readFile('run/last-result.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const status = process.env.MONITOR_OUTCOME === 'success' && result?.status === 'success'
  ? 'success' : result?.status === 'partial_success' ? 'partial_success' : 'error';
if (process.argv.includes('--check')) {
  if (status !== 'success') {
    console.error('本次采集失败或数据不完整，请查看 reports/last-run.json、异常报告及 Actions 日志。');
    process.exitCode = 1;
  }
} else {
  const summary = {
    status,
    mode: result?.mode ?? 'report',
    collection_date: result?.collection_date ?? null,
    report_date: result?.report_date ?? null,
    period: result?.period ?? null,
    pending_review_count: result?.pending_review_count ?? 0,
    completed_at: result?.completed_at ?? new Date().toISOString(),
    run_url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    message: status === 'success' ? (result?.message || '报告生成完成。') : status === 'partial_success'
      ? '报告部分完成，请查看报告中的待补查项。' : (result?.message || '本次运行未成功完成，请查看异常报告和 Actions 日志。'),
  };
  await fs.mkdir('reports', { recursive: true });
  await fs.writeFile(summary.mode === 'collection' ? 'reports/last-collection.json' : 'reports/last-run.json', `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.mode !== 'collection') await updateReadmeReport('.', summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const repo = `${process.env.GITHUB_SERVER_URL}/${process.env.REPORT_REPOSITORY || process.env.GITHUB_REPOSITORY}/blob/${encodeURIComponent(process.env.REPORT_BRANCH || 'main')}/reports/`;
    const archive = summary.report_date ? reportArchiveName(summary.report_date, summary.period?.end_inclusive ?? summary.period?.end_exclusive) + '/' : '';
    const links = summary.report_date ? ['今日电池报警简报', '电池报警复核清单'].map(name => `[${name}](${repo}${archive}${encodeURIComponent(name)}.md)`).join(' · ') : '报告入口见仓库README。';
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## JY 核查结果：${status}\n\n${process.env.JY_PUBLIC_RUN==='true' ? '报告、运行详情和证据仅保存于私有仓库。' : summary.message}\n\n${links}\n\n仓库链接在后续发布成功后生效；发布失败请在私有报告仓库的草稿Release下载备份。\n`);
  }
}
