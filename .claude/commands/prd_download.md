把飞书需求单挂的**全部**文档完整归档到 `docs/req/req_<需求单id>/prd/<日期>/`：需求单正文、各文档正文（保表格）、图片、附件、原始 blocks、完整性清单。

> 用法：`/prd_download <需求单URL>` [--no-images] [--doc <文档URL>] [--out-dir <目录>]
> 例：`/prd_download https://project.feishu.cn/kcty3k/story/detail/7069072169`

---

## 执行

```bash
PYTHONIOENCODING=utf-8 FS_ENV_FILE=config/feishu.env \
python tools/feishu-prd-review/scripts/fsprd.py fetch "<需求单URL>"
```

脚本自己完成整条链：读需求单 → 落 `story.md` → 从字段里找出**全部**飞书文档链接
（`wiki`/`prd`/`doc`，再扫所有含 `feishu.cn/wiki|docx` 的字段，按 token 去重）→ 逐篇抓 blocks →
还原 markdown → 下图片和附件 → 逐 block 校验完整性 → 写 MANIFEST。

第一篇是主 PRD，固定叫 `prd.md`；其余按文档标题命名。**需求单没挂文档也不报错**——
有的需求正文就是需求的全部，`story.md` 照样归档。

**你要做的**：跑完把输出**如实转述**给用户，重点是三行——blocks 数、图片/附件成败、完整性结论。
失败项不要淡化，也不要替用户决定"这些图不重要"。

## 产物

```
docs/req/req_<id>/prd/<YYYY-MM-DD>[-NN]/
├── story.md            需求单正文（字段 + 描述），不含抓取时间——它要进指纹
├── prd.md              主 PRD，表格还原成 markdown 表格
├── <附属文档标题>.md    需求单挂的其余文档，一篇一个（文件名过滤 Windows 非法字符）
├── blocks.json         全部文档的原始 block，完整性的最终依据
├── img/                主 PRD 的 imgNN.png；**附属文档在 img/dN/**
├── attachments/        同上，附属在 attachments/dN/
└── MANIFEST.md         清单 + 逐文档完整性结论 + 缺失项处置办法
```

🔴 **同一天重抓不会覆盖**，自动加 `-02`、`-03`。产品改文档时要靠日期快照做前后对比。
🔴 快照是**只读**的，不要手改 —— 需求内容真源在飞书，手改只会让指纹对不上。

## 参数

| 参数 | 用途 |
|---|---|
| `--doc <URL>` | 需求单没挂 PRD 链接时手动指定 |
| `--no-images` | 只要正文，跳过媒体 |
| `--out-dir <目录>` | 改输出位置（默认 `docs/req/req_<id>/prd/<今天>`，同日已有则 `-02`） |

---

## 🔴 三个必须知道的坑

### 1. 飞书是两套产品、两套凭证，媒体还是第三套权限

| | 读需求单 | 读 PRD 正文 | 下图片/附件 |
|---|---|---|---|
| 域名 | `project.feishu.cn` | `open.feishu.cn` | `open.feishu.cn` |
| 凭证 | `FS_PROJ_PLUGIN_*` | `FS_APP_ID/SECRET` | 同左，但**要额外的 scope** |

**能读正文 ≠ 能下媒体。** 实测同一个应用读 486 blocks 正常，8 张图全 403。

### 2. 图片 403 是**文件级权限**，目前只能用 UAT 绕过

先学会区分两类失败——报错形态完全不同，搞混会往错误方向排查（我们为此绕了三轮）：

```
缺 scope     → HTTP 400 + code=99991672 + JSON 里明确列出缺哪个权限
没文件权限    → HTTP 403 + Content-Length:0 + 空响应体，无错误码   ← 当前是这个
```

**当前可用解**：https://open.feishu.cn/api-explorer/ 取 `user_access_token`，
填进 `config/feishu.env` 的 `FS_USER_ACCESS_TOKEN=`。脚本会优先用它。
**约 2 小时过期**，进不了定时任务，每次要人工取一次。

**根治方向尚未跑通**，已验证的事实：

- 应用能读 `/drive/v1/metas/batch_query`（拿得到 owner、创建时间等元信息），
  但 `medias/{token}/download` 空体 403 —— 看得到文件、读不了内容
- 同一批文件用**用户身份 UAT** 一次通过（18/18 成功）
- 给应用身份补 `docs:document.media:download` scope 并发布新版本后，**仍然 403**

所以根因是应用对这些文件没有读取权限。界面上加文档协作者 / 加知识空间成员是否有效
**未能确认**（查协作者列表的接口本身也返回 `1063004 无 share 权限`，
API 加知识空间成员返回 `131006 permission denied`）。

### 3. 图往往就是需求本身，拿不到必须显式标注

实测一份 PRD：`2520×1520` 是业务流程图（正文只有 3 句概述），`868×487` 是详情抽屉 UI
（那半个需求正文只有 2 句）。**"只有一句话 + 一张图"的章节，图就是需求。**

图没下下来时，后续做需求质检必须在结论里写明「图 X 未覆盖」，不能假装读全了。

---

## 完整性怎么保证

脚本会把每个 block 的文本回查 `prd.md`，缺失项打印出来并写进 MANIFEST。
**看到「正文文本零缺失 ✅」才算真的全了**，没报错不等于没丢。

这条校验是有来历的：早期版本漏了 `block_type=23`（file 附件块），
附件被**静默丢弃**——md 里既没引用也不报错，不逐 block 回查根本发现不了。
实测丢的正是 PRD 里的 HTML 交互原型，而原型里有正文完全没写的交互细节。

如果 MANIFEST 报出缺失，说明 `blocks_to_markdown()` 还有没覆盖的 block 类型，
**要去修 `fsprd.py`，不是手工补 md**——手工补下次还会丢。

## 还有一类东西根本读不到

PRD 里贴的**外部设计稿链接**（Figma / 蓝湖 / 金山文档等）任何飞书凭证都拿不到，
只能人工导出。做质检时应显式列为「无法核验」。

---

## 自检

改完 `fsprd.py` 先跑 `python tools/feishu-prd-review/scripts/fsprd.py --selftest`
（不连网不连库，覆盖文件名过滤 / 快照目录序号 / 多文档去重 / `story.md` 稳定性）。

## 相关

- 工具与资料：`tools/feishu-prd-review/`（`docs/01-access-setup.md` 有完整错误码速查）
- 质检方法论：`tools/feishu-prd-review/docs/03-review-method.md`
- 产出样例：`review/2026-08-26-智能工单v2.2-工单数据页新建工单-需求质检.md`
