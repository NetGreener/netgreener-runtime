/**
 * Fixture: API inside .map / Promise.all — overconsumption + unbounded_parallelism.
 */
export async function fetchAll(urls: string[]): Promise<Response[]> {
  return Promise.all(urls.map((url) => fetch(url)))
}

/**
 * Fixture: API inside plain for-loop — external_api_overconsumption (network_call_in_loop).
 */
export async function fetchSequential(urls: string[]): Promise<void> {
  for (const url of urls) {
    await fetch(url)
  }
}
