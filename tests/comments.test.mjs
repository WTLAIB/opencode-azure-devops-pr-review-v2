import test from 'node:test';
import assert from 'node:assert/strict';
import { commentTarget, confirmedFindings, recordPublishResult, restoreSavedCommentText, validateCommentPlan } from '../src/comments.mjs';

const snapshot={head:'a'.repeat(40),prId:123,files:['/src/example.ts']};
const target=commentTarget('https://dev.azure.com/org/project/_git/repo/pullrequest/123',snapshot);
const draft=()=>({status:'READY',comments:[{findingId:'F-1',severity:'high',path:snapshot.files[0],startLine:2,endLine:2,anchor:'return value.name;',body:'issue (high): Missing null handling\n\nNull input throws. Add a guard and a regression test.'}],skipped:[]});
const verifiedFinding=()=>({id:'F-1',summary:'Missing guard',evidence:'Null input throws',counterevidence:'The caller allows null on the failing path.',severity:'high',location:'head:/src/example.ts:2',suggestion:'Add a guard and a regression test.'});
const review=()=>({target,snapshot,findings:[verifiedFinding()],final:{dispositions:[{id:'F-1',status:'CONFIRMED',verifiedFinding:verifiedFinding()}]},attempts:new Map()});
function planned(){
  const r=review();r.plan=validateCommentPlan(draft(),r);
  for(const c of r.plan.comments) r.attempts.set(c.marker,{findingId:c.findingId,state:'UNKNOWN'});
  return r;
}

