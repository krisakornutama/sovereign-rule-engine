import {
  generateKeyPair as generateEd25519KeyPair,
  sign as edSign,
  verify as edVerify,
} from '@stablelib/ed25519';
import { generateKeyPair as generateX25519KeyPair, sharedKey } from '@stablelib/x25519';
import { XChaCha20Poly1305 } from '@stablelib/xchacha20poly1305';
import { SHA256 } from '@stablelib/sha256';
import { HKDF } from '@stablelib/hkdf';
import {
  bytesToUtf8,
  concatBytes,
  fromBase64,
  fromBigEndian64,
  randomBytes,
  toBase64,
  toBigEndian64,
  toHex,
  utf8ToBytes,
} from '../types.js';
import type {
  CryptoEnvelope,
  HandshakeInit,
  HandshakeResponse,
  IdentityKeyPair,
  KeyPair,
} from './types.js';

const INIT_TAG = utf8ToBytes('sovereign-origin/handshake/init/v1');
const RESPONSE_TAG = utf8ToBytes('sovereign-origin/handshake/response/v1');
const SESSION_INFO = utf8ToBytes('sovereign-origin/session/v1');
const ENVELOPE_VERSION = 1;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 24;
const REPLAY_WINDOW = 64;

export function sha256(data: Uint8Array): Uint8Array {
  return new SHA256().update(data).digest();
}

