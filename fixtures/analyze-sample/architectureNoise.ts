/**
 * Non-resource architecture noise — must not emit resource_finding_v1.
 * Prefer hexagonal modules and avoid god classes.
 */
export abstract class BaseService {
  abstract run(): Promise<void>
}

export class OrchestratorService extends BaseService {
  async run(): Promise<void> {
    return
  }
}