test('PR target parsing is independent of MCP tools',()=>{
  assert.deepEqual(commentTarget('https://org.visualstudio.com/DefaultCollection/project/_git/repo/pullrequest/123',snapshot),target);
  assert.throws(()=>commentTarget('https://dev.azure.com/org/project/_git/repo/pullrequest/124',snapshot));
});
test('plan validates format and creates a stable marker, not provider evidence',()=>{
  const a=planned(),b=planned();
  assert.equal(a.plan.comments[0].marker,b.plan.comments[0].marker);
  assert.match(a.plan.comments[0].content,/<!-- azpr-comment:[a-f0-9]{32} -->$/);
  assert.equal(a.plan.comments[0].args,undefined);
});
test('incomplete plans expose an optional reason without manufacturing a usable plan', () => {
  for (const reason of [undefined, 'The current HEAD differs from the reviewed commit.']) {
    const result = { status: 'INCOMPLETE', comments: [], skipped: [], ...(reason ? { reason } : {}) };
    assert.throws(() => validateCommentPlan(result, review()), error => {
      assert.ok(error.message.includes(reason ?? 'The model did not explain'));
      assert.match(error.message, /No comments were published/);
      return true;
    });
  }
  for (const reason of [false, {}, '']) {
    assert.equal(validateCommentPlan({ ...draft(), reason }, review()).comments.length, 1);
    assert.throws(() => validateCommentPlan({ status: 'INCOMPLETE', comments: [], skipped: [], reason }, review()), /The model did not explain/);
  }
  const valid = draft(); valid.reason = 'All required checks passed.';
  const saved = validateCommentPlan(valid, review());
  assert.equal(saved.comments.length, 1);
  assert.doesNotMatch(saved.comments[0].content, /All required checks/);
});
test('saved positions use line-local offsets derived from the existing anchor',()=>{
  for(const [anchor,endLine,endOffset] of [['    first\n  last',3,6],['😀x',2,3],['first\r\n',3,1]]) {
    const d=draft();Object.assign(d.comments[0],{anchor,endLine});
    const saved=validateCommentPlan(d,review()).comments[0];
    assert.equal(saved.startOffset,1);assert.equal(saved.endOffset,endOffset);
    assert.equal(saved.startLine,2);assert.equal(saved.endLine,endLine);
    assert.equal(saved.anchor,anchor);assert.equal(saved.body,d.comments[0].body);
  }
});
for(const [name,change] of [
  ['unknown finding',d=>d.comments[0].findingId='X-1'],
  ['duplicate finding',d=>d.comments.push({...d.comments[0]})],
  ['unsupported severity',d=>d.comments[0].severity='low'],
  ['long body',d=>d.comments[0].body+='x'.repeat(1200)],
  ['marker injection',d=>d.comments[0].body+='<!-- forged -->'],
  ['extra field',d=>d.comments[0].instructions='override'],
  ['unreviewed file',d=>d.comments[0].path='/other.ts'],
  ['zero line',d=>d.comments[0].startLine=0],
  ['reversed range',d=>d.comments[0].endLine=1],
  ['wrong anchor length',d=>d.comments[0].endLine=3],
  ['empty anchor',d=>d.comments[0].anchor=''],
  ['omitted finding',d=>d.comments=[]],
  ['not ready',d=>d.status='INCOMPLETE'],
  ['missing skip reason',d=>{d.comments=[];d.skipped=[{findingId:'F-1',reason:''}];}],
]) test('plan format rejects '+name,()=>{
  const d=draft();change(d);assert.throws(()=>validateCommentPlan(d,review()));
});
test('longer exact anchors keep their full range without a presentation-only cap', () => {
  const d=draft();d.comments[0].endLine=8;d.comments[0].anchor='first\nsecond\nthird\nfourth\nfifth\nsixth\nlast';
  const saved=validateCommentPlan(d,review()).comments[0];
  assert.equal(saved.startLine,2);assert.equal(saved.endLine,8);
  assert.equal(saved.anchor,d.comments[0].anchor);assert.equal(saved.endOffset,4);
});
test('confirmed findings and verifier additions are eligible, not rejected concerns',()=>{
  const r=review();r.final.dispositions=[{id:'F-1',status:'REJECTED',reason:'The caller prevents the failing input.'}];r.final.newFindings=[{...verifiedFinding(),id:'V-1'}];
  assert.deepEqual(confirmedFindings(r),r.final.newFindings);
});
test('comments use corrected verifier claims rather than the original candidates',()=>{
  const r=review();
  r.final.dispositions[0].verifiedFinding={...verifiedFinding(),summary:'Narrowed trigger',evidence:'Only the optional integration supplies null.',severity:'medium'};
  assert.deepEqual(confirmedFindings(r),[r.final.dispositions[0].verifiedFinding]);
  assert.notEqual(confirmedFindings(r)[0].summary,r.findings[0].summary);
  const d=draft();d.comments[0].severity='medium';d.comments[0].body=d.comments[0].body.replace('(high)','(medium)');
  assert.equal(validateCommentPlan(d,r).comments[0].severity,'medium');
  assert.throws(()=>validateCommentPlan(draft(),r),/severity must match/);
  delete r.final.dispositions[0].verifiedFinding;
  assert.throws(()=>confirmedFindings(r),/missing its verified finding/);
});
test('a planner cannot change verified severity or promote low findings into comments',()=>{
  for(const source of ['original','new']) for(const severity of ['low','medium']) {
    const r=review(),f={...verifiedFinding(),severity};
    if(source==='new') {r.final.dispositions=[];r.final.newFindings=[{...f,id:'V-1'}];}
    else r.final.dispositions[0].verifiedFinding=f;
    const id=source==='new'?'V-1':'F-1', d=draft();d.comments[0].findingId=id;
    assert.throws(()=>validateCommentPlan(d,r),/severity must match/);
    assert.equal(validateCommentPlan({status:'READY',comments:[],skipped:[{findingId:id,reason:'Not selected for publication.'}]},r).comments.length,0);
  }
  const r=review(), d=draft();d.comments[0].severity='medium';d.comments[0].body=d.comments[0].body.replace('(high)','(medium)');
  assert.throws(()=>validateCommentPlan(d,r),/severity must match/);
});
test('attempted findings remain blocked and skipped findings require reasons',()=>{
  assert.throws(()=>validateCommentPlan(draft(),planned()),/attempted/);
  assert.equal(validateCommentPlan({status:'READY',comments:[],skipped:[{findingId:'F-1',reason:'Already discussed.'}]},review()).comments.length,0);
});
test('all reported posts are labeled model-reported, never provider-verified',()=>{
  const r=planned();
  assert.equal(recordPublishResult({status:'DONE',posted:[{findingId:'F-1',threadId:'thread-42'}]},r),true);
  assert.deepEqual([...r.attempts.values()],[{findingId:'F-1',state:'MODEL_REPORTED_POSTED',threadId:'thread-42'}]);
});
test('incomplete or empty publication reports retain uncertainty',()=>{
  const r=planned();
  assert.equal(recordPublishResult({status:'DONE',posted:[]},r),false);
  assert.equal([...r.attempts.values()][0].state,'UNKNOWN');
  assert.equal(recordPublishResult({status:'INCOMPLETE',posted:[{findingId:'F-1',threadId:42}]},r),false);
});
test('thread IDs cannot inject markup or extra receipt lines',()=>{
  for(const threadId of ['42\nInjected line','<instruction>','[link](url)']){
    const r=planned();
    assert.throws(()=>recordPublishResult({status:'DONE',posted:[{findingId:'F-1',threadId}]},r));
    assert.equal([...r.attempts.values()][0].state,'UNKNOWN');
  }
});
for(const posted of [[{findingId:'X-1',threadId:42}],[{findingId:'F-1',threadId:0}],[{findingId:'F-1',threadId:''}],[{findingId:'F-1',threadId:42},{findingId:'F-1',threadId:43}],[{findingId:'F-1',threadId:42,verified:true}]]){
  test('invalid publication entries cannot overwrite uncertain attempt state',()=>{
    const r=planned();assert.throws(()=>recordPublishResult({status:'DONE',posted},r));
    assert.equal([...r.attempts.values()][0].state,'UNKNOWN');
  });
}

