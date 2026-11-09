review **单个** Gitee PR：取上下文 → 读 diff → 对分支代码 → 有关联缺陷就对照既有分析 →
出结论，按参数决定要不要落库、要不要评论。

> 用法：`/pr_review <PR URL 或 repo#number 或 --id <pr_request.id>> [--save] [--comment] [--dry-run]`
>
> 例：`/pr_review wobackend#31 --save --comment`
> 例：`/pr_review https://gitee.com/chengduzhihuige/wowebui/pulls/44`

## 参数

| 参数 | 默认 | 作用 |
|---|---|---|
| （无） | — | **只分析、只打印**，不碰库、不碰 Gitee。默认就是安全的 |
| `--save` | 关 | 结论写入 `tbbm.pr_review` |
| `--comment` | 关 | 发 Gitee 评论并 @提交人。**对外可见且发出去撤不回，未给此参数绝不发** |
| `--dry-run` | — | 配合 `--comment` 用：只打印最终评论正文，不发 |

🔴 `--comment` 隐含 `--save`：评论发出去了就必须留档，否则下轮巡检会重复评论。

---

## 固定常量

- **仓库**：`wobackend` / `woclient` / `wowebui`，owner `chengduzhihuige`
- **只 review base ∈ develop / master / main 的 PR**，源分支不限
- 🔴 **目标分支白名单、大 PR 阈值、缺陷号正则、巡检窗口，一律以 `niuma/gitReview/仓库分支.json` 为准**，
  不要在 prompt 里另写一套
- **代码 diff 一律走本地 git 的 `refs/pull/N/head`**，不走 API。fork 来的 PR 只有这条路走得通
- 🔴 **全程 git 只读**：三个仓库各只有一个工作树，`review.py context` 只 `fetch` 不 `checkout`。
  你也绝不要 `git checkout` / `git switch` / `git commit`（同 `/bug_patrol` 的并发工作树约束）

---

## 步骤

### 1. 定位到 pr_request 行

给了 `--id` 就直接用，跳到第 2 步。否则**一条命令搞定**（用户给的 PR 链接原样塞进 `--url`）：

```bash
python niuma/gitReview/sync.py --url "<用户给的 PR 链接>" --print-id
```

`--url` 吃三种写法：完整链接 `https://gitee.com/<owner>/<repo>/pulls/<n>`、`<repo>#<n>`、`<repo> <n>`。
**输出就是 `pr_request.id`**，后面几步都用它。

这条命令自带闸门：PR 若判成 `skipped`（目标分支不在白名单、已 merged/closed、超大 PR），
它会**非零退出**并打印 `⏭ 此 PR 不 review：<原因>`。此时**就此停手**，把原因原样报给用户。

> 已 merged / closed 的 PR 要强行 review（验证用），先 `python niuma/gitReview/sync.py --url "<链接>" --force`
> 再从输出里找 id。日常不要用。

### 2. 取上下文

```bash
python niuma/gitReview/review.py context --id <id>
```

输出含：PR 元信息、PR 描述、**关联缺陷的既有分析结论**（若有）、完整 diff。

缺陷号由 `sync.py` 从分支名 / 标题 / 描述 / **diff 的新增行**四处抽（很多 PR 只在代码注释里写号）。
**「关联缺陷」小节是这个 skill 最有价值的部分** —— 第 5 步的对照往往能抓到 diff 本身看不出的问题，
比如做了分析里明确标注「需拍板、本轮不动代码」的改动。有这一节就不要跳过第 5 步。

### 3. 读代码，不要只读 diff

diff 只给你改动的几行，判断对错要看周边。按需补读：

```bash
git -C code/<repo> show <base_sha>:<文件路径>        # 改之前的完整文件
git -C code/<repo> show refs/gitreview/<number>:<文件路径>   # 改之后的完整文件
git -C code/<repo> log --oneline -5 <base_sha> -- <文件路径>
```

🔴 **读工作树会拿到错代码**（工作树可能停在别人的分支上），一律用 `git show <ref>:<路径>`。

必要时用 Grep 找调用方：改了一个共用函数，所有调用方都受影响，这是最常漏的一类问题。

### 4. review 什么，以及定哪个等级

**每条结论必须定一个等级**，三档，含义是「**这事不改会怎样**」：

| 等级 | 判据 —— 不改会怎样 | 典型 |
|---|---|---|
| 🔴 **严重** | **会出事**：线上报错、数据错/丢、资损、越权、性能塌方 | 逻辑错误、空指针、边界漏判、并发、事务边界不对、SQL 注入、越权、金额/库存路径算错、错误被吞掉、资源没关、DB 变更没回滚脚本或 `WHERE` 依赖不稳定的键 |
| 🔴 **严重** | **与既定方案不一致**：说改 A 实际改了 B，或方案点名的文件根本没动 | 见第 5 步的对照 |
| 🟡 **建议** | 不会立刻出事，但**留着早晚要还** | 重复造轮子（项目里已有同款 util/helper 没用）、明显的 N+1、无意义的抽象、边界情况没覆盖但当前调用方碰不到 |
| 🔵 **提示** | 顺手一提，**不改也行** | 命名/注释确实会误导后人、日志缺了关键字段查问题会难 |
| — | **不要报** | 纯风格、格式化、个人偏好的命名、"建议加注释"、"建议加日志"、"建议加单测"（除非缺的是资损路径的测试） |

