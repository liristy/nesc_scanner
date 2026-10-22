import fs from 'node:fs/promises';
import { createGithubProgress, githubProgressPublisher, finalProgressState } from '../src/github-progress.mjs';

try {
  if(process.argv[2]==='init') {
    const result=await createGithubProgress(process.env);
    await fs.appendFile(process.env.GITHUB_OUTPUT,`check_id=${result.id}\ncheck_url=${result.url}\n`);
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,`## 采集实时进度\n\n[打开GitHub实时进度](${result.url})\n\n运行期间每15秒更新设备及复查计数。设备身份、错误详情及报告仅保存在私有报告仓库。\n`);
    console.info(`GitHub实时进度：${result.url}`);
  } else if(process.argv[2]==='finish') {
    let state;try{state=JSON.parse(await fs.readFile('run/progress.json','utf8'));}catch{}
    await githubProgressPublisher(process.env,{onError:console.warn}).finish(finalProgressState(state,process.env));
  } else throw new Error('应指定init或finish');
} catch(error) {
  // UI failures must never stop collection or expose credentials/headers.
  console.warn(error.message.startsWith('GitHub')?error.message:'GitHub进度入口暂不可用，请查看采集步骤日志');
}
