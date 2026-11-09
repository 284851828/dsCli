import { describe, expect, it } from 'vitest'
import { parseDshArgs } from '../src/args.ts'

describe('parseDshArgs for the dscli profile', () => {
  it('hands --version to the app, which prints the Claude Code compatible version', () => {
    expect(parseDshArgs(['--profile', 'dscli', '--version'], '1.2.3'))
      .toEqual({ mode: 'profile', profile: 'dscli', patches: [], args: ['--version'] })
    expect(parseDshArgs(['dscli', '--patch', 'a.yml', '--version'], '1.2.3'))
      .toEqual({ mode: 'profile', profile: 'dscli', patches: ['a.yml'], args: ['--version'] })
  })
})
