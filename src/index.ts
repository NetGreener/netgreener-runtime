/**
 * @netgreener/runtime — Node emitter for NetGreener.
 *
 * N0: contracts · N1: Express/Fastify/Nest-via-adapter + RunSession flush
 * N2: outbound fetch meter · N3: BullMQ worker + process/cron runtime
 * Does not modify Python CLI/runtime capability.
 */

export type {
  AllocationReconciliationV0,
  EvidenceGrades,
  ExternalApiModelBucket,
  ExternalApiProvider,
  ExternalApiTenantBucket,
  ExternalApiV0,
  MeasurementProvenance,
  RunContext,
  RuntimeSessionMetadata,
  ServiceRuntimeTenantBucket,
  ServiceRuntimeUnit,
  ServiceRuntimeV0,
  TenantId,
} from './types.js'

export {
  validateExternalApiV0,
  validateMeasurementProvenance,
  validateRuntimeSessionMetadata,
  validateServiceRuntimeV0,
  type ContractIssue,
  type ContractResult,
} from './contract/index.js'

export { loadRuntimeConfig, configReady, type RuntimeConfig } from './config.js'
export {
  COMPATIBLE_COLLECTOR_METADATA,
  COLLECTOR_METADATA_NOTES,
  isCompatibleCollectorMetadata,
  type CompatibleCollectorMetadata,
} from './collectorMetadata.js'
export {
  validateObservationEnvelope,
  classifyObservationDelivery,
  projectSemanticEnvelopeToProtobufView,
  validateObservationProtobufView,
  validateObservationDualView,
} from './contract/observation-v1.mjs'
export { ServiceRuntimeAggregator } from './aggregator.js'
export {
  beginProcessResourceSample,
  endProcessResourceSample,
  currentRssKb,
  _resetRssSampleCacheForTests,
  type ProcessResourceMark,
  type ProcessResourceSample,
} from './processResources.js'
export {
  buildRuntimeHealthV0,
  mergeHealthIntoMetadata,
  markHooksActive,
  type RuntimeHealthV0,
  type RuntimeHealthStatus,
} from './runtimeHealth.js'

