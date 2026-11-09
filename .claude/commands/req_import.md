把一条飞书需求单导入 fsprm 流水线：同步入库 → 归档 PRD 快照 → 记指纹 → 起流程。

> 用法：`/req_import <需求单URL 或 work_item_id>`
> 例：`/req_import https://project.feishu.cn/kcty3k/story/detail/7078405903`

**只读飞书、只写本地。** 不改飞书任何字段，不发评论。

---

## 固定常量

- **空间** `kcty3k`（智能工单），工作项类型 `story`。🔴 只这一个空间
- **流程定义** `niuma/fsprm/阶段定义.json` —— 阶段、角色、产物、打回规则的唯一依据
- **库** `tbbm`，只用 `fs_req` / `fs_req_stage` / `fs_req_item` 三张表。
  🔴 不碰 `fs_bug*` / `fs_analysis`（那是 fsbm 的），更不碰非 `fs_` 前缀的表
- **产物目录** `docs/req/req_<id>/`，PRD 快照在 `docs/req/req_<id>/prd/<日期>/`
  （`docs/prd/` 已于 2026-09-03 并入这里，不要再往那边写）

## 步骤

### 1. 同步入库

```bash
python niuma/fsprm/sync.py --id <work_item_id>
```

新导入的会自动建 `created` 阶段起始行。失败常见原因：

| 报错 | 原因 |
|---|---|
| 没查到需求单 | id 是缺陷不是需求（URL 里 `issue/` vs `story/`） |
| `10301` | 插件没**安装**到该空间（发布 ≠ 安装） |
| 连不上库 | `config/tbbm.env`，或表没建：`mysql … < niuma/fsprm/schema.sql` |

### 2. 归档 PRD

```
/prd_download <需求单URL>
```

默认就落到 `docs/req/req_<id>/prd/<今天>/`，同日重抓自动加 `-02`，**不用手工传 `--out-dir`**。
需求单挂几篇飞书文档就归档几篇：主 PRD 是 `prd.md`，其余按标题命名。

需求单上没挂 PRD 链接时不报错，只归档 `story.md`（需求单正文）——
据实告诉用户「这条需求没有 PRD 文档，只有需求单正文」。**不要编一个链接**，
确实另有文档的话用 `--doc <文档URL>` 手动指定。

### 3. 记指纹

```bash
python niuma/fsprm/stage.py snapshot --id <work_item_id>
```

首次会打印「首个 PRD 快照已记录」。以后每次产品改文档，重跑第 2、3 步就能发现变更。

指纹算的是快照目录下**所有 `.md`**（`story.md` + `prd.md` + 附属文档），排除 `MANIFEST.md`
（它含下载统计，重抓一次就变）。只盯 `prd.md` 的话附属文档改了会漏。

### 4. 起流程

确认无误后把它推进到评审：

```bash
python niuma/fsprm/stage.py decide --id <work_item_id> --verdict pass \
  --actor "<你的名字>" --reason "已导入，PRD 已归档"
```

进入 `review` 阶段，三条审核线（AI / 开发 / 测试）**并行**开始。

### 5. 转述

跑完把结果**如实**告诉用户，四行：

1. 需求标题、编号、当前阶段
2. 认到的产品 / 开发 / 测试是谁（认不出就说认不出，**不要猜**）
3. PRD 归档了多少 blocks、图片附件成败
4. 看板链接 `http://localhost:8710/req/<id>`（web 起着的话）

## 🔴 容易踩的坑

1. **角色认不出来** —— `role_owners` 的角色名各空间不一样，关键词在 `阶段定义.json` 的
   「角色关键词」里。认不出就去改那份 json，别改代码，也别手工往库里塞人名而不修根因
2. **PRD 图片 403** —— 是文件级权限，不是缺 scope，两者报错形态不同，见 `prd_download` skill 第 2 节。
   图没下全要**明说**，不要替用户判断「这些图不重要」
3. **重复导入是安全的** —— `sync.py` 按 `work_item_id` upsert，且 `stage` / `review_round` /
   `frozen` / `prd_*` 这些本系统状态**不会被回捞覆盖**。但第 4 步的 `decide` 会真的推进，别重跑
