import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';

// Mirrors dynamo.ts/s3.ts's shared-client-instance convention.
export const cloudwatch = new CloudWatchClient({});
export const cloudwatchLogs = new CloudWatchLogsClient({});
