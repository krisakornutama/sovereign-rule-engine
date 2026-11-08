export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export type IdentityKeyPair = KeyPair;

export interface HandshakeInit {
  readonly peerId: string;
  readonly identityPublicKey: string;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface HandshakeResponse {
  readonly peerId: string;
  readonly identityPublicKey: string;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface CryptoEnvelope {
  readonly version: number;
  readonly sessionId: string;
  readonly senderPeerId: string;
  /** 24 bytes base64: 16-byte salt || 8-byte big-endian counter */
  readonly nonce: string;
  readonly ciphertext: string;
}
