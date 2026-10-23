/** Fixture: model inference inside loop → per_item_instead_of_batch / inference_inside_loop */
export async function scorePerItem(
  model: { predict: (x: unknown) => Promise<unknown> },
  batches: unknown[],
): Promise<unknown[]> {
  const out: unknown[] = []
  for (const batch of batches) {
    out.push(await model.predict(batch))
  }
  return out
}

export async function runOnnxPerItem(
  session: { run: (feeds: Record<string, unknown>) => Promise<unknown> },
  feedsList: Record<string, unknown>[],
): Promise<unknown[]> {
  const out: unknown[] = []
  for (const feeds of feedsList) {
    out.push(await session.run(feeds))
  }
  return out
}
