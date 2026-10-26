/**
 * Side-effect entry: ``import '@netgreener/runtime/auto'``.
 * Starts NetGreener with runtime mode ``auto`` (persistent vs ephemeral).
 */
import { NetGreener } from './init.js'

NetGreener.init({ runtime: 'auto' })

export { NetGreener }
export default NetGreener
