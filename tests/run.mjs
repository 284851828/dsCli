// dsCli 统一测试入口，规则见 docs/测试规范.md。
//
//   node tests/run.mjs                      全量：protocol + unit + acceptance（平台的项目测试命令）
//   node tests/run.mjs acceptance           只跑验收测试
//   node tests/run.mjs acceptance --only req_15     只跑路径含 req_15 的验收测试文件（某个需求的新功能测试）
//   node tests/run.mjs acceptance --grep "TC-0[1-5]"  按用例名正则筛选
//   node tests/run.mjs unit | e2e | protocol
//
// 退出码：0 全部通过；1 有失败、跳过或出错；2 用法错误。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = path.join(ROOT, 'tests')
const CODE = path.join(ROOT, 'code')
// Windows 上 --test-reporter 的绝对路径必须写成 file:// URL
const REPORTER = pathToFileURL(path.join(TESTS, 'lib', 'reporter.mjs')).href
const SUITES = ['protocol', 'unit', 'acceptance', 'e2e']
const DEFAULT_SUITES = ['protocol', 'unit', 'acceptance']
// dsCli 自己的单元测试（vitest 路径过滤）。上游 DSH 的测试不在这里跑，见 docs/测试规范.md 2.2
const UNIT_FILTERS = ['packages/claude-compat/', 'packages/bundle/dscli/', 'dscli.spec.ts']

function usage(message) {
  process.stderr.write(`${message}\n用法：node tests/run.mjs [${SUITES.join('|')}]... [--only <路径片段>] [--grep <用例名正则>]\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const suites = []
  const options = { only: [], grep: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only' || arg === '--grep') {
      const value = argv[++i]
      if (value === undefined || value === '') usage(`${arg} 需要一个值`)
      if (arg === '--only') options.only.push(value.replace(/\\/g, '/'))
      else options.grep = value
    } else if (SUITES.includes(arg)) {
      suites.push(arg)
    } else {
      usage(`未知参数：${arg}`)
    }
  }
  return { suites: suites.length > 0 ? suites : DEFAULT_SUITES, ...options }
}

function heading(text) {
  process.stdout.write(`\n========== ${text} ==========\n`)
}

/** tests/<dir> 下全部 *.test.mjs（递归），按路径排序；--only 按相对路径片段过滤。 */
function testFiles(dir, only) {
  const base = path.join(TESTS, dir)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base, { recursive: true })
    .map(name => String(name).replace(/\\/g, '/'))
    .filter(name => name.endsWith('.test.mjs'))
    .filter(name => only.length === 0 || only.some(part => `${dir}/${name}`.includes(part)))
    .sort()
    .map(name => path.join(base, name))
}

/** 用协议 reporter 跑一组 node:test 文件，返回是否全部通过（跳过也算不通过）。 */
function runNodeTests(files, { grep, env = process.env } = {}) {
  const summaryFile = path.join(os.tmpdir(), `dscli-test-summary-${process.pid}-${Date.now()}.json`)
  const args = ['--test', '--test-concurrency=1', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout']
  if (grep) args.push(`--test-name-pattern=${grep}`)
  const result = spawnSync(process.execPath, [...args, ...files], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, DSCLI_TEST_SUMMARY: summaryFile },
  })
  let summary
  try {
    summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    fs.rmSync(summaryFile, { force: true })
  } catch (error) {
    process.stdout.write(`✕ runner > 没有拿到测试汇总（node --test 异常退出）\n  │ ${error.message}\n`)
    return false
  }
  return result.status === 0 && summary.failed === 0 && summary.tests > 0
}

function suiteProtocol() {
  heading('protocol：测试输出协议自检')
  // 用一个故意含失败、子用例、跳过、伪造日志的样例文件，检查 reporter 输出符合协议第 4 节
  const fixture = path.join(TESTS, 'protocol', 'fixture.mjs')
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${REPORTER}`, fixture], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSCLI_TEST_SUMMARY: '' },
  })
  // 与常见平台识别失败用例的规则一致：行首（可有空白）是 × ✕ ✗ 之一，后面是用例名
  const failed = [...result.stdout.matchAll(/^\s*[×✕✗]\s+(.+?)(?: \(\d+ms\))?$/gm)].map(m => m[1])
  const expected = [
    'protocol/fixture.mjs > 失败',
    'protocol/fixture.mjs > 父用例 > 子用例失败',
    'protocol/fixture.mjs > 跳过',
  ]
  const checks = [
    ['失败用例逐条输出且名字带文件前缀', JSON.stringify(failed.sort()) === JSON.stringify([...expected].sort())],
    ['通过用例输出 ✓ 行', /^✓ protocol\/fixture\.mjs > 通过 \(\d+ms\)$/m.test(result.stdout)],
    ['测试日志里伪造的结果行被加上前缀', /^ {2}│ ✕ 伪造的失败行$/m.test(result.stdout)],
    ['有失败时 node --test 退出码非 0', result.status !== 0],
  ]
  for (const [name, ok] of checks) process.stdout.write(`${ok ? '✓' : '✕'} protocol > ${name}\n`)
  const ok = checks.every(([, passed]) => passed)
  if (!ok) process.stdout.write(`  │ reporter 实际输出：\n${result.stdout.replace(/^/gm, '  │   ')}\n`)
  return ok
}

