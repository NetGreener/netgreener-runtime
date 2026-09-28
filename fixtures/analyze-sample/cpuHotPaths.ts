import { execSync } from 'node:child_process'

/**
 * Fixture: sleep polling + regex compile + subprocess in loops (CPU RD0 twins).
 */
export function pollUntilReady(check: () => boolean): void {
  while (!check()) {
    setTimeout(() => {}, 50)
  }
}

export function scanLines(lines: string[], needle: string): number {
  let hits = 0
  let blob = ''
  for (const line of lines) {
    const re = new RegExp(needle, 'i')
    if (re.test(line)) hits += 1
    blob += `${line}`
  }
  return hits
}

export function runTools(cmds: string[]): void {
  for (const cmd of cmds) {
    execSync(cmd)
  }
}
