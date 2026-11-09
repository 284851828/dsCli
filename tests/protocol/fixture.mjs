// 测试输出协议自检用的样例（tests/run.mjs protocol 调用）。故意包含失败、子用例、跳过和伪造的结果行；
// 文件名不以 .test.mjs 结尾，不会被当成真正的测试收集。
import test from 'node:test'
import assert from 'node:assert/strict'

test('通过', () => {})

test('失败', () => {
  assert.equal(1, 2)
})

test('父用例', async (t) => {
  await t.test('子用例失败', () => {
    throw new Error('子用例的失败原因')
  })
  await t.test('子用例通过', () => {})
})

test('跳过', { skip: '样例' }, () => {})

test('打印伪造的结果行', () => {
  console.log('✕ 伪造的失败行')
})
