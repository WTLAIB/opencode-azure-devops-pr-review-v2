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
  const invoke = async (id,tool='fixture_mcp_read',result={output:'fixture source',metadata:{}},status='completed',input={secret:'PRIVATE_INPUT'}) => {
    const session=sessions.get(id), event={sessionID:id,agent:session.agent,messageID:`assistant_${seq}`,id:`call_${++seq}`,tool,input};
    await emit('tool','execute.before',event);
    calls.push({kind:'executed-tool',tool,sessionID:id});
    await emit('tool','execute.after',{...event,status,...(status==='error'?{error:new Error('PRIVATE_ERROR')}:{result})});
    return result;
  };
  const context = {
    location:{directory},
    model:{async list(){return {data:Object.values(settings.models).flatMap(group=>Object.values(group)).filter(id=>typeof id==='string'&&id.startsWith('fixture/')).map(value=>({providerID:'fixture',id:value.slice(8),enabled:true,capabilities:{tools:true}}))};}},
    mcp:{async list(){return {data:[{name:'arbitrary-server',status:{status:'connected'}}]};}},
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
    tool:{hook:hook('tool'),async list(){return [{name:'fixture_mcp_read',options:{namespace:'arbitrary-server',codemode:false}}];}},
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
          if(!opts.skipModelHook) await emit('session','model.request',{sessionID:session.id,agent:role,model:clone(session.model),kind:'primary',headers:{}});
          await opts.during?.({frame,emit,context,invoke,session,packet,calls,agents});
          if(!opts.skipTool) await invoke(session.id);
          let result;
          if(spec.stage==='check') result={status:'READY',snapshot:{...clone(SNAP),scope:'cumulative'},sourceAccess:{diff:'fixture'},requirements:'Fixture requirement',report:'Source access ready.'};
          else if(spec.format==='initial') result={status:'COMPLETE',snapshot:clone(SNAP),coverage:{files:[...SNAP.files],gaps:[]},findings:[finding(`${spec.prefix}-1`)],report:`PRIVATE_INITIAL_${spec.prefix}`};
          else if(spec.format==='final') result={status:'COMPLETE',snapshot:clone(SNAP),currentHead:SNAP.head,currentBase:SNAP.base,confirmed:packet.reviews.flatMap(r=>r.findings).map(f=>({...f,reason:'Independently verified.'})),merged:[],rejected:[],needsInfo:[],newFindings:[],report:'FINAL_REPORT'};
          else if(spec.stage==='comment-plan') result={status:'READY',comments:packet.findings.slice(0,1).map(f=>({findingId:f.id,severity:f.severity,path:SNAP.files[0],startLine:12,endLine:12,anchor:'fixture code',body:`issue (${f.severity}): fixture defect\n\nTrigger, impact and correction.`})),skipped:packet.findings.slice(1).map(f=>({findingId:f.id,reason:'Duplicate concern.'}))};
          else if(spec.stage==='comment-publish') {await invoke(session.id,'fixture_mcp_write');result={status:'DONE',posted:packet.comments.map(f=>({findingId:f.findingId,threadId:101}))};}
          result=await opts.result?.({result,role,packet,session})??result;
          const answer={id:`answer_${++seq}`,type:'assistant',agent:role,model:clone(session.model),finish:'stop',time:{created:Date.now(),completed:Date.now()},content:[{type:'text',text:JSON.stringify(result)}]};
          await opts.answer?.({answer,packet,role});
          const outcome = answer.error ? 'failed' : 'succeeded';
          session.history.push(answer,{id:`idle_${++seq}`,type:'idle',outcome});session.outcome=outcome;
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
  const f=await fixture(t,{settings(s){s.outputLanguage='zh-TW';}}),receipt=await f.command(mode==='deep'?'pr-deep':'pr-review',PR+' literal !`not-run` @../../secret $HOME\ncheck this');
  assert.match(receipt,/] COMPLETE/);
  const prompts=f.prompts(),stages=(await resultLog(receipt)).stages;
  assert.equal(prompts.length,3);assert.equal(new Set(prompts.map(p=>p.sessionID)).size,3);
  assert.deepEqual(stages.map(s=>s.model).sort(),['functional','risk','verifier'].map(r=>`fixture/${mode}-${r}`).sort());
  assert.ok(stages.every(s=>s.completedTools===1&&s.modelRequests===1));
  assert.ok(prompts.every(p=>p.resume===true&&p.metadata.azprGrant));
  assert.ok(prompts.every(p=>JSON.parse(p.text).outputLanguage==='zh-TW'));
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
test('numbered text is scoped to active project roles and preserves raw/native/ordinary output', async t => {
  const seen = [];
  const f = await fixture(t, { skipTool: true, async during({ emit, session }) {
    for (const tool of ['arbitrary_source_tool', 'shell']) {
      const raw = 'first\n\nfixture code\n';
      const event = { sessionID: session.id, agent: session.agent, messageID: 'fixture', id: tool,
        tool, input: { revision: SNAP.head }, status: 'completed', result: { output: raw, content: [{ type: 'text', text: raw }] } };
      await emit('tool', 'execute.before', event);
      await emit('tool', 'execute.after', event);
      assert.equal(event.result.output, raw);
      if (tool === 'shell') assert.equal(event.result.content[0].text, raw);
      else assert.match(event.result.content[0].text, /3 \| fixture code$/);
    }
    seen.push(session.agent);
  } });
  const receipt = await f.command();
  const id = /\[AZPR ([a-f0-9]+)\]/.exec(receipt)[1];
  assert.match(await f.command('pr-comment', id), /\] PREVIEW/);
  assert.match(await f.command('pr-comment', id + ' --publish'), /\] MODEL_REPORTED_POSTED/);
  assert.equal(seen.length, 5);
  const result = { output: 'ordinary\nsource', content: [{ type: 'text', text: 'ordinary\nsource' }] };
  const event = { sessionID: 'ordinary', agent: 'build', tool: 'arbitrary_source_tool', id: 'ordinary', status: 'completed', result };
  await f.emit('tool', 'execute.after', event);
  assert.equal(event.result, result);
});
test('disabled plugin registers nothing',async t=>{const f=await fixture(t,{settings(s){s.enabled=false;}});assert.equal(f.commands.size,1);assert.equal(f.agents.size,1);assert.equal(f.hooks.size,0);});
test('connected MCP registration settles before the first reviewer prompt', async t => {
  let polls = 0;
  const f = await fixture(t, { context({ context }) { context.tool.list = async () => ++polls < 3 ? []
    : [{ name: 'no_known_action_name', options: { namespace: 'arbitrary-server', codemode: false } }]; },
    beforePrompt() { assert.ok(polls >= 3); } });
  assert.match(await f.command(), /\] COMPLETE/);
  assert.equal(f.prompts().length, 3);
});
test('tool-catalog observation failure does not add a review refusal', async t => {
  const f = await fixture(t, { context({ context }) { context.tool.list = async () => { throw new Error('PRIVATE_CATALOG_ERROR'); }; } });
  assert.match(await f.command(), /\] COMPLETE/);
});
test('cancelling tool-registration waiting starts no reviewer', async t => {
  const waiting = deferred();
  const f = await fixture(t, { context({ context }) { context.tool.list = async () => { waiting.resolve(); return []; }; } });
  const pending = f.command(); await waiting.promise;
  await f.command('pr-stop', '');
  assert.match(await pending, /\] CANCELLED/);
  assert.equal(f.prompts().length, 0);
});
test('comment-plan notes survive locally without entering saved publication content', async t => {
  const notes = 'PRIVATE_PLANNER_NOTE: {"observed": 7}';
  const f = await fixture(t, { answer({ answer, role }) {
    if (role.endsWith('comment-plan')) answer.content[0].text = '```json\n' + answer.content[0].text + '\n```\n' + notes;
  } });
  const receipt = await f.command(); const id = /\[AZPR ([a-f0-9]+)\]/.exec(receipt)[1];
  const preview = await f.command('pr-comment', id); assert.match(preview, /\] PREVIEW/);
  const record = (await resultLog(preview)).stages[0];
  assert.equal(record.surroundingText, notes);
  assert.equal(record.outputFormatCorrections[0].action, 'extract-comment-plan-envelope');
  assert.match(await f.command('pr-comment', id + ' --publish'), /\] MODEL_REPORTED_POSTED/);
  const publication = JSON.parse(f.prompts().at(-1).text);
  assert.deepEqual(Object.keys(publication).sort(), ['comments', 'outputLanguage', 'snapshot', 'target']);
  assert.equal(JSON.parse(f.prompts().at(-2).text).report, 'FINAL_REPORT');
  assert.ok(publication.comments.every(comment => !comment.content.includes('PRIVATE_PLANNER_NOTE')));
  assert.equal(f.prompts().length, 5);
});
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
for(const native of BLOCKED_NATIVE_TOOLS) test(`source-only role execution guard blocks ${native}`,async t=>{
  const f=await fixture(t,{async during({invoke,session}){await invoke(session.id,native);}});
  const receipt=await f.command('pr-check');assert.match(receipt,/] INCOMPLETE/);
  assert.ok(!f.calls.some(c=>c.kind==='executed-tool'&&c.tool===native));
  const result=await resultLog(receipt);assert.equal(result.stages[0].blockedNativeToolCalls,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_INPUT/);
});
test('MCP names stay unclassified; diagnostics retain counts and private errors without tool bodies',async t=>{
  const f=await fixture(t,{skipTool:true,async during({invoke,session}){
    await invoke(session.id,'arbitrary_server_operation',{output:'PRIVATE_OUTPUT',metadata:{isError:true}});
    await invoke(session.id,'other_operation',{output:'PRIVATE_OUTPUT',metadata:{truncated:true}});
    await invoke(session.id,'failed_operation',undefined,'error');
  }}),receipt=await f.command('pr-check'),result=await resultLog(receipt),stage=result.stages[0];
  assert.match(receipt,/] READY/);assert.equal(stage.completedTools,0);assert.equal(stage.toolObservations.reportedErrors,1);assert.equal(stage.toolObservations.truncated,1);assert.equal(stage.toolFailures,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_OUTPUT|PRIVATE_INPUT/);
  assert.doesNotMatch(JSON.stringify(stage.toolObservations),/PRIVATE_/);
  assert.equal(stage.toolErrors.at(-1).error.message, 'PRIVATE_ERROR');
  assert.doesNotMatch(receipt,/PRIVATE_OUTPUT|PRIVATE_INPUT|PRIVATE_ERROR/);
});
for(const hook of ['skipPromptHook','skipContextHook','skipModelHook']) test(`missing ${hook} fails closed`,async t=>{const f=await fixture(t,{[hook]:true});assert.match(await f.command('pr-check'),/] INCOMPLETE/);});
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
  await writeFile(join(f.directory,'settings.json'),JSON.stringify({...f.settings,outputLanguage:'zh-TW'}));assert.match(await f.command('pr-check'),/settings.json changed/);
});

