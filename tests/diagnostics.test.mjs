import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createDiagnostics, createStageTiming, collectToolObservations, diagnosticResponse } from '../src/diagnostics.mjs';

test('V2 execution timing records error outcomes without source content or call IDs', () => {
  let now = 0; const timing = createStageTiming(() => now);
  timing.promptStarted(); timing.modelRequest(); now = 2; timing.toolStarted('private-id', 'custom_read');
  now = 6; timing.toolEnded('private-id', 'error');
  now = 7; timing.toolEnded('private-id', 'completed');
  now = 8; timing.promptSettled('returned'); now = 10;
  const result = timing.finish();
  assert.equal(result.unfinishedTools, 0); assert.equal(result.toolActiveMs, 4);
  assert.equal(result.lastToolToResponseMs, 2);
  assert.equal(result.toolCalls[0].outcome, 'error');
  assert.doesNotMatch(JSON.stringify(result), /private-id/);
});

test('timing ignores unknown and invalid outcomes without inventing a terminal event', () => {
  let now = 0; const timing = createStageTiming(() => now);
  timing.promptStarted(); now = 3; timing.toolStarted('known', 'custom_read');
  now = 5; timing.toolEnded('known', 'unsupported'); timing.toolEnded('unknown', 'error');
  now = 7; timing.promptSettled('interrupted'); now = 10; timing.toolEnded('known', 'error');
  const result = timing.finish();
  assert.equal(result.unfinishedTools, 1); assert.equal(result.toolActiveMs, null);
  assert.equal(result.toolCalls[0].outcome, null);
});

