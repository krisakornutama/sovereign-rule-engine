import { sign as edSign } from '@stablelib/ed25519';
import { describe, expect, it } from 'vitest';
import {
  acceptHandshake,
  concatBytes,
  createHandshakeInit,
  createIdentity,
  finalizeHandshake,
  randomBytes,
  toBase64,
  type SecureSession,
  utf8ToBytes,
} from '../src/index.js';

function createSessionPair(): {
  initiator: SecureSession;
  responder: SecureSession;
} {
  const alice = createIdentity();
  const bob = createIdentity();
  const pending = createHandshakeInit('peer-alice', alice, 'peer-bob');
  const { response, session: responder } = acceptHandshake(pending.init, 'peer-bob', bob);
  const initiator = finalizeHandshake(pending, response, alice);
  return { initiator, responder };
}

describe('SecureSession ciphertext round trip', () => {
  it('shares the same session id and decrypts both directions', () => {
    const { initiator, responder } = createSessionPair();
    expect(initiator.sessionId).toBe(responder.sessionId);

    const toBob = initiator.encrypt(new TextEncoder().encode('hello bob'));
    expect(responder.decryptToText(toBob)).toBe('hello bob');

    const toAlice = responder.encrypt(new TextEncoder().encode('hello alice'));
    expect(initiator.decryptToText(toAlice)).toBe('hello alice');
  });

  it('rejects tampered ciphertext and foreign sessions', () => {
    const { initiator, responder } = createSessionPair();
    const envelope = initiator.encrypt(new TextEncoder().encode('payload'));

    expect(() =>
      responder.decrypt({
        ...envelope,
        ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA`,
      })
    ).toThrow();

    const other = createSessionPair();
    expect(() => other.responder.decrypt(envelope)).toThrow(/different session/);
  });
});

describe('replay protection (64-message sliding window)', () => {
  it('rejects an exact duplicate nonce', () => {
    const { initiator, responder } = createSessionPair();
    const envelope = initiator.encrypt(new TextEncoder().encode('once'));

    expect(responder.decryptToText(envelope)).toBe('once');
    expect(() => responder.decrypt(envelope)).toThrow(/already seen/);
  });

  it('rejects a sequence that fell out of the window', () => {
    const { initiator, responder } = createSessionPair();
    const envelopes = Array.from({ length: 101 }, (_, index) =>
      initiator.encrypt(new TextEncoder().encode(`msg-${index}`))
    );

    // Deliver 0, then jump to 100: the window now starts at 36.
    expect(responder.decryptToText(envelopes[0]!)).toBe('msg-0');
    expect(responder.decryptToText(envelopes[100]!)).toBe('msg-100');

    expect(() => responder.decrypt(envelopes[10]!)).toThrow(/outside of the sliding window/);
  });

  it('still accepts an unseen gap that is inside the window', () => {
    const { initiator, responder } = createSessionPair();
    const envelopes = Array.from({ length: 101 }, (_, index) =>
      initiator.encrypt(new TextEncoder().encode(`msg-${index}`))
    );

    responder.decrypt(envelopes[0]!);
    responder.decrypt(envelopes[100]!);

    expect(responder.decryptToText(envelopes[50]!)).toBe('msg-50');
    // Once 100 has been seen it can never be replayed.
    expect(() => responder.decrypt(envelopes[100]!)).toThrow(/already seen/);
  });

  it('treats a sequence exactly 64 behind the highest as outside the window', () => {
    const { initiator, responder } = createSessionPair();
    const envelopes = Array.from({ length: 65 }, (_, index) =>
      initiator.encrypt(new TextEncoder().encode(`msg-${index}`))
    );

    responder.decrypt(envelopes[64]!);
    expect(() => responder.decrypt(envelopes[0]!)).toThrow(/outside of the sliding window/);
  });
});

describe('handshake input validation', () => {
  it('rejects a low-order ephemeral key instead of deriving an all-zero secret', () => {
    const initiator = createIdentity();
    const responder = createIdentity();
    const zeroEphemeral = new Uint8Array(32);
    const nonce = randomBytes(32);
    const payload = concatBytes(
      utf8ToBytes('sovereign-origin/handshake/init/v1'),
      initiator.publicKey,
      zeroEphemeral,
      nonce
    );

    const init = {
      peerId: 'peer-alice',
      identityPublicKey: toBase64(initiator.publicKey),
      ephemeralPublicKey: toBase64(zeroEphemeral),
      nonce: toBase64(nonce),
      signature: toBase64(edSign(initiator.secretKey, payload)),
    };

    expect(() => acceptHandshake(init, 'peer-bob', responder)).toThrow(/all-zero shared secret/);
  });
});

describe('session input validation', () => {
  it('rejects an init whose signature does not verify', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const pending = createHandshakeInit('peer-alice', alice, 'peer-bob');
    const forgedInit = { ...pending.init, signature: toBase64(new Uint8Array(64)) };

    expect(() => acceptHandshake(forgedInit, 'peer-bob', bob)).toThrow(
      'Handshake init signature verification failed'
    );
  });

  it('rejects a response whose signature does not verify', () => {
    const alice = createIdentity();
    const bob = createIdentity();
    const pending = createHandshakeInit('peer-alice', alice, 'peer-bob');
    const { response } = acceptHandshake(pending.init, 'peer-bob', bob);
    const forgedResponse = { ...response, signature: toBase64(new Uint8Array(64)) };

    expect(() => finalizeHandshake(pending, forgedResponse, alice)).toThrow(
      'Handshake response signature verification failed'
    );
  });

  it('rejects envelopes with a foreign version or a wrong nonce length', () => {
    const { initiator } = createSessionPair();
    const envelope = initiator.encrypt(new Uint8Array([1, 2, 3]));

    expect(() => initiator.decrypt({ ...envelope, version: 2 })).toThrow(
      /Unsupported envelope version/
    );
    expect(() => initiator.decrypt({ ...envelope, nonce: toBase64(new Uint8Array(16)) })).toThrow(
      /Nonce must be 24 bytes/
    );
  });
});