for (const kind of ['generate','compaction','title','unknown']) test(`private ${kind} model requests are denied during and after a run`, async t => {
  const f = await fixture(t, { async during({ emit, session }) {
    await assert.rejects(emit('session','model.request',{sessionID:session.id,agent:session.agent,model:clone(session.model),kind,headers:{authorization:'PRIVATE_HEADER'}}), /not authorized/);
  }});
  const receipt = await f.command('pr-check');
  assert.match(receipt, /] READY/);
  const saved = (await resultLog(receipt)).stages[0].requestObservations;
  assert.equal(saved.kinds[kind], 1);
  assert.equal(saved.rejected, 1);
  assert.equal(saved.authorizedPrimary, 1);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_HEADER/);
  const session = f.sessions.get(f.prompts()[0].sessionID);
  await assert.rejects(f.emit('session','model.request',{sessionID:session.id,agent:session.agent,model:session.model,kind}), /authorization/);
});

test('private auxiliary requests fail closed even without a remembered session; ordinary requests remain host-owned', async t => {
  const f = await fixture(t);
  for (const kind of ['primary','generate','compaction','title']) {
    await assert.rejects(f.emit('session','model.request',{sessionID:'previous-process-private',agent:'azpr-review-risk',model:{providerID:'fixture',id:'review-risk'},kind}), /authorization/);
    await f.emit('session','model.request',{sessionID:'ordinary',agent:'build',kind});
  }
  await rm(join(f.directory,'settings.json'));
  const retry={sessionID:'ordinary',agent:'build',decision:{retry:true,delay:500},attempt:2};
  await f.emit('session','retry',retry);
  assert.deepEqual(retry.decision,{retry:true,delay:500});
});

