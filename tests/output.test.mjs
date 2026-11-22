import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelJSON, parseUniqueJSON, evaluateInitial, assignIds,
  escapeCodeSpanQuotes, parseRepairPrompt, syntaxProblem, evaluateDuplicates, duplicateRepairPrompt, reviewRepairPrompt, reviewFollowUpPrompt,
  evaluateRatings, ratingRepairPrompt,
  parseCommentRequest, normalizeFindingId,
} from '../src/output.mjs';

const finding = (id, extra = {}) => ({ id, summary: `Defect ${id}`, evidence: 'HEAD drops the guard.', counterevidence: 'No caller re-checks.',
  location: 'head:/src/a.ts:12', severity: 'high', suggestion: 'Restore the guard.', ...extra });
const initialAnswer = (findings, extra = {}) => JSON.stringify({ status: 'COMPLETE', coverage: { files: ['/src/a.ts'], gaps: [] }, additionalFiles: [], findings, report: 'Report', ...extra });

test('/pr-comment arguments keep their meaning; the review ID is optional everywhere and finding IDs read as the runtime writes them', () => {
  assert.deepEqual(parseCommentRequest(''), { publish: false, show: false });
  assert.deepEqual(parseCommentRequest(undefined), { publish: false, show: false });
  assert.deepEqual(parseCommentRequest('abcd1234'), { reviewId: 'abcd1234', publish: false, show: false });
  assert.deepEqual(parseCommentRequest('--publish'), { publish: true, show: false });
  assert.deepEqual(parseCommentRequest(' abcd1234   --publish '), { reviewId: 'abcd1234', publish: true, show: false });
  assert.deepEqual(parseCommentRequest('--show'), { publish: false, show: true });
  assert.deepEqual(parseCommentRequest('abcd1234 --exclude f1, r-2 --severity F-3=LOW,q1001=medium'),
    { reviewId: 'abcd1234', publish: false, show: false, adjust: { exclude: ['F-1', 'R-2'], severity: { 'F-3': 'low', 'Q-1001': 'medium' } } });
  assert.deepEqual(parseCommentRequest('abcd1234 --exclude=F-1,F-1').adjust, { exclude: ['F-1'] });
  assert.deepEqual(parseCommentRequest('abcd1234 --exclude none --severity NONE').adjust, { exclude: [], severity: {} });
  assert.deepEqual(parseCommentRequest('abcd1234 --reset').adjust, { reset: true });
  for (const text of ['--publish abcd1234', 'abcd1234 --publish --show', 'abcd1234 --publish --publish', 'ABCD1234', 'abcd1234 F-1',
    'abcd1234 --exclude F-1 --publish', 'abcd1234 --show --severity F-1=low', 'abcd1234 --reset --exclude F-1', 'abcd1234 --excludes F-1',
    'abcd1234 --show=yes', 'abcd1234 --exclude F-1 --exclude F-2', '-p']) {
    assert.throws(() => parseCommentRequest(text), /Usage: \/pr-comment/, text);
  }
  // Adjustments need no review ID either: the runtime picks the conversation's current review, as for --publish.
  assert.deepEqual(parseCommentRequest('--exclude F-1,R-2'), { publish: false, show: false, adjust: { exclude: ['F-1', 'R-2'] } });
  assert.deepEqual(parseCommentRequest('--severity f3=low --exclude f1'), { publish: false, show: false, adjust: { exclude: ['F-1'], severity: { 'F-3': 'low' } } });
  assert.deepEqual(parseCommentRequest('--reset'), { publish: false, show: false, adjust: { reset: true } });
  // --list stands alone and names no review.
  assert.deepEqual(parseCommentRequest(' --list '), { list: true });
  for (const text of ['abcd1234 --list', '--list --show', '--list --publish', '--list F-1', '--list=all', '--exclude F-1 --list']) assert.throws(() => parseCommentRequest(text), /Usage: \/pr-comment/, text);
  assert.throws(() => parseCommentRequest('--bogus'), /Without an ID the command acts on this conversation's current review\. \/pr-comment --help has examples\./);
  assert.throws(() => parseCommentRequest('abcd1234 --exclude'), /--exclude needs the finding IDs to exclude, or none/);
  assert.throws(() => parseCommentRequest('abcd1234 --exclude='), /--exclude needs the finding IDs to exclude, or none/);
  assert.throws(() => parseCommentRequest('abcd1234 --exclude F-1 bad!'), /Not a finding ID: bad!/);
  assert.throws(() => parseCommentRequest('abcd1234 --severity'), /--severity needs ID=high/);
  assert.throws(() => parseCommentRequest('abcd1234 --severity F-1=critical'), /Not a severity change: F-1=critical/);
  assert.throws(() => parseCommentRequest('abcd1234 --severity F-1=low f1=high'), /--severity names F-1 twice/);
  // --seen names what the review's comments were when a step was offered. The terminal panel adds it to its
  // commands, with any of the forms above that change or post something, anywhere after the review ID.
  const word = '0f1e2d3c4b5a';
  assert.deepEqual(parseCommentRequest(`abcd1234 --publish --seen ${word}`), { reviewId: 'abcd1234', publish: true, show: false, seen: word });
  assert.deepEqual(parseCommentRequest(`abcd1234 --seen=${word}`), { reviewId: 'abcd1234', publish: false, show: false, seen: word });
  assert.deepEqual(parseCommentRequest(`--seen ${word} --reset`), { publish: false, show: false, seen: word, adjust: { reset: true } });
  assert.deepEqual(parseCommentRequest(`abcd1234 --exclude F-1,R-2 --severity none --seen ${word}`), { reviewId: 'abcd1234', publish: false, show: false, seen: word, adjust: { exclude: ['F-1', 'R-2'], severity: {} } });
  assert.deepEqual(parseCommentRequest(`abcd1234 --seen ${word} --exclude F-1 R-2`).adjust, { exclude: ['F-1', 'R-2'] }, 'A list goes on after it.');
  // One word of that form, once, and not with what neither changes nor posts anything.
  for (const text of ['--seen', '--seen=', `--seen ${word} ${word}`, '--seen 0f1e2d3c4b5', '--seen 0F1E2D3C4B5A', '--seen F-1', `--show --seen ${word}`, `--list --seen ${word}`, '--publish --seen ../../x']) {
    assert.throws(() => parseCommentRequest(text), /--seen takes the one word the terminal panel adds to its commands, and goes with neither --show nor --list; a typed command needs none\./, text);
  }
  assert.throws(() => parseCommentRequest(`--seen ${word} --seen ${word}`), /Usage: \/pr-comment/);
  assert.equal(normalizeFindingId('q1001'), 'Q-1001');
  assert.equal(normalizeFindingId(' v-2 '), 'V-2');
  assert.equal(normalizeFindingId('F--1'), null);
  assert.equal(normalizeFindingId('none'), null);
});

test('parseModelJSON accepts a whole object, one fence or one embedded object and keeps surrounding text', () => {
  assert.deepEqual(parseModelJSON('{"status":"COMPLETE"}', { keys: ['status'] }), { value: { status: 'COMPLETE' } });
  const fenced = parseModelJSON('Intro\n```json\n{"status":"READY","comments":[]}\n```\nOutro', { keys: ['status', 'comments'] });
  assert.deepEqual(fenced.value, { status: 'READY', comments: [] });
  assert.equal(fenced.surroundingText, 'Intro\n\nOutro');
  const embedded = parseModelJSON('Result: {"status":"COMPLETE","findings":[{"note":"a } brace"}]} done', { keys: ['status', 'findings'] });
  assert.equal(embedded.value.findings[0].note, 'a } brace');
  // An unrelated example object does not compete with the review object.
  const example = parseModelJSON('See fn({"item": 3}).\n```json\n{"status":"COMPLETE","findings":[]}\n```', { keys: ['status', 'findings'] });
  assert.deepEqual(example.value, { status: 'COMPLETE', findings: [] });
});

test('parseModelJSON reports concrete problems instead of guessing', () => {
  assert.match(parseModelJSON('').problem, /empty/);
  assert.match(parseModelJSON('no json here').problem, /no JSON object/);
  assert.match(parseModelJSON('{"status": "COMPLETE",}', { keys: ['status'] }).problem, /could not be parsed/);
  assert.match(parseModelJSON('{"status":"A","status":"B"}', { keys: ['status'] }).problem, /repeats a key/);
  assert.match(parseModelJSON('```json\n{"status":"A"}\n```\n```json\n{"status":"B"}\n```', { keys: ['status'] }).problem, /2 JSON objects/);
  assert.match(parseModelJSON('[1,2]', { keys: ['status'] }).problem, /not the expected object/);
});

test('settings parsing stays strict', () => {
  assert.deepEqual(parseUniqueJSON('{"a":1}'), { a: 1 });
  assert.throws(() => parseUniqueJSON('{"a":1,"a":2}'), /duplicate JSON keys/);
  assert.throws(() => parseUniqueJSON('```json\n{}\n```'));
});

test('evaluateInitial accepts a good review and normalizes aliases and severity case', () => {
  const answer = JSON.stringify({ Status: 'complete', coverage: { files: ['/src/a.ts'], gaps: [] }, findings: [finding('F-1', { severity: 'High' })], report: 'r' });
  const { result, issues } = evaluateInitial(answer, { prefix: 'F', assigned: ['/src/a.ts'], inventory: ['/src/a.ts'] });
  assert.deepEqual(issues, []);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.findings[0].severity, 'high');
});

