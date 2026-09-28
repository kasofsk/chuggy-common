/**
 * A response body read under a byte bound and a read bound, refused the moment
 * either is passed rather than cut. A declared `content-length` only refuses
 * early: a proxy that recompresses answers with none, so the bound is on the
 * stream. The read bound is what ends a body yielding empty chunks forever.
 */

/**
 * @param {Response} response
 * @param {number} bytesMax
 * @param {number} readsMax the chunks the body may yield; the read reporting its end is not one
 * @returns {Promise<Uint8Array>}
 */
export async function boundedResponseBytes(response, bytesMax, readsMax) {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > bytesMax) {
    await response.body?.cancel();
    throw new RangeError("HTTP response exceeds its byte bound");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let reads = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      reads += 1;
      if (reads > readsMax) {
        await reader.cancel();
        throw new RangeError("HTTP response exceeds its read bound");
      }
      length += read.value.byteLength;
      if (length > bytesMax) {
        await reader.cancel();
        throw new RangeError("HTTP response exceeds its byte bound");
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
