import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  DEFAULT_FACTOR_SOURCE,
  DEFAULT_GRID_KG_CO2E_PER_KWH,
  defaultGridFactor,
  energyKwhToCarbonG,
  energyKwhToCarbonKg,
} from '../carbonLedger.js'

describe('carbonLedger (Python twin)', () => {
  const prev = process.env.NETGREENER_CARBON_KG_PER_KWH

  afterEach(() => {
    if (prev === undefined) delete process.env.NETGREENER_CARBON_KG_PER_KWH
    else process.env.NETGREENER_CARBON_KG_PER_KWH = prev
  })

  it('defaults to 0.276 kg/kWh with netgreener_default_grid provenance', () => {
    delete process.env.NETGREENER_CARBON_KG_PER_KWH
    const fac = defaultGridFactor()
    assert.equal(fac.value, DEFAULT_GRID_KG_CO2E_PER_KWH)
    assert.equal(fac.source, DEFAULT_FACTOR_SOURCE)
    assert.equal(fac.unit, 'kg_co2e_per_kwh')
  })

  it('honors NETGREENER_CARBON_KG_PER_KWH override', () => {
    process.env.NETGREENER_CARBON_KG_PER_KWH = '0.5'
    const fac = defaultGridFactor()
    assert.equal(fac.value, 0.5)
    assert.equal(fac.source, 'env:NETGREENER_CARBON_KG_PER_KWH')
  })

  it('converts kWh to carbon g using the ledger factor', () => {
    delete process.env.NETGREENER_CARBON_KG_PER_KWH
    const { carbonKg } = energyKwhToCarbonKg(1)
    assert.equal(carbonKg, 0.276)
    const { carbonG } = energyKwhToCarbonG(1)
    assert.equal(carbonG, 276)
  })
})
