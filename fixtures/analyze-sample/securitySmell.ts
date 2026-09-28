/**
 * Non-resource security smell — must not emit resource_finding_v1.
 * const password = "super-secret-password"
 * API_TOKEN=sk_live_example_not_a_resource_finding
 */
export function login(user: string): string {
  return `welcome ${user}`
}
