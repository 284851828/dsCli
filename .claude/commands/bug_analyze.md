分析**单条**飞书缺陷（智能工单空间）：读正文与截图 → 查 SLS 日志 → 对分支代码 → 出根因与方案，
按参数决定要不要落库、要不要发评论。

> 用法：`/bug_analyze <缺陷URL 或 work_item_id> [--save] [--comment] [--fix] [--no-notify] [--min-confidence N]`
>
> 例：`/bug_analyze https://project.feishu.cn/kcty3k/issue/detail/7102943609 --save`

## 参数

| 参数 | 默认 | 作用 |
|---|---|---|
| （无） | — | **只分析、只打印**，不碰库、不碰飞书。默认就是安全的 |
| `--save` | 关 | 结论写入 `tbbm.fs_analysis`，图片元信息写 `fs_bug_image` |
| `--comment` | 关 | 按下方格式发飞书评论。**对外可见且无法撤回通知，未给此参数绝不发** |
| `--fix` | 关 | 置信度 ≥ 阈值时建 `fix/bug_<id>` 分支并改代码。**未给此参数只给方案不动代码** |
| `--min-confidence` | 90 | `--fix` 的门槛 |
| `--no-notify` | — | **关闭**飞书群通报。群通报默认**开启**，见第 7.5 步 |

🔴 三个写操作参数**互相独立**，没给就是没授权。`--fix` 隐含需要 `--save`（改了代码要留档）。

---

## 固定常量

- **空间**：`kcty3k`（智能工单）。🔴 **只这一个空间**，不碰「福客AI客服」
- **飞书**：Meegle CLI（用户身份，`meegle auth status` 应为 `authenticated: true`；token 约 2 小时，过期用
  `meegle auth login --device-code --phase init --host project.feishu.cn` 重新取码）
- **日志**：`tools/sls-wo-logs/scripts/sls_query.py`，`--env test|prod` 由 `fs_bug.env` 决定
- **代码**：`code/wobackend` / `code/woclient` / `code/wowebui`
- 🔴 **版本↔分支、涉及端↔仓库、环境标记这三套映射，一律以 `niuma/fsbm/版本分支映射.json` 为准。**
  它会随迭代上线节奏变动，**不要把当时的对应关系抄进分析结论或写死在别处** —— 那样存量分析会被
  固化成过期口径。分析前先读一遍该文件的当前值和 `_待办` 段。
- **库**：`tbbm`，凭证 `config/tbbm.env`

  🔴 **`bug` / `bug_attachment` / `bug_review` / `sync_cursor` 四张表是 fcMerge 的生产数据，一个字都不许动。**
  本项目只用 `fs_` 前缀的三张表。

🔴 **代码只读，绝不切分支**：一律 `git -C code/<repo> show <分支>:<文件>` 和
`git -C code/<repo> grep <模式> <分支>`。**禁止 checkout / stash / pull / merge / reset**（`fetch` 允许）——
工作树可能停在别人的分支上且有未提交改动。唯一例外是 `--fix`，见第 8 步。

## 前置必读（并行读）

1. `niuma/fsbm/评论要求.md` —— 评论格式的唯一依据
2. `docs/knowledge/索引.md` 里与涉及模块相关的业务流程文档
3. `tools/feishu-bug-analysis-kit/docs/04-analysis-method.md` —— 取证纪律

---

## 执行步骤

### 1. 取缺陷

```bash
ID=<work_item_id>
mkdir -p niuma/fsbm/work/$ID
meegle workitem get --project-key kcty3k --work-item-id $ID --fields description \
  > niuma/fsbm/work/$ID/detail.json
meegle comment list --project-key kcty3k --work-item-id $ID > niuma/fsbm/work/$ID/comments.json
python niuma/fsbm/sync.py --id $ID     # 顺手刷新 fs_bug，拿到 env / repo / branch / owner
```

评论常含补充复现步骤和技术支持结论，**必读**，别只看描述。

### 2. 下图并**逐张看**

描述里的内嵌图在富文本里长这样：
`![](https://project.feishu.cn/goapi/v5/platform/file/stream/download/<token>)<!-- image:{"uuid":"..."} -->`

```bash
python - <<'PY'
import json,io,re
d=json.load(io.open('niuma/fsbm/work/'+__import__('os').environ['ID']+'/detail.json',encoding='utf-8'))
v=d['work_item_fields'][0]['value']
for i,u in enumerate(re.findall(r'!\[\]\((https://[^)]+)\)', v)): print(i,u)
PY
meegle attachment +download "<上面某个URL>" --project-key kcty3k --work-item-id $ID \
  --output niuma/fsbm/work/$ID/img/<i>.png --overwrite
```

