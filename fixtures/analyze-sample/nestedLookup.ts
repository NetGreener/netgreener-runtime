/** Fixture: nested-loop array lookup → per_item_instead_of_batch */
export function matchMany(
  left: Array<{ id: string }>,
  right: Array<{ id: string }>,
): Array<{ id: string }> {
  const out: Array<{ id: string }> = []
  for (const a of left) {
    for (const b of right) {
      if (right.find((x) => x.id === a.id)) {
        out.push(b)
      }
    }
  }
  return out
}
