// P0 acceptance tests (TC-01 ~ TC-16). Black box only: real CLI processes,
// a local Anthropic-Messages stub, stdout/stderr/exit codes, session files.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  ensureInstalled,
  ensureBuilt,
  makeWorkspace,
  startStub,
  cliEnv,
  stubEnv,
  runCli,
  jsonLines,
  eventsOfType,
  contentBlocks,
  toolUses,
  toolResults,
  humanTexts,
  parseDumpYaml,
  dumpEntry,
  findSessionFiles,
  readSessionText,
  sessionLineCount,
  writeFile,
  sha256File,
  listDirs,
  UUID_RE,
  ROOT,
  CODE,
} from '../lib/harness.mjs'

const IS_WINDOWS = process.platform === 'win32'
const COMMAND_TOOL_DSH = IS_WINDOWS ? 'pwsh' : 'bash'
const COMMAND_TOOL_CLAUDE = IS_WINDOWS ? 'PowerShell' : 'Bash'

async function wsWithStub(t, tc, responder, { withAddDir = false, stubOptions = {} } = {}) {
  const ws = await makeWorkspace(t, tc, { withAddDir })
  const stub = await startStub(responder, stubOptions)
  t.after(() => stub.close())
  return { ws, stub }
}

function lastTextOfAssistant(event) {
  return contentBlocks(event?.message)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

test('TC-01 [P0] 基座构建成功，dscli profile 配置树可导出且包含五个插件行', async (t) => {
  const installed = await ensureInstalled()
  assert.equal(installed.ok, true, `pnpm install 失败：${installed.detail}`)
  const built = await ensureBuilt()
  assert.equal(built.ok, true, `pnpm run build 失败：${built.detail}`)

  const ws = await makeWorkspace(t, 'TC-01')
  const dumped = await runCli({
    args: ['--dump-config'],
    cwd: ws.cwd,
    env: cliEnv(ws),
    timeoutMs: 180000,
  })
  assert.equal(dumped.timedOut, false, `--dump-config 超时：${dumped.stderr.slice(-2000)}`)
  assert.equal(dumped.code, 0, `--dump-config 退出码应为 0，stderr：${dumped.stderr.slice(-2000)}`)
  assert.equal(dumped.stderr.trim(), '', `--dump-config 不应写 stderr：${dumped.stderr.slice(-2000)}`)

  const entries = parseDumpYaml(dumped.stdout)
  for (const id of ['cc-startup', 'cc-runner', 'cc-stream', 'cc-permissions', 'cc-tool-names']) {
    assert.ok(dumpEntry(entries, id), `配置树缺少插件行 ${id}`)
  }
  assert.equal(dumpEntry(entries, 'sandbox-policy')?.config?.mode, 'danger-full-access')
  assert.equal(dumpEntry(entries, 'approval')?.config?.policy, 'never')
  assert.equal(dumpEntry(entries, 'session-log-deepseek')?.config?.enabled, false)

  // 文档与许可证（Q3）
  const upstreamPath = path.join(CODE, 'UPSTREAM.md')
  assert.ok(fs.existsSync(upstreamPath), 'code/UPSTREAM.md 不存在')
  const upstream = await fsp.readFile(upstreamPath, 'utf8')
  assert.match(upstream, /fcc0ad4/, 'UPSTREAM.md 未记录 commit fcc0ad4')
  assert.match(upstream, /0\.2\.2-rc\.1/, 'UPSTREAM.md 未记录版本 0.2.2-rc.1')
  assert.match(upstream, /同步|sync/i, 'UPSTREAM.md 未写明同步方法')
  assert.match(upstream, /冲突|conflict/i, 'UPSTREAM.md 未写明冲突处理步骤')

  assert.equal(fs.existsSync(path.join(CODE, '.git')), false, 'code/.git 应不存在（Q3 不保留嵌套仓库）')

  const licensePath = path.join(CODE, 'LICENSE')
  assert.ok(fs.existsSync(licensePath), 'code/LICENSE 不存在')
  const license = await fsp.readFile(licensePath, 'utf8')
  assert.match(license, /MIT License|Permission is hereby granted/i, 'LICENSE 不是 MIT')

  const noticePath = path.join(CODE, 'THIRD_PARTY_NOTICES')
  const readmePath = path.join(CODE, 'README.md')
  const noticeText = [
    fs.existsSync(noticePath) ? await fsp.readFile(noticePath, 'utf8') : '',
    fs.existsSync(readmePath) ? await fsp.readFile(readmePath, 'utf8') : '',
  ].join('\n')
  assert.match(noticeText, /DeepSeek Harness/i, '未注明基于 DeepSeek Harness')
  assert.match(noticeText, /0\.2\.2-rc\.1/, '未注明上游版本 0.2.2-rc.1')
  assert.match(noticeText, /MIT/i, '未注明上游为 MIT')
})

test('TC-02 [P0] dsCli 包装命令可执行、参数透传、退出码一致、DSCLI_PATCH 生效', async (t) => {
  const built = await ensureBuilt()
  assert.equal(built.ok, true, `构建失败：${built.detail}`)
  const ws = await makeWorkspace(t, 'TC-02')

  const stub = await startStub(() => ({ text: 'OK' }))
  t.after(() => stub.close())

  const viaWrapper = await runCli({
    args: ['-p', '只回复 OK'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    mode: 'wrapper',
  })
  assert.equal(viaWrapper.timedOut, false, `包装脚本超时：${viaWrapper.stderr.slice(-2000)}`)
  assert.equal(viaWrapper.code, 0, `包装脚本退出码应为 0，stderr：${viaWrapper.stderr.slice(-2000)}`)
  assert.equal(viaWrapper.stdout, 'OK\n', `包装脚本 stdout 应为 OK\\n，实际：${JSON.stringify(viaWrapper.stdout)}`)
  assert.equal(viaWrapper.stderr, '', `包装脚本 stderr 应为空：${viaWrapper.stderr}`)

  const viaDirect = await runCli({
    args: ['-p', '只回复 OK'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    mode: 'auto',
  })
  assert.equal(viaDirect.code, 0, `直接入口退出码应为 0，stderr：${viaDirect.stderr.slice(-2000)}`)
  assert.equal(viaWrapper.stdout, viaDirect.stdout, '包装脚本与直接入口的 stdout 必须逐字节一致')
  assert.equal(viaWrapper.stderr, viaDirect.stderr, '包装脚本与直接入口的 stderr 必须逐字节一致')
  assert.equal(viaWrapper.code, viaDirect.code, '包装脚本与直接入口的退出码必须一致')

  // DSCLI_PATCH: 覆盖 agent-default-model
  stub.reset()
  const patch = path.join(ws.root, 'patch.yml')
  await fsp.writeFile(patch, [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: patched-model',
    '',
  ].join('\n'))
  const patched = await runCli({
    args: ['-p', 'hi'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub, { DSCLI_PATCH: patch }),
    mode: 'wrapper',
  })
  assert.equal(patched.code, 0, `DSCLI_PATCH 运行退出码应为 0，stderr：${patched.stderr.slice(-2000)}`)
  assert.equal(patched.stdout, 'OK\n')
  const requests = stub.taskRequests()
  assert.equal(requests.length, 1, `模型桩应收到 1 次任务请求，实际 ${requests.length}`)
  assert.equal(requests[0].body.model, 'patched-model', 'DSCLI_PATCH 未覆盖默认模型')
})

test('TC-03 [P0] -p + 位置参数，默认 text 输出最终回复并退出 0', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-03', () => ({ text: '答案是 2' }))
  const run = await runCli({
    args: ['-p', '1+1 等于几'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.timedOut, false, `进程超时：${run.stderr.slice(-2000)}`)
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  assert.equal(run.stdout, '答案是 2\n', `stdout 应精确为「答案是 2\\n」，实际 ${JSON.stringify(run.stdout)}`)
  assert.equal(run.stderr, '', `stderr 应为空字符串，实际 ${JSON.stringify(run.stderr)}`)

  const requests = stub.taskRequests()
  assert.equal(requests.length, 1, `模型桩应收到 1 次请求，实际 ${requests.length}`)
  const texts = humanTexts(requests[0].body)
  assert.equal(texts.at(-1), '1+1 等于几', `最后一条 user 消息应恰为提示词，实际 ${JSON.stringify(texts)}`)
})

test('TC-04 [P0] 无位置参数时从 stdin 读取任务', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-04', () => ({ text: '收到' }))
  const run = await runCli({
    args: ['-p'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    stdin: '这是来自标准输入的任务',
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  assert.equal(run.stdout, '收到\n')
  const requests = stub.taskRequests()
  assert.equal(requests.length, 1)
  const texts = humanTexts(requests[0].body)
  assert.ok(texts.includes('这是来自标准输入的任务'), `user 消息应恰为 stdin 内容，实际 ${JSON.stringify(texts)}`)
})

test('TC-05 [P0] stream-json 事件序列与必需字段正确', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-05', () => ({ text: '你好' }))
  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '打个招呼'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  assert.equal(run.stderr, '', `stderr 应为空：${run.stderr}`)

  const events = jsonLines(run.stdout)
  assert.equal(events.length, 3, `stdout 应恰好 3 行，实际 ${events.length}：${run.stdout.slice(0, 1000)}`)
  assert.deepEqual(events.map(event => event.type), ['system', 'assistant', 'result'])
  for (const event of events) {
    assert.ok(['system', 'assistant', 'user', 'result'].includes(event.type), `非法事件类型 ${event.type}`)
  }
  assert.equal(events.some(event => ['hook_started', 'hook_response', 'rate_limit_event'].includes(event.type)), false)

  const init = events[0]
  assert.equal(init.subtype, 'init')
  assert.match(init.session_id, UUID_RE, `session_id 不是 UUID：${init.session_id}`)
  assert.equal(path.resolve(init.cwd), path.resolve(ws.cwd), 'init.cwd 应为当前工作目录绝对路径')
  assert.ok(typeof init.model === 'string' && init.model.length > 0, 'init.model 应为非空字符串')
  assert.ok(Array.isArray(init.tools), 'init.tools 应为数组')
  assert.deepEqual(init.mcp_servers, [], 'init.mcp_servers 应为 []')
  assert.equal(typeof init.permissionMode, 'string')
  assert.equal(init.claude_code_version, '2.1.319')
  assert.equal(init.apiKeySource, 'none')
  assert.equal(init.output_style, 'default')
  assert.deepEqual(init.agents, [])
  assert.deepEqual(init.skills, [])
  assert.deepEqual(init.plugins, [])
  assert.equal(typeof init.uuid, 'string')
  assert.equal(typeof init.timestamp, 'string')

  const assistant = events[1]
  assert.equal(assistant.message.role, 'assistant')
  assert.equal(assistant.message.content[0].type, 'text')
  assert.equal(assistant.message.content[0].text, '你好')
  assert.equal(typeof assistant.message.usage.input_tokens, 'number')
  assert.equal(typeof assistant.message.usage.output_tokens, 'number')

  const result = events[2]
  assert.equal(result.type, 'result')
  assert.equal(result.subtype, 'success')
  assert.equal(result.is_error, false)
  assert.equal(result.result, '你好')
})

test('TC-06 [P0] 文本与 tool_use 合并在同一条 assistant 消息，输出映射为 Claude 名', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-06', ({ n }) => {
    if (n === 1) {
      return {
        text: '我先读一下',
        calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } }],
      }
    }
    return { text: '内容是 ABC' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '读 a.txt', '--tools', 'Read'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)

  const assistants = eventsOfType(events, 'assistant')
  assert.ok(assistants.length >= 2, `应有至少 2 条 assistant 事件，实际 ${assistants.length}`)
  const first = assistants[0]
  const blocks = contentBlocks(first.message)
  assert.ok(blocks.length >= 2, `第一条 assistant 的 content 应至少 2 块，实际 ${blocks.length}`)
  assert.ok(blocks.some(block => block.type === 'text' && block.text === '我先读一下'), '缺少文本块「我先读一下」')
  const toolBlock = blocks.find(block => block.type === 'tool_use')
  assert.ok(toolBlock, '第一条 assistant 消息缺少 tool_use 块（不得拆成两条 assistant）')
  assert.equal(toolBlock.name, 'Read', `工具名应映射为 Read，实际 ${toolBlock.name}`)
  assert.equal(typeof toolBlock.input, 'object')
  assert.ok(toolBlock.input !== null)
  assert.ok('file_path' in toolBlock.input, 'tool_use.input 应包含 file_path')
  assert.equal(typeof toolBlock.id, 'string')
  assert.ok(toolBlock.id.length > 0)

  const results = toolResults(events)
  assert.equal(results.length, 1, `应恰有 1 条 tool_result，实际 ${results.length}`)
  assert.equal(results[0].tool_use_id, toolBlock.id, 'tool_result.tool_use_id 应等于 tool_use.id')
  assert.equal(lastTextOfAssistant(assistants.at(-1)), '内容是 ABC')
})

test('TC-07 [P0] tool/result 映射为 user.tool_result，ID 与错误标志正确', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-07', ({ n }) => {
    if (n === 1) {
      return { calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } }] }
    }
    if (n === 2) {
      return { calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'nope.txt') } }] }
    }
    return { text: '完成' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '读两个文件', '--tools', 'Read'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)

  const assistants = eventsOfType(events, 'assistant')
  assert.ok(assistants.length >= 3, `应有至少 3 条 assistant 事件，实际 ${assistants.length}`)
  const uses = toolUses(events)
  assert.equal(uses.length, 2, `应恰有 2 个 tool_use，实际 ${uses.length}`)

  const users = eventsOfType(events, 'user')
  assert.equal(users.length, 2, `每个工具调用应恰对应 1 条 user 事件，实际 ${users.length}`)
  for (const user of users) {
    assert.equal(user.message.content[0].type, 'tool_result')
  }
  const results = toolResults(events)
  assert.equal(results.length, 2)
  assert.equal(results[0].tool_use_id, uses[0].id)
  assert.equal(results[1].tool_use_id, uses[1].id)

  assert.equal(typeof results[0].content, 'string')
  assert.equal(results[0].is_error, false, '读取存在的文件应成功')
  assert.ok(results[0].content.includes('ABC'), `成功结果应包含 ABC，实际：${results[0].content.slice(0, 500)}`)
  assert.equal(results[1].is_error, true, '读取不存在的文件应标记 is_error')
  assert.ok(results[1].content.length > 0, '失败结果的 content 不应为空')

  // 0.01 不回显普通用户消息
  for (const user of users) {
    for (const block of contentBlocks(user.message)) {
      assert.equal(block.type, 'tool_result', `user 事件不应包含普通文本块：${JSON.stringify(block)}`)
    }
  }
})

