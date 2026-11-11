// Minimal types for the one AWS Encryption SDK call
// functions/cognitoCustomEmailSender.ts makes. The package is installed in
// vendor/cognito-crypto (its own lockfile) and bundled into that one function
// by scripts/build.mjs, so it is not visible to the root tsc.
declare module '@aws-crypto/client-node' {
  export const CommitmentPolicy: { REQUIRE_ENCRYPT_ALLOW_DECRYPT: unknown };
  export class KmsKeyringNode {
    constructor(input: { keyIds?: string[]; generatorKeyId?: string });
  }
  export function buildClient(policy: unknown): {
    decrypt(keyring: KmsKeyringNode, ciphertext: Buffer): Promise<{ plaintext: Buffer }>;
  };
}
