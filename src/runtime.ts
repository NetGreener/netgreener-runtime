import { hostname } from 'node:os'

import { ServiceRuntimeAggregator } from './aggregator.js'
import {
  configReady,
  loadRuntimeConfig,
  type RuntimeConfig,
} from './config.js'
import type { RuntimeSessionMetadata } from './types.js'
import { type RunSessionCreatePayload, type UploadResult } from './uploader.js'
import {
  resolveObservationExporter,
  type ObservationExporter,
} from './exporter.js'
import { newRuntimeWindowId } from './windowId.js'
import {
  attachWindowTenantToRunContext,
  getTenantContext,
  tenantConfigFromRuntime,
} from './tenantContext.js'
import {
  getExternalAggregator,
  getOriginalFetch,
  installOutboundInstrumentation,
} from './externalApiMeter.js'
import {
  CPU_SOURCE_PROCESS,
  MEMORY_SOURCE_PROCESS,
} from './processResources.js'
import { CPU_SOURCE_DURATION_PROXY } from './n4/missingnessInventory.js'
import {
  buildRuntimeHealthV0,
  markHooksActive,
  mergeHealthIntoMetadata,
  noteExportAttempt,
  noteExportMode,
  noteExportResult,
  noteFlushSkippedInFlight,
  _resetRuntimeHealthForTests,
} from './runtimeHealth.js'

export type FlushKind = 'periodic' | 'shutdown' | 'manual'

export type NetGreenerRuntimeOptions = {
  config?: RuntimeConfig
  collector?: string
  framework?: string
  fetchImpl?: typeof fetch
  /** MP2: defaults to direct upload exporter (unchanged pipeline). */
  exporter?: ObservationExporter
  onFlush?: (result: UploadResult, payload: RunSessionCreatePayload) => void
}

/**
 * Process-wide runtime controller: record samples, periodic flush, shutdown flush.
 */
export class NetGreenerRuntime {
  readonly config: RuntimeConfig
  private readonly aggregator = new ServiceRuntimeAggregator()
  private readonly collector: string
  private readonly framework: string
  private readonly fetchImpl: typeof fetch
  private readonly exporter: ObservationExporter
  private readonly onFlush?: NetGreenerRuntimeOptions['onFlush']
  private timer: NodeJS.Timeout | null = null
  private flushing = false
  private started = false
  private outboundInstalled = false

  constructor(opts: NetGreenerRuntimeOptions = {}) {
    this.config = opts.config ?? loadRuntimeConfig()
    this.collector = opts.collector ?? 'express_middleware'
    this.framework = opts.framework ?? 'express'
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.exporter = opts.exporter ?? resolveObservationExporter()
    this.onFlush = opts.onFlush
  }

  get enabled(): boolean {
    return configReady(this.config).ok
  }

  private ensureOutboundMeter(): void {
    if (this.outboundInstalled || !this.enabled) return
    this.outboundInstalled = true
    try {
      const apiHost = new URL(this.config.apiUrl).hostname
      installOutboundInstrumentation({
        excludedHosts: apiHost ? [apiHost] : [],
      })
    } catch {
      installOutboundInstrumentation()
    }
  }

  /** Prefer unwrapped fetch so telemetry uploads are never metered. */
  private uploadFetch(): typeof fetch {
    return getOriginalFetch() ?? this.fetchImpl
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (!this.enabled) return
    markHooksActive({
      processKind: this.framework,
      exportMode: this.exporter.mode,
    })
    noteExportMode(this.exporter.mode)
    this.ensureOutboundMeter()
    this.timer = setInterval(() => {
      void this.flush('periodic')
    }, this.config.flushIntervalMs)
    // Do not keep the process alive solely for the timer.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.started = false
  }

