export interface ClientIdCrypto {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
}

export declare function createClientId(cryptoApi?: ClientIdCrypto, random?: () => number): string;