test('evaluateInitial lists repairable problems and still returns a usable PARTIAL result', () => {
  const bad = JSON.stringify({ status: 'COMPLETE', findings: [{ id: 'F-1', summary: 'only summary', severity: 'critical' }], report: 'r' });
  const { result, issues } = evaluateInitial(bad, { prefix: 'F', assigned: ['/src/a.ts'] });
  assert.ok(issues.some(issue => /coverage/.test(issue)));
  // Every field of a finding is needed, the location included: nothing after the reviewer supplies one.
  assert.ok(issues.some(issue => /^findings\[0\] \(F-1\): missing evidence, counterevidence, location, suggestion; severity must be high, medium or low\.$/.test(issue)));
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.invalid, { 'F-1': ['missing evidence, counterevidence, location, suggestion', 'severity must be high, medium or low'] });
  assert.match(reviewRepairPrompt(issues), /complete corrected JSON object/);
});

test('evaluateInitial keeps unstructured text as the report: it is no review, and nothing in it is a finding', () => {
  const { result, issues } = evaluateInitial('I found a race in /src/a.ts when two writers overlap.', { prefix: 'F', assigned: ['/src/a.ts'] });
  assert.equal(result.structured, false);
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.coverage, { files: [], gaps: ['The reviewer answer was not structured JSON.'] });
  assert.match(result.report, /race/);
  assert.deepEqual(result.warnings, ['The reviewer answer was not structured; its text is kept as it is.']);
  assert.match(issues[0], /could not be used/);
});