export { newRuntimeWindowId } from './windowId.js'
export {
  uploadRunSession,
  type RunSessionCreatePayload,
  type UploadResult,
} from './uploader.js'
export {
  resolveObservationExporter,
  exportModeFromEnv,
  DirectRunSessionExporter,
  ThinRunSessionExporter,
  CollectorRunSessionExporter,
  type ExportMode,
  type ExportResult,
  type ObservationExporter,
  type ObservationBatchDocument,
} from './exporter.js'
export {
  detectServerlessPlatformSignals,
  flushModeRequestsThin,
  type ServerlessPlatformHint,
  type ServerlessPlatformSignal,
} from './serverlessHints.js'
export {
  resolveLifecycle,
  isEphemeralLifecycle,
  type RuntimeModePreference,
  type RuntimeLifecycle,
  type RuntimePlatform,
  type RuntimeCapabilities,
  type ResolvedRuntimeLifecycle,
} from './lifecycle.js'
export { NetGreener, type NetGreenerInitOptions } from './init.js'
export {
  sendCollectorEvent,
  encodeCollectorFrame,
  normalizeCollectorEndpoint,
  type CollectorIpcAck,
} from './collectorIpc.js'
export {
  NetGreenerRuntime,
  getRuntime,
  _resetRuntimeForTests,
  type FlushKind,
  type NetGreenerRuntimeOptions,
} from './runtime.js'
export {
  netgreenerExpressMiddleware,
  getExpressRuntime,
  type ExpressRequest,
  type ExpressResponse,
  type ExpressNext,
} from './express.js'
export {
  netgreenerFastifyPlugin,
  getFastifyRuntime,
  fastifyRouteTemplate,
  bindFastifyTenant,
  type FastifyLike,
  type FastifyRequestLike,
  type FastifyReplyLike,
} from './fastify.js'
export {
  applyNetGreenerNestHooks,
  detectNestHttpAdapter,
  getNestRuntime,
  netgreenerNestExpressMiddleware,
  netgreenerNestFastifyPlugin,
  type NestApplicationLike,
  type NestHttpAdapterKind,
} from './nest.js'
export {
  attachWindowTenantToRunContext,
  getTenantContext,
  loadTenantConfig,
  normalizeTenantId,
  resolveTenantFromHttpRequest,
  resolveTenantFromTaskData,
  runWithTenantContext,
  setTenantContext,
  tenantConfigFromRuntime,
  type TenantConfig,
  type TenantContext,
} from './tenantContext.js'
export {
  ExternalApiAggregator,
  buildExternalV0,
  clearExternalAggregator,
  getExternalAggregator,
  installOutboundInstrumentation,
  providerForHost,
  usageFromClientBody,
  _resetOutboundInstrumentationForTests,
} from './externalApiMeter.js'
export {
  attributionServiceUnit,
  getRequestAttribution,
  runWithRequestAttribution,
} from './requestContext.js'
export {
  getBullMqRuntime,
  netgreenerBullMqProcessor,
  runBullMqJobWithNetGreener,
  type BullMqJobLike,
  type BullMqProcessorOptions,
} from './bullmq.js'
export {
  bindProcessTenant,
  flushProcessRuntime,
  runWithProcessTenant,
  startProcessRuntime,
  type ProcessRuntimeOptions,
} from './processRuntime.js'
export {
  buildServiceManifest,
  detectFrameworks,
  extractServiceUnits,
  isServiceProject,
  buildServiceManifestFromPaths,
  listCandidateSourceFiles,
  NON_RESOURCE_CATEGORIES,
  RESOURCE_DOMAINS,
  admitAnalyzeCandidate,
  isNonResourceCategory,
  languageForPath,
  toResourceFindingCandidate,
  detectRetryAmplificationHits,
  detectApiOverconsumptionHits,
  detectUnboundedParallelismHits,
  detectPollingIdleHits,
  detectProcessChurnHits,
  detectRepeatedWorkHits,
  detectPerItemInsteadOfBatchHits,
  detectModelLoadInLoopHits,
  detectFullDatasetInMemoryHits,
  detectRepeatedFileReadHits,
  detectAllHitsAst,
  detectHotPathHitsAst,
  detectApiOverconsumptionHitsAst,
  detectPollingIdleHitsAst,
  detectProcessChurnHitsAst,
  detectRepeatedFileReadHitsAst,
  detectRepeatedWorkHitsAst,
  detectRetryAmplificationHitsAst,
  detectUnboundedParallelismHitsAst,
  detectFullDatasetInMemoryHitsAst,
  detectPerItemInsteadOfBatchHitsAst,
  detectModelLoadInLoopHitsAst,
  collectPreferAstHits,
  detectApiOverconsumptionHitsPreferAst,
  detectPollingIdleHitsPreferAst,
  detectProcessChurnHitsPreferAst,
  detectRepeatedFileReadHitsPreferAst,
  detectRepeatedWorkHitsPreferAst,
  detectRetryAmplificationHitsPreferAst,
  detectUnboundedParallelismHitsPreferAst,
  detectFullDatasetInMemoryHitsPreferAst,
  detectPerItemInsteadOfBatchHitsPreferAst,
  detectModelLoadInLoopHitsPreferAst,
  isTypescriptAnalyzeAvailable,
  tryLoadTypescript,
  allResourceFindingsValid,
  filterValidResourceFindings,
  validateResourceFindingCandidate,
  countGateFindings,
  findingsExceedFailThreshold,
  formatAnalyzeGateFailureMessage,
  resolveAnalyzeGateLimit,
  buildAnalyzeGateSummary,
  buildResourceAnalyzeResultFromPaths,
  buildResourceFindingsFromSources,
  type ServiceEndpointUnit,
  type ServiceFileExtraction,
  type ServiceManifestV0,
  type ServiceTaskUnit,
  type ListCandidateSourceFilesOptions,
  type AdmissionDecision,
  type NonResourceCategory,
  type ResourceDomain,
  type ResourceCandidateHit,
  type ResourceFindingCandidateV1,
  type ResourcePrimaryDomain,
  type BuildResourceFindingsOptions,
  type ResourceAnalyzeResultV0,
  type ResourceFindingValidation,
  type ResourceFindingValidationError,
  type AnalyzeGateLimit,
  type AnalyzeGateSummaryV0,
  type AstHitBundle,
} from './analyze/index.js'

export {
  assertNoFalseCgroupClaim,
  CPU_SOURCE_DURATION_PROXY,
  CPU_SOURCE_PROCESS,
  MEMORY_SOURCE_PROCESS,
  missingnessByStatus,
  NODE_DIRECT_MISSINGNESS_INVENTORY,
  type MeasurementStatus,
  type MissingnessEntry,
} from './n4/missingnessInventory.js'
export {
  NODE_DEPLOYMENT_MATRIX,
  claimedDeployModes,
  assertProductionScopeIsExplicit,
  type DeployModeEntry,
  type DeployModeStatus,
} from './n4/deploymentMatrix.js'
