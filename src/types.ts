/**
 * Isomorphic byte helpers. Everything here works on plain `Uint8Array`
 * so the module runs unchanged on Node.js and in the browser / PWA.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_LOOKUP: Record<string, number | undefined> = (() => {
  const table: Record<string, number | undefined> = {};
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET[i] as string] = i;
  }
  return table;
})();

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    // The last group may be short, so the trailing bytes really can be missing.
    const b1 = bytes.at(i + 1);
    const b2 = bytes.at(i + 2);

    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const char of clean) {
    const sextet = BASE64_LOOKUP[char];
    if (sextet === undefined) {
      throw new Error(`Invalid base64 character: ${char}`);
    }
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }

  return out.subarray(0, index);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex string: ${hex}`);
    }
    out[i] = byte;
  }
  return out;
}

export function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function randomBytes(length: number): Uint8Array {
  // Browsers always expose crypto; older Node versions and bare runtimes do not.
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (!webCrypto || typeof webCrypto.getRandomValues !== 'function') {
    throw new Error('WebCrypto getRandomValues is not available in this runtime');
  }
  const out = new Uint8Array(length);
  webCrypto.getRandomValues(out);
  return out;
}

/** 8-byte unsigned big-endian counter, used for the nonce suffix. */
export function toBigEndian64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Counter must be a non-negative safe integer, got ${value}`);
  }
  const out = new Uint8Array(8);
  let remaining = BigInt(value);
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

export function fromBigEndian64(bytes: Uint8Array): number {
  if (bytes.length !== 8) {
    throw new Error('Expected an 8-byte big-endian counter');
  }
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return Number(value);
}
