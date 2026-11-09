# @deepseek-ai/dsh-cc-cli

The Claude Code compatible plugins of dsCli. See the [package group README](../README.md) for flags and differences.

| Export | Plugin row | Provides |
|---|---|---|
| `./startup` | `cc-startup` | `ccStartup`: parsed and validated command line |
| `./tool-names` | `cc-tool-names` | `ccToolNames`: Claude ⇄ DSH tool names |
| `./stream` | `cc-stream` | `ccStream`: `system/init` → `assistant`/`user` → `result` projection, never truncated |
| `./permissions` | `cc-permissions` | `ccPermissions`: Claude permission-rule decisions |
| `.` | `cc-runner` | one task per process; `config.modelAliases` overrides the `opus`/`sonnet`/`haiku`/`fable` table |

Tests: `pnpm run test:dscli`.