test('a second primary request needs a new authorized context', async t => {
  const f = await fixture(t, { async during({ emit, session }) {
    await assert.rejects(emit('session','model.request',{sessionID:session.id,agent:session.agent,model:session.model,kind:'primary'}), /authorized primary context/);
  }});
  assert.match(await f.command('pr-check'), /] READY/);
});

test('retry observations retain host decisions and block revoked sessions', async t => {
  const f = await fixture(t, { async during({ emit, session }) {
    const event={sessionID:session.id,agent:session.agent,model:session.model,attempt:2,error:{message:'PRIVATE_PROVIDER_ERROR'},decision:{retry:true,delay:100}};
    await emit('session','retry',event);
    assert.deepEqual(event.decision,{retry:true,delay:100});
  }});
  const receipt=await f.command('pr-check'), stages=(await resultLog(receipt)).stages;
  assert.match(receipt, /] READY/);
  assert.deepEqual(stages.map(s=>s.requestObservations.retries[0].allowed),[true]);
  assert.doesNotMatch(JSON.stringify(stages),/PRIVATE_PROVIDER_ERROR/);
  const session=f.sessions.get(f.prompts().at(-1).sessionID);
  const event={sessionID:session.id,agent:session.agent,model:session.model,attempt:3,decision:{retry:true,delay:100}};
  await f.emit('session','retry',event);assert.deepEqual(event.decision,{retry:false});
});

for (const target of ['initial-agent','stage-agent','command','model','mcp']) test(`cancellation releases a pending ${target} catalog read and its origin lock`, {timeout:3000}, async t => {
  const entered=deferred(), pending=deferred();let arm=false, reads=0;
  const f=await fixture(t,{context({context}){
    const domain=target.includes('agent')?'agent':target, method=domain==='agent'?'get':'list', original=context[domain][method];
    context[domain][method]=async input=>{
      const relevant=domain!=='agent'||input.agentID==='azpr-review-check';
      if(arm&&relevant&&++reads===(target==='stage-agent'?2:1)){entered.resolve();await pending.promise;}
      return original(input);
    };
  }});
  arm=true;const running=f.command('pr-check');await entered.promise;
  await f.command('pr-stop','');assert.match(await running,/] CANCELLED/);
  assert.equal(f.prompts().length,0);
  arm=false;assert.match(await f.command('pr-check'),/] READY/);
  pending.resolve();
});

test('disposal cancels a pending catalog read before reviewer creation', {timeout:3000}, async t => {
  const entered=deferred(),pending=deferred();
  const f=await fixture(t,{context({context}){context.model.list=async()=>{entered.resolve();await pending.promise;return {data:[]};};}});
  const running=f.command('pr-check');await entered.promise;await f.cleanup();
  assert.match(await running,/] CANCELLED/);assert.equal(f.prompts().length,0);pending.resolve();
});

