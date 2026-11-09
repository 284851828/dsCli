// P1 acceptance tests TC-31 ~ TC-40.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  ensureInstalled,
  makeWorkspace,
  startStub,
  cliEnv,
  stubEnv,
  runCli,
  runPnpm,
  jsonLines,
  eventsOfType,
  contentBlocks,
  toolUses,
  toolResults,
  humanTexts,
  systemTextOf,
  parseDumpYaml,
  dumpEntry,
  writeFile,
  listSessionIds,
  sleep,
  countOf,
} from '../lib/harness.mjs'

const IS_WINDOWS = process.platform === 'win32'
const COMMAND_TOOL_DSH = IS_WINDOWS ? 'pwsh' : 'bash'
const COMMAND_TOOL_CLAUDE = IS_WINDOWS ? 'PowerShell' : 'Bash'

const CATALOG_PATCH = `- id: llm-deepseek
  config:
    models:
      - id: deepseek-flash
        name: DeepSeek Flash
        contextWindow: 1048576
      - id: env-model
        name: Env Model
        contextWindow: 1048576
      - id: cli-model
        name: CLI Model
        contextWindow: 1048576
      - id: deepseek-pro
        name: DeepSeek Pro
        contextWindow: 1048576
`

async function setup(t, tc, responder, options = {}) {
  const ws = await makeWorkspace(t, tc)
  const stub = await startStub(responder, options)
  t.after(() => stub.close())
  return { ws, stub }
}

function lastText(events) {
  return [...eventsOfType(events, 'assistant')]
    .reverse()
    .map(event => contentBlocks(event.message).filter(block => block.type === 'text').map(block => block.text).join(''))
    .find(text => text.length > 0)
}

test('TC-31 [P1] 模型优先级、别名与 provider/model 解析', async (t) => {
  const ws = await makeWorkspace(t, 'TC-31')
  const stub = await startStub(() => ({ text: 'ok' }))
  t.after(() => stub.close())
  const catalog = await writeFile(path.join(ws.root, 'catalog.yml'), CATALOG_PATCH)

  const runModel = async (args, envOverrides = {}, patches = [catalog]) => {
    stub.reset()
    const run = await runCli({
      args: ['-p', '--output-format', 'stream-json', '--verbose', ...args, 'hi'],
      cwd: ws.cwd,
      env: stubEnv(ws, stub, envOverrides),
      patches,
    })
    assert.equal(run.code, 0, `运行失败（${args.join(' ')}）：${run.stderr.slice(-2000)}`)
    const events = jsonLines(run.stdout)
    const init = eventsOfType(events, 'system')[0]
    const requests = stub.taskRequests()
    assert.ok(requests.length >= 1, `模型桩未收到请求（${args.join(' ')}）`)
    return { init, request: requests.at(-1), events }
  }

  const first = await runModel([])
  assert.equal(first.request.body.model, 'deepseek-flash', '默认模型应为 deepseek-flash')
  assert.equal(first.init.model, 'deepseek-flash')
  assert.equal(eventsOfType(first.events, 'assistant')[0].message.model, first.init.model, 'assistant.message.model 应与 init.model 一致')

  const fromEnv = await runModel([], { DSCLI_MODEL: 'env-model' })
  assert.equal(fromEnv.request.body.model, 'env-model')
  assert.equal(fromEnv.init.model, 'env-model')

  const fromCli = await runModel(['--model', 'cli-model'], { DSCLI_MODEL: 'env-model' })
  assert.equal(fromCli.request.body.model, 'cli-model', '--model 应优先于 DSCLI_MODEL')
  assert.equal(fromCli.init.model, 'cli-model')

  for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
    const result = await runModel(['--model', alias])
    assert.equal(result.request.body.model, 'deepseek-flash', `别名 ${alias} 应映射默认模型`)
    assert.equal(result.init.model, 'deepseek-flash')
  }

  // gw/qwen: 第二个模型桩，验证请求确实发往 gw provider 的 base URL
  const gwStub = await startStub(() => ({ text: 'from-gw' }))
  t.after(() => gwStub.close())
  const gwPatch = await writeFile(path.join(ws.root, 'catalog-gw.yml'), `${CATALOG_PATCH}- id: llm-pi-ai
  config:
    providers:
      gw:
        api: anthropic-messages
        baseURL: ${gwStub.url}/anthropic
        apiKeyEnv: DEEPSEEK_API_KEY
        models:
          - id: qwen
            name: Qwen
            contextWindow: 1048576
`)
  stub.reset()
  const viaProvider = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'gw/qwen', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    patches: [gwPatch],
  })
  assert.equal(viaProvider.code, 0, `gw/qwen 运行失败：${viaProvider.stderr.slice(-2000)}`)
  const gwRequests = gwStub.taskRequests()
  assert.equal(gwRequests.length, 1, `gw provider 应收到 1 次请求，实际 ${gwRequests.length}`)
  assert.equal(gwRequests[0].body.model, 'qwen', 'gw provider 请求的 model 应为 qwen')
  assert.match(gwRequests[0].url, /^\/anthropic\//, `请求应发往 gw provider 的 base URL，实际 ${gwRequests[0].url}`)
  assert.equal(stub.taskRequests().length, 0, '默认 provider 不应收到 gw/qwen 请求')
  const viaProviderInit = eventsOfType(jsonLines(viaProvider.stdout), 'system')[0]
  assert.equal(viaProviderInit.model, 'qwen')

  // 别名表可配置（不硬编码在代码里）
  const aliasPatch = await writeFile(path.join(ws.root, 'alias.yml'), `- id: cc-runner
  config:
    modelAliases:
      opus: deepseek-pro
`)
  const remapped = await runModel(['--model', 'opus'], {}, [catalog, aliasPatch])
  assert.equal(remapped.request.body.model, 'deepseek-pro', 'profile patch 应能覆盖别名表')
  assert.equal(remapped.init.model, 'deepseek-pro')
})

