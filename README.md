# nesc_scanner

JY 电池报警采集程序与 GitHub Actions。报告、客户与设备数据、状态及原始证据均存放在私有仓库 `liristy/nesc_report`。

原服务器定时器每天北京时间 16:00 触发本仓库 Actions（实际启动可能排队）。仅采集前一天 16:00（不含）至当天 16:00（含），工作日生成双报告，休息日仍采集，不补历史失败区间。

## 数据边界

- 本仓库只包含程序、合成测试与部署说明，使用独立 Git 历史。
- 运行时将私有报告库检出到忽略目录 `private-reports/`，所有设备资料在该目录处理。
- 报告及必要状态提交回私有报告库。原始证据、日志和诊断保存在私有库的草稿 Release 附件，不写入 Git 历史。
- 公开 Actions 不上传业务附件，日志不输出设备数据；实时进度只显示阶段和汇总计数。
- 保存证据时核验目标库确为私有，并回读校验 SHA-256 后才允许推进截止。兼容旧私有 Actions 原始证据指针，不删除历史附件。

## Secrets

在本仓库 Settings → Secrets and variables → Actions 配置：

| 名称 | 用途 |
| --- | --- |
| `REPORT_REPO_TOKEN` | 仅授权私有报告库：Contents 读写、Actions 读取（用于旧证据迁移） |
| `JY_ALARM_USERNAME` | 平台登录账号 |
| `JY_ALARM_PASSWORD` | 平台登录密码 |

优先使用只限报告库的细粒度令牌。凭据不写入文件或日志，不使用来自 PR 的代码运行正式采集。PR 仅执行不含 Secrets 的合成测试。

## 验证与运行

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:table
python -m unittest discover -s deploy/server-trigger -p 'test_*.py'
```

现场验收使用 Actions 的“心跳采集小批次验收”，从私有库已有跟踪状态中按报警时间从新到旧选取最多两台具有明确SN的设备，要求读取非空且完整的心跳记录，只读查询，不发布报告或推进截止。设备名单只在私有检出目录和进程内存中使用，不保存到公开库的Secret、变量或输入；详细结果保存在私有报告库的草稿 Release 中。

报告库专用访问令牌仅授权 `nesc_report`，按所有者要求设为永久有效。

正式入口是“JY 每日监测报告”。主线读取并写回报告库 `main`。分支手动重跑要求报告库已存在同名分支，检出和发布均使用该分支；不得回退到 `main`，也不清理主线证据。

迁移后先配置 Secrets 并完成只读小批次验收，再把仓库 Actions Variable `SCANNER_ENABLED` 设置为 `true` 启用正式采集；未启用时定时和手动日报都跳过采集。

正式定时入口沿用服务器 `nesc-report-trigger.timer`，目标已改为本仓库；GitHub 原生 schedule 已移除。部署方式见 [服务器触发器](deploy/server-trigger/README.md)。原服务器专用令牌沿用原名称，改为只授权 `nesc_scanner` 的 Actions 读写和必要 Metadata 读取，并设为永久有效。服务器仅持有触发令牌，平台凭据及私有报告库令牌保存在本仓库 Actions Secrets。

## 证据保留

迁移阶段不自动删除旧 Actions 附件或草稿 Release。最新证据由私有库 `state/cloud-runtime.json` 指向；旧报告、真实截止和状态保持原样。草稿 Release 不受 Actions 附件过期时间管理，需要按实际存储量另行制定清理策略。
