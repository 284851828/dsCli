按系统设计实现代码，再按自测用例跑自测。**开发工程师全程监工。**

> 用法：`/req_impl <需求单URL 或 id> [--decide]`
> 覆盖流程的步骤 9（AI 实现代码）与步骤 10（AI 自测），是两个阶段，分两次跑。

| 参数 | 默认 | 作用 |
|---|---|---|
| （无） | — | 只做事、只报告，不推进阶段 |
| `--decide` | 关 | 落库并推进到下一阶段 |

---

## 🔴 开跑前必须知道的三件事

### 1. 这个阶段是全局互斥的

`code/wobackend` / `code/woclient` / `code/wowebui` 三个 submodule **各只有一个工作树**。
两条需求同时改代码会互相覆盖、抢 `.git/index.lock`。

`stage.py claim` 已经保证同一时刻只有一条需求能进 `ai_impl`，
但**手工跑本 skill 时要自己确认**：

```bash
python niuma/fsprm/stage.py stats     # 「ai_impl」那一行只能有你这一条在认领中
```

有别人在跑 → **停下等**，不要硬上。

### 2. 这是唯一允许写 git 的阶段

其余所有 skill 都是 `git show` 只读。本阶段允许 `checkout -b` / `add` / `commit`，
但仍然**禁止** `push` / `merge` / `reset --hard` / `stash pop` 别人的东西。

开工前确认工作树干净：

```bash
git -C code/<repo> status --porcelain      # 必须为空
git -C code/<repo> fetch origin
```

不干净 → **停下问用户**。那可能是别人没提交的活，覆盖掉就找不回来了。

### 3. 开发工程师是监工，不是旁观者

每完成一个可独立验证的部分就停下来报告，让开发看一眼再继续。
不要一口气改 20 个文件再说「做完了」。

---

## 阶段一：实现代码（`stage` = `ai_impl`）

### 1. 读设计

`docs/req/req_<id>/07-系统设计.md` 的「改动范围」表就是施工图。
偏离它就要说明为什么 —— 设计是开发确认过的，擅自改法等于绕过确认。

### 2. 建分支

每个涉及的仓库各建一条，**名字统一**：

```bash
git -C code/<repo> checkout -b feat/req_<id> origin/<目标分支>
```

目标分支按迭代版本定，参照 `niuma/fsbm/版本分支映射.json`（两套系统共用一份映射）。

### 3. 写代码

- **风格跟现有代码走**：命名、分层、错误处理、注释密度，看邻居怎么写就怎么写
- **最小改动**：能改一处就别改三处；能复用就别新建
- 不做设计里没写的事。发现设计漏了 → 停下报告，可能要打回 `ai_design`

### 4. 提交

```bash
git -C code/<repo> add -- <具体文件>          # 🔴 不要 add -A
git -C code/<repo> commit -m "feat(req_<id>): <做了什么>"
```

### 5. 落库并推进（仅 `--decide`）

```bash
python niuma/fsprm/stage.py item --id <id> --kind artifact --title "实现分支" \
  --path "feat/req_<id>" --content "<repo>: <commit sha 列表>" --author "<model>"
python niuma/fsprm/stage.py decide --id <id> --verdict pass --actor "<model>" \
  --reason "<涉及端> 共 N 个文件，M 个提交"
```

---

## 阶段二：自测（`stage` = `ai_selftest`）

### 1. 逐条执行用例

依据 `docs/req/req_<id>/05-自测用例.md`。标了「需人工」的**不要假装跑了**。

能用的验证手段：

- 单元测试 / 接口测试：仓库里现有的测试框架，跟着现有测试写
- 日志核对：`PYTHONIOENCODING=utf-8 python tools/sls-wo-logs/scripts/sls_query.py … --env test`
- 数据核对：直接查库

### 2. 出报告

`docs/req/req_<id>/08-自测报告.md`：

```markdown
# <需求标题> —— AI 自测报告

> 分支：feat/req_<id>　依据：05-自测用例.md　时间：<YYYY-MM-DD>

## 结果总览

| 结果 | 条数 |
|---|---|
| ✅ 通过 | |
| ❌ 未通过 | |
| ⏭ 需人工（未执行） | |

## 逐条结果

| # | 场景 | 结果 | 证据 | 备注 |
|---|---|---|---|---|
| TC-01 | … | ✅ | <日志片段 / 断言 / SQL 结果> | |

## 未通过的问题
<每条：现象、原因、已修/待修、对应提交>

## 需人工验证的
<列出来交给开发，写清楚该怎么验>
```

🔴 **每条通过的用例都要有证据**。没有证据的「✅」等于没测 ——
后面开发冒烟、测试执行都会依赖这份报告，写虚了会一路传下去。

🔴 **失败不要淡化**。有 ❌ 就如实写，`verdict` 该是 `reject` 就 `reject`
（打回 `ai_impl` 自己修，修完再推进）。

### 3. 落库并推进（仅 `--decide`）

```bash
python niuma/fsprm/stage.py item --id <id> --kind artifact --title "AI 自测报告" \
  --path "docs/req/req_<id>/08-自测报告.md" --author "<model>" --commit
python niuma/fsprm/stage.py decide --id <id> --verdict pass --actor "<model>" \
  --reason "N 条通过，M 条需人工"
python niuma/fsprm/notify.py --id <id>
```

进入 `dev_smoke`，交给开发跑冒烟。

## 🔴 容易踩的坑

1. **不要 `git add -A`** —— 会把别人的散落改动、临时文件、凭证一起提交
2. **不要动 submodule 指针** —— 主仓库里 `code/*` 的指针由用户决定何时更新，AI 不碰
3. **分支名三端必须一致**（都叫 `feat/req_<id>`），否则后面没人找得到这次改动
4. **测试环境数据是共享的** —— 造数据前先想会不会踩到别人的用例
5. **改完不 push**。推不推、什么时候推，等用户说