test('TC-32 [P1] 未知模型直接报错，不回落默认模型', async (t) => {
  const { ws, stub } = await setup(t, 'TC-32', () => ({ text: '不应被调用' }))
  const run = await runCli({
    args: ['-p', '--model', 'no-such-model', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 1, `退出码应为 1，实际 ${run.code}`)
  assert.equal(run.stdout, '', 'stdout 应为空')
  assert.match(run.stderr, /no-such-model/, `stderr 应指出未知模型：${run.stderr}`)
  assert.equal(/[一-鿿]/.test(run.stderr), false, 'stderr 应为英文')
  assert.equal(stub.taskRequests().length, 0, '不应悄悄改用默认模型发请求')
})

test('TC-33 [P1] --append-system-prompt 追加、--system-prompt 替换且保留工具能力', async (t) => {
  const { ws, stub } = await setup(t, 'TC-33', ({ n }) => {
    if (n === 1) {
      return { calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } }] }
    }
    return { text: 'done' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const appended = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose', '读 a.txt',
      '--tools', 'Read', '--append-system-prompt', 'APPEND-MARKER-42',
    ],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(appended.code, 0, `append 运行失败：${appended.stderr.slice(-2000)}`)
  const appendRequest = stub.taskRequests()[0]
  const appendSystem = systemTextOf(appendRequest.body)
  assert.ok(appendSystem.includes('APPEND-MARKER-42'), '请求 system 应包含 APPEND-MARKER-42')
  assert.ok(appendSystem.length > 'APPEND-MARKER-42'.length + 100, '追加提示词时应保留原有系统提示片段')
  assert.deepEqual(appendRequest.body.tools.map(tool => tool.name), ['read'], '追加提示词不应改变工具定义')

  stub.reset()
  const replaced = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose', '读 a.txt',
      '--tools', 'Read', '--system-prompt', 'REPLACE-MARKER-99',
    ],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(replaced.code, 0, `replace 运行失败：${replaced.stderr.slice(-2000)}`)
  const replaceRequest = stub.taskRequests()[0]
  const replaceSystem = systemTextOf(replaceRequest.body)
  assert.ok(replaceSystem.includes('REPLACE-MARKER-99'), '请求 system 应包含 REPLACE-MARKER-99')
  assert.equal(replaceSystem.includes('You are a coding agent powered by'), false, '替换后不应包含 headless 人设前缀')
  assert.ok(replaceRequest.body.tools.some(tool => tool.name === 'read'), '替换提示词后仍应提供原生 read 工具')

  const events = jsonLines(replaced.stdout)
  const uses = toolUses(events)
  const results = toolResults(events)
  assert.equal(uses.length, 1)
  assert.equal(uses[0].name, 'Read')
  assert.equal(results[0].is_error, false, '替换提示词后工具调用仍应成功')
})

