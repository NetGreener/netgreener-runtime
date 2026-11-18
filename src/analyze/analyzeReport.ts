/** Local report + completion event, matching Python's terminal/editor sync path. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export function writeAnalyzeCompletion(
  projectDir: string,
  outputFile: string,
  options: { report?: Record<string, unknown>; error?: string },
): void {
  const root = resolve(projectDir)
  const target = resolve(root, outputFile)
  const eventPath = join(root, '.netgreener', 'last_event.json')
  if (target === eventPath) throw new Error('Analyze report cannot overwrite last_event.json.')
  const timestamp = new Date().toISOString()
  if (options.report) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ ...options.report, project_dir: root, completed_at: timestamp }, null, 2) + '\n', 'utf8')
  }
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return
  const projectId = Number(options.report?.project_id)
  mkdirSync(dirname(eventPath), { recursive: true })
  writeFileSync(eventPath, JSON.stringify({
    type: 'analyze', source: 'node_analyze_local', timestamp,
    status: options.error ? 'failed' : 'complete',
    ...(Number.isSafeInteger(projectId) && projectId > 0 ? { project_id: projectId } : {}),
    ...(options.report ? { report_path: rel.replace(/\\/g, '/') } : {}),
    ...(options.error ? { error: options.error.slice(0, 400) } : {}),
  }, null, 2) + '\n', 'utf8')
}
