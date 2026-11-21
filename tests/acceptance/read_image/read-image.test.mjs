// 读图片：Claude Code 的 Read 能直接看图，dsCli 里对应内核的 read_image。
// 这不是平台上某条需求的验收测试（2026-11-21 直接改的），所以目录不带需求编号。
// 黑盒验收：只通过命令行入口驱动，断言模型桩收到的请求、stdout 事件和权限结果。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import zlib from 'node:zlib'
import fsp from 'node:fs/promises'
import {
  makeWorkspace,
  startStub,
  stubEnv,
  runCli,
  jsonLines,
  eventsOfType,
  toolUses,
  toolResults,
  requestedToolNames,
  writeFile,
} from '../../lib/harness.mjs'

// 模型桩走 llm-deepseek 路由。声明一个支持图片的模型和一个只支持文本的模型。
// 「Read 带出读图片」默认打开；READ_IMAGE_OFF_PATCH 把它关掉。
const MODELS_PATCH = `- id: llm-deepseek
  config:
    models:
      - id: stub-vision
        name: Stub Vision
        contextWindow: 1048576
        inputModalities: [text, image]
      - id: stub-text
        name: Stub Text
        contextWindow: 1048576
`
const READ_IMAGE_OFF_PATCH = `${MODELS_PATCH}- id: cc-runner
  config:
    readImage: false
`

/** 生成一张合法的 8 位 RGB PNG，不依赖任何图片库。 */
function pngBytes(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8 位、RGB、默认压缩 / 滤波 / 不隔行
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0).map((_, i) => [r, g, b][i % 3])])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 请求体里（含工具结果内部）有没有图片块。 */
function hasImageBlock(value) {
  if (Array.isArray(value)) return value.some(hasImageBlock)
  if (value === null || typeof value !== 'object') return false
  if (value.type === 'image' || value.type === 'image_url') return true
  return Object.values(value).some(hasImageBlock)
}

/** 模型桩收到的对话请求（带 messages 的 JSON 请求），不含标题请求和文件上传。 */
function messageRequests(stub) {
  return stub.taskRequests().filter(request => Array.isArray(request.body?.messages))
}

async function setup(t, tc, responder) {
  const ws = await makeWorkspace(t, tc)
  const stub = await startStub(responder)
  t.after(() => stub.close())
  const patch = await writeFile(path.join(ws.root, 'models.yml'), MODELS_PATCH)
  const turnedOff = await writeFile(path.join(ws.root, 'read-image-off.yml'), READ_IMAGE_OFF_PATCH)
  const shot = path.join(ws.cwd, 'shots', 'page.png')
  await fsp.mkdir(path.dirname(shot), { recursive: true })
  await fsp.writeFile(shot, pngBytes(16, 12, [200, 30, 30]))
  return { ws, stub, patch, turnedOff, shot }
}

const BASE = ['-p', '--output-format', 'stream-json', '--verbose']

