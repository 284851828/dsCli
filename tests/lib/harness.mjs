/**
 * Black-box acceptance harness for dsCli.
 *
 * Everything here drives the product only through the interfaces fixed by the
 * development plan: `code\bin\dsCli.cmd`, `node apps/cli/lib/bin.js --profile dscli`,
 * `dsh --profile dscli --dump-config`, process exit codes, stdout/stderr, the
 * `$DSH_HOME/sessions` layout, and a local Anthropic-Messages model stub.
 *
 * No product source is imported. The only Node command executed is the real
 * entry point; the only model endpoint is the local stub.
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CODE = path.join(ROOT, 'code')
const BUILT_ENTRY = path.join(CODE, 'apps', 'cli', 'lib', 'bin.js')
const DEV_ENTRY = path.join(CODE, 'apps', 'cli', 'src', 'bin.ts')
const WRAPPER = path.join(CODE, 'bin', 'dsCli.cmd')

const IS_WINDOWS = process.platform === 'win32'
const COMSPEC = process.env.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe'

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function quoteCmd(value) {
  if (value === '') return '""'
  if (!/[\s"&|<>^]/.test(value)) return value
  // cmd.exe doubles embedded quotes inside a quoted argument.
  return `"${value.replace(/"/g, '""')}"`
}

function killTreeSync(pid) {
  if (!pid) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

/** Run a command line through cmd.exe (Windows) / sh (POSIX) and capture output. */
export function runShell(line, { cwd = ROOT, env = process.env, timeout = 120000 } = {}) {
  const started = Date.now()
  const result = IS_WINDOWS
    ? spawnSync(COMSPEC, ['/d', '/s', '/c', line], {
      cwd, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    })
    : spawnSync('/bin/sh', ['-c', line], {
      cwd, env, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    })
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    durationMs: Date.now() - started,
  }
}

/** Run pnpm inside the copied upstream workspace. */
export function runPnpm(args, options = {}) {
  return runShell(`pnpm ${args.map(quoteCmd).join(' ')}`, { cwd: CODE, ...options })
}

// ---------------------------------------------------------------------------
// Install / build bootstrap (idempotent, shared by TC-01 and TC-02)
// ---------------------------------------------------------------------------

let installed
/** Ensure the upstream workspace dependencies exist. Returns {ok, detail}. */
export async function ensureInstalled() {
  installed ??= (async () => {
    if (!fs.existsSync(path.join(CODE, 'package.json'))) {
      return { ok: false, skipped: false, detail: 'code/package.json 不存在：上游 DSH 源码尚未复制到 code/' }
    }
    if (process.env.DSCLI_FORCE_INSTALL !== '1' && fs.existsSync(path.join(CODE, 'node_modules', '.pnpm'))) {
      return { ok: true, skipped: true, detail: 'node_modules 已存在' }
    }
    const run = runPnpm(['install'], { timeout: 45 * 60 * 1000 })
    return {
      ok: run.code === 0,
      skipped: false,
      detail: `pnpm install 退出码 ${run.code}${run.code === 0 ? '' : `\n${tail(run.stdout)}\n${tail(run.stderr)}`}`,
      run,
    }
  })()
  return installed
}

let built
/** Ensure `apps/cli/lib/bin.js` exists. Returns {ok, detail}. */
export async function ensureBuilt() {
  built ??= (async () => {
    const install = await ensureInstalled()
    if (!install.ok) return { ok: false, detail: install.detail }
    if (process.env.DSCLI_FORCE_BUILD !== '1' && fs.existsSync(BUILT_ENTRY)) {
      return { ok: true, skipped: true, detail: '构建产物已存在' }
    }
    const run = runPnpm(['run', 'build'], { timeout: 60 * 60 * 1000 })
    return {
      ok: run.code === 0 && fs.existsSync(BUILT_ENTRY),
      skipped: false,
      detail: run.code === 0
        ? `pnpm run build 退出码 0，产物存在：${fs.existsSync(BUILT_ENTRY)}`
        : `pnpm run build 退出码 ${run.code}\n${tail(run.stdout)}\n${tail(run.stderr)}`,
      run,
    }
  })()
  return built
}