🔴 **图必须真的打开看**（用 Read 工具读 png）。事发时刻、对象标识、报错原文常只在图里。
把每张图看到的关键信息写进 `images[].vision_text`，落库时一起存 —— 下次复核不用重下。

⚠️ 一次只下一张，URL 里有特殊字符，循环里用变量传容易被 shell 截断。

### 3. 分流：先判定链路，再翻代码

🔴 **不先分流就查代码 = 看错链路。** 从描述、截图、日志判定：问题出在**哪一端**、走**哪条业务链路**。

⚠️ **`fs_bug.repo` / `fs_bug.branch` 两列的口径（2026-09-16 改过，别按老印象用）：**

- **`repo` 为空 = 未知**，不是「没推出来」。「涉及端」填默认值「客户端」时**故意不映射** ——
  实测那批只有 18.6% 命中，给值等于主动误导。**空着就老老实实按证据反查。**
- **`repo` 有值 = 报告人主动改过涉及端**，约 90% 可信（`WEB端` 实测 95.7%），可以当强初筛，
  但仍要用证据确认，**不能直接当结论写进评论**。
- **`branch` 存的是逻辑名，只有 `develop` 和 `main` 两种。`main` 表示「主干」不是分支名** ——
  woclient / wowebui 的主干实际叫 `master`，**用之前必须查映射文件的『仓库主干』换成实际名字**。
  另外它依赖标题里的迭代版本号，识别不出来时落默认分支，**同样只是初筛**。

**以证据为准**：界面现象 → woclient/wowebui；接口返回或数据落库异常 → wobackend。
分支拿不准就先 `git -C code/<repo> log --oneline -5 origin/<branch>` 看一眼时间线对不对得上。

### 4. 取证

**4.1 先锚定事发现场再分析（铁律）**
锁定 ① 事发时刻 ② 当事对象标识（工单号/订单号/店铺）③ 当事操作 ④ 触发的那条真实数据，
再去日志里**定位到这一次**才开始分析。症状相似的其它时刻绝不能当根因。

时间窗按**事发日**而不是提单日，两者常差好几天。

**4.2 查日志**

```bash
python tools/sls-wo-logs/scripts/sls_query.py search --env test \
  --query "<工单号或关键词>" --last 24h --limit 50
```

日志带 `service/erp/erplog/flow.go:240` 这类文件行号，可直接对代码。
🔴 那是**打印这条日志的位置**，不是「该改的位置」，别当源码引用写进方案。

查不到别急着说「缺日志」—— 先换关键词、放宽时间窗、换 `--env`。

**4.3 读代码**

```bash
git -C code/woclient show develop:src/path/to/File.vue
git -C code/wobackend grep -n "<关键词>" develop
```

用前先确认分支存在：`git -C code/<repo> rev-parse --verify origin/<branch>`。

### 5. 产出结论

| 项 | 要求 |
|---|---|
| `layer` | 数据 / 配置 / 服务端 / 管理后台 / 客户端，**只填主因一个** |
| `summary` | 一句话，进评论第一句 |
| `root_cause` | 针对**这个具体现象**深挖，靠日志原文和 `文件:行` 锚定，不泛泛而谈 |
| `evidence` | 日志原文摘录 + 代码位置 + 截图看到的内容 |
| `timeline` | 有时间线就逐步写「时刻 + 事件 + 字段=值」 |
| `solution` | **最小改动**，解决问题且不引入新问题 |
| `confidence` | 0-100，见下 |

**置信度怎么给**（别拍脑袋）：

| 分档 | 条件 |
|---|---|
| 90+ | 代码、日志、现象**三方互证**，能指到 `文件:行`，且排除了邻近可能 |
| 70-89 | 根因明确但缺一环直证（如日志没捞到事发那次） |
| < 70 | 只有推断，或需要复现确认 |

🔴 **严禁以「展示层问题 / 待复现」草草收尾。** 回答不了「为什么是这条而不是邻近那条」就压低分数，不硬凑。

### 6. 落库（仅 `--save`）

```bash
cat > niuma/fsbm/work/$ID/analysis.json <<'JSON'
{"work_item_id": 0, "layer": "", "summary": "", "root_cause": "", "evidence": "",
 "timeline": "", "solution": "", "confidence": 0, "model": "claude-opus-5",
 "images": [{"seq": 0, "local_path": "", "source_url": "", "vision_text": ""}]}
JSON
python niuma/fsbm/save_analysis.py < niuma/fsbm/work/$ID/analysis.json
```

`round` 自动递增；同轮重跑覆盖。置信度 ≥90 且填了 `fix_branch` 才把 `fs_bug.sys_status` 推到 `fixed`，
否则只标 `analyzed`。

