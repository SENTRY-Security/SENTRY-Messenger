// Strict BufferSource normalizer for Node-side scripts.
export function toU8Strict(input, tag = 'node/u8-strict') {
  const buildInfo = (reason) => ({
    tag,
    reason,
    type: typeof input,
    ctor: input?.constructor?.name || null,
    stack: (() => {
      try {
        return new Error().stack?.split('\n').slice(0, 4).join(' | ') || null;
      } catch {
        return null;
      }
    })()
  });
  const fail = (reason) => {
    const info = buildInfo(reason);
    try {
      // eslint-disable-next-line no-console
      console.error('[u8-strict:node]', info);
    } catch {}
    const err = new Error(`toU8Strict(${tag}): ${reason}`);
    err.info = info;
    throw err;
  };

  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === 'string') {
    try {
      return new Uint8Array(Buffer.from(input, 'base64'));
    } catch {
      fail('base64-decode-failed');
    }
  }
  if (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer === 'function' && Buffer.isBuffer(input)) {
    return new Uint8Array(input);
  }
  if (input && input.type === 'Buffer' && Array.isArray(input.data)) {
    try {
      return new Uint8Array(input.data);
    } catch {
      fail('buffer-object-invalid');
    }
  }
  fail('unsupported-type');
}
