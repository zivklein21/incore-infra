import type { SQSEvent } from 'aws-lambda';
import { recordSystemAlert } from '../lib/alerts';

// SQS-triggered (see dlq.tf) — consumes the on-failure destination queue
// wired to every EventBridge-scheduled function (aws_lambda_function_event_invoke_config
// in dlq.tf). Async Lambda invocations use up to 2 automatic retries before
// AWS delivers a RetriesExhausted payload here; this turns that payload
// into a SystemAlertItem so it shows up in the Admin Portal Dashboard's
// alert feed (adminGetSystemAlerts.ts) next to in-code alerts.
//
// Payload shape delivered by Lambda's own destination mechanism (not
// something this repo controls) — see
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html#invocation-async-destinations
interface LambdaFailureDestinationPayload {
  requestContext?: {
    functionArn?: string;
    condition?: string; // 'RetriesExhausted' | 'EventAgeExceeded' | ...
    approximateInvokeCount?: number;
  };
  responsePayload?: {
    errorType?: string;
    errorMessage?: string;
  };
}

function functionNameFromArn(arn: string | undefined): string {
  if (!arn) return 'unknown';
  const parts = arn.split(':');
  return parts[parts.length - 1] ?? 'unknown';
}

export async function handler(event: SQSEvent): Promise<void> {
  await Promise.all(event.Records.map(async (record) => {
    let payload: LambdaFailureDestinationPayload;
    try {
      payload = JSON.parse(record.body);
    } catch {
      await recordSystemAlert({
        severity: 'warning',
        source: 'dlq:unparseable',
        message: 'Received a DLQ message that was not valid JSON.',
        context: { body: record.body },
      });
      return;
    }

    const functionName = functionNameFromArn(payload.requestContext?.functionArn);
    await recordSystemAlert({
      severity: 'critical',
      source: `dlq:${functionName}`,
      message: payload.responsePayload?.errorMessage ?? 'Async invocation failed with no error message.',
      context: {
        condition: payload.requestContext?.condition,
        approximateInvokeCount: payload.requestContext?.approximateInvokeCount,
        errorType: payload.responsePayload?.errorType,
      },
    });
  }));
}
