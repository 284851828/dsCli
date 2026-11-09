/**
 * dsCli 测试输出协议的 node:test reporter，规则见 docs/测试规范.md 第 4 节。
 *
 * 为什么不用 node 自带的 spec 格式：spec 用 `✖` 标失败，常见平台（含 xCode）只认 jest / vitest
 * 惯用的 `✕` 行。这里把每个用例输出成一行固定格式，平台据此识别失败用例名。
 *
 *   ✓ <文件> > <用例名> (12ms)        通过
 *   ✕ <文件> > <用例名> (12ms)        失败；下面缩进的 `│` 行是失败原因
 *   ✕ <文件> > <用例名> (0ms)         跳过也算失败（规范不允许跳过），原因写在下一行
 *   │ ...                              测试自己打印的内容，一律加 `│` 前缀，不会被误认成结果行
 *
 * 环境变量 DSCLI_TEST_SUMMARY 指定一个文件时，结束后把汇总写成 JSON（tests/run.mjs 用它决定退出码）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_DETAIL_LINES = 20

/** tests/acceptance/req_15/foo.test.mjs → acceptance/req_15/foo：用例名前缀，保证不同需求的 TC 编号不冲突。 */
function fileTag(file) {
  if (!file) return '?'
  const abs = path.isAbsolute(file) ? file : path.resolve(file)
  return path.relative(TESTS_DIR, abs).replace(/\\/g, '/').replace(/\.test\.mjs$/, '')
}

/** 多行文本加 `│` 前缀，避免以 ✓ / ✕ 开头的日志被平台当成结果行。 */
function guarded(text, limit = Infinity) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const shown = lines.slice(0, limit).map(line => `  │ ${line}`)
  if (lines.length > limit) shown.push(`  │ …（共 ${lines.length} 行）`)
  return shown.join('\n') + '\n'
}

function errorText(error) {
  const cause = error?.cause ?? error
  return cause?.stack || cause?.message || String(cause)
}

export default async function * reporter(source) {
  const stack = [] // stack[nesting] = 当前各层用例名
  const counts = { tests: 0, passed: 0, failed: 0, skipped: 0 }
  const failures = []
  for await (const event of source) {
    const data = event.data
    switch (event.type) {
      case 'test:start':
        stack[data.nesting] = data.name
        stack.length = data.nesting + 1
        break
      case 'test:pass':
      case 'test:fail': {
        // 父用例因子用例失败而失败时不重复输出，失败只记在叶子用例上
        if (data.details?.type === 'suite' || data.details?.error?.failureType === 'subtestsFailed') break
        const name = [fileTag(data.file), ...stack.slice(0, data.nesting), data.name].join(' > ')
        const ms = `${Math.round(data.details?.duration_ms ?? 0)}ms`
        counts.tests++
        if (data.skip !== undefined || data.todo !== undefined) {
          counts.skipped++
          counts.failed++
          failures.push(name)
          // 说明放在下一行：结果行只留用例名和耗时，平台识别出的名字才稳定
          yield `✕ ${name} (${ms})\n` + guarded(`跳过：规范不允许跳过（${data.skip ?? data.todo}）`)
        } else if (event.type === 'test:pass') {
          counts.passed++
          yield `✓ ${name} (${ms})\n`
        } else {
          counts.failed++
          failures.push(name)
          yield `✕ ${name} (${ms})\n` + guarded(errorText(data.details?.error), MAX_DETAIL_LINES)
        }
        break
      }
      case 'test:stdout':
      case 'test:stderr':
        yield guarded(data.message)
        break
      case 'test:diagnostic':
        // 顶层诊断是 node 自带的计数汇总，下面统一输出；用例内的诊断（t.diagnostic）照常显示
        if (data.nesting > 0) yield guarded(data.message)
        break
      default:
        break
    }
  }
  const summary = `ℹ 用例 ${counts.tests}　通过 ${counts.passed}　失败 ${counts.failed}　跳过 ${counts.skipped}`
  yield `\n${summary}\n`
  if (failures.length > 0) yield `失败用例：\n${failures.map(name => `  - ${name}`).join('\n')}\n`
  if (process.env.DSCLI_TEST_SUMMARY) {
    fs.writeFileSync(process.env.DSCLI_TEST_SUMMARY, JSON.stringify({ ...counts, failures }, null, 2))
  }
}
