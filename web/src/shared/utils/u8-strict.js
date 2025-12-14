// Strict BufferSource normalizer for browser/front-end.
// Converts various inputs into Uint8Array or throws with tagged diagnostics.
export function toU8Strict(input, tag = 'web/u8-strict') {
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
      console.error('[u8-strict]', info);
    } catch {}
    throw new Error(`toU8Strict(${tag}): ${reason}`);
  };

  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === 'string') {
    try {
      const bin = atob(input);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
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
