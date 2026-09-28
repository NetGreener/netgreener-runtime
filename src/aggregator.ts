import type { ServiceRuntimeTenantBucket, ServiceRuntimeUnit, ServiceRuntimeV0, TenantId } from './types.js'

type UnitAgg = {
  serviceUnit: string
  unitType: string
  calls: number
  errors: number
  durationMsTotal: number
  durationMsMax: number
  /** Sum of measured process CPU ms (when samples provided cpuTimeMs). */
  cpuMsTotal: number
  /** True when at least one sample carried measured process CPU. */
  cpuMsMeasured: boolean
  /** Peak RSS (KiB) across samples that provided peakRssKb. */
  peakRssKbMax: number
}

const MAX_UNITS = 500
const MAX_SERVICE_UNIT_LEN = 256

function normalizeServiceUnit(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'UNKNOWN'
  if (trimmed.length <= MAX_SERVICE_UNIT_LEN) return trimmed
  return `${trimmed.slice(0, MAX_SERVICE_UNIT_LEN - 1)}…`
}

/** Contain NaN / ±Infinity / negatives so session_metadata numerics stay finite. */
function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export class ServiceRuntimeAggregator {
  private units = new Map<string, UnitAgg>()
  private byTenant = new Map<TenantId, Map<string, UnitAgg>>()
  private windowStartedAt = Date.now()

  resetWindow(): void {
    this.units.clear()
    this.byTenant.clear()
    this.windowStartedAt = Date.now()
  }

  windowStartedMs(): number {
    return this.windowStartedAt
  }

  record(sample: {
    serviceUnit: string
    unitType?: string
    durationMs: number
    error?: boolean
    tenantId?: TenantId | null
    /** Measured process CPU ms for this sample (CAP-R4); omit → duration proxy. */
    cpuTimeMs?: number
    /** Measured RSS KiB at sample end. */
    peakRssKb?: number
  }): void {
    const key = normalizeServiceUnit(sample.serviceUnit)
    this.recordIntoMap(this.units, key, sample)
    if (sample.tenantId) {
      let tenantUnits = this.byTenant.get(sample.tenantId)
      if (!tenantUnits) {
        tenantUnits = new Map()
        this.byTenant.set(sample.tenantId, tenantUnits)
      }
      this.recordIntoMap(tenantUnits, key, sample)
    }
  }

  private recordIntoMap(
    target: Map<string, UnitAgg>,
    key: string,
    sample: {
      serviceUnit: string
      unitType?: string
      durationMs: number
      error?: boolean
      cpuTimeMs?: number
      peakRssKb?: number
    },
  ): void {
    let unit = target.get(key)
    if (!unit) {
      const needsOverflow =
        key !== '__other__' && target.size >= MAX_UNITS - 1 && !target.has(key)
      if (needsOverflow) {
        key = '__other__'
        unit = target.get(key)
      }
      if (!unit) {
        unit = {
          serviceUnit: key,
          unitType: sample.unitType || 'http_route',
          calls: 0,
          errors: 0,
          durationMsTotal: 0,
          durationMsMax: 0,
          cpuMsTotal: 0,
          cpuMsMeasured: false,
          peakRssKbMax: 0,
        }
        target.set(key, unit)
      }
    }
    unit.calls += 1
    if (sample.error) unit.errors += 1
    // Math.max(0, NaN) === NaN — must reject non-finite before accumulate.
    const ms = nonNegativeFinite(sample.durationMs)
    unit.durationMsTotal += ms
    unit.durationMsMax = Math.max(unit.durationMsMax, ms)
    if (sample.cpuTimeMs !== undefined) {
      unit.cpuMsTotal += nonNegativeFinite(sample.cpuTimeMs)
      unit.cpuMsMeasured = true
    }
    if (sample.peakRssKb !== undefined) {
      const rss = nonNegativeFinite(sample.peakRssKb)
      if (rss > 0) unit.peakRssKbMax = Math.max(unit.peakRssKbMax, rss)
    }
  }

  private buildUnitsList(
    source: Map<string, UnitAgg>,
    windowEnergyKwh: number,
    equalShare: boolean,
    totalDuration: number,
  ): ServiceRuntimeUnit[] {
    const list = [...source.values()].filter((u) => u.calls > 0)
    if (!list.length) return []
    const energyBudget = nonNegativeFinite(windowEnergyKwh)
    const sorted = list.sort((a, b) => b.durationMsTotal - a.durationMsTotal)
    const units: ServiceRuntimeUnit[] = sorted.map((u) => {
      const share = equalShare ? 1 / list.length : u.durationMsTotal / totalDuration
      const energy = energyBudget * share
      const avg = u.calls ? u.durationMsTotal / u.calls : 0
      const cpuSeconds = u.cpuMsMeasured
        ? u.cpuMsTotal / 1000
        : u.durationMsTotal / 1000
      const unit: ServiceRuntimeUnit = {
        service_unit: u.serviceUnit,
        unit_type: u.unitType,
        calls: u.calls,
        errors: u.errors,
        cpu_seconds_total: Math.round(cpuSeconds * 10000) / 10000,
        energy_kwh: energy,
        carbon_g: energy * 0.4 * 1000,
        duration_ms: {
          avg: Math.round(avg * 100) / 100,
          max: Math.round(u.durationMsMax * 100) / 100,
        },
      }
      if (u.peakRssKbMax > 0) {
        unit.peak_rss_kb_max = Math.round(u.peakRssKbMax)
      }
      return unit
    })
    const allocatedRaw = units.reduce((s, u) => s + u.energy_kwh, 0)
    const drift = energyBudget - allocatedRaw
    if (units.length && Math.abs(drift) > 0) {
      units[0].energy_kwh += drift
      units[0].carbon_g = units[0].energy_kwh * 0.4 * 1000
    }
    for (const u of units) {
      u.energy_kwh = Math.round(u.energy_kwh * 1e12) / 1e12
      u.carbon_g = Math.round(u.carbon_g * 1e6) / 1e6
    }
    return units
  }

  hasData(): boolean {
    for (const u of this.units.values()) {
      if (u.calls > 0) return true
    }
    return false
  }

  totalDurationMs(): number {
    let total = 0
    for (const u of this.units.values()) {
      if (u.calls > 0) total += u.durationMsTotal
    }
    return total
  }

  /** Sum of measured process CPU ms in this window (0 if none measured). */
  totalMeasuredCpuMs(): number {
    let total = 0
    for (const u of this.units.values()) {
      if (u.calls > 0 && u.cpuMsMeasured) total += u.cpuMsTotal
    }
    return total
  }

  /** True when any unit recorded measured process CPU (not duration proxy). */
  hasMeasuredCpu(): boolean {
    for (const u of this.units.values()) {
      if (u.calls > 0 && u.cpuMsMeasured) return true
    }
    return false
  }

  /** True when any unit recorded peak RSS. */
  hasMeasuredRss(): boolean {
    for (const u of this.units.values()) {
      if (u.calls > 0 && u.peakRssKbMax > 0) return true
    }
    return false
  }

  /**
   * Build service_runtime_v0. N1 uses duration-share energy attribution (trend).
   * CPU-accurate share can land later without changing the schema.
   */
  buildV0(opts: {
    collector: string
    framework: string
    windowEnergyKwh: number
    windowSeconds: number
  }): ServiceRuntimeV0 | null {
    const list = [...this.units.values()].filter((u) => u.calls > 0)
    if (!list.length) return null
    const windowEnergyKwh = nonNegativeFinite(opts.windowEnergyKwh)
    const windowSeconds = nonNegativeFinite(opts.windowSeconds)
    const totalDuration = list.reduce((s, u) => s + u.durationMsTotal, 0)
    const equalShare = totalDuration <= 0
    const units = this.buildUnitsList(this.units, windowEnergyKwh, equalShare, totalDuration)
    const byTenant: Record<TenantId, ServiceRuntimeTenantBucket> = {}
    const totalBusy = list.reduce((s, u) => s + u.durationMsTotal, 0)
    for (const [tenantId, tenantMap] of this.byTenant.entries()) {
      const tenantList = [...tenantMap.values()].filter((u) => u.calls > 0)
      if (!tenantList.length) continue
      const tenantBusy = tenantList.reduce((s, u) => s + u.durationMsTotal, 0)
      const tenantEnergy =
        totalBusy > 0
          ? windowEnergyKwh * (tenantBusy / totalBusy)
          : windowEnergyKwh / Math.max(1, this.byTenant.size)
      const tenantDuration = tenantList.reduce((s, u) => s + u.durationMsTotal, 0)
      const tenantEqual = tenantDuration <= 0
      const tenantUnits = this.buildUnitsList(
        tenantMap,
        tenantEnergy,
        tenantEqual,
        tenantDuration,
      )
      if (!tenantUnits.length) continue
      byTenant[tenantId] = {
        tenant_id: tenantId,
        calls: tenantUnits.reduce((s, u) => s + u.calls, 0),
        errors: tenantUnits.reduce((s, u) => s + u.errors, 0),
        units: tenantUnits,
      }
    }
    const allocated = units.reduce((s, u) => s + u.energy_kwh, 0)
    const residual = windowEnergyKwh - allocated
    const tolerance = Math.max(1e-12, Math.abs(windowEnergyKwh) * 1e-6)
    return {
      framework: opts.framework,
      collector: opts.collector,
      window_seconds: Math.round(windowSeconds * 100) / 100,
      attribution: equalShare ? 'equal_share_no_cpu_signal' : 'duration_share',
      accuracy: 'trend',
      units,
      ...(Object.keys(byTenant).length ? { by_tenant: byTenant } : {}),
      allocation_reconciliation_v0: {
        schema_version: 1,
        window_energy_kwh: windowEnergyKwh,
        allocated_energy_kwh: allocated,
        residual_energy_kwh: residual,
        tolerance_kwh: tolerance,
        passed: Math.abs(residual) <= tolerance,
        scope: 'endpoint_allocation_arithmetic_only',
        endpoint_capture_coverage: null,
        capture_completeness: 'unknown',
      },
    }
  }

  /** Take a snapshot and reset live window (Python take_snapshot analogue). */
  takeSnapshot(): ServiceRuntimeAggregator {
    const snap = new ServiceRuntimeAggregator()
    snap.units = this.units
    snap.byTenant = this.byTenant
    snap.windowStartedAt = this.windowStartedAt
    this.units = new Map()
    this.byTenant = new Map()
    this.windowStartedAt = Date.now()
    return snap
  }

  mergeSnapshot(snapshot: ServiceRuntimeAggregator): void {
    if (snapshot.hasData()) {
      this.windowStartedAt = Math.min(this.windowStartedAt, snapshot.windowStartedAt)
    }
    this.mergeMap(this.units, snapshot.units)
    for (const [tenantId, sourceMap] of snapshot.byTenant.entries()) {
      let targetMap = this.byTenant.get(tenantId)
      if (!targetMap) {
        targetMap = new Map()
        this.byTenant.set(tenantId, targetMap)
      }
      this.mergeMap(targetMap, sourceMap)
    }
  }

  private mergeMap(target: Map<string, UnitAgg>, source: Map<string, UnitAgg>): void {
    for (const [rawKey, src] of source) {
      let key = rawKey
      let dst = target.get(key)
      if (!dst) {
        const needsOverflow =
          key !== '__other__' && target.size >= MAX_UNITS - 1 && !target.has(key)
        if (needsOverflow) {
          key = '__other__'
          dst = target.get(key)
        }
      }
      if (!dst) {
        target.set(key, { ...src, serviceUnit: key })
        continue
      }
      dst.calls += src.calls
      dst.errors += src.errors
      dst.durationMsTotal += src.durationMsTotal
      dst.durationMsMax = Math.max(dst.durationMsMax, src.durationMsMax)
      dst.cpuMsTotal += src.cpuMsTotal
      dst.cpuMsMeasured = dst.cpuMsMeasured || src.cpuMsMeasured
      dst.peakRssKbMax = Math.max(dst.peakRssKbMax, src.peakRssKbMax)
    }
  }
}