test('TC-08 [P0] result 事件字段与取值符合约定', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-08', ({ n }) => {
    if (n === 1) {
      return {
        text: '我先读一下',
        calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } }],
      }
    }
    return { text: '内容是 ABC' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '读 a.txt', '--tools', 'Read'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const init = eventsOfType(events, 'system')[0]
  const result = eventsOfType(events, 'result').at(-1)
  assert.ok(result, '缺少 result 事件')

  const assistants = eventsOfType(events, 'assistant')
  const lastText = [...assistants].reverse().map(lastTextOfAssistant).find(text => text.length > 0)

  assert.equal(result.type, 'result')
  assert.equal(result.subtype, 'success')
  assert.equal(result.is_error, false)
  assert.equal(result.result, '内容是 ABC')
  assert.equal(result.result, lastText, 'result.result 应等于最后一条非空 assistant 文本')
  assert.equal(result.session_id, init.session_id)
  assert.match(result.session_id, UUID_RE)
  assert.equal(result.num_turns, assistants.length, `num_turns 应为 assistant 消息数 ${assistants.length}，实际 ${result.num_turns}`)
  assert.equal(result.num_turns, 2)
  assert.ok(Number.isInteger(result.duration_ms) && result.duration_ms >= 0, `duration_ms 非整数：${result.duration_ms}`)
  assert.equal(typeof result.duration_api_ms, 'number')
  assert.equal(result.total_cost_usd, 0)
  assert.equal(typeof result.usage.input_tokens, 'number')
  assert.ok(result.usage.input_tokens >= 0)
  assert.equal(typeof result.usage.output_tokens, 'number')
  assert.ok(result.usage.output_tokens >= 0)
  assert.deepEqual(result.permission_denials, [])
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens']) {
    assert.equal(typeof result.usage[key], 'number', `usage.${key} 应为数字`)
  }
})

