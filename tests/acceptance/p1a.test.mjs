// P1 acceptance tests TC-17 ~ TC-30.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  makeWorkspace,
  startStub,
  stubEnv,
  runCli,
  jsonLines,
  eventsOfType,
  contentBlocks,
  toolUses,
  toolResults,
  humanTexts,
  writeFile,
  listSessionIds,
  findSessionFiles,
  sha256File,
  countOf,
} from '../lib/harness.mjs'

const IS_WINDOWS = process.platform === 'win32'
const COMMAND_TOOL_DSH = IS_WINDOWS ? 'pwsh' : 'bash'
const COMMAND_TOOL_CLAUDE = IS_WINDOWS ? 'PowerShell' : 'Bash'

async function setup(t, tc, responder, options = {}) {
  const ws = await makeWorkspace(t, tc)
  const stub = await startStub(responder, options)
  t.after(() => stub.close())
  return { ws, stub }
}

function textsOf(events) {
  return eventsOfType(events, 'assistant').map(event =>
    contentBlocks(event.message).filter(block => block.type === 'text').map(block => block.text).join(''))
}

test('TC-17 [P1] 模型/运行错误输出 error_during_execution 并退出 1', async (t) => {
  const ws = await makeWorkspace(t, 'TC-17')
  const stub = await startStub(() => ({ status: 500, message: 'stub failure' }), { countTitles: true })
  t.after(() => stub.close())
  const patch = path.join(ws.root, 'no-retry.yml')
  await fsp.writeFile(patch, [
    '- id: llm-deepseek',
    '  config:',
    '    retryPolicy:',
    '      mode: normal',
    '      maxRetries: 0',
    '',
  ].join('\n'))

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '任意任务'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    patches: [patch],
    timeoutMs: 120000,
  })
  assert.equal(run.timedOut, false, `进程超时：${run.stderr.slice(-2000)}`)
  assert.equal(run.code, 1, `退出码应为 1，实际 ${run.code}`)

  const events = jsonLines(run.stdout)
  const results = eventsOfType(events, 'result')
  assert.ok(results.length >= 1, '缺少 result 事件')
  const last = results.at(-1)
  assert.equal(last.type, 'result')
  assert.equal(last.subtype, 'error_during_execution')
  assert.equal(last.is_error, true)
  assert.equal(events.some(event => event.type === 'result' && event.subtype === 'success'), false)
  assert.ok(run.stderr.trim().length > 0, 'stderr 应非空')
  assert.match(run.stderr, /Error|error/, 'stderr 应为英文诊断')
  assert.equal(/[一-鿿]/.test(run.stderr), false, `stderr 不应含中文堆栈：${run.stderr.slice(-1000)}`)
})

test('TC-18 [P1] stream-json 缺少 --verbose 时报错并退出 1', async (t) => {
  const { ws, stub } = await setup(t, 'TC-18', () => ({ text: 'hi' }))
  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 1, `退出码应为 1，实际 ${run.code}`)
  assert.equal(run.stdout, '', `stdout 应为空，实际 ${JSON.stringify(run.stdout)}`)
  assert.match(run.stderr, /verbose/i, 'stderr 应指出需要 --verbose')
  assert.equal(/[一-鿿]/.test(run.stderr), false, 'stderr 应为英文')
  assert.equal(stub.taskRequests().length, 0)
})

