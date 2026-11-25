import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewSession, requestReview as sendReview, interruptSession, appendReport, classifyFailure, restartIndex } from '../src/session.mjs';

const sessionID = 'ses_review';
const input = 'https://example.test/pr/2 literal $ARGUMENTS `pwd` @private.txt';
const model = { providerID: 'example', id: 'model/path' };
const requestReview = (context, input) => sendReview(context, { role: 'azpr-review-functional', model, ...input });
const assistant = (fields = {}) => ({
  id: 'msg_answer', type: 'assistant', agent: 'azpr-review-functional', model,
  finish: 'stop', time: { created: 2, completed: 3 },
  content: [{ type: 'text', text: '{"status":"COMPLETE"}' }], ...fields,
});
const idle = () => ({ id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 4 } });
const admitted = () => ({ id: 'msg_input', sessionID, type: 'user', payload: { text: input }, delivery: 'steer' });

function host(overrides = {}) {
  const calls = [];
  const implementations = {
    create: async value => ({ id: sessionID, ...value }),
    prompt: async () => admitted(),
    wait: async () => {},
    context: async () => [{ id: 'msg_input', type: 'user', text: input }, assistant(), idle()],
    get: async () => ({ id: sessionID, outcome: 'succeeded', agent: 'azpr-review-functional', model }),
    interrupt: async () => ({ interrupted: true }),
    synthetic: async value => ({ id: 'msg_report', sessionID: value.sessionID, type: 'synthetic', payload: { text: value.text }, delivery: value.delivery }),
    ...overrides,
  };
  const context = { session: Object.fromEntries(Object.entries(implementations).map(([name, fn]) => [name, async (...args) => {
    calls.push({ name, args });
    return fn(...args);
  }])) };
  return { context, calls };
}

test('V2 creation binds exact agent/model and preserves supplied session permission denials', async () => {
  const { context, calls } = host();
  const permissions = [{ action: 'shell', resource: '*', effect: 'deny' }];
  const made = await createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model: 'example/model/path', permissions });
  assert.equal(made.id, sessionID);
  assert.deepEqual(calls, [{ name: 'get', args: [{ sessionID: 'ses_origin' }] },
    { name: 'create', args: [{ title: 'review', agent: 'azpr-review-functional', model, permissions }] }]);
});

test('V2 creation makes a session of its own at the conversation\'s location, with the given metadata and no parent', async () => {
  const metadata = { azpr: { run: '1a2b3c4d', role: 'azpr-review-functional', conversation: 'ses_origin' } };
  const conversation = location => async ({ sessionID: id }) => ({ id, ...(location ? { location } : {}) });
  for (const [location, sent] of [
    [{ directory: '/work/project', workspaceID: 'wrk_1' }, { directory: '/work/project', workspaceID: 'wrk_1' }],
    [{ directory: '/work/project' }, { directory: '/work/project' }],
    // Without a usable location the host places the session where this plugin instance runs.
    [undefined, undefined], [{ directory: '' }, undefined], [{ workspaceID: 'wrk_1' }, undefined],
  ]) {
    const { context, calls } = host({ get: conversation(location) });
    await createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model, metadata });
    const input = calls.find(call => call.name === 'create').args[0];
    assert.deepEqual(input, { title: 'review', agent: 'azpr-review-functional', model, ...(sent ? { location: sent } : {}), metadata });
    assert.equal(Object.hasOwn(input, 'parentID'), false, 'Never a child: OpenCode 2.3.0 hands a child\'s answers to its parent.');
  }
  // A conversation that cannot be read does not stop the review; the host's own location applies.
  const unread = host({ get: async () => { throw new Error('conversation unavailable'); } });
  await createReviewSession(unread.context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model });
  assert.deepEqual(unread.calls.find(call => call.name === 'create').args[0], { title: 'review', agent: 'azpr-review-functional', model });
  // Hosts may wrap records in { data }.
  const wrapped = host({ get: async ({ sessionID: id }) => ({ data: { id, location: { directory: '/work/project' } } }) });
  await createReviewSession(wrapped.context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model });
  assert.deepEqual(wrapped.calls.find(call => call.name === 'create').args[0].location, { directory: '/work/project' });
});

test('V2 creation rejects changed or reused session identity before prompting', async () => {
  const placed = async ({ sessionID: id }) => ({ id, location: { directory: '/work/project' } });
  for (const altered of [{ id: 'ses_origin' }, { parentID: 'ses_origin' }, { parentID: 'ses_other' }, { agent: 'build' }, { model: { ...model, id: 'other' } },
    { location: { directory: '/elsewhere' } }]) {
    const { context, calls } = host({ get: placed, create: async value => ({ ...value, id: sessionID, ...altered }) });
    await assert.rejects(createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model }), /independent reviewer/);
    assert.equal(calls.filter(call => call.name === 'create').length, 1);
  }
  // A host that does not echo the location, or names no parent as null, is accepted.
  for (const tolerated of [{ location: undefined }, { parentID: null }]) {
    const { context } = host({ get: placed, create: async value => ({ ...value, id: sessionID, ...tolerated }) });
    assert.equal((await createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model })).id, sessionID);
  }
});

test('V2 creation is cancelled while the conversation is read, before a session exists', async () => {
  const controller = new AbortController();
  const { context, calls } = host({ get: () => new Promise(() => {}) });
  const pending = createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('manual cancellation'));
  await assert.rejects(pending, /manual cancellation/);
  assert.deepEqual(calls.map(call => call.name), ['get']);
});