  recordHttp(sample: {
    method: string
    path: string
    statusCode: number
    durationMs: number
    /** Measured process CPU ms (from begin/endProcessResourceSample). */
    cpuTimeMs?: number
    /** Measured RSS KiB at request end. */
    peakRssKb?: number
  }): void {
    if (!this.enabled) return
    this.ensureOutboundMeter()
    markHooksActive({
      processKind: this.framework,
      exportMode: this.exporter.mode,
    })
    const serviceUnit = `${sample.method.toUpperCase()} ${sample.path}`
    this.aggregator.record({
      serviceUnit,
      unitType: 'http_route',
      durationMs: sample.durationMs,
      error: sample.statusCode >= 400,
      tenantId: getTenantContext()?.tenantId ?? null,
      ...(sample.cpuTimeMs !== undefined ? { cpuTimeMs: sample.cpuTimeMs } : {}),
      ...(sample.peakRssKb !== undefined ? { peakRssKb: sample.peakRssKb } : {}),
    })
  }

  /** Record a background job / worker task sample (BullMQ, cron, scripts). */
  recordTask(sample: {
    serviceUnit: string
    durationMs: number
    error?: boolean
    tenantId?: string | null
    cpuTimeMs?: number
    peakRssKb?: number
  }): void {
    if (!this.enabled) return
    this.ensureOutboundMeter()
    markHooksActive({
      processKind: this.framework,
      exportMode: this.exporter.mode,
    })
    this.aggregator.record({
      serviceUnit: sample.serviceUnit,
      unitType: 'task',
      durationMs: sample.durationMs,
      error: Boolean(sample.error),
      tenantId: sample.tenantId ?? getTenantContext()?.tenantId ?? null,
      ...(sample.cpuTimeMs !== undefined ? { cpuTimeMs: sample.cpuTimeMs } : {}),
      ...(sample.peakRssKb !== undefined ? { peakRssKb: sample.peakRssKb } : {}),
    })
  }

