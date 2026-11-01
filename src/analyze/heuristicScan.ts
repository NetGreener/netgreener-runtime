/**
 * Shared heuristic helpers for MP4 JS/TS resource detectors.
 * Not a TypeScript AST — line + brace-depth only.
 */

/** HTTP / paid API call sites commonly metered as external_api. */
export const API_CALL_RE =
  /\b(?:fetch|axios(?:\.(?:get|post|put|delete|patch|request|head|options))?|got|request|openai|anthropic|stripe|cohere|mistral|groq|replicate|huggingface|together|bedrock|sagemaker|twilio|sendgrid|pinecone|@aws-sdk)\b|\bhttps?\.(?:get|request)\s*\(/i

/** Retry-ish for/while headers (Python attempt|retry|tries twin). */
export const RETRY_HEADER_RE =
  /^\s*(?:for|while)\s*\([^;)]*(?:\battempt\b|\bretry\b|\btries\b|\bretries\b|\bmaxRetries\b|\bmax_retries\b)[^)]*\)/i

/** Plain for/while loop header (any). */
export const LOOP_HEADER_RE = /^\s*(?:for|while)\s*\(/i

/** Array iteration that behaves like a Python comprehension for fan-out cost. */
export const COMPREHENSION_RE =
  /\.(?:map|flatMap|filter|forEach)\s*\(/i

/** Unbounded concurrent fan-out (JS twin of asyncio.gather). */
export const PROMISE_ALL_RE = /\bPromise\.all(?:Settled)?\s*\(/i

/** Sleep / delay polling (Python sleep_polling twin). */
export const SLEEP_POLL_RE =
  /\b(?:setTimeout|setInterval|Atomics\.wait)\s*\(|\b(?:Bun\.sleep|await\s+(?:delay|sleep|wait)\s*\()/i

/** RegExp compiled inside a hot path (Python regex_compile_in_loop twin). */
export const REGEX_COMPILE_RE = /\bnew\s+RegExp\s*\(/

/** String concat growth in a loop (Python string_concat_in_loop twin). */
export const STRING_CONCAT_RE = /\w+\s*\+=\s*(?:['"`]|String\s*\()/

/** child_process style spawn/exec (Python subprocess_in_loop twin). */
export const SUBPROCESS_RE =
  /\b(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|fork)\s*\(/

/** Whole-file reads (fs) — loop reuse → repeated_file_reads. */
export const FILE_READ_RE =
  /\b(?:readFileSync|readFile)\s*\(|\bfs\.promises\.readFile\s*\(|\bpromises\.readFile\s*\(/

/**
 * Per-item array lookup (JS twin of Python ``unvectorized_nested_loops``).
 * Meaningful when nested loop depth ≥ 2.
 */
export const NESTED_LOOKUP_RE =
  /\.\s*(?:find|includes|indexOf|lastIndexOf)\s*\(/

/**
 * Model / runtime load inside a loop (Python ``model_load_in_loop`` twin).
 * Prefer explicit loader APIs; avoid bare ``pipeline(`` (Node streams).
 */
export const MODEL_LOAD_RE =
  /\b(?:loadLayersModel|loadGraphModel|from_pretrained|loadModel)\s*\(|\bInferenceSession\.create\s*\(|\b(?:tf|ort)\.(?:loadLayersModel|loadGraphModel|InferenceSession)\b|\brequire\(\s*['"](?:@tensorflow\/(?:tfjs(?:-node)?)|onnxruntime(?:-node|-web)?|@xenova\/transformers|@huggingface\/transformers)['"]\s*\)|\bimport\(\s*['"](?:@tensorflow\/(?:tfjs(?:-node)?)|onnxruntime(?:-node|-web)?|@xenova\/transformers|@huggingface\/transformers)['"]\s*\)/

/**
 * Per-item model inference inside a loop (Python ``inference_inside_loop`` twin).
 * Prefer explicit predict/execute/session.run; avoid bare ``.run(`` / Node streams.
 */
export const INFERENCE_RE =
  /\.\s*(?:predict(?:OnBatch)?|executeAsync|forward)\s*\(|\b(?:session|ortSession|inferenceSession|ort)\.run\s*\(/i
export function stripLineComment(line: string): string {
  const idx = line.indexOf('//')
  return idx >= 0 ? line.slice(0, idx) : line
}

export function hasApiCall(line: string): boolean {
  return API_CALL_RE.test(line)
}

/**
 * Walk lines updating brace depth; returns depth after processing ``line``.
 * Also reports whether an opening `{` occurred on this line.
 */
export function advanceBraceDepth(
  line: string,
  braceDepth: number,
): { braceDepth: number; openedBrace: boolean } {
  let depth = braceDepth
  let openedBrace = false
  for (let c = 0; c < line.length; c += 1) {
    const ch = line[c]
    if (ch === '{') {
      depth += 1
      openedBrace = true
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1)
    }
  }
  return { braceDepth: depth, openedBrace }
}

export type LoopBodyVisitor = (input: {
  line: string
  lineNo: number
  inLoop: boolean
  /** Nested for/while depth (same-line `{` headers only, matching prior heuristic). */
  loopDepth: number
}) => void

/**
 * Invoke ``visit`` for each line; ``inLoop`` is true inside for/while bodies.
 * Tracks nested loop depth when headers open a brace on the same line.
 */
export function forEachSourceLine(
  source: string,
  visit: LoopBodyVisitor,
): void {
  const lines = source.split(/\r?\n/)
  let braceDepth = 0
  /** Exit thresholds: leave loop when braceDepth ≤ entry. */
  const loopStack: number[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripLineComment(lines[i] ?? '')
    const lineNo = i + 1
    const isLoopHeader = LOOP_HEADER_RE.test(line)
    const before = braceDepth
    const { braceDepth: next, openedBrace } = advanceBraceDepth(line, braceDepth)

    if (isLoopHeader && openedBrace) {
      loopStack.push(before)
    }
    braceDepth = next
    while (loopStack.length > 0 && braceDepth <= loopStack[loopStack.length - 1]!) {
      loopStack.pop()
    }

    const loopDepth = loopStack.length
    visit({ line, lineNo, inLoop: loopDepth > 0, loopDepth })
  }
}