test('cancelling one origin during initial role pinning does not cancel another origin', {timeout:3000}, async t => {
  const entered=deferred(), pending=deferred(), otherPreflight=deferred();
  let held=false, commandReads=0;
  const f=await fixture(t,{context({context}){
    const get=context.agent.get, list=context.command.list;
    context.agent.get=async input=>{
      if(!held){held=true;entered.resolve();await pending.promise;}
      return get(input);
    };
    context.command.list=async()=>{
      if(++commandReads===3)otherPreflight.resolve();
      return list();
    };
  }});
  t.after(()=>pending.resolve());
  const first=f.command('pr-check',PR,'first');await entered.promise;
  const second=f.command('pr-check',PR,'second');await otherPreflight.promise;
  await new Promise(resolve=>setImmediate(resolve));
  await f.command('pr-stop','','first');assert.match(await first,/] CANCELLED/);
  pending.resolve();assert.match(await second,/] READY/);
});

for (const target of ['missing-model','no-tools','disconnected','invalid-catalog']) test(`readiness rejects ${target} before either initial reviewer starts`, async t => {
  const f=await fixture(t,{context({context}){
    const original=context.model.list;
    if(target==='disconnected')context.mcp.list=async()=>({data:[{name:'anything',status:{status:'needs_auth'}}]});
    else context.model.list=async()=>{
      if(target==='invalid-catalog')return {data:null};
      const models=await original();
      if(target==='missing-model')models.data=models.data.filter(m=>m.id!=='review-verifier');
      else models.data.find(m=>m.id==='review-verifier').capabilities.tools=false;
      return models;
    };
  }});
  assert.match(await f.command(),/] INCOMPLETE/);assert.equal(f.prompts().length,0);assert.equal(f.calls.filter(c=>c.kind==='create').length,0);
});
for(const missing of ['functional','risk','verifier']) test(`incomplete deep ${missing} stops without model fallback`,async t=>{
  const f=await fixture(t,{settings(s){s.models.deep[missing]='';}});await assert.rejects(f.command('pr-deep'),/All three/);assert.equal(f.calls.length,0);
});
for(const fault of ['final-snapshot','missing-id','stale']) test(`${fault} cannot become a publishable review`,async t=>{
  const f=await fixture(t,{result({role,result}){
    if(fault==='final-snapshot'&&role.endsWith('-verifier'))result.snapshot.head='c'.repeat(40);
    if(fault==='missing-id'&&role.endsWith('-verifier'))result.confirmed=result.confirmed.slice(0,1);
    if(fault==='stale'&&role.endsWith('-verifier'))result.currentHead='c'.repeat(40);return result;
  }}),receipt=await f.command();
  assert.equal(f.prompts().length,3,'Initial quality gaps still reach the verifier.');
  assert.doesNotMatch(receipt.split('\n')[0],/] COMPLETE$/);
  assert.match(receipt,/publication evidence contract/);
  const id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];await assert.rejects(f.command('pr-comment',id),/unavailable/);
});
for(const initial of ['disclosures','partial','conflicting-frame']) test(`a complete verifier permits preview despite initial ${initial}`,async t=>{
  const f=await fixture(t,{result({role,result}){
    if(role.endsWith('-risk')) {
      if(initial==='conflicting-frame')result.snapshot.head='c'.repeat(40);
      else {result.coverage.gaps=['Tests were not executed. The comparison base is not a proven merge base.'];if(initial==='partial')result.status='PARTIAL';}
    }
    return result;
  }});
  const receipt=await f.command(),id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  assert.match(receipt,/] COMPLETE/);assert.doesNotMatch(receipt,/publication evidence contract/);
  assert.equal(f.prompts().length,3);
  await assert.rejects(f.command('pr-comment',id,'another-origin'),/unavailable/);
  assert.match(await f.command('pr-comment',id),/] PREVIEW/);
  const packet=JSON.parse(f.prompts().at(-1).text);
  assert.ok(packet.reviewWarnings.length,'The planner sees the retained review limitations.');
  if(initial!=='conflicting-frame')assert.ok(packet.reviewWarnings.some(warning=>warning.includes('Tests were not executed.')));
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='fixture_mcp_write').length,0);
  assert.match(await f.command('pr-comment',id+' --publish'),/] MODEL_REPORTED_POSTED/);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='fixture_mcp_write').length,1);
});
for(const stop of ['cancel','dispose']) test(`${stop} revokes pending work without aborting the origin`,{timeout:3000},async t=>{
  const started=deferred(),release=deferred(),f=await fixture(t,{async during(){started.resolve();await release.promise;}});
  const running=f.command('pr-check');await started.promise;
  if(stop==='cancel')await f.command('pr-stop','');else await f.cleanup();
  const receipt=await running;release.resolve();assert.match(receipt,/] CANCELLED/);
  assert.ok(f.calls.some(c=>c.kind==='interrupt'));assert.ok(f.calls.filter(c=>c.kind==='interrupt').every(c=>c.sessionID!=='ordinary'&&c.resume===false));
});
test('initial execution failure preserves sibling work and reaches independent verification',{timeout:3000},async t=>{
  const both=deferred(),release=deferred();let count=0;
  const f=await fixture(t,{async during({session}){
    if(session.agent.endsWith('-verifier'))return;
    if(++count===2)both.resolve();await both.promise;
    if(session.agent.endsWith('-functional'))throw new Error('Provider failed');
    await release.promise;
  }});
  const running=f.command();await both.promise;release.resolve();
  const receipt=await running;assert.match(receipt,/] COMPLETE/);assert.equal(f.prompts().length,3);
  const packet=JSON.parse(f.prompts()[2].text);
  assert.equal(packet.reviews[0].status,'PARTIAL');assert.equal(packet.reviews[0].findings.length,0);
  assert.equal(packet.reviews[1].findings[0].id,'R-1');assert.doesNotMatch(receipt,/publication evidence contract/);
  const id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];assert.match(await f.command('pr-comment',id),/] PREVIEW/);
});
test('same-origin lock rejects concurrent commands',async t=>{
  const started=deferred(),release=deferred(),f=await fixture(t,{async during(){started.resolve();await release.promise;}});
  const running=f.command('pr-check');await started.promise;await assert.rejects(f.command(),/already running/);release.resolve();assert.match(await running,/] READY/);
});

