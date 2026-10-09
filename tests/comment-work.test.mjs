// Lossless data transport and complete accounting across independent admissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createCommentData, captureObservation, textPages } from '../src/comment-data.mjs';
import { prepareComments, checkPublication, publicationPages, publisherItem } from '../src/comment-work.mjs';
import { publicationItems, restoreSavedCommentText, recordPublishResult } from '../src/comments.mjs';

const snapshot = { repository: 'org/project/repo', prId: 42, base: 'a'.repeat(40), head: 'b'.repeat(40), files: ['/source.ts'], scope: 'pr' };
const finding = i => ({ id: `F-${i}`, severity: 'high', summary: `Distinct defect ${i}`, location: 'head:/source.ts:1', evidence: `Evidence ${i}`, counterevidence: 'Checked caller.', suggestion: `Fix ${i}` });
const reviewFor = (count = 1, report = '') => ({ id: '01234567', target: { organization: 'org', project: 'project', repositoryId: 'repo', pullRequestId: 42 }, snapshot, attempts: new Map(), outputLanguage: 'en', final: { report, dispositions: Array.from({ length: count }, (_, i) => ({ id: `F-${i}`, status: 'CONFIRMED', reason: 'Verified.', verifiedFinding: finding(i) })), newFindings: [] }, toolText: [] });
const comment = f => ({ findingId: f.id, severity: 'high', path: '/source.ts', startLine: 1, endLine: 1, anchor: 'source();', body: `issue (high): ${f.id}\n\nDistinct supported trigger, impact and correction.` });
async function storeFor(t) { const store = await createCommentData(); t.after(() => store.dispose()); return store; }
const ready = payload => ({ status: 'READY', comments: payload.findings.map(comment), skipped: [], summaryDetails: typeof payload.report === 'string' ? payload.report : '' });

test('multi-million-character evidence stays exact on disk and out of every planning admission', async t => {
  const store = await storeFor(t), review = reviewFor();
  for (const size of [2200000, 3307749]) {
    const source = 'x'.repeat(size - 2) + '\n終';
    review.toolText.push(await captureObservation(store, 'arbitrary_tool', { opaque: '/large.ts', revision: snapshot.head }, source));
    assert.equal(await store.read(review.toolText.at(-1).outputRef), source);
  }
  const inputs = [];
  const plan = await prepareComments(review, store, async (payload, validate) => {
    inputs.push(payload);
    const index = (await store.read(payload.evidenceIndex)).trim().split('\n').map(JSON.parse);
    assert.equal(index.length, 2);
    assert.deepEqual(index.map(item => item.output.characters), [2200000, 3307749]);
    assert.ok(JSON.stringify(payload).length < 10000);
    assert.equal(payload.dispositions[0].verifiedFinding, undefined);
    return validate(ready(payload), {});
  });
  assert.equal(inputs.length, 1);
  assert.equal(plan.comments.length, 1);
});

test('large file lists, findings and report pages have no aggregate quota and retain every distinct item', async t => {
  const store = await storeFor(t);
  const advice = Array.from({ length: 1400 }, (_, i) => `Suggestion ${i}: preserve the distinct supported tradeoff for this component.\n`).join('');
  const review = reviewFor(260, advice);
  review.snapshot = { ...snapshot, files: ['/source.ts', ...Array.from({ length: 8000 }, (_, i) => `/changed/module-${i}.ts`)] };
  const requests = [];
  const plan = await prepareComments(review, store, async (payload, validate) => {
    requests.push(payload);
    assert.ok(JSON.stringify(payload).length < 48000);
    assert.ok(payload.snapshot.files.azprData);
    assert.equal(await store.read(payload.reportReference), advice);
    return validate({ ...ready(payload), summaryDetails: typeof payload.report === 'string' ? payload.report : JSON.parse(await store.read(payload.report.azprData)) }, {});
  });
  assert.ok(requests.length > 5);
  assert.equal(plan.comments.length, 260);
  assert.equal(new Set(plan.comments.map(c => c.findingId)).size, 260);
  for (let i = 0; i < 1400; i++) assert.equal(plan.summary.content.split(`Suggestion ${i}:`).length, 2);
  const pages = publicationPages(plan);
  assert.ok(pages.length > 5);
  assert.equal(pages.flatMap(publicationItems).length, 261);
  assert.equal(pages.filter(page => page.summary).length, 1);
  const item = await publisherItem(store, plan.summary);
  assert.ok(item.content.length < 500);
  assert.equal(await store.read(item.savedContent), plan.summary.content);
  assert.equal(restoreSavedCommentText({ body: item.content }, [plan.summary]).input.body, plan.summary.content);
});