test('a session the host creates after the call was cancelled is handed to the caller, which deletes it', async () => {
  const creation = (answer = value => ({ id: sessionID, ...value })) => {
    const controller = new AbortController(), late = [];
    let finish, fail;
    const { context, calls } = host({ create: value => new Promise((resolve, reject) => { finish = () => resolve(answer(value)); fail = reject; }) });
    const pending = createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model, signal: controller.signal,
      onLate: session => late.push(session.id) });
    const asked = async () => { while (!calls.some(call => call.name === 'create')) await new Promise(resolve => setImmediate(resolve)); };
    const settled = () => new Promise(resolve => setTimeout(resolve, 5));
    return { controller, late, pending, asked, settled, finish: () => finish(), fail: error => fail(error) };
  };
  const cancelled = creation();
  await cancelled.asked();
  cancelled.controller.abort(new Error('manual cancellation'));
  await assert.rejects(cancelled.pending, /manual cancellation/);
  assert.deepEqual(cancelled.late, [], 'Nothing exists yet.');
  cancelled.finish();
  await cancelled.settled();
  assert.deepEqual(cancelled.late, [sessionID], 'The session created afterwards is handed over.');
  // Only the session this call asked for: never one with another identity, and nothing after a failed creation.
  for (const answer of [value => ({ id: 'ses_origin', ...value }), value => ({ id: sessionID, ...value, agent: 'build' }), value => ({ id: sessionID, ...value, parentID: 'ses_origin' }), () => null]) {
    const other = creation(answer);
    await other.asked();
    other.controller.abort(new Error('manual cancellation'));
    await assert.rejects(other.pending, /manual cancellation/);
    other.finish();
    await other.settled();
    assert.deepEqual(other.late, []);
  }
  const failed = creation();
  await failed.asked();
  failed.controller.abort(new Error('manual cancellation'));
  await assert.rejects(failed.pending, /manual cancellation/);
  failed.fail(new Error('host could not create it'));
  await failed.settled();
  assert.deepEqual(failed.late, []);
  // A creation that finishes in time is returned, not handed over.
  const timely = creation();
  await timely.asked();
  timely.finish();
  assert.equal((await timely.pending).id, sessionID);
  assert.deepEqual(timely.late, []);
});

test('V2 creation accepts the host-normalized default model variant', async () => {
  const { context } = host({ create: async value => ({ ...value, id: sessionID, model: { ...value.model, variant: 'default' } }) });
  const made = await createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model });
  assert.equal(made.model.variant, 'default');
});

test('V2 prompt queues literal input, waits, and reads only final assistant text', async () => {
  const { context, calls } = host({ context: async () => [
    assistant({ id: 'msg_old', content: [{ type: 'text', text: 'old answer' }] }),
    { id: 'msg_input', type: 'user', text: input },
    assistant({ id: 'msg_tool', finish: 'tool-calls', content: [{ type: 'tool', id: 'tool_1', state: { status: 'completed' } }] }),
    assistant({ content: [{ type: 'reasoning', text: 'not retained' }, { type: 'text', text: '{"status":"COMPLETE"}' }] }), idle(),
  ] });
  const answer = await requestReview(context, { sessionID, text: input });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }]);
  assert.equal(JSON.stringify(answer).includes('not retained'), false);
  assert.equal(answer.info.finish, 'stop');
  assert.deepEqual(calls.map(call => call.name), ['prompt', 'wait', 'context', 'get']);
  assert.deepEqual(calls[0].args, [{ sessionID, text: input, delivery: 'steer', resume: true }]);
});

test('V2 prompt rejects changed admission or added attachments', async () => {
  for (const change of [{ payload: { text: input + ' changed' } }, { sessionID: 'ses_other' }, { payload: { text: input, files: [{}] } }, { delivery: 'queue' }]) {
    const { context, calls } = host({ prompt: async () => ({ ...admitted(), ...change }) });
    await assert.rejects(requestReview(context, { sessionID, text: input }), /exact literal/);
    assert.deepEqual(calls.map(call => call.name), ['prompt']);
  }
});

test('V2 prompt binds admission metadata without including it in model text', async () => {
  const metadata = { azprGrant: 'opaque-test-nonce' };
  const { context, calls } = host({
    prompt: async () => ({ ...admitted(), payload: { text: input, metadata } }),
    context: async () => [{ id: 'msg_input', type: 'user', text: input, metadata }, assistant(), idle()],
  });
  await requestReview(context, { sessionID, text: input, metadata });
  assert.deepEqual(calls[0].args[0].metadata, metadata);
  assert.equal(calls[0].args[0].text, input);
  const changed = host({ prompt: async () => ({ ...admitted(), payload: { text: input, metadata: { azprGrant: 'other' } } }) });
  await assert.rejects(requestReview(changed.context, { sessionID, text: input, metadata }), /exact literal/);
});

test('V2 output fails closed when active context lacks the exact admitted prompt', async () => {
  for (const messages of [[assistant(), idle()], [{ id: 'msg_input', type: 'user', text: input }, { id: 'msg_input', type: 'user', text: input }, assistant(), idle()]]) {
    const { context } = host({ context: async () => messages });
    await assert.rejects(requestReview(context, { sessionID, text: input }), /absent or ambiguous/);
  }
});

test('V2 output rejects interleaved input, changed projected text, and selected agent changes', async () => {
  for (const changed of [{ type: 'user', text: 'foreign input' }, { type: 'synthetic', text: 'foreign input' }, { type: 'agent-switched', agent: 'build' }, { type: 'model-switched', model }]) {
    const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, changed, assistant(), idle()] });
    await assert.rejects(requestReview(context, { sessionID, text: input }), /another message during this turn/);
  }
  const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: 'different' }, assistant(), idle()] });
  await assert.rejects(requestReview(context, { sessionID, text: input }), /projected prompt differs/);
});

test('V2 output rejects incomplete, truncated, filtered, failed and interrupted executions', async () => {
  for (const final of [assistant({ finish: 'length' }), assistant({ finish: 'content-filter' }), assistant({ finish: 'error' }), assistant({ finish: 'unknown' }), assistant({ time: { created: 2 } }), assistant({ error: { type: 'provider', message: 'retained error' } }), assistant({ finish: 'tool-calls' })]) {
    const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, final, idle()] });
    await assert.rejects(requestReview(context, { sessionID, text: input }), error => {
      assert.ok(error.response);
      assert.equal(error.response.info.finish, final.finish);
      return true;
    });
  }
  // The turn's own idle marker says how it ended. The session's outcome is that of its latest execution: by the
  // time it is read, a command that ended later can have woken the session, and that execution is not this turn.
  for (const outcome of ['failed', 'interrupted']) {
    const { context } = host({ get: async () => ({ id: sessionID, outcome, agent: 'azpr-review-functional', model }) });
    assert.deepEqual((await requestReview(context, { sessionID, text: input })).parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }], outcome);
    // A turn without a marker of its own has only the session's outcome to go by.
    const { context: unmarked } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, assistant()],
      get: async () => ({ id: sessionID, outcome, agent: 'azpr-review-functional', model }) });
    await assert.rejects(requestReview(unmarked, { sessionID, text: input }), error => {
      assert.match(error.message, /did not finish successfully/);
      assert.deepEqual([error.execution.sessionOutcome, error.execution.terminalOutcome, error.execution.interrupted], [outcome, 'missing-idle', outcome === 'interrupted']);
      return true;
    });
  }
});

