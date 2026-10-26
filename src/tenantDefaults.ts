/** Default tenant attribution fields for tests and partial RuntimeConfig mocks. */
export const DEFAULT_TENANT_RUNTIME_FIELDS = {
  tenantSource: 'none',
  tenantClaim: 'organization_id',
  tenantHeader: 'X-Organization-Id',
  tenantPathRegex: null,
  tenantTaskKwarg: 'organization_id',
  tenantLabelClaim: null,
} as const
