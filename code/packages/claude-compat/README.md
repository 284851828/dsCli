# claude-compat

dsCli: a Claude Code compatible, non-interactive command line over the DeepSeek Harness core.

| Package | Role |
|---|---|
| [`@deepseek-ai/dsh-cc-cli`](cc-cli/README.md) | startup parser, tool names, event projection, permissions, and runner plugins |
| [`@deepseek-ai/dsh-dscli`](../bundle/dscli/README.md) | the `dscli` profile bundle that mounts them over `dsh-base` |

Entry points: `code\bin\dsCli.cmd` (Windows) and `code/bin/dsCli` run
`node apps/cli/lib/bin.js --profile dscli`. `DSCLI_PATCH` adds `--patch <path>`.
When the DSH variable is unset, the wrappers bridge `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` → `DEEPSEEK_API_KEY`,
`ANTHROPIC_BASE_URL` → `DEEPSEEK_BASE_URL`, and `ANTHROPIC_MODEL` → `DSCLI_MODEL`.

## Supported flags

`-p/--print` (required), `[prompt...]` or stdin, `--output-format text|json|stream-json` (stream-json needs `--verbose`),
`--session-id <uuid>`, `-r/--resume <id>`, `-c/--continue`, `--permission-mode`, `--dangerously-skip-permissions`,
`--tools`, `--allowedTools`, `--disallowedTools`, `--add-dir`, `--model`, `--effort`, `--system-prompt`,
`--append-system-prompt`, `--strict-mcp-config`, `-h/--help`, `-v/--version`.
Unknown flags warn and are dropped (`DSCLI_STRICT=1` makes them fatal).

## Differences from Claude Code (0.01)

- No interactive mode, MCP servers, hooks, skills, slash commands, or `.claude/agents`; `.claude/settings.json` and `.mcp.json` are not read. Only `CLAUDE.md` is loaded (as user context).
- `--tools`, `--allowedTools`, and `--disallowedTools` are variadic, so a prompt written after them is consumed as a tool name. Put the prompt first or send it on stdin.
- `-c` picks the newest Session **created** in the working directory, not the most recently updated one.
- Session logs are plain JSONL under `$DSH_HOME/sessions` (default `~/.dsh`), not `~/.claude/projects`.
- On Windows, `Bash` maps to the native `pwsh` tool and is reported as `PowerShell`.
- Reading images: Claude Code's `Read` returns an image file as an image; DSH splits that into `read` (text) and `read_image`. `read_image` is reported as `Read`, and `Read(path)` allow and deny rules cover it. With `Read` in `--tools`, the model gets both `read` and `read_image` whenever its route declares image input, and `read` alone on a text-only model. To pin the model-side tool definitions of `--tools Read` to `read` alone, turn off `readImage` for `cc-runner` in a profile patch:

  ```yaml
  - id: cc-runner
    config:
      readImage: false
  ```

  A route declares image input with `input: [text, image]` on an `llm-pi-ai` model entry, or `inputModalities: [text, image]` on an `llm-deepseek` one. Without `--tools`, `read_image` is always available; on a model without image input it refuses and says why.
- `--version` prints `2.1.319 (Claude Code compatible; dsCli 0.1.0)`; the launcher keeps `-V` for its own version.
- Shell permission rules use prefix matching on simple command segments, not a full shell parser.
