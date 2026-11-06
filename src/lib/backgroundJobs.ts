import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { BackgroundJob } from './backgroundJobTypes';

// Slow work that shouldn't hold up the signer's request. The current Lambda
// invokes itself asynchronously, so no queue or new API integration is needed;
// incoreWorkoutApi.ts picks the job up. Only callable from within that Lambda.

const lambda = new LambdaClient({});

/** Never throws: both PDFs are also generated on their first download. */
export async function runInBackground(job: BackgroundJob): Promise<void> {
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(job)),
    }));
  } catch (err) {
    console.error('[backgroundJobs] failed to start', job.job, err);
  }
}
