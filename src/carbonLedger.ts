/**
 * Unified local-compute carbon ledger (Python ``carbon_ledger.py`` twin).
 *
 * Single formula for energy (kWh) → CO₂e with factor provenance.
 * Vendor/catalog carbon stays separate.
 */

export const DEFAULT_GRID_KG_CO2E_PER_KWH = 0.276
export const FACTOR_VERSION = 'v0'
export const FACTOR_UNIT = 'kg_co2e_per_kwh'
export const DEFAULT_FACTOR_SOURCE = 'netgreener_default_grid'

export type CarbonFactor = {
  value: number
  unit: string
  source: string
  version: string
  location: string | null
}

function envFloat(name: string): number | null {
  const raw = process.env[name]
  if (raw == null || !String(raw).trim()) return null
  const n = Number(String(raw).trim())
  return Number.isFinite(n) ? n : null
}

/** Resolve active grid intensity (env ``NETGREENER_CARBON_KG_PER_KWH`` overrides). */
export function defaultGridFactor(): CarbonFactor {
  const override = envFloat('NETGREENER_CARBON_KG_PER_KWH')
  if (override != null && override >= 0) {
    return {
      value: override,
      unit: FACTOR_UNIT,
      source: 'env:NETGREENER_CARBON_KG_PER_KWH',
      version: FACTOR_VERSION,
      location: null,
    }
  }
  return {
    value: DEFAULT_GRID_KG_CO2E_PER_KWH,
    unit: FACTOR_UNIT,
    source: DEFAULT_FACTOR_SOURCE,
    version: FACTOR_VERSION,
    location: null,
  }
}

export function energyKwhToCarbonKg(
  energyKwh: number | null | undefined,
  factor?: CarbonFactor | null,
): { carbonKg: number; factor: CarbonFactor } {
  const fac = factor ?? defaultGridFactor()
  const energy = Number(energyKwh ?? 0)
  if (!Number.isFinite(energy) || energy <= 0) {
    return { carbonKg: 0, factor: fac }
  }
  return { carbonKg: energy * fac.value, factor: fac }
}

export function energyKwhToCarbonG(
  energyKwh: number | null | undefined,
  factor?: CarbonFactor | null,
): { carbonG: number; factor: CarbonFactor } {
  const { carbonKg, factor: fac } = energyKwhToCarbonKg(energyKwh, factor)
  return { carbonG: carbonKg * 1000, factor: fac }
}

export function carbonFactorDict(factor?: CarbonFactor | null): CarbonFactor {
  return factor ?? defaultGridFactor()
}