test('evaluateInitial downgrades COMPLETE when assigned files are missing and records discovered paths', () => {
  const { result } = evaluateInitial(initialAnswer([], { coverage: { files: [], gaps: [] }, additionalFiles: ['src/extra.ts', '/src/a.ts'] }),
    { prefix: 'F', assigned: ['/src/a.ts'], inventory: ['/src/a.ts'], filesComplete: false });
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual(result.additionalFiles, ['/src/extra.ts']);
});

test('assignIds keeps valid IDs and renumbers missing or repeated ones', () => {
  const warnings = new Set();
  const rows = [{ id: 'F-1' }, { id: 'F-1' }, {}, { id: 'X-9' }];
  assignIds(rows, 'F', warnings);
  assert.deepEqual(rows.map(row => row.id), ['F-1', 'F-2', 'F-3', 'F-4']);
  assert.equal(rows[3].originalId, 'X-9');
  assert.equal(warnings.size, 1);
});

test('evaluateDuplicates only merges within the checked file and never loses a finding', () => {
  const ids = ['F-1', 'F-2', 'F-3', 'F-4'];
  const clean = evaluateDuplicates(JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-2', mergedInto: 'F-1', reason: 'Same cause and fix.' }], report: 'r' }), { ids });
  assert.deepEqual(clean.issues, []);
  assert.deepEqual(clean.result.merges, [{ id: 'F-2', mergedInto: 'F-1', reason: 'Same cause and fix.' }]);
  assert.deepEqual([clean.result.refused, clean.result.warnings, clean.result.report, clean.result.structured], [0, [], 'r', true]);
  assert.deepEqual(evaluateDuplicates('{"status":"COMPLETE","merged":[],"report":""}', { ids }).result.merges, []);
  // A chain ends at the finding that stays; invalid rows are reported and left out.
  const chained = evaluateDuplicates(JSON.stringify({ status: 'COMPLETE', merged: [
    { id: 'F-3', mergedInto: 'F-2', reason: 'a' }, { id: 'F-2', mergedInto: 'F-1', reason: 'b' },
    { id: 'X-9', mergedInto: 'F-1', reason: 'c' }, { id: 'F-4', mergedInto: 'F-4', reason: 'd' }, { id: 'F-1', mergedInto: 'F-2' }, { id: 'F-3', mergedInto: 'F-1', reason: 'e' }], report: '' }), { ids });
  assert.deepEqual(chained.result.merges.map(m => `${m.id}>${m.mergedInto}`), ['F-3>F-1', 'F-2>F-1']);
  assert.ok(chained.issues.some(issue => /merged\[2\]: id "X-9" is not an assigned finding/.test(issue)));
  assert.ok(chained.issues.some(issue => /merged\[3\]: mergedInto must name another assigned finding/.test(issue)));
  assert.ok(chained.issues.some(issue => /merged\[4\]: give a concrete reason/.test(issue)));
  assert.ok(chained.issues.some(issue => /merged\[5\]: F-3 is merged more than once/.test(issue)));
  assert.equal(chained.issues.length, 4);
  assert.deepEqual(chained.result.warnings, ['Some duplicate-check merges were invalid and were not applied; those findings stay reported.']);
  assert.match(duplicateRepairPrompt(chained.issues), /only when both state the same root cause and need the same correction; two findings of one session stay separate\.$/);
  assert.equal(duplicateRepairPrompt(chained.issues, { parseOnly: true }), parseRepairPrompt(chained.issues));
  // A cycle names no survivor: nothing in it is merged, and a merge outside it still is.
  const cycle = evaluateDuplicates(JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-1', mergedInto: 'F-2', reason: 'a' }, { id: 'F-2', mergedInto: 'F-1', reason: 'b' },
    { id: 'F-4', mergedInto: 'F-3', reason: 'c' }], report: '' }), { ids });
  assert.deepEqual(cycle.result.merges.map(m => `${m.id}>${m.mergedInto}`), ['F-4>F-3']);
  assert.equal(cycle.issues.filter(issue => /form a cycle/.test(issue)).length, 2);
  // A merge that leads into a cycle has no finding that stays either: it is left out with the cycle, and all three stay reported.
  const intoCycle = evaluateDuplicates(JSON.stringify({ status: 'COMPLETE', merged: [{ id: 'F-1', mergedInto: 'F-2', reason: 'a' }, { id: 'F-2', mergedInto: 'F-1', reason: 'b' },
    { id: 'F-3', mergedInto: 'F-1', reason: 'c' }], report: '' }), { ids });
  assert.deepEqual(intoCycle.result.merges, []);
  assert.deepEqual(intoCycle.issues.map(issue => issue.slice(0, 4)), ['F-1:', 'F-2:', 'F-3:']);
  // No usable JSON: a correction turn, and no merge on its own.
  const prose = evaluateDuplicates('F-2 repeats F-1.', { ids });
  assert.equal(prose.result.structured, false);
  assert.deepEqual(prose.result.merges, []);
  assert.match(prose.issues[0], /could not be used/);
  assert.deepEqual(prose.result.warnings, ['The duplicate check gave no usable answer; no finding was merged.']);
  assert.ok(evaluateDuplicates('{"status":"COMPLETE","merged":"none","report":""}', { ids }).issues.some(issue => /"merged" must be an array/.test(issue)));
});

