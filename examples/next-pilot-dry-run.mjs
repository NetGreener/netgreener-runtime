/**
 * Wave 3 Next.js adapter dry-run (no Next server required).
 */
import {
  getNextRuntime,
  loadRuntimeConfig,
  withNetGreenerRoute,
  _resetRuntimeForTests,
} from '../dist/index.js'

_resetRuntimeForTests()
const config = loadRuntimeConfig({
  NETGREENER_SERVICE_RUNTIME: '1',
  NETGREENER_TOKEN: 'ngs_local_dry_run',
  NETGREENER_PROJECT_ID: '1',
  NETGREENER_RUNTIME_DRY_RUN: '1',
})

const POST = withNetGreenerRoute(
  async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  { config, routeTemplate: '/api/pilot' },
)

await POST({ method: 'POST', url: 'https://local/api/pilot', headers: {} })
const result = await getNextRuntime().flush('manual')
if (!result?.ok || !result.dryRun) {
  console.error(result)
  process.exit(1)
}
console.log('next pilot dry-run ok')
console.log(JSON.stringify(result.body?.session_metadata?.service_runtime_v0 || {}, null, 2))
_resetRuntimeForTests()
