import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupAzurePrReview } from '../src/runtime.mjs';
import { ROLES, BLOCKED_NATIVE_TOOLS } from '../src/config.mjs';

const ROOT = new URL('../', import.meta.url);
const PR = 'https://dev.azure.com/org/proj/_git/repo/pullrequest/123';
const SNAP = { repository:'org/proj/repo', prId:123, base:'a'.repeat(40), head:'b'.repeat(40), scope:'pr', files:['/src/Main.java'] };
const clone = value => structuredClone(value);
const finding = id => ({ id, summary:'Fixture issue', location:'head:/src/Main.java:12', severity:'high',
  evidence:'A reachable fixture branch drops a required guard.', counterevidence:'The caller guard does not cover this input.', suggestion:'Add the guard and a regression test.' });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

// V2 domain fixture: prompt returns an inbox admission; wait settles execution;
// context contains projected messages. No V1 hook or SDK translation.
async function fixture(t, opts = {}) {
  const directory = await mkdtemp(join(tmpdir(),'azpr-v2-runtime-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await cp(new URL('src/prompts',ROOT),join(directory,'prompts'),{recursive:true});
  const settings = JSON.parse(await readFile(new URL('config/settings.example.json',ROOT),'utf8'));
  for (const mode of ['review','deep']) for (const role of ['functional','risk','verifier']) settings.models[mode][role] = `fixture/${mode}-${role}`;
  settings.debug = {enabled:true,directory:'debug'};
  opts.settings?.(settings);
  await writeFile(join(directory,'settings.json'),JSON.stringify(settings));
  const globalPermissions = [{action:'fixture_mcp_write',resource:'*',effect:'deny'}];
  const agents = new Map([['build',{id:'build',system:'Ordinary developer rules',permissions:clone(globalPermissions)}]]);
  const commands = new Map([['existing',{name:'existing',execute(){}}]]);
  const hooks = new Map(), sessions = new Map(), calls = [], notices = [];
  let seq = 0;
  const emit = async (domain,name,event) => { for (const fn of hooks.get(`${domain}:${name}`) ?? []) await fn(event); };
  const hook = domain => async (name,fn) => {
    const key = `${domain}:${name}`, list = hooks.get(key) ?? [];
    list.push(fn); hooks.set(key,list);
    return {dispose(){hooks.set(key,list.filter(item => item !== fn));}};
  };
  const invoke = async (id,tool='fixture_mcp_read',result={output:'fixture source',metadata:{}},status='completed') => {
    const session=sessions.get(id), event={sessionID:id,agent:session.agent,messageID:`assistant_${seq}`,id:`call_${++seq}`,tool,input:{secret:'PRIVATE_INPUT'}};
    await emit('tool','execute.before',event);
    calls.push({kind:'executed-tool',tool,sessionID:id});
    await emit('tool','execute.after',{...event,status,...(status==='error'?{error:new Error('PRIVATE_ERROR')}:{result})});
  };
  const context = {
    location:{directory},
    agent:{
      async get({agentID}) { return {location:{directory},data:clone(agents.get(agentID))}; },
      async list() { return {location:{directory},data:[...agents.values()].map(clone)}; },
      async transform(fn) {
        const before=new Map(agents);
        fn({get:id=>agents.get(id),list:()=>[...agents.values()],update(id,update){
          const agent=agents.get(id)??{id,name:id,permissions:clone(globalPermissions)};
          update(agent); agents.set(id,agent);
        }});
        return {dispose(){agents.clear();for(const [id,value] of before) agents.set(id,value);}};
      },
    },
    command:{
      async list() { return {location:{directory},data:[...commands.values()]}; },
      async get({name}) { return {location:{directory},data:commands.get(name)}; },
      async transform(fn) {
        const before=new Map(commands);
        fn({get:name=>commands.get(name),list:()=>[...commands.values()],add(def){commands.set(def.name,def);}});
        return {dispose(){commands.clear();for(const [id,value] of before) commands.set(id,value);}};
      },
    },
    tool:{hook:hook('tool')},
    session:{
      hook:hook('session'),
      async create(input) {
        calls.push({kind:'create',...clone(input)});
        if(opts.createError) throw new Error('Fixture create failed');
        const id=`ses_${++seq}`, session={...clone(input),id,history:[],stopped:deferred()};
        session.model.variant='default';sessions.set(id,session);
        return {...clone(input),id,model:clone(session.model)};
      },
      async get({sessionID}) { const {history,running,stopped,...info}=sessions.get(sessionID);return clone(info); },
      async prompt(input) {
        calls.push({kind:'prompt',...clone(input)});
        const session=sessions.get(input.sessionID),role=session.agent,spec=ROLES[role];
        const packet=JSON.parse(input.text),messageID=`msg_${++seq}`;
        const event={sessionID:session.id,messageID,prompt:{text:input.text},metadata:input.metadata,delivery:input.delivery};
        await opts.beforePrompt?.({context,emit,session,event,agents,packet});
        if(!opts.skipPromptHook) await emit('session','prompt',event);
        session.history.push({id:messageID,type:'user',text:event.prompt.text,metadata:event.metadata});
        session.stopped=deferred();
        const work=async()=>{
          const frame={sessionID:session.id,agent:role,model:clone(session.model),system:[{type:'text',text:agents.get(role).system+'\nHOST_RULES'}],tools:{fixture_mcp_read:{},shell:{}},messages:[],options:{}};
          await opts.beforeContext?.({frame,emit,session,packet,agents});
          if(!opts.skipContextHook) await emit('session','context',frame);
          await opts.during?.({frame,emit,context,invoke,session,packet,calls,agents});
          if(!packet.operation&&!opts.skipTool) await invoke(session.id);
          let result;
          if(packet.operation==='output-status-repair') result={status:spec.stage==='check'?'READY':'COMPLETE'};
          else if(packet.operation==='output-location-repair') result={locations:packet.missingLocations.map(({id})=>({id,location:finding(id).location}))};
          else if(packet.operation==='output-disposition-repair') result={dispositions:packet.missingDispositionIds.map(id=>({id,status:'MERGED',mergedInto:packet.mergeTargets[0],reason:'Same verified defect.'}))};
          else if(packet.operation==='output-final-resubmission') result={status:'COMPLETE',...clone(packet.frozen),confirmed:packet.expectedFindingIds.map(id=>({...finding(id),reason:'Rechecked retained source.'})),merged:[],rejected:[],needsInfo:[],newFindings:[],report:'Corrected final.'};
          else if(spec.stage==='check') result={status:'READY',snapshot:{...clone(SNAP),scope:'cumulative'},sourceAccess:{diff:'fixture'},requirements:'Fixture requirement',report:'Source access ready.'};
          else if(spec.format==='initial') result={status:'COMPLETE',snapshot:clone(SNAP),coverage:{files:[...SNAP.files],gaps:[]},findings:[finding(`${spec.prefix}-1`)],report:`PRIVATE_INITIAL_${spec.prefix}`};
          else if(spec.format==='final') result={status:'COMPLETE',snapshot:clone(SNAP),currentHead:SNAP.head,currentBase:SNAP.base,confirmed:packet.reviews.flatMap(r=>r.findings).map(f=>({...f,reason:'Independently verified.'})),merged:[],rejected:[],needsInfo:[],newFindings:[],report:'FINAL_REPORT'};
          else if(spec.stage==='comment-plan') result={status:'READY',comments:packet.findings.slice(0,1).map(f=>({findingId:f.id,severity:f.severity,path:SNAP.files[0],startLine:12,endLine:12,anchor:'fixture code',body:`issue (${f.severity}): fixture defect\n\nTrigger, impact and correction.`})),skipped:packet.findings.slice(1).map(f=>({findingId:f.id,reason:'Duplicate concern.'}))};
          else if(spec.stage==='comment-publish') {await invoke(session.id,'fixture_mcp_write');result={status:'DONE',posted:packet.comments.map(f=>({findingId:f.findingId,threadId:101}))};}
          result=await opts.result?.({result,role,packet,session})??result;
          const answer={id:`answer_${++seq}`,type:'assistant',agent:role,model:clone(session.model),finish:'stop',time:{created:Date.now(),completed:Date.now()},content:[{type:'text',text:JSON.stringify(result)}]};
          await opts.answer?.({answer,packet,role});
          session.history.push(answer,{id:`idle_${++seq}`,type:'idle',outcome:'succeeded'});session.outcome='succeeded';
        };
        session.running=Promise.race([Promise.resolve().then(work),session.stopped.promise]).catch(error=>{
          session.outcome='failed';session.failure=error.message;
          session.history.push({id:`idle_${++seq}`,type:'idle',outcome:'failed'});
        });
        return {id:messageID,type:'user',sessionID:session.id,payload:{text:input.text,...(input.metadata?{metadata:input.metadata}:{})},delivery:input.delivery};
      },
      async wait({sessionID}) {await sessions.get(sessionID).running;},
      async context({sessionID}) {return clone(sessions.get(sessionID).history);},
      async interrupt({sessionID,resume}) {calls.push({kind:'interrupt',sessionID,resume});const s=sessions.get(sessionID);s.outcome='interrupted';s.stopped.resolve();return {interrupted:true};},
      async synthetic(input) {notices.push(clone(input));return {id:`notice_${++seq}`,type:'synthetic',sessionID:input.sessionID,delivery:input.delivery,payload:{text:input.text,description:input.description}};},
    },
  };
  opts.context?.({context,agents,commands});
  const cleanup=await setupAzurePrReview(context,directory);t.after(cleanup);
  return {directory,settings,agents,commands,sessions,hooks,calls,notices,context,emit,invoke,cleanup,
    prompts:()=>calls.filter(c=>c.kind==='prompt'),
    async command(name='pr-review',text=PR,origin='ordinary') {await commands.get(name).execute({sessionID:origin,prompt:{text},delivery:'steer'});return notices.filter(n=>n.sessionID===origin).at(-1)?.text;},
  };
}
const resultLog=async receipt=>JSON.parse(await readFile(join(/Private debug directory: ([^\n]+)/.exec(receipt)[1],'result.json'),'utf8'));

for(const mode of ['review','deep']) test(`V2 ${mode} preserves literal context and uses independent full-scope sessions`,async t=>{
  const f=await fixture(t),receipt=await f.command(mode==='deep'?'pr-deep':'pr-review',PR+' literal !`not-run` @../../secret $HOME\ncheck this');
  assert.match(receipt,/] COMPLETE/);
  const prompts=f.prompts(),stages=(await resultLog(receipt)).stages;
  assert.equal(prompts.length,3);assert.equal(new Set(prompts.map(p=>p.sessionID)).size,3);
  assert.deepEqual(stages.map(s=>s.model).sort(),['functional','risk','verifier'].map(r=>`fixture/${mode}-${r}`).sort());
  assert.ok(stages.every(s=>s.completedTools===1&&s.modelRequests===1));
  assert.ok(prompts.every(p=>p.resume===true&&p.metadata.azprGrant));
  assert.match(JSON.parse(prompts[0].text).userContext,/literal !`not-run` @\.\.\/\.\.\/secret \$HOME/);
  assert.deepEqual(JSON.parse(prompts[2].text).expectedFindingIds,['F-1','R-1']);
  assert.ok(f.notices.every(n=>n.resume===false&&n.description===n.text));
  assert.doesNotMatch(receipt,/PRIVATE_INITIAL_|FINAL_REPORT/);
});
test('ordinary hooks are no-ops after settings disappear; disposal preserves ordinary definitions',async t=>{
  const f=await fixture(t),ordinary=clone(f.agents.get('build'));
  await rm(join(f.directory,'settings.json'));
  await f.emit('session','prompt',{sessionID:'ordinary',prompt:{text:'Normal chat'}});
  await f.emit('session','context',{sessionID:'ordinary',agent:'build'});
  await f.emit('tool','execute.before',{sessionID:'ordinary',tool:'shell',agent:'build'});
  assert.deepEqual(f.agents.get('build'),ordinary);await f.cleanup();
  assert.deepEqual([...f.agents.keys()],['build']);assert.deepEqual([...f.commands.keys()],['existing']);
});
test('disabled plugin registers nothing',async t=>{const f=await fixture(t,{settings(s){s.enabled=false;}});assert.equal(f.commands.size,1);assert.equal(f.agents.size,1);assert.equal(f.hooks.size,0);});
for(const kind of ['agent','command']) test(`${kind} collision preserves existing definition`,async t=>{
  const original={name:'pr-check',id:'azpr-review-check',system:'Keep me'};let map;
  await assert.rejects(fixture(t,{context({agents,commands}){map=kind==='agent'?agents:commands;map.set(kind==='agent'?'azpr-review-check':'pr-check',original);}}),/conflict/i);
  assert.ok([...map.values()].includes(original));
});
test('private mentions, direct role use and delegation do not grant authorization',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.emit('session','prompt',{sessionID:'ordinary',prompt:{text:'hello',agents:[{id:'azpr-review-risk'}]}}),/mentioned/);
  await assert.rejects(f.emit('session','context',{sessionID:'ordinary',agent:'azpr-review-risk',model:{providerID:'fixture',id:'review-risk'}}),/authorization/);
  await assert.rejects(f.emit('tool','execute.before',{sessionID:'ordinary',agent:'build',tool:'subagent',input:{agent:'azpr-review-risk'}}),/delegated/);
  assert.equal(f.prompts().length,0);
});
test('check uses one readiness stage and full return contains the report',async t=>{
  const f=await fixture(t,{settings(s){s.returnReport='full';}}),receipt=await f.command('pr-check');
  assert.match(receipt,/] READY/);assert.match(receipt,/Source access ready/);assert.equal(f.prompts().length,1);
});
for(const native of BLOCKED_NATIVE_TOOLS) test(`execution guard blocks ${native}, including shell=ask`,async t=>{
  const f=await fixture(t,{settings(s){s.shellToolPermission='ask';},async during({invoke,session}){await invoke(session.id,native);}});
  const receipt=await f.command('pr-check');assert.match(receipt,/] INCOMPLETE/);
  assert.ok(!f.calls.some(c=>c.kind==='executed-tool'&&c.tool===native));
  const result=await resultLog(receipt);assert.equal(result.stages[0].blockedNativeToolCalls,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_INPUT/);
});
test('MCP names stay unclassified; diagnostics retain error and truncation observations without content',async t=>{
  const f=await fixture(t,{skipTool:true,async during({invoke,session}){
    await invoke(session.id,'arbitrary_server_operation',{output:'PRIVATE_OUTPUT',metadata:{isError:true}});
    await invoke(session.id,'other_operation',{output:'PRIVATE_OUTPUT',metadata:{truncated:true}});
    await invoke(session.id,'failed_operation',undefined,'error');
  }}),receipt=await f.command('pr-check'),result=await resultLog(receipt),stage=result.stages[0];
  assert.match(receipt,/] READY/);assert.equal(stage.completedTools,0);assert.equal(stage.toolObservations.reportedErrors,1);assert.equal(stage.toolObservations.truncated,1);assert.equal(stage.toolFailures,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OUTPUT|PRIVATE_INPUT|PRIVATE_ERROR/);
});
for(const hook of ['skipPromptHook','skipContextHook']) test(`missing ${hook} fails closed`,async t=>{const f=await fixture(t,{[hook]:true});assert.match(await f.command('pr-check'),/] INCOMPLETE/);});
for(const change of ['text','nonce','model','variant','agent']) test(`private ${change} mutation is rejected`,async t=>{
  const f=await fixture(t,{beforePrompt({event,session,agents}){
    if(change==='text')event.prompt.text+=' injected';if(change==='nonce')event.metadata={azprGrant:'forged'};
    if(change==='model')session.model.id='unapproved';if(change==='variant')session.model.variant='high';
    if(change==='agent')agents.get(session.agent).system+=' changed';
  }});assert.match(await f.command('pr-check'),/] INCOMPLETE/);assert.equal(f.calls.filter(c=>c.kind==='executed-tool').length,0);
});
test('settings changes require restart and completed sessions cannot resume',async t=>{
  const f=await fixture(t);await f.command('pr-check');const id=f.prompts()[0].sessionID;
  await assert.rejects(f.emit('session','prompt',{sessionID:id,prompt:{text:'resume'}}),/authorized/);
  await assert.rejects(f.command('pr-check',PR,id),/ordinary development session/);
  await writeFile(join(f.directory,'settings.json'),JSON.stringify({...f.settings,outputLanguage:'zh-TW'}));await assert.rejects(f.command('pr-check'),/changed/);
});
for(const missing of ['functional','risk','verifier']) test(`incomplete deep ${missing} stops without model fallback`,async t=>{
  const f=await fixture(t,{settings(s){s.models.deep[missing]='';}});await assert.rejects(f.command('pr-deep'),/All three/);assert.equal(f.calls.length,0);
});
for(const fault of ['snapshot','partial','missing-id','stale']) test(`${fault} cannot become a publishable review`,async t=>{
  const f=await fixture(t,{result({role,result}){
    if(fault==='snapshot'&&role.endsWith('-risk'))result.snapshot.head='c'.repeat(40);
    if(fault==='partial'&&role.endsWith('-risk')){result.status='PARTIAL';result.coverage.gaps=['Source unavailable.'];}
    if(fault==='missing-id'&&role.endsWith('-verifier'))result.confirmed=result.confirmed.slice(0,1);
    if(fault==='stale'&&role.endsWith('-verifier'))result.currentHead='c'.repeat(40);return result;
  }}),receipt=await f.command();assert.doesNotMatch(receipt.split('\n')[0],/] COMPLETE$/);
  const id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];await assert.rejects(f.command('pr-comment',id),/unavailable/);
});
for(const stop of ['cancel','dispose']) test(`${stop} revokes pending work without aborting the origin`,{timeout:3000},async t=>{
  const started=deferred(),release=deferred(),f=await fixture(t,{async during(){started.resolve();await release.promise;}});
  const running=f.command('pr-check');await started.promise;
  if(stop==='cancel')await f.command('pr-stop','');else await f.cleanup();
  const receipt=await running;release.resolve();assert.match(receipt,/] CANCELLED/);
  assert.ok(f.calls.some(c=>c.kind==='interrupt'));assert.ok(f.calls.filter(c=>c.kind==='interrupt').every(c=>c.sessionID!=='ordinary'&&c.resume===false));
});
test('initial failure revokes a sibling whose work never settles',{timeout:3000},async t=>{
  const both=deferred();let count=0;
  const f=await fixture(t,{async during({session}){if(++count===2)both.resolve();await both.promise;if(session.agent.endsWith('-functional'))throw new Error('Provider failed');await new Promise(()=>{});}});
  assert.match(await f.command(),/] INCOMPLETE/);assert.equal(f.prompts().length,2);assert.ok(f.calls.filter(c=>c.kind==='interrupt').length>=2);
});
test('same-origin lock rejects concurrent commands',async t=>{
  const started=deferred(),release=deferred(),f=await fixture(t,{async during(){started.resolve();await release.promise;}});
  const running=f.command('pr-check');await started.promise;await assert.rejects(f.command(),/already running/);release.resolve();assert.match(await running,/] READY/);
});

