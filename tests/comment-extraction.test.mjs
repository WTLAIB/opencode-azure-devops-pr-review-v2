import test from 'node:test';
import assert from 'node:assert/strict';
import { readReviewOutput } from '../src/output.mjs';

const plan = { status: 'READY', comments: [], skipped: [{ findingId: 'F-1', reason: 'Already discussed.' }] };
const response = text => ({ info: { finish: 'stop' }, parts: [{ type: 'text', text }] });
const fenced = value => '```json\n' + JSON.stringify(value) + '\n```';

test('a unique strict comment plan survives surrounding examples and retains notes', () => {
  const notes = 'Local check: {"stock": 7}; Python example {\'batch\': []}.';
  for (const role of ['azpr-review-comment-plan', 'azpr-deep-comment-plan']) {
    const parsed = readReviewOutput(response(fenced(plan) + '\n\n' + notes), role);
    assert.deepEqual(parsed.envelope, plan);
    assert.equal(parsed.surroundingText, notes);
    assert.deepEqual(parsed.corrections, [{ action: 'extract-comment-plan-envelope' }]);
  }
});

test('competing and unfinished comment plans cannot silently select a winner', () => {
  for (const other of [JSON.stringify(plan), '{"status":"READY"}', '{"comments":[', '{"status":"INCOMPLETE","comments":[],"skipped":[]}']) {
    assert.throws(() => readReviewOutput(response(fenced(plan) + '\n' + other), 'azpr-review-comment-plan'), /required JSON envelope/);
  }
});

test('comment extraction does not repair syntax, duplicate keys or failed execution', () => {
  for (const text of ['{"status":"READY","comments":[],"skipped":[],}', '{"status":"READY","status":"INCOMPLETE","comments":[],"skipped":[]}']) {
    assert.throws(() => readReviewOutput(response('```json\n' + text + '\n```\nNote: {"value":1}'), 'azpr-review-comment-plan'));
  }
  assert.throws(() => readReviewOutput({ ...response(fenced(plan)), info: { finish: 'length' } }, 'azpr-review-comment-plan'), /did not finish successfully/);
});

test('source checks and publication receipts retain their strict extraction policy', () => {
  for (const role of ['azpr-review-check', 'azpr-review-comment-publish']) {
    assert.throws(() => readReviewOutput(response(fenced(plan) + '\nNote: {"value":1}'), role), /required JSON envelope/);
  }
});
