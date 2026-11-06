#!/usr/bin/env node
// Removes one test member's files (all versions), table rows and archive rows
// through incore-member-retention-job. A dry run unless --delete is passed;
// the job refuses a real member. Run with admin AWS credentials:
//   node scripts/purgeTestMember.mjs --brand forca --member <id> [--delete]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const brand = arg('brand');
const memberId = arg('member');
const dryRun = !process.argv.includes('--delete');
if (!memberId || !['forca', 'incore'].includes(brand)) {
  console.error('Usage: node scripts/purgeTestMember.mjs --brand forca|incore --member <id> [--delete]');
  process.exit(1);
}

const out = path.join(mkdtempSync(path.join(tmpdir(), 'purge-')), 'result.json');
const meta = JSON.parse(execFileSync('aws', [
  'lambda', 'invoke', '--region', 'eu-central-1', '--function-name', 'incore-member-retention-job',
  '--cli-binary-format', 'raw-in-base64-out',
  '--payload', JSON.stringify({ job: 'purge_member', memberId, brand, dryRun }), out,
], { encoding: 'utf8' }));
const result = JSON.parse(readFileSync(out, 'utf8'));
if (meta.FunctionError) {
  console.error('Refused or failed:', result.errorMessage);
  process.exit(1);
}

for (const o of result.objects) console.log(`${String(o.size).padStart(10)}  ${o.key}  ${o.versionId ?? ''}`);
console.log(`\n${dryRun ? 'DRY RUN — nothing was deleted' : 'DELETED'}: ${result.objects.length} object version(s), `
  + `${(result.totalBytes / 1024 / 1024).toFixed(2)} MB, ${result.rows} table row(s), ${result.archiveRows} archive row(s)`);
