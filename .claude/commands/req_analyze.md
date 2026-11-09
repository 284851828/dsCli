走**评审阶段的 AI 审核线**：读 PRD → 判断是否适用 AI 开发 → 提问题与建议 → 出 md → 落库。
产品回复后重跑本 skill 就是复审（逐条核对上一轮问题是否闭环）。

> 用法：`/req_analyze <需求单URL 或 id> [--decide] [--comment]`
> 例：`/req_analyze 7078405903 --decide`

## 参数

| 参数 | 默认 | 作用 |
|---|---|---|
| （无） | — | **只分析、只出文档**，不推进阶段、不发飞书评论 |
| `--decide` | 关 | 把结论写进状态机（`stage.py decide --track ai`），可能触发阶段流转 |
| `--comment` | 关 | 往飞书需求单发评论。**对外可见且无法撤回，未给此参数绝不发** |

---

## 固定常量

- **流程定义** `niuma/fsprm/阶段定义.json`
- **评审方法论** `tools/feishu-prd-review/docs/03-review-method.md` —— 提问题的依据，先读
- **产物** `docs/req/req_<id>/01-AI分析_r<轮次>.md`
- 🔴 **代码只读**：`git -C code/<repo> show origin/<分支>:<文件>`。禁止 checkout / stash / reset

## 步骤

### 1. 取现状

```bash
python niuma/fsprm/stage.py show --id <id>
```

看三件事：`stage` 是不是 `review`、`当前待办` 里 `ai` 是不是 `pending`、`review_round` 是第几轮。

- 不在 `review` 阶段 → **停下**，告诉用户当前在哪个阶段，别硬跑
- `ai` 已是 `pass` 且轮次没变 → 这一轮已经审过了，问用户是不是要重审

### 2. 读需求

按顺序读，读全再动笔：

1. `docs/req/req_<id>/prd/<最新日期>/prd.md` —— PRD 正文（**主要依据**）
2. 同目录 `img/` 下的图 —— 原型图往往藏着正文没写的交互细节，**必须看**
3. `stage.py show` 输出里的 `description` —— 需求单正文
4. `docs/knowledge/索引.md` 里与本需求模块相关的业务流程文档
5. 若是复审（轮次 ≥ 2）：上一轮的 `01-AI分析_r<上一轮>.md` 和 `04-产品回复_r*.md`

没有 PRD 快照 → 先跑 `/req_import` 的第 2、3 步，别凭需求单标题硬编。

### 3. 判断是否适用 AI 开发

这是本阶段**第一位**的产出。判据（需求原文的口径）：

| 判据 | 不适用的信号 |
|---|---|
| 是否依赖大量外部沟通协调 | 要和第三方对接口、要等运营给规则、要拉会才能定边界 |
| 开发自测能否自动完成 | 依赖真实支付/短信/硬件、只能人肉验、没有可复现的测试数据 |
| 需求边界是否可界定 | 通篇「优化体验」「提升效率」，没有可验收的具体行为 |
| 是否触及高风险面 | 资金、权限、数据迁移、对外协议 |

结论只有两种，**不许骑墙**：
- **适用** → 继续走流水线
- **不适用** → verdict 用 `not_suitable`，整单转 `manual_exit`，并在文档里写清楚是上面哪一条卡住的

### 4. 提问题与建议

**简洁明了**（需求原文的要求）。每条必须是产品能直接回答的，不要写成读后感。

- 一条问题 = 一个可回答的疑点，附「为什么这会影响开发」
- 定位到 PRD 的**具体章节或图**，不要说「文档里有些地方不清楚」
- 没问题就写「无」——**不要凑数**。凑出来的问题会让产品对整个流程失去信任
- 建议与问题分开列：问题是**必须回答**的，建议是**可选采纳**的

### 5. 出文档

写到 `docs/req/req_<id>/01-AI分析_r<轮次>.md`：

```markdown
# <需求标题> —— AI 分析（第 N 轮）

> 需求单：<URL>　PRD 快照：docs/req/req_<id>/prd/<日期>/
> 分析时间：<YYYY-MM-DD>　模型：<model>

## 一、是否适用 AI 开发

**结论：适用 / 不适用**

<两三句话说明，不适用时点明卡在哪一条判据>

## 二、必须回答的问题

| # | 问题 | 出处 | 为什么影响开发 |
|---|---|---|---|
| 1 | … | PRD 第 3.2 节 / 图 4 | … |

## 三、建议（可选采纳）

1. …

## 四、复审：上一轮问题闭环情况
<仅第 2 轮起。逐条列上一轮的问题 → 产品怎么回的 → 是否闭环>

| # | 上轮问题 | 产品回复 | 闭环 |
|---|---|---|---|
| 1 | … | … | ✅ / ❌ 仍不明确：… |
```

第四节是复审的核心：**只要还有 ❌，verdict 就必须是 `reject`**，不能因为「大部分都回了」放行。

### 6. 落库（仅 `--decide`）

```bash
python niuma/fsprm/stage.py item --id <id> --kind artifact --track ai \
  --title "AI 分析 第 N 轮" --path "docs/req/req_<id>/01-AI分析_r<N>.md" \
  --author "<model>" --commit

python niuma/fsprm/stage.py decide --id <id> --track ai \
  --verdict pass|reject|not_suitable --actor "<model>" --reason "<一句话结论>"
```

`decide` 的输出会告诉你阶段有没有流转：
- `⏸ …尚未审完` → 另外两条线还没出结论，正常
- `✅ 需求评审 → 产品回复` → 你这条 reject 触发了整单退回
- `✅ 需求评审 → AI 生成自测用例` → 三条线全通过了

### 7. 飞书评论（仅 `--comment`）

```bash
PYTHONIOENCODING=utf-8 FS_ENV_FILE=config/feishu.env \
python tools/feishu-prd-review/scripts/fsprd.py comment "<需求单URL>" --file <上面那份 md>
```

### 8. 通报（阶段真的流转了才发）

```bash
python niuma/fsprm/notify.py --id <id>
```

## 🔴 容易踩的坑

1. **不要跳过看图**。原型图里的字段、按钮、空态，正文经常不写，只看正文提的问题会全是低质量的
2. **复审不是重新分析一遍**。第 2 轮起必须逐条对上一轮的问题，产品最烦的就是被反复问同样的事
3. **`not_suitable` 只有 AI 线能给**，且是终止信号 —— 不必等开发/测试两条线，整单直接转人工
4. **PRD 变更后别接着用旧快照**。`stage.py snapshot` 报「PRD 已变更」时，先重跑 `/prd_download`
5. **不要替产品做决定**。问题就是问题，不要写「我理解应该是 X，那就按 X 做」——
   那样错了没人负责，而且绕过了产品确认这一环
