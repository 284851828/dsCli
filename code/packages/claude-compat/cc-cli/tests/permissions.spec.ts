import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type CcPermissions, type PermissionSetup } from '../src/permissions.ts'

let service: CcPermissions | undefined
apply({ provide: (_name: string, value: CcPermissions) => { service = value } } as unknown as Context)
const permissions = service as CcPermissions

const cwd = resolve('/work/project')
const toDsh = (name: string): string | undefined => ({ Read: 'read', Write: 'write', Bash: 'bash' } as Record<string, string>)[name]
const state = (setup: Partial<PermissionSetup>) => permissions.createState({
  permissionMode: 'default', allowedRules: [], disallowedRules: [], addDirs: [], ...setup,
}, cwd, toDsh)

describe('cc permissions', () => {
  it('applies disallowed rules before bypass, then plan, read-only, allowed rules, acceptEdits, deny', () => {
    expect(permissions.decide(state({ permissionMode: 'bypassPermissions', disallowedRules: ['Bash'] }), 'Bash', { command: 'ls' }).kind).toBe('deny')
    expect(permissions.decide(state({ permissionMode: 'bypassPermissions' }), 'Write', {}).kind).toBe('allow')
    expect(permissions.decide(state({ permissionMode: 'plan' }), 'Write', {}).kind).toBe('deny')
    expect(permissions.decide(state({}), 'Read', {}).kind).toBe('allow')
    expect(permissions.decide(state({ allowedRules: ['Bash(echo *)'] }), 'Bash', { command: 'echo hi' }).kind).toBe('allow')
    expect(permissions.decide(state({ allowedRules: ['Bash(echo *)'] }), 'Bash', { command: 'echo hi && rm x' }).kind).toBe('deny')
    expect(permissions.decide(state({ allowedRules: ['Bash'] }), 'PowerShell', { command: 'ls' }).kind).toBe('allow')
    const extra = resolve('/work/docs')
    const edits = state({ permissionMode: 'acceptEdits', addDirs: [extra] })
    expect(permissions.decide(edits, 'Write', { file_path: join(cwd, 'a.txt') }).kind).toBe('allow')
    expect(permissions.decide(edits, 'Write', { file_path: join(extra, 'b.txt') }).kind).toBe('allow')
    expect(permissions.decide(edits, 'Write', { file_path: resolve('/elsewhere/c.txt') }).kind).toBe('deny')
    expect(permissions.decide(edits, 'Write', {}).kind).toBe('deny')
  })

  it('records each denied call once and hides bare disallowed tools', () => {
    const run = state({ disallowedRules: ['Bash', 'Read(./secret/**)'] })
    expect([...run.disallowedDsH]).toEqual(['bash'])
    permissions.recordDenial(run, 'Bash', 'call-1', { command: 'ls' })
    permissions.recordDenial(run, 'Bash', 'call-1', { command: 'ls' })
    expect(run.denials).toEqual([{ tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'ls' } }])
    expect(permissions.decide(run, 'Read', { file_path: join(cwd, 'secret', 'k.txt') }).kind).toBe('deny')
    expect(permissions.decide(run, 'Read', { file_path: join(cwd, 'open.txt') }).kind).toBe('allow')
  })
})