function findTsxLoader() {
  try {
    const req = createRequire(path.join(CODE, 'package.json'))
    return req.resolve('tsx')
  } catch {
    // fall through to the well-known layout
  }
  for (const candidate of [
    path.join(CODE, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
    path.join(CODE, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
  ]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/** Resolve how to start the product CLI. Throws when the implementation is absent. */
export function resolveEntry(mode = 'auto') {
  if (mode === 'wrapper') {
    if (!fs.existsSync(WRAPPER)) {
      throw new Error(`dsCli 包装脚本不存在：${WRAPPER}（实现缺失）`)
    }
    if (!fs.existsSync(BUILT_ENTRY)) {
      throw new Error(`构建产物不存在：${BUILT_ENTRY}；包装脚本无法运行（实现缺失或未执行 pnpm run build）`)
    }
    return { kind: 'wrapper', wrapper: WRAPPER }
  }
  if (fs.existsSync(BUILT_ENTRY)) return { kind: 'node', file: BUILT_ENTRY, pre: [] }
  if (fs.existsSync(DEV_ENTRY)) {
    const loader = findTsxLoader()
    if (loader === undefined) {
      throw new Error(`开发入口存在但 tsx 未安装：${path.join(CODE, 'node_modules', 'tsx')}（依赖未安装）`)
    }
    return { kind: 'node', file: DEV_ENTRY, pre: ['--import', pathToFileURL(loader).href] }
  }
  throw new Error(
    `dsCli 实现不存在：找不到 ${BUILT_ENTRY} 或 ${DEV_ENTRY}。`
    + '（需要先把上游 DSH 源码复制到 code/ 并执行 pnpm install / pnpm run build）',
  )
}

function tail(text, limit = 4000) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : `...(${text.length} chars)\n${text.slice(-limit)}`
}

/**
 * Spawn the real dsCli process.
 *
 * @param {object} options
 * @param {string[]} options.args       app arguments after `--profile dscli`
 * @param {string} [options.cwd]        agent working directory
 * @param {object} [options.env]        child environment
 * @param {string} [options.stdin]      bytes to write to stdin ('', null closes immediately)
 * @param {string[]} [options.patches]  launcher `--patch` overlays (direct node mode)
 * @param {'auto'|'wrapper'|'dev'} [options.mode]
 * @param {number} [options.timeoutMs]
 */
export async function runCli({
  args = [],
  cwd = ROOT,
  env = process.env,
  stdin = '',
  patches = [],
  mode = 'auto',
  profile = 'dscli',
  timeoutMs = 180000,
} = {}) {
  const entry = resolveEntry(mode)
  let command
  let commandArgs
  if (entry.kind === 'wrapper') {
    command = COMSPEC
    commandArgs = ['/d', '/s', '/c', `${quoteCmd(entry.wrapper)} ${args.map(quoteCmd).join(' ')}`]
  } else {
    command = process.execPath
    commandArgs = [
      ...entry.pre,
      entry.file,
      '--profile', profile,
      ...patches.flatMap(patch => ['--patch', patch]),
      ...args,
    ]
  }

  const child = spawn(command, commandArgs, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let lastResultAt
  let partial = ''
  const startedAt = Date.now()

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    partial += chunk
    const lines = partial.split(/\r?\n/)
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (line.includes('"type":"result"') || line.includes('"type": "result"')) lastResultAt = Date.now()
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  child.stdin.on('error', () => { /* the CLI may not read stdin */ })
  child.stdin.end(stdin ?? '')

  let timeoutTimer
  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true
      killTreeSync(child.pid)
    }, timeoutMs)
  }

  const result = await new Promise((resolve) => {
    child.on('error', (error) => {
      resolve({ code: null, signal: null, spawnError: error })
    })
    child.on('close', (code, signal) => resolve({ code, signal, spawnError: undefined }))
  })
  if (timeoutTimer) clearTimeout(timeoutTimer)
  const exitedAt = Date.now()

  return {
    ...result,
    stdout,
    stderr,
    timedOut,
    durationMs: exitedAt - startedAt,
    lastResultAt,
    exitedAt,
    resultToExitMs: lastResultAt === undefined ? undefined : exitedAt - lastResultAt,
    command: `${command} ${commandArgs.join(' ')}`,
  }
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

function safeTag(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-')
}

/**
 * Create an isolated project workspace. Every test gets its own tmp dir (and
 * XCODE_SANDBOX is part of the name so concurrent requirement copies never share).
 */
export async function makeWorkspace(t, tc, { withAddDir = false } = {}) {
  const sandbox = process.env.XCODE_SANDBOX || 'local'
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `dscli-${safeTag(tc)}-${safeTag(sandbox)}-`))
  const workspace = {
    root,
    cwd: path.join(root, 'work'),
    dshHome: path.join(root, 'dsh'),
    addDir: path.join(root, 'doc'),
    outside: path.join(root, 'outside'),
    home: path.join(root, 'home'),
  }
  await Promise.all([workspace.cwd, workspace.dshHome, workspace.home, workspace.outside, ...(withAddDir ? [workspace.addDir] : [])]
    .map(dir => fsp.mkdir(dir, { recursive: true })))
  if (t) {
    t.after(async () => {
      if (process.env.DSCLI_KEEP_TEMP === '1') {
        console.error(`[harness] 保留临时目录：${root}`)
        return
      }
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
    })
  }
  return workspace
}