test('one huge verified field becomes a reference instead of an oversized singleton page', async t => {
  const store = await storeFor(t), review = reviewFor();
  review.final.dispositions[0].verifiedFinding.evidence = 'Evidence '.repeat(200000);
  await prepareComments(review, store, async (payload, validate) => {
    assert.ok(JSON.stringify(payload).length < 10000);
    assert.equal(JSON.parse(await store.read(payload.findings[0].evidence.azprData)), review.final.dispositions[0].verifiedFinding.evidence);
    return validate(ready(payload), {});
  });
});

test('many short findings get small independent working sets without losing any finding', async t => {
  const store=await storeFor(t),review=reviewFor(24),assignments=[];
  const plan=await prepareComments(review,store,async(payload,validate)=>{
    assert.ok(payload.findings.length<=4);
    assignments.push(payload.findings.map(f=>f.id));
    return validate(ready(payload),{});
  });
  assert.equal(assignments.length,6);
  assert.deepEqual(assignments.flat(),review.final.dispositions.map(f=>f.id));
  assert.equal(plan.comments.length,24);
});

test('successful checkpoints retain completed comments and advice without repeating their assignment', async t => {
  const store = await storeFor(t), review = reviewFor(3);
  let calls = 0;
  const plan = await prepareComments(review, store, async (payload, validate) => {
    calls++;
    if (calls === 1) return validate({ status: 'CONTINUE', comments: [comment(payload.findings[0])], skipped: [], summaryDetails: 'Advice one.', continuation: 'Checked metadata; next discussion cursor is 2.' }, {});
    assert.deepEqual(payload.findings.map(f => f.id), ['F-1', 'F-2']);
    assert.match(payload.continuation, /cursor is 2/);
    assert.ok(payload.priorPlanning);
    const references=(await store.read(payload.priorPlanning)).trim().split('\n').map(JSON.parse);
    const previous=JSON.parse(await store.read(references[0]));
    assert.deepEqual(previous.input.findings.map(f=>f.id),['F-0','F-1','F-2']);
    assert.equal(previous.result.comments[0].findingId,'F-0');
    return validate({ ...ready(payload), summaryDetails: 'Advice two.' }, {});
  });
  assert.equal(calls, 2);
  assert.equal(plan.comments.length, 3);
  assert.match(plan.summary.content, /Advice one\.[\s\S]*Advice two\./);
});

for(const checking of [false,true]) test(`${checking?'publication checks':'planning'} reject reworded checkpoints with identical read records`,async t=>{
  const store=await storeFor(t),review=reviewFor();let calls=0;
  review.plan=await prepareComments(review,store,(payload,validate)=>validate(ready(payload),{}));
  await assert.rejects((checking?checkPublication:prepareComments)(review,store,async(payload,validate)=>{
    calls++;
    (review.commentEvidence??=[]).push({sessionID:`new-${calls}`,tool:'read',
      input:calls===1?{file:'same-file',offset:1}:{offset:1,file:'same-file'},result:{sha256:'same-exact-output'}});
    return validate({status:'CONTINUE',comments:[],skipped:[],continuation:`Reworded continuation ${calls}`},{completedTools:1});
  }),/without progress/);
  assert.equal(calls,2);
  assert.equal(review.attempts.size,0);
});