test('evaluateDuplicates never puts two findings of one reviewer session into one finding, directly or through a third', () => {
  const ids = ['F-1', 'F-2', 'F-3', 'F-4'];
  const merged = (rows, sessions) => evaluateDuplicates(JSON.stringify({ status: 'COMPLETE', merged: rows.map(([id, mergedInto]) => ({ id, mergedInto, reason: 'Same cause and fix.' })), report: '' }), { ids, sessions });
  const pairs = result => result.merges.map(m => `${m.id}>${m.mergedInto}`);
  // F-1 and F-3 come from one session, which filed them as two findings.
  const sessions = { 'F-1': ['pass 1'], 'F-2': ['pass 2'], 'F-3': ['pass 1'], 'F-4': ['pass 3'] };
  const across = merged([['F-2', 'F-1'], ['F-4', 'F-1']], sessions);
  assert.deepEqual([pairs(across.result), across.issues, across.result.refused], [['F-2>F-1', 'F-4>F-1'], [], 0], 'Findings of different sessions merge as before.');
  const direct = merged([['F-3', 'F-1'], ['F-2', 'F-1']], sessions);
  assert.deepEqual(pairs(direct.result), ['F-2>F-1'], 'The refused merge is left out; the others are applied.');
  assert.deepEqual(direct.issues, ['F-3 into F-1: F-3 and F-1 were both reported by the session "pass 1", which filed them as separate findings, so they cannot end up in one finding. Merge only the one that repeats the other session\'s finding, if any, and leave the other separate.']);
  assert.equal(direct.result.refused, 1);
  assert.deepEqual(direct.result.warnings, ['Some duplicate-check merges were invalid and were not applied (1 would have joined two findings of one reviewer session); those findings stay reported.']);
  // Through a third finding: F-1 joins F-2, then F-3 may not join them. The answer's order decides which merge stands.
  const through = merged([['F-1', 'F-2'], ['F-3', 'F-2']], sessions);
  assert.deepEqual(pairs(through.result), ['F-1>F-2']);
  assert.match(through.issues[0], /^F-3 into F-2: F-3 and F-1 were both reported by the session "pass 1"/);
  const other = merged([['F-3', 'F-2'], ['F-1', 'F-2']], sessions);
  assert.deepEqual(pairs(other.result), ['F-3>F-2']);
  assert.match(other.issues[0], /^F-1 into F-2: F-1 and F-3 were both reported by the session "pass 1"/);
  // A chain whose later link is refused keeps its earlier link, with the target it had.
  const chain = merged([['F-4', 'F-3'], ['F-3', 'F-1']], sessions);
  assert.deepEqual([pairs(chain.result), chain.result.refused], [['F-4>F-3'], 1]);
  // A chain that is applied in full ends at the finding that stays, whichever order its links come in.
  const free = { 'F-1': ['pass 1'], 'F-2': ['pass 2'], 'F-3': ['pass 3'], 'F-4': ['pass 4'] };
  assert.deepEqual(pairs(merged([['F-3', 'F-2'], ['F-2', 'F-1'], ['F-4', 'F-3']], free).result), ['F-3>F-1', 'F-2>F-1', 'F-4>F-1']);
  assert.deepEqual(pairs(merged([['F-2', 'F-1'], ['F-3', 'F-2'], ['F-4', 'F-3']], free).result), ['F-2>F-1', 'F-3>F-1', 'F-4>F-1']);
  // A finding that stands for identical findings of two sessions counts for both.
  const stands = merged([['F-2', 'F-1'], ['F-3', 'F-1']], { 'F-1': ['pass 1', 'pass 2'], 'F-2': ['pass 2'], 'F-3': ['pass 3'] });
  assert.deepEqual([pairs(stands.result), stands.result.refused], [['F-3>F-1'], 1]);
  assert.match(stands.issues[0], /^F-2 into F-1: F-2 and F-1 were both reported by the session "pass 2"/);
  // The sessions of a group are those of all its members: after F-3 joined F-1, a finding of pass 3 may not join.
  const grown = merged([['F-3', 'F-1'], ['F-4', 'F-1']], { 'F-1': ['pass 1'], 'F-3': ['pass 3'], 'F-4': ['pass 3'] });
  assert.deepEqual(pairs(grown.result), ['F-3>F-1']);
  assert.match(grown.issues[0], /^F-4 into F-1: F-4 and F-3 were both reported by the session "pass 3"/);
  // Without session names nothing is refused: the rule needs to know who reported what.
  assert.deepEqual(pairs(merged([['F-3', 'F-1'], ['F-2', 'F-1']]).result), ['F-3>F-1', 'F-2>F-1']);
});

