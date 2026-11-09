# @deepseek-ai/dsh-dscli

The `dscli` profile bundle (`dsh --profile dscli`, template `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-dscli']`).
Its `cordis.patch.yml` inserts the five `cc-*` rows from [`@deepseek-ai/dsh-cc-cli`](../../claude-compat/cc-cli/README.md) and:

- uses no OS sandbox (`sandbox-policy.mode: danger-full-access`, `approval.policy: never`); `cc-permissions` decides every tool call;
- turns off session-log upload and telemetry (`session-log-deepseek.enabled: false`, `session-telemetry-otel` disabled);
- writes plain JSONL session logs and loads no skills;
- disables the interactive `hmr`, `credentials`, `authorization`, and `deepseek-account` rows, as headless does.
