#!/usr/bin/env node
/**
 * NetGreener Node CLI entry.
 *
 *   netgreener analyze <dir>     — resource Analyze candidates (local)
 *   netgreener run <script> …    — execute script with process metering
 *   netgreener optimize <dir>    — local OptimizerProvider proposals (no apply)
 *
 * Does not flip EXPORT_MODE. Optimize never mutates the tree (see OPTIMIZE_STUB.md).
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runAnalyzeCli } from '../analyze/cli.js'
import { formatOptimizeHelp, runOptimizeCli } from '../optimize/cli.js'
import {
  CLI_VERSION,
  formatAnalyzeHelp,
  formatRootHelp,
} from './helpText.js'
import { formatRunHelp, runRunCli } from './runCli.js'

function printHelpFor(topic: string | undefined): number {
  const key = (topic || '').trim().toLowerCase()
  if (!key || key === 'help') {
    process.stdout.write(formatRootHelp())
    return 0
  }
  if (key === 'analyze') {
    process.stdout.write(formatAnalyzeHelp())
    return 0
  }
  if (key === 'run') {
    process.stdout.write(formatRunHelp())
    return 0
  }
  if (key === 'optimize') {
    process.stdout.write(formatOptimizeHelp())
    return 0
  }
  process.stderr.write(`Unknown help topic: ${topic}\n\n`)
  process.stdout.write(formatRootHelp())
  return 2
}

/** Dispatch top-level ``netgreener`` commands. Sync entry; ``run`` may return a Promise. */
export function runNetgreenerCli(argv: string[]): number | Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(formatRootHelp())
    return 0
  }
  if (cmd === '-V' || cmd === '--version' || cmd === 'version') {
    process.stdout.write(`${CLI_VERSION}\n`)
    return 0
  }
  if (cmd === 'help') {
    return printHelpFor(rest[0])
  }
  if (cmd === 'analyze') {
    return runAnalyzeCli(rest)
  }
  if (cmd === 'run') {
    return runRunCli(rest)
  }
  if (cmd === 'optimize') {
    return runOptimizeCli(rest)
  }
  process.stderr.write(`Unknown command: ${cmd}\n\n`)
  process.stdout.write(formatRootHelp())
  return 2
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url

if (invokedDirectly) {
  Promise.resolve(runNetgreenerCli(process.argv.slice(2))).then((code) => {
    process.exitCode = code
  })
}