test('PARTIAL initial retains evidence and revokes a sibling that never settles',{timeout:3000},async t=>{
  const both=deferred();let count=0;
  const f=await fixture(t,{async during({session}){
    if(++count===2)both.resolve();await both.promise;
    if(session.agent.endsWith('-risk'))await new Promise(()=>{});
  },result({result}){result.status='PARTIAL';result.coverage.gaps=['Fixture source gap.'];return result;}});
  const receipt=await f.command();assert.match(receipt,/] INCOMPLETE/);assert.equal(f.prompts().length,2);
  const saved=await resultLog(receipt),partial=saved.stages.find(stage=>stage.status==='PARTIAL');
  assert.equal(partial.result.findings[0].id,'F-1');assert.deepEqual(partial.result.coverage.gaps,['Fixture source gap.']);
  assert.equal(saved.reportKind,'incomplete-draft');assert.ok(f.calls.some(c=>c.kind==='interrupt'));
});
test('status amendment is one fresh tool-free request with host instructions preserved',async t=>{
  const f=await fixture(t,{settings(s){s.outputRetries=1;},result({packet,result}){if(!packet.operation&&result.status==='READY')result.status='DONE';return result;},
    during({packet,frame}){if(packet.operation){assert.deepEqual(frame.tools,{});assert.match(frame.system[0].text,/status/);assert.match(frame.system[0].text,/HOST_RULES/);}}});
  const receipt=await f.command('pr-check');assert.match(receipt,/] READY/);assert.equal(f.prompts().length,2);assert.notEqual(f.prompts()[0].sessionID,f.prompts()[1].sessionID);
  assert.equal((await resultLog(receipt)).stages[0].status,'FAILED');
});
test('location amendment reuses stopped verifier context and records both attempts',async t=>{
  const f=await fixture(t,{settings(s){s.outputRetries=1;},result({role,packet,result}){if(role.endsWith('-verifier')&&!packet.operation)delete result.confirmed[0].location;return result;}});
  const receipt=await f.command();assert.match(receipt,/] COMPLETE/);assert.equal(f.prompts().length,4);assert.equal(f.prompts()[2].sessionID,f.prompts()[3].sessionID);assert.match(receipt,/Location amendment notice/);
});
test('amendments cannot use tools or receive another recovery',async t=>{
  const f=await fixture(t,{settings(s){s.outputRetries=1;},result({packet,result}){if(!packet.operation)result.status='DONE';return result;},async during({packet,invoke,session}){if(packet.operation)await invoke(session.id);}});
  assert.match(await f.command('pr-check'),/] INCOMPLETE/);assert.equal(f.prompts().length,2);assert.equal(f.calls.filter(c=>c.kind==='executed-tool').length,1);
});
test('large evidence survives JSON, verifier handoff and diagnostics without a hidden cap',async t=>{
  const evidence='x'.repeat(2100000),f=await fixture(t,{result({role,packet,result}){if(ROLES[role].format==='initial')result.findings[0].evidence=evidence;if(ROLES[role].format==='final')assert.ok(packet.reviews.every(r=>r.findings[0].evidence===evidence));return result;}});
  const receipt=await f.command();assert.match(receipt,/] COMPLETE/);const result=await resultLog(receipt);assert.ok(result.stages.at(-1).inputCharacters>4000000);assert.equal(result.stages.at(-1).remainingRunMsAtEnd,null);
});
test('comment publication requires explicit preview and opt-in, and never retries',async t=>{
  const f=await fixture(t,{settings(s){s.comments.enabled=true;}}),receipt=await f.command(),id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  await assert.rejects(f.command('pr-comment',id+' --publish'),/Preview first/);assert.match(await f.command('pr-comment',id),/] PREVIEW/);
  assert.match(await f.command('pr-comment',id+' --publish'),/] MODEL_REPORTED_POSTED/);await assert.rejects(f.command('pr-comment',id+' --publish'),/already had a publication/);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='fixture_mcp_write').length,1);
});

