/**
 * Process-facing effects of one dsCli invocation: the output streams, stdin
 * access, and a flush barrier that keeps piped stdout complete before exit.
 * @module @deepseek-ai/dsh-cc-cli/internals
 */

/** The effects the startup parser and runner share. */
export const internals = {
  stdout: {
    write(chunk: string): void {
      process.stdout.write(chunk)
    },
  },
  stderr: {
    write(chunk: string): void {
      process.stderr.write(chunk)
    },
  },
  /** Whether stdin is an interactive terminal (promptless runs must fail fast there). */
  stdinIsTty(): boolean {
    return process.stdin.isTTY === true
  },
  /** Read the whole of stdin as UTF-8 text. */
  async readStdin(): Promise<string> {
    process.stdin.setEncoding('utf8')
    let text = ''
    for await (const chunk of process.stdin) text += chunk as string
    return text
  },
}

/**
 * Wait until everything queued on stdout has been handed to the OS.
 * A zero-length write queues behind earlier writes, so its callback is the
 * barrier; without it a large piped event can be cut by process exit.
 */
export async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
  })
}
