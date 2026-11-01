/**
 * Webpack / Turbopack loader. Wraps Next.js route, page, and server-action
 * exports. No-ops for every other module.
 */
const { transformNextEntrySource } = require('../dist/nextEntryTransform.js')

module.exports = function netgreenerNextEntryLoader(source) {
  const filename = (this && this.resourcePath) || ''
  try {
    return transformNextEntrySource(String(source), filename)
  } catch {
    return source
  }
}
