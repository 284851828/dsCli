// One command runs only the dsCli acceptance suite (TC-01..TC-40, TC-47..TC-50).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const acceptanceDir = path.join(root, 'tests', 'acceptance')
const files = readdirSync(acceptanceDir)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join(acceptanceDir, name))

const result = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  '--test-reporter=spec',
  ...files,
], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
})

process.exit(result.status ?? 1)
