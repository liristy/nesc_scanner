import fs from 'node:fs/promises';
import path from 'node:path';

const start = '<!-- daily-report:start -->';
const end = '<!-- daily-report:end -->';

export async function updateReadmeReport(root = '.', summary = {}) {
  const readmePath = path.join(root, 'README.md');
  let readme;
  try { readme = await fs.readFile(readmePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const names = await fs.readdir(path.join(root, 'reports'));
  const reports = names.filter(name => /^\d{4}-\d{2}-\d{2}_JY报警监测日报\.md$/.test(name)).sort();
  const latest = reports.at(-1);
  const lines = [start, '## 当日报告入口', ''];
  const link = (label, file) => `[${label}](${file.split('/').map(encodeURIComponent).join('/')})`;
  const archives = names.filter(name => /^\d{8}-(?:160000|163000)$/.test(name)).sort().reverse();
  let auditArchive;
  for (const name of archives) {
    try {
      await fs.access(path.join(root, 'reports', name, '今日电池报警简报.md'));
      await fs.access(path.join(root, 'reports', name, '电池报警复核清单.md'));
      auditArchive = name; break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (auditArchive) {
    const date = `${auditArchive.slice(0,4)}-${auditArchive.slice(4,6)}-${auditArchive.slice(6,8)}`;
    lines.push(`### 最新核查报告（${date}）`, '',
      link('今日电池报警简报', `reports/${auditArchive}/今日电池报警简报.md`), '',
      link('电池报警复核清单', `reports/${auditArchive}/电池报警复核清单.md`), '', '[历史报告](reports/)');
  } else if (latest) {
    const date = latest.slice(0, 10);
    lines.push(`### 📄 ${link(`查看最新日报（${date}）`, `reports/${latest}`)}`, '');
    const shortcuts = [];
    for (const [label, file] of [
      ['重点专项 SN', `reports/${date}_重点专项SN.md`],
      ['文字简报', `reports/daily_reports/${date}_JY日报总结.txt`],
    ]) {
      try { await fs.access(path.join(root, file)); shortcuts.push(link(label, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    shortcuts.push('[历史报告](reports/)');
    lines.push(shortcuts.join(' · '), '', '链接按实际报告日期自动更新；当天报告生成前，保留最近一期入口。');
  } else {
    lines.push('当日报告尚未生成，生成后这里会自动显示直达链接。', '', '[查看历史报告](reports/)');
  }
  if (summary.status) {
    const status = { success: '成功', partial_success: '部分完成，请查看待补查项', error: '失败，当前链接可能为此前报告' }[summary.status] ?? '未知';
    lines.push('', `最近运行：**${status}** · [查看运行状态](reports/last-run.json)`);
  }
  lines.push(end);
  const block = lines.join('\n');
  const a = readme.indexOf(start), b = readme.indexOf(end);
  if (a >= 0 && b > a) readme = readme.slice(0, a) + block + readme.slice(b + end.length);
  else {
    const headingEnd = readme.indexOf('\n');
    readme = headingEnd >= 0 ? readme.slice(0, headingEnd + 1) + '\n' + block + '\n' + readme.slice(headingEnd + 1) : readme + '\n\n' + block + '\n';
  }
  await fs.writeFile(readmePath, readme);
}
