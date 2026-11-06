// Minimal types for the one SES v2 call lib/mailer.ts makes. The real
// package is provided by the Lambda nodejs20.x runtime (full AWS SDK v3)
// and kept external in scripts/build.mjs; it is deliberately not a
// package.json dependency, because any package-lock.json change re-stages
// the shared dependency layer and replaces the layer version every other
// function is pinned to (see lambdas.tf's null_resource.stage_layer).
declare module '@aws-sdk/client-sesv2' {
  export interface SendEmailCommandInput {
    FromEmailAddress: string;
    Destination: { ToAddresses: string[] };
    ReplyToAddresses?: string[];
    ConfigurationSetName?: string;
    Content: {
      Simple: {
        Subject: { Data: string; Charset?: string };
        Body: { Html?: { Data: string; Charset?: string }; Text?: { Data: string; Charset?: string } };
      };
    };
  }
  export class SendEmailCommand {
    constructor(input: SendEmailCommandInput);
  }
  export class SESv2Client {
    constructor(config: { region: string });
    send(command: SendEmailCommand): Promise<{ MessageId?: string }>;
  }
}
