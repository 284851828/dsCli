# @deepseek-ai/dsh-dscli

`dscli` profile bundle（`dsh --profile dscli`，模板 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-dscli']`）。
它的 `cordis.patch.yml` 插入 [`@deepseek-ai/dsh-cc-cli`](../../claude-compat/cc-cli/README.zh.md) 的五个 `cc-*` 行，并且：

- 不使用 OS 沙箱（`sandbox-policy.mode: danger-full-access`、`approval.policy: never`），每次工具调用由 `cc-permissions` 判定；
- 关闭会话日志上传与遥测（`session-log-deepseek.enabled: false`，`session-telemetry-otel` 禁用）；
- 会话日志写纯 JSONL，不加载 skills；
- 与 headless 一样禁用交互式的 `hmr`、`credentials`、`authorization`、`deepseek-account` 行。