test('checkpoints can advance through distinct original read ranges without a total session cap',async t=>{
  const store=await storeFor(t),review=reviewFor();let calls=0;
  const plan=await prepareComments(review,store,async(payload,validate)=>{
    calls++;
    (review.commentEvidence??=[]).push({tool:'read',input:{file:'source',offset:calls},result:{sha256:`page-${calls}`}});
    return validate(calls<12?{status:'CONTINUE',comments:[],skipped:[],continuation:`Next source range ${calls+1}`} : ready(payload),{});
  });
  assert.equal(calls,12);assert.equal(plan.comments.length,1);
});

for (const checking of [false, true]) test(`${checking ? 'publication checks' : 'planning'} preserve a successful checkpoint handoff supplied as reason`, async t => {
  const store = await storeFor(t), review = reviewFor();
  if (checking) review.plan = await prepareComments(review, store, (payload, validate) => validate(ready(payload), {}));
  const raw = { status: 'CONTINUE', comments: [], skipped: [], reason: 'Read original record abc, offset 2 next; no finding completed.' };
  const before = structuredClone(raw), record = { completedTools: 1 }; let calls = 0;
  await (checking ? checkPublication : prepareComments)(review, store, async (payload, validate) => {
    if (++calls === 1) {
      const result = await validate(raw, record);
      assert.equal(result.reason, raw.reason);
      return result;
    }
    assert.equal(payload.continuation, raw.reason);
    return validate(checking ? { status: 'READY', comments: [], skipped: [] } : ready(payload), { completedTools: 1 });
  });
  assert.equal(calls, 2);
  assert.deepEqual(raw, before);
  assert.equal(record.checkpointCorrection, 'copy-reason-to-continuation');
  assert.equal(review.attempts.size, 0);
});

for (const checking of [false, true]) test(`${checking ? 'publication checks' : 'planning'} do not turn missing, invalid or failed handoffs into progress`, async t => {
  const store = await storeFor(t), review = reviewFor();
  if (checking) review.plan = await prepareComments(review, store, (payload, validate) => validate(ready(payload), {}));
  for (const fields of [
    { status: 'CONTINUE', reason: '' },
    { status: 'CONTINUE', reason: 'Unfinished work', continuation: '' },
    { status: 'CONTINUE', reason: 'Unfinished work', continuation: null },
    { status: 'INCOMPLETE', reason: 'Required source unavailable' },
  ]) {
    const record = { completedTools: 1 }; let calls = 0;
    await assert.rejects((checking ? checkPublication : prepareComments)(review, store, (payload, validate) => {
      calls++;
      return validate({ ...fields, comments: [], skipped: [] }, record);
    }), /checkpoint|incomplete/i);
    assert.equal(calls, 1);
    assert.equal(record.checkpointCorrection, undefined);
    assert.equal(review.attempts.size, 0);
  }
});

for (const kind of ['repeat', 'unassigned', 'failure']) test(`checkpoint ${kind} fails closed without silently retrying or saving a partial plan`, async t => {
  const store = await storeFor(t), review = reviewFor(2); let calls = 0;
  await assert.rejects(prepareComments(review, store, async (payload, validate) => {
    calls++;
    if (kind === 'failure') throw new Error('Execution failed.');
    return validate({ status: 'CONTINUE', comments: kind === 'unassigned' ? [comment(finding(0))] : [], skipped: [], continuation: 'Same unfinished cursor.' }, {});
  }), kind === 'failure' ? /Execution failed/ : kind === 'repeat' ? /without progress/ : /unassigned/);
  assert.equal(calls, kind === 'failure' ? 1 : 2);
});

