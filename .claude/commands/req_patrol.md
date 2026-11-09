批量巡检需求流水线：同步 → 认领待推进的 → 并行跑各阶段 skill → 收尾通报。

> 用法：`/req_patrol [--limit N] [--force] [--dry-run]`

| 参数 | 默认 | 作用 |
|---|---|---|
| `--limit` | 5 | 本轮最多认领几条 |
| `--force` | 关 | 越过工作日 9:00-22:00 的巡检窗口 |
| `--dry-run` | 关 | 只认领并列出计划，**不真的跑 skill、不推进阶段** |

---

## 🔴 三条硬约束

1. **`ai_impl` 全局互斥**。三端 submodule 各只有一个工作树，两条需求同时改代码会互相覆盖、
   抢 `.git/index.lock`。`claim` 已保证同一时刻只放行一条，且**必须由主控串行执行**，
   绝不派给并行 subagent
2. **subagent 不许做 git 写操作**。评审、用例、设计三类阶段可以并行派 agent（它们只读代码、只写
   `docs/req/`），`ai_impl` / `ai_selftest` 一律主控自己跑
3. **跳过 `sync` 直接 `claim` = 拿旧快照干活**。飞书是需求内容的真源，第 1 步不能省

## 步骤

### 1. 同步 + 回收

```bash
python niuma/fsprm/sync.py
python niuma/fsprm/stage.py reap
```

`sync.py` 输出末尾若有「需求正文有变动」清单，**先处理它们**：
对每条重跑 `/prd_download` 到新日期目录，再 `stage.py snapshot --id <id>`，
按 snapshot 的提示决定是否在后续 `decide` 时带 `--doc-changed`。

### 2. 认领

```bash
python niuma/fsprm/stage.py claim --limit <N>
```

输出是 JSON：每条给出 `work_item_id`、`stage`、`round`、`待办线`、`产物目录`。
`因互斥跳过` 里的是被 `ai_impl` 互斥挡住的，本轮不动它们，下轮再说。

不在窗口内会拒绝执行 —— 除非用户明确要 `--force`，否则**照拒绝执行，别自己加 `--force`**。

### 3. 分派

按 `stage` 分两类：

| 阶段 | 怎么跑 | 用哪个 skill |
|---|---|---|
| `review`（`ai` 线 pending） | **并行** subagent，一条一个 | `/req_analyze <id> --decide` |
| `ai_testcase` | **并行** subagent | `/req_testcase <id> --decide` |
| `ai_design` | **并行** subagent | `/req_design <id> --decide` |
| `ai_impl` / `ai_selftest` | 🔴 **主控串行** | `/req_impl <id> --decide` |

派 subagent 时把这些告诉它：`work_item_id`、当前阶段与轮次、产物目录、
以及「**只读代码，禁止任何 git 写操作**」。

`--dry-run` 时到这一步就停，把计划列给用户看。

### 4. 收口

每条跑完确认状态对得上：

```bash
python niuma/fsprm/stage.py show --id <id>     # 逐条
python niuma/fsprm/stage.py stats              # 全局
```

有 subagent 失败或超时的，别让它占着认领：

```bash
python niuma/fsprm/stage.py release --id <id>
```

### 5. 通报

阶段真的流转了的才发：

```bash
python niuma/fsprm/notify.py --id <id>
```

最后给用户一张本轮小结表：

| 需求 | 原阶段 | 现阶段 | 结论 | 产物 |
|---|---|---|---|---|

**失败的、跳过的、打回的都要列出来**，不要只报成功的那几条。

## 🔴 容易踩的坑

1. **别把 `not_suitable` 当失败**。AI 判定「不适用 AI 开发」是正常结论，
   整单转 `manual_exit`，如实通报即可
2. **一条需求一轮只推进一个阶段**。跑完 `req_analyze` 别顺手接着跑 `req_testcase` ——
   评审要等开发和测试两条线，你看到的「已通过」可能只是 AI 自己那条
3. **飞书登录态约 2 小时过期**。整轮开始前先 `meegle auth status`
4. **冻结的需求（`frozen=1`）不会被认领**，这是人工干预的开关，不要绕过它
