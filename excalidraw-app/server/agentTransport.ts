/** Retry only before an upstream stream is accepted. Never replay a partially
 * streamed request or a completed tool; cancellation/deadline remain absolute. */
export async function requestAgentStream(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
) {
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    try {
      const response = await transport(url, init);
      if (attempt >= 2 || ![429, 502, 503, 504].includes(response.status)) {
        return response;
      }
      await response.body?.cancel();
    } catch (error) {
      if (init.signal?.aborted || attempt >= 2) {
        throw error;
      }
    }
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        init.signal?.removeEventListener("abort", stop);
        resolve();
      };
      const timer = setTimeout(done, 400 * 2 ** attempt);
      const stop = () => {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", stop);
        reject(init.signal?.reason);
      };
      init.signal?.addEventListener("abort", stop, { once: true });
      if (init.signal?.aborted) {
        stop();
      }
    });
  }
}
