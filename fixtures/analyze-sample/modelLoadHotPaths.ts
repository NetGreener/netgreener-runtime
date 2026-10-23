/** Fixture: model load inside loop → process_or_runtime_churn / model_load_in_loop */
export async function loadPerItem(paths: string[]): Promise<unknown[]> {
  const out: unknown[] = []
  for (const p of paths) {
    const model = await loadLayersModel(`file://${p}`)
    out.push(model)
  }
  return out
}

declare function loadLayersModel(url: string): Promise<unknown>
