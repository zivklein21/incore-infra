import test from 'node:test';
import assert from 'node:assert/strict';
import { isBackgroundJob } from '../src/lib/backgroundJobTypes';

test('a queued job is recognized', () => {
  assert.equal(isBackgroundJob({ job: 'photo_consent_pdf', childId: 'c', logId: 'l' }), true);
});

test('an API request is never treated as a job', () => {
  assert.equal(isBackgroundJob({ routeKey: 'POST /submitFormPart', body: '{"job":"signed_form_pdf"}' }), false);
  assert.equal(isBackgroundJob(null), false);
});
