import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewSession, createRuntimeSession, requestReview as sendReview, interruptSession, appendReport, classifyFailure } from '../src/session.mjs';

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
  assert.deepEqual(calls, [{ name: 'create', args: [{ parentID: 'ses_origin', title: 'review', agent: 'azpr-review-functional', model, permissions }] }]);
});

test('V2 creation rejects changed or reused session identity before prompting', async () => {
  for (const altered of [{ id: 'ses_origin' }, { parentID: 'ses_other' }, { agent: 'build' }, { model: { ...model, id: 'other' } }]) {
    const { context, calls } = host({ create: async value => ({ ...value, id: sessionID, ...altered }) });
    await assert.rejects(createReviewSession(context, { origin: 'ses_origin', title: 'review', role: 'azpr-review-functional', model }), /independent reviewer/);
    assert.equal(calls.length, 1);
  }
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
  for (const outcome of ['failed', 'interrupted']) {
    const { context } = host({ get: async () => ({ id: sessionID, outcome }) });
    await assert.rejects(requestReview(context, { sessionID, text: input }), /did not finish successfully/);
  }
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

test('V2 report delivery queues the exact report without starting a model call', async () => {
  const { context, calls } = host();
  assert.deepEqual(await appendReport(context, { sessionID: 'ses_origin', text: 'Final report' }), { queued: true, id: 'msg_report' });
  assert.deepEqual(calls, [{ name: 'synthetic', args: [{ sessionID: 'ses_origin', text: 'Final report', description: 'Final report', delivery: 'queue', resume: false }] }]);
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

test('a follow-up prompt in the same session only examines its own turn', async () => {
  const repair = 'AZPR runtime: correct your answer';
  const history = [{ id: 'msg_input', type: 'user', text: input }, assistant({ id: 'msg_first' }), idle(),
    { id: 'msg_repair', type: 'user', text: repair }, assistant({ id: 'msg_second', content: [{ type: 'text', text: '{"fixed":true}' }] }), { ...idle(), id: 'msg_idle2' }];
  const { context } = host({ prompt: async () => ({ id: 'msg_repair', sessionID, type: 'user', payload: { text: repair }, delivery: 'steer' }), context: async () => history });
  const answer = await requestReview(context, { sessionID, text: repair });
  assert.deepEqual(answer.parts, [{ type: 'text', text: '{"fixed":true}' }]);
});

test('failure classification drives stage retries and shard splitting', () => {
  const failure = (execution, extra = {}) => Object.assign(new Error('x'), { execution }, extra);
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 429 } })), 'transient');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 503 } })), 'transient');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 401 } })), 'permanent');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed', provider: { status: 413 } })), 'overflow');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'failed' }), { compactionRequested: true }), 'overflow');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'missing-idle' })), 'transient');
  assert.equal(classifyFailure(failure({ terminalOutcome: 'interrupted', interrupted: true })), 'permanent');
  assert.equal(classifyFailure(Object.assign(new Error('x'), { contextChanged: true })), 'transient');
  assert.equal(classifyFailure(new Error('bad request')), 'permanent');
});

test('runtime sessions are model-less children bound to the runtime agent', async () => {
  const { context, calls } = host({ create: async value => ({ id: 'ses_runtime', ...value }) });
  const made = await createRuntimeSession(context, { origin: 'ses_origin', title: 'runtime', agent: 'azpr-runtime' });
  assert.equal(made.id, 'ses_runtime');
  assert.deepEqual(calls[0].args[0], { parentID: 'ses_origin', title: 'runtime', agent: 'azpr-runtime' });
  const wrong = host({ create: async value => ({ id: 'ses_runtime', ...value, agent: 'build' }) });
  await assert.rejects(createRuntimeSession(wrong.context, { origin: 'ses_origin', title: 'runtime', agent: 'azpr-runtime' }), /runtime session/);
});
