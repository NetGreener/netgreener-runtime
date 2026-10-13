/**
 * TypeScript AST detectors for Analyze (Python AST parity path).
 *
 * Returns ``null`` when typescript is unavailable or the file cannot be parsed —
 * callers must fall back to heuristic detectors.
 */

import {
  languageForPath,
  type ResourceCandidateHit,
} from './resourceFindingCandidate.js'
import { tryLoadTypescript, type TypescriptApi } from './loadTypescript.js'

const DETECTOR_VERSION = '0.1.0'
const RETRY_NAME = /\b(?:attempt|retry|tries|retries|maxRetries|max_retries)\b/i
const CAP_HINT_RE =
  /\b(?:pLimit|p-limit|bottleneck|Semaphore|mapLimit|eachLimit|PromisePool|concurrency\s*:)\b/i
const API_ROOTS = new Set([
  'fetch',
  'axios',
  'got',
  'request',
  'openai',
  'anthropic',
  'stripe',
  'cohere',
  'mistral',
  'groq',
  'replicate',
  'huggingface',
  'together',
  'bedrock',
  'sagemaker',
  'twilio',
  'sendgrid',
  'pinecone',
])
const FILE_READ_NAMES = new Set(['readFile', 'readFileSync'])
const COMP_METHODS = new Set(['map', 'flatMap', 'filter', 'forEach'])
const SUBPROCESS_NAMES = new Set([
  'exec',
  'execSync',
  'spawn',
  'spawnSync',
  'fork',
  'execFile',
  'execFileSync',
])
const SLEEP_NAMES = new Set(['setTimeout', 'setInterval'])
/** Nested-loop per-item scans (Python unvectorized_nested_loops twin). */
const LOOKUP_METHODS = new Set(['find', 'includes', 'indexOf', 'lastIndexOf'])
/** Explicit model/runtime loaders (Python model_load_in_loop twin). */
const MODEL_LOAD_NAMES = new Set([
  'loadLayersModel',
  'loadGraphModel',
  'from_pretrained',
  'loadModel',
])
/** Explicit per-item inference (Python inference_inside_loop twin). */
const INFERENCE_NAMES = new Set([
  'predict',
  'predictOnBatch',
  'executeAsync',
  'forward',
])
const HEAVY_MODEL_PACKAGES = new Set([
  '@tensorflow/tfjs',
  '@tensorflow/tfjs-node',
  'onnxruntime-node',
  'onnxruntime-web',
  'onnxruntime',
  '@xenova/transformers',
  '@huggingface/transformers',
])

export type AstHitBundle = {
  retry: ResourceCandidateHit[]
  fileReads: ResourceCandidateHit[]
  overconsumption: ResourceCandidateHit[]
  unbounded: ResourceCandidateHit[]
  polling: ResourceCandidateHit[]
  repeatedWork: ResourceCandidateHit[]
  processChurn: ResourceCandidateHit[]
  fullDataset: ResourceCandidateHit[]
  perItem: ResourceCandidateHit[]
  modelLoad: ResourceCandidateHit[]
  inference: ResourceCandidateHit[]
}

type LoopFrame = { kind: 'retry' | 'plain' }

function emptyBundle(): AstHitBundle {
  return {
    retry: [],
    fileReads: [],
    overconsumption: [],
    unbounded: [],
    polling: [],
    repeatedWork: [],
    processChurn: [],
    fullDataset: [],
    perItem: [],
    modelLoad: [],
    inference: [],
  }
}

