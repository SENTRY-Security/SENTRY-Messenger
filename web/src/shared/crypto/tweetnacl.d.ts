declare module 'tweetnacl' {
  interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  interface SignDetached {
    (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
  }

  const nacl: {
    sign: {
      keyPair(): KeyPair;
      detached: SignDetached;
    };
    box: {
      keyPair(): KeyPair;
    };
    scalarMult(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
    lowlevel?: {
      crypto_hash(out: Uint8Array, message: Uint8Array, n: number): number;
    };
  };

  export default nacl;
}
