// 需求 #27：帮助信息增加文档提示。
// 黑盒验收：只通过 code\bin\dsCli.cmd 驱动，断言 stdout / stderr / 退出码 / 会话目录 / 模型桩请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT,
  makeWorkspace,
  startStub,
  stubEnv,
  runCli,
  listSessionIds,
  countOf,
  hasNoReplacementChars,
  parseDumpYaml,
} from '../../lib/harness.mjs'

const HINT = '文档：docs/使用教程.html'

async function setup(t, tc, responder = () => ({ text: '不应被调用' })) {
  const ws = await makeWorkspace(t, tc)
  const stub = await startStub(responder)
  t.after(() => stub.close())
  return { ws, stub }
}

/** 统一 CRLF；「最后一行」= 去掉末尾换行后按行切分的最后一项。 */
function normalize(text) {
  return text.replace(/\r\n/g, '\n')
}

function lastLine(text) {
  return normalize(text).replace(/\n+$/, '').split('\n').at(-1)
}

/** 帮助正文断言：与改动前基线一致的关键行仍在（不比对全文快照，避免终端宽度差异）。 */
function assertHelpBodyIntact(stdout, label) {
  const lines = normalize(stdout).split('\n')
  assert.equal(lines[0], 'Usage: dsCli [options] [prompt...]', `${label} 首行应为 Usage`)
  assert.ok(lines.includes(''), `${label} 帮助正文应有空行分隔`)
  assert.ok(
    lines.includes('Claude Code compatible non-interactive runner over the DeepSeek Harness core.'),
    `${label} 缺少 Description 行`,
  )
  for (const line of [
    'Arguments:',
    'Options:',
    'Examples:',
    '  dsCli -p "run the tests"',
    '  echo "run the tests" | dsCli -p',
    '  dsCli -p --output-format stream-json --verbose "read a.txt"',
    '  dsCli -p --resume <session-id> "continue"',
  ]) {
    assert.ok(lines.includes(line), `${label} 缺少帮助行：${JSON.stringify(line)}；实际末尾：${JSON.stringify(lines.slice(-8))}`)
  }
  for (const flag of [
    '-v, --version',
    '-h, --help',
    '-p, --print',
    '--output-format <format>',
    '--verbose',
    '--session-id <uuid>',
    '-r, --resume <id>',
    '-c, --continue',
    '--permission-mode <mode>',
    '--dangerously-skip-permissions',
    '--tools <tools...>',
    '--allowedTools <tools...>',
    '--disallowedTools <tools...>',
    '--add-dir <path>',
    '--model <model>',
    '--effort <level>',
    '--system-prompt <text>',
    '--append-system-prompt <text>',
    '--strict-mcp-config',
  ]) {
    assert.ok(stdout.includes(flag), `${label} 输出缺少选项文本 ${flag}`)
  }
  for (const section of ['Usage:', 'Arguments:', 'Options:', 'Examples:']) {
    assert.equal(countOf(stdout, section), 1, `${label} 中 ${section} 应恰好出现 1 次`)
  }
  for (const absent of ['--bg', '--chrome', '--attach']) {
    assert.equal(stdout.includes(absent), false, `${label} 不应列出 ${absent}`)
  }
  assert.equal(/^\s*mcp\b/m.test(stdout), false, `${label} 不应列出 mcp 子命令`)
  assert.equal(countOf(stdout, HINT), 1, `${label} 中文档提示应恰好出现 1 次`)
  assert.equal(lastLine(stdout), HINT, `${label} 最后一行应为文档提示`)
}

