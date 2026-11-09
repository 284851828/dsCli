# @deepseek-ai/dsh-cc-cli

dsCli 的 Claude Code 兼容插件。参数与差异见[包组 README](../README.zh.md)。

| 导出 | 插件行 | 提供 |
|---|---|---|
| `./startup` | `cc-startup` | `ccStartup`：解析并校验后的命令行 |
| `./tool-names` | `cc-tool-names` | `ccToolNames`：Claude ⇄ DSH 工具名 |
| `./stream` | `cc-stream` | `ccStream`：`system/init` → `assistant`/`user` → `result` 投影，不截断 |
| `./permissions` | `cc-permissions` | `ccPermissions`：Claude 权限规则判定 |
| `.` | `cc-runner` | 每个进程执行一个任务；`config.modelAliases` 可覆盖 `opus`/`sonnet`/`haiku`/`fable` 别名表 |

测试：`pnpm run test:dscli`。
