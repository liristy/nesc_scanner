export async function mapConcurrent(items, concurrency, worker, { signal } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('并发数应为 1～8 的整数');
  const results = new Array(items.length);
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async (_, lane) => {
    while (!failure && !signal?.aborted) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index, lane); }
      catch (error) { failure ??= error; }
    }
  }));
  signal?.throwIfAborted();
  if (failure) throw failure;
  return results;
}