test('null timeout creates no run timer even after a day, while manual cancellation still works',{timeout:3000},async t=>{
  const started=deferred(),release=deferred(),f=await fixture(t,{async during(){started.resolve();await release.promise;}});
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let settled=false;
  const running=f.command('pr-check').then(value=>{settled=true;return value;});
  await started.promise;t.mock.timers.tick(86400000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);assert.equal(f.calls.filter(c=>c.kind==='interrupt').length,0);
  await f.command('pr-stop','');const receipt=await running;release.resolve();
  assert.match(receipt,/] CANCELLED/);
  assert.equal((await resultLog(receipt)).stages[0].remainingRunMsAtEnd,null);
});

test('explicit timeout interrupts pending work at the original deadline',{timeout:3000},async t=>{
  const started=deferred(),release=deferred(),f=await fixture(t,{settings(s){s.runTimeoutSeconds=10;},async during(){started.resolve();await release.promise;}});
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const running=f.command('pr-check');await started.promise;t.mock.timers.tick(10000);
  const receipt=await running;release.resolve();assert.match(receipt,/] TIMED_OUT/);
  const stage=(await resultLog(receipt)).stages[0];assert.equal(stage.remainingRunMsAtStart,10000);assert.equal(stage.remainingRunMsAtEnd,0);
});