test('publication checks can page with exact cursors and reject incomplete checks before any write', async t => {
  const store = await storeFor(t), review = reviewFor();
  review.plan = await prepareComments(review, store, (payload, validate) => validate(ready(payload), {}));
  let calls = 0;
  await checkPublication(review, store, async (payload, validate) => {
    calls++;
    assert.equal(payload.commentWork.kind, 'publication-check');
    assert.deepEqual(payload.findings, []);
    assert.equal(payload.evidenceIndex, undefined);
    if (calls === 1) return validate({ status: 'CONTINUE', comments: [], skipped: [], continuation: 'All prior discussion pages checked; next opaque cursor 7.' }, { completedTools: 1 });
    assert.match(payload.continuation, /cursor 7/);
    return validate({ status: 'READY', comments: [], skipped: [] }, { completedTools: 1 });
  });
  assert.equal(calls, 2);
  assert.equal(review.attempts.size, 0);
  await assert.rejects(checkPublication(review, store, (payload, validate) => validate({ status: 'INCOMPLETE', comments: [], skipped: [], reason: 'HEAD changed.' }, { completedTools: 1 })), /HEAD changed/);
  assert.equal(review.attempts.size, 0);
});

test('publication checks carry saved claims and their own exact reads without restarting source review',async t=>{
  const store=await storeFor(t),review=reviewFor();
  review.plan=await prepareComments(review,store,(payload,validate)=>validate(ready(payload),{}));
  review.snapshot={...review.snapshot,files:[...review.snapshot.files,'/unassigned.ts']};
  review.final.report='Earlier coverage limitations';review.final.reviewWarnings=['Initial source unavailable'];
  review.commentEvidence=[{tool:'earlier_source',input:{path:'/source.ts'},result:{sha256:'original-plan-source'}}];
  let calls=0;
  await checkPublication(review,store,async(payload,validate)=>{
    calls++;
    for(const key of ['report','reportReference','reviewWarnings','dispositions','evidenceIndex','priorPlanning']) assert.equal(Object.hasOwn(payload,key),false);
    assert.deepEqual(payload.snapshot.files,['/source.ts']);
    assert.equal(payload.commentWork.immutableAnchorsVerified,true);
    const inline=payload.savedItems.find(item=>item.kind!=='summary');
    assert.equal(inline.content,review.plan.comments[0].content);
    for(const key of ['anchor','startLine','endLine','startOffset','endOffset']) assert.equal(Object.hasOwn(inline,key),false);
    if(calls===1){
      assert.equal(payload.workEvidence,undefined);
      review.commentEvidence.push({tool:'current_discussions',input:{cursor:7},result:{sha256:'discussion-page'}});
      return validate({status:'CONTINUE',comments:[],skipped:[],continuation:'Next discussion cursor 8.'},{completedTools:1});
    }
    const records=(await store.read(payload.workEvidence)).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records,review.commentEvidence.slice(1));
    assert.match(payload.continuation,/cursor 8/);
    return validate({status:'READY',comments:[],skipped:[]},{completedTools:1});
  });
  assert.equal(calls,2);assert.equal(review.attempts.size,0);
});

test('publication receipts reject repeated thread IDs across pages without overwriting earlier outcomes', async t => {
  const store = await storeFor(t), review = reviewFor(2);
  const plan = await prepareComments(review, store, (payload, validate) => validate(ready(payload), {}));
  recordPublishResult({ status: 'DONE', posted: [{ findingId: 'F-0', threadId: 7 }] }, { ...review, plan: { comments: [plan.comments[0]] } });
  await assert.rejects(async () => recordPublishResult({ status: 'DONE', posted: [{ findingId: 'F-1', threadId: '7' }] }, { ...review, plan: { comments: [plan.comments[1]] } }), /Invalid model-reported/);
  assert.equal(review.attempts.size, 1);
});

test('lossless UTF-16 pages include final bytes and detect altered artifacts; temporary data is removed on disposal', async () => {
  const store = await createCommentData();
  try {
    const value = '😀'.repeat(8000) + '\nlast line\n';
    assert.equal(textPages(value).map(p => p.text).join(''), value);
    const ref = await store.put(value);
    const rows = (await readFile(ref.pages, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.map(row => row.text).join(''), value);
    assert.ok(rows.every(row => !/[\uD800-\uDBFF]$/.test(row.text)));
    await writeFile(ref.file, 'altered');
    await assert.rejects(store.read(ref), /changed/);
  } finally { await store.dispose(); }
  await assert.rejects(access(store.directory), /ENOENT/);
});
