#!/usr/bin/env node
/**
 * NetGreener Node CLI entry (scaffold).
 *
 *   netgreener analyze <dir>     — resource Analyze candidates (implemented)
 *   netgreener run …             — stub (not implemented; no upload)
 *   netgreener optimize …        — stub (not implemented; no upload)
 *
 * Does not change RunSession / metering pipelines. Upload remains off.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runAnalyzeCli } from '../analyze/cli.js'
import {
  CLI_VERSION,
  formatAnalyzeHelp,
  formatRootHelp,
  formatStubHelp,
} from './helpText.js'

function stubCommand(name: 'run' | 'optimize'): number {
  process.stderr.write(formatStubHelp(name))
  return 2
}

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
  if (key === 'run' || key === 'optimize') {
    process.stderr.write(formatStubHelp(key))
    return 0
  }
  process.stderr.write(`Unknown help topic: ${topic}\n\n`)
  process.stdout.write(formatRootHelp())
  return 2
}

/** Dispatch top-level ``netgreener`` commands. */
export function runNetgreenerCli(argv: string[]): number {
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
  if (cmd === 'run' || cmd === 'optimize') {
    return stubCommand(cmd)
  }
  process.stderr.write(`Unknown command: ${cmd}\n\n`)
  process.stdout.write(formatRootHelp())
  return 2
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url

if (invokedDirectly) {
  process.exitCode = runNetgreenerCli(process.argv.slice(2))
}
