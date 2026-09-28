import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertProductionScopeIsExplicit,
  claimedDeployModes,
  NODE_DEPLOYMENT_MATRIX,
} from '../n4/deploymentMatrix.js'

test('production scope claims exactly long_running_process', () => {
  assert.equal(assertProductionScopeIsExplicit(), true)
  const claimed = claimedDeployModes()
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].check_id, 'CHK-R6.vm-process')
})

test('container and kubernetes remain not_claimed', () => {
  const byId = Object.fromEntries(
    NODE_DEPLOYMENT_MATRIX.map((e) => [e.check_id, e.status]),
  )
  assert.equal(byId['CHK-R6.container'], 'not_claimed')
  assert.equal(byId['CHK-R6.kubernetes'], 'not_claimed')
  assert.equal(byId['CHK-R6.serverless-degraded'], 'documented_degraded')
})