test('V2 tool observations count overlapping outcomes without logging arguments or certifying source', () => {
  const result = collectToolObservations({
    toolCalls: new Map(['a', 'b', 'c', 'd', 'e'].map(id => [id, 'PRIVATE_TOOL_NAME'])),
    returnedTools: new Set(['a', 'c', 'd']),
    terminalTools: new Map([['a', 'completed'], ['b', 'error'], ['c', 'completed'], ['d', 'completed']]),
    failedTools: new Set(['b']), reportedToolErrors: new Set(['b', 'c']), truncatedTools: new Set(['c', 'd']),
    arguments: 'PRIVATE_ARGUMENTS', output: 'PRIVATE_SOURCE',
  });
  assert.deepEqual(result, {
    registered: 5, afterHook: 4, hostCompleted: 3, hostErrors: 1, reportedErrors: 2,
    truncated: 2, observedErrors: 2, unverifiedResults: 1, withoutOutcome: 1,
    evidenceValidity: 'not-assessed', recoveredReads: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|rejectedSubmissions/);
});

test('V2 response diagnostics retain visible text and model/error identity but omit provider bodies', () => {
  const result = diagnosticResponse({
    info: { id: 'msg_fixture', model: { providerID: 'fixture', id: 'model' }, finish: 'error',
      error: { type: 'api_error', message: 'Visible failure', status: 403, response: { body: 'PRIVATE_BODY' } },
      headers: { authorization: 'PRIVATE_HEADER' }, structured: { ignored: 'PRIVATE_NATIVE' } },
    parts: [{ type: 'text', text: 'Visible answer' }, { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'tool', output: 'PRIVATE_TOOL' }],
  });
  assert.deepEqual(result, {
    messageID: 'msg_fixture', model: 'model', provider: 'fixture', finish: 'error',
    error: { type: 'api_error', message: 'Visible failure', status: 403 }, text: 'Visible answer', textCharacters: 14,
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|structured/);
});

test('stage timing separates overlapping tool intervals from model request windows',()=>{
  let now=0;const timing=createStageTiming(()=>now);
  now=2;timing.promptStarted();now=4;timing.modelRequest();
  now=10;timing.toolStarted('private-call-a','custom_read');
  now=14;timing.toolStarted('private-call-b','custom_read');
  now=20;timing.toolEnded('private-call-a');now=24;timing.toolEnded('private-call-b');
  now=30;timing.modelRequest();now=60;timing.promptSettled('returned');now=65;
  const result=timing.finish();
  assert.equal(result.promptMs,58);assert.equal(result.toolActiveMs,14);
  assert.equal(result.lastToolToResponseMs,36);assert.equal(result.responseProcessingMs,5);
  assert.deepEqual(result.modelRounds.map(r=>[r.durationMs,r.toolActiveMs,r.outsideToolMs,r.endReason]),
    [[26,14,12,'next-request'],[30,0,30,'returned']]);
  assert.deepEqual(result.toolCalls.map(t=>t.durationMs),[10,10]);
  assert.doesNotMatch(JSON.stringify(result),/private-call/);
});
test('stage timing leaves unmatched tools unknown on interruption and ignores late completions',()=>{
  let now=0;const timing=createStageTiming(()=>now);
  timing.promptStarted();timing.modelRequest();
  now=2;timing.toolStarted('read','custom_read');now=12;timing.promptSettled('interrupted');now=20;
  const result=timing.finish();
  assert.equal(result.promptMs,12);assert.equal(result.responseProcessingMs,8);
  assert.equal(result.toolActiveMs,null);assert.equal(result.unfinishedTools,1);
  assert.equal(result.toolCalls[0].durationMs,null);
  assert.equal(result.lastToolToResponseMs,null);
  assert.equal(result.modelRounds[0].outsideToolMs,null);
  assert.equal(result.modelRounds[0].endReason,'interrupted');
  now=30;timing.toolEnded('read');timing.modelRequest();
  assert.deepEqual(timing.finish(),result);
});
test('stage timing counts each tool once and does not invent a last read for tool-free stages',()=>{
  let now=0;const timing=createStageTiming(()=>now);
  timing.promptStarted();timing.modelRequest();now=2;timing.toolStarted('a','read');
  now=3;timing.toolStarted('a','read');now=7;timing.toolEnded('a');
  now=8;timing.toolEnded('a');now=9;timing.promptSettled('rejected');
  const result=timing.finish();assert.equal(result.toolActiveMs,5);assert.equal(result.toolCalls.length,1);
  const empty=createStageTiming(()=>now);empty.promptStarted();empty.modelRequest();
  now=10;empty.promptSettled('returned');const repaired=empty.finish();
  assert.equal(repaired.toolActiveMs,0);assert.equal(repaired.lastToolToResponseMs,null);
  assert.deepEqual(repaired.toolCalls,[]);assert.equal(repaired.modelRounds.length,1);
});
test('stage timing records an early stage stop without fabricating a prompt response',()=>{
  let now=0;const timing=createStageTiming(()=>now);now=5;
  const result=timing.finish();assert.equal(result.elapsedMs,5);
  assert.equal(result.promptMs,null);assert.equal(result.responseProcessingMs,null);
  assert.equal(result.responseOutcome,null);assert.deepEqual(result.modelRounds,[]);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'azpr-debug-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory };
}
const run = { id: '01234567', mode: 'review', profile: 'review', origin: 'ses_test' };
const settings = { debug: { enabled: true, directory: '.azpr-v2-debug' }, outputLanguage: 'zh-TW', returnReport: 'receipt', shellToolPermission: 'ask' };
test('debug off makes no files or directories', async t => {
  const context = await fixture(t);
  const log = await createDiagnostics({ ...settings, debug: { enabled: false, directory: '.azpr-v2-debug' } }, context, run);
  await log.write('input.json', { private: 'source' });
  assert.equal(log.directory, ''); assert.deepEqual(await readdir(context.directory), []);
});
test('default V2 debug storage stays isolated from other integration directories', async t => {
  const context = await fixture(t);
  const source = new URL('../src/diagnostics.mjs', import.meta.url).href;
  const input = { ...settings, debug: { enabled: true, directory: '' } };
  const code = `import { createDiagnostics } from ${JSON.stringify(source)}; const log = await createDiagnostics(${JSON.stringify(input)}, ${JSON.stringify(context)}, ${JSON.stringify(run)}); process.stdout.write(log.directory);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: context.directory },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stdout.startsWith(join(context.directory, 'opencode', 'azpr-v2-debug') + '/'));
  assert.deepEqual(await readdir(join(context.directory, 'opencode')), ['azpr-v2-debug']);
});

test('project diagnostics are private, ignored by Git, unique, and never overwrite files', async t => {
  const context = await fixture(t);
  assert.equal(spawnSync('git', ['init', '-q', context.directory]).status, 0);
  const log = await createDiagnostics(settings, context, run);
  assert.equal(log.warnings.length, 0);
  const metadata = JSON.parse(await readFile(join(log.directory, 'run.json'), 'utf8'));
  assert.equal(metadata.shellToolPermission, 'ask');
  assert.equal(metadata.outputTransport, 'json-text');
  assert.equal(Object.hasOwn(metadata, 'structuredOutput'), false);
  await log.write('report.md', 'Private report');
  assert.equal((await stat(log.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(log.directory, 'report.md'))).mode & 0o777, 0o600);
  assert.equal(spawnSync('git', ['check-ignore', join(log.directory, 'report.md')], { cwd: context.directory }).status, 0);
  await log.write('report.md', 'Do not overwrite');
  assert.equal(await readFile(join(log.directory, 'report.md'), 'utf8'), 'Private report');
  assert.match(log.warnings.join(), /Could not save/);
  const next = await createDiagnostics(settings, context, run);
  assert.notEqual(next.directory, log.directory);
  await log.write('../escape.md', 'no');
  assert.match(log.warnings.join(), /escape/);
});
test('symlink paths are refused without writing to their destination', async t => {
  const context = await fixture(t), destination = await fixture(t);
  await symlink(destination.directory, join(context.directory, 'link'));
  const log = await createDiagnostics({ ...settings, debug: { enabled: true, directory: 'link/child' } }, context, run);
  assert.equal(log.directory, ''); assert.ok(log.warnings.length);
  assert.deepEqual(await readdir(destination.directory), []);
});
test('an unwritable debug target produces a warning, not an exception or overwrite', async t => {
  const context = await fixture(t);
  await writeFile(join(context.directory, '.azpr-v2-debug'), 'Existing user file');
  const log = await createDiagnostics(settings, context, run);
  assert.ok(log.warnings.length); assert.equal(log.directory, '');
  assert.equal(await readFile(join(context.directory, '.azpr-v2-debug'), 'utf8'), 'Existing user file');
});
