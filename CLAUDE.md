# dsCli

由 xCode 平台创建的新项目。

这是一个新项目， 主要是改造现有的开源项目，deepseek harness  让其client 功能等与 claude code 兼容

## 测试

写测试、跑测试、给出测试命令之前，先读 [测试规范](docs/测试规范.md)。要点：

- 统一入口 `node tests\run.mjs`：不带参数是全量测试（protocol + unit + acceptance），退出码 0 才算通过。
- **每个需求的验收测试放在 `tests/acceptance/req_<需求编号>/`**，用例名 `TC-<编号> [P0|P1|P2] <标题>`。已有的 `tests/acceptance/*.test.mjs` 属于需求 #14，不要移动。
- **新功能测试命令只写一行** `node tests\run.mjs acceptance --only req_<需求编号>`，不要 `cd /d` 到绝对路径。
- 验收测试只做黑盒：用 `tests/lib/harness.mjs` 驱动 `code\bin\dsCli.cmd`，模型用 `startStub()` 本机模型桩，不 import 产品源码，不连真实模型。
- 不写 `skip` / `todo`，跳过的用例按失败处理。
- 开发时只能**新增**测试，不能修改或删除已有测试，也不能改 `tests/lib/`、`tests/run.mjs`、`xcode.json`、`xcode.yaml`。认为验收测试有错，写进需求目录的 `用例质疑.md`。