export function createIdentity(): IdentityKeyPair {
  const pair = generateEd25519KeyPair();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

function initSignaturePayload(
  identityPublicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: Uint8Array
): Uint8Array {
  return concatBytes(INIT_TAG, identityPublicKey, ephemeralPublicKey, nonce);
}

function responseSignaturePayload(
  initiatorIdentityPublicKey: Uint8Array,
  initiatorEphemeralPublicKey: Uint8Array,
  responderEphemeralPublicKey: Uint8Array,
  nonce: Uint8Array
): Uint8Array {
  return concatBytes(
    RESPONSE_TAG,
    initiatorIdentityPublicKey,
    initiatorEphemeralPublicKey,
    responderEphemeralPublicKey,
    nonce
  );
}

function deriveSessionKeys(
  sharedSecret: Uint8Array,
  salt: Uint8Array
): { initiatorToResponder: Uint8Array; responderToInitiator: Uint8Array } {
  const okm = new HKDF(SHA256, sharedSecret, salt, SESSION_INFO).expand(64);
  return {
    initiatorToResponder: okm.slice(0, 32),
    responderToInitiator: okm.slice(32, 64),
  };
}

export interface PendingHandshake {
  readonly remotePeerId: string;
  readonly init: HandshakeInit;
  readonly ephemeralSecretKey: Uint8Array;
  readonly ephemeralPublicKey: Uint8Array;
}

export function createHandshakeInit(
  peerId: string,
  identity: IdentityKeyPair,
  remotePeerId: string
): PendingHandshake {
  const ephemeral = generateX25519KeyPair();
  const nonce = randomBytes(32);
  const signature = edSign(
    identity.secretKey,
    initSignaturePayload(identity.publicKey, ephemeral.publicKey, nonce)
  );

  return {
    remotePeerId,
    init: {
      peerId,
      identityPublicKey: toBase64(identity.publicKey),
      ephemeralPublicKey: toBase64(ephemeral.publicKey),
      nonce: toBase64(nonce),
      signature: toBase64(signature),
    },
    ephemeralSecretKey: ephemeral.secretKey,
    ephemeralPublicKey: ephemeral.publicKey,
  };
}

export function acceptHandshake(
  init: HandshakeInit,
  peerId: string,
  identity: IdentityKeyPair
): { response: HandshakeResponse; session: SecureSession } {
  const initiatorIdentity = fromBase64(init.identityPublicKey);
  const initiatorEphemeral = fromBase64(init.ephemeralPublicKey);
  const initiatorNonce = fromBase64(init.nonce);

  const initValid = edVerify(
    initiatorIdentity,
    initSignaturePayload(initiatorIdentity, initiatorEphemeral, initiatorNonce),
    fromBase64(init.signature)
  );
  if (!initValid) {
    throw new Error('Handshake init signature verification failed');
  }

  const ephemeral = generateX25519KeyPair();
  const sharedSecret = sharedKey(ephemeral.secretKey, initiatorEphemeral);
  if (!sharedSecret) {
    throw new Error('X25519 key agreement produced no shared secret');
  }

  const salt = sha256(concatBytes(initiatorEphemeral, ephemeral.publicKey));
  const keys = deriveSessionKeys(sharedSecret, salt);
  const responseNonce = randomBytes(32);
  const signature = edSign(
    identity.secretKey,
    responseSignaturePayload(
      initiatorIdentity,
      initiatorEphemeral,
      ephemeral.publicKey,
      responseNonce
    )
  );

  const session = new SecureSession({
    sessionId: toHex(salt.subarray(0, 8)),
    localPeerId: peerId,
    remotePeerId: init.peerId,
    remoteIdentityPublicKey: initiatorIdentity,
    sendKey: keys.responderToInitiator,
    receiveKey: keys.initiatorToResponder,
  });

  return {
    response: {
      peerId,
      identityPublicKey: toBase64(identity.publicKey),
      ephemeralPublicKey: toBase64(ephemeral.publicKey),
      nonce: toBase64(responseNonce),
      signature: toBase64(signature),
    },
    session,
  };
}

export function finalizeHandshake(
  pending: PendingHandshake,
  response: HandshakeResponse,
  identity: IdentityKeyPair
): SecureSession {
  const responderIdentity = fromBase64(response.identityPublicKey);
  const responderEphemeral = fromBase64(response.ephemeralPublicKey);
  const responseNonce = fromBase64(response.nonce);

  const responseValid = edVerify(
    responderIdentity,
    responseSignaturePayload(
      identity.publicKey,
      pending.ephemeralPublicKey,
      responderEphemeral,
      responseNonce
    ),
    fromBase64(response.signature)
  );
  if (!responseValid) {
    throw new Error('Handshake response signature verification failed');
  }

  const sharedSecret = sharedKey(pending.ephemeralSecretKey, responderEphemeral);
  if (!sharedSecret) {
    throw new Error('X25519 key agreement produced no shared secret');
  }

  const salt = sha256(concatBytes(pending.ephemeralPublicKey, responderEphemeral));
  const keys = deriveSessionKeys(sharedSecret, salt);

  return new SecureSession({
    sessionId: toHex(salt.subarray(0, 8)),
    localPeerId: pending.init.peerId,
    remotePeerId: response.peerId,
    remoteIdentityPublicKey: responderIdentity,
    sendKey: keys.initiatorToResponder,
    receiveKey: keys.responderToInitiator,
  });
}

export interface SecureSessionParams {
  readonly sessionId: string;
  readonly localPeerId: string;
  readonly remotePeerId: string;
  readonly remoteIdentityPublicKey: Uint8Array;
  readonly sendKey: Uint8Array;
  readonly receiveKey: Uint8Array;
}

/**
 * Post-handshake session. Each direction has its own AEAD key, so nonce
 * counters can never collide across directions.
 */
export class SecureSession {
  readonly sessionId: string;
  readonly localPeerId: string;
  readonly remotePeerId: string;
  readonly remoteIdentityPublicKey: Uint8Array;

  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  private readonly sendSalt: Uint8Array;

  private sendCounter = 0;
  private highestReceived = -1;
  private readonly seenSequences = new Set<number>();

  constructor(params: SecureSessionParams) {
    this.sessionId = params.sessionId;
    this.localPeerId = params.localPeerId;
    this.remotePeerId = params.remotePeerId;
    this.remoteIdentityPublicKey = params.remoteIdentityPublicKey;
    this.sendKey = params.sendKey;
    this.receiveKey = params.receiveKey;
    this.sendSalt = randomBytes(SALT_LENGTH);
  }

  encrypt(plaintext: Uint8Array): CryptoEnvelope {
    const sequence = this.sendCounter;
    this.sendCounter += 1;

    const nonce = concatBytes(this.sendSalt, toBigEndian64(sequence));
    const ciphertext = new XChaCha20Poly1305(this.sendKey).seal(
      nonce,
      plaintext,
      this.additionalData()
    );

    return {
      version: ENVELOPE_VERSION,
      sessionId: this.sessionId,
      senderPeerId: this.localPeerId,
      nonce: toBase64(nonce),
      ciphertext: toBase64(ciphertext),
    };
  }

  decrypt(envelope: CryptoEnvelope): Uint8Array {
    if (envelope.version !== ENVELOPE_VERSION) {
      throw new Error(`Unsupported envelope version: ${envelope.version}`);
    }
    if (envelope.sessionId !== this.sessionId) {
      throw new Error('Envelope belongs to a different session');
    }

    const nonce = fromBase64(envelope.nonce);
    if (nonce.length !== NONCE_LENGTH) {
      throw new Error(`Nonce must be ${NONCE_LENGTH} bytes, got ${nonce.length}`);
    }

    const sequence = fromBigEndian64(nonce.slice(SALT_LENGTH));
    if (sequence <= this.highestReceived - REPLAY_WINDOW) {
      throw new Error('Replay rejected: sequence outside of the sliding window');
    }
    if (this.seenSequences.has(sequence)) {
      throw new Error('Replay rejected: nonce already seen');
    }

    const plaintext = new XChaCha20Poly1305(this.receiveKey).open(
      nonce,
      fromBase64(envelope.ciphertext),
      this.additionalData()
    );
    if (!plaintext) {
      throw new Error('Decryption failed: bad key, nonce or tampered ciphertext');
    }

    this.remember(sequence);
    return plaintext;
  }

  decryptToText(envelope: CryptoEnvelope): string {
    return bytesToUtf8(this.decrypt(envelope));
  }

  private additionalData(): Uint8Array {
    const [first, second] = [this.localPeerId, this.remotePeerId].sort();
    return utf8ToBytes(`sovereign-origin/envelope/v1|${this.sessionId}|${first}|${second}`);
  }

  private remember(sequence: number): void {
    this.seenSequences.add(sequence);
    if (sequence > this.highestReceived) {
      this.highestReceived = sequence;
    }
    const cutoff = this.highestReceived - REPLAY_WINDOW;
    for (const seen of this.seenSequences) {
      if (seen <= cutoff) this.seenSequences.delete(seen);
    }
  }
}

export type { KeyPair };
