/**
 * Single NetGreener init surface — one product, lifecycle-aware delivery.
 *
 * Prefer ``import '@netgreener/runtime/auto'`` or ``NetGreener.init()``.
 * Does not create a separate Vercel/Lambda product.
 */

import {
  getRuntime,
  type NetGreenerRuntime,
  type NetGreenerRuntimeOptions,
} from './runtime.js'
import type { UploadResult } from './uploader.js'
import type { RuntimeModePreference } from './lifecycle.js'

export type NetGreenerInitOptions = NetGreenerRuntimeOptions & {
  /**
   * Lifecycle preference. Default ``auto`` (serverless signals → ephemeral).
   * Most apps never need to set this.
   */
  runtime?: RuntimeModePreference
}

export const NetGreener = {
  /**
   * Initialize (or return) the process singleton and start metering.
   * Safe to call multiple times — subsequent calls reuse the singleton.
   */
  init(opts: NetGreenerInitOptions = {}): NetGreenerRuntime {
    const { runtime: mode, ...rest } = opts
    const instance = getRuntime({
      ...rest,
      ...(mode ? { runtimeMode: mode } : {}),
    })
    instance.start()
    return instance
  },

  /**
   * Flush at a serverless invoke boundary (Lambda handler finally, etc.).
   * Fail-open: errors are returned, never thrown to the caller by design
   * of ``flush`` (catch returns UploadResult).
   */
  async flushForInvokeEnd(): Promise<UploadResult | null> {
    return getRuntime().flushForInvokeEnd()
  },
}

export default NetGreener