test('PARTIAL initial retains evidence and coverage gaps in the verifier handoff',async t=>{
  const f=await fixture(t,{result({result,role}){if(role.endsWith('-functional')){result.status='PARTIAL';result.coverage.gaps=['Fixture source gap.'];}return result;}});
  const receipt=await f.command();assert.match(receipt,/] COMPLETE/);assert.equal(f.prompts().length,3);
  const saved=await resultLog(receipt),partial=saved.stages.find(stage=>stage.status==='PARTIAL');
  assert.equal(partial.result.findings[0].id,'F-1');assert.deepEqual(partial.result.coverage.gaps,['Fixture source gap.']);
  const packet=JSON.parse(f.prompts()[2].text);
  assert.deepEqual(packet.reviews[0].coverage.gaps,['Fixture source gap.']);
  assert.equal(saved.reportKind,'report');assert.doesNotMatch(receipt,/publication evidence contract/);
  const id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];assert.match(await f.command('pr-comment',id),/] PREVIEW/);
});
test('invalid standalone readiness retains the failure without another model request',async t=>{
  const f=await fixture(t,{result({result}){result.status='DONE';return result;}});
  const receipt=await f.command('pr-check');assert.match(receipt,/] INCOMPLETE/);assert.equal(f.prompts().length,1);
  assert.equal((await resultLog(receipt)).stages[0].status,'FAILED');
  const directory=/Private debug directory: ([^\n]+)/.exec(receipt)[1];
  const original=JSON.parse(await readFile(join(directory,'01-azpr-review-check.response.json'),'utf8'));
  assert.match(original.text,/"status":"DONE"/);
});
test('missing final location retains a partial report without another model request',async t=>{
  const f=await fixture(t,{result({role,packet,result}){if(role.endsWith('-verifier'))delete result.confirmed[0].location;return result;}});
  const receipt=await f.command();assert.match(receipt,/] PARTIAL/);assert.equal(f.prompts().length,3);
  assert.match(receipt,/<azpr_report_data>/);assert.match(receipt,/A reachable fixture branch/);assert.doesNotMatch(receipt,/Location amendment notice/);
});
test('a partial final with an incomplete confirmation still shows the original observation', async t => {
  const initialText='Original observation that must survive an incomplete final row';
  const f=await fixture(t,{result({result,role}){
    if(role.endsWith('-functional'))result.findings[0].summary=initialText;
    if(role.endsWith('-verifier'))result.confirmed[0]={id:'F-1',reason:'Incomplete confirmation'};
    return result;
  }});
  const receipt=await f.command();assert.match(receipt,/] PARTIAL/);assert.ok(receipt.includes(initialText));
  assert.equal(f.prompts().length,3);
});
test('large evidence survives JSON, verifier handoff and diagnostics without a hidden cap',async t=>{
  const evidence='x'.repeat(2100000),f=await fixture(t,{result({role,packet,result}){if(ROLES[role].format==='initial')result.findings[0].evidence=evidence;if(ROLES[role].format==='final')assert.ok(packet.reviews.every(r=>r.findings[0].evidence===evidence));return result;}});
  const receipt=await f.command();assert.match(receipt,/] COMPLETE/);const result=await resultLog(receipt);assert.ok(result.stages.at(-1).inputCharacters>4000000);assert.equal(result.stages.at(-1).remainingRunMsAtEnd,null);
});
test('extra final brace no longer cancels a useful initial review', async t => {
  const f=await fixture(t,{answer({answer,role}){if(role.endsWith('-functional'))answer.content[0].text+='}';}});
  const receipt=await f.command();assert.match(receipt,/] COMPLETE/);assert.equal(f.prompts().length,3);
  const packet=JSON.parse(f.prompts()[2].text);
  assert.deepEqual(packet.expectedFindingIds,['F-1','R-1']);assert.equal(packet.reviews[0].findings[0].evidence,finding('F-1').evidence);
  const saved=await resultLog(receipt);
  assert.equal(saved.stages[0].outputFormatCorrections[0].action,'remove-redundant-closing-delimiter');
});
test('unstructured initial and final reviews are delivered without a formatting retry', async t => {
  const raw='A useful review observation with source context and an unresolved limitation.';
  const f=await fixture(t,{answer({answer,role}){
    if(role.endsWith('-functional')||role.endsWith('-verifier'))answer.content[0].text=raw;
  }});
  const receipt=await f.command();assert.match(receipt,/] PARTIAL/);assert.equal(f.prompts().length,3);
  assert.equal(JSON.parse(f.prompts()[2].text).reviews[0].report,raw);
  assert.ok(receipt.includes(raw));assert.match(receipt,/<azpr_report_data>/);
  const id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];await assert.rejects(f.command('pr-comment',id),/unavailable/);
});
test('both unavailable initial reviews still permit the existing verifier to inspect the PR', async t => {
  const f=await fixture(t,{async during({session}){if(ROLES[session.agent].format==='initial')throw new Error('Initial service unavailable');}});
  const receipt=await f.command();assert.equal(f.prompts().length,3);assert.match(receipt,/] COMPLETE/);
  const packet=JSON.parse(f.prompts()[2].text);
  assert.equal(packet.snapshot,null);assert.deepEqual(packet.expectedFindingIds,[]);
  assert.ok(packet.reviews.every(review=>review.status==='PARTIAL'));
  assert.doesNotMatch(receipt,/publication evidence contract/);
  const id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];assert.match(await f.command('pr-comment',id),/] PREVIEW/);
});

