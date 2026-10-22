# Debian 12 定时触发器

服务器只调用 GitHub 的 workflow_dispatch，采集、报告、节假日判断和状态保存仍由原 Actions 工作流执行。定时器每天北京时间 16:00 启动，独立于服务器系统时区；Actions 收到请求后仍可能排队。

## 部署前提

- GitHub main 已包含可选的 trigger_id 工作流输入。本目录脚本使用该标识核对本次运行，避免把其他手动运行误认为触发成功。
- Debian 12 已安装 python3、ca-certificates、tzdata，使用 systemd。无需 Node.js、Chromium 或采集账号。
- 由仓库所有者配置仅限 liristy/nesc_scanner 的 GitHub 凭据，细粒度令牌需要 Actions: Read and write。令牌过期时需更新。不要使用更广权限的个人凭据，不要将令牌提交到仓库或发送到聊天。
- 将令牌放入服务器 /etc/nesc-report-trigger/github-token（root 所有，目录 0700，文件 0600），由 systemd LoadCredential 传入服务。脚本不会记录令牌。

## 安装及验收

连接服务器确认现有配置后，使用 root 执行以下非凭据安装步骤（不会启动任务）：

```sh
install -d -m 0755 /opt/nesc-report-trigger
install -m 0644 trigger.py /opt/nesc-report-trigger/trigger.py
install -m 0644 nesc-report-trigger.service /etc/systemd/system/
install -m 0644 nesc-report-trigger.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/nesc-report-trigger.service /etc/systemd/system/nesc-report-trigger.timer
systemd-analyze calendar '*-*-* 16:00:00 Asia/Shanghai'
systemctl daemon-reload
```

配置凭据后运行一次 `systemctl start nesc-report-trigger.service`，并通过 `journalctl -u nesc-report-trigger.service -n 30 --no-pager` 核对运行链接。日志确认的是触发成功，采集结果以 Actions 为准。

确认新运行对应当前 main 后，再执行 `systemctl enable --now nesc-report-trigger.timer`。用 `systemctl list-timers nesc-report-trigger.timer` 检查下次时间。仅在服务器联调成功后停用原 ChatGPT 触发，避免迁移期间漏跑。

## 防重复与失败处理

- 服务禁止并发，使用唯一的每日标识和本地状态，同一采集日不会自动重复发送。
- 写请求超时后保留“结果未知”状态，后续只读核对，不盲目重发。凭据错误也需检查日志后人工处理。
- 如需同日重新采集，可在 GitHub 页面手动运行原工作流，留空 trigger_id；仓库已有截止检查和失败续查逻辑。
- 当前当天模式只核查前一天16:00至当天16:00，不补跑历史失败区间、不自动追加追赶任务。假期仍采集，工作日生成正式报告；历史未恢复和待确认对象继续跟踪。
- 服务器关机错过时间后，Persistent=true 会在恢复时补触发一次，不补发多天重复任务。16:00之前恢复时用上一已到达触发日去重，仓库程序按实际截止判断窗口。
- 停用：`systemctl disable --now nesc-report-trigger.timer`。它不会取消 GitHub 上已启动的采集。

本地无网络测试：`python -m unittest discover -s deploy/server-trigger -p 'test_*.py'`。
