# Upstream: DeepSeek Harness (DSH)

This directory contains a copy of the open-source DeepSeek Harness workspace, used as the
base of dsCli. dsCli adds the Claude Code compatible command line under
`packages/claude-compat/` and the `dscli` profile bundle under `packages/bundle/dscli/`.

## Snapshot

| Item | Value |
|---|---|
| Upstream repository | `https://github.com/deepseek-ai/deepseek-harness` |
| Pinned commit | `fcc0ad4` |
| Upstream version | `0.2.2-rc.1` |
| Copy date | 2026-11-09 |
| License | MIT (see `LICENSE` and `THIRD_PARTY_NOTICES`) |

Excluded from the copy: `.git/`, `node_modules/`, and build outputs (`lib/`, `dist/`, `*.tsbuildinfo`).
`code/.git` must not exist; this workspace is a plain directory inside the dsCli repository.

## Dependencies on upstream interfaces

dsCli intentionally depends on a small, recorded surface:

- profile composition (`dsh.profile.bundles`, `cordis.patch.yml` patch layers);
- the cordis agent, session, session-query, tools, system-prompt, and llm services;
- `ctx.agents.create` / `ctx.agents.resume`, `agent.followup`, `agent.whenIdle`, `agent.model.select`;
- session events `turn/start`, `turn/end`, `step/end`, `assistant/message`, `tool/call`, `tool/result`;
- the `tools/pre-execute` waterfall;
- `ctx.agents.create` session IDs, the JSONL session layout, and `--dump-config` output.

Anything outside that surface may change on the next upstream sync.

## Sync

1. Fetch the desired upstream commit and check out the copy in a scratch directory.
2. Copy the workspace into `code/` with the same exclusions. Do not copy `.git/`.
3. Re-apply dsCli's registered changes:
   - `packages/util/official-bundles/src/bundles.ts` (`dscli` profile template);
   - `packages/util/official-bundles/tests/official-bundles.spec.ts` (exact template expectation);
   - `apps/cli/package.json` (`@deepseek-ai/dsh-dscli` dependency);
   - `tsconfig.host.json` (references to `packages/claude-compat/cc-cli` and `packages/bundle/dscli`).
4. Run `pnpm install`, `pnpm run gen-tsconfig-paths`, and `pnpm run build`.
5. Run `pnpm run test:dscli` and the acceptance suite (`node ../tests/run-acceptance.mjs`).

## Conflicts

Upstream changes win in files dsCli does not own. Resolve conflicts in this order:

1. Keep upstream behaviour for every existing profile (`headless`, `web`, `acp`, `sdk`, `sdk-minimal`).
2. Adapt dsCli code under `packages/claude-compat/` and `packages/bundle/dscli/` to the new upstream API.
3. If an upstream change breaks the Claude-compatible contract, record the difference in
   `packages/claude-compat/README.md` and open a requirement note instead of weakening the contract.
4. Never commit real credentials; tests use fake keys.