test('code examples surrounding a complete final JSON do not require another review before comments',async t=>{
  const f=await fixture(t,{answer({answer,role}){
    if(role.endsWith('-verifier'))answer.content[0].text='Trigger: fn({"item":3}).\n```json\n'+answer.content[0].text+'\n```';
  }});
  const receipt=await f.command(),id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  assert.match(receipt,/] COMPLETE/);assert.equal(f.prompts().length,3);
  assert.match(await f.command('pr-comment',id),/] PREVIEW/);assert.equal(f.prompts().length,4);
});

test('normalized new verifier IDs allow same-origin preview without another review', async t => {
  const f = await fixture(t, { result({ result, role }) {
    if (ROLES[role].format === 'initial') result.findings = [];
    if (ROLES[role].format === 'final') result.newFindings = [finding('V001'), finding('V002')];
    return result;
  } });
  const receipt = await f.command();
  assert.match(receipt, /] COMPLETE/);
  const final = (await resultLog(receipt)).stages.find(stage => stage.stage === 'verifier').result;
  assert.deepEqual(final.newFindings.map(row => [row.id, row.originalId]), [['V-1', 'V001'], ['V-2', 'V002']]);
  const id = /AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  assert.match(await f.command('pr-comment', id), /] PREVIEW/);
  assert.equal(f.prompts().length, 4);
  const packet = JSON.parse(f.prompts().at(-1).text);
  assert.deepEqual(packet.findings, final.newFindings);
});

test('unconfirmed cleanup cannot leave a COMPLETE receipt without a comment cache entry',async t=>{
  const f=await fixture(t,{context({context}){context.session.interrupt=async()=>{throw new Error('Settlement unavailable');};},
    during({session}){if(session.agent.endsWith('-functional'))throw new Error('Provider failed');}});
  const receipt=await f.command();assert.match(receipt,/] INCOMPLETE/);
  assert.equal((await resultLog(receipt)).abortUnconfirmed,true);
  const id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];await assert.rejects(f.command('pr-comment',id),/unavailable/);
});

test('a verifier failure before model submission remains incomplete with actionable diagnostics',async t=>{
  const f=await fixture(t,{beforeContext({session}){if(session.agent.endsWith('-verifier'))throw new Error('Fixture host failure');}});
  const receipt=await f.command(),result=await resultLog(receipt),stage=result.stages.at(-1);
  assert.match(receipt,/] INCOMPLETE/);assert.equal(f.prompts().length,3);
  assert.match(receipt,/No authorized primary model request was observed/);
  assert.deepEqual(stage.execution,{sessionOutcome:'failed',terminalOutcome:'failed',assistantResponses:0,lastFinish:'unknown',interrupted:false,authorizedPrimaryRequests:0});
  assert.ok(Number.isFinite(stage.timing.wallMinusMonotonicMs));
});
test('provider-rejected preview preserves the completed review, starts no publisher and exposes only safe diagnostics',async t=>{
  let rejectPlan = true;
  const f = await fixture(t, { skipTool: true, async during({ invoke, session }) {
    if (!session.agent.endsWith('-comment-plan')) await invoke(session.id);
  }, answer({ answer, role }) {
    if (rejectPlan && role.endsWith('-comment-plan')) {
      answer.finish = 'error';
      answer.error = { type: 'provider.auth', status: 403, message: 'PRIVATE_PROVIDER_DETAIL', response: { body: 'PRIVATE_BODY' } };
      answer.content = [];
    }
  }});
  const review = await f.command(), id = /AZPR ([a-f0-9]{8})/.exec(review)[1];
  assert.match(review, /] COMPLETE/);
  const failed = await f.command('pr-comment', id);
  assert.match(failed, /] INCOMPLETE/);
  assert.match(failed, /HTTP 403; 0 tool calls observed/);
  assert.doesNotMatch(failed, /PRIVATE_PROVIDER_DETAIL|PRIVATE_BODY/);
  assert.deepEqual((await resultLog(failed)).stages[0].execution.provider, { status: 403, toolCallsObserved: 0 });
  assert.equal(f.prompts().length, 4);
  await assert.rejects(f.command('pr-comment', id + ' --publish'), /Preview first/);
  assert.equal(f.prompts().length, 4);
  assert.equal(f.calls.some(call => call.kind === 'executed-tool' && call.tool === 'fixture_mcp_write'), false);
  rejectPlan = false;
  assert.match(await f.command('pr-comment', id), /] PREVIEW/);
  assert.equal(f.prompts().length, 5, 'An explicitly requested new preview reuses the original COMPLETE review.');
});

