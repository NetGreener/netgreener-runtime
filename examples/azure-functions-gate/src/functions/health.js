/**
 * Isolated Azure Functions gate for serverless-thin live run_id evidence.
 * Does not modify existing NetGreener Azure resources.
 */
import { app } from '@azure/functions'
import { NetGreener } from '@netgreener/runtime'

NetGreener.init({ runtime: 'auto' })

app.http('health', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  handler: async (_request, _context) => {
    try {
      return {
        status: 200,
        jsonBody: {
          ok: true,
          gate: 'CHK-R6.serverless-degraded',
          platform: 'azure_functions',
        },
      }
    } finally {
      await NetGreener.flushForInvokeEnd()
    }
  },
})
