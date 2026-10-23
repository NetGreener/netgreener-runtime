/**
 * Public Next.js config wrapper. Registers the entry loader on the Node
 * server build (webpack and Turbopack). Does not change export mode.
 */

import { fileURLToPath } from 'node:url'

export type NextConfigLike = {
  webpack?: (config: WebpackConfigLike, options: WebpackOptionsLike) => WebpackConfigLike
  turbopack?: {
    rules?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

type WebpackConfigLike = {
  module?: { rules?: unknown[] }
  [key: string]: unknown
}

type WebpackOptionsLike = {
  isServer?: boolean
  nextRuntime?: string
}

const ENTRY_GLOBS = [
  '**/route.ts',
  '**/route.tsx',
  '**/route.js',
  '**/route.jsx',
  '**/page.ts',
  '**/page.tsx',
  '**/page.js',
  '**/page.jsx',
  '**/*action.ts',
  '**/*action.tsx',
  '**/*actions.ts',
  '**/*actions.tsx',
]

function loaderFile(): string {
  return fileURLToPath(new URL('../loaders/next-entry-loader.cjs', import.meta.url))
}

function turbopackRule(loader: string): Record<string, unknown> {
  return {
    loaders: [loader],
    condition: {
      all: ['node', { not: 'browser' }, { not: 'edge-light' }],
    },
  }
}

/**
 * Wrap an existing Next config so Node route, page, and server-action modules
 * are observed. Compose outside other config wrappers:
 *
 * ```ts
 * export default withNextIntl(withNetGreener(nextConfig))
 * ```
 *
 * Also call ``registerNetGreenerNext`` from ``instrumentation.ts``.
 */
export function withNetGreener<T extends NextConfigLike>(nextConfig: T = {} as T): T {
  const loader = loaderFile()
  const prevTurbo = nextConfig.turbopack ?? {}
  const prevRules = (prevTurbo.rules ?? {}) as Record<string, unknown>
  const rules: Record<string, unknown> = { ...prevRules }
  for (const glob of ENTRY_GLOBS) {
    if (rules[glob] == null) rules[glob] = turbopackRule(loader)
  }
  const prevWebpack = nextConfig.webpack
  return {
    ...nextConfig,
    turbopack: {
      ...prevTurbo,
      rules,
    },
    webpack(config: WebpackConfigLike, options: WebpackOptionsLike) {
      const serverNode = options.isServer === true && options.nextRuntime !== 'edge'
      if (serverNode) {
        config.module = config.module ?? {}
        config.module.rules = config.module.rules ?? []
        config.module.rules.push({
          test: /([\\/](route|page)\.(tsx?|jsx?)$)|([\\/][^\\/]*actions?\.(tsx?|jsx?)$)/,
          enforce: 'pre',
          use: [loader],
        })
      }
      if (typeof prevWebpack === 'function') return prevWebpack(config, options)
      return config
    },
  }
}
