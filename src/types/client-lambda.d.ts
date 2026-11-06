// Minimal types for the Lambda calls this repo makes. Provided
// by the nodejs20.x runtime and kept out of package.json for the same reason
// as client-sesv2.d.ts: a package-lock.json change replaces the shared layer.
declare module '@aws-sdk/client-lambda' {
  export interface InvokeCommandInput {
    FunctionName?: string;
    InvocationType?: 'Event' | 'RequestResponse' | 'DryRun';
    Payload?: Uint8Array;
  }
  export class InvokeCommand {
    constructor(input: InvokeCommandInput);
  }
  export class LambdaClient {
    constructor(config: Record<string, unknown>);
    send(command: InvokeCommand): Promise<{ FunctionError?: string; Payload?: Uint8Array }>;
  }
}