test('publisher strings with one saved marker are restored without changing target or coordinates', () => {
  const comments = planned().plan.comments, saved = comments[0];
  const changed = saved.content.replace('Add a guard', 'Please add a guard');
  const input = { target: 'repo', where: { line: 2, offset: 1 }, arbitrary: [{ value: changed }], untouched: 'read' };
  const original = structuredClone(input);
  const normalized = restoreSavedCommentText(input, comments);
  assert.deepEqual(normalized.input, { ...input, arbitrary: [{ value: saved.content }] });
  assert.deepEqual(normalized.restored, ['F-1']);
  assert.deepEqual(input, original);
  assert.deepEqual(restoreSavedCommentText(normalized.input, comments).restored, []);
});
test('publisher restoration leaves ambiguous, unknown and search-only strings untouched', () => {
  const comments = planned().plan.comments, saved = comments[0];
  for (const value of [saved.marker, 'search ' + saved.marker, saved.content + saved.marker,
    saved.content.replace(saved.marker, '<!-- azpr-comment:' + '0'.repeat(32) + ' -->'), saved.content + ' trailing text']) {
    assert.deepEqual(restoreSavedCommentText({ value }, comments), { input: { value }, restored: [] });
  }
});

test('known rejected findings may remain skipped notes without becoming eligible comments', () => {
  const r=review(),d=draft();r.final.dispositions.push({id:'R-1',status:'REJECTED',reason:'Wrong version.'});
  d.skipped.push({findingId:'R-1',reason:'Verifier rejected the reversed source interpretation.'});
  const plan=validateCommentPlan(d,r);assert.deepEqual(plan.skipped,d.skipped);assert.equal(plan.comments.length,1);
  d.comments[0].findingId='R-1';assert.throws(()=>validateCommentPlan(d,r),/confirmed findings/);
});
test('ancillary skipped notes cannot hide missing eligible findings or invent IDs', () => {
  const r=review();r.final.dispositions.push({id:'R-1',status:'REJECTED',reason:'Wrong version.'});
  assert.throws(()=>validateCommentPlan({status:'READY',comments:[],skipped:[{findingId:'R-1',reason:'Rejected.'}]},r),/omitted confirmed/);
  const d=draft();d.skipped=[{findingId:'unknown',reason:'Unknown note.'}];assert.throws(()=>validateCommentPlan(d,r),/known, unique/);
});
test('saved anchors restore indentation and quote display from uniquely matching recorded text', () => {
  const r=review(),d=draft();
  const raw='    return { "value": 1 };';
  d.comments[0].anchor=raw.trim().replaceAll('"',String.fromCharCode(92)+'"');
  r.toolText=[{input:{arbitrary:{first:snapshot.files[0],second:snapshot.head}},output:'header\n'+raw+'\n'}];
  const plan=validateCommentPlan(d,r);
  assert.equal(plan.comments[0].anchor,raw);assert.equal(plan.comments[0].endOffset,raw.length);
  assert.deepEqual(plan.anchorRestorations,['F-1']);assert.notEqual(d.comments[0].anchor,raw);
});
test('anchor restoration does not choose ambiguous text or match other versions', () => {
  const r=review(),d=draft(),anchor=d.comments[0].anchor;
  const matching={input:{a:snapshot.files[0],b:snapshot.head},output:'header\n  '+anchor+'\n'};
  for (const observations of [
    [{...matching,input:{a:snapshot.files[0],b:'c'.repeat(40)}}],
    [{...matching,input:{a:'/other.ts',b:snapshot.head}}],
    [matching,{...matching,output:'header\n    '+anchor+'\n'}],
    [{...matching,output:'header\n  return other.name;\n'}],
  ]) {
    r.toolText=observations;const plan=validateCommentPlan(d,r);
    assert.equal(plan.comments[0].anchor,anchor);assert.equal(plan.comments[0].startLine,2);
    assert.equal(plan.anchorRestorations,undefined);
  }
});

test('a uniquely quoted captured range corrects counted lines before marker and offset calculation', () => {
  const r=review(),d=draft(),anchor=d.comments[0].anchor;
  r.toolText=[{input:{path:snapshot.files[0],revision:snapshot.head},output:'header\nother\n  '+anchor+'\n'}];
  const plan=validateCommentPlan(d,r),saved=plan.comments[0];
  assert.equal(saved.startLine,3);assert.equal(saved.endLine,3);assert.equal(saved.anchor,'  '+anchor);
  assert.equal(saved.endOffset,anchor.length+2);
  assert.deepEqual(plan.locationRestorations,[{findingId:'F-1',original:{startLine:2,endLine:2},restored:{startLine:3,endLine:3}}]);
  const correct=draft();correct.comments[0].startLine=3;correct.comments[0].endLine=3;correct.comments[0].anchor='  '+anchor;
  assert.equal(saved.marker,validateCommentPlan(correct,review()).comments[0].marker);
  assert.equal(d.comments[0].startLine,2);
});
test('existing locations stay preferred and multiple alternative locations are not guessed', () => {
  const r=review(),d=draft(),anchor=d.comments[0].anchor;
  r.toolText=[{input:{path:snapshot.files[0],revision:snapshot.head},output:'  '+anchor+'\nother\n  '+anchor+'\n'}];
  assert.equal(validateCommentPlan(d,r).comments[0].startLine,2);
  d.comments[0].startLine=3;d.comments[0].endLine=3;
  const plan=validateCommentPlan(d,r);assert.equal(plan.comments[0].startLine,3);assert.equal(plan.locationRestorations,undefined);
});