test('a turn ends at the first idle marker after an answer; a marker before any answer is an earlier execution\'s', async () => {
  const prompt = { id: 'msg_input', type: 'user', text: input };
  const answer = (id, text) => assistant({ id, content: [{ type: 'text', text }] });
  // The host had begun something in the session before the prompt arrived (a command that ended had woken it),
  // and that execution ended, without an answer, after the prompt was admitted.
  for (const outcome of ['failed', 'succeeded']) {
    const { context } = host({ context: async () => [prompt, { id: 'msg_stale', type: 'idle', outcome }, answer('msg_answer', '{"answer":"to the prompt"}'), idle()] });
    assert.deepEqual((await requestReview(context, { sessionID, text: input })).parts, [{ type: 'text', text: '{"answer":"to the prompt"}' }], outcome);
  }
  // Nothing but that marker: the prompt was never answered.
  const { context: unanswered } = host({ context: async () => [prompt, { id: 'msg_stale', type: 'idle', outcome: 'failed' }], get: async () => ({ id: sessionID, outcome: 'failed', agent: 'azpr-review-functional', model }) });
  await assert.rejects(requestReview(unanswered, { sessionID, text: input }), error => error.execution.terminalOutcome === 'failed' && error.execution.assistantResponses === 0);
  // What the session's own model wrote after the turn's marker (the host woke it) is no part of the answer.
  const { context: woken } = host({ context: async () => [prompt, answer('msg_first', '{"answer":"given"}'), idle(), answer('msg_later', 'Something the session said afterwards.'), { ...idle(), id: 'msg_idle2', outcome: 'failed' }] });
  assert.deepEqual((await requestReview(woken, { sessionID, text: input })).parts, [{ type: 'text', text: '{"answer":"given"}' }]);
});

test('the caller is told that the session is idle before its context is read', async () => {
  const order = [];
  const { context } = host({ wait: async () => { order.push('wait'); }, context: async () => { order.push('context'); return [{ id: 'msg_input', type: 'user', text: input }, assistant(), idle()]; } });
  await requestReview(context, { sessionID, text: input, settled: () => order.push('settled') });
  assert.deepEqual(order, ['wait', 'settled', 'context']);
  // Not when the wait itself fails: the caller closes what it opened either way.
  const { context: failing } = host({ wait: async () => { throw new Error('wait failed'); } });
  let told = 0;
  await assert.rejects(requestReview(failing, { sessionID, text: input, settled: () => told++ }), /wait failed/);
  assert.equal(told, 0);
});

test('V2 output rejects stale idle markers or missing terminal settlement', async () => {
  for (const suffix of [[idle(), assistant()], [assistant()], [assistant(), { ...idle(), outcome: 'interrupted' }]]) {
    const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, ...suffix] });
    await assert.rejects(requestReview(context, { sessionID, text: input }), /did not finish successfully/);
  }
});

test('failed and interrupted sessions expose terminal states without leaking provider error text', async () => {
  for (const outcome of ['failed', 'interrupted']) {
    const final = assistant({ finish: 'error', error: { type: 'aborted', message: 'PRIVATE_PROVIDER_DETAIL' } });
    const { context } = host({ get: async () => ({ id: sessionID, outcome }),
      context: async () => [{ id: 'msg_input', type: 'user', text: input }, final, { ...idle(), outcome }] });
    await assert.rejects(requestReview(context, { sessionID, text: input }), error => {
      assert.equal(error.execution.sessionOutcome, outcome);
      assert.equal(error.execution.terminalOutcome, outcome);
      assert.equal(error.execution.assistantResponses, 1);
      assert.equal(error.execution.lastFinish, 'error');
      assert.equal(error.execution.interrupted, true);
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_DETAIL/);
      assert.equal(error.response.info.error.message, 'PRIVATE_PROVIDER_DETAIL');
      return true;
    });
  }
  const { context } = host({ get: async () => ({ id: sessionID, outcome: 'failed' }),
    context: async () => [{ id: 'msg_input', type: 'user', text: input }, { ...idle(), outcome: 'failed' }] });
  await assert.rejects(requestReview(context, { sessionID, text: input }), error => {
    assert.equal(error.execution.assistantResponses, 0);
    assert.equal(error.response, undefined);
    return true;
  });
});