test('TC-19 [P1] 不认识的参数警告后继续执行', async (t) => {
  const { ws, stub } = await setup(t, 'TC-19', () => ({ text: 'OK' }))

  const first = await runCli({
    args: ['-p', '--chrome', '只回复 OK'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(first.code, 0, `第 1 次退出码应为 0，stderr：${first.stderr}`)
  assert.equal(first.stdout, 'OK\n')
  assert.ok(first.stderr.includes('dsCli: --chrome is not supported, ignored'), `缺少 --chrome 警告：${first.stderr}`)
  assert.equal(stub.taskRequests().length, 1)

  stub.reset()
  const second = await runCli({
    args: ['-p', '--bg', '--unknown-flag', '只回复 OK'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(second.code, 0, `第 2 次退出码应为 0，stderr：${second.stderr}`)
  assert.equal(second.stdout, 'OK\n')
  for (const flag of ['--bg', '--unknown-flag']) {
    assert.ok(
      second.stderr.includes(`dsCli: ${flag} is not supported, ignored`),
      `缺少警告 dsCli: ${flag} is not supported, ignored；实际：${second.stderr}`,
    )
  }
  assert.equal(stub.taskRequests().length, 1)
})

test('TC-20 [P1] --help / --version 不启动 agent，内容符合约定', async (t) => {
  const { ws, stub } = await setup(t, 'TC-20', () => ({ text: '不应被调用' }))

  const help = await runCli({ args: ['--help'], cwd: ws.cwd, env: stubEnv(ws, stub) })
  assert.equal(help.code, 0, '--help 退出码应为 0')
  for (const flag of [
    '-p', '--output-format', '--verbose', '--session-id', '-r', '-c',
    '--permission-mode', '--dangerously-skip-permissions', '--tools',
    '--allowedTools', '--disallowedTools', '--add-dir', '--model',
    '--append-system-prompt', '--system-prompt', '--strict-mcp-config',
    '--help', '--version',
  ]) {
    assert.ok(help.stdout.includes(flag), `--help 输出缺少 ${flag}`)
  }
  for (const absent of ['--bg', '--chrome', '--attach']) {
    assert.equal(help.stdout.includes(absent), false, `--help 不应列出 ${absent}`)
  }
  assert.equal(/^\s*mcp\b/m.test(help.stdout), false, '--help 不应列出 mcp 子命令')

  const version = await runCli({ args: ['--version'], cwd: ws.cwd, env: stubEnv(ws, stub) })
  assert.equal(version.code, 0, '--version 退出码应为 0')
  assert.equal(version.stdout, '2.1.319 (Claude Code compatible; dsCli 0.1.0)\n')

  assert.equal(stub.taskRequests().length, 0, '模型桩不应收到请求')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '不应创建会话')
})

test('TC-21 [P1] --session-id 校验：非 UUID、已存在、与 -r 互斥', async (t) => {
  const existing = '33333333-3333-4333-8333-333333333333'
  const { ws, stub } = await setup(t, 'TC-21', () => ({ text: 'ok' }))

  const created = await runCli({
    args: ['-p', '--session-id', existing, 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(created.code, 0, `准备会话失败：${created.stderr}`)
  const idsBefore = await listSessionIds(ws.dshHome)
  assert.deepEqual(idsBefore, [existing])
  const files = await findSessionFiles(ws.dshHome, existing)
  assert.equal(files.length, 1)
  const hashBefore = await sha256File(files[0])

  stub.reset()
  const invalid = await runCli({
    args: ['-p', '--session-id', 'not-a-uuid', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(invalid.code, 1, '非 UUID 应退出 1')
  assert.equal(invalid.stdout, '', '非 UUID 时 stdout 应为空')
  assert.ok(invalid.stderr.trim().length > 0, '非 UUID 时 stderr 应非空')
  assert.equal(/[一-鿿]/.test(invalid.stderr), false, 'stderr 应为英文')
  assert.deepEqual(await listSessionIds(ws.dshHome), idsBefore, '非 UUID 不应创建会话目录')

  const duplicate = await runCli({
    args: ['-p', '--session-id', existing, 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(duplicate.code, 1, '已存在的 --session-id 应退出 1')
  assert.equal(duplicate.stdout, '')
  assert.ok(duplicate.stderr.trim().length > 0)
  assert.equal(await sha256File(files[0]), hashBefore, '已存在会话的文件字节哈希不应变化')

  const conflict = await runCli({
    args: ['-p', '--session-id', '44444444-4444-4444-8444-444444444444', '-r', existing, 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(conflict.code, 1, '--session-id 与 -r 互斥，应退出 1')
  assert.equal(conflict.stdout, '')
  assert.ok(conflict.stderr.trim().length > 0)

  assert.equal(stub.taskRequests().length, 0, '三次校验均不应调用模型桩')
})

test('TC-22 [P1] 有位置参数时不读取 stdin', async (t) => {
  const { ws, stub } = await setup(t, 'TC-22', () => ({ text: 'OK' }))
  const run = await runCli({
    args: ['-p', '参数任务'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    stdin: '标准输入任务',
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr}`)
  const requests = stub.taskRequests()
  assert.equal(requests.length, 1)
  const texts = humanTexts(requests[0].body)
  assert.equal(texts.at(-1), '参数任务')
  assert.equal(requests[0].raw.includes('标准输入任务'), false, '请求 body 中不应出现 stdin 内容')
})

test('TC-23 [P1] --output-format json 只输出一条 result', async (t) => {
  const { ws, stub } = await setup(t, 'TC-23', () => ({ text: '纯文本结果' }))
  const run = await runCli({
    args: ['-p', '--output-format', 'json', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr}`)
  assert.equal(run.stderr, '', 'stderr 应为空')
  assert.equal(run.stdout.replace(/\r?\n$/, '').split(/\r?\n/).length, 1, `stdout 应只有 1 行：${run.stdout.slice(0, 500)}`)

  const events = jsonLines(run.stdout)
  assert.equal(events.length, 1)
  const result = events[0]
  assert.equal(result.type, 'result')
  assert.equal(result.subtype, 'success')
  assert.equal(result.is_error, false)
  assert.equal(result.result, '纯文本结果')
  assert.match(result.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.equal(result.total_cost_usd, 0)
  assert.deepEqual(result.permission_denials, [])
  assert.equal(run.stdout.includes('"type":"system"'), false, 'stdout 不应出现 system 事件')
  assert.equal(run.stdout.includes('"type":"assistant"'), false, 'stdout 不应出现 assistant 事件')
})

test('TC-24 [P1] 长文本与长工具结果不截断（≥ 40 KiB）', async (t) => {
  const { ws, stub } = await setup(t, 'TC-24', ({ n }) => {
    if (n === 1) {
      return { calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'long.txt') } }] }
    }
    return { text: 'y'.repeat(40000) }
  })
  // 400 行 × 100 字符 = 40000 个 x（单行远小于上游 read 的 2000 字符行上限）
  await writeFile(path.join(ws.cwd, 'long.txt'), Array.from({ length: 400 }, () => 'x'.repeat(100)).join('\n') + '\n')

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '读长文件', '--tools', 'Read'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const results = toolResults(events)
  assert.equal(results.length, 1)
  const content = results[0].content
  assert.equal(typeof content, 'string')
  assert.equal(countOf(content, 'x'), 40000, `tool_result 应含 40000 个 x，实际 ${countOf(content, 'x')}`)
  assert.equal(/truncat/i.test(content), false, '工具结果不应出现截断标记')

  const finalText = textsOf(events).at(-1)
  assert.equal(finalText.length, 40000, `最终 assistant 文本长度应为 40000，实际 ${finalText.length}`)
  assert.equal(finalText, 'y'.repeat(40000))

  const result = eventsOfType(events, 'result').at(-1)
  assert.equal(result.result.length, 40000, `result.result 长度应为 40000，实际 ${result.result.length}`)
  assert.equal(result.result, 'y'.repeat(40000))
})

test('TC-25 [P1] 续接时不输出上一轮的旧 result', async (t) => {
  const id = '55555555-5555-4555-8555-555555555555'
  const { ws, stub } = await setup(t, 'TC-25', ({ n }) => ({ text: n === 1 ? '旧结果' : '新结果' }))

  const first = await runCli({
    args: ['-p', '--session-id', id, '第一轮'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(first.code, 0, `准备会话失败：${first.stderr}`)

  stub.reset()
  const second = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '-r', id, '新任务'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(second.code, 0, `续接退出码应为 0，stderr：${second.stderr.slice(-2000)}`)
  const events = jsonLines(second.stdout)
  const results = eventsOfType(events, 'result')
  assert.equal(results.length, 1, `应恰有 1 条 result 事件，实际 ${results.length}`)
  assert.equal(results[0].result, '新结果')
  assert.equal(second.stdout.includes('"result":"旧结果"'), false, 'stdout 不应出现上一轮的旧 result')
})

test('TC-26 [P1] --tools 边界：空串、default、未知工具', async (t) => {
  const { ws, stub } = await setup(t, 'TC-26', () => ({ text: 'OK' }))

  const envStep = async (step) => {
    const home = path.join(ws.root, `dsh-${step}`)
    await fsp.mkdir(home, { recursive: true })
    return stubEnv(ws, stub, { DSH_HOME: home })
  }

  const empty = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', 'hi', '--tools', ''],
    cwd: ws.cwd,
    env: await envStep('empty'),
  })
  assert.equal(empty.code, 0, `--tools "" 退出码应为 0，stderr：${empty.stderr}`)
  const emptyEvents = jsonLines(empty.stdout)
  assert.deepEqual(eventsOfType(emptyEvents, 'system')[0].tools, [], '--tools "" 时 init.tools 应为 []')
  assert.deepEqual(stub.taskRequests().at(-1).body.tools ?? [], [], '--tools "" 时模型侧工具定义应为空')
  assert.equal(eventsOfType(emptyEvents, 'result').at(-1).subtype, 'success')

  stub.reset()
  const defaultTools = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', 'hi', '--tools', 'default'],
    cwd: ws.cwd,
    env: await envStep('default'),
  })
  assert.equal(defaultTools.code, 0, `--tools default 退出码应为 0，stderr：${defaultTools.stderr}`)
  const defaultInit = eventsOfType(jsonLines(defaultTools.stdout), 'system')[0]
  for (const required of ['Read', 'Write', 'Edit', 'Glob', 'Grep', COMMAND_TOOL_CLAUDE]) {
    assert.ok(defaultInit.tools.includes(required), `默认工具集应包含 ${required}，实际 ${JSON.stringify(defaultInit.tools)}`)
  }
  const defaultRequested = stub.taskRequests().at(-1).body.tools.map(tool => tool.name)
  for (const native of ['read', 'write', 'edit', 'glob', 'grep', COMMAND_TOOL_DSH]) {
    assert.ok(defaultRequested.includes(native), `默认模型工具定义应包含原生名 ${native}，实际 ${JSON.stringify(defaultRequested)}`)
  }
  assert.equal(eventsOfType(jsonLines(defaultTools.stdout), 'result').at(-1).subtype, 'success')

  stub.reset()
  const unknown = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', 'hi', '--tools', 'Read,MultiEdit'],
    cwd: ws.cwd,
    env: await envStep('unknown'),
  })
  assert.equal(unknown.code, 0, `未知工具应警告后继续，退出码：${unknown.code}`)
  const unknownEvents = jsonLines(unknown.stdout)
  assert.deepEqual(eventsOfType(unknownEvents, 'system')[0].tools, ['Read'], '未知工具应从白名单中忽略')
  assert.ok(unknown.stderr.includes('MultiEdit'), `stderr 应提及 MultiEdit：${unknown.stderr}`)
  assert.ok(/ignored/i.test(unknown.stderr), `stderr 应说明已忽略：${unknown.stderr}`)
  assert.equal(/Error/i.test(unknown.stderr), false, '未知工具警告不应包含 Error')
  assert.equal(eventsOfType(unknownEvents, 'result').at(-1).subtype, 'success')
})

test('TC-27 [P1] --allowedTools 不能突破 --tools，--disallowedTools 优先', async (t) => {
  const { ws, stub } = await setup(t, 'TC-27', ({ n }) => {
    if (n === 1) {
      return {
        calls: [
          { name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } },
          { name: COMMAND_TOOL_DSH, input: { command: 'echo hi', description: 'echo' } },
        ],
      }
    }
    return { text: '完成' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const first = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose', '执行',
      '--tools', 'Read', '--allowedTools', 'Read,Bash',
    ],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(first.code, 0, `第 1 次退出码应为 0，stderr：${first.stderr.slice(-2000)}`)
  const firstEvents = jsonLines(first.stdout)
  assert.deepEqual(eventsOfType(firstEvents, 'system')[0].tools, ['Read'], '--tools Read 时 init.tools 应为 ["Read"]')
  const firstUses = toolUses(firstEvents)
  const firstResults = toolResults(firstEvents)
  const commandUse = firstUses.find(use => use.name === COMMAND_TOOL_CLAUDE)
  if (commandUse) {
    const commandResult = firstResults.find(result => result.tool_use_id === commandUse.id)
    assert.ok(commandResult)
    assert.equal(commandResult.is_error, true, '--allowedTools 不应突破 --tools 放行命令工具')
  }

  stub.reset()
  const second = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose', '执行',
      '--allowedTools', 'Bash', '--disallowedTools', 'Bash',
    ],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(second.code, 0, `第 2 次退出码应为 0，stderr：${second.stderr.slice(-2000)}`)
  const secondEvents = jsonLines(second.stdout)
  const secondUses = toolUses(secondEvents)
  const secondResults = toolResults(secondEvents)
  const deniedUse = secondUses.find(use => use.name === COMMAND_TOOL_CLAUDE)
  assert.ok(deniedUse, '第 2 次应有命令工具调用')
  const deniedResult = secondResults.find(result => result.tool_use_id === deniedUse.id)
  assert.ok(deniedResult)
  assert.equal(deniedResult.is_error, true, 'disallowedTools 应优先于 allowedTools')
  const denials = eventsOfType(secondEvents, 'result').at(-1).permission_denials
  assert.ok(denials.some(item => item.tool_name === COMMAND_TOOL_CLAUDE), `permission_denials 应含 ${COMMAND_TOOL_CLAUDE}：${JSON.stringify(denials)}`)

  stub.reset()
  const third = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '执行', '--disallowedTools', 'WebFetch'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(third.code, 0, `第 3 次退出码应为 0，stderr：${third.stderr.slice(-2000)}`)
  const thirdInit = eventsOfType(jsonLines(third.stdout), 'system')[0]
  assert.equal(thirdInit.tools.includes('WebFetch'), false, '--disallowedTools WebFetch 后 init.tools 不应含 WebFetch')
})

test('TC-28 [P1] --strict-mcp-config 且无 --mcp-config 时不加载 MCP', async (t) => {
  const { ws, stub } = await setup(t, 'TC-28', () => ({ text: 'OK' }))
  await writeFile(path.join(ws.cwd, '.mcp.json'), JSON.stringify({
    mcpServers: {
      demo: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] },
    },
  }))

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const init = eventsOfType(events, 'system')[0]
  assert.deepEqual(init.mcp_servers, [], 'init.mcp_servers 应为 []')
  assert.equal(init.tools.some(tool => tool.startsWith('mcp__')), false, 'init.tools 不应含 mcp__ 工具')
  const requested = stub.taskRequests()[0].body.tools.map(tool => tool.name)
  assert.equal(requested.some(name => name.startsWith('mcp__demo__')), false, '模型工具定义不应含 mcp__demo__*')
})

test('TC-29 [P1] bypassPermissions 全放行，plan 只放行只读工具', async (t) => {
  const { ws, stub } = await setup(t, 'TC-29', ({ n }) => {
    if (n === 1) {
      return {
        calls: [
          { name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } },
          { name: 'write', input: { file_path: path.join(ws.cwd, 'written.txt'), content: 'hi' } },
          { name: COMMAND_TOOL_DSH, input: { command: IS_WINDOWS ? 'Write-Output hi' : 'echo hi', description: 'echo' } },
        ],
      }
    }
    return { text: '完成' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const expectedNames = ['Read', 'Write', COMMAND_TOOL_CLAUDE]

  const bypass = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '干活'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(bypass.code, 0, `bypassPermissions 退出码应为 0，stderr：${bypass.stderr.slice(-2000)}`)
  const bypassEvents = jsonLines(bypass.stdout)
  const bypassUses = toolUses(bypassEvents)
  const bypassResults = toolResults(bypassEvents)
  assert.deepEqual(new Set(bypassUses.map(use => use.name)), new Set(expectedNames))
  for (const use of bypassUses) {
    const result = bypassResults.find(item => item.tool_use_id === use.id)
    assert.ok(result, `工具 ${use.name} 缺少结果`)
    assert.equal(result.is_error, false, `bypassPermissions 下 ${use.name} 应成功`)
  }
  assert.deepEqual(eventsOfType(bypassEvents, 'result').at(-1).permission_denials, [])
  assert.equal(fs.existsSync(path.join(ws.cwd, 'written.txt')), true)

  await fsp.rm(path.join(ws.cwd, 'written.txt'), { force: true })
  stub.reset()
  const plan = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '干活'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(plan.code, 0, `plan 退出码应为 0，stderr：${plan.stderr.slice(-2000)}`)
  const planEvents = jsonLines(plan.stdout)
  const planUses = toolUses(planEvents)
  const planResults = toolResults(planEvents)
  for (const use of planUses) {
    const result = planResults.find(item => item.tool_use_id === use.id)
    assert.ok(result)
    if (use.name === 'Read') assert.equal(result.is_error, false, 'plan 下 Read 应成功')
    else assert.equal(result.is_error, true, `plan 下 ${use.name} 应被拒绝`)
  }
  const planDenials = eventsOfType(planEvents, 'result').at(-1).permission_denials
  assert.deepEqual(new Set(planDenials.map(item => item.tool_name)), new Set(['Write', COMMAND_TOOL_CLAUDE]))
  assert.equal(fs.existsSync(path.join(ws.cwd, 'written.txt')), false, 'plan 下不应写入文件')

  stub.reset()
  const dangerous = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '干活'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(dangerous.code, 0, `--dangerously-skip-permissions 退出码应为 0，stderr：${dangerous.stderr.slice(-2000)}`)
  const dangerousEvents = jsonLines(dangerous.stdout)
  const dangerousResults = toolResults(dangerousEvents)
  for (const use of toolUses(dangerousEvents)) {
    const result = dangerousResults.find(item => item.tool_use_id === use.id)
    assert.ok(result)
    assert.equal(result.is_error, false, `--dangerously-skip-permissions 下 ${use.name} 应成功`)
  }
  assert.deepEqual(eventsOfType(dangerousEvents, 'result').at(-1).permission_denials, [])
})

test('TC-30 [P1] acceptEdits 只放行工作目录与 --add-dir 内的编辑', async (t) => {
  const ws = await makeWorkspace(t, 'TC-30', { withAddDir: true })
  const outsideFile = path.join(ws.outside, 'bad.txt')
  const stub = await startStub(({ n }) => {
    if (n === 1) {
      return {
        calls: [
          { name: 'write', input: { file_path: path.join(ws.cwd, 'in.txt'), content: 'IN' } },
          { name: 'write', input: { file_path: path.join(ws.addDir, 'out.txt'), content: 'OUT' } },
          { name: 'write', input: { file_path: outsideFile, content: 'BAD' } },
          { name: COMMAND_TOOL_DSH, input: { command: IS_WINDOWS ? 'Write-Output hi' : 'echo hi', description: 'echo' } },
        ],
      }
    }
    return { text: '写完了' }
  })
  t.after(() => stub.close())

  const run = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--add-dir', ws.addDir, '写文件',
    ],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  assert.equal(await fsp.readFile(path.join(ws.cwd, 'in.txt'), 'utf8'), 'IN')
  assert.equal(await fsp.readFile(path.join(ws.addDir, 'out.txt'), 'utf8'), 'OUT')
  assert.equal(fs.existsSync(outsideFile), false, '工作目录与 add-dir 之外的写入不应发生')

  const events = jsonLines(run.stdout)
  const uses = toolUses(events)
  const results = toolResults(events)
  const outsideUse = uses.find(use => use.name === 'Write' && use.input?.file_path === outsideFile)
  assert.ok(outsideUse, '应有对 outside 的 Write 调用')
  const outsideResult = results.find(result => result.tool_use_id === outsideUse.id)
  assert.ok(outsideResult)
  assert.equal(outsideResult.is_error, true, 'outside 的 Write 应被拒绝')

  const result = eventsOfType(events, 'result').at(-1)
  assert.equal(result.subtype, 'success')
  assert.ok(
    result.permission_denials.some(item => item.tool_name === 'Write' && item.tool_input?.file_path === outsideFile),
    `permission_denials 应含 outside 的 Write 及路径：${JSON.stringify(result.permission_denials)}`,
  )
  assert.ok(
    result.permission_denials.some(item => item.tool_name === COMMAND_TOOL_CLAUDE),
    `permission_denials 应含 ${COMMAND_TOOL_CLAUDE}：${JSON.stringify(result.permission_denials)}`,
  )
  const commandUse = uses.find(use => use.name === COMMAND_TOOL_CLAUDE)
  if (commandUse) {
    const commandResult = results.find(item => item.tool_use_id === commandUse.id)
    assert.ok(commandResult)
    assert.equal(commandResult.is_error, true, 'acceptEdits 下命令工具应被拒绝')
  }
})
