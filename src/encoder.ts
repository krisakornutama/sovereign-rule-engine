/** Unsigned LEB128 varint, handy for compact binary framing. */

export function encodeVarInt(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`VarInt value must be a non-negative safe integer, got ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return new Uint8Array(bytes);
}

export function decodeVarInt(bytes: Uint8Array, offset = 0): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 1;
  let cursor = offset;

  while (cursor < bytes.length) {
    const byte = bytes[cursor] as number;
    value += (byte & 0x7f) * shift;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, bytesRead: cursor - offset };
    }
    shift *= 128;
  }

  throw new Error('Unexpected end of buffer while decoding VarInt');
}