test('provider failures expose status and observed tool turns while retaining private error details only in diagnostics', async () => {
  for (const status of [401, 403, 429, 503]) for (const toolCount of [0, 2]) {
    const detail = { type: status < 429 ? 'provider.auth' : 'provider.api', status,
      message: 'PRIVATE_PROVIDER_DETAIL', response: { body: 'PRIVATE_REQUEST_BODY' } };
    const final = assistant({ finish: 'error', error: detail });
    const toolTurn = assistant({ id: 'msg_tools', finish: 'tool-calls',
      content: Array.from({ length: toolCount }, (_, i) => ({ type: 'tool', id: `tool_${i}`, state: { status: 'completed' } })) });
    const { context, calls } = host({ get: async () => ({ id: sessionID, outcome: 'failed' }),
      context: async () => [assistant({ id: 'old_tools', content: [{ type: 'tool' }] }),
        { id: 'msg_input', type: 'user', text: input }, toolTurn, final, { ...idle(), outcome: 'failed' }] });
    await assert.rejects(requestReview(context, { sessionID, text: input }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}; ${toolCount} tool calls observed`));
      assert.equal(error.message.includes('tool permissions'), [401, 403].includes(status));
      assert.deepEqual(error.execution.provider, { status, toolCallsObserved: toolCount });
      assert.doesNotMatch(error.message + JSON.stringify(error.execution), /PRIVATE_/);
      assert.deepEqual(error.response.info.error, detail);
      return true;
    });
    assert.deepEqual(calls.map(call => call.name), ['prompt', 'wait', 'context', 'get']);
  }
});

test('a used-up usage or spend limit is named and not retried, with or without an HTTP status', async () => {
  for (const [type, status, named] of [['provider.quota', 429, /usage quota as used up \(provider\.quota\)/], ['provider.free-limit', 429, /free model's usage limit as reached \(provider\.free-limit\)/],
    ['provider.chatgpt-limit', 429, /ChatGPT reports the subscription usage limit as reached \(provider\.chatgpt-limit\)/],
    ['provider.chatgpt-workspace-limit', 429, /ChatGPT reports the usage limit set by the workspace's admin as reached \(provider\.chatgpt-workspace-limit\)/],
    ['provider.go-limit', 429, /OpenCode Go reports its usage limit as reached \(provider\.go-limit\)/],
    ['provider.budget-limit', 429, /workspace usage limit as reached \(provider\.budget-limit\)/],
    ['provider.model-budget-limit', 429, /this model's spend limit as reached \(provider\.model-budget-limit\)/],
    ['provider.quota', undefined, /provider\.quota/], ['provider.free-limit', 'PRIVATE_STATUS', /provider\.free-limit/], ['provider.chatgpt-limit', undefined, /provider\.chatgpt-limit/]]) {
    const detail = { type, ...(status === undefined ? {} : { status }), message: 'PRIVATE_PROVIDER_DETAIL', response: { body: 'PRIVATE_REQUEST_BODY' } };
    const { context } = host({ get: async () => ({ id: sessionID, outcome: 'failed' }),
      context: async () => [{ id: 'msg_input', type: 'user', text: input }, assistant({ finish: 'error', error: detail }), { ...idle(), outcome: 'failed' }] });
    await assert.rejects(requestReview(context, { sessionID, text: input }), error => {
      assert.match(error.message, named);
      assert.match(error.message, /new session would fail the same way and is not started/);
      assert.equal(error.message.includes('HTTP'), status === 429, 'Only a valid status is shown.');
      assert.deepEqual(error.execution.provider, { ...(status === 429 ? { status } : {}), exhausted: type, toolCallsObserved: 0 });
      assert.doesNotMatch(error.message + JSON.stringify(error.execution), /PRIVATE_/);
      assert.equal(classifyFailure(error), 'permanent', `${type} ${status}`);
      return true;
    });
  }
});

test('untrusted or missing provider metadata and interrupted runs keep the generic execution failure', async () => {
  for (const detail of [
    { type: 'provider.auth', status: '403 PRIVATE_DETAIL' },
    { type: 'provider.auth', status: 200 }, { type: 'provider.auth', status: 600 },
    { type: 'provider.auth', status: 403.5 }, { type: 'provider.auth' },
    { type: 'host.error', status: 403 }, { status: 403 },
    { type: 'provider.auth', status: 403, interrupted: true },
  ]) {
    const outcome = detail.interrupted ? 'interrupted' : 'failed';
    const { context } = host({ get: async () => ({ id: sessionID, outcome }),
      context: async () => [{ id: 'msg_input', type: 'user', text: input },
        assistant({ finish: 'error', error: detail }), { ...idle(), outcome }] });
    await assert.rejects(requestReview(context, { sessionID, text: input }), error => {
      assert.match(error.message, /did not finish successfully/);
      assert.doesNotMatch(error.message, /HTTP|PRIVATE_DETAIL/);
      assert.equal(Object.hasOwn(error.execution, 'provider'), false);
      return true;
    });
  }
});

test('V2 output requires the granted agent/model in session and every assistant turn', async () => {
  for (const changed of [{ agent: 'build' }, { model: { ...model, id: 'other' } }, { model: { ...model, variant: 'other' } }]) {
    const selection = host({ get: async () => ({ id: sessionID, outcome: 'succeeded', agent: 'azpr-review-functional', model, ...changed }) });
    await assert.rejects(requestReview(selection.context, { sessionID, text: input }), /binding changed/);
    const output = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, assistant(changed), idle()] });
    await assert.rejects(requestReview(output.context, { sessionID, text: input }), /binding changed/);
  }
  const defaults = host({
    get: async () => ({ id: sessionID, outcome: 'succeeded', agent: 'azpr-review-functional', model: { ...model, variant: 'default' } }),
    context: async () => [{ id: 'msg_input', type: 'user', text: input }, assistant({ model: { ...model, variant: 'default' } }), idle()],
  });
  assert.equal((await requestReview(defaults.context, { sessionID, text: input })).info.finish, 'stop');
});

test('V2 interruption requires settlement after acknowledgment, including idle no-op', async () => {
  for (const interrupted of [true, false]) {
    const { context, calls } = host({ interrupt: async () => ({ interrupted }) });
    assert.deepEqual(await interruptSession(context, { sessionID }), { interrupted, settled: true });
    assert.deepEqual(calls, [{ name: 'interrupt', args: [{ sessionID, resume: false }] }, { name: 'wait', args: [{ sessionID }] }]);
  }
  const { context } = host({ wait: async () => { throw new Error('settlement unavailable'); } });
  await assert.rejects(interruptSession(context, { sessionID }), /settlement unavailable/);
});

test('V2 cancellation cannot certify idle before a delayed admission settles', async () => {
  let admit;
  const { context, calls } = host({ prompt: () => new Promise(resolve => { admit = resolve; }) });
  const controller = new AbortController();
  const pending = requestReview(context, { sessionID, text: input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  const reason = new Error('manual cancellation');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  const cleanup = interruptSession(context, { sessionID });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call.name), ['prompt']);
  admit(admitted());
  await cleanup;
  assert.deepEqual(calls.map(call => call.name), ['prompt', 'interrupt', 'wait']);
});

test('V2 local cancellation releases a pending wait without adding timers or another prompt', async () => {
  const controller = new AbortController();
  const { context, calls } = host({ wait: () => new Promise(() => {}) });
  const pending = requestReview(context, { sessionID, text: input, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('manual cancellation'));
  await assert.rejects(pending, /manual cancellation/);
  assert.deepEqual(calls.map(call => call.name), ['prompt', 'wait']);
});

test('V2 report delivery leaves the exact report in the inbox, steered, without starting a model call', async () => {
  const { context, calls } = host();
  assert.deepEqual(await appendReport(context, { sessionID: 'ses_origin', text: 'Final report' }), { queued: true, id: 'msg_report' });
  assert.deepEqual(calls, [{ name: 'synthetic', args: [{ sessionID: 'ses_origin', text: 'Final report', description: 'Final report', delivery: 'steer', resume: false }] }]);
  // A host that stores the notice as a queued item would give it a turn of the conversation's model: refuse it.
  const queueing = host({ synthetic: async value => ({ id: 'msg_report', sessionID: value.sessionID, type: 'synthetic', payload: { text: value.text }, delivery: 'queue' }) });
  await assert.rejects(appendReport(queueing.context, { sessionID: 'ses_origin', text: 'Final report' }), /did not acknowledge the report/);
});

const continuationText = 'The previous response was interrupted. Continue from where you left off without repeating completed content.';
function continuationTurn() {
  const error = { type: 'provider.invalid-output', status: 200, message: 'OpenAI Chat stream ended without finish_reason' };
  return [assistant({ id: 'msg_fragment', finish: 'error', error, retry: { attempt: 2, at: 4, error },
    content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: '{"status":"COM' }] }),
  { type: 'synthetic', text: continuationText },
  assistant({ content: [{ type: 'text', text: 'PLETE"}' }] }), idle()];
}
test('review text can complete through the pinned host continuation protocol without another plugin prompt', async () => {
  const { context, calls } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, ...continuationTurn()] });
  const answer = await requestReview(context, { sessionID, text: input, allowHostContinuations: true });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }]);
  assert.equal(answer.continuation.count, 1);
  assert.equal(answer.continuation.fragments[0].info.finish, 'error');
  assert.equal(answer.continuation.fragments[0].parts[0].text, '{"status":"COM');
  assert.doesNotMatch(JSON.stringify(answer), /PRIVATE_REASONING/);
  assert.equal(calls.filter(call => call.name === 'prompt').length, 1);
  await assert.rejects(requestReview(context, { sessionID, text: input }), /another message during this turn/);
});
test('host continuation cannot excuse foreign input, tool execution, binding changes or unfinished execution', async () => {
  const mutations = [
    turn => delete turn[0].retry,
    turn => turn[0].retry.attempt = 0,
    turn => delete turn[0].error,
    turn => turn[0].finish = 'length',
    turn => turn[0].content.push({ type: 'tool', id: 'unexpected' }),
    turn => turn[1].text = 'foreign input',
    turn => turn[1].type = 'user',
    turn => turn[2].agent = 'build',
    turn => turn[2].model = { ...model, id: 'changed' },
    turn => turn[2].finish = 'tool-calls',
    turn => turn[2].content.push({ type: 'tool', id: 'unexpected' }),
    turn => turn[3].outcome = 'interrupted',
    turn => turn.splice(2, 0, { type: 'synthetic', text: 'foreign input' }),
  ];
  for (const mutate of mutations) {
    const turn = continuationTurn(); mutate(turn);
    const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, ...turn] });
    await assert.rejects(requestReview(context, { sessionID, text: input, allowHostContinuations: true }));
  }
});

test('host continuation is accepted for any provider error wording and a reworded host continuation', async () => {
  const turn = continuationTurn();
  turn[0].error = { type: 'provider.api', status: 502, message: 'Anthropic stream closed unexpectedly' };
  turn[1].text = 'The previous response was interrupted; please continue where you stopped.';
  const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, ...turn] });
  const answer = await requestReview(context, { sessionID, text: input, allowHostContinuations: true });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }]);
});

// OpenCode 2.3.0: a step whose stream broke stays as an errored message marked for retry, directly followed by the
// retried step's own assistant message; no continuation message is queued.
function retriedTurn() {
  const error = { type: 'provider.transport', status: 200, message: 'Connection lost while reading the response' };
  return [assistant({ id: 'msg_cut', finish: 'error', error, retry: { attempt: 2, at: 4, error },
    content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: '{"status":"COM' }] }),
  assistant({ content: [{ type: 'text', text: '{"status":"COMPLETE"}' }] }), idle()];
}
test('a step the host retried after an interrupted stream leaves the retried answer alone, without another plugin prompt', async () => {
  const { context, calls } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, ...retriedTurn()] });
  const answer = await requestReview(context, { sessionID, text: input, allowHostContinuations: true });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }], 'Nothing of the interrupted step is joined to the answer.');
  assert.equal(answer.retriedSteps, 1);
  assert.equal(answer.continuation, undefined);
  assert.equal(answer.info.id, 'msg_answer');
  assert.doesNotMatch(JSON.stringify(answer), /PRIVATE_REASONING|COM"/);
  assert.equal(calls.filter(call => call.name === 'prompt').length, 1);
  // Like a host continuation, it needs the caller's consent.
  await assert.rejects(requestReview(context, { sessionID, text: input }), error => {
    assert.match(error.message, /no complete, successful final assistant response/);
    assert.equal(classifyFailure(error), 'transient');
    return true;
  });
});
test('retried steps may have run tools and may repeat; the answer is still the final message alone', async () => {
  const turn = retriedTurn();
  // The interrupted step had called a tool that ran: the host keeps it and resends from there.
  turn[0].content = [{ type: 'text', text: 'Reading the file first.' }, { type: 'tool', id: 'tool_1', state: { status: 'completed' } }, { type: 'text', text: '{"status":"CO' }];
  const second = assistant({ id: 'msg_cut2', finish: 'error', error: turn[0].error, retry: { attempt: 3, at: 5, error: turn[0].error }, content: [{ type: 'text', text: '{"sta' }] });
  const toolStep = assistant({ id: 'msg_tools', finish: 'tool-calls', content: [{ type: 'tool', id: 'tool_2', state: { status: 'completed' } }] });
  const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, toolStep, turn[0], second, turn[1], turn[2]] });
  const answer = await requestReview(context, { sessionID, text: input, allowHostContinuations: true });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }]);
  assert.equal(answer.retriedSteps, 2);
});
test('a retried step cannot excuse a missing retry mark, a failed final answer, foreign input, binding changes or unfinished execution', async () => {
  const mutations = [
    turn => delete turn[0].retry,
    turn => turn[0].retry.attempt = 0,
    turn => turn[0].retry.attempt = 1.5,
    turn => turn[0].finish = 'length',
    turn => delete turn[0].time.completed,
    turn => turn[0].agent = 'build',
    turn => turn[0].model = { ...model, id: 'changed' },
    turn => turn[1].agent = 'build',
    turn => turn[1].finish = 'tool-calls',
    turn => turn[1].finish = 'error',
    turn => turn[1].error = { type: 'provider.transport', message: 'again' },
    turn => Object.assign(turn[1], { finish: 'error', error: { type: 'provider.transport', message: 'again' }, retry: { attempt: 3, at: 6 } }),
    turn => turn[1].content.push({ type: 'tool', id: 'unexpected' }),
    turn => turn[2].outcome = 'interrupted',
    turn => turn[2].outcome = 'failed',
    turn => turn.splice(1, 0, { type: 'user', text: 'foreign input' }),
    turn => turn.splice(1, 0, { type: 'synthetic', text: 'foreign input' }),
    turn => turn.splice(1, 1),
  ];
  for (const mutate of mutations) {
    const turn = retriedTurn(); mutate(turn);
    const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, ...turn] });
    await assert.rejects(requestReview(context, { sessionID, text: input, allowHostContinuations: true }), undefined, mutate.toString());
  }
});
test('a retried step and a host continuation in one turn are each handled by their own rule', async () => {
  // The continued fragment's own retry breaks once more and the host retries that step.
  const [fragment, synthetic] = continuationTurn();
  const cut = assistant({ id: 'msg_cut', finish: 'error', error: { type: 'provider.transport', message: 'lost' }, retry: { attempt: 2, at: 5 }, content: [{ type: 'text', text: 'PLE' }] });
  const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, fragment, synthetic, cut, assistant({ content: [{ type: 'text', text: 'PLETE"}' }] }), idle()] });
  const answer = await requestReview(context, { sessionID, text: input, allowHostContinuations: true });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }]);
  assert.equal(answer.continuation.count, 1);
  assert.equal(answer.retriedSteps, 1);
});

test('a follow-up prompt in the same session only examines its own turn', async () => {
  const repair = 'AZPR runtime: correct your answer';
  const history = [{ id: 'msg_input', type: 'user', text: input }, assistant({ id: 'msg_first' }), idle(),
    { id: 'msg_repair', type: 'user', text: repair }, assistant({ id: 'msg_second', content: [{ type: 'text', text: '{"fixed":true}' }] }), { ...idle(), id: 'msg_idle2' }];
  const { context } = host({ prompt: async () => ({ id: 'msg_repair', sessionID, type: 'user', payload: { text: repair }, delivery: 'steer' }), context: async () => history });
  const answer = await requestReview(context, { sessionID, text: repair });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"fixed":true}' }]);
});

test('only a compaction the host attempted in the failed turn marks it; a refused background summary leaves no trace', async () => {
  const failed = async messages => {
    const { context } = host({ get: async () => ({ id: sessionID, outcome: 'failed' }), context: async () => messages });
    let caught;
    await requestReview(context, { sessionID, text: input }).catch(error => { caught = error; });
    assert.ok(caught?.execution, 'The failed turn is described.');
    return caught;
  };
  const prompt = { id: 'msg_input', type: 'user', text: input };
  const toolTurn = assistant({ id: 'msg_tools', finish: 'tool-calls', content: [{ type: 'tool', id: 'tool_0', state: { status: 'completed' } }] });
  const expired = assistant({ finish: 'error', error: { type: 'provider.auth', status: 401, message: 'expired' } });
  // OpenCode opens the compaction's message before it asks for the summary; AZPR refuses it and the turn ends.
  const full = await failed([prompt, toolTurn, { id: 'cmp_1', type: 'compaction', status: 'failed' }, { ...idle(), outcome: 'failed' }]);
  assert.equal(full.execution.compaction, 'failed');
  assert.equal(classifyFailure(full), 'overflow');
  assert.equal((await failed([prompt, toolTurn, { id: 'cmp_1', type: 'compaction', status: 'new' }, { ...idle(), outcome: 'failed' }])).execution.compaction, 'unknown');
  // A background summary publishes nothing, so the provider failure that ended the turn decides.
  const auth = await failed([prompt, toolTurn, expired, { ...idle(), outcome: 'failed' }]);
  assert.equal(auth.execution.compaction, undefined);
  assert.equal(classifyFailure(auth), 'permanent');
  // A compaction message before this turn's prompt belongs to an earlier turn.
  const earlier = await failed([{ id: 'cmp_0', type: 'compaction', status: 'failed' }, prompt, expired, { ...idle(), outcome: 'failed' }]);
  assert.equal(earlier.execution.compaction, undefined);
  assert.equal(classifyFailure(earlier), 'permanent');
});

test('failure classification drives stage retries and shard splitting', () => {
  const failure = (execution, extra = {}) => Object.assign(new Error('x'), { execution }, extra);
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 429 } })), 'transient');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 429, exhausted: 'provider.quota' } })), 'permanent');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { exhausted: 'provider.free-limit' } })), 'permanent');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 503 } })), 'transient');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 401 } })), 'permanent');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 413 } })), 'overflow');
  // A compaction the host attempted in the failed turn means a full context, whatever ended the turn.
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', compaction: 'failed' })), 'overflow');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', compaction: 'failed', provider: { status: 400 } })), 'overflow');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed' })), 'transient');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'missing-idle' })), 'transient');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'interrupted', interrupted: true })), 'permanent');
  assert.equal(classifyFailure(Object.assign(new Error('x'), { contextChanged: true })), 'transient');
  assert.equal(classifyFailure(new Error('bad request')), 'permanent');
});

test('a model that restarts its answer after a stream interruption keeps only the restarted text', async () => {
  const turn = continuationTurn();
  turn[0].error = { type: 'provider.transport', message: 'socket closed' };
  turn[0].content = [{ type: 'text', text: '{"status":"COMPLETE","report":"first attempt cut off mid-sen' }];
  turn[2].content = [{ type: 'text', text: '{"status":"COMPLETE","report":"complete second attempt"}' }];
  const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, ...turn] });
  const answer = await requestReview(context, { sessionID, text: input, allowHostContinuations: true });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE","report":"complete second attempt"}' }]);
  assert.equal(answer.continuation.restartedAt, 1);
  assert.equal(restartIndex(['{"status":"COM', 'PLETE"}']), 0, 'A real continuation is joined.');
  assert.equal(restartIndex(['{"a"', '{"a" again']), 0, 'Very short openings are not compared.');
});

// OpenCode 2.3.0 and later: after the native read tool read a file of the project, the host leaves the instruction
// files near it in the session as a synthetic message of its own (AGENTS.md; from 2.3.1 also CLAUDE.md).
test('the host\'s own load of instruction files does not end a turn when the caller kept it from the model, and only then', async () => {
  const load = (fields = {}) => ({ id: 'msg_load', type: 'synthetic', text: 'Instructions from: /work/sub/AGENTS.md\nNESTED RULES', description: 'Loaded sub/AGENTS.md',
    metadata: { instruction: { paths: ['/work/sub/AGENTS.md'] } }, ...fields });
  const reading = () => assistant({ id: 'msg_read', finish: 'tool-calls', content: [{ type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed' } }] });
  const turn = message => async () => [{ id: 'msg_input', type: 'user', text: input }, reading(), message, assistant(), idle()];
  // Kept from every model request of the session: the answer is the answer to the admitted prompt.
  const kept = host({ context: turn(load()) });
  const answer = await requestReview(kept.context, { sessionID, text: input, hiddenMessages: new Set(['msg_load']) });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"status":"COMPLETE"}' }]);
  assert.equal(answer.instructionLoads, 1);
  // Not known to be kept from the model: the turn ends as with any other message.
  for (const hiddenMessages of [undefined, new Set(), new Set(['msg_other'])]) {
    const shown = host({ context: turn(load()) });
    await assert.rejects(requestReview(shown.context, { sessionID, text: input, hiddenMessages }), /another message during this turn/);
  }
  // Someone else's messages still end the turn, whatever the caller hid: a synthetic message without the host's
  // list of paths, one with another ID than the hidden one, a user message that only looks like a load.
  for (const foreign of [load({ metadata: undefined }), load({ metadata: { instruction: { paths: [] } } }), load({ metadata: { azpr: { notice: true } } }), load({ id: 'msg_forged' }),
    load({ type: 'user' }), { id: 'msg_load', type: 'synthetic', text: 'A notice of another plugin.' }]) {
    const { context } = host({ context: turn(foreign) });
    await assert.rejects(requestReview(context, { sessionID, text: input, hiddenMessages: new Set(['msg_load']) }), /another message during this turn/, JSON.stringify(foreign).slice(0, 120));
  }
  // One of each in a turn: the foreign one decides.
  const both = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, reading(), load(), { id: 'msg_foreign', type: 'synthetic', text: 'foreign input' }, assistant(), idle()] });
  await assert.rejects(requestReview(both.context, { sessionID, text: input, hiddenMessages: new Set(['msg_load']) }), /another message during this turn/);
  // A load of an earlier turn lies before the admitted prompt and is not looked at.
  const earlier = host({ context: async () => [{ id: 'msg_first', type: 'user', text: 'first prompt' }, reading(), load(), assistant({ id: 'msg_first_answer' }), { id: 'msg_idle_1', type: 'idle', outcome: 'succeeded' },
    { id: 'msg_input', type: 'user', text: input }, assistant(), idle()] });
  assert.equal((await requestReview(earlier.context, { sessionID, text: input })).instructionLoads, undefined);
});

// OpenCode 2.3.0 through 2.4.1, shell allowed: a command the session started goes on in the background (the model
// asked for it, or from 2.3.1 its timeout ran out) and the host tells the session when it has ended.
const shellCall = (shellID = 'sh_1', name = 'shell', reported = { status: 'running', truncated: false, shellID, pid: 1 }) => assistant({ id: `msg_call_${shellID}`, finish: 'tool-calls',
  content: [{ type: 'tool', id: `tool_${shellID}`, name, state: { status: 'completed', input: { command: 'sleep 2', background: true }, metadata: reported, content: [{ type: 'text', text: `Command moved to the background (shell ID: ${shellID}).` }] } }] });
const shellNotice = (shellID = 'sh_1', fields = {}) => ({ id: `msg_notice_${shellID}`, type: 'synthetic', text: `<background-result kind="shell" id="${shellID}" state="completed" command="sleep 2">\n(no output)\n</background-result>`,
  description: 'sleep 2', metadata: { source: 'shell', shellID, jobID: shellID, state: 'completed', truncated: false, exit: 0 }, ...fields });
const said = text => ({ content: [{ type: 'text', text }] });

test('the host\'s notice that a background command of this session ended is no foreign input; the answer after it counts', async () => {
  const { context } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, shellCall(),
    assistant({ id: 'msg_first', ...said('{"answer":"before the notice"}') }), shellNotice(), assistant({ id: 'msg_second', ...said('{"answer":"after the notice"}') }), idle()] });
  const answer = await requestReview(context, { sessionID, text: input });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"answer":"after the notice"}' }]);
  assert.equal(answer.shellNotices, 1);
  // The notice may be the last thing before the turn ends: the answer before it stands.
  const { context: last } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, shellCall(), assistant({ id: 'msg_first', ...said('{"answer":"only"}') }), shellNotice(), idle()] });
  assert.deepEqual((await requestReview(last, { sessionID, text: input })).parts, [{ type: 'text', text: '{"answer":"only"}' }]);
  // However the command ended, the host says so once: cancelled and in error are endings too.
  for (const state of ['cancelled', 'error']) {
    const notice = shellNotice('sh_1', { metadata: { source: 'shell', shellID: 'sh_1', jobID: 'sh_1', state } });
    const { context: ended } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, shellCall(), notice, assistant(), idle()] });
    assert.equal((await requestReview(ended, { sessionID, text: input })).shellNotices, 1, state);
  }
  // A step whose stream broke is retried by the host, and the notice can lie between the two: it is no step, so the
  // retried answer is still the one that directly follows.
  const cut = assistant({ id: 'msg_cut', finish: 'error', error: { type: 'provider.transport', message: 'lost' }, retry: { attempt: 1, at: 3 }, ...said('{"ans') });
  const { context: recovered } = host({ context: async () => [{ id: 'msg_input', type: 'user', text: input }, shellCall(), cut, shellNotice(), assistant({ id: 'msg_retried', ...said('{"answer":"retried"}') }), idle()] });
  const retried = await requestReview(recovered, { sessionID, text: input, allowHostContinuations: true });
  assert.deepEqual([retried.parts, retried.retriedSteps, retried.shellNotices], [[{ type: 'text', text: '{"answer":"retried"}' }], 1, 1]);
});

test('a command that ends after the answer wakes the session by itself; the answer before the turn\'s idle marker stands', async () => {
  const history = [{ id: 'msg_input', type: 'user', text: input }, shellCall(), assistant({ id: 'msg_first', ...said('{"answer":"given"}') }), idle(),
    shellNotice(), assistant({ id: 'msg_woken', ...said('The command has finished.') }), { ...idle(), id: 'msg_idle2' }];
  const { context } = host({ context: async () => history });
  const answer = await requestReview(context, { sessionID, text: input });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"answer":"given"}' }]);
  assert.equal(answer.shellNotices, 1);
  // The host could not run the woken turn (no turn is open any more): the session's outcome is that turn's, not this one's.
  const { context: refused } = host({ context: async () => [...history.slice(0, 5), { ...idle(), id: 'msg_idle2', outcome: 'failed' }],
    get: async () => ({ id: sessionID, outcome: 'failed', agent: 'azpr-review-functional', model }) });
  assert.deepEqual((await requestReview(refused, { sessionID, text: input })).parts, [{ type: 'text', text: '{"answer":"given"}' }]);
  // Also where the session was woken only after its context was read: the marker that was read decides.
  const { context: later } = host({ context: async () => history.slice(0, 4), get: async () => ({ id: sessionID, outcome: 'interrupted', agent: 'azpr-review-functional', model }) });
  assert.deepEqual((await requestReview(later, { sessionID, text: input })).parts, [{ type: 'text', text: '{"answer":"given"}' }]);
  // Something else of the host's between the marker and the notice changes nothing: an update of the instructions.
  const { context: updated } = host({ context: async () => [...history.slice(0, 4), { id: 'msg_update', type: 'system', text: 'The instructions changed.' }, ...history.slice(4)] });
  assert.deepEqual((await requestReview(updated, { sessionID, text: input })).parts, [{ type: 'text', text: '{"answer":"given"}' }]);
  // The turn itself must still have ended well.
  const { context: failed } = host({ context: async () => [history[0], shellCall(), assistant({ id: 'msg_first', ...said('{"answer":"given"}') }), { ...idle(), outcome: 'failed' }, shellNotice()],
    get: async () => ({ id: sessionID, outcome: 'failed', agent: 'azpr-review-functional', model }) });
  await assert.rejects(requestReview(failed, { sessionID, text: input }), /did not finish successfully/);
});

test('a shell notice the session did not start, a second one for a shell, and anything else that arrives, stays foreign input', async () => {
  const prompt = { id: 'msg_input', type: 'user', text: input };
  for (const [name, history] of Object.entries({
    'a shell this session never started': [prompt, shellCall('sh_1'), assistant({ id: 'msg_first' }), shellNotice('sh_other'), assistant({ id: 'msg_second' }), idle()],
    'no shell call at all (a command a person ran)': [prompt, assistant({ id: 'msg_first' }), shellNotice('sh_1'), assistant({ id: 'msg_second' }), idle()],
    'the notice before the call that names its shell': [prompt, shellNotice('sh_1'), shellCall('sh_1'), assistant({ id: 'msg_second' }), idle()],
    'another tool whose result names a shell': [prompt, shellCall('sh_1', 'foreign_tool'), assistant({ id: 'msg_first' }), shellNotice('sh_1'), assistant({ id: 'msg_second' }), idle()],
    'a shell call that ended in the foreground': [prompt, shellCall('sh_1', 'shell', { status: 'completed', truncated: false, exit: 0, shellID: 'sh_1' }), shellNotice('sh_1'), assistant({ id: 'msg_second' }), idle()],
    'a notice without the host\'s source mark': [prompt, shellCall('sh_1'), assistant({ id: 'msg_first' }), { ...shellNotice('sh_1'), metadata: { shellID: 'sh_1', state: 'completed' } }, assistant({ id: 'msg_second' }), idle()],
    'a notice that does not say the command ended': [prompt, shellCall('sh_1'), shellNotice('sh_1', { metadata: { source: 'shell', shellID: 'sh_1', state: 'running' } }), assistant({ id: 'msg_second' }), idle()],
    'a second notice for the shell, in the same turn': [prompt, shellCall('sh_1'), shellNotice('sh_1'), assistant({ id: 'msg_first' }), { ...shellNotice('sh_1'), id: 'msg_again' }, assistant({ id: 'msg_second' }), idle()],
    'a second notice for the shell, in a later turn': [{ id: 'msg_earlier', type: 'user', text: 'the first prompt' }, shellCall('sh_1'), shellNotice('sh_1'), assistant({ id: 'msg_first' }), { ...idle(), id: 'msg_idle1' },
      prompt, { ...shellNotice('sh_1'), id: 'msg_again' }, assistant({ id: 'msg_second' }), idle()],
    'a second notice for the shell, after the turn': [prompt, shellCall('sh_1'), shellNotice('sh_1'), assistant({ id: 'msg_first' }), idle(), { ...shellNotice('sh_1'), id: 'msg_again' }],
    'other input in the turn next to a real notice': [prompt, shellCall('sh_1'), shellNotice('sh_1'), { type: 'synthetic', text: 'foreign input' }, assistant({ id: 'msg_second' }), idle()],
    'other input after a late notice': [prompt, shellCall('sh_1'), assistant({ id: 'msg_first' }), idle(), shellNotice('sh_1'), { type: 'user', text: 'foreign input' }, assistant({ id: 'msg_woken' }), { ...idle(), id: 'msg_idle2' }],
    'other input after the turn without a notice': [prompt, shellCall('sh_1'), assistant({ id: 'msg_first' }), idle(), { type: 'synthetic', text: 'foreign input' }, assistant({ id: 'msg_woken' }), { ...idle(), id: 'msg_idle2' }],
  })) {
    const { context } = host({ context: async () => history });
    await assert.rejects(requestReview(context, { sessionID, text: input }), /another message during this turn/, name);
  }
  // The notice of a command that an earlier turn of the session started is this session's own in a later turn.
  const { context: carried } = host({ context: async () => [{ id: 'msg_earlier', type: 'user', text: 'the first prompt' }, shellCall('sh_1'), assistant({ id: 'msg_first' }), { ...idle(), id: 'msg_idle1' },
    prompt, shellNotice('sh_1'), assistant({ id: 'msg_second', ...said('{"answer":"second turn"}') }), idle()] });
  assert.deepEqual((await requestReview(carried, { sessionID, text: input })).parts, [{ type: 'text', text: '{"answer":"second turn"}' }]);
});
