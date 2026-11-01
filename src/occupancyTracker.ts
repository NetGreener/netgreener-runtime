/**
 * Concurrency-normalized request occupancy (Python OccupancyTracker twin).
 *
 * Accrues ``dt / N`` to each active request id while N > 0. On end, share moves
 * to the service unit. Window snapshots leave in-flight as unattributed.
 * Additive for anomaly evidence — does not change EXPORT_MODE.
 */

export type OccupancyWindowSnapshot = {
  by_unit: Record<string, number>
  in_flight_seconds: number
  idle_seconds: number
}

export class OccupancyTracker {
  private activeIds = new Set<string>()
  private occById = new Map<string, number>()
  private occByUnit = new Map<string, number>()
  private idleSeconds = 0
  private lastMono: number | null = null

  begin(requestId: string): void {
    if (!requestId) return
    this.accrue(nowMono())
    this.activeIds.add(requestId)
    if (!this.occById.has(requestId)) this.occById.set(requestId, 0)
  }

  end(requestId: string, serviceUnit: string): void {
    if (!requestId) return
    this.accrue(nowMono())
    this.activeIds.delete(requestId)
    const share = this.occById.get(requestId) || 0
    this.occById.delete(requestId)
    const unit = String(serviceUnit || '').trim()
    if (unit && share > 0) {
      this.occByUnit.set(unit, (this.occByUnit.get(unit) || 0) + share)
    }
  }

  private accrue(now: number): void {
    if (this.lastMono == null) {
      this.lastMono = now
      return
    }
    const dt = Math.max(0, now - this.lastMono)
    this.lastMono = now
    if (dt <= 0) return
    const n = this.activeIds.size
    if (n <= 0) {
      this.idleSeconds += dt
      return
    }
    const per = dt / n
    for (const rid of this.activeIds) {
      this.occById.set(rid, (this.occById.get(rid) || 0) + per)
    }
  }

  /** Snapshot closed-window occupancy; keep in-flight ids active with zeroed accrual. */
  takeWindowSnapshot(): OccupancyWindowSnapshot {
    this.accrue(nowMono())
    const by_unit: Record<string, number> = {}
    for (const [k, v] of this.occByUnit) {
      if (v > 0) by_unit[k] = Math.round(v * 1e6) / 1e6
    }
    let inFlight = 0
    for (const v of this.occById.values()) inFlight += v
    const idle = this.idleSeconds
    this.occByUnit.clear()
    for (const rid of this.occById.keys()) this.occById.set(rid, 0)
    this.idleSeconds = 0
    return {
      by_unit,
      in_flight_seconds: Math.round(inFlight * 1e6) / 1e6,
      idle_seconds: Math.round(idle * 1e6) / 1e6,
    }
  }
}

function nowMono(): number {
  const t = process.hrtime.bigint()
  return Number(t) / 1e9
}

let globalTracker = new OccupancyTracker()

export function getOccupancyTracker(): OccupancyTracker {
  return globalTracker
}

/** Test helper — swap in a fresh tracker. */
export function _resetOccupancyTrackerForTests(): void {
  globalTracker = new OccupancyTracker()
}