test('TC-09 [P0] -r 续接不存在的会话，文案逐字一致并退出 1', async (t) => {
  const id = '00000000-0000-4000-8000-000000000000'
  const { ws, stub } = await wsWithStub(t, 'TC-09', () => ({ text: '不应被调用' }))
  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '继续', '-r', id],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 1, `退出码应为 1，实际 ${run.code}；stderr：${run.stderr}`)
  assert.ok(run.stderr.includes(`No conversation found with session ID: ${id}`), `stderr 未逐字包含目标文案：${run.stderr}`)

  const events = jsonLines(run.stdout)
  assert.equal(events.length, 1, `stdout 应恰好 1 行，实际 ${events.length}：${run.stdout.slice(0, 1000)}`)
  const result = events[0]
  assert.equal(result.type, 'result')
  assert.equal(result.subtype, 'error_during_execution')
  assert.equal(result.is_error, true)
  assert.equal(result.num_turns, 0)
  assert.equal(result.session_id, id)

  assert.equal(stub.taskRequests().length, 0, '模型桩不应收到请求')
  assert.deepEqual(await listDirs(path.join(ws.dshHome, 'sessions')), [], '不应新建会话目录')
})

test('TC-10 [P0] 无位置参数且 stdin 为空时报错并退出 1', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-10', () => ({ text: '不应被调用' }))
  const run = await runCli({ args: ['-p'], cwd: ws.cwd, env: stubEnv(ws, stub), stdin: '' })
  assert.equal(run.code, 1, `退出码应为 1，实际 ${run.code}`)
  assert.ok(
    run.stderr.includes('Error: Input must be provided either through stdin or as a prompt argument when using --print'),
    `stderr 缺少逐字文案：${run.stderr}`,
  )
  assert.equal(run.stdout, '', `stdout 应为空，实际 ${JSON.stringify(run.stdout)}`)
  assert.equal(stub.taskRequests().length, 0)
  assert.deepEqual(await listDirs(path.join(ws.dshHome, 'sessions')), [])
})