test('TC-34 [P1] 写完 result 后 5 秒内退出，不等待后台命令', async (t) => {
  const { ws, stub } = await setup(t, 'TC-34', ({ n }) => {
    if (n === 1) {
      const command = IS_WINDOWS
        ? "Start-Process -FilePath node -ArgumentList '-e','setTimeout(()=>{},30000)'"
        : 'nohup node -e "setTimeout(()=>{},30000)" >/dev/null 2>&1 & echo started'
      return { calls: [{ name: COMMAND_TOOL_DSH, input: { command, description: 'start background' } }] }
    }
    return { text: '完成' }
  })

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '启动后台任务'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    timeoutMs: 60000,
  })
  assert.equal(run.timedOut, false, `进程超时：${run.stderr.slice(-2000)}`)
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  assert.equal(events.at(-1).type, 'result')
  assert.equal(events.at(-1).subtype, 'success')
  assert.ok(run.lastResultAt !== undefined, '未能定位 result 行写入时间')
  assert.ok(
    run.resultToExitMs <= 5000,
    `从写完 result 到进程退出应 ≤ 5000ms，实际 ${run.resultToExitMs}ms`,
  )
  assert.ok(run.durationMs < 25000, `不应等待 30 秒的后台命令，实际耗时 ${run.durationMs}ms`)
})

