/**
 * Side-effect entry: ``import '@netgreener/runtime/auto'``.
 * Starts NetGreener with runtime mode ``auto`` (persistent vs ephemeral).
 */
import { NetGreener } from './init.js'
import { installMcpClientInstrumentation } from './mcpToolMeter.js'

const runtime = NetGreener.init({ runtime: 'auto' })
// Complete optional ESM/CJS patching before dependent application code starts.
if (runtime.enabled) await installMcpClientInstrumentation()

export { NetGreener }
export default NetGreener