### 7. 发评论（仅 `--comment`）

严格按 `niuma/fsbm/评论要求.md` 六段：**① 问题出在哪 → ② 现象/原因/日志佐证 → ③ 时间线 →
④ 最小改动方案 → ⑤ 置信度 → ⑥ @负责人**。

✅ **走 CLI 发评论 markdown 会正常渲染**（2026-09-02 实测），放心用标题、列表、代码块。
那套全角符号排版只适用于插件 API 通道，别照抄。

```bash
meegle comment add --project-key kcty3k --work-item-id $ID --content "$(cat 评论正文.md)"
```

**@人现状**：`lark_user_id` 经 CLI 返回时被 float64 截断（低 10 位归零，六人抽样全部整除 1024），
带 mention 块会被服务端拒 `ErrCrossTenant`。**在 `contact:user.id:readonly` 开通前，评论里写纯文本
`@姓名`**（负责人取 `fs_bug.owner_name`）。工单有新评论时 Meego 本身会通知相关人，不影响流转。

发完把返回的 `comment_id` 补回 `fs_analysis`（重跑 `save_analysis.py` 即可覆盖）。

### 7.5 推送飞书群（默认开，`--no-notify` 关）

```bash
python niuma/fsbm/notify.py --work-item-id $ID
```

卡片带**可点链接 + 一句话结论 + 责任端/环境/置信度 + 负责人姓名**，内容取自
`fs_bug` 与 `fs_analysis` 最新一轮，消息格式只在 `notify.py` 一处维护。

前置条件（不满足就别发）：

- 必须**已落库**（`--save`）——`notify.py` 读不到 `fs_analysis` 记录会直接报错拒发
- **资料不足（置信度 < 30）的不推群**：群里刷「这条没法分析」没有价值，
  飞书评论已经通知到相关人了。这类只落库 + 评论，不通报

🔴 **被 `/bug_patrol` 调起时不要自己发** —— 巡检有自己的收尾通报（高优单独发 + 一条汇总），
worker 各发各的会刷屏。巡检派单时会显式传 `--no-notify`。

### 8. 改代码（仅 `--fix` 且置信度 ≥ 阈值）

```bash
git -C code/<repo> fetch origin
git -C code/<repo> checkout -b fix/bug_$ID origin/<branch>
```

- 这是**唯一允许切分支**的场景，且必须新建分支、基于 `origin/<branch>`，不在别人的工作树上改
- 🔴 **被 `/bug_patrol` 调起时不要执行本步** —— 每个仓库只有一个工作树，多个 worker 并发
  `checkout -b` 会互相覆盖、抢 `.git/index.lock`。巡检场景下 worker 只在结论里写清方案，
  由巡检主控**串行**执行修复（见 `bug_patrol.md` 的「分析并行，修复串行」）
- 改完**不自动提交、不自动推送**，把 diff 给用户看，等确认
- 置信度不到阈值 → **只给方案，不动代码**，并说明差在哪一环

### 9. 输出

一屏摘要：`#编号 | 环境 | 责任端 | 根因一句话 | 置信度 | 落库? | 评论? | 分支?`
证据留在 `niuma/fsbm/work/$ID/`。

---

## 坑

1. **不先分流就翻代码** → 看错链路
2. **不看图就下结论** → 事发时刻和报错原文常只在图里
3. **把 `fs_bug.repo` 为空当成「推导失败」** → 那是「未知」，是有意留的（默认值只有 18.6% 命中）；
   有值时可信约 90%，但仍要证据确认。**`branch` 里的 `main` 是「主干」不是分支名**，
   woclient / wowebui 得按『仓库主干』换成 `master` 再用，照抄会 `unknown revision`
11. **把当前的版本↔分支对应关系写进结论** → 迭代一上线就过期，只引用映射文件，不复述其内容
4. **把日志的 `file.go:240` 当源码行号写进方案** → 那是打日志的位置
5. **在共享工作树上 checkout** → 各仓停在别人分支且有未提交改动；
   多 worker 并发 checkout 更是必然互相破坏，巡检场景下修复只能由主控串行做
6. **查不到日志就判缺证** → 先换关键词、放宽窗口、换环境
7. **时间窗按提单日** → 应按事发日，两者常差好几天
8. **没给 `--comment` 却发了评论** → 对外可见且撤不回，这是硬红线
12. **巡检 worker 自己发群通知** → 一轮 30 条就是 30 条群消息，必须由巡检收尾统一发
9. **动 `bug` / `bug_attachment` 等四张表** → 那是 fcMerge 的生产数据
10. **置信度虚高** → 排除不了邻近根因就压分，不硬凑
