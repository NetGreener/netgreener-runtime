import { energyKwhToCarbonG } from './carbonLedger.js'
import { tenantBucketId } from './tenantContext.js'
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

  excludePausedTime(milliseconds: number): void {
    this.windowStartedAt += Math.max(0, milliseconds)
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
      const tenantId = tenantBucketId(sample.tenantId, this.byTenant)
      let tenantUnits = this.byTenant.get(tenantId)
      if (!tenantUnits) {
        tenantUnits = new Map()
        this.byTenant.set(tenantId, tenantUnits)
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

  /** Peak RSS (KiB) across units with calls — for crude window RAM estimate. */
  maxPeakRssKb(): number {
    let max = 0
    for (const u of this.units.values()) {
      if (u.calls > 0 && u.peakRssKbMax > max) max = u.peakRssKbMax
    }
    return max
  }

  private buildUnitsList(
    source: Map<string, UnitAgg>,
    windowEnergyKwh: number,
    equalShare: boolean,
    totalDuration: number,
    occByUnit?: Record<string, number>,
    alloc?: {
      windowSeconds: number
      windowRamGbHours: number | null
      useOccupancy: boolean
      windowCpuSeconds?: number | null
    },
  ): ServiceRuntimeUnit[] {
    const list = [...source.values()].filter((u) => u.calls > 0)
    if (!list.length) return []
    const energyBudget = nonNegativeFinite(windowEnergyKwh)
    const windowSeconds = nonNegativeFinite(alloc?.windowSeconds ?? 0)
    const windowRam =
      alloc?.windowRamGbHours != null
        ? nonNegativeFinite(alloc.windowRamGbHours)
        : null
    const useOccupancy = Boolean(alloc?.useOccupancy)
    const sorted = list.sort((a, b) => b.durationMsTotal - a.durationMsTotal)
    const totalCalls = list.reduce((sum, unit) => sum + unit.calls, 0)
    const units: ServiceRuntimeUnit[] = sorted.map((u) => {
      const share = equalShare ? u.calls / totalCalls : u.durationMsTotal / totalDuration
      const energy = energyBudget * share
      const avg = u.calls ? u.durationMsTotal / u.calls : 0
      const cpuSeconds = alloc?.windowCpuSeconds != null
        ? nonNegativeFinite(alloc.windowCpuSeconds) * share
        : u.cpuMsMeasured
        ? u.cpuMsTotal / 1000
        : u.durationMsTotal / 1000
      const unit: ServiceRuntimeUnit = {
        service_unit: u.serviceUnit,
        unit_type: u.unitType,
        calls: u.calls,
        errors: u.errors,
        cpu_seconds_total: Math.round(cpuSeconds * 10000) / 10000,
        energy_kwh: energy,
        carbon_g: energyKwhToCarbonG(energy).carbonG,
        duration_ms: {
          avg: Math.round(avg * 100) / 100,
          max: Math.round(u.durationMsMax * 100) / 100,
        },
      }
      if (u.peakRssKbMax > 0) {
        unit.peak_rss_kb_max = Math.round(u.peakRssKbMax)
      }
      const occ = occByUnit?.[u.serviceUnit]
      const occS = occ != null && occ > 0 ? occ : 0
      if (occS > 0) {
        unit.occupancy_seconds = Math.round(occS * 1e6) / 1e6
      }
      if (windowRam != null) {
        const occShare =
          useOccupancy && windowSeconds > 0 ? occS / windowSeconds : share
        unit.ram_gb_hours = Math.round(windowRam * occShare * 1e6) / 1e6
      }
      return unit
    })
    const allocatedRaw = units.reduce((s, u) => s + u.energy_kwh, 0)
    const drift = energyBudget - allocatedRaw
    if (units.length && Math.abs(drift) > 0) {
      units[0].energy_kwh += drift
      units[0].carbon_g = energyKwhToCarbonG(units[0].energy_kwh).carbonG
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
   * Build service_runtime_v0.
   * When occupancy snapshot is present → ``cpu_and_occupancy_v1`` (anomaly evidence).
   * Occupancy is window-scaled (Python twin) so coverage reconciles to ``window_seconds``.
   */
  buildV0(opts: {
    collector: string
    framework: string
    windowEnergyKwh: number
    windowSeconds: number
    /** Crude window RAM (GiB·h); split by occupancy share when present. */
    windowRamGbHours?: number | null
    /** One process-wide CPU delta; per-route values are allocated estimates. */
    windowCpuSeconds?: number | null
    occupancy?: {
      by_unit: Record<string, number>
      in_flight_seconds: number
      idle_seconds: number
    } | null
  }): ServiceRuntimeV0 | null {
    const list = [...this.units.values()].filter((u) => u.calls > 0)
    if (!list.length) return null
    const windowEnergyKwh = nonNegativeFinite(opts.windowEnergyKwh)
    const windowSeconds = nonNegativeFinite(opts.windowSeconds)
    const windowRamGbHours =
      opts.windowRamGbHours != null ? nonNegativeFinite(opts.windowRamGbHours) : null
    const totalDuration = list.reduce((s, u) => s + u.durationMsTotal, 0)
    const equalShare = totalDuration <= 0
    const occ = opts.occupancy
    const unitKeys = new Set(list.map((u) => u.serviceUnit))
    const rawOccByUnit = occ?.by_unit || {}
    let attributedOccMap: Record<string, number> = {}
    let orphanOcc = 0
    for (const [k, v] of Object.entries(rawOccByUnit)) {
      const n = Math.max(0, Number(v) || 0)
      if (n <= 0) continue
      if (unitKeys.has(k)) attributedOccMap[k] = n
      else orphanOcc += n
    }
    let totalOcc = Object.values(attributedOccMap).reduce((s, v) => s + v, 0)
    const idleSecondsRaw = Math.max(0, occ?.idle_seconds || 0)
    const inFlightSecondsRaw = Math.max(0, occ?.in_flight_seconds || 0)
    let unattributedOcc = idleSecondsRaw + inFlightSecondsRaw + orphanOcc
    const hasOccupancySignal =
      Boolean(occ) && (totalOcc > 0 || unattributedOcc > 0)
    // Align occupancy coverage to the meter window (Python service_runtime_v0 twin).
    if (hasOccupancySignal && windowSeconds > 0) {
      const coverage = totalOcc + unattributedOcc
      if (coverage <= 0) {
        unattributedOcc = windowSeconds
      } else if (Math.abs(coverage - windowSeconds) > 1e-9) {
        const scale = windowSeconds / coverage
        attributedOccMap = Object.fromEntries(
          Object.entries(attributedOccMap).map(([k, v]) => [k, v * scale]),
        )
        totalOcc = Object.values(attributedOccMap).reduce((s, v) => s + v, 0)
        unattributedOcc = windowSeconds - totalOcc
      }
    }
    const useOccupancy =
      hasOccupancySignal && (totalOcc > 0 || unattributedOcc > 0)
    // Keep idle / in-flight proportions after window-scale (orphan folds into unattributed).
    let idleOut = idleSecondsRaw
    let inFlightOut = inFlightSecondsRaw
    if (useOccupancy && windowSeconds > 0) {
      const rawUna = idleSecondsRaw + inFlightSecondsRaw + orphanOcc
      if (rawUna > 0) {
        idleOut = unattributedOcc * (idleSecondsRaw / rawUna)
        inFlightOut = unattributedOcc * (inFlightSecondsRaw / rawUna)
      } else {
        idleOut = unattributedOcc
        inFlightOut = 0
      }
    }

    const unitAlloc = {
      windowSeconds,
      windowRamGbHours,
      useOccupancy,
      windowCpuSeconds: opts.windowCpuSeconds,
    }
    const units = this.buildUnitsList(
      this.units,
      windowEnergyKwh,
      equalShare,
      totalDuration,
      attributedOccMap,
      unitAlloc,
    )
    const byTenant: Record<TenantId, ServiceRuntimeTenantBucket> = {}
    const totalBusy = list.reduce((s, u) => s + u.durationMsTotal, 0)
    const totalCalls = list.reduce((s, u) => s + u.calls, 0)
    for (const [tenantId, tenantMap] of this.byTenant.entries()) {
      const tenantList = [...tenantMap.values()].filter((u) => u.calls > 0)
      if (!tenantList.length) continue
      const tenantBusy = tenantList.reduce((s, u) => s + u.durationMsTotal, 0)
      const tenantShare = totalBusy > 0 ? tenantBusy / totalBusy
        : tenantList.reduce((sum, unit) => sum + unit.calls, 0) / totalCalls
      const tenantEnergy =
        totalBusy > 0
          ? windowEnergyKwh * (tenantBusy / totalBusy)
          : windowEnergyKwh * tenantShare
      const tenantDuration = tenantList.reduce((s, u) => s + u.durationMsTotal, 0)
      const tenantEqual = tenantDuration <= 0
      const tenantUnits = this.buildUnitsList(
        tenantMap,
        tenantEnergy,
        tenantEqual,
        tenantDuration,
        attributedOccMap,
        {
          ...unitAlloc,
          // Route occupancy cannot identify tenants sharing that route.
          useOccupancy: false,
          windowRamGbHours: windowRamGbHours == null ? null
            : windowRamGbHours * tenantShare,
          windowCpuSeconds: opts.windowCpuSeconds == null ? null
            : opts.windowCpuSeconds * tenantShare,
        },
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
    const measuredCpu = this.hasMeasuredCpu()
    let attribution: string
    if (useOccupancy) attribution = 'cpu_and_occupancy_v1'
    else if (measuredCpu) attribution = 'cpu_share'
    else if (equalShare) attribution = 'equal_share_no_cpu_signal'
    else attribution = 'duration_share'

    const attribution_detail = {
      cpu: opts.windowCpuSeconds != null
        ? { method: 'process_window_duration_share', kind: 'allocated_estimate' }
        : measuredCpu
        ? { method: 'request_process_cpu_time', kind: 'proxy' }
        : { method: 'request_duration_proxy', kind: 'proxy' },
      ram: {
        method: useOccupancy
          ? 'concurrency_normalized_active_occupancy'
          : this.hasMeasuredRss()
            ? 'process_rss_peak_observed'
            : 'unallocated',
        kind: useOccupancy
          ? 'allocated_estimate'
          : this.hasMeasuredRss()
            ? 'measured'
            : 'unavailable',
      },
      gpu: { method: 'none', kind: 'unavailable' },
      energy: {
        cpu_dynamic: 'duration_share',
        memory: useOccupancy ? 'ram_occupancy_share' : 'unallocated',
        gpu: 'none',
      },
    }

    const unattributedRam =
      useOccupancy && windowSeconds > 0 && windowRamGbHours != null
        ? windowRamGbHours * (unattributedOcc / windowSeconds)
        : null

    return {
      framework: opts.framework,
      collector: opts.collector,
      window_seconds: Math.round(windowSeconds * 100) / 100,
      attribution,
      attribution_detail,
      accuracy: 'trend',
      units,
      ...(Object.keys(byTenant).length ? { by_tenant: byTenant } : {}),
      ...(useOccupancy
        ? {
            unattributed: {
              occupancy_seconds: Math.round(unattributedOcc * 1e6) / 1e6,
              idle_seconds: Math.round(idleOut * 1e6) / 1e6,
              in_flight_seconds: Math.round(inFlightOut * 1e6) / 1e6,
              ...(unattributedRam != null
                ? { ram_gb_hours: Math.round(unattributedRam * 1e6) / 1e6 }
                : {}),
            },
          }
        : {}),
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
    for (const [sourceTenantId, sourceMap] of snapshot.byTenant.entries()) {
      const tenantId = tenantBucketId(sourceTenantId, this.byTenant)
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
