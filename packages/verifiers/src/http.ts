export type Endpoint = { sourceId: string; url: string; bearer?: string };
export function validateEndpoint(endpoint: Endpoint) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(endpoint.sourceId)) throw Error('Invalid verifier source ID');
  const url = new URL(endpoint.url);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
  )
    throw Error('Verifier endpoints require HTTPS or loopback HTTP without embedded credentials');
  return url;
}
export async function boundedJson(
  url: URL,
  init: RequestInit,
  fetcher = globalThis.fetch,
): Promise<unknown> {
  const deadline = AbortSignal.timeout(5000);
  const response = await fetcher(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
  });
  if (!response.ok || !/application\/json/i.test(response.headers.get('content-type') ?? ''))
    throw Error('Verifier HTTP response unavailable');
  const reader = response.body?.getReader();
  if (!reader) throw Error('Missing verifier response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512 * 1024) throw Error('Verifier response exceeds limit');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
