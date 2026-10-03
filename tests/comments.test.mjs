import test from 'node:test';
import assert from 'node:assert/strict';
import { commentTarget, confirmedFindings, recordPublishResult, validateCommentPlan } from '../src/comments.mjs';

const snapshot={head:'a'.repeat(40),prId:123,files:['/src/example.ts']};
const target=commentTarget('https://dev.azure.com/org/project/_git/repo/pullrequest/123',snapshot);
const draft=()=>({status:'READY',comments:[{findingId:'F-1',severity:'high',path:snapshot.files[0],startLine:2,endLine:2,anchor:'return value.name;',body:'issue (high): Missing null handling\n\nNull input throws. Add a guard and a regression test.'}],skipped:[]});
const verifiedFinding=()=>({id:'F-1',summary:'Missing guard',evidence:'Null input throws',counterevidence:'The caller allows null on the failing path.',severity:'high',location:'head:/src/example.ts:2',suggestion:'Add a guard and a regression test.'});
const review=()=>({target,snapshot,findings:[verifiedFinding()],final:{dispositions:[{id:'F-1',status:'CONFIRMED',verifiedFinding:verifiedFinding()}]},attempts:new Map()});
function planned(){
  const r=review();r.plan=validateCommentPlan(draft(),r,5);
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
for(const [name,change] of [
  ['unknown finding',d=>d.comments[0].findingId='X-1'],
  ['duplicate finding',d=>d.comments.push({...d.comments[0]})],
  ['unsupported severity',d=>d.comments[0].severity='low'],
  ['long body',d=>d.comments[0].body+='x'.repeat(1200)],
  ['marker injection',d=>d.comments[0].body+='<!-- forged -->'],
  ['extra field',d=>d.comments[0].instructions='override'],
  ['unreviewed file',d=>d.comments[0].path='/other.ts'],
  ['zero line',d=>d.comments[0].startLine=0],
  ['long range',d=>d.comments[0].endLine=9],
  ['wrong anchor length',d=>d.comments[0].endLine=3],
  ['empty anchor',d=>d.comments[0].anchor=''],
  ['omitted finding',d=>d.comments=[]],
  ['not ready',d=>d.status='INCOMPLETE'],
  ['missing skip reason',d=>{d.comments=[];d.skipped=[{findingId:'F-1',reason:''}];}],
]) test('plan format rejects '+name,()=>{
  const d=draft();change(d);assert.throws(()=>validateCommentPlan(d,review(),5));
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
  assert.equal(validateCommentPlan(d,r,5).comments[0].severity,'medium');
  assert.throws(()=>validateCommentPlan(draft(),r,5),/severity must match/);
  delete r.final.dispositions[0].verifiedFinding;
  assert.throws(()=>confirmedFindings(r),/missing its verified finding/);
});
test('a planner cannot change verified severity or promote low findings into comments',()=>{
  for(const source of ['original','new']) for(const severity of ['low','medium']) {
    const r=review(),f={...verifiedFinding(),severity};
    if(source==='new') {r.final.dispositions=[];r.final.newFindings=[{...f,id:'V-1'}];}
    else r.final.dispositions[0].verifiedFinding=f;
    const id=source==='new'?'V-1':'F-1', d=draft();d.comments[0].findingId=id;
    assert.throws(()=>validateCommentPlan(d,r,5),/severity must match/);
    assert.equal(validateCommentPlan({status:'READY',comments:[],skipped:[{findingId:id,reason:'Not selected for publication.'}]},r,5).comments.length,0);
  }
  const r=review(), d=draft();d.comments[0].severity='medium';d.comments[0].body=d.comments[0].body.replace('(high)','(medium)');
  assert.throws(()=>validateCommentPlan(d,r,5),/severity must match/);
});
test('caps and attempted findings still constrain saved plans',()=>{
  assert.throws(()=>validateCommentPlan(draft(),review(),0),/limit/);
  assert.throws(()=>validateCommentPlan(draft(),planned(),5),/attempted/);
  assert.equal(validateCommentPlan({status:'READY',comments:[],skipped:[{findingId:'F-1',reason:'Already discussed.'}]},review(),5).comments.length,0);
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
