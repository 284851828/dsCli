// P1 acceptance tests TC-47 ~ TC-50.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  ensureBuilt,
  makeWorkspace,
  startStub,
  cliEnv,
  stubEnv,
  runCli,
  jsonLines,
  eventsOfType,
  toolUses,
  toolResults,
  systemTextOf,
  writeFile,
  listSessionIds,
} from '../lib/harness.mjs'

const IS_WINDOWS = process.platform === 'win32'
const COMMAND_TOOL_DSH = IS_WINDOWS ? 'pwsh' : 'bash'
const COMMAND_TOOL_CLAUDE = IS_WINDOWS ? 'PowerShell' : 'Bash'
const INPUT_ERROR = 'Error: Input must be provided either through stdin or as a prompt argument when using --print'

async function setup(t, tc, responder) {
  const ws = await makeWorkspace(t, tc)
  const stub = await startStub(responder)
  t.after(() => stub.close())
  return { ws, stub }
}

test('TC-47 [P1] --tools 逗号/空格等价，保留 variadic 吞参行为', async (t) => {
  let phase = 'text'
  const ws = await makeWorkspace(t, 'TC-47')
  const stub = await startStub(({ n }) => {
    if (phase === 'allowed' && n === 1) {
      return {
        calls: [
          { name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } },
          { name: 'glob', input: { pattern: '*.txt', path: ws.cwd } },
        ],
      }
    }
    return { text: 'OK' }
  })
  t.after(() => stub.close())
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const runTools = async (toolArgs) => {
    stub.reset()
    const run = await runCli({
      args: ['-p', '--output-format', 'stream-json', '--verbose', ...toolArgs],
      cwd: ws.cwd,
      env: stubEnv(ws, stub),
      stdin: 'hi',
    })
    return run
  }

  const comma = await runTools(['--tools', 'Read,Glob,Grep'])
  assert.equal(comma.code, 0, `逗号分隔退出码应为 0，stderr：${comma.stderr}`)
  const commaInit = eventsOfType(jsonLines(comma.stdout), 'system')[0]
  assert.deepEqual(new Set(commaInit.tools), new Set(['Read', 'Glob', 'Grep']))
  assert.equal(eventsOfType(jsonLines(comma.stdout), 'result').at(-1).subtype, 'success')

  const space = await runTools(['--tools', 'Read', 'Glob', 'Grep'])
  assert.equal(space.code, 0, `空格分隔退出码应为 0，stderr：${space.stderr}`)
  const spaceInit = eventsOfType(jsonLines(space.stdout), 'system')[0]
  assert.deepEqual(new Set(spaceInit.tools), new Set(['Read', 'Glob', 'Grep']))
  assert.equal(eventsOfType(jsonLines(space.stdout), 'result').at(-1).subtype, 'success')

  // 位置参数在 --tools 之后会被 variadic 吞掉；stdin 关闭 → 输入错误
  stub.reset()
  const swallowed = await runCli({
    args: ['-p', '--tools', 'Read', '读 a.txt'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    stdin: '',
  })
  assert.equal(swallowed.code, 1, 'prompt 被吞且 stdin 为空时应退出 1')
  assert.ok(swallowed.stderr.includes(INPUT_ERROR), `stderr 应包含逐字输入错误：${swallowed.stderr}`)
  assert.equal(stub.taskRequests().length, 0)

  // --allowedTools 不改变 system/init.tools；被允许的 Read/Glob 直接放行
  phase = 'allowed'
  stub.reset()
  const allowed = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read', 'Glob'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    stdin: 'hi',
  })
  assert.equal(allowed.code, 0, `--allowedTools 退出码应为 0，stderr：${allowed.stderr}`)
  const allowedEvents = jsonLines(allowed.stdout)
  const allowedInit = eventsOfType(allowedEvents, 'system')[0]
  for (const required of ['Read', 'Write', 'Edit', 'Glob', 'Grep']) {
    assert.ok(allowedInit.tools.includes(required), `--allowedTools 不应改变 init.tools，缺少 ${required}`)
  }
  const allowedUses = toolUses(allowedEvents)
  const allowedResults = toolResults(allowedEvents)
  assert.equal(allowedUses.length, 2, `应有 Read 与 Glob 两次调用，实际 ${allowedUses.length}`)
  for (const use of allowedUses) {
    assert.ok(['Read', 'Glob'].includes(use.name), `意外工具 ${use.name}`)
    const result = allowedResults.find(item => item.tool_use_id === use.id)
    assert.ok(result, `工具 ${use.name} 缺少结果`)
    assert.equal(result.is_error, false, `--allowedTools 应直接放行 ${use.name}`)
  }
  assert.equal(eventsOfType(allowedEvents, 'result').at(-1).subtype, 'success')
})