test('evaluateRatings only sets levels: a finding without a usable rating keeps its reviewer\'s severity', () => {
  const ids = ['F-1', 'F-2', 'F-3'];
  const clean = evaluateRatings(JSON.stringify({ status: 'COMPLETE', report: 'r', ratings: [
    { id: 'F-1', severity: 'HIGH', reason: 'Data people keep is lost in ordinary use.' }, { id: 'F-2', severity: 'low', reason: 'A rare trigger, and the failure is recoverable.' },
    { id: 'F-3', severity: 'medium', reason: 'A call that BASE handled now fails.' }] }), { ids });
  assert.deepEqual(clean.issues, []);
  assert.equal(clean.result.structured, true);
  assert.deepEqual(clean.result.ratings.map(row => `${row.id}:${row.severity}`), ['F-1:high', 'F-2:low', 'F-3:medium']);
  assert.deepEqual(clean.result.warnings, []);
  // Invalid rows are reported and left out, and every finding without a usable rating is named.
  const partial = evaluateRatings(JSON.stringify({ status: 'COMPLETE', report: '', ratings: [
    { id: 'F-1', severity: 'critical', reason: 'a' }, { id: 'X-9', severity: 'low', reason: 'b' }, { id: 'F-2', severity: 'low', reason: 'c' }, { id: 'F-2', severity: 'high', reason: 'd' }] }), { ids });
  assert.deepEqual(partial.result.ratings.map(row => `${row.id}:${row.severity}`), ['F-2:low']);
  assert.ok(partial.issues.some(issue => /ratings\[0\]: severity must be high, medium or low/.test(issue)));
  assert.ok(partial.issues.some(issue => /ratings\[1\]: id "X-9" is not an assigned finding/.test(issue)));
  assert.ok(partial.issues.some(issue => /ratings\[3\]: F-2 is rated more than once/.test(issue)));
  assert.ok(partial.issues.some(issue => /No usable rating for F-1, F-3\./.test(issue)));
  assert.deepEqual(partial.result.warnings, ['2 finding(s) got no usable rating and keep their reviewer\'s severity.']);
  assert.match(ratingRepairPrompt(partial.issues), /exactly one rating \(high, medium or low\) for every ID in assignment\.findingIds/);
  assert.ok(evaluateRatings('{"status":"COMPLETE","ratings":"none","report":""}', { ids }).issues.some(issue => /"ratings" must be an array/.test(issue)));
  // No usable JSON: a correction turn, and no level changes on its own.
  const prose = evaluateRatings('F-1 is high; the others are low.', { ids });
  assert.equal(prose.result.structured, false);
  assert.deepEqual(prose.result.ratings, []);
  assert.match(prose.issues[0], /could not be used/);
  assert.deepEqual(prose.result.warnings, ['The severity rating gave no usable answer; the reviewers\' severities are kept.']);
  assert.equal(ratingRepairPrompt(prose.issues, { parseOnly: true }), parseRepairPrompt(prose.issues));
});

