import { describe, expect, it } from 'vitest';
import {
  bytesEqual,
  concatBytes,
  decodeVarInt,
  encodeVarInt,
  fromBase64,
  fromBigEndian64,
  fromHex,
  toBase64,
  toBigEndian64,
  toHex,
  utf8ToBytes,
  bytesToUtf8,
} from '../src/index.js';

describe('varint codec', () => {
  it('round-trips boundary values', () => {
    for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 2 ** 31, 2 ** 40]) {
      const encoded = encodeVarInt(value);
      const decoded = decodeVarInt(encoded);
      expect(decoded.value).toBe(value);
      expect(decoded.bytesRead).toBe(encoded.length);
    }
  });

  it('decodes from an offset and stops at the terminator', () => {
    const buffer = concatBytes(new Uint8Array([0xff]), encodeVarInt(300), new Uint8Array([0x00]));
    const decoded = decodeVarInt(buffer, 1);
    expect(decoded.value).toBe(300);
    expect(decoded.bytesRead).toBe(2);
  });

  it('rejects invalid input and truncated buffers', () => {
    expect(() => encodeVarInt(-1)).toThrow(/non-negative/);
    expect(() => encodeVarInt(1.5)).toThrow(/safe integer/);
    expect(() => decodeVarInt(new Uint8Array([0x80, 0x80]))).toThrow(/Unexpected end/);
  });
});

describe('base64 and hex helpers', () => {
  it('round-trips all byte lengths (padding cases)', () => {
    for (let length = 0; length <= 8; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 5) & 0xff);
      expect(bytesEqual(fromBase64(toBase64(bytes)), bytes)).toBe(true);
    }
  });

  it('round-trips hex with and without the 0x prefix', () => {
    const bytes = new Uint8Array([0x00, 0xab, 0xff]);
    expect(toHex(bytes)).toBe('00abff');
    expect(bytesEqual(fromHex('00abff'), bytes)).toBe(true);
    expect(bytesEqual(fromHex('0x00abff'), bytes)).toBe(true);
  });

  it('rejects malformed encodings', () => {
    expect(() => fromBase64('!!!!')).toThrow(/Invalid base64/);
    expect(() => fromHex('abc')).toThrow(/even length/);
    expect(() => fromHex('zz')).toThrow(/Invalid hex/);
  });

  it('compares, concatenates and converts text', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(Array.from(concatBytes(new Uint8Array([1]), new Uint8Array([2, 3])))).toEqual([1, 2, 3]);
    expect(bytesToUtf8(utf8ToBytes('สวัสดี sovereign'))).toBe('สวัสดี sovereign');
  });
});

describe('big-endian 64-bit counter', () => {
  it('round-trips safe integers', () => {
    for (const value of [0, 1, 255, 256, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      const encoded = toBigEndian64(value);
      expect(encoded).toHaveLength(8);
      expect(fromBigEndian64(encoded)).toBe(value);
    }
  });

  it('rejects invalid counters', () => {
    expect(() => toBigEndian64(-1)).toThrow(/non-negative/);
    expect(() => fromBigEndian64(new Uint8Array(7))).toThrow(/8-byte/);
  });
});
