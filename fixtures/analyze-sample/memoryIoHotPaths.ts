import { readFileSync } from 'node:fs'

/**
 * Fixture: repeated file reads in a loop + full JSON dataset materialization.
 */
export function loadManyConfigs(paths: string[]): string[] {
  const out: string[] = []
  for (const p of paths) {
    out.push(readFileSync(p, 'utf8'))
  }
  return out
}

export function loadDataset(path: string): unknown {
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw)
}

export function loadDatasetOneLiner(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}