function suiteUnit() {
  heading('unit：dsCli 单元测试（vitest）')
  let vitest
  try {
    const require = createRequire(path.join(CODE, 'package.json'))
    const pkg = require.resolve('vitest/package.json')
    vitest = path.join(path.dirname(pkg), JSON.parse(fs.readFileSync(pkg, 'utf8')).bin.vitest)
  } catch {
    process.stdout.write('✕ unit > 依赖未安装：请先执行 prepare（pnpm -C code install --frozen-lockfile）\n')
    return false
  }
  // vitest 默认输出（失败行为 `FAIL  文件 > 用例` 与 `×`），本身符合协议，不另做转换
  const result = spawnSync(process.execPath, [vitest, 'run', ...UNIT_FILTERS], { cwd: CODE, stdio: 'inherit', env: process.env })
  return result.status === 0
}

function suiteNodeTests(dir, label, { only, grep, requireEnv }) {
  heading(label)
  if (requireEnv && !process.env[requireEnv]) {
    // 规范不允许跳过：缺少真实模型密钥就明确失败，而不是悄悄跳过
    process.stdout.write(`✕ ${dir} > 缺少环境变量 ${requireEnv}（e2e 要调用真实模型）\n`)
    return false
  }
  const files = testFiles(dir, only)
  if (files.length === 0) {
    if (only.length > 0) {
      process.stdout.write(`✕ ${dir} > 没有匹配 ${only.join(', ')} 的测试文件\n`)
      return false
    }
    process.stdout.write(`ℹ ${dir}：没有测试文件\n`)
    return true
  }
  return runNodeTests(files, { grep })
}

const options = parseArgs(process.argv.slice(2))
const started = Date.now()
const results = []
for (const suite of options.suites) {
  let ok
  if (suite === 'protocol') ok = suiteProtocol()
  else if (suite === 'unit') ok = suiteUnit()
  else if (suite === 'acceptance') ok = suiteNodeTests('acceptance', 'acceptance：黑盒验收测试', options)
  else ok = suiteNodeTests('e2e', 'e2e：真实模型端到端测试', { ...options, requireEnv: 'DEEPSEEK_API_KEY' })
  results.push([suite, ok])
}
heading(`结果（${Math.round((Date.now() - started) / 1000)} 秒）`)
for (const [suite, ok] of results) process.stdout.write(`${ok ? '通过' : '失败'}  ${suite}\n`)
process.exit(results.every(([, ok]) => ok) ? 0 : 1)
