export {
  buildServiceManifest,
  detectFrameworks,
  extractServiceUnits,
  isServiceProject,
  type ServiceEndpointUnit,
  type ServiceFileExtraction,
  type ServiceManifestV0,
  type ServiceTaskUnit,
} from './serviceDiscovery.js'
export {
  buildServiceManifestFromPaths,
  listCandidateSourceFiles,
  type ListCandidateSourceFilesOptions,
} from './projectScan.js'
export {
  NON_RESOURCE_CATEGORIES,
  RESOURCE_DOMAINS,
  admitAnalyzeCandidate,
  isNonResourceCategory,
  type AdmissionDecision,
  type NonResourceCategory,
  type ResourceDomain,
} from './resourceAdmission.js'
export {
  languageForPath,
  toResourceFindingCandidate,
  type ResourceCandidateHit,
  type ResourceFindingCandidateV1,
  type ResourcePrimaryDomain,
} from './resourceFindingCandidate.js'
export { detectRetryAmplificationHits } from './retryAmplificationDetector.js'
export { detectApiOverconsumptionHits } from './apiOverconsumptionDetector.js'
export { detectUnboundedParallelismHits } from './unboundedParallelismDetector.js'
export {
  detectInferenceInsideLoopHits,
  detectModelLoadInLoopHits,
  detectPollingIdleHits,
  detectPerItemInsteadOfBatchHits,
  detectProcessChurnHits,
  detectRepeatedWorkHits,
} from './cpuResourceDetectors.js'
export {
  detectFullDatasetInMemoryHits,
  detectRepeatedFileReadHits,
} from './memoryIoDetectors.js'
export {
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
  detectInferenceInsideLoopHitsAst,
  type AstHitBundle,
} from './astDetectors.js'
export {
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
  detectInferenceInsideLoopHitsPreferAst,
} from './preferAstDetectors.js'
export {
  isTypescriptAnalyzeAvailable,
  tryLoadTypescript,
} from './loadTypescript.js'
export {
  allResourceFindingsValid,
  filterValidResourceFindings,
  validateResourceFindingCandidate,
  type ResourceFindingValidation,
  type ResourceFindingValidationError,
} from './validateResourceFinding.js'
export {
  buildAnalyzeGateSummary,
  countGateFindings,
  findingsExceedFailThreshold,
  formatAnalyzeGateFailureMessage,
  resolveAnalyzeGateLimit,
  type AnalyzeGateLimit,
  type AnalyzeGateSummaryV0,
} from './analyzeGate.js'
export {
  buildResourceAnalyzeResultFromPaths,
  buildResourceFindingsFromSources,
  type BuildResourceFindingsOptions,
  type ResourceAnalyzeResultV0,
} from './buildResourceFindings.js'