test('TC-11 [P0] 缺少 -p 时报错并退出 1，不启动 agent', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-11', () => ({ text: '不应被调用' }))
  const run = await runCli({ args: ['只回复 OK'], cwd: ws.cwd, env: stubEnv(ws, stub) })
  assert.equal(run.code, 1, `退出码应为 1，实际 ${run.code}`)
  assert.ok(run.stderr.includes('交互模式暂不支持，请使用 -p'), `stderr 缺少中文提示：${run.stderr}`)
  assert.equal(run.stdout, '')
  assert.equal(stub.taskRequests().length, 0)
  assert.deepEqual(await listDirs(path.join(ws.dshHome, 'sessions')), [])
})

test('TC-12 [P0] --tools 白名单生效，输出使用 Claude 工具名', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-12', ({ n }) => {
    if (n === 1) {
      return {
        calls: [
          { name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } },
          {
            name: COMMAND_TOOL_DSH,
            input: { command: IS_WINDOWS ? 'Write-Output hi' : 'echo hi', description: 'echo' },
          },
        ],
      }
    }
    return { text: '读完了' }
  })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '读 a.txt', '--tools', 'Read,Glob,Grep'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const init = eventsOfType(events, 'system')[0]

  assert.deepEqual(new Set(init.tools), new Set(['Read', 'Glob', 'Grep']), `init.tools 应为 Read/Glob/Grep，实际 ${JSON.stringify(init.tools)}`)
  for (const tool of init.tools) {
    assert.ok(['Read', 'Glob', 'Grep'].includes(tool), `init.tools 含非 Claude 名或多余项：${tool}`)
  }

  const firstRequest = stub.taskRequests()[0]
  const requested = firstRequest.body.tools.map(tool => tool.name).sort()
  assert.deepEqual(requested, ['glob', 'grep', 'read'], `模型侧工具定义应为 DSH 原生名，实际 ${JSON.stringify(requested)}`)

  const uses = toolUses(events)
  const readUse = uses.find(use => use.name === 'Read')
  assert.ok(readUse, `输出应含 tool_use.name == Read，实际 ${JSON.stringify(uses.map(u => u.name))}`)
  const results = toolResults(events)
  assert.ok(results.some(result => result.tool_use_id === readUse.id), 'tool_result.tool_use_id 应等于 read 的 tool_use.id')

  // 白名单外的命令工具不得成功执行
  const commandUse = uses.find(use => use.name === COMMAND_TOOL_CLAUDE)
  if (commandUse) {
    const commandResult = results.find(result => result.tool_use_id === commandUse.id)
    assert.ok(commandResult, '白名单外工具调用应有对应结果')
    assert.equal(commandResult.is_error, true, '白名单外工具不得成功执行')
  }
})