test('unescaped quotes inside inline code are repaired locally and disclosed', () => {
  const broken = '{"status":"COMPLETE","findings":[],"coverage":{"files":["/a.ts"],"gaps":[]},"report":"HEAD returns `{"stock": s}.copy()` and `x`."}';
  assert.throws(() => JSON.parse(broken));
  const parsed = parseModelJSON(broken, { keys: ['status'] });
  assert.equal(parsed.value.report, 'HEAD returns `{"stock": s}.copy()` and `x`.');
  assert.deepEqual(parsed.corrections, [{ action: 'escape-quotes-in-code-span', count: 2 }]);
  const { result, issues } = evaluateInitial(broken, { prefix: 'F', assigned: ['/a.ts'], inventory: ['/a.ts'] });
  assert.deepEqual(issues, []);
  assert.ok(result.warnings.some(w => /repaired locally/.test(w)));
  // A backtick span that crosses JSON members is never touched.
  assert.equal(escapeCodeSpanQuotes('{"a":"x `y", "b": "z` w"}'), null);
  assert.equal(escapeCodeSpanQuotes('{"a":"plain"}'), null);
});

test('repair prompts: syntax errors ask for the same content; other problems ask for the corrected object', () => {
  assert.equal(syntaxProblem(['Your answer could not be used: no JSON object was found.']), false);
  // An answer whose JSON does not parse is asked for again as it was; nothing of it is taken meanwhile.
  const broken = evaluateInitial('{"status":"COMPLETE","findings":[{"id":"F-1" "summary": "x"}]}', { prefix: 'F', assigned: ['/src/a.ts'] });
  assert.equal(broken.result.structured, false);
  assert.ok(syntaxProblem(broken.issues));
  assert.match(parseRepairPrompt(broken.issues), /identical content: do not shorten/);
  assert.equal(reviewRepairPrompt(broken.issues, { parseOnly: true }), parseRepairPrompt(broken.issues));
  assert.match(reviewRepairPrompt(['x could not be parsed'], { parseOnly: true }), /not valid JSON[\s\S]*identical content/);
  assert.match(reviewRepairPrompt(['coverage missing']), /^AZPR runtime: your previous answer needs correction before it can be used\.\n- coverage missing\n\nReturn the complete corrected JSON object/);
  assert.match(reviewRepairPrompt(['F-1: x']), /read the file with azpr_read_diff or azpr_read_file and correct the location/);
  assert.match(reviewRepairPrompt(['F-1: x']), /keep the existing wording of fields that need no correction\.$/);
  // The one follow-up turn of a reviewer that named unfinished work.
  const followUp = reviewFollowUpPrompt({ gaps: ['The retry path was not traced.'], uncovered: ['/src/b.ts'] });
  assert.match(followUp, /^AZPR runtime: your answer is PARTIAL and names work that is not finished\.\n- The retry path was not traced\.\n- Assigned files not listed as reviewed: \/src\/b\.ts\n/);
  assert.match(followUp, /Keep a gap only for a limit you cannot close[\s\S]*status COMPLETE only when every assigned file is reviewed and no gap remains\.$/);
  assert.match(reviewFollowUpPrompt({ uncovered: Array.from({ length: 23 }, (_, index) => `/src/f${index}.ts`) }), /\/src\/f19\.ts, and 3 more\n/);
});

test('evaluateInitial requires a location for every finding and tells item problems from the answer envelope', () => {
  const { result, issues } = evaluateInitial(initialAnswer([finding('F-1'), finding('F-2', { location: '' })]), { prefix: 'F', assigned: ['/src/a.ts'] });
  assert.deepEqual(result.invalid, { 'F-2': ['missing location'] });
  assert.match(issues.join('\n'), /findings\[1\] \(F-2\): missing location/);
  assert.deepEqual(result.envelope, { findings: true, coverage: true });
  assert.deepEqual(result.findings.map(row => row.id), ['F-1', 'F-2'], 'The finding stays in the answer: what becomes of it is the review\'s decision.');
  // Parsed JSON is not a usable review by itself.
  const odd = evaluateInitial(JSON.stringify({ status: 'COMPLETE', findings: { summary: 'x' }, coverage: 'all', report: 'r' }), { prefix: 'F' });
  assert.equal(odd.result.structured, true);
  assert.deepEqual(odd.result.envelope, { findings: false, coverage: false });
  assert.deepEqual(evaluateInitial('no json here', { prefix: 'F' }).result.envelope, { findings: false, coverage: false });
});
