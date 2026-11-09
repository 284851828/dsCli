批量巡检三个仓库的待 review PR：拉新 → 大 PR 发跳过说明 → 认领 → 派 agent 并行 review →
落库评论 → 汇总。单条的 review 方法与评论格式**全部沿用 `/pr_review`**，本 skill 只管调度和收口。

> 用法：`/pr_patrol [--limit 10] [--agents 3] [--dry-run]`
>
> 定时跑：`/loop 30m /pr_patrol`

## 硬上限（不得突破）

| 项 | 值 | 说明 |
|---|---|---|
| 每轮处理 | **≤ 10 条** | `--limit` 只能调小不能调大。PR 量本来就小（三仓常态个位数 open） |
| 并行 agent | **≤ 3 个** | `--agents` 同上 |
| 单轮墙钟 | ~30 分钟 | 与巡检间隔一致，跑不完的**释放回队列**，下轮再来 |

`--dry-run`：走完全流程但**不发任何评论**，每条只打印评论正文。第一次跑、改完 prompt 后都该先干跑。

## 🔴 全程 git 只读（不可违反）

`code/wobackend` / `code/woclient` / `code/wowebui` 每个仓库**只有一个工作树**，3 个 worker 共用。
所以 worker 和主控**都不做任何 git 写操作**：不 `checkout`、不 `switch`、不 `commit`、不建分支。

`review.py context` 内部只 `git fetch` 到 `refs/gitreview/<n>`，这是只读安全的；
读文件一律 `git show <ref>:<路径>`。并发 `checkout` 的后果见 `/bug_patrol` 同名小节。

（这也是本系统和 `/bug_patrol` 的差别：那边有 `--fix` 要串行改代码，**这边压根不改代码**，
review 系统只出意见。）

---

## 步骤

### 1. 先同步，再干别的

```bash
python niuma/gitReview/sync.py
```

🔴 **跳过这步直接 claim 会拿旧快照**，评论到一个已经合并了的 PR 上。

sync 会把每条判成 `pending` 或 `skipped`：

- `skipped` + `files_changed IS NULL` → 目标分支不在白名单、或已 merged/closed，**不评论**，到此为止
- `skipped` + `files_changed` 有值 → 大 PR，**要发一条说明评论**，见第 2 步
- `pending` → 进 review 队列

### 2. 回收 + 大 PR 跳过说明

```bash
python niuma/gitReview/review.py reap                 # 回收上轮死掉的 worker 占着的
python niuma/gitReview/review.py skip-notify [--dry-run]   # 大 PR 的「已跳过」评论，纯脚本不过模型
python niuma/gitReview/review.py stats                # 看水位
```

`skip-notify` 不需要模型，直接跑。`--dry-run` 时带上 `--dry-run`。

### 3. 认领

```bash
python niuma/gitReview/review.py claim --limit <limit>
```

输出 `{"worker":"wNNNN","ids":[...]}`。`ids` 为空就直接跳到第 6 步报"本轮无待 review"。

claim 在事务里 `SELECT ... FOR UPDATE` 再 `UPDATE`，多个巡检同时跑不会撞。
窗口外（非工作日 / 不在 9:00-22:00）会直接拒绝，窗口配在 `niuma/gitReview/仓库分支.json`。

### 4. 派 agent 并行 review

把 `ids` 均分成 ≤ `--agents` 份，**一条消息里发多个 Agent 调用**让它们真并行。

每个 agent 的 prompt：

> 你是 PR reviewer。**严格按 `.claude/commands/pr_review.md` 的第 2-7 步执行**，
> 处理这几条：`--id <id1>`、`--id <id2>`……（第 1 步已由主控完成，直接从第 2 步开始）
>
> 授权：`--save --comment`{{--dry-run 时换成："只做到第 6 步，把 summary/findings 原样返回给我，不要 save 不要 comment"}}
>
> 🔴 全程 git 只读，不要 checkout 任何分支。
> 🔴 结论文件名带上 id（`work/findings_<id>.md`），**不要用通用名** —— 几个 worker 共用这个目录会互相覆盖。
> 🔴 每条处理完立即 `save`，不要攒到最后 —— 中途被打断时已完成的不会丢。
> 🔴 某条失败就 `release --status failed --reason <原因>` 放回，**不要卡住整批**。
>
> 返回：每条一行 `<repo>#<number> <verdict> <严重 N/建议 N/提示 N> <一句话结论>`。

worker 各自管自己的任务列表（`tasks/todo_pr_<worker>.md`），不要共用。

### 5. 收口

所有 agent 返回后：

```bash
python niuma/gitReview/review.py stats
```

还挂在 `reviewing` 的（agent 崩了没回执）→ `release --id <id> --status pending` 放回队列，下轮再来。
**不要自己补做** —— 本轮墙钟已经用掉了。

### 6. 汇总

给用户一张表，然后**结束**：

```
本轮巡检：同步 N 条 / 跳过 M 条 / review K 条
  wobackend#31  ✅ pass              3 文件，SQL 预检查与回滚齐备
  wowebui#44    🔴 严重 1 · 建议 2   <一句话>  https://gitee.com/.../pulls/44
未处理：<id 列表及原因>
```

**有「严重」的排在最前面** —— 汇总是给人扫一眼决定先看哪个的。

按全局指令，**耗时任务完成后用 wxnotify skill 发企业微信通知**，报本轮结果摘要；出错也要通知。

---

## 不要做的事

1. **不改代码** —— 本系统只出意见，没有 `--fix`。发现问题写在评论里，改不改是提交人的事
2. **不碰 Gitee 审查/合并状态**
3. **不重复评论** —— `pr_review` 对 `request_id` 唯一，claim 时已排除出过结论的。
   推了新 commit 会产生新的 `pr_request` 行（唯一键带 `head_sha`），那才该重新 review
4. **不越过窗口** —— 要强跑加 `--force`，但那是人工介入，不是巡检该干的
5. **不 cat `config/gitee.env`**