test('TC-13 [P0] --session-id 用指定 UUID 新建会话并落盘', async (t) => {
  const id = '11111111-1111-4111-8111-111111111111'
  const { ws, stub } = await wsWithStub(t, 'TC-13', () => ({ text: '你好' }))
  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', id, '你好'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const init = eventsOfType(events, 'system')[0]
  const result = eventsOfType(events, 'result').at(-1)
  assert.equal(init.session_id, id)
  assert.equal(result.session_id, id)

  const files = await findSessionFiles(ws.dshHome, id)
  assert.equal(files.length, 1, `应存在 1 个会话文件，实际 ${files.length}`)
  assert.match(path.basename(files[0]), /^session\.v4\.jsonl(\.zstd)?$/)
  const text = await readSessionText(files[0])
  assert.ok(text.includes('你好'), '会话文件应包含本轮 user 消息「你好」')
  assert.ok(!id.startsWith('session-'), '会话 ID 不应带 session- 前缀')

  // 默认数据根目录 ~/.dsh
  stub.reset()
  const secondId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const second = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', secondId, '你好'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub, {
      DSH_HOME: undefined,
      USERPROFILE: ws.home,
      HOME: ws.home,
    }),
  })
  assert.equal(second.code, 0, `默认数据目录运行退出码应为 0，stderr：${second.stderr.slice(-2000)}`)
  const defaultRoot = path.join(ws.home, '.dsh')
  const defaultFiles = await findSessionFiles(defaultRoot, secondId)
  assert.equal(defaultFiles.length, 1, `会话应落在 <USERPROFILE>\\.dsh\\sessions 下，实际 ${defaultFiles.length} 个文件`)
})

