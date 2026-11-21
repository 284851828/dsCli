import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyPermissions, type CcPermissions, type PermissionSetup } from '../src/permissions.ts'
import { apply as applyToolNames, type CcToolNames } from '../src/tool-names.ts'

let namesService: CcToolNames | undefined
applyToolNames({ provide: (_name: string, value: CcToolNames) => { namesService = value } } as unknown as Context)
const names = namesService as CcToolNames

let permissionsService: CcPermissions | undefined
applyPermissions({ provide: (_name: string, value: CcPermissions) => { permissionsService = value } } as unknown as Context)
const permissions = permissionsService as CcPermissions

const cwd = resolve('/work/project')
const state = (setup: Partial<PermissionSetup>) => permissions.createState({
  permissionMode: 'default', allowedRules: [], disallowedRules: [], addDirs: [], ...setup,
}, cwd, name => names.toDshAll(name))

describe('cc tool names', () => {
  it('lets Claude Read stand for read and its read_image companion', () => {
    expect(names.toDsh('Read')).toBe('read')
    expect(names.toDshAll('Read')).toEqual(['read', 'read_image'])
    expect(names.toClaude('read')).toBe('Read')
    expect(names.toClaude('read_image')).toBe('Read')
  })

  it('keeps single-tool names, MCP names, and unknown names as before', () => {
    expect(names.toDshAll('Write')).toEqual(['write'])
    expect(names.toDshAll('Glob')).toEqual(['glob'])
    expect(names.toDshAll('mcp__srv__tool')).toEqual(['mcp__srv__tool'])
    expect(names.toDshAll('MultiEdit')).toEqual([])
    expect(names.toDsh('MultiEdit')).toBeUndefined()
    expect(names.toClaude('some_native_tool')).toBe('some_native_tool')
  })

  it('applies Read permission rules to an image read reported under the Read name', () => {
    const imageRead = names.toClaude('read_image')
    const run = state({ disallowedRules: ['Read(./secret/**)'] })
    expect(permissions.decide(run, imageRead, { file_path: join(cwd, 'secret', 'shot.png') }).kind).toBe('deny')
    expect(permissions.decide(run, imageRead, { file_path: join(cwd, 'open', 'shot.png') }).kind).toBe('allow')
    // An image read is read-only: plan mode allows it, like a text read.
    expect(permissions.decide(state({ permissionMode: 'plan' }), imageRead, { file_path: join(cwd, 'a.png') }).kind).toBe('allow')
  })

  it('hides read_image together with read under a bare disallowed Read', () => {
    expect([...state({ disallowedRules: ['Read'] }).disallowedDsH].sort()).toEqual(['read', 'read_image'])
    expect([...state({ disallowedRules: ['Read(./x/**)'] }).disallowedDsH]).toEqual([])
  })
})