test('TC-48 [P1] dontAsk 与 auto 权限模式', async (t) => {
  const ws = await makeWorkspace(t, 'TC-48')
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')
  const marker = path.join(ws.cwd, 'marker.txt')
  const stub = await startStub(({ n }) => {
    if (n === 1) {
      return {
        calls: [
          { name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } },
          { name: COMMAND_TOOL_DSH, input: { command: 'echo hi > marker.txt', description: 'write marker' } },
        ],
      }
    }
    return { text: '完成' }
  })
  t.after(() => stub.close())

  const runMode = async (mode) => {
    await fsp.rm(marker, { force: true })
    stub.reset()
    return runCli({
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode, '干活'],
      cwd: ws.cwd,
      env: stubEnv(ws, stub),
    })
  }

  for (const mode of ['dontAsk', 'manual']) {
    const run = await runMode(mode)
    assert.equal(run.code, 0, `${mode} 退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
    const events = jsonLines(run.stdout)
    const uses = toolUses(events)
    const results = toolResults(events)
    const readUse = uses.find(use => use.name === 'Read')
    const commandUse = uses.find(use => use.name === COMMAND_TOOL_CLAUDE)
    assert.ok(readUse && commandUse, `${mode} 应包含 Read 与 ${COMMAND_TOOL_CLAUDE} 调用`)
    assert.equal(results.find(result => result.tool_use_id === readUse.id).is_error, false, `${mode} 下 Read 应成功`)
    assert.equal(results.find(result => result.tool_use_id === commandUse.id).is_error, true, `${mode} 下命令应被拒绝`)
    const denials = eventsOfType(events, 'result').at(-1).permission_denials
    assert.ok(denials.some(item => item.tool_name === COMMAND_TOOL_CLAUDE), `${mode} 的 denials 应含 ${COMMAND_TOOL_CLAUDE}`)
    assert.equal(eventsOfType(events, 'result').at(-1).subtype, 'success')
    assert.equal(fs.existsSync(marker), false, `${mode} 下命令不应执行`)
  }

  const auto = await runMode('auto')
  assert.equal(auto.code, 0, `auto 应警告后继续，退出码：${auto.code}，stderr：${auto.stderr}`)
  assert.ok(auto.stderr.includes('auto'), `stderr 应提及 auto：${auto.stderr}`)
  assert.match(auto.stderr, /ignored|not supported/i, `stderr 应说明已忽略：${auto.stderr}`)
  const autoEvents = jsonLines(auto.stdout)
  const autoUses = toolUses(autoEvents)
  const autoResults = toolResults(autoEvents)
  const autoCommand = autoUses.find(use => use.name === COMMAND_TOOL_CLAUDE)
  assert.ok(autoCommand, 'auto 应按默认模式执行工具调用')
  assert.equal(autoResults.find(result => result.tool_use_id === autoCommand.id).is_error, true, 'auto 按默认模式应拒绝命令')
  assert.ok(
    eventsOfType(autoEvents, 'result').at(-1).permission_denials.some(item => item.tool_name === COMMAND_TOOL_CLAUDE),
    `auto 的 denials 应含 ${COMMAND_TOOL_CLAUDE}`,
  )
  assert.equal(fs.existsSync(marker), false, 'auto 下命令不应执行')
})

test('TC-49 [P1] 模型地址/密钥兼容读取，缺失时大声失败', async (t) => {
  const built = await ensureBuilt()
  assert.equal(built.ok, true, `构建失败：${built.detail}`)
  const ws = await makeWorkspace(t, 'TC-49')
  const stub = await startStub(() => ({ text: 'OK' }))
  t.after(() => stub.close())

  // 1. 仅 DEEPSEEK_*
  const deepseek = await runCli({
    args: ['-p', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    mode: 'wrapper',
  })
  assert.equal(deepseek.code, 0, `DEEPSEEK_* 运行失败：${deepseek.stderr.slice(-2000)}`)
  assert.equal(stub.taskRequests().length, 1, 'DEEPSEEK_* 时模型桩应收到 1 次请求')

  // 2. 仅 ANTHROPIC_*（包装脚本桥接）
  stub.reset()
  const anthropic = await runCli({
    args: ['-p', 'hi'],
    cwd: ws.cwd,
    env: cliEnv(ws, {
      ANTHROPIC_BASE_URL: `${stub.url}/anthropic`,
      ANTHROPIC_AUTH_TOKEN: 'test',
    }),
    mode: 'wrapper',
  })
  assert.equal(anthropic.code, 0, `ANTHROPIC_* 运行失败：${anthropic.stderr.slice(-2000)}`)
  const bridged = stub.taskRequests()
  assert.equal(bridged.length, 1, `ANTHROPIC_* 时模型桩应收到 1 次请求，实际 ${bridged.length}`)
  const headers = bridged[0].headers
  const auth = headers['x-api-key'] ?? headers.authorization ?? ''
  assert.equal(auth, 'test', `请求应带 x-api-key/Authorization: test，实际 ${JSON.stringify({ 'x-api-key': headers['x-api-key'], authorization: headers.authorization })}`)

  // 3. 两组变量都不设置 → 大声失败
  stub.reset()
  const missing = await runCli({
    args: ['-p', 'hi'],
    cwd: ws.cwd,
    env: cliEnv(ws),
    mode: 'wrapper',
  })
  assert.equal(missing.code, 1, `缺少模型配置应退出 1，实际 ${missing.code}`)
  assert.equal(missing.stdout, '', '缺少模型配置时 stdout 应为空')
  assert.match(missing.stderr, /DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN/, `stderr 应指出缺少的凭据：${missing.stderr}`)
  assert.equal(/[一-鿿]/.test(missing.stderr), false, 'stderr 应为英文')
  assert.equal(stub.taskRequests().length, 0, '缺少凭据时不应发出请求')
})

test('TC-50 [P1] 0.01 不加载 .claude 的 skills/commands/agents/hooks', async (t) => {
  const { ws, stub } = await setup(t, 'TC-50', ({ n }) => {
    if (n === 1) {
      return { calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } }] }
    }
    return { text: '完成' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')
  await writeFile(path.join(ws.cwd, 'CLAUDE.md'), 'CLAUDE-MARKER-OK\n')
  await writeFile(path.join(ws.cwd, '.claude', 'skills', 'foo', 'SKILL.md'), 'SKILL-MARKER-1\n')
  await writeFile(path.join(ws.cwd, '.claude', 'commands', 'bar.md'), 'COMMAND-MARKER-2\n')
  await writeFile(path.join(ws.cwd, '.claude', 'agents', 'baz.md'), 'AGENT-MARKER-3\n')
  await writeFile(path.join(ws.cwd, '.claude', 'settings.json'), JSON.stringify({
    permissions: { deny: ['Read'] },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `echo ran > ${path.join(ws.cwd, 'hook-ran.txt')}` }] }],
    },
  }, null, 2))
  await writeFile(path.join(ws.cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'] } },
  }, null, 2))

  const run = await runCli({
    args: [
      '-p', '--output-format', 'stream-json', '--verbose', '读 a.txt',
      '--tools', 'Read,Bash', '--permission-mode', 'bypassPermissions',
    ],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const init = eventsOfType(events, 'system')[0]
  const request = stub.taskRequests()[0]
  const requestText = systemTextOf(request.body) + '\n' + JSON.stringify(request.body.messages ?? [])

  // CLAUDE.md 由上游以 system-reminder 用户上下文注入，不强制落在 system 字段（见 06 偏差说明）。
  assert.ok(requestText.includes('CLAUDE-MARKER-OK'), '请求上下文应包含工作目录 CLAUDE.md 内容')
  for (const marker of ['SKILL-MARKER-1', 'COMMAND-MARKER-2', 'AGENT-MARKER-3']) {
    assert.equal(requestText.includes(marker), false, `请求上下文不应包含 ${marker}`)
  }
  assert.equal(init.tools.some(tool => tool.startsWith('mcp__')), false, 'init.tools 不应含 mcp__ 工具')
  const requested = request.body.tools.map(tool => tool.name)
  assert.equal(requested.some(name => name.startsWith('mcp__')), false, '模型工具定义不应含 mcp__ 工具')
  assert.equal(requested.some(name => name.includes('baz')), false, '不应由 .claude/agents 派生子 agent 类型')
  assert.equal(fs.existsSync(path.join(ws.cwd, 'hook-ran.txt')), false, '项目目录下不应执行 hook')
  assert.equal(fs.existsSync(path.join(ws.root, 'hook-ran.txt')), false, '工作区下不应执行 hook')
})