test('amendment retains the original deadline instead of starting a new timer',{timeout:3000},async t=>{
  const f=await fixture(t,{settings(s){s.runTimeoutSeconds=10;s.outputRetries=1;},
    during({packet}){t.mock.timers.tick(packet.operation?4000:6000);},
    result({packet,result}){if(!packet.operation)result.status='DONE';return result;}});
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const receipt=await f.command('pr-check');assert.match(receipt,/] TIMED_OUT/);assert.equal(f.prompts().length,2);
  const stages=(await resultLog(receipt)).stages;assert.equal(stages[1].remainingRunMsAtStart,4000);assert.equal(stages[1].remainingRunMsAtEnd,0);
});

test('captured truncated output is retained privately and never accepted or amended',async t=>{
  const f=await fixture(t,{settings(s){s.outputRetries=1;},answer({answer}){answer.finish='length';}});
  const receipt=await f.command('pr-check');assert.match(receipt,/] INCOMPLETE/);assert.equal(f.prompts().length,1);
  const directory=/Private debug directory: ([^\n]+)/.exec(receipt)[1];
  const saved=JSON.parse(await readFile(join(directory,'01-azpr-review-check.response.json'),'utf8'));
  assert.equal(saved.finish,'length');assert.match(saved.text,/Source access ready/);
});