test('TC-35 [P1] --dump-config 确认外发日志与遥测关闭', async (t) => {
  const ws = await makeWorkspace(t, 'TC-35')
  const run = await runCli({ args: ['--dump-config'], cwd: ws.cwd, env: cliEnv(ws) })
  assert.equal(run.code, 0, `--dump-config 退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const entries = parseDumpYaml(run.stdout)

  assert.equal(dumpEntry(entries, 'session-log-deepseek')?.config?.enabled, false)
  const telemetry = dumpEntry(entries, 'session-telemetry-otel')
  assert.ok(
    telemetry === undefined || telemetry.disabled === true || telemetry.config?.enabled !== true,
    'session-telemetry-otel 应不存在或 disabled == true',
  )
  assert.equal(dumpEntry(entries, 'sandbox-policy')?.config?.mode, 'danger-full-access')
  assert.equal(dumpEntry(entries, 'approval')?.config?.policy, 'never')
  for (const id of ['hmr', 'credentials', 'authorization', 'deepseek-account']) {
    assert.equal(dumpEntry(entries, id)?.disabled, true, `${id} 应为 disabled: true`)
  }
})

test('TC-36 [P1] Windows 上 Bash 映射为 pwsh，输出报 PowerShell', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('仅在 Windows 验收平台运行')
    return
  }
  const { ws, stub } = await setup(t, 'TC-36', ({ n }) => {
    if (n === 1) {
      return { calls: [{ name: 'pwsh', input: { command: 'Write-Output hi', description: 'print hi' } }] }
    }
    return { text: '完成' }
  })

  const run = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose', '执行命令',
      '--permission-mode', 'bypassPermissions', '--tools', 'Bash',
    ],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const init = eventsOfType(events, 'system')[0]
  assert.ok(init.tools.includes('PowerShell'), `init.tools 应含 PowerShell，实际 ${JSON.stringify(init.tools)}`)
  assert.equal(init.tools.includes('Bash'), false, 'init.tools 不应含 Bash')

  const request = stub.taskRequests()[0]
  assert.deepEqual(request.body.tools.map(tool => tool.name), ['pwsh'], '模型侧工具定义应为原生 pwsh')

  const uses = toolUses(events)
  assert.equal(uses[0].name, 'PowerShell', '对外事件应使用 Claude 名 PowerShell')
  const results = toolResults(events)
  assert.equal(results[0].is_error, false)
  assert.ok(results[0].content.includes('hi'), `tool_result.content 应包含 hi，实际：${results[0].content.slice(0, 500)}`)
  assert.equal(/Bash is not supported/i.test(run.stderr), false, `stderr 不应出现 Bash 不支持警告：${run.stderr}`)
})

test('TC-37 [P1] 中文/空格路径、UTF-8 输出与 CRLF 内容', async (t) => {
  const ws = await makeWorkspace(t, 'TC-37')
  const cwd = path.join(ws.root, '临时 目录', '项目 01')
  const docDir = path.join(ws.root, '需求 目录')
  await fsp.mkdir(cwd, { recursive: true })
  await fsp.mkdir(docDir, { recursive: true })
  await writeFile(path.join(cwd, '说明.txt'), '第一行\r\n第二行\r\n')

  const stub = await startStub(({ n }) => {
    if (n === 1) {
      return { calls: [{ name: 'read', input: { file_path: path.join(cwd, '说明.txt') } }] }
    }
    return { text: '已完成：中文输出正常' }
  })
  t.after(() => stub.close())

  const run = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose', '读说明.txt',
      '--tools', 'Read', '--add-dir', docDir,
    ],
    cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  assert.equal(run.stdout.includes('�'), false, 'stdout 不应出现 U+FFFD 替换字符')

  const events = jsonLines(run.stdout)
  const init = eventsOfType(events, 'system')[0]
  assert.equal(init.cwd, cwd, `init.cwd 应为带中文与空格的原样绝对路径，实际 ${init.cwd}`)

  const result = toolResults(events)[0]
  assert.ok(result.content.includes('第一行'), 'tool_result.content 应包含第一行')
  assert.ok(result.content.includes('第二行'), 'tool_result.content 应包含第二行')
  // 上游 read 会归一化 CRLF，验收关注中文与换行内容未损坏（见 06-验收测试说明.md 偏差说明）。
  assert.equal(result.content.includes('�'), false, 'tool_result 不应出现替换字符')

  const finalResult = eventsOfType(events, 'result').at(-1)
  assert.equal(finalResult.result, '已完成：中文输出正常')
})

test('TC-38 [P1] -c 续接当前目录最近会话，无会话时报错', async (t) => {
  const olderId = '66666666-6666-4666-8666-666666666666'
  const newerId = '77777777-7777-4777-8777-777777777777'
  const { ws, stub } = await setup(t, 'TC-38', () => ({ text: 'ok' }))

  const first = await runCli({
    args: ['-p', '--session-id', olderId, '较早会话'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(first.code, 0, `较早会话创建失败：${first.stderr}`)
  await sleep(1200)
  const second = await runCli({
    args: ['-p', '--session-id', newerId, '较新会话'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(second.code, 0, `较新会话创建失败：${second.stderr}`)

  stub.reset()
  const continued = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '-c', '继续'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(continued.code, 0, `-c 退出码应为 0，stderr：${continued.stderr.slice(-2000)}`)
  const events = jsonLines(continued.stdout)
  const init = eventsOfType(events, 'system')[0]
  assert.equal(init.session_id, newerId, '-c 应选择当前 cwd 最新创建的会话')
  const texts = stub.taskRequests().flatMap(request => humanTexts(request.body))
  assert.ok(texts.includes('较新会话'), `续接请求应包含较新会话的消息，实际 ${JSON.stringify(texts)}`)
  assert.ok(!texts.includes('较早会话'), '续接请求不应包含较早会话的消息')

  const emptyDir = path.join(ws.root, 'empty')
  await fsp.mkdir(emptyDir, { recursive: true })
  stub.reset()
  const none = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '-c', '继续'],
    cwd: emptyDir,
    env: stubEnv(ws, stub),
  })
  assert.equal(none.code, 1, '无会话时 -c 应退出 1')
  assert.match(none.stderr, /No conversation found/, `stderr 应包含 No conversation found：${none.stderr}`)
  const results = eventsOfType(jsonLines(none.stdout), 'result')
  assert.equal(results.some(event => event.subtype === 'success'), false, '不应输出 success result')
  assert.equal(stub.taskRequests().length, 0, '无会话时不应调用模型桩')
})

test('TC-39 [P1] 参数值非法：stdout 为空、退出码 1', async (t) => {
  const { ws, stub } = await setup(t, 'TC-39', () => ({ text: '不应被调用' }))

  const format = await runCli({
    args: ['-p', '--output-format', 'yaml', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(format.code, 1, '非法 --output-format 应退出 1')
  assert.equal(format.stdout, '', '非法 --output-format 时 stdout 应为空')
  assert.ok(format.stderr.includes('yaml'), `stderr 应指出非法值 yaml：${format.stderr}`)
  assert.equal(/[一-鿿]/.test(format.stderr), false, 'stderr 应为英文')

  const mode = await runCli({
    args: ['-p', '--permission-mode', 'unknown-mode', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(mode.code, 1, '非法 --permission-mode 应退出 1')
  assert.equal(mode.stdout, '', '非法 --permission-mode 时 stdout 应为空')
  assert.ok(mode.stderr.includes('unknown-mode'), `stderr 应指出非法值 unknown-mode：${mode.stderr}`)

  assert.equal(stub.taskRequests().length, 0, '不应调用模型桩')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '不应创建会话')
})

test('TC-40 [P1] 回归：上游既有 profile 与登记测试不受影响', async (t) => {
  const installed = await ensureInstalled()
  assert.equal(installed.ok, true, `pnpm install 失败：${installed.detail}`)
  const ws = await makeWorkspace(t, 'TC-40')

  for (const profile of ['headless', 'sdk', 'acp']) {
    const run = await runCli({
      profile,
      args: ['--dump-config'],
      cwd: ws.cwd,
      env: cliEnv(ws),
    })
    assert.equal(run.code, 0, `${profile} --dump-config 退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
    const entries = parseDumpYaml(run.stdout)
    assert.ok(dumpEntry(entries, 'agent-default-model'), `${profile} 配置缺少 agent-default-model`)
    assert.equal(
      entries.some(entry => String(entry?.id ?? '').startsWith('cc-')),
      false,
      `${profile} 配置不应含 dscli 的 cc-* 插件行`,
    )
  }

  // 上游登记测试（profile 模板快照）必须仍然通过
  const spec = runPnpm(['exec', 'vitest', 'run', 'packages/util/official-bundles'], { timeout: 10 * 60 * 1000 })
  assert.equal(
    spec.code,
    0,
    `official-bundles 回归测试失败（退出码 ${spec.code}）\n${spec.stdout.slice(-4000)}\n${spec.stderr.slice(-4000)}`,
  )

  // headless profile 仍能完成一轮并输出 final 事件
  const stub = await startStub(() => ({ text: 'hi' }))
  t.after(() => stub.close())
  const headless = await runCli({
    profile: 'headless',
    args: ['--json', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(headless.code, 0, `headless 退出码应为 0，stderr：${headless.stderr.slice(-2000)}`)
  const events = jsonLines(headless.stdout)
  assert.equal(events.at(-1).type, 'final', `headless 最后一条应为 final，实际 ${JSON.stringify(events.at(-1)).slice(0, 500)}`)
  assert.equal(events.at(-1).text, 'hi')
})