test('TC-01 [P0] 模型支持图片：--tools Read 默认带出 read_image，读图成功并显示为 Read', async (t) => {
  const { ws, stub, patch, shot } = await setup(t, 'RI-01', ({ n }) => (
    n === 1 ? { calls: [{ name: 'read_image', input: { file_path: shot } }] } : { text: '看到了一张红色的图' }
  ))

  const run = await runCli({
    args: [...BASE, '--model', 'stub-vision', '看一下截图', '--tools', 'Read'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    patches: [patch],
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)

  const requests = stub.taskRequests()
  assert.deepEqual(requestedToolNames(requests[0].body).sort(), ['read', 'read_image'],
    '模型支持图片时，--tools Read 默认应同时给出 read 和 read_image')
  assert.deepEqual(eventsOfType(events, 'system')[0].tools, ['Read'], 'init.tools 里两个工具合并显示为一个 Read')

  const uses = toolUses(events)
  assert.equal(uses.length, 1, `应恰有 1 次工具调用，实际 ${uses.length}`)
  assert.equal(uses[0].name, 'Read', `读图片在 stdout 里应显示为 Read，实际 ${uses[0].name}`)
  assert.equal(uses[0].input.file_path, shot)

  const results = toolResults(events)
  assert.equal(results.length, 1)
  assert.equal(results[0].is_error, false, `读图不应报错：${JSON.stringify(results[0].content).slice(0, 500)}`)
  assert.match(String(results[0].content), /<type>image<\/type>/, '工具结果应是图片的说明文字')
  assert.match(String(results[0].content), /image\/png image, 16x12 px/)
  assert.equal(String(results[0].content).includes('base64'), false, 'stdout 的工具结果里不应带图片数据')

  // 有的路由会先把图片传到文件接口（不是 JSON 请求），所以只看对话请求里的最后一条
  const chats = messageRequests(stub)
  assert.ok(chats.length >= 2, '读图之后应把结果发回模型')
  assert.ok(hasImageBlock(chats.at(-1).body.messages), '读图之后的对话请求应带上图片本身，模型才看得到')
  assert.deepEqual(eventsOfType(events, 'result').at(-1).permission_denials, [])
})

test('TC-02 [P0] Read 的路径拒绝规则同样挡住读图片', async (t) => {
  const { ws, stub, patch, shot } = await setup(t, 'RI-02', ({ n }) => (
    n === 1 ? { calls: [{ name: 'read_image', input: { file_path: shot } }] } : { text: '读不了' }
  ))
  const blocked = `${path.dirname(shot).replaceAll('\\', '/')}/**`

  const run = await runCli({
    args: [...BASE, '--model', 'stub-vision', '看一下截图', '--tools', 'Read', '--disallowedTools', `Read(${blocked})`],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    patches: [patch],
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)

  const results = toolResults(events)
  assert.equal(results.length, 1)
  assert.equal(results[0].is_error, true, '被拒绝规则挡住的读图应报错')
  assert.match(String(results[0].content), /Permission to use Read has been denied/)
  const denials = eventsOfType(events, 'result').at(-1).permission_denials
  assert.ok(denials.some(item => item.tool_name === 'Read' && item.tool_input?.file_path === shot),
    `permission_denials 应记下这次读图：${JSON.stringify(denials)}`)
  assert.equal(messageRequests(stub).some(request => hasImageBlock(request.body.messages)), false, '被挡住的图片不能发给模型')
  assert.equal(stub.requests.some(request => String(request.url).includes('/files')), false, '被挡住的图片也不能上传到文件接口')
})

test('TC-03 [P1] 模型只支持文本：--tools Read 的工具定义不变，只有 read', async (t) => {
  const { ws, stub, patch } = await setup(t, 'RI-03', () => ({ text: 'OK' }))

  const run = await runCli({
    args: [...BASE, '--model', 'stub-text', 'hi', '--tools', 'Read'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    patches: [patch],
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  assert.deepEqual(requestedToolNames(stub.taskRequests()[0].body), ['read'],
    '模型不支持图片时不该给它 read_image：给了也只会被拒绝')
  assert.deepEqual(eventsOfType(jsonLines(run.stdout), 'system')[0].tools, ['Read'])
})

test('TC-04 [P1] 不限定工具时，读图片按 Read 放行，不再被当成未授权的工具', async (t) => {
  const { ws, stub, patch, shot } = await setup(t, 'RI-04', ({ n }) => (
    n === 1 ? { calls: [{ name: 'read_image', input: { file_path: shot } }] } : { text: '看到了' }
  ))

  const run = await runCli({
    args: [...BASE, '--model', 'stub-vision', '看一下截图'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    patches: [patch],
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  const events = jsonLines(run.stdout)

  const init = eventsOfType(events, 'system')[0]
  assert.equal(init.tools.filter(tool => tool === 'Read').length, 1, `init.tools 里 Read 只出现一次：${JSON.stringify(init.tools)}`)
  assert.equal(init.tools.includes('read_image'), false, 'init.tools 不应出现原生名 read_image')
  assert.equal(toolUses(events)[0].name, 'Read')
  assert.equal(toolResults(events)[0].is_error, false, `默认权限下读图应放行：${String(toolResults(events)[0].content).slice(0, 300)}`)
  assert.deepEqual(eventsOfType(events, 'result').at(-1).permission_denials, [])
})

test('TC-05 [P1] 在配置里关掉开关：模型支持图片，--tools Read 也只给 read', async (t) => {
  const { ws, stub, turnedOff } = await setup(t, 'RI-05', () => ({ text: 'OK' }))

  const run = await runCli({
    args: [...BASE, '--model', 'stub-vision', 'hi', '--tools', 'Read'],
    cwd: ws.cwd,
    env: stubEnv(ws, stub),
    patches: [turnedOff],
  })
  assert.equal(run.code, 0, `退出码应为 0，stderr：${run.stderr.slice(-2000)}`)
  assert.deepEqual(requestedToolNames(stub.taskRequests()[0].body), ['read'],
    'cc-runner 的 readImage 设为 false 后，--tools Read 的模型侧工具定义只有 read')
  assert.deepEqual(eventsOfType(jsonLines(run.stdout), 'system')[0].tools, ['Read'])
})