test('comment publication needs a saved preview and explicit publish without a config switch',async t=>{
  const f=await fixture(t,{}),receipt=await f.command(),id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  await assert.rejects(f.command('pr-comment',id+' --publish'),/Preview first/);
  await assert.rejects(f.command('pr-comment',id,'other-origin'),/unavailable/);
  assert.match(await f.command('pr-comment',id),/] PREVIEW/);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='fixture_mcp_write').length,0);
  assert.match(await f.command('pr-comment',id+' --publish'),/] MODEL_REPORTED_POSTED/);await assert.rejects(f.command('pr-comment',id+' --publish'),/already had a publication/);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='fixture_mcp_write').length,1);
});

test('all twelve eligible findings reach the saved preview and explicitly requested publication',async t=>{
  const f=await fixture(t,{result({role,packet,result}){
    if(ROLES[role].format==='initial') result.findings=Array.from({length:6},(_,i)=>finding(`${ROLES[role].prefix}-${i+1}`));
    if(ROLES[role].stage==='comment-plan') {
      assert.equal(Object.hasOwn(packet,'maxComments'),false);
      result.comments=packet.findings.map((item,i)=>({findingId:item.id,severity:item.severity,path:SNAP.files[0],
        startLine:i+1,endLine:i+1,anchor:`fixture branch ${i+1}`,body:`issue (${item.severity}): Defect ${item.id}\n\nIndependent trigger, impact and correction ${i+1}.`}));
      result.skipped=[];
    }
    return result;
  }});
  const receipt=await f.command(),id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  const preview=await f.command('pr-comment',id);
  assert.match(preview,/] PREVIEW/);assert.match(preview,/Comments prepared: 12/);
  assert.equal((preview.match(/<!-- azpr-comment:/g)??[]).length,12);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='fixture_mcp_write').length,0);
  const published=await f.command('pr-comment',id+' --publish');
  assert.match(published,/] MODEL_REPORTED_POSTED/);
  const packet=JSON.parse(f.prompts().at(-1).text);
  assert.equal(packet.comments.length,12);
  for(const comment of packet.comments) assert.ok(preview.includes(comment.content));
  assert.equal((published.match(/; thread=101/g)??[]).length,12);
});

test('an empty saved preview starts no publisher even with explicit publish',async t=>{
  const f=await fixture(t,{result({role,packet,result}){
    if(ROLES[role].stage==='comment-plan') {
      result.comments=[];result.skipped=packet.findings.map(item=>({findingId:item.id,reason:'Already discussed.'}));
    }
    return result;
  }});
  const receipt=await f.command(),id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  assert.match(await f.command('pr-comment',id),/Comments prepared: 0/);
  const before=f.prompts().length;
  assert.match(await f.command('pr-comment',id+' --publish'),/] NOTHING_TO_POST/);
  assert.equal(f.prompts().length,before);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='fixture_mcp_write').length,0);
});

for(const failure of ['execution','metadata','result']) test(`publisher ${failure} error revokes authorization before another request or tool`,async t=>{
  const checked=deferred();
  const f=await fixture(t,{async during({invoke,emit,session}){
    if(ROLES[session.agent].stage!=='comment-publish')return;
    try {
      const result=failure==='metadata'?{metadata:{isError:true}}:{isError:true};
      await invoke(session.id,'arbitrary_operation',result,failure==='execution'?'error':'completed');
      await assert.rejects(emit('session','model.request',{sessionID:session.id,agent:session.agent,model:session.model,kind:'primary'}),/authorization|authorized/);
      await assert.rejects(invoke(session.id,'another_operation'),/authorization|authorized/);
      checked.resolve();
    } catch(error) {checked.resolve(error);throw error;}
  }});
  const receipt=await f.command(),id=/AZPR ([a-f0-9]{8})/.exec(receipt)[1];
  await f.command('pr-comment',id);
  const published=await f.command('pr-comment',id+' --publish');
  assert.equal(await checked.promise,undefined);
  assert.match(published,/] INCOMPLETE/);assert.match(published,/publisher tool failed/i);
  assert.match(published,/UNKNOWN/);assert.doesNotMatch(published,/MODEL_REPORTED_POSTED/);
  assert.doesNotMatch(published,/PRIVATE_ERROR|PRIVATE_INPUT/);
  const stage = (await resultLog(published)).stages[0];
  assert.deepEqual(stage.toolErrors, [{ tool: 'arbitrary_operation',
    source: failure === 'execution' ? 'execution' : 'result-flag',
    ...(failure === 'execution' ? { error: { name: 'Error', message: 'PRIVATE_ERROR' } } : {}) }]);
  assert.doesNotMatch(JSON.stringify(stage.toolErrors), /PRIVATE_INPUT/);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&c.tool==='arbitrary_operation').length,1);
  assert.equal(f.calls.filter(c=>c.kind==='executed-tool'&&['another_operation','fixture_mcp_write'].includes(c.tool)).length,0);
  await assert.rejects(f.command('pr-comment',id+' --publish'),/already had a publication/);
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

test('verifier shares the original review deadline instead of starting a new timer',{timeout:3000},async t=>{
  const f=await fixture(t,{settings(s){s.runTimeoutSeconds=10;},
    during({session}){if(session.agent.endsWith('-functional'))t.mock.timers.tick(6000);if(session.agent.endsWith('-verifier'))t.mock.timers.tick(4000);}});
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const receipt=await f.command();assert.match(receipt,/] TIMED_OUT/);assert.equal(f.prompts().length,3);
  const verifier=(await resultLog(receipt)).stages.find(s=>s.stage==='verifier');
  assert.equal(verifier.remainingRunMsAtStart,4000);assert.equal(verifier.remainingRunMsAtEnd,0);
});