🔴 **严重档要克制。** 说不出「什么输入 → 什么后果」的具体链条，就不是严重，降级或删掉。
一个 PR 里挂三四条「严重」，基本说明你在通胀等级，没人会当真。

🔵 **提示档可以一条都没有。** 凑不出来就不凑。

🔴 **没把握的不要写成断言。** 拿不准就写"确认一下：……"，别说"这里有 bug"。
被误报打脸几次之后没人会再看 AI 的评论，这比漏报更伤。

🔴 **每条结论必须落到 `文件:行号`。** 说不出具体位置的，说明你没看懂，删掉。

### 5. 关联缺陷对照（第 2 步输出里有「关联缺陷」小节才做）

拿 `fs_analysis` 的既有结论逐项对：

- 既定方案说改的文件，这个 PR 动了吗？
- 改法和方案一致吗？不一致的话，是提交人发现了更好的办法，还是漏理解了？
- 根因里点名的那条路径，这次真的堵上了吗？还是只堵了症状？

结论写进 `--bug-check-file`，两三句话，一句话讲清"一致 / 不一致在哪"。
**没有关联缺陷就不要造这一节。**

### 6. 出结论

写两个文件到临时目录（`niuma/gitReview/work/` 已 gitignore）。

🔴 **文件名必须带 `<id>` 后缀**：`findings_<id>.md` / `bugcheck_<id>.md`。
`/pr_patrol` 下最多 3 个 worker 共用这一个目录，用 `findings.md` 这种通用名会互相覆盖
—— 2026-09-16 首次干跑就撞了一次，后一个 worker 把前一个的结论盖掉了。

`findings_<id>.md` —— 每条一个 `#### ` 小标题，**格式固定**，评论头部的「严重 1 · 建议 2」就是数它：

```markdown
#### 🔴 严重 · `internal/service/order.go:142` 事务里调了外部 HTTP，超时会把行锁扛到 30s

<两三句说清什么输入 → 什么后果，什么条件下触发>

建议：<具体怎么改，能给出代码就给代码>

#### 🟡 建议 · `internal/dao/order.go:88` 循环里查库，N+1

<同上>
```

小标题的硬格式：`#### <emoji> <等级> · \`文件:行号\` <一句话>`。
等级只能是 **严重** / **建议** / **提示**，emoji 对应 🔴 / 🟡 / 🔵。
**一条都没标等级的话 `save` 会直接拒绝**，别绕过它去改脚本。

按**严重在前**排序，同级按文件路径排。

`bugcheck_<id>.md`（可选）—— 第 5 步的对照结论。

**没发现问题就不要硬凑。** `verdict=pass`，`--summary` 一句话说清你检查了什么，
比如"3 个 SQL 文件，预检查/回滚脚本齐备，WHERE 用 path+title 双条件定位，未依赖 parent_id"。
这一句是给人看的"我确实看过了"的凭据，不要写成"代码质量良好"这种没信息量的话。

### 7. 落库并评论

先干跑看正文：

```bash
python niuma/gitReview/review.py save --id <id> --verdict issues \
  --summary "<一句话结论>" --findings-file niuma/gitReview/work/findings.md \
  --bug-check-file niuma/gitReview/work/bugcheck.md --confidence 80 --dry-run
```

正文没问题、且用户给了 `--comment`，去掉 `--dry-run` 真发。

`--confidence` 0-100：你对这些结论的把握。低于 60 的，先想想是不是该少报几条。

失败了别让行卡在 `reviewing`：

```bash
python niuma/gitReview/review.py release --id <id> --status failed --reason "<原因>"
```

---

## 评论格式

正文由 `review.py build_comment()` 拼，**你只负责 summary / findings / bug_check 三段内容**，
不要自己拼 `@` 和页脚。要点：

- 头部的「⚠️ **严重 1 · 建议 2**」由脚本数 `findings_<id>.md` 的小标题生成，**你不要自己写**
- Gitee 的 PR 评论**会渲染 markdown**（这点和飞书插件 API 不同，别照搬 `/bug_analyze` 的排版）
- @人用的是 **gitee login**（`author_login`），不是姓名。`@caojinbangs` 对，`@曹金榜` @不上
- 评论里**不写**"本 PR 不能合并""请勿合并"这类话 —— 我们只给意见，合不合由人定
- 代码块标 `diff` 或语言，行号写成 `` `路径:行号` ``

## 不要做的事

1. **不碰 Gitee 的审查/测试通过标记、不碰合并状态** —— 只评论
2. **不 `git checkout`** —— 全程只读，理由同 `/bug_patrol`
3. **同一个 head_sha 不重复评论** —— `pr_review` 对 `request_id` 有唯一键，
   推了新 commit 会是新的 `pr_request` 行，那才该重新 review
4. **不把 token 打到输出里** —— `config/gitee.env` 已 gitignore，也别 cat 它