function scriptKindForPath(ts: TypescriptApi, relPath: string) {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (lower.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function calleeName(ts: TypescriptApi, expr: import('typescript').Expression): string {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) {
    const right = expr.name.text
    if (ts.isIdentifier(expr.expression)) {
      return `${expr.expression.text}.${right}`
    }
    return right
  }
  return ''
}

/** Leftmost identifier in a property chain (``groq.chat.completions.create`` → ``groq``). */
function rootIdentifier(
  ts: TypescriptApi,
  expr: import('typescript').Expression,
): string {
  let cur: import('typescript').Expression = expr
  while (ts.isPropertyAccessExpression(cur) || ts.isParenthesizedExpression(cur)) {
    cur = ts.isPropertyAccessExpression(cur) ? cur.expression : cur.expression
  }
  return ts.isIdentifier(cur) ? cur.text : ''
}

function leafName(name: string): string {
  return name.includes('.') ? name.split('.').pop() || name : name
}

function looksLikeApiCall(
  ts: TypescriptApi,
  expr: import('typescript').Expression,
): boolean {
  const name = calleeName(ts, expr)
  if (name) {
    const root = name.split('.')[0] || name
    if (API_ROOTS.has(root) || API_ROOTS.has(name)) return true
  }
  const chainRoot = rootIdentifier(ts, expr)
  return Boolean(chainRoot) && API_ROOTS.has(chainRoot)
}

function looksLikeFileRead(name: string): boolean {
  if (!name) return false
  const leaf = leafName(name)
  return FILE_READ_NAMES.has(leaf) || FILE_READ_NAMES.has(name)
}

function looksLikePromiseAll(name: string): boolean {
  return name === 'Promise.all' || name === 'Promise.allSettled' || name.endsWith('.all')
}

function looksLikeSleep(name: string): boolean {
  return SLEEP_NAMES.has(name) || name === 'Bun.sleep' || name.endsWith('.wait')
}

function looksLikeSubprocess(name: string): boolean {
  return SUBPROCESS_NAMES.has(leafName(name))
}

function looksLikeNestedLookup(name: string): boolean {
  return LOOKUP_METHODS.has(leafName(name))
}

function looksLikeModelLoadCall(name: string): boolean {
  if (!name) return false
  const leaf = leafName(name)
  if (MODEL_LOAD_NAMES.has(leaf)) return true
  // onnxruntime: InferenceSession.create
  return name === 'InferenceSession.create' || name.endsWith('.InferenceSession.create')
}

function looksLikeInferenceCall(name: string): boolean {
  if (!name) return false
  const leaf = leafName(name)
  if (INFERENCE_NAMES.has(leaf)) return true
  // ONNX Runtime session.run / ort.run — require session-ish qualifier
  if (leaf === 'run') {
    const lower = name.toLowerCase()
    return (
      lower.includes('session') ||
      lower === 'ort.run' ||
      lower.endsWith('.ort.run')
    )
  }
  return false
}

function inferenceHit(
  path: string,
  line: number,
  language: 'javascript' | 'typescript',
): ResourceCandidateHit {
  return hit(path, line, language, {
    mechanism_id: 'per_item_instead_of_batch',
    primary_domain: 'compute.gpu',
    admission_domain: 'compute.gpu',
    title:
      'Model inference inside loop may run per item instead of a supported batch path',
    detector_id: 'js.ast.inference_inside_loop',
    legacy_issue_type: 'inference_inside_loop',
  })
}

function stringLiteralValue(
  ts: TypescriptApi,
  expr: import('typescript').Expression | undefined,
): string | null {
  if (!expr) return null
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text
  }
  return null
}

function isHeavyModelPackage(spec: string | null): boolean {
  if (!spec) return false
  return HEAVY_MODEL_PACKAGES.has(spec)
}

function modelLoadHit(
  path: string,
  line: number,
  language: 'javascript' | 'typescript',
): ResourceCandidateHit {
  return hit(path, line, language, {
    mechanism_id: 'process_or_runtime_churn',
    primary_domain: 'compute.cpu',
    admission_domain: 'compute.cpu',
    title: 'Model/runtime load inside loop may repeat expensive initialization',
    detector_id: 'js.ast.model_load_in_loop',
    legacy_issue_type: 'model_load_in_loop',
  })
}

function loopHeaderLooksRetry(
  ts: TypescriptApi,
  node: import('typescript').IterationStatement,
  sf: import('typescript').SourceFile,
): boolean {
  if (ts.isForStatement(node)) {
    const parts = [node.initializer, node.condition, node.incrementor]
      .filter(Boolean)
      .map((p) => p!.getText(sf))
      .join(' ')
    return RETRY_NAME.test(parts)
  }
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
    return RETRY_NAME.test(node.expression.getText(sf))
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    return RETRY_NAME.test(node.getText(sf).slice(0, 120))
  }
  return false
}