test('TC-14 [P0] -r 续接成功，保留上一轮上下文', async (t) => {
  const id = '22222222-2222-4222-8222-222222222222'
  const { ws, stub } = await wsWithStub(t, 'TC-14', ({ body }) => ({ text: JSON.stringify(body?.messages ?? []).includes('上一轮的数字') ? '42' : '记住了' }))

  const first = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', id, '请记住数字 42'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(first.code, 0, `第一轮退出码应为 0，stderr：${first.stderr.slice(-2000)}`)
  const files = await findSessionFiles(ws.dshHome, id)
  assert.equal(files.length, 1)
  const linesBefore = await sessionLineCount(files[0])

  stub.reset()
  const second = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '-r', id, '上一轮的数字是多少'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(second.code, 0, `续接退出码应为 0，stderr：${second.stderr.slice(-2000)}`)
  const events = jsonLines(second.stdout)
  const init = eventsOfType(events, 'system')[0]
  const result = eventsOfType(events, 'result').at(-1)
  assert.equal(init.session_id, id)
  assert.equal(result.result, '42', 'result.result 应为这一轮的新回复')

  const requests = stub.taskRequests()
  assert.ok(requests.length >= 1)
  const texts = requests.flatMap(request => humanTexts(request.body))
  assert.ok(texts.includes('请记住数字 42'), `续接请求应包含上一轮 user 消息，实际 ${JSON.stringify(texts)}`)
  assert.ok(texts.includes('上一轮的数字是多少'), '续接请求应包含本轮 user 消息')

  const linesAfter = await sessionLineCount(files[0])
  assert.ok(linesAfter > linesBefore, `会话文件应追加写入：之前 ${linesBefore} 行，之后 ${linesAfter} 行`)
})