/** Environment for one CLI process: no inherited model/DSH/dsCli variables. */
export function cliEnv(workspace, overrides = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DEEPSEEK_|ANTHROPIC_|DSCLI_|DSH_|CLAUDE_CODE_)/.test(key)) continue
    env[key] = value
  }
  env.NO_COLOR = '1'
  env.DSH_HOME = workspace?.dshHome
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key]
    else env[key] = String(value)
  }
  return env
}

/** Standard stub environment; point the provider at `${stub.url}/anthropic`. */
export function stubEnv(workspace, stub, overrides = {}) {
  return cliEnv(workspace, {
    DEEPSEEK_BASE_URL: `${stub.url}/anthropic`,
    DEEPSEEK_API_KEY: 'test',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Local Anthropic-Messages model stub
// ---------------------------------------------------------------------------

function textOfSystem(body) {
  if (body === null || body === undefined) return ''
  const system = body.system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map(block => (block && typeof block.text === 'string' ? block.text : '')).join('\n')
  }
  return ''
}

/** Joined text of a request body's `system` field. */
export const systemTextOf = textOfSystem

const TITLE_PROMPT = 'Create a concise title for an AI coding-assistant session'

/**
 * Start the deterministic model stub.
 *
 * `responder({ body, n, isTitle, request })` returns one of:
 *   { text }                          plain assistant text
 *   { thinking, text }                thinking block then text
 *   { text, calls: [{name,input}] }   text (optional) plus tool_use blocks
 *   { calls: [...] }                  tool_use blocks only
 *   { status, json?, message? }       HTTP error
 *
 * Every request is recorded with its full JSON body. `taskRequests` excludes
 * the base harness's automatic session-title call.
 */
export async function startStub(responder, { countTitles = false } = {}) {
  const state = { requests: [], n: 0 }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body
      try { body = raw.length > 0 ? JSON.parse(raw) : undefined } catch { body = undefined }
      const isTitle = textOfSystem(body).includes(TITLE_PROMPT)
      const request = { url: req.url, method: req.method, headers: req.headers, body, raw, isTitle, at: Date.now() }
      state.requests.push(request)

      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }

      let spec
      if (isTitle && !countTitles) {
        spec = { text: '测试标题' }
      } else {
        state.n += 1
        try {
          spec = responder({ body, n: state.n, isTitle, request })
        } catch (error) {
          spec = { status: 500, message: `stub responder threw: ${error.message}` }
        }
      }
      if (spec === undefined) spec = { text: 'OK' }

      if (spec.status !== undefined && spec.status >= 400) {
        res.writeHead(spec.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(spec.json ?? {
          type: 'error',
          error: { type: 'api_error', message: spec.message ?? 'stub failure' },
        }))
        return
      }
      writeMessagesStream(res, spec, body)
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests: state.requests,
    taskRequests: () => state.requests.filter(request => request.method === 'POST' && !request.isTitle),
    reset() {
      state.requests.length = 0
      state.n = 0
    },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function writeMessagesStream(res, spec, body) {
  const inputTokens = spec.inputTokens ?? 12
  const outputTokens = spec.outputTokens ?? 7
  const model = body?.model ?? 'stub-model'
  const events = [{
    type: 'message_start',
    message: {
      id: `msg_stub_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }]
  let index = 0
  const blocks = []
  if (spec.thinking !== undefined) blocks.push({ type: 'thinking', thinking: spec.thinking })
  if (spec.text !== undefined) blocks.push({ type: 'text', text: spec.text })
  for (const call of spec.calls ?? []) blocks.push({ type: 'tool_use', id: call.id ?? `toolu_stub_${index}_${Date.now()}`, name: call.name, input: call.input ?? {} })

  for (const block of blocks) {
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } })
      events.push({ type: 'content_block_stop', index })
    } else if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
      events.push({ type: 'content_block_stop', index })
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      events.push({ type: 'content_block_stop', index })
    }
    index += 1
  }

  const stopReason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
  events.push({ type: 'message_stop' })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
}

// ---------------------------------------------------------------------------
// stdout / event parsing
// ---------------------------------------------------------------------------

/** Parse every non-empty stdout line as JSON; throws with context when a line is not JSON. */
export function jsonLines(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim().length > 0)
  return lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`stdout 第 ${index + 1} 行不是合法 JSON（可能输出了非协议内容）：\n${line.slice(0, 500)}`)
    }
  })
}

export function eventsOfType(events, type) {
  return events.filter(event => event?.type === type)
}

export function contentBlocks(message) {
  const content = message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

/** Tool uses across assistant events, in order. */
export function toolUses(events) {
  return eventsOfType(events, 'assistant').flatMap(event =>
    contentBlocks(event.message).filter(block => block.type === 'tool_use'))
}

/** Tool results across user events, in order. */
export function toolResults(events) {
  return eventsOfType(events, 'user').flatMap(event =>
    contentBlocks(event.message).filter(block => block.type === 'tool_result'))
}

/** Text blocks of human (non tool-result) user messages in a request body. */
export function humanTexts(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.flatMap(message => {
    if (message?.role !== 'user') return []
    return contentBlocks(message).filter(block => block.type === 'text').map(block => block.text)
  })
}

/** Names offered in a model request body. */
export function requestedToolNames(body) {
  return Array.isArray(body?.tools) ? body.tools.map(tool => tool?.name).filter(name => typeof name === 'string') : []
}

// ---------------------------------------------------------------------------
// dump-config / YAML
// ---------------------------------------------------------------------------

/** Load the dumped profile YAML (js-yaml ships in the upstream workspace). */
export function parseDumpYaml(text) {
  const req = createRequire(path.join(CODE, 'package.json'))
  const yaml = req('js-yaml')
  const jsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: data => data,
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsType])
  const loaded = yaml.load(text, { schema, json: true })
  if (!Array.isArray(loaded)) throw new Error(`--dump-config 输出不是 YAML 列表：${String(text).slice(0, 300)}`)
  return loaded
}

export function dumpEntry(entries, id) {
  return entries.find(entry => entry && entry.id === id)
}

// ---------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------

/** Find session files matching sessions/* /<sessionId>/session.v4.jsonl* */
export async function findSessionFiles(dshHome, sessionId) {
  const sessionsRoot = path.join(dshHome, 'sessions')
  const found = []
  let projects = []
  try { projects = await fsp.readdir(sessionsRoot, { withFileTypes: true }) } catch { return found }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = path.join(sessionsRoot, project.name, sessionId)
    let files = []
    try { files = await fsp.readdir(dir) } catch { continue }
    for (const file of files) {
      if (file.startsWith('session.v4.jsonl')) found.push(path.join(dir, file))
    }
  }
  return found
}

/** Read a session log (plain JSONL or zstd-compressed). */
export async function readSessionText(file) {
  const bytes = await fsp.readFile(file)
  if (file.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error(`会话文件为 zstd 压缩，但当前 Node 不支持 zstd 解压：${file}`)
    }
    return zlib.zstdDecompressSync(bytes).toString('utf8')
  }
  return bytes.toString('utf8')
}

/** Count non-empty lines in a session log. */
export async function sessionLineCount(file) {
  const text = await readSessionText(file)
  return text.split(/\r?\n/).filter(line => line.trim().length > 0).length
}

// ---------------------------------------------------------------------------
// Small filesystem helpers used by the acceptance cases
// ---------------------------------------------------------------------------

export async function writeFile(file, content, encoding = 'utf8') {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, encoding)
  return file
}

/** Write a profile patch overlay and return its absolute path. */
export async function writePatch(workspace, name, yamlText) {
  return writeFile(path.join(workspace.root, name), yamlText)
}

export async function sha256File(file) {
  const bytes = await fsp.readFile(file)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

export async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

/** Every `<dshHome>/sessions/<project>/<session-id>` directory name. */
export async function listSessionIds(dshHome) {
  const root = path.join(dshHome, 'sessions')
  const ids = []
  for (const project of await listDirs(root)) {
    ids.push(...await listDirs(path.join(root, project)))
  }
  return ids
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Number of occurrences of a literal substring. */
export function countOf(text, needle) {
  if (needle.length === 0) return 0
  return text.split(needle).length - 1
}

/** True when stdout contains no U+FFFD replacement characters. */
export function hasNoReplacementChars(text) {
  return !text.includes('�')
}