function parseSource(
  ts: TypescriptApi,
  source: string,
  relPath: string,
): import('typescript').SourceFile | null {
  try {
    return ts.createSourceFile(
      relPath.replace(/\\/g, '/'),
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(ts, relPath),
    )
  } catch {
    return null
  }
}

function containsApiCall(
  ts: TypescriptApi,
  node: import('typescript').Node,
): boolean {
  let found = false
  const walk = (n: import('typescript').Node): void => {
    if (found) return
    if (ts.isCallExpression(n) && looksLikeApiCall(ts, n.expression)) {
      found = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return found
}

function hit(
  path: string,
  line: number,
  language: 'javascript' | 'typescript',
  opts: {
    mechanism_id: string
    primary_domain: ResourceCandidateHit['primary_domain']
    admission_domain: string
    title: string
    detector_id: string
    legacy_issue_type: string
  },
): ResourceCandidateHit {
  return {
    mechanism_id: opts.mechanism_id,
    primary_domain: opts.primary_domain,
    admission_domain: opts.admission_domain,
    title: opts.title,
    rel_path: path,
    start_line: line,
    end_line: line,
    language,
    detector_id: opts.detector_id,
    detector_version: DETECTOR_VERSION,
    legacy_issue_type: opts.legacy_issue_type,
  }
}

function looksLikeJsonParse(name: string): boolean {
  return name === 'JSON.parse'
}

function unwrapExpr(
  ts: TypescriptApi,
  expr: import('typescript').Expression,
): import('typescript').Expression {
  let cur: import('typescript').Expression = expr
  while (true) {
    if (ts.isAwaitExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isAsExpression(cur)) {
      cur = cur.expression
      continue
    }
    break
  }
  return cur
}

function isFileReadCall(
  ts: TypescriptApi,
  expr: import('typescript').Expression,
): boolean {
  const inner = unwrapExpr(ts, expr)
  return ts.isCallExpression(inner) && looksLikeFileRead(calleeName(ts, inner.expression))
}

function fullDatasetHit(
  path: string,
  line: number,
  language: 'javascript' | 'typescript',
): ResourceCandidateHit {
  return hit(path, line, language, {
    mechanism_id: 'memory_retention_or_materialization',
    primary_domain: 'memory.host',
    admission_domain: 'memory.host',
    title: 'Loading and parsing an entire file may retain a full dataset in memory',
    detector_id: 'js.ast.full_dataset_in_memory',
    legacy_issue_type: 'full_dataset_in_memory',
  })
}

function walkHits(
  ts: TypescriptApi,
  sf: import('typescript').SourceFile,
  relPath: string,
): AstHitBundle {
  const language = languageForPath(relPath)
  const path = relPath.replace(/\\/g, '/')
  const out = emptyBundle()
  const stack: LoopFrame[] = []
  let comprehensionDepth = 0
  let promiseAllDepth = 0
  /** Recent ``const x = readFile…`` bindings for JSON.parse(x) pairing. */
  const recentFileReads: Array<{ name: string; line: number }> = []
  const mentionsChildProcess =
    /\b(?:node:)?child_process\b/.test(sf.text) ||
    /\bfrom\s+['"](?:node:)?child_process['"]/.test(sf.text)

  const rememberFileReadBinding = (name: string, line: number): void => {
    recentFileReads.push({ name, line })
    if (recentFileReads.length > 8) recentFileReads.shift()
  }

  const visit = (node: import('typescript').Node): void => {
    const isLoop =
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)

    if (isLoop) {
      const kind: LoopFrame['kind'] = loopHeaderLooksRetry(ts, node, sf)
        ? 'retry'
        : 'plain'
      stack.push({ kind })
      ts.forEachChild(node, visit)
      stack.pop()
      return
    }

    if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.initializer) {
      if (isFileReadCall(ts, node.initializer)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        rememberFileReadBinding(node.name.text, line)
      }
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(ts, node.expression)
      const leaf = leafName(name)
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const inLoop = stack.length > 0
      const inRetry = stack.some((f) => f.kind === 'retry')

      if (looksLikeJsonParse(name) && node.arguments.length > 0) {
        const arg = unwrapExpr(ts, node.arguments[0]!)
        if (ts.isCallExpression(arg) && looksLikeFileRead(calleeName(ts, arg.expression))) {
          out.fullDataset.push(fullDatasetHit(path, line, language))
        } else if (ts.isIdentifier(arg)) {
          const prior = [...recentFileReads].reverse().find((r) => r.name === arg.text)
          if (prior) {
            out.fullDataset.push(fullDatasetHit(path, prior.line, language))
          }
        }
      }

      if (looksLikePromiseAll(name)) {
        const argText = node.arguments.map((a) => a.getText(sf)).join(' ')
        if (
          !CAP_HINT_RE.test(argText) &&
          (/\.map\s*\(/.test(argText) || /\.flatMap\s*\(/.test(argText)) &&
          containsApiCall(ts, node)
        ) {
          out.unbounded.push(
            hit(path, line, language, {
              mechanism_id: 'unbounded_parallelism',
              primary_domain: 'network.io',
              admission_domain: 'network.io',
              title: 'Unbounded Promise.all fan-out may spike concurrent I/O cost',
              detector_id: 'js.ast.unbounded_promise_all',
              legacy_issue_type: 'unbounded_asyncio_gather_with_io',
            }),
          )
        }
        promiseAllDepth += 1
        ts.forEachChild(node, visit)
        promiseAllDepth -= 1
        return
      }

      if (COMP_METHODS.has(leaf)) {
        comprehensionDepth += 1
        ts.forEachChild(node, visit)
        comprehensionDepth -= 1
        return
      }

      if (looksLikeApiCall(ts, node.expression)) {
        if (inRetry) {
          out.retry.push(
            hit(path, line, language, {
              mechanism_id: 'retry_amplification',
              primary_domain: 'external_api',
              admission_domain: 'external_api',
              title: 'Retry loop may amplify billed API attempts',
              detector_id: 'js.ast.retry_loop',
              legacy_issue_type: 'api_call_in_retry_loop',
            }),
          )
        } else if (comprehensionDepth > 0 && promiseAllDepth === 0) {
          out.overconsumption.push(
            hit(path, line, language, {
              mechanism_id: 'external_api_overconsumption',
              primary_domain: 'external_api',
              admission_domain: 'external_api',
              title: 'API call inside map/filter may multiply billed attempts',
              detector_id: 'js.ast.api_in_comprehension',
              legacy_issue_type: 'api_call_in_comprehension',
            }),
          )
        } else if (inLoop && !inRetry) {
          out.overconsumption.push(
            hit(path, line, language, {
              mechanism_id: 'external_api_overconsumption',
              primary_domain: 'external_api',
              admission_domain: 'external_api',
              title: 'API call inside loop may multiply billed attempts',
              detector_id: 'js.ast.api_in_loop',
              legacy_issue_type: 'network_call_in_loop',
            }),
          )
        }
      }

      if (inLoop && looksLikeFileRead(name)) {
        out.fileReads.push(
          hit(path, line, language, {
            mechanism_id: 'repeated_work',
            primary_domain: 'storage.io',
            admission_domain: 'storage.io',
            title: 'File read inside loop may repeat avoidable I/O work',
            detector_id: 'js.ast.repeated_file_reads',
            legacy_issue_type: 'repeated_file_reads',
          }),
        )
      }

      if (inLoop && looksLikeSleep(name)) {
        out.polling.push(
          hit(path, line, language, {
            mechanism_id: 'polling_or_idle_work',
            primary_domain: 'compute.cpu',
            admission_domain: 'compute.cpu',
            title: 'Sleep/delay inside loop may burn CPU with idle wakeups',
            detector_id: 'js.ast.sleep_polling',
            legacy_issue_type: 'sleep_polling',
          }),
        )
      }

      if (inLoop && looksLikeSubprocess(name)) {
        const strong =
          /(?:Sync|fork)$/.test(leaf) || mentionsChildProcess || leaf === 'fork'
        if (strong) {
          out.processChurn.push(
            hit(path, line, language, {
              mechanism_id: 'process_or_runtime_churn',
              primary_domain: 'compute.cpu',
              admission_domain: 'compute.cpu',
              title: 'Subprocess spawn/exec inside loop may repeat process churn',
              detector_id: 'js.ast.subprocess_in_loop',
              legacy_issue_type: 'subprocess_in_loop',
            }),
          )
        }
      }

      if (stack.length >= 2 && looksLikeNestedLookup(name)) {
        out.perItem.push(
          hit(path, line, language, {
            mechanism_id: 'per_item_instead_of_batch',
            primary_domain: 'compute.cpu',
            admission_domain: 'compute.cpu',
            title:
              'Nested-loop array lookup may scan per item instead of a batched/indexed path',
            detector_id: 'js.ast.unvectorized_nested_loops',
            legacy_issue_type: 'unvectorized_nested_loops',
          }),
        )
      }

      if (inLoop && looksLikeModelLoadCall(name)) {
        out.modelLoad.push(modelLoadHit(path, line, language))
      }

      if (inLoop && looksLikeInferenceCall(name)) {
        out.inference.push(inferenceHit(path, line, language))
      }

      if (inLoop && leaf === 'require' && node.arguments.length > 0) {
        const spec = stringLiteralValue(ts, node.arguments[0])
        if (isHeavyModelPackage(spec)) {
          out.modelLoad.push(modelLoadHit(path, line, language))
        }
      }

      if (
        inLoop &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 0
      ) {
        const spec = stringLiteralValue(ts, node.arguments[0])
        if (isHeavyModelPackage(spec)) {
          out.modelLoad.push(modelLoadHit(path, line, language))
        }
      }
    }

    if (ts.isNewExpression(node) && stack.length > 0) {
      const ctor = node.expression.getText(sf)
      if (ctor === 'RegExp') {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        out.repeatedWork.push(
          hit(path, line, language, {
            mechanism_id: 'repeated_work',
            primary_domain: 'compute.cpu',
            admission_domain: 'compute.cpu',
            title: 'RegExp compiled inside loop may repeat avoidable CPU work',
            detector_id: 'js.ast.regex_compile_in_loop',
            legacy_issue_type: 'regex_compile_in_loop',
          }),
        )
      }
    }

    if (ts.isBinaryExpression(node) && stack.length > 0) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
        const right = node.right
        const isStringy =
          ts.isStringLiteral(right) ||
          ts.isNoSubstitutionTemplateLiteral(right) ||
          ts.isTemplateExpression(right) ||
          (ts.isCallExpression(right) && calleeName(ts, right.expression) === 'String')
        if (isStringy) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          out.repeatedWork.push(
            hit(path, line, language, {
              mechanism_id: 'repeated_work',
              primary_domain: 'compute.cpu',
              admission_domain: 'compute.cpu',
              title: 'String concatenation inside loop may repeat avoidable CPU work',
              detector_id: 'js.ast.string_concat_in_loop',
              legacy_issue_type: 'string_concat_in_loop',
            }),
          )
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)
  return out
}

/** Full AST hit bundle, or ``null`` to signal heuristic fallback. */
export function detectAllHitsAst(
  source: string,
  relPath: string,
): AstHitBundle | null {
  const ts = tryLoadTypescript()
  if (!ts) return null
  const sf = parseSource(ts, source, relPath)
  if (!sf) return null
  return walkHits(ts, sf, relPath)
}

/** @deprecated Prefer detectAllHitsAst — kept for callers. */
export function detectHotPathHitsAst(
  source: string,
  relPath: string,
): { retry: ResourceCandidateHit[]; fileReads: ResourceCandidateHit[] } | null {
  const all = detectAllHitsAst(source, relPath)
  if (!all) return null
  return { retry: all.retry, fileReads: all.fileReads }
}

export function detectRetryAmplificationHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.retry : null
}

export function detectRepeatedFileReadHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.fileReads : null
}

export function detectApiOverconsumptionHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.overconsumption : null
}

export function detectUnboundedParallelismHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.unbounded : null
}

export function detectPollingIdleHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.polling : null
}

export function detectRepeatedWorkHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.repeatedWork : null
}

export function detectProcessChurnHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.processChurn : null
}

export function detectFullDatasetInMemoryHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.fullDataset : null
}

export function detectPerItemInsteadOfBatchHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.perItem : null
}

export function detectModelLoadInLoopHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.modelLoad : null
}

export function detectInferenceInsideLoopHitsAst(
  source: string,
  relPath: string,
): ResourceCandidateHit[] | null {
  const all = detectAllHitsAst(source, relPath)
  return all ? all.inference : null
}