test('TC-15 [P0] 默认权限下未授权工具被拒绝并记入 permission_denials', async (t) => {
  const { ws, stub } = await wsWithStub(t, 'TC-15', ({ n }) => {
    if (n === 1) {
      return {
        calls: [{
          name: COMMAND_TOOL_DSH,
          input: { command: 'echo hi > marker.txt', description: 'write marker' },
        }],
      }
    }
    return { text: '完成' }
  })
  const markerFile = path.join(ws.cwd, 'marker.txt')

  const run = await runCli({
    args: ['-p', '--output-format', 'stream-json', '--verbose', '执行命令'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
  })
  assert.equal(run.code, 0, `权限拒绝不应导致整轮失败，退出码：${run.code}，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)
  const result = eventsOfType(events, 'result').at(-1)
  const uses = toolUses(events)
  assert.equal(uses.length, 1)
  const results = toolResults(events)
  assert.equal(results.length, 1)
  assert.equal(results[0].is_error, true, '被拒绝的工具调用应标记 is_error')
  assert.ok(results[0].content.length > 0, '拒绝结果的 content 不应为空')

  assert.equal(result.subtype, 'success')
  assert.equal(result.is_error, false)
  assert.ok(result.permission_denials.length >= 1, 'permission_denials 长度应 ≥ 1')
  const denial = result.permission_denials.find(item => item.tool_name === COMMAND_TOOL_CLAUDE)
  assert.ok(denial, `permission_denials 应含 ${COMMAND_TOOL_CLAUDE}，实际 ${JSON.stringify(result.permission_denials)}`)
  assert.equal(denial.tool_use_id, uses[0].id)
  assert.equal(typeof denial.tool_input, 'object')
  assert.ok(denial.tool_input !== null)
  assert.equal(fs.existsSync(markerFile), false, '被拒绝的命令不应创建 marker.txt')
})

test('TC-16 [P0] xCode 契约场景：完整参数 + stdin + stream-json 全流程', async (t) => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const { ws, stub } = await wsWithStub(t, 'TC-16', ({ n }) => {
    if (n === 1) {
      return { calls: [{ name: 'read', input: { file_path: path.join(ws.cwd, 'a.txt') } }] }
    }
    return { text: '文件内容已读取' }
  }, { withAddDir: true })
  await writeFile(path.join(ws.cwd, 'a.txt'), 'ABC')

  const baseArgs = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Glob,Grep',
    '--allowedTools', 'Read,Glob,Grep',
    '--strict-mcp-config',
    '--add-dir', ws.addDir,
  ]
  const first = await runCli({
    args: [...baseArgs, '--session-id', id],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    stdin: '读一下 a.txt 并告诉我',
  })
  assert.equal(first.code, 0, `第一次退出码应为 0，stderr：${first.stderr.slice(-2000)}`)
  const firstEvents = jsonLines(first.stdout)
  const firstInit = eventsOfType(firstEvents, 'system')[0]
  const firstResult = eventsOfType(firstEvents, 'result').at(-1)
  assert.equal(firstInit.session_id, id)
  assert.ok(
    eventsOfType(firstEvents, 'assistant').some(event => lastTextOfAssistant(event).includes('文件内容已读取')),
    '应有 assistant 文本块包含「文件内容已读取」',
  )
  assert.equal(firstResult.subtype, 'success')
  assert.ok(firstResult.result.length > 0)
  assert.equal(firstResult.session_id, id)
  assert.ok(firstResult.num_turns >= 1)
  assert.deepEqual(new Set(firstInit.tools), new Set(['Read', 'Glob', 'Grep']))
  assert.equal(firstInit.tools.some(tool => tool.startsWith('mcp__')), false)
  assert.equal(first.stderr.includes('No conversation found'), false)

  stub.reset()
  const second = await runCli({
    args: [...baseArgs, '-r', id],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    stdin: '读一下 a.txt 并告诉我',
  })
  assert.equal(second.code, 0, `第二次退出码应为 0，stderr：${second.stderr.slice(-2000)}`)
  const secondEvents = jsonLines(second.stdout)
  const secondInit = eventsOfType(secondEvents, 'system')[0]
  assert.equal(secondInit.session_id, id)
  assert.equal(secondInit.tools.some(tool => tool.startsWith('mcp__')), false)
  assert.equal(second.stderr.includes('No conversation found'), false)

  const texts = stub.taskRequests().flatMap(request => humanTexts(request.body))
  assert.ok(texts.includes('读一下 a.txt 并告诉我'), '续接请求应包含第 1 次的 user 消息')
})