test('captured truncated output is retained privately and never accepted or resubmitted',async t=>{
  const f=await fixture(t,{answer({answer}){answer.finish='length';}});
  const receipt=await f.command('pr-check');assert.match(receipt,/] INCOMPLETE/);assert.equal(f.prompts().length,1);
  const directory=/Private debug directory: ([^\n]+)/.exec(receipt)[1];
  const saved=JSON.parse(await readFile(join(directory,'01-azpr-review-check.response.json'),'utf8'));
  assert.equal(saved.finish,'length');assert.match(saved.text,/Source access ready/);
});

for (const mode of ['review', 'deep']) test(`${mode} reviewers use native project tools; failed commands do not veto COMPLETE preview`, async t => {
  const executed = [];
  const f = await fixture(t, {
    async during({ session, invoke }) {
      const spec = ROLES[session.agent];
      if (['initial', 'final'].includes(spec.format)) {
        for (const tool of ['shell', 'read', 'glob', 'grep']) {
          await invoke(session.id, tool, { output: 'Fixture command failed; source evidence remains available.', metadata: { exit: 7 } });
          executed.push({ id: session.id, tool });
        }
      } else if (spec.comment) {
        for (const tool of ['shell', 'read', 'glob', 'grep']) {
          await invoke(session.id, tool);
          executed.push({ id: session.id, tool });
        }
      } else {
        await assert.rejects(invoke(session.id, 'shell'), /Native tool denied/);
      }
    },
  });
  assert.match(await f.command('pr-check'), /READY/);
  const receipt = await f.command(mode === 'deep' ? 'pr-deep' : 'pr-review');
  assert.match(receipt, /\] COMPLETE/); assert.equal(executed.length, 12);
  for (const { id, tool } of executed) await assert.rejects(f.invoke(id, tool), /authorization expired/);
  const id = receipt.match(/AZPR ([a-f0-9]{8})/)[1];
  assert.match(await f.command('pr-comment', id), /\] PREVIEW/);
  assert.equal(executed.length, 16);
  assert.match(await f.command('pr-comment', id + ' --publish'), /\] MODEL_REPORTED_POSTED/);
  assert.equal(executed.length, 20);
  for (const { id, tool } of executed) await assert.rejects(f.invoke(id, tool), /authorization expired/);
  for (const agent of f.agents.values()) assert.ok(agent.permissions.some(rule => rule.action === 'fixture_mcp_write' && rule.effect === 'deny'));
});

for (const tool of ['shell', 'read', 'glob', 'grep']) test(`project ${tool} rechecks reviewer model binding before execution`, async t => {
  const f = await fixture(t, {
    async during({ session, invoke }) {
      const prior = session.model;
      session.model = { providerID: 'fixture', id: 'wrong', variant: 'default' };
      await assert.rejects(invoke(session.id, tool), /Model mismatch/);
      session.model = prior;
    },
  });
  assert.match(await f.command(), /\] COMPLETE/);
  assert.equal(f.calls.filter(call => call.kind === 'executed-tool' && call.tool === tool).length, 0);
  await assert.rejects(f.emit('tool', 'execute.before', { sessionID: 'ordinary', agent: 'azpr-review-functional', tool }), /authorization expired/);
});

test('project tools require literal admission and an authorized model request', async t => {
  const probe = async ({ session, emit }) => {
    for (const tool of ['shell', 'read', 'glob', 'grep']) {
      await assert.rejects(emit('tool', 'execute.before', { sessionID: session.id, agent: session.agent, id: 'unadmitted', tool }), /admitted reviewer input/);
    }
  };
  const f = await fixture(t, { beforePrompt: probe, beforeContext: probe });
  assert.match(await f.command(), /\] COMPLETE/);
  assert.equal(f.calls.filter(call => call.kind === 'executed-tool' && call.tool !== 'fixture_mcp_read').length, 0);
});

test('a publisher denied CodeMode loses its grants before another tool can start', async t => {
  let denied = false;
  const f = await fixture(t, {
    async during({ session, emit, invoke }) {
      if (ROLES[session.agent].stage !== 'comment-publish') return;
      const event = { sessionID: session.id, agent: session.agent, id: 'publisher-denied-execute', tool: 'execute', input: { code: '1 + 1' } };
      await assert.rejects(emit('tool', 'execute.before', event), /Native tool denied/);
      await emit('tool', 'execute.after', { ...event, status: 'error', error: new Error('Denied fixture CodeMode') });
      await assert.rejects(invoke(session.id, 'fixture_mcp_write'), /authorization expired/);
      denied = true;
    },
  });
  const receipt = await f.command(); const id = receipt.match(/AZPR ([a-f0-9]{8})/)[1];
  assert.match(await f.command('pr-comment', id), /\] PREVIEW/);
  const before = f.calls.filter(call => call.kind === 'executed-tool').length;
  assert.match(await f.command('pr-comment', id + ' --publish'), /\] INCOMPLETE/);
  assert.equal(denied, true);
  assert.equal(f.calls.filter(call => call.kind === 'executed-tool').length, before);
});
