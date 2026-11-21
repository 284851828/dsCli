# claude-compat

dsCli：基于 DeepSeek Harness 核心、与 Claude Code 兼容的非交互命令行。

| 包 | 职责 |
|---|---|
| [`@deepseek-ai/dsh-cc-cli`](cc-cli/README.zh.md) | 启动参数解析、工具名映射、事件投影、权限与 runner 插件 |
| [`@deepseek-ai/dsh-dscli`](../bundle/dscli/README.zh.md) | 在 `dsh-base` 之上挂载上述插件的 `dscli` profile bundle |

入口：`code\bin\dsCli.cmd`（Windows）与 `code/bin/dsCli`，执行 `node apps/cli/lib/bin.js --profile dscli`；
设置 `DSCLI_PATCH` 时追加 `--patch <path>`。DSH 变量未设置时，包装脚本把 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` 桥接到
`DEEPSEEK_API_KEY`，把 `ANTHROPIC_BASE_URL` 桥接到 `DEEPSEEK_BASE_URL`，把 `ANTHROPIC_MODEL` 桥接到 `DSCLI_MODEL`。

## 支持的参数

`-p/--print`（必填）、`[prompt...]` 或 stdin、`--output-format text|json|stream-json`（stream-json 需 `--verbose`）、
`--session-id <uuid>`、`-r/--resume <id>`、`-c/--continue`、`--permission-mode`、`--dangerously-skip-permissions`、
`--tools`、`--allowedTools`、`--disallowedTools`、`--add-dir`、`--model`、`--effort`、`--system-prompt`、
`--append-system-prompt`、`--strict-mcp-config`、`-h/--help`、`-v/--version`。
未知参数警告后丢弃（`DSCLI_STRICT=1` 时直接报错）。

## 与 Claude Code 的差异（0.01）

- 无交互模式、MCP 服务、hooks、skills、斜杠命令与 `.claude/agents`；不读 `.claude/settings.json` 与 `.mcp.json`。只加载 `CLAUDE.md`（作为用户上下文）。
- `--tools`/`--allowedTools`/`--disallowedTools` 是 variadic，写在其后的 prompt 会被当成工具名吞掉；请把 prompt 写在前面或走 stdin。
- `-c` 选当前目录下**创建时间**最新的会话，而不是最近更新的会话。
- 会话日志是 `$DSH_HOME/sessions`（默认 `~/.dsh`）下的纯 JSONL，不写 `~/.claude/projects`。
- Windows 上 `Bash` 映射到原生 `pwsh` 工具，对外报告为 `PowerShell`。
- 读图片：Claude Code 的 `Read` 能直接读出图片，DSH 把它分成 `read`（文本）和 `read_image` 两个工具。`read_image` 对外报告为 `Read`，`Read(路径)` 的放行和拒绝规则对它同样生效。`--tools` 里写了 `Read` 时，默认只给模型 `read`；要让模型同时拿到 `read_image`（比如需要看截图），在 profile 补丁里打开 `cc-runner` 的 `readImage`，并且当前模型路由要声明支持图片输入：

  ```yaml
  - id: cc-runner
    config:
      readImage: true
  ```

  不写 `--tools` 时 `read_image` 一直可用。模型不支持图片时，`read_image` 会直接拒绝并说明原因。
- `--version` 输出 `2.1.319 (Claude Code compatible; dsCli 0.1.0)`；启动器自身版本改用 `-V`。
- 命令权限规则按简单命令段做前缀匹配，不做完整 shell 解析。