test('TC-01 [P0] dsCli -h 帮助最后一行是文档提示，退出码 0，且只出现一次', async (t) => {
  const { ws, stub } = await setup(t, 'TC-01')
  const run = await runCli({ args: ['-h'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(run.timedOut, false, `进程超时：${run.stderr.slice(-1000)}`)
  assert.equal(run.code, 0, `-h 退出码应为 0，实际 ${run.code}；stderr：${run.stderr}`)
  assert.equal(run.stderr, '', `-h 不应写 stderr，实际：${JSON.stringify(run.stderr)}`)
  assert.ok(run.stdout.length > 0, '-h stdout 不应为空')
  assert.ok(normalize(run.stdout).startsWith('Usage: dsCli'), `stdout 首行应以 Usage: dsCli 开头：${JSON.stringify(normalize(run.stdout).slice(0, 80))}`)
  assert.equal(lastLine(run.stdout), HINT, `最后一行应为文档提示；实际末尾：${JSON.stringify(normalize(run.stdout).slice(-120))}`)
  assert.equal(countOf(run.stdout, HINT), 1, '文档提示应恰好出现 1 次')
  assert.equal(hasNoReplacementChars(run.stdout), true, 'stdout 不应含 U+FFFD 替换字符')
  assert.equal(stub.taskRequests().length, 0, '帮助不应请求模型')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '帮助不应创建会话')
})

test('TC-02 [P0] dsCli --help 与 dsCli -h 输出逐字一致，最后一行同为文档提示', async (t) => {
  const { ws, stub } = await setup(t, 'TC-02')
  const short = await runCli({ args: ['-h'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })
  const long = await runCli({ args: ['--help'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(short.code, 0, `-h 退出码应为 0，实际 ${short.code}`)
  assert.equal(long.code, 0, `--help 退出码应为 0，实际 ${long.code}`)
  assert.equal(short.stderr, '', `-h stderr 应为空：${JSON.stringify(short.stderr)}`)
  assert.equal(long.stderr, '', `--help stderr 应为空：${JSON.stringify(long.stderr)}`)
  assert.equal(long.stdout, short.stdout, '--help 与 -h 的 stdout 应逐字相同')
  for (const [label, out] of [['-h', short.stdout], ['--help', long.stdout]]) {
    assert.equal(lastLine(out), HINT, `${label} 最后一行应为文档提示`)
    assert.equal(countOf(out, HINT), 1, `${label} 中文档提示应恰好出现 1 次`)
  }
  assert.equal(stub.taskRequests().length, 0, '帮助不应请求模型')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '帮助不应创建会话')
})

test('TC-03 [P1] 帮助原有内容完好：Usage、Arguments、Options、Examples 关键行均保留', async (t) => {
  const { ws, stub } = await setup(t, 'TC-03')
  const run = await runCli({ args: ['-h'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(run.code, 0, `退出码应为 0，实际 ${run.code}；stderr：${run.stderr}`)
  assert.equal(run.stderr, '', `stderr 应为空：${JSON.stringify(run.stderr)}`)
  assertHelpBodyIntact(run.stdout, '-h')
})

test('TC-04 [P1] 文档提示与上方示例之间恰好一个空行，输出以提示行 + 单个换行结束', async (t) => {
  const { ws, stub } = await setup(t, 'TC-04')
  const run = await runCli({ args: ['-h'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(run.code, 0, `退出码应为 0，实际 ${run.code}；stderr：${run.stderr}`)
  assert.equal(run.stderr, '', `stderr 应为空：${JSON.stringify(run.stderr)}`)

  const text = normalize(run.stdout)
  const lines = text.split('\n')
  assert.equal(lines.at(-1), '', `输出应以一个换行结束；实际末尾：${JSON.stringify(text.slice(-60))}`)
  assert.equal(lines.at(-2), HINT, '提示应是真正的最后一行（其后只有一个换行）')
  assert.equal(lines.at(-3), '', '提示上方应恰好一个空行')
  assert.equal(
    lines.at(-4),
    '  dsCli -p --resume <session-id> "continue"',
    '空行应紧接最后一条既有示例',
  )
  assert.equal(text.endsWith(`${HINT}\n\n`), false, '提示后不应有多余空行')
  assert.equal(text.endsWith(`${HINT}\n`), true, '输出应以提示行 + 单个换行结束')
})

test('TC-05 [P1] -v / --version 版本输出逐字节不变，且不含文档提示', async (t) => {
  const { ws, stub } = await setup(t, 'TC-05')
  const expected = '2.1.319 (Claude Code compatible; dsCli 0.1.0)\n'
  const shortVersion = await runCli({ args: ['-v'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })
  const longVersion = await runCli({ args: ['--version'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(shortVersion.code, 0, `-v 退出码应为 0，实际 ${shortVersion.code}`)
  assert.equal(longVersion.code, 0, `--version 退出码应为 0，实际 ${longVersion.code}`)
  assert.equal(shortVersion.stdout, expected, `-v 输出应逐字节不变；实际：${JSON.stringify(shortVersion.stdout)}`)
  assert.equal(longVersion.stdout, expected, `--version 输出应逐字节不变；实际：${JSON.stringify(longVersion.stdout)}`)
  assert.equal(shortVersion.stderr, '', `-v stderr 应为空：${JSON.stringify(shortVersion.stderr)}`)
  assert.equal(longVersion.stderr, '', `--version stderr 应为空：${JSON.stringify(longVersion.stderr)}`)
  assert.equal(countOf(shortVersion.stdout, HINT), 0, '-v 不应包含文档提示')
  assert.equal(countOf(longVersion.stdout, HINT), 0, '--version 不应包含文档提示')
  assert.equal(stub.taskRequests().length, 0, '版本输出不应请求模型')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '版本输出不应创建会话')
})

test('TC-06 [P1] -p 正常问答输出与退出码不变，且不含文档提示', async (t) => {
  const { ws, stub } = await setup(t, 'TC-06', () => ({ text: 'OK' }))
  const run = await runCli({ args: ['-p', 'hello'], cwd: ws.cwd, env: stubEnv(ws, stub) })

  assert.equal(run.timedOut, false, `进程超时：${run.stderr.slice(-1000)}`)
  assert.equal(run.code, 0, `-p 退出码应为 0，实际 ${run.code}；stderr：${run.stderr}`)
  assert.equal(run.stdout, 'OK\n', `-p 文本输出应为模型回答；实际：${JSON.stringify(run.stdout)}`)
  assert.equal(run.stderr, '', `-p stderr 应为空：${JSON.stringify(run.stderr)}`)
  assert.equal(countOf(run.stdout, HINT), 0, '-p 输出不应包含文档提示')
  assert.equal(stub.taskRequests().length, 1, '-p 应恰好发出 1 次任务请求')
})

test('TC-07 [P1] docs/使用教程.html 不存在时仍原样打印提示，退出码 0，无文件错误', async (t) => {
  const { ws, stub } = await setup(t, 'TC-07')
  const tutorial = path.join(ws.cwd, 'docs', '使用教程.html')
  assert.equal(fs.existsSync(tutorial), false, `前置条件不成立：临时目录不应存在 ${tutorial}`)

  const run = await runCli({ args: ['-h'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(run.code, 0, `教程文件缺失时退出码仍应为 0，实际 ${run.code}`)
  assert.equal(run.stderr, '', `stderr 应严格为空：${JSON.stringify(run.stderr)}`)
  assert.equal(lastLine(run.stdout), HINT, `最后一行应为文档提示；实际末尾：${JSON.stringify(normalize(run.stdout).slice(-120))}`)
  assert.equal(countOf(run.stdout, HINT), 1, '文档提示应恰好出现 1 次')
  const combined = `${run.stdout}\n${run.stderr}`.toLowerCase()
  for (const forbidden of ['enoent', 'no such file', '未找到教程', '不存在']) {
    assert.equal(combined.includes(forbidden), false, `不应出现文件校验错误文本：${forbidden}`)
  }
  assert.equal(stub.taskRequests().length, 0, '帮助不应请求模型')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '帮助不应创建会话')
})

test('TC-08 [P1] -p -h 组合仍只打印帮助，提示为最后一行，不调用模型', async (t) => {
  const { ws, stub } = await setup(t, 'TC-08')
  const run = await runCli({ args: ['-p', '-h'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(run.code, 0, `-p -h 退出码应为 0，实际 ${run.code}；stderr：${run.stderr}`)
  assert.equal(run.stderr, '', `-p -h stderr 应为空：${JSON.stringify(run.stderr)}`)
  assert.ok(run.stdout.includes('Usage: dsCli'), `应打印帮助；实际：${JSON.stringify(run.stdout.slice(0, 120))}`)
  assert.equal(countOf(run.stdout, HINT), 1, '文档提示应恰好出现 1 次')
  assert.equal(lastLine(run.stdout), HINT, `最后一行应为文档提示；实际末尾：${JSON.stringify(normalize(run.stdout).slice(-120))}`)
  assert.equal(stub.taskRequests().length, 0, '-h 应优先于 -p，不应请求模型')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '-h 应优先于 -p，不应创建会话')
})

test('TC-09 [P2] --dump-config 输出不包含文档提示，配置导出仍正常', async (t) => {
  const { ws, stub } = await setup(t, 'TC-09')
  const run = await runCli({ args: ['--dump-config'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(run.code, 0, `--dump-config 退出码应为 0，实际 ${run.code}；stderr：${run.stderr}`)
  assert.equal(run.stderr, '', `--dump-config stderr 应为空：${JSON.stringify(run.stderr)}`)
  const entries = parseDumpYaml(run.stdout)
  assert.ok(Array.isArray(entries) && entries.length > 0, '--dump-config 应输出非空 YAML 列表')
  assert.equal(countOf(run.stdout, HINT), 0, '--dump-config 不应包含文档提示')
  assert.equal(stub.taskRequests().length, 0, '--dump-config 不应请求模型')
})

test('TC-10 [P1] 不同工作目录下提示始终是固定相对路径，不出现绝对路径', async (t) => {
  const { ws, stub } = await setup(t, 'TC-10')
  const env = stubEnv(ws, stub)
  const atRoot = await runCli({ args: ['-h'], cwd: ROOT, env, mode: 'wrapper' })
  const atTemp = await runCli({ args: ['-h'], cwd: ws.cwd, env, mode: 'wrapper' })

  for (const [label, run] of [['仓库根目录', atRoot], ['临时工作目录', atTemp]]) {
    assert.equal(run.code, 0, `${label} 退出码应为 0，实际 ${run.code}；stderr：${run.stderr}`)
    assert.equal(run.stderr, '', `${label} stderr 应为空：${JSON.stringify(run.stderr)}`)
    assert.equal(countOf(run.stdout, HINT), 1, `${label} 中文档提示应恰好出现 1 次`)
  }

  const rootLine = lastLine(atRoot.stdout)
  const tempLine = lastLine(atTemp.stdout)
  assert.equal(rootLine, HINT, `仓库根目录下最后一行应为文档提示，实际：${JSON.stringify(rootLine)}`)
  assert.equal(tempLine, HINT, `临时目录下最后一行应为文档提示，实际：${JSON.stringify(tempLine)}`)
  assert.equal(tempLine, rootLine, '两种工作目录下的提示行应完全相同')

  for (const location of [ROOT, ws.root, ws.cwd]) {
    assert.equal(tempLine.includes(location), false, `提示行不应包含绝对路径：${location}`)
  }
  assert.equal(/[A-Za-z]:[\\/]/.test(tempLine), false, `提示行不应包含盘符路径：${tempLine}`)
  assert.equal(tempLine.includes('file://'), false, `提示行不应包含 file://：${tempLine}`)
  assert.equal(tempLine.includes('\\'), false, `提示行不应包含反斜杠：${tempLine}`)
})

test('TC-11 [P2] 未知参数与 -h 同用时，警告在 stderr，stdout 最后一行仍为提示且退出 0', async (t) => {
  const { ws, stub } = await setup(t, 'TC-11')
  const run = await runCli({ args: ['--no-such-flag', '-h'], cwd: ws.cwd, env: stubEnv(ws, stub), mode: 'wrapper' })

  assert.equal(run.code, 0, `未知参数 + -h 退出码应为 0，实际 ${run.code}`)
  assert.equal(run.stderr, 'dsCli: --no-such-flag is not supported, ignored\n', `stderr 应只有一条警告；实际：${JSON.stringify(run.stderr)}`)
  assert.ok(run.stdout.includes('Usage: dsCli'), 'stdout 应仍打印帮助')
  assert.equal(lastLine(run.stdout), HINT, `最后一行应为文档提示；实际末尾：${JSON.stringify(normalize(run.stdout).slice(-120))}`)
  assert.equal(countOf(run.stdout, HINT), 1, '文档提示应恰好出现 1 次')
  assert.equal(stub.taskRequests().length, 0, '帮助不应请求模型')
  assert.deepEqual(await listSessionIds(ws.dshHome), [], '帮助不应创建会话')
})