  async flush(kind: FlushKind = 'manual'): Promise<UploadResult | null> {
    if (!this.enabled) return null
    if (this.flushing) {
      noteFlushSkippedInFlight()
      return null
    }
    const externalAgg = getExternalAggregator()
    const hasRuntime = this.aggregator.hasData()
    const hasExternal = externalAgg.hasData()
    if (!hasRuntime && !hasExternal) return null

    this.flushing = true
    noteExportMode(this.exporter.mode)
    const snapshot = hasRuntime ? this.aggregator.takeSnapshot() : null
    const externalSnapshot = hasExternal ? externalAgg.takeSnapshot() : null
    try {
      const windowStartedMs = snapshot
        ? snapshot.windowStartedMs()
        : Date.now() - 1000
      const windowSeconds = Math.max(0.001, (Date.now() - windowStartedMs) / 1000)
      // Crude trend energy: TDP * utilization proxy from request busy time.
      const busySeconds = snapshot
        ? snapshot.hasMeasuredCpu()
          ? snapshot.totalMeasuredCpuMs() / 1000
          : snapshot.totalDurationMs() / 1000
        : 0
      const util = Math.min(1, busySeconds / Math.max(windowSeconds, 0.001))
      const windowEnergyKwh =
        (this.config.estimateTdpWatts * util * windowSeconds) / 1000 / 3600

      const runtimeV0 = snapshot
        ? snapshot.buildV0({
            collector: this.collector,
            framework: this.framework,
            windowEnergyKwh,
            windowSeconds,
          })
        : null
      if (snapshot && !runtimeV0) {
        this.aggregator.mergeSnapshot(snapshot)
        if (externalSnapshot) externalAgg.mergeSnapshot(externalSnapshot)
        return null
      }

      const externalV0 = externalSnapshot ? externalSnapshot.buildV0() : null

      const end = new Date()
      const start = new Date(end.getTime() - windowSeconds * 1000)
      const windowId = newRuntimeWindowId()
      // Prefer effective RuntimeConfig over ambient process.env.
      const tenantConfig = tenantConfigFromRuntime(this.config)
      const runContext: Record<string, unknown> = {
        client: 'netgreener_node_runtime',
        runtime_flush_kind: kind,
        measured_scope: 'process',
        resource_scope: 'process',
        ...(this.config.deployEnvironment
          ? { deploy_environment: this.config.deployEnvironment }
          : {}),
        ...(this.config.releaseTag ? { release_tag: this.config.releaseTag } : {}),
      }
      attachWindowTenantToRunContext(runContext, {
        runtimeV0: runtimeV0 ?? undefined,
        externalV0: externalV0 ?? undefined,
        tenantConfig,
        activeContext: getTenantContext(),
      })

      const measuredCpu = snapshot?.hasMeasuredCpu() ?? false
      const measuredRss = snapshot?.hasMeasuredRss() ?? false
      const session_metadata: RuntimeSessionMetadata = {
        run_context: runContext,
        ...(runtimeV0 ? { service_runtime_v0: runtimeV0 } : {}),
        ...(externalV0 ? { external_api_v0: externalV0 } : {}),
        measurement_provenance: {
          cpu_source: runtimeV0
            ? measuredCpu
              ? CPU_SOURCE_PROCESS
              : CPU_SOURCE_DURATION_PROXY
            : 'unavailable',
          memory_source: measuredRss ? MEMORY_SOURCE_PROCESS : 'unavailable',
          energy_model: runtimeV0 ? 'tdp_utilization_estimate' : 'unavailable',
          gpu_scope: 'none',
          gpu_source: 'unavailable',
          carbon_factor: {
            value: 0.4,
            unit: 'kg_co2e_per_kwh',
            source: 'default_grid_factor',
          },
          evidence_grades: {
            schema_version: 1,
            policy_version: 'r9_v0',
            metrics: {
              local_energy: {
                metric: 'local_energy',
                grade: runtimeV0 ? 'G1' : 'G0',
                reasons: runtimeV0 ? ['estimated_power_tdp'] : ['no_runtime_units'],
              },
              local_carbon: {
                metric: 'local_carbon',
                grade: runtimeV0 ? 'G1' : 'G0',
                reasons: runtimeV0
                  ? ['estimated_power_tdp', 'default_grid_factor']
                  : ['no_runtime_units'],
              },
            },
            combined_floor_grade: runtimeV0 ? 'G1' : 'G0',
            notes: ['vendor_carbon_separate_ledger'],
          },
        },
      }
      mergeHealthIntoMetadata(session_metadata, buildRuntimeHealthV0())

      const payload: RunSessionCreatePayload = {
        project_id: this.config.projectId,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        server_name: hostname() || null,
        energy_kwh: windowEnergyKwh,
        runtime_window_id: windowId,
        session_metadata,
      }

      noteExportAttempt(this.exporter.mode)
      const result = await this.exporter.exportRunSessionWindow(
        this.config,
        payload,
        this.uploadFetch(),
      )
      noteExportResult(
        result.ok,
        result.ok ? undefined : 'error' in result ? result.error : 'export_failed',
      )
      mergeHealthIntoMetadata(session_metadata, buildRuntimeHealthV0())
      if (!result.ok) {
        if (snapshot) this.aggregator.mergeSnapshot(snapshot)
        if (externalSnapshot) externalAgg.mergeSnapshot(externalSnapshot)
      }
      this.onFlush?.(result, payload)
      return result
    } catch (err) {
      noteExportResult(false, err instanceof Error ? err.message : String(err))
      if (snapshot) this.aggregator.mergeSnapshot(snapshot)
      if (externalSnapshot) externalAgg.mergeSnapshot(externalSnapshot)
      const result: UploadResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
      this.onFlush?.(result, {
        project_id: this.config.projectId,
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        runtime_window_id: newRuntimeWindowId(),
        session_metadata: {},
      })
      return result
    } finally {
      this.flushing = false
    }
  }

  async shutdown(): Promise<UploadResult | null> {
    this.stop()
    return this.flush('shutdown')
  }
}

let globalRuntime: NetGreenerRuntime | null = null

export function getRuntime(opts?: NetGreenerRuntimeOptions): NetGreenerRuntime {
  if (!globalRuntime) {
    globalRuntime = new NetGreenerRuntime(opts)
  }
  return globalRuntime
}

/** Test helper — reset singleton. */
export function _resetRuntimeForTests(): void {
  globalRuntime?.stop()
  globalRuntime = null
  _resetRuntimeHealthForTests()
}
