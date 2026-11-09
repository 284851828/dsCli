出**需求分析文档**与**系统设计文档**。开发工程师随后在这两份上改，改完由他 `decide` 通过。

> 用法：`/req_design <需求单URL 或 id> [--decide]`

| 参数 | 默认 | 作用 |
|---|---|---|
| （无） | — | 只出文档 |
| `--decide` | 关 | 落库并推进到「工程师确认设计」 |

---

## 固定常量

- **模板** `tools/feishu-prd-review/templates/需求分析文档模板.md` —— **照它的结构写**，别自创
- **样例** `tools/feishu-prd-review/examples/20260820_工单v2.2_工单数据页新建工单_需求分析.md`
- **编码约定** `docs/CodeStandards/` —— 设计里的命名、分层、错误处理要符合现有约定
- 🔴 **代码只读**：`git -C code/<repo> show origin/<分支>:<文件>` / `git -C code/<repo> grep <模式> origin/<分支>`。
  禁止 checkout / stash / pull / reset —— 三端工作树可能停在别人的分支上

## 步骤

### 1. 确认阶段

`stage.py show --id <id>`，`stage` 必须是 `ai_design`。

### 2. 摸清现状（这一步最花时间，不要省）

先搞清楚**现在的代码是怎么做的**，再谈怎么改：

1. `docs/knowledge/索引.md` → 相关模块的业务流程文档
2. 定位入口：接口路由、页面组件、消息消费者
3. 顺着调用链读到数据层，记下涉及的表与字段
4. 找**同类需求**过去是怎么实现的 —— 跟着现有模式走，比另起一套省事也省事故

判断涉及哪几端：`code/wobackend`（服务端）/ `code/wowebui`（管理后台）/ `code/woclient`（客户端）。

### 3. 需求分析文档

`docs/req/req_<id>/06-需求分析.md`，按模板结构。核心是把 PRD 的**产品语言**翻译成**工程语言**：

- 业务规则逐条拆成可实现的判定条件
- 每条规则标注依据（PRD 第 X 节 / 产品回复第 N 条）
- **列出 PRD 没说但必须定的**（并发怎么办、历史数据怎么处理、失败怎么补偿）——
  这些如果到编码时才发现，就得重新走一遍产品确认

### 4. 系统设计文档

`docs/req/req_<id>/07-系统设计.md`：

```markdown
# <需求标题> —— 系统设计

> 依据：06-需求分析.md　涉及端：<…>　目标分支：feat/req_<id>

## 一、改动范围

| 端 | 文件 | 改什么 | 新增/修改 |
|---|---|---|---|

## 二、数据模型
<表结构变更、索引、迁移脚本；无变更就写「无」>

## 三、接口
<新增/修改的接口：路径、入参、出参、错误码。沿用现有风格>

## 四、核心流程
<时序或步骤描述，把第 3 节的判定条件落到具体位置>

## 五、兼容与回滚
<存量数据怎么办、灰度怎么做、出问题怎么退>

## 六、风险
<明确写出来。没有风险也要写「无」并说明为什么>
```

**最小改动优先**：能复用现有函数就别新写，能加分支就别抽象层。
🔴 设计里出现「为了将来扩展，先抽一个接口」这类话，先问自己：现在有第二个实现吗？没有就删掉。

### 5. 落库并推进（仅 `--decide`）

```bash
python niuma/fsprm/stage.py item --id <id> --kind artifact --title "需求分析" \
  --path "docs/req/req_<id>/06-需求分析.md" --author "<model>" --commit
python niuma/fsprm/stage.py item --id <id> --kind artifact --title "系统设计" \
  --path "docs/req/req_<id>/07-系统设计.md" --author "<model>" --commit

python niuma/fsprm/stage.py decide --id <id> --verdict pass --actor "<model>" \
  --reason "涉及 <端>，改动 N 个文件；主要风险：<一句话>"
```

进入 `dev_design_ok`，等开发工程师改完并确认。他可以在看板上直接操作，也可以跑
`stage.py decide --id <id> --verdict pass|reject`。打回则退回本阶段重出设计。

### 6. 转述

三行：涉及哪几端、改动多少文件、**PRD 没说而你替它定了的地方有哪些**（这一条最重要，
需要开发和产品复核）。
