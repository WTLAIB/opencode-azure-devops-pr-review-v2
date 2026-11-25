# Validation

This page records validation of the Azure DevOps REST implementation, the
0.1.0 through 0.3.4 distributions, the release candidates from 0.3.5 to
0.5.1, the moves to OpenCode 2.3.0, 2.3.2 and 2.4.1, runs of Martian's public code
review benchmark, the instruction
changes of 0.3.6 measured on it and on ReviewBench, the severity changes
of 0.3.7 run on ReviewBench's test set, the runs behind the single
pipeline of 0.5.0, 0.5.0 against 0.4.6 scored by ReviewBench's own
judge, and 0.5.0 on Martian's benchmark. Host
integration, provider
admission, source fidelity, model quality and publication are separate claims; a
passing fixture establishes only the first. Earlier revisions and their live
acceptance runs, including the MCP-based runs, are preserved in
[validation history](VALIDATION_HISTORY.md).

## Summary

- **Every change, in CI.** `npm run check` and the offline test suite, then
  thirteen runs on the real OpenCode 2.4.1 host with isolated profiles and
  fake model and Azure DevOps services: fresh, replacement and native
  installation (including an authenticating proxy, a custom CA certificate, a
  foreign MCP server behind CodeMode and an image model), a 120-file review
  in shards and two passes with a context-overflow split and idempotent
  publication, a refused background summary and a pass that fails while the
  other completes, the last two once more with debug off, where a run deletes
  its sessions when it ends, and, in the real terminal UI, the review panel, a
  setup from a profile without settings and the confirmed update of settings
  of 0.4.x, each installed from source and as OpenCode's plugin manager
  installs the package.
- **Live, with real models on Azure DevOps Services.** Reviews, comment
  previews and publication on three test PRs with 1, 35 and 316 changed
  files. On OpenCode 2.1.4 with gpt-6-luna, all six quick and review runs
  completed without a retry or a failed stage; both modes found all 24 seeded
  policy defects of the 316-file PR and the 3 known defects of the 1-file PR.
  Live automatic publication on the 35-file PR (OpenCode 2.1.2) posted and
  read back its comments, and a second run on the unchanged PR wrote nothing.
  On OpenCode 2.3.0 with AZPR 0.4.1, a gpt-6-luna review and its preview
  completed on the 1-file and the 35-file PR, and with the 0.4.2 candidate
  one more on the 35-file PR, with the terminal panel open. With AZPR 0.4.3,
  a first setup in the dialogs against the live organization, and a
  gpt-6-luna review and preview of the 1-file PR whose ten notices reached
  the conversation's own model together with one prompt, in one request.
  With AZPR 0.4.4, a gpt-6-luna review of the 1-file PR in the terminal UI,
  whose preview was adjusted (one finding lowered to low) and then posted: a
  summary and two inline comments, read back. With the 0.4.5 candidate, a
  gpt-6-luna review of the 35-file PR stopped from the terminal panel, and a
  second one to its preview. With the 0.4.6 candidate, 62 reviews of public
  pull requests with three models, each followed by its comment preview,
  against a local stand-in for Azure DevOps. With the 0.5.0 candidate, 24
  reviews of ReviewBench's test set with two passes of GPT-6.1 Terra, against
  the same kind of stand-in, after the
  [development runs](#one-pipeline-passes-instead-of-roles-2026-11-22-and-23)
  that the single pipeline rests on; with the release's review stages, the
  same 24 pull requests with one to four passes of GPT-6.2 Sol, all 96
  reviews COMPLETE.
- **Every release.** Following the [releasing guide](RELEASING.md), the
  candidate is installed from a clean source archive and from its public Git
  commit before it is tagged, and the published npm package is installed from
  the registry; its integrity must match the package built from the tag.
- **A public benchmark.** On the 50 real pull requests of Martian's
  [Code Review Bench](#martian-code-review-bench-2026-11-05-and-06),
  `/pr-deep` with Claude Opus 5.5 found 67.7% of the issues a reviewer should
  catch and 74.2% of the High and Critical ones, scored with the benchmark's
  own pipeline and judge. That recall is higher than any of the 21 tools on
  the benchmark's dashboard; on its overall F2 score AZPR would place sixth.
  The 0.4.6 candidate, [measured the same way](#martians-code-review-bench-measured-again)
  on 2026-11-21, found 67.1% and 75.8%, again the highest recall, with an F2
  that would place eighth: one run each, and within one run's sampling error
  of 0.3.5. Both reviewed with two reviewers and a verifier. 0.5.0, with
  [its default two passes of the same model](#050-on-martians-code-review-bench-with-claude-opus-55-2026-11-25),
  found 73.4% and 80.3%, again the highest recall and High and Critical
  recall, with an F2 that would place sixth, at 83% of 0.4.6's model cost; a
  second run, with three passes, found 69.6% and 78.8% at 121%. One run each:
  no difference from 0.4.6 or 0.3.5 is larger than runs of one setup differ.
  On 24 pull requests of ReviewBench's test set,
  [scored by ReviewBench's own judge](#050-against-046-on-reviewbench-with-its-own-judge-2026-11-24)
  against 0.4.6 with GPT-6.2 Sol, 0.5.0's two passes found about as many
  reference issues (49.1% against 51.5%) at 58% of the cost, with 89.7% of
  their findings judged valid against 93.2%; three passes matched 0.4.6, and
  four, at about its cost, found 54.8%, a gain of about one run's variation.

The test-PR runs show that the workflow works and what it found on those PRs;
the benchmark measures how much of a published reference set it finds.
Findings still vary between models and runs; see
[known limitations](#known-limitations).

## 0.5.1 release candidate acceptance (2026-11-26)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.4.1 and tmux 3.2a, with isolated OpenCode profiles and the fake model and
Azure DevOps services. No review with a real model ran on this candidate.

0.5.1 moves the tested host to OpenCode 2.4.1 and changes what the
[comparison of the hosts](#opencode-231-to-241-compared-with-230-2026-11-24-to-26)
found. `host.mjs` has the tested version, the workspace limit among the
used-up limits, the length of a line the host's read returns, and what tells
the host's parts and messages apart (`withoutPlaceInstructions`,
`claudeInstructions`, `isInstructionLoad`, `isRequestedLoad`,
`isInstructionUpdate`). `runtime.mjs` keeps the place's instructions and the
host's own messages out of private requests in its `context` hook, opens a
grant for a turn and closes it with the host's idle hook, takes AZPR's tools
out of the requests built outside a turn, refuses one of AZPR's commands that
arrives as a prompt, and puts the report into the last stage of the pipeline
that did not fail. `session.mjs` ends a turn at the first idle marker after
its prompt and lets its check pass a load that no request showed, an update
of the instructions, and the notice of the session's own background command.
`comment-data.mjs` writes rows that fit (`pageRows`) and hands out a stored
value only when its pages give it whole through the host's read
(`wholePages`), `attribution.mjs` orders the stages (`stagesInOrder`), and
`tui-view.jsx` tells a made-up release from a click (`hold`). No prompt
changed (the hash test holds them), no setting is new, and the package has
the files of 0.5.0.

### Offline

`npm run check` passes, and `npm test` runs 808 tests (783 for 0.5.0), all
passing. The new ones:

| Tests | What they establish |
| ---: | --- |
| 4 | The host's forms (`tests/compatibility.test.mjs`): the instructions part is rebuilt from the date and the environment, without changing the parts that were handed over, and comes back as it was when nothing can be left out; no such part, two of them, a text that is not its sources joined or sources of another form are not told apart. What the Claude Code provider keeps for a request is its sources but those two, joined. A load of instruction files is told by the paths it names and an ID, in the form of the place it is in: the synthetic message of a session, the user message of a request, and neither for the other; a message without an ID, a person's message, a tool result or an assistant message that carries such paths is none. An update is a system message whose content is one text part, without an ID or metadata; a change of effort or of tools, two texts, a plain string, or a system message that another hook marked is none. |
| 9 | The hooks (`tests/runtime.test.mjs`). A private request keeps only the date and the environment, loses the loaded instruction file and the update and keeps a change of effort; an option of the Claude provider's name on another provider's request changes nothing of that; an ordinary session's request is untouched. For the Claude Code provider the sources are left out, and its option emptied, only where the option holds exactly what they give: written another way, with a source more or less, missing, not a text, or holding something where nothing is to leave out, the parts and the option stay and the stage record counts the request. A load ends no turn only on proof that no request showed it: one that no request offered to the hook, one whose ID a request showed (before or after a request that knew it, which takes it out all the same), one that was hidden in the first turn and shown in the correction turn, and one in a session where a request showed a user message without an ID all fail the turn; a message that only looks like a load is someone else's; AZPR's own prompt is never taken for a load. A private session gets a request and a tool only while a turn is open: between two turns the hook refuses a request, the tool hook a call and AZPR's own tool its execution, and nothing is read. At the end of a turn (the fixture's host runs the idle hook and leaves its marker as OpenCode does): a session that rests gets no prepared request and no tool; asked again before the marker, the turn goes on and what it reads counts; asked again after the marker, with the wait for the session still pending, it gets no request, no retry and no tool, and nothing is read. A prompt that the host admits after the call that sent it has ended (the inactivity watchdog stopped the stage while the host was slow, before the prompt hook or inside it) is refused and no model is asked. One of AZPR's commands sent as a prompt is refused with a notice, for each of its eight commands; a question about a command, a longer name, an unknown name, an indented example and a command after a blank line or a tab are not. A hook that cannot be registered fails the load, also one for the requests built outside a turn. The receipt lists the passes in their order and the report goes to the last of them. |
| 7 | The turn (`tests/session.test.mjs`): a turn ends at the first idle marker after its prompt, whatever came before it: a marker right after the prompt is the end of the prompt's own execution (interrupted, failed, or with nothing answered), what another execution wrote afterwards is not the answer, and the turn keeps the outcome its own marker says. A load of instruction files ends no turn where the caller says that no request showed it, and fails it otherwise, also a load of an earlier turn and one after the turn's marker; a message of another form and a second, foreign message end the turn. An update of the instructions is no step of the turn between two steps, between a step that broke and its retry, and after the answer, and excuses nothing else. The caller is told that the session is idle before its context is read. The notice of the session's own background command is no foreign input, whether the command completed, was cancelled or ended in error, also between a step that broke and its retry; a notice after the turn's marker leaves the answer before it, whatever the woken turn's outcome and whatever else of the host's lies between. A notice for a shell the session did not start, one before its call, one of another tool's or of a call that ended in the foreground, one without the host's marks, one that does not say the command ended, and a second one for a shell (in the turn, in a later turn, after the turn) are foreign; the notice of a command that an earlier turn started is the session's own. And the workspace limit is named and not retried. |
| 3 | Rows and stored values (`tests/comment-work.test.mjs`): for prose, code, one long line, quotes and backslashes, control characters and surrogate pairs, every row is at most 1,900 characters as written, the rows are the value, each continues the one before and none splits a pair; a row ends at a line break in its second half. What tells that a pages file gives its value whole says so of every file this version writes and of none that lacks a row or its line end, repeats or reorders rows, holds another text or a row longer than the host returns (2,000 characters pass, 2,001 do not). A store that is opened again writes the pages of a sound object again where they are rows of 0.5.0, a row of 2,001 characters, missing, empty, cut in a row, cut after a row, another text, or something else, each time it is opened, and leaves a row of exactly 2,000 characters as it is; it holds no mark. A value that another writer has written since the store was opened (an earlier version with its rows, a writer cut off in the object or in the pages, an object that is something else) is made right when it is put. An object that is not what its name says gives no pages and is not handed out; putting its value writes it again; with pages that the host's read would cut, and where the pages of a sound object cannot be written, the store is not opened, leaves no working file, and is opened once the obstacle is gone. |
| 2 | The order of stages (`tests/attribution.test.mjs`): three orders of creation give one list, for a review and for a comment run; the sessions of one label, among them a page's continuation after a retry, keep the order they ran in; the receipt's inactivity notice follows the same order. |
| in an existing test | A made-up release (`tests/tui-view.test.mjs`): a release long after the last movement picks nothing and ends the gesture, which a later movement and release without a new press show; one right after a movement, and one after any time without a movement, is a click; a movement before the press does not count, and neither does one with another button; a session's row and `close` follow the same rule, also after another button was pressed or moved on them; and each of the two clocks alone, or one that runs backwards, is enough to refuse. The clocks are the test's. |
| in an existing test | The requests built outside a turn lose AZPR's tools (`tests/runtime.test.mjs`). |

Twenty-two changes that each take one of these rules out of the code (the
marker rule, the proof for a load, the idle hook, the look at the session's
messages, the checks of a stored value, and so on) were tried against the
tests, and each made one fail.

The other changed expectations are the tested version (`2.4.1`) and what
`/pr-check` says of it.

### On the real host

The thirteen host fixture runs passed on OpenCode 2.4.1. What is new in
them:

- **What a private request carries** (`tests/host-v2-smoke.mjs`, fresh,
  `--replace` and `--native`). The fixture's configuration names an
  instruction file. Its text is in the request of an ordinary conversation
  and in none of the 121 requests of private sessions in the fresh run
  (reviewers, duplicate checks, ratings, comment planning), and every stage's
  record names the source that was left out and counts no request that could
  not be told apart.
- **The end of a turn.** Every stage's record of that review counts the
  host's idle reports, at least one: OpenCode ran the hook that closes a
  private session's grant when its work is done. None counts a look at the
  session's messages, a request refused outside a turn, or a user message
  that a request showed without an ID.
- **A local read beside an instruction file.** A quick review whose reviewer
  reads a file of the project with the native read, in a folder that has an
  `AGENTS.md`. The host leaves that file in the reviewer's session, which the
  fixture reads back to see; no request carries its text, the review is
  COMPLETE with one reviewer session, and the stage's record counts the load.
- **A command sent as a prompt.** `/pr-check <URL>` posted to the prompt
  endpoint of a new conversation is refused (the host answers HTTP 500
  without the reason), the conversation holds AZPR's notice and no user
  message, no model is asked, also not for a title, and the command then
  runs there.
- **A workspace's usage limit.** Every request of a quick review is answered
  with HTTP 429 and the code of that limit: one request, one session,
  `failure=permanent`, OpenCode's retry refused, and the receipt names the
  limit.
- **Rows read with the host's read** (`tests/host-v2-comment-scale.mjs`, with
  debug on and off). The first planning page reads two rows of the list of
  120 changed files, which its input names as private data, with the native
  read: the host returns both whole (1,893 characters at most), and their
  texts are the value's beginning.
- **A release the host makes up** (`tests/host-v2-tui-panel.mjs`, from source
  and `--native`). In the real terminal UI, **Reset adjustments** is pressed,
  moved on by a cell and not released, and 2.5 seconds later something else
  is clicked: the conversation gets no notice and the preview stays. The same
  for `close` at the end of the run. The panel measures the moment where it
  handles the events, so the fixture counts the 2.5 seconds from when the
  terminal UI is seen to have handled the movement (a word typed into the
  prompt after it appears there), and reads the result once it has handled
  the click in the same way.
- **A token that is typed** (`tests/host-v2-tui-setup.mjs`): the second token
  is typed key by key, with a Backspace and `ctrl+u` on the way, where the
  fixture only pasted before.
- **The host's tools** (smoke): the image tool under its new name, and a
  video model in the fixture's catalog, so that the check that private roles
  see their allowlist and nothing else runs against tools OpenCode 2.4.1
  really offers to ordinary sessions.

Each new step failed when the change it is for was taken out of a copy of the
tree: with the system parts left as they were, or the host's form no longer
recognised, the step for the configured file; without hiding the load, the
nested file (both sessions `failure=transient`, and the file's text in their
requests); without the refusal, the prompt (HTTP 200 and a user message);
without the limit's type, the usage limit (a second request); with rows of
2,900 characters, the read (a row cut at 2,000); with an idle hook that
closes nothing, the end of a turn (no idle report in the record); and with a
made-up release taken for a click again, the panel's step (the step that was
pressed long before was picked).

Model and Azure DevOps requests of the runs: smoke fresh 123 and 212,
replacement 102 and 182, native 129 and 228; comment scale 36 and 125, with
debug off 36 and 121; background compaction 6 model requests, with debug off
12; the terminal panel 47 and 73 in both runs; setup none and 16, the update
of 0.4.x settings none and 7.

The same tree ran on three other versions, with only its tested version set
to the host's: people upgrade AZPR before OpenCode. On 2.4.0 all thirteen
runs passed. On 2.3.2 and 2.3.0 the comment scale runs, the six runs in the
terminal UI and the background compaction runs passed, except, on 2.3.0, the
background compaction run with debug on, which waits for a background summary
that 2.3.0 does not write by default. The smoke fixture checks the tested
host's own error types and tool names, so on 2.3.2 and 2.3.0 its three runs
stop at the step for a workspace's usage limit, a type those versions do not
have; what comes before that step passed there, among it the review of two
passes, the configured instruction file and the instruction file beside a
local read.

Four probes outside the repository's tests ran on the candidate with a real
host and the fake services. The Claude Code provider, with a stand-in for the
`claude` program, on 2.3.0 and 2.4.1 (see the comparison of the hosts).
Messages in a reviewer's turn, on 2.3.0 and 2.4.1: a native read beside an
`AGENTS.md`, beside a `CLAUDE.md`, in two such folders, and in a correction
turn, each COMPLETE in one session with the file kept from the model; an
instruction file edited while the review ran, with the file watcher on, whose
update the host wrote into the session and no request held; a message of the
load's form that someone else posted, kept from the model as well; and
someone else's ordinary message, which fails the pass as it should. Shell
allowed, on 2.3.0, 2.3.1 and 2.4.1: a command that ends at once, one in the
background that ends during the turn, one that outlasts its timeout, one that
ends six seconds after the answer and one that ends between a first answer
and its correction turn (three runs) each gave a COMPLETE review in one
session with the command run once; so did, on 2.4.1, a background command
under `shell: ask` that was approved through the API. And a review saved by
0.5.0 on 2.4.1, then the candidate installed over it and `/pr-comment`: the
store's pages, 14 rows of up to 3,243 characters as 0.5.0 wrote them, were
written again as 24 rows of at most 1,879, and the preview was planned.

A fifth probe looked at the end of a turn, on 2.3.0, 2.3.1, 2.4.0 and 2.4.1,
with shell allowed and a reviewer that starts a background command. A second
plugin, loaded before AZPR, admitted the notice for that command itself at
chosen moments. Inside the host's idle hook, or a microtask after it returned
(thirteen runs on 2.4.1, three on each other version): the same execution
went on, AZPR's hook read the session's messages once, found no marker after
the prompt and let the request through, the model was asked once more, and
the review was COMPLETE with the notice counted on its stage. A turn of the
event loop later, or one to two milliseconds (ten runs on 2.4.1, two on each
other version): the execution had ended, the session held its marker before
the notice, and the execution the host started then got no request (the
provider was asked nothing more); the review was COMPLETE with the answer
before the marker. With the command's own notice, timed from 40 ms before to
40 ms after the model's last answer (ten runs on 2.4.1, three on each other
version), every review was COMPLETE in one session with the command run once:
the notice was handed to the model as input that waited (three of the ten),
or came after the marker. The moment between the two, where OpenCode starts
another execution while AZPR's wait still covers it, is a few awaits wide and
was not produced on a real host; what AZPR does in it (the look at the
session's messages finds the marker, and the request is refused) is shown by
the unit test with the fixture's host.

### Not verified

- A review with a real model on this candidate, and what a real model does
  after the notice of a background command.
- The moment in which OpenCode starts another execution in a private session
  while the wait for its turn still covers it (the fifth probe above).
- The Claude Code provider with a real Claude Code: a stand-in recorded what
  it would be given, for the reviewer role only; nested instruction files and
  updates with that provider were not run.
- What a real ChatGPT workspace answers at its limit, and an automatic plugin
  update against a registry.
- Real terminal emulators: every mouse gesture and key was injected in tmux.
- The refused prompt in the desktop app and other clients.
- A store that 0.5.0 saved, reopened by this version on a host, beyond the
  run named above.
- macOS, Windows and the desktop app.

## OpenCode 2.3.1 to 2.4.1 compared with 2.3.0 (2026-11-24 to 26)

The baseline is OpenCode 2.3.0, the last version whose interfaces were
[studied one by one](#opencode-230-compared-with-224-2026-11-15-and-16).
0.5.0 named 2.3.2 as the tested host after its fixtures passed there; what
2.3.1 and 2.3.2 change had not been studied. This section covers 2.3.1,
2.3.2, 2.4.0 and 2.4.1 against 2.3.0.

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3 and tmux 3.2a. OpenCode
CLI 2.3.0, 2.3.1, 2.3.2, 2.4.0 and 2.4.1 were installed into disposable
prefixes; all embed Bun 1.4.4, and 2.4.0 moves from OpenTUI 0.8.4 to 0.9.4.
Every run used isolated profiles and the fake model and Azure DevOps services.
No real model or Azure request was made, with one exception that the table
names (the processes of the `claude-agent` provider). The upstream source of
the five tags was read for each host interface AZPR uses, and the 236 entries
of the four releases' notes were read against it. "0.5.0" below is the
released tree; "the candidate" is 0.5.1. Each row says on which versions it
was measured; "source" means read in OpenCode's code and not run.

| Check | Observed |
| --- | --- |
| The fixtures of 0.5.0 | The thirteen host fixture runs of 0.5.0, unchanged: 12 of 13 on 2.3.0 (the background-summary run fails there, since 2.3.0 writes no such summary by default), 13 of 13 on 2.3.1 and on 2.3.2. On 2.4.0 and 2.4.1 they pass once the tests follow two changes of the host: the image tool is `generate_image` (was `experimental_image_generate`), and lists mark the current choice differently in the terminal UI's new design. |
| Model requests | Every request a 0.5.0 fixture review sends to the fake model was recorded and compared part by part between versions. 2.3.1: the host's own `read` tool description is one sentence shorter. 2.3.2: identical to 2.3.1. 2.4.0: the environment block no longer has a sentence about worktrees. 2.4.1: identical to 2.4.0. AZPR's system prompts and tool definitions are the same on all five. |
| What the host adds for a conversation's place | Measured on 2.3.0, 2.3.1 and 2.4.1 with 0.5.0, a review of 6 files with two passes and its preview (9 private requests in 7 sessions). Characters added to every private request, against a directory with no instruction source: an `AGENTS.md` in the conversation's directory (AZPR's own, 53,853 bytes) 54,085 on all three; the same text as `CLAUDE.md` there, or as `~/.claude/CLAUDE.md`, nothing on 2.3.0 and 54,085 and 54,120 from 2.3.1; an MCP server that says 2,100 characters about itself 2,144; a file the configuration lists under `instructions` 1,988; a reference 476; the last three on 2.3.0 too. With the `AGENTS.md`, the system messages of the nine requests came to about 625,000 characters instead of 138,000; the rating, which has no tools and a prompt of 5,226 characters, received the whole file. |
| The candidate and those sources | Same runs, 2.3.0, 2.3.1 and 2.4.1: in all eight arrangements the private requests carry the date and the environment only, their system messages are back at the size of a directory without sources, an ordinary conversation's request still has every source, and the review, the preview and the number of requests are as before. |
| Instruction files beside a file that was read | Measured on 2.3.0, 2.3.1 and 2.4.1: a reviewer's native `read` of a file in a directory with its own `AGENTS.md` makes the host leave that file in the session as a message, which reaches the model. 0.5.0 then fails both of the pass's sessions (`The session received another message during this turn`) and the review is INCOMPLETE; with a `CLAUDE.md` instead, only from 2.3.1. The candidate on the three versions: COMPLETE with one session, also after two such directories and when the load falls into a correction turn, and the file's text is in no request. A message of the same form that someone else sends is kept from the model as well; any other message still ends the turn. |
| An instruction file that changes during a review | Measured on 2.3.0 and 2.4.1: the host writes an update into the session, which 0.5.0 passes to the model (`<system-update>The instructions changed: …`). The candidate keeps it out of private requests. |
| The Claude Code provider | OpenCode's `claude-agent` provider does not send the system parts. Its own hook, which runs before any plugin's and before the built-in hooks that add the model's identity and a hint about worktrees, joins the instruction sources but the date and the environment into one text, and Claude Code is handed that text after the agent's prompt (source, all five tags). Measured on 2.3.0 and 2.4.1 with a stand-in for the `claude` program that records what it is given, so that no model ran, and with an `AGENTS.md`, a configured instruction file and an MCP server's text in place: 0.5.0's private reviewer session was handed all three, in a system prompt of 18,856 characters. So was a first form of the candidate, which worked that text out again from the parts as a plugin sees them, matched nothing, left the request as it was and counted it. The candidate takes the sources it leaves out of the parts out of that text as well: the reviewer's system prompt has 18,117 characters, none of the three and AZPR's role prompt as before, the stage record names the two sources, and an ordinary conversation on the same model keeps all three. Only the reviewer role ran, and no real Claude Code. For the same reason, what AZPR itself adds to the system parts (the note that ends a comment page's reading) does not reach a `claude-agent` model, as before this release (source). |
| A usage limit of a ChatGPT workspace | The provider's answer carries the code `subscription_sharing_workplace_individual_usage_limit_exceeded`. OpenCode's own ChatGPT plugin refuses to retry it on all five versions (source, and upstream's test). Measured with HTTP 429 from the fake provider and a stand-in for that plugin's decision: 2.3.0 to 2.3.2 report `provider.rate-limit`, or `provider.quota` where the answer's text also speaks of a usage limit; 2.4.0 and 2.4.1 report `provider.chatgpt-workspace-limit` either way. 0.5.0 on 2.4.x: two sessions, both `failure=transient`, a receipt that names only HTTP 429. The candidate on 2.4.0 and 2.4.1: one session, `failure=permanent`, the limit named. What a real workspace answers was not seen. |
| AZPR's tools outside a turn | Measured on 2.3.0, 2.3.1 and 2.4.1: in an ordinary conversation, a generation, a manual summary, a background summary and a compaction in the turn each carried 18 to 20 tool definitions, 6 of them AZPR's (4,990 of 22,780 characters on 2.4.1); a turn's own requests carried none. The candidate: none in any of them. |
| The read tool's line limit | The native `read` returns at most 2,000 characters of a line and appends `... (line truncated to 2000 chars)` (source, 2.3.0 and 2.4.1). Measured on both with a PR description of 9,000 characters, which a reviewer and a comment planner each got as a reference: of every row of 3,000 characters, 1,910 could be read. The candidate's rows are at most 1,900 characters as written; the same reads return them whole. A value of 12,000 characters has 7 rows instead of 4. |
| The order of stages | A run records a stage when the host has created its session. Six reviews of one PR, two passes over three shards: 0.5.0 listed the stages in 4 different orders on 2.3.0 and in 6 on 2.4.1, and the report was in one of two sessions. The candidate: one order and one session on both. |
| A command in the background | Shell allowed (`inherit`, and `ask` with an approval through the API), measured on 2.3.0, 2.3.1 and 2.4.1. A command the model starts with `background: true` and that ends while the turn runs: 0.5.0 fails both sessions of the pass on all three, and the command runs twice. A command that outlasts its `timeout`: stopped on 2.3.0, so the review completes; moved to the background from 2.3.1 on, with the same failure. The candidate: COMPLETE, the command once, on all three; also where the notice arrives between a first answer and its correction turn (three runs each). A notice after the last answer wakes the session that keeps the report; AZPR refuses that request, and the session is left in a failed state. |
| A shell command the host cannot analyze | `alias p=true; …`: a tool error of the host's scanner on 2.3.0 and 2.3.2; on 2.4.0 and 2.4.1 the host asks for every directory instead, which AZPR's project boundary refuses, so the command does not run on any of them. The candidate says why in that case. |
| A shell request nobody approves | `shell: ask`, measured on 2.3.0 and 2.4.1 with `workflow.stageIdleSeconds` at 60: both sessions of the pass wait their window and fail as idle, 120 s in all. The request belongs to the reviewer's session. |
| Reloading plugins | Measured on 2.3.0 and 2.4.1 with the file watcher on and a review under way: a plugin that is loaded before AZPR changes, and AZPR is unloaded and loaded again; the review ends `CANCELLED` within 0.25 s (`OpenCode V2 plugin unloaded`). A plugin loaded after AZPR, or an unrelated key of the configuration, leaves it running. Local plugins of the configuration directory are loaded before the entries of `plugins`. |
| Automatic plugin updates | Source only: 2.3.x check every 24 hours and mark a plugin as updatable; 2.4.0 and later install the newer version of an entry that follows one (`@latest`, a range, a Git branch, a `#semver:` range) when the service starts and every 24 hours, and reload. An exact version is not even checked, and a Git tag or commit is not changed. Not run against a registry. |
| Commands at startup, over HTTP | `/pr-check` sent to the command endpoint as soon as the server listened: READY in 10 of 10 starts on each of 2.3.0, 2.3.2, 2.4.0 and 2.4.1. On 2.4.x the model list answers before plugins are loaded (empty in those 10 starts), which a command does not depend on: it waits for the plugins. |
| Commands at startup, in the terminal UI | `opencode --prompt "/pr-check <URL>"` with a project directory the server had not loaded: sent as an ordinary prompt in 1 of 6 starts on 2.3.0, 0 of 6 on 2.3.2, 5 of 6 on 2.4.0 and 9 of 10 on 2.4.1; in 5 and 5 of those on 2.4.x the conversation's model was the built-in `opencode/big-pickle`, not the configured one (requests to it were blocked in the fixture). With the directory already loaded: 0 of 4 on 2.3.x, 1 of 4 on each of 2.4.0 and 2.4.1. |
| The candidate and such a prompt | 2.4.0 and 2.4.1, 22 starts: 5 ran as a command and 17 were refused; a refused prompt left no user message and no model request, also no title request. The terminal UI then showed `Failed to set up session` and tried again in a new conversation, two to four in all; where a retry found the commands loaded, the command ran. 2.3.0, 6 starts: all ran as a command. |
| A release that was lost | OpenTUI 0.9.4 ends a drag whose release never arrived at the next press of the left button, with a release for the element that was pressed, at the place of the last movement (source). Measured with injected mouse sequences in tmux on all five versions, and on 2.4.1 in both designs: a step that is pressed, moved on by one cell and not released is picked by a later click elsewhere on 2.4.0 and 2.4.1 with 0.5.0, never on 2.3.x. With **Post 3 comments…** and that click where the question's second row appears, the three comments were posted to the fake service. A session's row and `close` were triggered the same way. The candidate, on 2.3.0, 2.4.0 and 2.4.1: none of it; an ordinary click, and one with a movement of a cell, pick as before. How often a real terminal loses a release is not known. |
| Typing a token | The setup fixture only pasted. Thirty steps of typing, keys of the Kitty and xterm protocols, pasting and keys that must change nothing passed on all five versions and in both designs, with no change to the code. Page Up and Page Down close the dialog on all of them (the host's handler for scrolling the transcript clears dialogs). |
| Screens | The panel and the setup dialogs were walked through on 2.4.1 (new design, classic design, light theme) and on 2.3.0, and 228 screens were rendered as pictures from tmux captures; about 55 were looked at, the rest compared as text. Nothing is wrong on 2.4.1 that is right on 2.3.0. The same on both: typing `F-1` into the list of adjustments selects `F-11` when there are twelve findings; a panel that fills a narrow terminal shows the Markdown's background as bands; a question's second line is cut at the dialog's width. |
| Markdown | 2.4.0 renders Markdown with a native engine (source): character references in running text are decoded, and struck-through text is drawn so. The summary table, whose cells AZPR decodes itself, reads the same on 2.3.0 and 2.4.1 (screens). |
| Compiled view | A package whose terminal part is the JSX source does not load on 2.3.0 (measured) and loads and passes the panel and setup fixtures on 2.4.1 (measured). 2.3.1 and 2.3.2 have 2.3.0's OpenTUI (source). The compiled file loads on all five. |
| Processes of the `claude-agent` provider | The one measurement with a real model: `claude-agent/haiku` on 2.3.2 and 2.4.1, ten one-word prompts and two reviews of a two-file fixture PR. Each session has a local `claude` process of 200 to 230 MB. It ends about five minutes after the session's last turn on both (the provider's idle timer, in all five tags). Deleting the session ends it within 2 s on 2.4.1 and not at all on 2.3.2: after a review with debug off, five processes were left on 2.3.2 and one on 2.4.1. When OpenCode stops, the processes end with it. Claude Code's transcript of each session stays under its configuration directory on both. |
| Background summary | On by default from 2.3.1 (`compaction.background`; 2.3.0 has `experimental.background_compaction`, off). The thresholds are those of 2.3.0 on all five (source). |
| Plugin interface | The session methods, message types, hooks, events, the error of a missing session, the plugin list and the registration of commands and agents that AZPR uses are unchanged from 2.3.0 to 2.4.1 (source). A change of commands a plugin makes after it was loaded is still announced without its location. |
| Database | 2.3.1 adds three migrations and 2.4.0 two, and 2.4.0 stores an answer's parts in rows of their own (source): going back to an earlier version needs a backup. |
| Requests to OpenAI-style providers | From 2.3.2, models reached through the Responses interface get the system prompt as a developer message (source). The fake provider speaks another interface, so no fixture shows it, and its effect on reviews is not measured. |

How often real models read local files was counted in the debug records of
about 4,900 earlier runs, nearly all of them benchmark reviews. In the runs
of ReviewBench's pull requests, reviewer sessions called the native `read` in
9% of the sessions of GPT-6.1 Sol (158 of 1,729), 15% of GPT-6.2 Sol, 3% of
GPT-6 Luna and 4% of GPT-6.1 Terra; in the other sets none did. The failure
that a nested instruction file causes appears once in those records.

Not covered: reviews with real providers on 2.3.1 to 2.4.1. The benchmark
runs of 0.5.0 ran on 2.4.0 before this comparison, and the one measurement
with a real model in the table (`claude-agent/haiku` on 2.3.2 and 2.4.1)
looked at how long a local process lives, with 0.5.0: it says nothing of what
a review finds, and nothing of this candidate. Also not covered: the answer a
real ChatGPT workspace gives at its limit; an automatic plugin update itself;
real terminal emulators and their mouse and keyboard reporting; the desktop
app, macOS and Windows; and the native terminal UI in OpenCode's source,
which has not shipped.

## 0.5.0 on Martian's Code Review Bench with Claude Opus 5.5 (2026-11-25)

The [public benchmark](#martian-code-review-bench-2026-11-05-and-06) had been
run with 0.3.5 and with the
[0.4.6 candidate](#martians-code-review-bench-measured-again), both reviewing
with two reviewers and a verifier. 0.5.0 reviews with passes instead, so it
was run again, with the model of those runs: with two passes (the default),
three and four, one run each.

- **Review.** AZPR 0.5.0 as published on npm, `/pr-deep` with
  `claude-agent/opus#medium` (Claude Opus 5.5 at medium effort, Claude Code
  CLI 2.1.314) for every pass, the first reviewer model rating the severities
  (the default), English output, the same 50 pull requests at the same
  commits and the same local implementation of the Azure DevOps calls as
  before. The host was OpenCode 2.4.0, not the tested 2.3.2: on 2.3.2 every
  claude-agent session keeps a local process of about 200 MB until the host
  exits, and the three runs started about 1,200 model sessions; 2.4.0 stops
  the process when its session is deleted, which the runs showed between two
  reviews. (Correction of 2026-11-26: the process ends five minutes after the session's last turn, not when the host exits; on 2.3.2 deleting the session does not end it earlier. See [the comparison of the hosts](#opencode-231-to-241-compared-with-230-2026-11-24-to-26).) The five pull requests with 30 or more changed files were reviewed
  one at a time and the others two at a time; at most 31 such processes ran at
  once, and at least 1.6 GB of memory stayed free.
- **All runs complete.** All 150 reviews were COMPLETE without a retry.

  | Passes | Findings (high, medium, low) | Median review | Longest | Model cost against 0.4.6 |
  | --- | --- | ---: | ---: | ---: |
  | Two | 348 (48, 151, 149) | 112 s | 282 s | 83% |
  | Three | 371 (56, 167, 148) | 119 s | 285 s | 121% |
  | Four | 406 (69, 167, 170) | 138 s | 338 s | 157% |

  Model cost weighs each run's tokens by the provider's prices relative to
  uncached input: cache reads 0.1, cache writes 1.25, output and reasoning 5;
  0.4.6's run is counted without its comment previews. The runs took 57, 63
  and 70 minutes. In 49 reviews of each of the two- and three-pass runs and in 46 of the
  four-pass run every pass finished its files. In the others a pass still
  named unfinished work after its follow-up: in every run the same
  sentry-greptile pull request, where the passes covered 7 of its 8 files
  (with two passes, no pass reviewed the eighth), and with four passes three
  cal.com pull requests, where every pass still covered every file. As in the
  0.4.6 run, five cal.com pull requests had no content search, since that
  repository's archive is larger than `azure.archiveMegabytes` allows by
  default.
- **Choosing a run to score.** Our own judge (the benchmark's three prompts
  applied by Claude Opus 5.5 subagents, as in the
  [model comparison](#martian-code-review-bench-2026-11-05-and-06)) scored
  the three- and four-pass runs under a rule written before any score was
  seen: the higher core F2 goes to the official judge. Three passes: precision
  27.4, recall 70.9, F2 53.8, with 112 core golden comments matched and 297
  unmatched issues; four passes: 24.2, 70.3 and 50.9, with 111 and 348. The
  two-pass run, the default, was added afterwards and scored officially as
  well; four passes were scored by our judge only.
- **Scoring.** By the benchmark's pipeline (upstream `e616e84` with the
  scoring step of `23a35d0`, which changes only how a repeated match is
  counted) and the dashboard's judge, Claude Opus 4.5
  (`claude-opus-4-5-20251101`, temperature 0), through Anthropic's
  OpenAI-compatible endpoint: 413 extracted issues and 1,745 judged pairs for
  two passes, 434 and 1,844 for three. Eight extractions failed once (three
  refused for too many concurrent requests) and passed when retried, and no
  verdict is missing. Every verdict was recorded, so both ways of counting
  come from the same judging.

| Core golden comments, one run each | Comments | Issues per PR | Precision | Recall | F2 | High and Critical recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AZPR 0.3.5 (2026-11-06) | 323 | 7.6 | 30.0 | 67.7 | 54.1 | 74.2 |
| 0.4.6 candidate (2026-11-21) | 341 | 8.1 | 27.2 | 67.1 | 51.9 | 75.8 |
| 0.5.0, two passes (2026-11-25) | 348 | 8.3 | 29.9 | 73.4 | 56.9 | 80.3 |
| 0.5.0, three passes (2026-11-25) | 371 | 8.7 | 27.2 | 69.6 | 53.1 | 78.8 |

Counted as the dashboard's published results count. Under the corrected
counting the 0.4.6 candidate scores 28.5, 67.1 and 52.8, 0.5.0's two passes
31.3, 73.4 and 57.8, and its three passes 28.2, 69.6 and 53.8; 0.3.5's
verdicts were not recorded. The two passes matched 116 of the 158 core golden
comments (0.3.5: 107) and 53 of the 66 High and Critical ones (49); 272
extracted issues matched none (250). On the dashboard's default view that is
the highest recall of its 21 tools (copilot-v2 66.5) and the highest High and
Critical recall (qodo-extended-v2 and augment 74.2), with the sixth F2: after
copilot-v2 (58.0), ahead of gemini-v2 (52.8).

What this shows and what it does not:

- **About the same as before, not better.** One run's recall has a sampling
  error of about 3.7 points and its precision of about 2.3, so a difference
  between two runs has one of about 5 and 3. No difference between these
  four runs is twice that: 0.5.0 finds about as much of the benchmark's list
  as 0.3.5's and 0.4.6's two reviewers and verifier did.
- **Runs vary more than a pass adds.** Counted from the recorded official
  verdicts of the three-pass run, with each extracted issue attributed to the
  finding it most resembles and kept when that finding came from the first
  passes, its first pass alone found about 60.1% (precision 30.4), its first
  two 65.8% (28.7) and all three 69.6% (27.2). Our own judge, scoring the same
  subsets rebuilt from the run's records (the rebuild with all three passes
  reproduces the run's 371 findings), gave 63.3% (33.2), 67.7% (30.1) and
  70.9% (27.4). Within a run each pass found more and lowered precision; the
  separate two-pass run found about 8 points more than the first two passes
  of the three-pass run. By our judge a fourth pass, in its own run, found no
  more than three. On ReviewBench, with GPT-6.2 Sol, three and four passes
  found more than two
  ([0.5.0 against 0.4.6](#050-against-046-on-reviewbench-with-its-own-judge-2026-11-24)).
- **What it saves depends on the model.** With Claude Opus 5.5 here, two
  passes cost 83% of 0.4.6's run, three 121% and four 157%. With GPT-6.2 Sol
  on ReviewBench the same setups cost 58%, 78% and 105%: there 0.4.6 had
  filed about five times as many findings per pull request, and the verifier
  that checked them, which 0.5.0 drops, was a larger part of its cost.
- **Our judge and the official one agreed this time.** For the three passes
  our judge gave F2 53.8 and the official one 53.1 under the dashboard's
  counting (53.8 under the corrected one); for 0.3.5 ours was 2.5 points
  lower.
- **Not on the tested host.** The reviews ran on OpenCode 2.4.0 with AZPR's
  code unchanged; AZPR is tested with 2.3.2. This run is evidence for 0.5.0 on
  2.4.0, and the 2.3.2 process limit above applies to real use with
  claude-agent models there (as corrected above: five minutes after a
  session's last turn).
- **Not a leaderboard result.** We ran the benchmark's pipeline and judge
  ourselves; the dashboard includes tools by their public GitHub activity, and
  AZPR reviews Azure DevOps pull requests.

## 0.5.0 after publication (2026-11-24)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.2 and tmux 3.2a, in isolated OpenCode profiles with the fake model and
Azure DevOps services.

- **The merged tree.** The pull request was merged with a merge commit whose
  tree is that of the candidate's last commit. CI passed on that commit, on
  `main` and on the tag. That commit changes only documentation against the
  last commit of the review (`e560de3`): the code and tests are those the
  thirteen host fixture runs passed on.
- **Before the tag.** On the candidate's last commit: the source archive
  passed the clean-directory installation check, the package built from a
  clean export holds 35 files, all 350 local links and images of the 48
  Markdown files resolve, and the public Git commit, installed by OpenCode's
  plugin manager, passed the native smoke, terminal panel and setup fixtures
  and the setup fixture's update of 0.4.x settings.
- **Source archives.** The release's source archive, downloaded again, is
  byte-identical to the one built from the tag, and so is GitHub's own archive
  of the tag. They passed the clean-directory installation check: 23 runtime
  modules, 6 prompts and the license as in the archive, the view's JSX source
  not installed, and `--replace` keeping the settings file byte for byte.
- **The Git package.** `github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.5.0`,
  installed by OpenCode's plugin manager, passed the native smoke fixture
  (124 model and 203 Azure DevOps requests), the terminal panel's fixture (47
  and 73) and the setup fixture (no model request, 16 Azure DevOps requests).
- **The npm package.** The registry's integrity and shasum for 0.5.0 equal
  those of the package built from the tag, which holds the candidate's 35
  files; the tarball downloaded from the registry is byte-identical to it, and
  `latest` names 0.5.0. Installed from the registry, the package passed the
  same three fixtures with the same request counts, and the update of 0.4.x
  settings (no model request, 7 Azure DevOps requests).

The runs with real models were made with the candidate; see
[0.5.0 against 0.4.6 on ReviewBench](#050-against-046-on-reviewbench-with-its-own-judge-2026-11-24)
and the [release candidate's acceptance](#050-release-candidate-acceptance-2026-11-23)
for them and for what was not verified.

## 0.5.0 against 0.4.6 on ReviewBench with its own judge (2026-11-24)

Before the release, 0.5.0 and 0.4.6 reviewed the same pull requests of
ReviewBench's test set with the same model, and ReviewBench's own judging
pipeline scored every run. The configurations, the measures and how a
difference is read were written down before any result, and the results are
reported as they came out.

**Configurations.** GPT-6.2 Sol at its default reasoning effort in every role:

| Run | AZPR | Reviewers |
| :--- | :--- | :--- |
| 0.4.6 | 0.4.6 from npm, run 2026-11-22 | a functional and a risk reviewer and a verifier; no rating |
| Two passes | 0.5.0 at commit `e6f7332`, run 2026-11-24 | two passes and the rating by the first model, the default |
| Three passes | the same | three passes |
| Four passes | the same | four passes, the most a mode takes |

A run with one pass was reviewed as well (23.4 findings and US$0.33 per pull
request, a median of 253 s) but not judged: the judge's budget did not cover
another run.

The three commits from `e6f7332` to the release's `e560de3` change only
`src/attribution.mjs`, `src/comment-work.mjs` and `src/comments.mjs`: how
comment planning and the report read locations that 0.4.x saved, and places
whose path holds a colon. The prompts and the review stages are the
release's, byte for byte, and the scored findings are a review's `REPORTED`
findings (for 0.4.6, its `CONFIRMED` findings in the verifier's wording and
the verifier's own), so they are what the release produces.

Everything else is as on the
[research page](#one-pipeline-passes-instead-of-roles-2026-11-22-and-23):
OpenCode 2.3.2 with an isolated profile, the Git-backed stand-in for Azure
DevOps, four reviews at a time, and 24 of the 25 test pull requests.
`simnaut/emdash#2` was left out of every run: its head merges about 100
upstream commits, 0.4.6 filed 449 findings there (35% of its run) in 52
minutes, and the judge reads all findings of a pull request in one session,
which for that many would pass its model's context window or cost an
estimated US$50 to 300 a run.

**Judge.** ReviewBench's `npm run judge` at its upstream commit `082f65f`
(2026-11-18) rather than the pinned `228f2a8` of the earlier pages: upstream
had removed same-file duplicates from 47 reference files (#107) and made the
judges read JavaScript-style escapes (#117). The judge model is Claude Sonnet
5, the model that judges the leaderboard, four pull requests at a time. Each
run was judged once. These numbers are not compared with those judged with
`228f2a8` (the 0.3.5 to 0.3.7 table).

**Measures.** Per pull request: findings; *judged valid*, the share of
findings that matched a true reference issue or that the judge rated valid
(ReviewBench's augmented precision); *reference issues found*, the share of
the true reference issues that some finding covered (grounded recall, pooled
over the pull requests); the same for the high and medium reference issues;
*inline decisions*, the F1 of AZPR's medium or high against the judge's level
on valid findings; cost at GPT-6.2 Sol's list price (US$2 per million input
tokens, 0.10 cached, 10 output with reasoning) from each run's token counts;
and the median time of a review. A difference is read as one when it is
larger than the falls allowed in the earlier ReviewBench comparisons (2.8
points of reference issues found, 2.0 of judged valid, 3.6 of high and medium
found, 5.8 of inline decisions: twice the variation of two runs of one setup
when their results are swapped pull request by pull request). The plan written
before the results gave 1.3 and 3.9 for the second and third; no reading below
changes with them.

| Per pull request | Findings | Judged valid | Reference issues found | High and medium found | Inline decisions (F1) | Cost | Time |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.4.6 | 34.1 | 93.2% | 51.5% | 60.6% | 75.4 | US$1.30 | 367 s |
| Two passes | 27.8 | 89.7% | 49.1% | 61.9% | 77.2 | US$0.76 | 293 s |
| Three passes | 31.1 | 93.2% | 51.2% | 63.7% | 76.2 | US$1.01 | 290 s |
| Four passes | 33.7 | 91.0% | 54.8% | 65.6% | 78.3 | US$1.36 | 338 s |

The differences to 0.4.6, each with its standard deviation when the two runs
are swapped pull request by pull request (2,000 swaps):

| Against 0.4.6 | Reference issues found | Judged valid | High and medium found | Inline decisions |
| :--- | ---: | ---: | ---: | ---: |
| Two passes | −2.4 (sd 2.3) | −3.5 (2.3) | +1.3 (1.8) | +1.9 (2.4) |
| Three passes | −0.3 (1.8) | 0.0 (0.9) | +3.1 (1.6) | +0.9 (2.9) |
| Four passes | +3.3 (1.6) | −2.2 (1.4) | +5.0 (2.2) | +2.9 (2.5) |

ReviewBench's own four measures, with F1 and F2 computed from them, pooled
over the 24 pull requests; the last column averages F1 per pull request, as
the leaderboard does. Grounded precision counts only the findings that matched
a reference entry, true or false; augmented recall adds each run's own valid
findings to its reference set, so ReviewBench advises against ranking by it.

| | Grounded precision | Grounded recall | F1 | F2 | Augmented precision | Augmented recall | F1 | F2 | Augmented F1 per PR |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.4.6 | 84.7 | 51.5 | 64.0 | 55.9 | 93.2 | 82.5 | 87.5 | 84.5 | 83.2 |
| Two passes | 81.5 | 49.1 | 61.3 | 53.4 | 89.7 | 78.0 | 83.4 | 80.1 | 81.2 |
| Three passes | 83.8 | 51.2 | 63.6 | 55.5 | 93.2 | 81.1 | 86.7 | 83.2 | 84.3 |
| Four passes | 81.0 | 54.8 | 65.3 | 58.6 | 91.0 | 83.0 | 86.8 | 84.4 | 84.5 |

What the runs show:

- **Two passes.** Reference issues found −2.4 and high and medium +1.3: the
  same as 0.4.6, at 58% of its cost and 80% of its time. Judged valid −3.5: a
  difference. All four runs reported one defect at the same 12 places
  (frontmatter that does not parse as YAML, in agent files that
  `scotthamilton77/agents-config#1` moves); the judge accepted the 12 findings
  of 0.4.6 and of three and four passes and rejected those of two passes.
  Decided as in the other runs, they would give two passes 91.5%. Beyond that
  case, the judge's verdicts at one place vary between runs: 44 of the 69
  findings of two passes it rejected lie where 0.4.6 had a finding it
  accepted, and 29 of 0.4.6's 56 where two passes had one.
- **Three passes.** Every difference within the allowed falls: the same as
  0.4.6, at 78% of its cost and 79% of its time.
- **Four passes.** Reference issues found +3.3 and high and medium +5.0, both
  beyond the allowed falls and about two standard deviations of the swap:
  more than 0.4.6, at 105% of its cost and 92% of its time. Judged valid
  −2.2: a difference.
- **More passes find more.** Reference issues found 49.1, 51.2 and 54.8%,
  high and medium 61.9, 63.7 and 65.6% with two, three and four passes. Each
  pass adds US$0.25 to 0.35 per pull request; the passes run side by side, so
  time grows little.
- **Severity.** The rating marks about 20% of 0.5.0's findings high (0.4.6:
  9.3%); of the valid ones, the judge rated 27% to 33% high (0.4.6: 47%). The
  inline decision, medium or high against low, agrees with the judge as well
  as before (F1 76.2 to 78.3 against 75.4), and fewer of the findings the
  judge rated medium or high carry AZPR's low (10.7 to 13.0% against 16.6%).
- **Two roles against one prompt.** 0.4.6's output without the verifier's own
  98 findings is what its two role prompts reported, merged and in the
  verifier's wording: 30.0 findings per pull request, 92.5% judged valid,
  49.7% of the reference issues and 60.6% of the high and medium ones, as
  much as two passes of the one prompt found (49.1% and 61.9%). The verifier's
  own findings covered 6 more reference issues (1.8 points), none of them high
  or medium.

**Cost of judging.** At the judge model's list price, from its session
records: US$38.71 for 0.4.6, and 28.03, 32.95 and 34.35 for two, three and
four passes, plus the matching step, which keeps no record (about US$1 to 2 a
run, from the account's balance). About 98% of the judge's prompt tokens were
read from its cache.

**Limits.**

- One run per configuration. The allowed falls come from an earlier setup
  scored by the local judge; no run-to-run variation of this judge with this
  model is known.
- The judge's verdicts on single findings vary between runs (above), so
  differences of a few points of judged valid are partly the judge's.
- 24 of the 25 test pull requests, one model at its default effort. The 0.4.6
  run was made two days before the 0.5.0 runs, with the same OpenCode,
  profile and stand-in.
- Times depend on four reviews running at once and on the provider's load.
- We ran the judging pipeline ourselves; this is not a leaderboard entry. The
  leaderboard runs on ReviewBench's full set of 219 pull requests, of which
  the test set is a sample of 25, so these numbers do not compare with its
  rows.

## 0.5.0 release candidate acceptance (2026-11-23)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.2 and tmux 3.2a, with isolated OpenCode profiles and the fake model and
Azure DevOps services for the tests and host fixtures. Real models ran
afterwards against the Git-backed stand-in for Azure DevOps of the
[research page](#one-pipeline-passes-instead-of-roles-2026-11-22-and-23).

0.5.0 replaces the reviewer roles and the verifier with one pipeline for every
mode (see [how reviews work](../README.md#how-reviews-work)). `review-work.mjs`
runs the passes of every shard in one session pool, numbers the findings once
all passes have answered, removes identical records, runs the duplicate check
per file and side, and the rating; `output.mjs` refuses a merge that would
join two findings of one session; `comments.mjs` tells the three kinds of
saved review apart (`reviewMethod`); `config.mjs` has the version-3 settings
and the pure update of a version-2 file (`migrateSettings`), which
`setup.mjs` shows and writes only for the word that names it, and
`tui-setup.mjs` asks for in the terminal UI. Of the prompts, `review.md` is
new (the reviewer prompt of the development builds), `functional.md`,
`risk.md`, `final.md` and `quick.md` are gone, and `common.md`, `dedupe.md`,
`rating.md`, `comment-plan.md` and `comment-policy.md` changed. The hash test
holds the system prompts of five review roles in two configurations; the
verified planner's two hashes are those of 0.4.6's comment planner. The tested
host moves to OpenCode 2.3.2.

### Offline

`npm run check` passes, and `npm test` runs 783 tests (686 for 0.4.6), all
passing, on the final code (commit `e560de3`, 2026-11-24). Among them, for what is new: the order of finding IDs whichever
session answers first (`tests/review-work.test.mjs`, `tests/runtime.test.mjs`);
the duplicate check's refusal of a merge within one session, directly and
through a third finding (`tests/output.test.mjs`); the rating's input, which
holds no level, session or count, its three states and what a failed rating
keeps; the coverage numbers with one and with several passes; a mode that is
off; the three kinds of saved review, what each may comment on and with which
planner and disclosure line (`tests/comments.test.mjs`,
`tests/comment-work.test.mjs`); a review of this version that finds the
comments a review of 0.4.x posted and posts none of them again; and the
update of settings of 0.4.x (`tests/setup.test.mjs`,
`tests/tui-setup.test.mjs`): only the confirmed word rewrites such a file,
also one with a fault; a word holds only for the file it was shown for and
for the process that showed it; the update is written under the setup lock,
in one step and owner-only; what it shows names every change in behaviour;
no value that is not a model ID, and no token, leaves a model row; and the
installer carries such a file over byte for byte (`tests/install.test.mjs`).

### On the real host

The thirteen host fixture runs passed on the final code (commit `e560de3`,
2026-11-24), as on every commit of the review that led to it; two of them are
new.

- **Two passes of two models** (`tests/host-v2-smoke.mjs`, fresh,
  `--replace` and `--native`). A review runs four private sessions of their
  own (both passes, the duplicate check of the file both reported, which
  merges their finding after a correction turn, and the rating on its own
  model without tools); the comments are previewed, posted, found after a
  host restart and not posted twice. `/pr-quick` runs one reviewer session
  and its rating, `/pr-deep` without reviewer models is refused before any
  request, and the native installation's first setup writes the model twice
  for `/pr-review` and once for `/pr-quick`. The fixture's other checks
  (automatic comments, cancellation, a provider 503 and a cut stream that
  OpenCode retries in place, the inactivity watchdog, the proxy) passed as
  before.
- **At scale** (`tests/host-v2-comment-scale.mjs`, with debug on and off).
  120 files in two passes: the first pass's 24-file first shard reaches its
  context and is split in two (`pass 1/2 shard 1/5a`, `1/5b`); the duplicate
  check merges the one finding both passes report at one place (31 reports,
  30 findings); the rating sets every level (20 high, 10 low, from reviewers
  that filed all of them as medium); 18 inline comments, three high findings
  sharing one, and the summary are posted, and a second publication finds
  all 19. With debug off the run's 15 sessions are deleted but the one
  holding the report.
- **A pass that fails** (`tests/host-v2-background-compaction.mjs`, with
  debug on and off). The first pass's reviewer fails with HTTP 401 after the
  host asked for a background summary, which AZPR refused: no split and no
  retry. The second pass completes, so the review is COMPLETE, and its
  receipt says `coverage complete, 0/4 file(s) in every pass`. OpenCode
  2.3.2 has no `experimental.background_compaction`: its background summary
  is `compaction.background`, on by default, so the fixture now runs with the
  host's defaults. Measured on 2.3.2 with a 100,000-token window: a summary
  from about 42,000 tokens, an in-turn compaction (the shard split) at
  84,000, the same rule as 2.3.0's. With debug off, a second review in which
  no session gives a usable answer is PARTIAL and keeps the session holding
  its draft on the run's record.
- **The terminal panel** (`tests/host-v2-tui-panel.mjs`, from source and
  `--native`). The panel opens on STARTED with the four reviewer sessions of
  two passes over two shards, shows the report from the rating's session,
  counts the five deleted sessions, and posts and adjusts from its foot as
  before.
- **Setup and its update** (`tests/host-v2-tui-setup.mjs`, from source and
  `--native`, each without and with the new `--migrate`). The first setup
  writes the lists, and a model row's editor asks for one model and then for
  its passes. With `--migrate` the profile starts with a settings file of
  0.4.6: nothing rewrites it by itself (from source the installer carries it
  over unchanged), AZPR's commands say only that the settings need an update,
  `/pr-setup` shows the change and a list whose first row keeps the file
  (leaving and that row write nothing), and confirming writes the complete
  file of this version, which AZPR loads at once: `/pr-check` is READY
  without a restart. Neither run makes a model request.

### With real models

Before the rest of the release work, one pull request of ReviewBench's test
set (PierreJanineh/TechDebtMCP#135) was reviewed with two passes of
GPT-6.1 Terra: COMPLETE in 54 seconds, two duplicate checks that merged three
reports, the rating, 4 findings, and a report and receipt that state the
method and both coverage numbers.

Then the candidate reviewed the 24 pull requests of the research page with
two passes of GPT-6.1 Terra and the default rating (the first reviewer model),
scored by the same local judge:

| Per pull request | Findings | Judged valid | Reference issues found | High and medium found | Cost | Time |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.4.6, Terra in all three roles | 7.3 | 90.2% | 29.5% | 50.3% | US$0.15 | 94 s |
| Development build, two passes of Terra, no rating | 7.5 | 91.1% | 29.2% | 48.5% | US$0.13 | 73 s |
| **This candidate, two passes of Terra** | **7.2** | **93.0%** | **29.8%** | **50.9%** | **US$0.12** | **67 s** |

- All 24 reviews completed. 54 reviewer sessions filed 295 reports; the
  duplicate check (68 sessions) merged 123 of them, refused no merge and did
  not fail; 24 rating sessions rated the 172 findings that were left. No
  stage needed a correction turn; two reviewer sessions answered PARTIAL with
  named gaps, got their one follow-up turn and stayed PARTIAL.
- The candidate matches the development build within the variation between
  runs, and 0.4.6's three roles at 80% of their cost.
- The rating, by the same model that reviewed, changed the level of 22 of the
  102 findings that match a reference issue but the inline decision of only
  4, two of them rightly (inline F1 91.0 before, 90.9 after; reference high
  or medium issues labelled low 4 and 5 of 85). That is what the research
  page found for a model whose scale is sound: the rating makes no measurable
  difference there, at US$0.005 per pull request.

The duplicate check was also replayed with the candidate on the stored
reviewer findings of the three development runs of the research page, which
had been replayed with a build that split a file's findings into batches of
15. Without batches: 684 of the 695 stored merge groups unchanged (98.4%,
against 98.7% with batches), 1.5% more findings kept, the wrong merge of
three places in one workflow file kept apart, no merge refused, no check
failed, and no further reference issue lost.

Cost of these runs at list prices: US$6.10 (the benchmark run 2.94, the
replays 3.05, the single review 0.11).

### Limits of this candidate

- One run of the candidate with real models, with one model; the rows it is
  compared with are one run each as well. The local judge, not
  ReviewBench's: none of the public benchmark numbers of the README was
  measured anew.
- The passes of different models, the two-pass deep default and the rating
  by a different model were measured with the development builds, not with
  the candidate.
- The host fixtures prove orchestration with fake models, not review quality;
  the terminal fixtures read the screen of one terminal size.
- An update of settings of 0.4.x was checked with fixtures and fake services;
  no live settings file was updated.

## One pipeline: passes instead of roles (2026-11-22 and 23)

0.5.0 replaces the two reviewer roles and the verifier with independent
passes of one reviewer prompt, a duplicate check across reviewer sessions and
a severity rating. These are the runs that decision rests on. They are
development measurements scored by our own judge: none is a leaderboard
result, and no benchmark's own judge scored any of them.

**Setup.** ReviewBench's test set, 24 of its 25 pull requests: one
(`simnaut/emdash#2`) was left out of every comparison after a single
configuration needed an hour for it. OpenCode 2.3.2 with an isolated profile
and a Git-backed stand-in for Azure DevOps that serves each PR's commits, as
in the earlier ReviewBench runs. Models: GPT-6 Luna, GPT-6.1 Terra and
GPT-6.2 Sol at their default reasoning effort unless a variant is named, and
Claude Sonnet 5.5 at medium effort through OpenCode's `claude-agent`
provider. The pipeline with a verifier ran as AZPR 0.4.6. The new one ran as
development builds of this change: one reviewer prompt (0.4.6's quick prompt
with the guidance paragraphs of the two roles), N passes per shard, a
duplicate check per file and no rating; later builds added a model per pass
and a rating that was only recorded. The release candidate's own run is under
[0.5.0 release candidate acceptance](#050-release-candidate-acceptance-2026-11-23).

**Judge and measures.** The local judge of the earlier ReviewBench pages:
Claude Opus 5.5 subagents applying ReviewBench's matcher and classifier
rubric. *Reference recall* is the share of the reference issues that a run's
findings matched, *high and medium recall* the same for the reference issues
of those levels, and *judged valid* the share of a run's findings that
matched a reference issue or were rated valid against the code. GPT-6.2 Sol
files about 25 findings per PR, so its findings without a match were sampled
for classification (120 to 170 per run); its valid shares are estimates,
within about 6 points. Costs are list prices from the token records. Each
configuration ran once; single Terra passes differed by 0.4 to 0.8 points of
reference recall.

### What the verifier did

The same model in all three roles of 0.4.6's `/pr-review`:

| Model | Reviewers' candidates | Rejected by the verifier | Added by the verifier | Findings | Judged valid | Reference recall | Verifier's share of cost | Time per PR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-6.1 Terra | 280 | 0 | 5 | 174 | 90.2% | 29.5 | 30% | 94 s, 42 of them verifying |
| GPT-6.2 Sol | 1,185 | 3 | 98 | 819 | about 74% | 50.6 | 54% | 369 s, 151 of them verifying |

The two reviewers' findings without any verification, after a duplicate
check, were 170 findings at 90.0% and recall 29.2 for Terra, and 728 at about
73% and 48.6 for Sol. So a verifier of the reviewers' own strength rejected
almost nothing; what it contributed was its own additions (0.3 and 2.0 points
of recall), which no stage checked and which were reported as verified.

A verifier stronger than the reviewers did filter, where the reviewers were
weak. With GPT-6 Luna as both reviewers, a Terra verifier raised the valid
share from 59% to 89% and a Sol verifier from 62% to 88%, rejecting about 20
findings each, of which 83% to 90% were rightly rejected. With Terra as the
reviewers, whose findings were about 90% valid already, a Sol verifier
rejected 3 of them, two wrongly, and added 173 findings of its own: the valid
share fell from 89.5% to 86.5% and the review cost 2.3 times as much. The
same money spent on the stronger model as a reviewer bought more: one Terra
pass cost about US$0.06 per PR and reached a reference recall of 25, against
13.4 for Luna reviewers with a Terra verifier at US$0.05.

**What 0.5.0 gives up with the verifier:** those additions; the filter for
reviewers whose own findings often do not hold, for which the answer is now a
better reviewer model; and the verifier's rewrite of each finding. To size
the last one, 104 pairs of a reviewer's text and the verifier's version of
the same finding were judged blind (two versions in random order, against the
code): the verifier moved a finding to a correct place that its reviewer had
missed in 0 of 169 Terra findings and 6 of 721 Sol findings, and its wording
was the better one in about one Sol finding in eight and in no measurable
share of Terra's. The wording comparison rests on small samples: for Sol,
38 pairs stand for the 692 findings whose place had not moved or still
overlapped. No step was added for either.

### Passes of one prompt

| Configuration | Findings per PR | Judged valid | Reference recall | High and medium recall | Cost per PR | Time per PR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.4.6, Terra in three roles | 7.3 | 90.2% | 29.5 | 50.3 | US$0.15 | 94 s |
| Terra, two passes | 7.5 | 91.1% | 29.2 | 48.5 | US$0.13 | 73 s |
| Terra, four passes | 7.8 | about 89% | 30.6 | 52.7 | US$0.23 | 73 s |
| 0.4.6, Sol in three roles | 34.1 | about 74% | 50.6 | 59.9 | US$1.30 | 369 s |
| Sol, two passes | 27.7 | about 86% | 47.7 | 58.1 | US$0.72 | 257 s |
| Terra and Claude Sonnet 5.5, one pass each | 7.3 | 93.7% | 35.0 | 52.1 | US$0.22 | 58 s |
| Claude Sonnet 5.5, two passes | 5.1 | 91.9% | 28.6 | 41.9 | US$0.38 | 53 s |

- Two passes of the one prompt matched Terra's three roles within the
  variation between runs, at 87% of the cost and 78% of the time. With Sol
  the new pipeline reported fewer findings and a larger share of them was
  valid (about 3.7 invalid findings per PR against about 9), for 2.9 points
  less reference recall, 55% of the cost and 70% of the time.
- A single pass of the one prompt found slightly less than a single role
  reviewer (Terra 25.4 against 26.6; Sol 44.5 against 46.1) and, with Sol,
  far more of it was valid (about 85% against 76%): the prompt keeps the
  quick prompt's rule that a reviewer checks each finding against the source
  before filing it, which the role prompts left to the verifier.
- From seven single Terra passes, the union before the duplicate check
  reached 25.4, 28.8, 30.6 and 31.8 points of reference recall with one to
  four passes: the second pass adds about 13%, the third 6%, the fourth 4%.
  The valid share of what is reported fell slightly with more passes (about
  92%, 91% and 89% at one, two and four), because a later pass mostly adds
  findings that only it reports. Passes run side by side, so four took as
  long as two.
- Passes of two vendors' models found more than passes of one: Terra and
  Sonnet together reached 35.0, against 29.2 and 28.6 for two passes of
  either and 30.6 for four Terra passes, at 93.7% valid.
- Whether several passes reported a finding did not tell valid findings from
  invalid ones at two passes (92% against 89% for Terra), so nothing is
  dropped for being reported once, and the rating is not told.

Reasoning effort, one pass each: Luna at its default effort reasoned for
about 200 tokens per session and filed 1.5 findings per PR (reference recall
9.2); at `xhigh` it filed 6.5 (23.1) and took 405 seconds per PR instead
of 33. Terra's `medium` and `high` changed nothing measurable; its `xhigh`
(29.8, 102 s) was worth about a second pass.

### The duplicate check

In four pilot runs the duplicate check merged 1,064 findings. Of the 558
merged findings that matched a reference issue, 556 were merged into a
finding that matched the same issue; two reference issues were lost. It took
5% to 14% of a run's cost.

Reading the 47 merges whose two findings lay on lines that do not overlap
showed 41 that were one defect placed at different lines and 6 that were the
same kind of mistake at several places (three steps of one workflow file,
five `break` statements of one function), which AZPR treats as one finding
per place. The check was then replayed on the stored reviewer findings of
three runs with Terra and Sol (695 merge groups) with four variants of its
instructions:

| Variant | The two wrongly merged Terra findings | Groups unchanged | Findings left | Sound merges across lines kept (of 39) |
| --- | --- | ---: | ---: | ---: |
| 0.4.6's rule, run again | merged again | 99.3% | +0.2% | 37 |
| The rule rewritten around "one change fixes both" | apart | 96.5% | +3.2% | 31 |
| **0.4.6's rule plus one sentence** (released) | apart | 98.7% | +1.1% | 37 |
| Merging only findings on overlapping lines, enforced | apart | 91% (two runs) | +7% | 0 of 26 |

The released sentence is "The same kind of mistake made at several places,
each needing its own change, is several findings, however alike their texts
are." Feeding one PR's stored findings in two random orders gave identical
requests, so the check does not depend on which session finished first. In
the 1,064 merges no two findings of one reviewer session had been merged
with each other; the release refuses such a merge in the program, which on
these runs would have changed nothing. The replays ran on a build that also
split a file's findings into batches of 15; the release does not, since the
control showed no effect of it.

### The rating without the earlier level

117 findings of one mixed run (Terra and Sonnet, one pass each) that matched
a reference issue were rated again by three models that saw the finding's
text and not its level. The inline decision is whether a finding is high or
medium, and so gets an inline comment, or low:

| Level set by | Level equal to the reference | Inline decision (F1) | Reference high or medium issues labelled low |
| --- | ---: | ---: | ---: |
| The reviewers themselves | 63.2% | 87.0 | 12 of 89 |
| Terra | 68.4% | 89.4 | 9 of 89 |
| GPT-6.2 Sol | 61.5% | 90.1 | 7 of 89 |
| Claude Sonnet 5.5 | 65.8% | 87.9 | 13 of 89 |

The models scale severity differently: of the reference's high and medium
issues, Sonnet labelled about a third low in its own findings (10 of 28
here, 21 of 66 in two runs of its own), Terra 2.5% to 4.5% and Sol 7.5%. On
the 44 findings Sonnet wrote, its own blind rating raised the inline F1 from
75.0 to 82.4, Terra's to 84.0 and Sol's to 88.9; on the 73 Terra wrote
(91.5), Terra's rating changed no inline decision, and Sonnet's lowered it
to 90.2. Each rater changed 6 to 10 of the 117 inline decisions (Terra 5
right and 1 wrong, Sol 6 and 1, Sonnet 6 and 4), so this run alone is weak
evidence: Terra's 5 to 1 is within chance (sign test, p = 0.22). The rating
is on by default because three observations point the same way (this run,
Sonnet's second run, and 0.3.7's measurement that a verifier that did not see
the reviewer's level raised the inline F1 from 65.5 to 83.0), it cost
US$0.005 to 0.018 and 6 to 14 seconds per PR, and it did not harm the model
that rated well. A model that underrates lowers other models' findings too,
which is why the first entry of a list, or the named rater, matters.

### Limits

- One benchmark, 24 pull requests with about 14 reference issues each, which
  are larger and hold more issues than most pull requests. One run per
  configuration.
- Our judge, not ReviewBench's; the same judge and procedure for every row,
  so rows compare with each other and not with a leaderboard. The labels of
  the 47 merges across lines are our own reading.
- GPT models of three strengths and one Claude model. Nothing here was
  measured with Claude Opus, the model of the README's benchmark results.
- The pilot builds are not the release: their reviewer prompt was edited
  into the released `review.md`, the duplicate check was regrouped by side
  and file, and the rating was switched on. The acceptance section has one
  run of the release candidate.
- A session of a `claude-agent` model keeps a local process of about 215 MB
  until the OpenCode process ends (OpenCode 2.3.2). A Sonnet run with four
  PRs at a time exhausted the 8 GB of the test machine; the rest of the
  Sonnet runs used a new host process for every one to six PRs. (Correction of 2026-11-26: the process ends five minutes after the session's last turn, not when the host exits; on 2.3.2 deleting the session does not end it earlier. See [the comparison of the hosts](#opencode-231-to-241-compared-with-230-2026-11-24-to-26).)

## 0.4.6 after publication (2026-11-21)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.0 and tmux 3.2a, in isolated OpenCode profiles with the fake model and
Azure DevOps services.

- **The merged tree.** The pull request was merged with a merge commit whose
  tree is that of the candidate's last commit. CI passed on that commit, on
  `main` and on the tag. The three commits after the thirteenth review change
  this page only; the code and tests are those of the tree that review read
  and that the eleven host fixture runs passed on.
- **Before the tag.** On the candidate's last commit: the source archive
  passed the clean-directory installation check, the package built from a
  clean export holds 38 files, all 309 local links and images of the 50
  Markdown files resolve, and the public Git commit, installed by OpenCode's
  plugin manager, passed the native smoke, terminal panel and setup fixtures.
- **Source archives.** The release's source archive, downloaded again, is
  byte-identical to the one built from the tag, and so is GitHub's own archive
  of the tag. Both passed the clean-directory installation check: 23 runtime
  modules, 9 prompts and the license as in the archive, the view's JSX source
  not installed, and `--replace` keeping the settings file byte for byte.
- **The Git package.** `github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.4.6`,
  installed by OpenCode's plugin manager, passed the native smoke fixture
  (110 model and 194 Azure DevOps requests), the terminal panel's fixture
  (30 and 57, with one request of the conversation's model; four of its five
  previews start with a grouping pass) and the setup fixture (no model
  request, 16 Azure DevOps requests).
- **The npm package.** The registry's integrity and shasum for 0.4.6 equal
  those of the package built from the tag (38 files), which is the package
  built from the candidate before the merge; the tarball downloaded from the
  registry is byte-identical to it, and `latest` names 0.4.6. Installed from
  the registry, the package passed the same three fixtures with the same
  request counts.

The runs with real models were made with the candidate; see
[which findings share a comment](#with-real-models-which-findings-share-a-comment)
and [the public benchmark](#martians-code-review-bench-measured-again) for
them, and the [limits](#limits-of-this-candidate) for what was not verified.

## 0.4.6 release candidate acceptance (2026-11-21)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.0 and tmux 3.2a, with isolated OpenCode profiles and the fake model and
Azure DevOps services for the tests and host fixtures. Real models ran
afterwards, against a local stand-in for Azure DevOps
([which findings share a comment](#with-real-models-which-findings-share-a-comment),
[the public benchmark](#martians-code-review-bench-measured-again)); what
is left open is under [limits](#limits-of-this-candidate).

0.4.6 lets one inline comment hold one defect that a pull request makes at
several places (see
[one defect at several places](COMMENTING.md#one-defect-at-several-places)).
`comment-work.mjs` settles before the planning pages which findings may be
such repeats, with a grouping pass when there are several pages, and reads
the list of places back from AZPR's own comments on the PR for a later plan.
`comments.mjs` checks the groups and the comments that combine them, gives
a shared comment a marker of its own, and keeps a shared comment and a
comment for one place off each other's quoted lines when planning;
`attribution.mjs` renders the list of other places and reads it back, and
`runtime.mjs` labels the grouping pass's stage and gives it a checkpoint text
of its own. Publication (`publishPlan`) is unchanged but for one count: the
other AZPR comments of a PR are counted by thread (`threadMarkers` in
`azure.mjs`), not by marker. Of the
prompts, `comment-plan.md` and `comment-policy.md` changed. The hash test
holds the system prompts of the six review roles in two configurations
(shell denied with English output, shell on request with Traditional Chinese
output): the two hashes of the comment-plan role changed, and the ten of the
reviewers, the verifier, the duplicate check and the rating are as for
0.4.5. The deep roles are compared with the review roles and are identical
to them; the quick planner gets the same new instructions and is checked for
its wording, not by a hash. No setting and no file of the package is new.

### Offline

`npm run check` passes, and `npm test` runs 686 tests (654 for 0.4.5), all
passing.

| Tests | What they establish |
| ---: | --- |
| 10 | The rules (`tests/comments.test.mjs`): a comment that names several findings of a listed group stands at the one finding whose lines its anchor touches and carries the others as places, in the order of the page, whatever order the planner wrote; nothing is combined unless the planner says so. A combination is refused outside a listed group, across two groups, without a reason, across severities, for findings on the same lines, for lines that end before they begin, for a file name a list cannot hold as it is, for a place that is not on lines of a changed file as the runtime read it at HEAD (an unchanged file, a line beyond the file's end, a file the page could not read), when the anchor touches no member's lines and when it reaches from one member's lines into another's (one that reaches beyond a single finding's lines still stands at that finding); after the correction turns it is dropped and every finding it named is skipped with that reason. A shared comment's quote must be found in the HEAD text also in a verified review (a quote of a line the file does not have is refused; one found at other lines is moved there; one that adds a blank line after the file's last line is refused as reaching past its end), while a single comment keeps its declared lines as before. A quick review keeps both kinds apart (the same lines twice, and several places). A planner's text that holds the heading of the list of other places is sent back and then not planned, in a comment for several places and in one for one place, however the heading is indented, quoted or continued. A shared comment whose text leaves a block open that would take the list in is sent back and then not planned: a code fence without its closing fence at the top level, or raw HTML that waits for its own end (`<pre>`, `<script>`, `<?…`, `<!…`, CDATA). The test holds 22 texts that are sent back and 27 that are not: a fence in a list item or a quote ends with it, a fence line after it stands at the top level (an unindented one under an item, one indented less than the item's text, one after a quote), a paragraph is interrupted only by some list items, raw HTML that ends at a blank line holds a fence line as text (a line that is one whole tag starts it, `<pre/>` too), a tag in code or within a sentence opens nothing, and a line ends at a line feed or a carriage return only (U+2028 is a character of its line). A comment for one place with an open fence is planned as before. The assembled text is the planner's text, the list, the attribution and the comment's two markers, in English and Chinese; each place keeps its row and its count in the summary index; and automatic publication holds nothing of the list's own markup. A shared comment's own marker follows its file, its quoted lines and its other places, whatever order the planner names the findings in; other places, another quote or another file give another one, and so does the second of two defects at the same places, whose comments quote the same line and list the same place; what a marker is made of is kept apart (a quote of two lines is not a quote of one line with a place listed); its second marker follows the file and the quoted lines only; and the markers of comments for one place and the summary's are as before, whichever kind comes first in the plan. A shared comment on quoted lines that already carry a comment of AZPR's is refused with the thread and the ways out: a comment for one place (also when the first comment of those lines is gone and a later one is there) or a shared comment with other places; it is accepted when the PR has this very comment or its twin, when it stands at another place, next to a comment of the same plan on those lines, and when the PR's comments are unknown. The other way round, a comment for one place on quoted lines that carry a shared comment is sent back and then skipped with that reason, unless a comment for one place is there as well. After the correction turns a refused shared comment is dropped and its findings are skipped with that reason. The grouping pass's answer is checked by the same rules: unknown findings, a finding in two groups, mixed severities and findings on the same lines are reported, then dropped; a status other than READY, or none, is sent back, and so are an answer without `groups` and an entry whose findings are no list (a string, another field); after the correction turns the groups it named stand, and what was malformed counts as none. |
| 16 | Planning and publication (`tests/comment-work.test.mjs`): which findings are eligible (high and medium, on lines of a changed HEAD file, with a place a list can hold, not already a quick merge candidate) and which sets can hold a repeat (one severity, two places or more). Only a place whose lines the file has at HEAD is offered: a finding beyond the file's end or on a file that cannot be read is planned alone, on one page and in the pass's input, and without the files' text nothing is offered. Those files are read before the pages, each once, in the order of the findings and never more at a time than pages are planned (one, two or three). On one page the sets are offered without a grouping pass and the page keeps its order; findings that share lines are offered nothing, and their planning input is as before. With several pages one pass runs first, sees only the findings that fit a page together with another one of their severity at a different place (not a finding longer than a page, nor the only one of its severity, for which no file is read ahead either), and its group shares a page of five findings; a pass that finds nothing leaves the pages exactly as without it. No pass is asked where no two findings of a set fit one page together (two findings with 6,500 characters of evidence each), and no file is then read ahead of the pages; one is asked once a shorter third makes a pair. The pass reads its findings inline: 40 findings with long evidence go without the evidence, and a list too long even then is not grouped, with a notice. The pass gets two correction turns like a page, and a group that stays wrong is dropped. A pass that fails costs only the grouping, with a progress notice; a stopped run starts no page, one stopped while the files are read ahead of the pages reads no further file and asks no pass, and one stopped while the pass was ending prepares no page. A group larger than a page's text is planned in parts of two or more findings, none larger than a page; a long finding is planned alone. A page continued in a new session is offered what is open of a group while two of its findings at different places are. A shared comment planned onto lines that already carry a comment of AZPR's goes back to the planner, which moves it; once that comment is on the PR, the same plan made again is that very comment and nothing is sent back. At publication a shared comment is another comment than one for its place alone: it is posted in full next to it, the earlier comment is as it was, and the receipt has the usual row; published again it is found by its own marker, and its attempt record is under that marker alone; other places give another marker and the same places the same one in any order; with a person's adjustments the other AZPR comments of the PR are counted by thread, so a shared comment with its two markers is one, a reply that quotes another thread's marker hides no thread, and the count does not depend on the order of the threads; two defects at the same places are two threads; and with the shared comment on the PR, a plan that comments on its place alone is sent back and then skips that finding. The list is read back only in the runtime's form (its heading as a line, rows of a place and a finding ID directly under it, and after them the comment's two markers, or a rule, the attribution's line and the two markers, with nothing in between; CRLF; the last heading when a text quotes a list): a single marker, a third one, a row that writing its place and ID again under that heading does not give to the character (another ID, no lines, lines out of order, two code spans, other spacing, the other language's brackets, anything after the row), an attribution that is not the whole line the runtime writes (a sentence before or after the models, a code span that is no model reference as settings take one: a sentence, a placeholder, an overlong name), or a comment continued after its attribution reads as no list; every listable place reads back as written, whatever its file is called, in three languages, and so does what `commentAttribution` writes for a verified and a quick review in each language. In a thread the list is read only from the comment that opened it, wherever that comment stands among the thread's comments, not from a reply that quotes one; the thread's author and excerpt are that comment's too, so the places never stand next to the words of a reply. The opener is comment 1 of its thread, as publication takes it: when it is gone, the thread is described by the first comment left, as before, and no later comment's list is read, whatever that comment says of its parent. |
| 1 | The list (`tests/attribution.test.mjs`): one row per place with its ID, in English, Traditional and Simplified Chinese; a path stays inside its code span whatever characters it holds; nothing is collapsed or linked. |
| 5 | The runtime (`tests/runtime.test.mjs`): a review whose reviewers report one defect in three files plans its comments with a grouping stage of its own (titled "Comment plan grouping") and two pages; the preview shows one comment for the three places with the two others listed, four inline comments instead of six and six rows in the index; `/pr-comment --publish` posts that text, and the receipt names the three findings of the shared thread. A preview's shared comment, with a comment for its place alone posted meanwhile on the same lines: publication leaves that comment as it is and posts the shared one in full, as a comment of its own; planned again it has the same marker, no correction turn is taken, and its publication finds it (`ALREADY_PRESENT`, nothing posted twice). A plan that combines three findings while the PR already has AZPR's comment for the first place: the page is sent back once with that thread named, the comment stands at the second place, and its publication adds one thread there. A grouping pass that takes twelve model requests gets a thirteenth without tools and the instruction to return READY with its groups, where a page is told to return READY or CONTINUE. A grouping pass that the provider refuses leaves a preview of six separate comments and a FAILED stage; `/pr-stop` during the pass ends the run as CANCELLED, with the pass's session interrupted, no page session made and no "grouping failed" notice. |

The other changed expectations are in existing tests: the two comment-plan
prompt hashes (`tests/config.test.mjs`), the message for a combination outside
a listed group, three runtime tests whose reviews now run a grouping pass
before their pages, and two planning tests about pages that run side by side,
whose findings now have severities that rule a shared comment out, so that
the reads they order are the pages' own (a wait that runs out there now fails
the test).

Whether a shared comment's text leaves a block open is decided by reading its
lines (`openBlock`). That reading was also compared, outside the repository,
with two Markdown parsers: commonmark.js 0.31.2 and markdown-it 14.1.0 (HTML
on), on Node.js 22.23.3. Each of 730,216 generated texts (one to seven lines
drawn from 58 to 132 forms of line: fences, list items, quotes, raw HTML,
headings, tabs) was followed by the list of other places and parsed, and the
list counted as taken in when it was not a paragraph followed by a list at
the top level. The reading agreed with commonmark.js on all but 13 texts:
eight with a list nested in a list item, which the reading takes as that
item's text, and five with a link reference definition, where the two
parsers disagree with each other (on 228 texts in all). The 49 texts of the
test are as both parsers read them. The package has no dependency, so this
comparison is not part of `npm test`, and it says how these two parsers read
a text, not how Azure DevOps renders it.

### On the real host

The eleven host fixture runs passed on one tree (the hash of the code and
tests was the same before and after).

- **One defect in three files, at scale** (`tests/host-v2-comment-scale.mjs`,
  with debug on and off). The review of 120 files leaves 29 findings: 19
  high ones in different files and 10 low ones. Their plan has eight pages,
  so a grouping pass runs first, in a session of its own; the fake planner
  answers that the first three high findings are one lost guard in three
  files. The three share a page and one comment. Publication creates 18
  threads where 0.4.5 created 20: 17 inline comments and the summary. The
  shared thread stands at the first finding's file and lists the two other
  files with their lines and finding IDs; the receipt names the three
  findings together; and each of them still has its row in the summary
  index. A second publish writes nothing. The run made 35 model requests
  (34 for 0.4.5: the pass) and 73 Azure DevOps requests (75: two threads
  fewer), with at most two planning pages in flight. With debug off, the
  planner's sessions, the pass's included, are gone when the preview's run
  ends, and the host lists the report session alone (35 model and 69 Azure
  DevOps requests).
- **The terminal panel** (`tests/host-v2-tui-panel.mjs`, from source and as
  the package). It plans five previews. Four of them have two pages and high
  findings in several files, so each now starts with a grouping pass, which
  finds nothing there; the fifth, after two findings were left out, fits one
  page and has none. The panel lists a pass's session like a page's, and
  every step of the fixture passes as for 0.4.5. The runs made 30 model
  requests by AZPR's sessions (26 for 0.4.5: the four passes), 57 Azure
  DevOps requests and still exactly 1 request of the conversation's own
  model.
- **Unchanged**: setup no model request and 16 Azure DevOps requests; smoke
  fresh 110 model and 194 Azure DevOps requests, replacement 92 and 164,
  native 110 and 201; and background compaction 8 model requests in both
  runs, all as for 0.4.5. The smoke fixtures plan comments for a single
  finding on one page, so no pass runs there; the setup fixtures run setup
  and `/pr-check`, and the background-compaction fixtures only `/pr-review`,
  so neither plans a comment at all.

`npm pack --dry-run` lists 38 files, as for 0.4.5. `package.json` has no
dependency and no lifecycle script.

### Reviews by a second model

The pull request was reviewed thirteen times by a second model (GPT-6.2 Astra
at its highest reasoning effort through the Codex CLI 0.171.0, in a read-only
sandbox on a clean clone; its instructions were the change and its purpose,
not the results of the checks above). Each commit after the first corrects
what the review before it reported, and each was reviewed again. The reviewer
ran the build check and the tests that write nothing; the tests that write
files and the eleven host fixture runs ran here, on every tree. The reviews
reported 13, 12, 7, 11, 9, 12, 8, 6, 5, 4, 3, 5 and 4 points.

One question took three designs. The first review found the one serious
defect of the first commit: publication skipped a shared comment whose marker
the pull request already had, and the receipt counted every finding of it as
posted, also when the comment found there was an earlier one for that place
alone.

1. The first answer worked out, from the comment found under the marker,
   which places it listed, and reported the rest. Each of the next four
   reviews found another path on which that inference said more than the pull
   request held: a marker found in a reply, a list that someone had edited, a
   comment deleted while publication ran, a record written before the answer.
2. The second answer gave a shared comment a marker of its own next to the
   marker of its place. The second marker then had to be kept in step with
   the counts of comments on the same lines and with the records of attempts,
   and two reviews found where it was not.
3. As it stands since the eighth commit, a shared comment is known to
   publication by its own marker alone, publication is that of 0.4.5 but for
   one count, and the two kinds of comment are kept off each other's quoted
   lines when planning. The six reviews of this design reported 6, 5, 4, 3, 5
   and 4 points, and the last one found no duplicate write and no false
   receipt in the publication path.

The other corrections that stand:

- A place is checked against the file as the runtime reads it at the reviewed
  commit, when findings are offered and again on the page; the anchor of a
  shared comment must be found in that text, end within the file and touch
  the lines of one finding only.
- The list is read back only from the comment that opened a thread (its
  comment 1), and only in the very form the runtime writes: rows that write
  back as they stand, the whole attribution line, the two markers. The
  thread's author and excerpt are that comment's too.
- A planner's text may not hold the list's heading, and a shared comment's
  text may not end inside a code fence or a raw HTML block.
- A page that continues in a new session keeps what is open of its groups,
  and a group cut to a page's text never exceeds a page.
- The grouping pass has an answer of its own form (an explicit READY, a list
  of groups, entries that are lists) and a checkpoint text of its own; it
  reads its findings inline, and is asked only about findings that could
  share a page with another one.
- The files read ahead of the pages are read a few at a time and not at all
  once the run was stopped; a stop while the pass is ending prepares no page.
- With a person's adjustments, the other AZPR comments of a pull request are
  counted by thread.
- Several statements of this record and of the documentation were narrowed
  to what was run.

Left as they are, and stated under the limits below: a marker holds no line
numbers, comments that quote the same lines are told apart by their order in
the plan, a marker counts wherever a live comment holds it, thread positions
are not compared, and of two defects at the same places the second passes the
rule that keeps comments off occupied lines. One point of the twelfth review
was not taken: a line that holds `<pre/>` alone starts raw HTML in both
parsers the reading of blocks was compared with, whatever the wording of the
specification.

The thirteenth review reported four points that change nothing a pull request
gets, so the tree it reviewed is the one that stands; the commit after it
adds this record only.

- `listablePlace` would admit a file name with a colon, which `listedPlaces`
  does not read back. No such place is listed: a finding's location is not
  read with a colon in its path, as in every earlier version, where such a
  finding has no inline comment either.
- A thread listed without its comment 1, in which a later comment names no
  parent, would have that comment's list read. Azure DevOps keeps a deleted
  comment in the listing, and that case is handled.
- On a single page, the file of a finding without a partner is read ahead of
  the page with the others. It is the read the page makes anyway.
- The planner's policy states the shared comment as a rule, where the page's
  instructions give its conditions and the runtime holds them.

### With real models: which findings share a comment

After the reviews above, the candidate planned comments with real models, in
three runs on public pull requests: OpenCode 2.3.0 in a profile of its own,
the package built from the tree named below, and the benchmark harness's
local service in the place of Azure DevOps, which serves each pull request's
real files at its commits. Each task reviewed one pull request and then
planned its comments; nothing was posted. The shared comments and the
findings they hold were read one by one by the author of this change. No
benchmark judge took part in that reading.

| | `/pr-review`, `openai/gpt-6-luna` | `/pr-deep`, `openai/gpt-6.1-sol` | `/pr-deep`, `claude-agent/opus#medium` |
| --- | --- | --- | --- |
| Tree | `2cee3dd` | `f6a3d8a` | `d7b5ab3` |
| Pull requests | 8 | 4 of those 8 | the 50 of Martian's Code Review Bench |
| Reviews | 8 COMPLETE, 24 findings | 4 COMPLETE, 37 findings | 50 COMPLETE, 341 findings |
| Grouping passes, one request each | 1 | 2 | 23 |
| Shared comments | 2, of 2 findings each | 3, of 2, 2 and 3 findings | 7, of 16 findings |
| Shared comments that held different defects | 0 | 0 | 0 |
| Correction turns that a rule of the shared comment caused | 0 | 0 | 0 |
| Clear repeats that got a comment each | 1 | none found | not looked for |

The eight pull requests are those of the benchmark's 50 where an earlier run
had reported the most findings with a common cause: calcom/cal.com 11059,
10967, 8087 and 7232, keycloak/keycloak 37038, 37634 and 37429, and
grafana/grafana 107534. The three trees differ in what the reviews by a
second model corrected, not in the planner's instructions for a shared
comment.

- **What was combined.** In cal.com 11059 GPT-6 Luna and GPT-6.1 Sol each
  gave one comment to the two Zoho adapters that read a Fetch response as an
  Axios response. Luna also combined the two Lithuanian message files of
  keycloak 37429 that hold Italian text. Sol combined the two query-splitting
  paths of grafana 107534 that apply filters before a second interpolation,
  and the three reschedule implementations of cal.com 8087 that discard the
  promises of an asynchronous `forEach` callback, while it left a fourth
  finding of that page, whose correction differs, on its own. Claude Opus 5.5
  combined, among others, three calls that cancel a reminder at once
  (cal.com 7232), the update and the delete of one calendar adapter that
  share a fallback which never matches (cal.com 10967), a desktop and a
  mobile stylesheet with the same slip, and the background writes of Create,
  Delete and Update that inherit a request's cancellation (grafana 90045).
  Its 50 previews hold 147 inline comments where a comment per place would
  have made 156; 39 correction turns were for a text over the length limit,
  2 of them texts of shared comments.
- **What was left apart.** For the three implementations of cal.com 8087,
  Luna wrote three comments with nearly the same text, although the page
  listed them as possible repeats. Two variants of the instructions were
  then tried with Luna on the same eight pull requests, outside this tree: a
  sentence that names such comments as the case for one comment, and a
  grouping pass also where all findings fit one page. Neither made it
  combine them, and neither is part of this release. How often repeats share
  a comment therefore depends on the planner's model, which is the one of
  the risk reviewer (`models.<mode>.risk`).
- **What this does not show.** These are 62 reviews read by one person, of
  pull requests that are public and partly chosen for their repeats: no rate
  of wrong or missed combinations follows from them. Publication was not
  part of these runs, and neither was a later plan on a pull request that
  already has a shared comment.

### Martian's Code Review Bench, measured again

The figures of the [public benchmark](#martian-code-review-bench-2026-11-05-and-06)
are those of 0.3.5, and two releases since changed what the reviewers and the
verifier are told (0.3.6 and 0.3.7; this candidate changes comment planning
only). So the benchmark was run once more with this candidate, in the same
way.

- **Review.** On 2026-11-21, the tree `d7b5ab3` of this candidate (its code is
  that of `bae12e7`), packed as the npm package is, on OpenCode 2.3.0. Every
  pull request ran `/pr-deep` with `claude-agent/opus#medium` for all three
  roles (Claude Code CLI 2.1.314, the version of 2026-11-05), four pull
  requests at a time, with English output, against the same 50 pull requests
  at the same commits and the same local implementation of the Azure DevOps
  calls. All 50 reviews were COMPLETE; the run took about an hour, the median
  review 156 seconds and the longest 323. They hold 341 confirmed findings:
  26 high, 133 medium and 182 low (0.3.5: 323, of them 30, 81 and 212).
- **Scoring.** As on 2026-11-06: each confirmed finding is one inline comment
  with its summary, evidence and suggested fix, scored by the benchmark's
  pipeline at commit `e616e84` and the dashboard's judge, Claude Opus 4.5
  (`claude-opus-4-5-20251101`, temperature 0), through Anthropic's
  OpenAI-compatible endpoint. The pipeline reported no error.

| Core golden comments, one run each | Comments | Issues per PR | Precision | Recall | F2 | High and Critical recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AZPR 0.3.5 (2026-11-06) | 323 | 7.6 | 30.0 | 67.7 | 54.1 | 74.2 |
| This candidate (2026-11-21) | 341 | 8.1 | 27.2 | 67.1 | 51.9 | 75.8 |

The candidate matched 106 of the 158 core golden comments (0.3.5: 107) and 50
of the 66 High and Critical ones (49); 283 extracted issues matched no golden
comment (250). On the dashboard's default view that is still the highest
recall of its 21 tools, by one golden comment (copilot-v2 66.5), now the
highest High and Critical recall alone (qodo-extended-v2 and augment 74.2),
and the eighth F2 instead of the sixth: after gemini-v2 (52.8) and gitlab
(52.7), ahead of sourcery (51.5).

What this shows and what it does not:

- **No measurable change in what is found.** With 158 golden comments one
  run's recall has a sampling error of about 3.7 points and its precision of
  about 2.3, so neither figure differs from that of 0.3.5 by more than one
  run does from the next. The benchmark does not show these releases finding
  more or less of its list.
- **More findings, the same matches.** The candidate files 18 more findings
  and labels more of them medium, as 0.3.7's severity rules intend. The
  benchmark's precision counts every issue outside its list, accurate or
  not, so more findings with the same matches lower it. Medium findings did
  not match the list more often than low ones: by the finding each issue
  most resembles, 45% of the issues from high findings were counted as
  matched, 26% of those from medium ones and 31% of those from low ones.
- **Where the additional unmatched issues come from.** The reviewers filed
  572 candidates (563), and the verifier merged 216 of them into others as
  duplicates (227) and confirmed 342 (323). Sorted by what a finding's
  summary says, again by the finding each issue most resembles: 26 findings
  ask whether a behavior is intended, as the instructions since 0.3.6 tell
  the reviewers to do instead of leaving such a finding out, where the 0.3.5
  run has none; their issues are 7 matched and 24 unmatched ones. Findings
  about documentation rose from 7 to 13, with 12 more unmatched issues. For
  the other findings the number of unmatched issues is as it was (244 and
  241). The questions are not noise for this benchmark: counting the
  recorded verdicts without them gives precision 27.9 and recall 63.3, so
  they hold six of the matched golden comments.
- **The change of this candidate is not in the score.** The comments scored
  are the findings, one per place, as for 0.3.5. Each review of this run was
  also followed by a comment preview, which the score does not use: 147
  inline comments for the 156 high and medium findings with an inline
  location, 7 of them for several places (16 places), after 23 grouping
  passes of one request each. Scored as they would be posted, the shared
  comments could remove at most 9 of the 404 extracted issues.

**The benchmark's corrected counting.** On 2026-11-20 the benchmark changed
how its last step counts (pull request 75 of its repository, in `23a35d0` of
2026-11-21). An issue that the judge matched to a golden comment used to
count as unmatched when another issue already held a match of the same or a
higher confidence for that comment; now every issue the judge matched counts
as matched. The steps that extract issues and group duplicates are unchanged,
and the results the dashboard shows are those of 2026-08-30, counted the
earlier way, so the table above is the one that compares with the dashboard.

The candidate's issues were judged a second time with the corrected step,
with the judge's 1,694 verdicts recorded. Of the 283 unmatched issues, 17
are issues the judge had matched:

| This candidate, core golden comments | Precision | Recall | F2 | High and Critical recall |
| --- | ---: | ---: | ---: | ---: |
| Counted as the dashboard's results are | 27.2 | 67.1 | 51.9 | 75.8 |
| With the benchmark's corrected counting | 28.5 | 67.1 | 52.8 | 75.8 |

Counting the recorded verdicts the earlier way gives the first judging's
numbers exactly, and counting them the corrected way gives the pipeline's own
output, pull request by pull request. No other tool's results were counted
again, so the second row compares with nothing on the dashboard.

Limits: one run of one model combination; the judge model is scheduled for
retirement (not before 2026-11-24), after which these figures cannot be
reproduced with it; the pull requests are public ones of well-known
repositories; and the two judgings cost about US$31 at list prices, by our
estimate from the number of judged pairs.

### Limits of this candidate

- **A small sample with real models.** In the fixtures the fake planner
  groups what the fixture tells it to. With real models, no shared comment of
  [62 reviews](#with-real-models-which-findings-share-a-comment) combined
  different defects, as read by one person; how often a planner does, and
  how often it leaves repeats apart, is not a rate these runs give, and a
  weaker planner left clear repeats apart. The runtime cannot tell a
  well-formed but wrong combination; the preview shows each shared comment
  with its findings and the planner's reason, and each finding keeps its row.
- **The grouping pass is given finding text only**, not source; it has the
  planner's read-only tools, but its instructions say that it needs none.
  The page that writes the comment sees the source of every place and
  decides again.
- **One severity.** Places of one defect that were given different severities
  are not combined, and low findings have no inline comment to share.
- **Large groups.** A group larger than a page's text is planned in parts, so
  it gets a comment per part, each listing the places of its part.
- **One thread, several places.** A thread's status cannot say which of its
  places were fixed. A comment that was posted is never changed, so a place
  fixed later stays in its list.
- **Re-reviews.** A later plan is told which places a posted shared comment
  covers; whether a real planner then skips those places was not run.
- **A place is a file and its lines.** A shared comment's own marker takes
  its other places as written. After their lines moved, a later comment for
  the same defect is another comment than the one posted before, and it is
  planned away from the lines of the earlier one: this errs towards one more
  thread, never towards a finding without one.
- **A marker does not hold line numbers.** The same lines of text elsewhere
  in the same file share it, as for every comment since the first version,
  and comments that quote the same lines are told apart by their order in
  the plan. Thread positions are not compared, since they go stale when
  lines move.
- **Two kinds of comment on the same lines are kept apart at planning
  only.** A shared comment and a comment for one place do not find each
  other by marker, and the rule that keeps them off each other's quoted
  lines uses the threads read before planning. A comment that appears on the
  PR between a preview and its publication (also one that Azure DevOps has
  created but not listed yet), or threads that could not be read, leave the
  later comment to be posted next to the earlier one: one more thread, never
  a finding counted as posted that is not. And the rule lets a shared
  comment stand where the PR has a shared comment with the same file, quoted
  lines and other places: of two defects at the same places, whose comments
  differ by a count given only when the pages are assembled, the second
  passes too and is posted next to what is there.
- **The text above the list is the planner's Markdown.** The runtime checks
  only that it does not end inside a code fence or raw HTML that waits for
  its own end, as CommonMark reads blocks. What is nested inside a list item
  or a quote is read as its text, an inline tag that was left unclosed is
  not checked, and how Azure DevOps renders a text was not compared.

## 0.4.5 after publication (2026-11-20)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.0 and tmux 3.2a, in isolated OpenCode profiles with the fake model and
Azure DevOps services, except for the last item.

- **The merged tree.** The pull request was merged with a merge commit whose
  tree is that of the candidate's last commit. CI passed on that commit, on
  `main` and on the tag. That last commit adds the record of the reviews to
  this page and nothing else; the third review was of the tree before it.
- **Source archives.** The release's source archive, downloaded again, is
  byte-identical to the one built from the tag, and so is GitHub's own archive
  of the tag. Both passed the clean-directory installation check: 23 runtime
  modules, 9 prompts and the license as in the archive, the view's JSX source
  not installed, and `--replace` keeping the settings file byte for byte.
- **The Git package.** `github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.4.5`,
  installed by OpenCode's plugin manager, passed the native smoke fixture
  (110 model and 194 Azure DevOps requests), the terminal panel's fixture
  (26 and 57, with one request of the conversation's model) and the setup
  fixture (no model request, 16 Azure DevOps requests). In the terminal UI a
  review was stopped from the panel's foot: the step was clicked and
  declined, picked again with its key, the key pressed once more left no row
  of the question to take, and "Yes" ended the run `CANCELLED`.
- **The npm package.** The registry's integrity and shasum for 0.4.5 equal
  those of the package built from the tag (38 files), the tarball downloaded
  from the registry is byte-identical to it, and `latest` names 0.4.5.
  Installed from the registry, the package passed the same three fixtures
  with the same request counts.
- **On the maintainer's everyday service**, which runs the npm package since
  the release, the 38 installed files are those of the package built from the
  tag, and `/pr-check` of the 1-file test PR reported `READY` and named
  0.4.5; its `STARTED` notice carried the offer to stop the run, as data. No
  model ran.

The step that stops a run was used once on a run of a real model, with the
candidate, for the recording; see the acceptance below for that run and for
what was not verified.

## 0.4.5 release candidate acceptance (2026-11-20)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.0 and tmux 3.2a, with isolated OpenCode profiles and the fake model and
Azure DevOps services, except where a real model is named
([the recording](#with-a-real-model-a-review-stopped-from-the-panel-and-the-recording));
what 0.4.4 showed with a real model is in the next section.

0.4.5 lets the terminal panel offer to stop the run under way (see
[what can be done next](ARCHITECTURE.md#what-can-be-done-next)). Of the
server part, `runtime.mjs` sends the run's ID with its STARTED notice, as
metadata, and nothing else changed there. Of the terminal part,
`tui-model.mjs` reads that offer and checks it (`stopOf`), `tui-actions.mjs`
makes the step, its question and the `/pr-stop` command, and `tui-view.jsx`
binds its key, says of a run that has ended that it left nothing to show,
and draws the steps from their names, so that each keeps its element. No
prompt, no setting and no file of the package is new.

### Offline

`npm run check` passes, and `npm test` runs 654 tests (646 for 0.4.4),
all passing.

| Tests | What they establish |
| ---: | --- |
| 3 | The step (`tests/tui-actions.test.mjs`), with scripted dialogs: a run under way offers one step, with its key, which is not the step anything leads to; its command is `/pr-stop` with the run's ID and nothing else; stopping asks first with "No, let it run" first, names the run and its command, and sends nothing unless a person says yes; a review or a preview does not offer it, and a run under way offers nothing else; an answer for a run that ended while the question was open sends nothing and says so; a stop the server part refused is said with its reason; one action at a time; nothing is asked or sent after the part was unloaded. And what is typed into the question finds a row by the beginning of its title: with nothing typed both rows, the one that keeps the run first; `s`, typed once or more, and other stray letters find none; `y` and `n` find their rows; the question before posting answers the same way, and the lists of findings are searched as the host searches. |
| 1 | What the panel shows of it (`tests/tui-model.test.mjs`): the ID is taken only in its form and as the ID of the run the very notice starts; the offer holds from the STARTED notice until the run's receipt, whatever progress follows, with the same notice offering; every command that starts a run is named, and one the panel does not know is not; a notice of an earlier version, one that names another run and one that carries a preview's offer offer nothing; what the runtime answers to a stop is not the run's end; after any receipt nothing is stopped, and a review that no preview follows then offers its own steps; the comment run that follows a review is another run with a notice of its own; a run that starts after a preview takes the preview's steps away; in one of AZPR's own sessions the conversation's run and a run typed there are both offered to be stopped. |
| 3 | The view (`tests/tui-view.test.mjs`): the step is alone in the row at the foot, with its key in brackets and not bold; its key and a click ask first and then send `/pr-stop` for that run to the session on screen, and the left button's press is stopped, so the keyboard stays where it was; the end of a selection of text and the right button pick nothing; an answer is not acted on once the run's receipt arrived or the next run started; a release picks nothing when the run ended while the button was held, also when the next run's step, which the same element draws, is there by then, and still picks after progress of the same run; an action that is open when the part is unloaded sends nothing. And in place of a document the panel says "No report or preview yet." of a run under way and "This run ended with no report or preview to show." of one that has its receipt. And the row is drawn from the steps' names, which stay the same values when the panel's content is worked out again, while what a step shows is read when it is drawn: a preview planned again with another count is said by the element that is there. |
| 1 | The runtime (`tests/runtime.test.mjs`): the STARTED notice of a run carries that run's ID as the one thing it offers, and its progress notices carry nothing; the panel's model offers the step while the run is under way, and the command the step makes stops the run when it is sent to the conversation and nothing when it is sent from another one; the run ends `CANCELLED` and offers nothing; the same command sent after its run has ended stops nothing, and the run that started since goes on. |

The other changed expectations are in existing tests: which notices carry
metadata (a run's STARTED notice now does, with and without
`terminalPanel: manual`), the rule that the terminal part sends a command in
one place, `/pr-comment` or `/pr-stop` and no other, with `/pr-stop` made of
the run's ID alone (`tests/release.test.mjs`), the labels that ask first, and
that a run under way offers nothing on a host that cannot send a command or
has no list dialog, or when an earlier version started it
(`tests/tui-view.test.mjs`).

### In the real terminal UI

The eleven host fixture runs passed on one tree (the hash of the code and
tests was the same before and after).

- **Stopping a run from the panel** (`tests/host-v2-tui-panel.mjs`, from
  source and as the package, in a terminal of 170 by 46). A first review
  starts and its four reviewers are held. The panel lists them as running
  and offers **Stop this run…** at its foot, and nothing else; the step is on
  the line of OpenCode's status bar, under a line that crosses the panel. The
  STARTED notice in the conversation's inbox carries the run's ID as its
  offer. A click on the step asks "Stop this run?", with "No, let it run"
  and the run's ID and command first; Enter takes that row: nothing is sent,
  the run goes on, and what is typed next goes to the prompt. With the
  keyboard in the panel, `s` asks again. `s` pressed once more is typed into
  the question: it then lists no row ("No results found"), Enter does
  nothing, and with the letter deleted both rows are back. "Yes" ends the
  run: the panel
  shows `CANCELLED` within a second (0.2 s in these runs), offers nothing,
  counts the four deleted sessions and says that the run left nothing to
  show, and the conversation holds the runtime's answer to `/pr-stop` and the
  run's receipt. The fixture then goes on as before with a second review,
  whose notices show that with the default setting only the notices that
  offer a step carry metadata: the start of a run, the receipt of a review
  that no preview follows, each preview and the saved preview shown again.
  The runs made 26 model requests by AZPR's sessions (18 for 0.4.4; the
  other 8 are those of the review that was stopped) and 57 Azure DevOps
  requests (49), and still exactly 1 request of the conversation's own
  model.
- **Unchanged**: setup no model request and 16 Azure DevOps requests; smoke
  fresh 110 model and 194 Azure DevOps requests, replacement 92 and 164,
  native 110 and 201; comment scale 34 and 75, with debug off 34 and 71; and
  background compaction 8 model requests in both runs, all as for 0.4.4.

`npm pack --dry-run` lists 38 files, as for 0.4.4. `package.json` has no
dependency and no lifecycle script.

### A click that was lost

In one run of this fixture as the package, the click on **Stop this run…**
did nothing: no question within a minute, and nothing in OpenCode's log. The
run from source had passed, and so had the same click in the package's run
before it.

OpenTUI 0.8.4 sends a press and a release to what its last drawn frame has
under the pointer. The panel drew its steps from a list of objects that
`actionRows` makes anew each time the panel's content is worked out, which
every notice and every answer of the server causes, so the renderer made the
steps anew each time; a step made after the last frame is not in that frame,
and a press or a release then goes nowhere. 0.4.4 has this too, for the steps
of a preview; there the panel is mostly at rest when a person clicks, and
right after a run starts it is not.

To see whether that was it, two copies of the candidate were made to work
the panel's content out again every 5 milliseconds, one drawing the steps as
before and one from their names, and each ran the fixture four times:

| Steps drawn | Result of four runs |
| --- | --- |
| From objects made anew (as 0.4.4) | 4 failed, each at a click that did nothing: three at **Stop this run…**, one at **Adjust findings…** |
| From their names (the candidate) | 4 passed |

The candidate draws them from their names, as it already drew the session
rows from their IDs. This is no test of the package: the copies exist only
for it, and the offline test holds that the row is drawn from names.

### Reviews by a second model

Three reviews of the pull request (GPT-6 Astra at its highest reasoning
effort through the Codex CLI, in a read-only sandbox on a clean clone): of
the first commit, of the correction described below, and of the tree with the
recording; the commit after that one adds this record only. The reviewer ran
the build check and the tests that write nothing, and probes of its own (a
press under one run and a release under the next, on the element both share;
an answer after the session changed or the panel closed); the tests that
write files and the host fixtures ran here, on every tree. None of the three
reported a defect.

One defect was found by reading the change again while the first review ran,
and corrected before the second. The question before a stop is a list the
host lets a person search, and what is typed into it includes the key that
opened it, when that key is pressed once more than meant. The host's search
finds a letter anywhere in a title and selects the best match; `s` is in
"Yes, stop it" and not in "No, let it run", so "yes" was the only row left,
selected, for Enter to take. The two questions (before a stop and before
posting) now give their list a search of its own, by the beginning of a row's
title. On OpenCode 2.3.0, in the panel's fixture: after the second `s` the
question lists no row, Enter does nothing, and with the letter deleted both
rows are back.

### With a real model: a review stopped from the panel, and the recording

The recording at the top of the README and the pictures of the panel in
[the demonstration](DEMO.md#the-terminal-panel) were made with the candidate
(the public Git commit `4427f75`, installed by OpenCode's plugin manager) on
the maintainer's everyday OpenCode 2.3.0 service, with `openai/gpt-6-luna`
for every review role, on Test PR 4 of the maintainer's Azure DevOps test
project (35 changed files). The settings were changed for it
(`outputLanguage: en`, no debug records) and put back afterwards, byte for
byte, with the released plugin. Nothing was posted.

| Step | Result | Time |
| --- | --- | ---: |
| `/pr-review <URL>`, then **Stop this run…** clicked in the panel and "Yes, stop it" | `CANCELLED`: the four reviewer sessions were stopped and deleted, and the panel said that the run left nothing to show | under 1 s from the answer |
| `/pr-review <URL>` again | `COMPLETE`: 4 reviewer sessions, 2 candidate findings, 1 confirmed (medium); the panel offered to stop the run throughout | about 70 s |
| The preview that follows | `PREVIEW`: a summary and 1 inline comment; the panel offered to stop that run as well, then **Post 2 comments…** and **Adjust findings…** | 7 s |
| **Adjust findings…** clicked | The list of findings, left with Escape; nothing changed | |

The commands were sent through OpenCode's command API and the clicks to a
terminal UI attached to that conversation, which the recording shows; every
screen state of the cast was read for the organization's name, addresses of
Azure DevOps, local paths and account names, and none is on screen. This is
one stop of one run, with one model.

### Not verified

- The step was used on one run of a real model, above. A stop while comments
  are posted, and a stop from one of a review's own sessions, were not tried
  with a real model; the runtime's side of both is the `/pr-stop` command
  earlier versions have.
- A run that the panel shows as running after the OpenCode process that ran
  it was restarted cannot be stopped, since nothing runs; that the runtime
  then answers that no active review matches was read in the code and is
  what the test of a step that arrives late shows, not a restart.
- Other OpenCode clients (the desktop app) were not run; they load no
  terminal part.

## 0.4.4 in use: a review, an adjusted preview and its publication with a real model (2026-11-19)

Environment: the maintainer's everyday OpenCode 2.3.0 background service on
Ubuntu 22.04.5 under WSL2, with `opencode-azure-devops-pr-review@0.4.4` from
npm, the maintainer's Azure DevOps test organization and `openai/gpt-6-luna`
for every review role; a preview after each review (the default), debug on,
`outputLanguage: zh-TW`. 0.4.4 was released without a review by a real model
and without its steps used against a live organization (see
[its acceptance](#044-release-candidate-acceptance-2026-11-19)). The
maintainer did both in the terminal UI on the evening of the day it was
published, and reported that lowering a level and posting the comments from
the steps at the panel's foot worked without a problem.

What was on screen was not recorded. What follows was read afterwards from
the conversation's notices and from the debug records of the four runs, on
Test PR 2 of the maintainer's Azure DevOps test project (a draft PR with 1
changed file):

| Step | Result | Time |
| --- | --- | ---: |
| `/pr-review <URL>` | `COMPLETE`: 2 reviewer sessions, 6 candidate findings, 3 confirmed (the other 3 merged into them), all medium | 72 s |
| The preview that follows | `PREVIEW`: a summary and 3 inline comments; nothing posted | 15 s |
| An adjustment, three minutes later: one finding from medium to low | `PREVIEW` again: a summary and 2 inline comments, the lowered finding in the summary only; nothing posted | 22 s |
| Posting that preview, four minutes later | `POSTED`: the summary and the 2 inline comments (lines 29 and 37 of the changed file), then the PR's threads read back; 7 Azure DevOps requests, none retried | 2 s |

- **The offer.** The notice of each preview carried what can be done next in
  its metadata (`azpr.next`), as the panel reads it: after the first preview,
  posting 4 items and adjusting 3 findings, all medium; after the second,
  posting 3 items, with one finding low that was medium. No other notice
  carried one.
- **The adjustment.** The planner's input of the second preview holds the
  adjustment (one severity change, with the rule that it is final) and the
  finding at its new level; the first preview's input holds none. The saved
  review still holds that finding at medium, with the adjustment beside it.
- **The name.** The conversation was new and nobody had named it; the review
  that started in it named it after the PR, `AZPR: PR #2 (<repository>)`.
- **The conversation's own model** never ran: the conversation has no
  message, and the 14 notices of the four runs are in its inbox, each
  steered.

**Limits.** One review of a 1-file PR, with one model. The run records keep
no arguments of a command, so they do not tell a step picked in the panel
from the same command typed: that the adjustment and the publication were
picked there is the maintainer's report, not something the records show.
What the findings and the comments say was not judged here. The comments are
on the test PR.

## 0.4.4 after publication (2026-11-19)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.0 and tmux 3.2a, in isolated OpenCode profiles with the fake model and
Azure DevOps services.

- **The merged tree.** The pull request was merged with a merge commit whose
  tree is that of the candidate's last commit. CI passed on that commit, on
  `main` and on the tag. That last commit changed two documents after the
  ninth review; a tenth review, of the tree that was merged, found nothing to
  change either.
- **Source archives.** The release's source archive, downloaded again, is
  byte-identical to the one built from the tag, and so is GitHub's own archive
  of the tag. Both passed the clean-directory installation check: 23 runtime
  modules, 9 prompts and the license as in the archive, the view's JSX source
  not installed, and `--replace` keeping the settings file byte for byte.
- **The Git package.** `github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.4.4`,
  installed by OpenCode's plugin manager, passed the native smoke fixture
  (110 model and 194 Azure DevOps requests), the terminal panel's fixture
  (18 and 49, with one request of the conversation's model) and the setup
  fixture (no model request, 16 Azure DevOps requests). In the terminal UI
  the steps at the panel's foot were clicked and picked with their keys, an
  adjustment was applied from the foot of its list, a preview was posted
  after the question, and neither a selection of text let go over a step nor
  a step that was pressed and then left picked anything.
- **The npm package.** The registry's integrity and shasum for 0.4.4 equal
  those of the package built from the tag (38 files), the tarball downloaded
  from the registry is byte-identical to it, and `latest` names 0.4.4.
  Installed from the registry, the package passed the same three fixtures
  with the same request counts.

No review with a real model ran on 0.4.4, and the steps at the panel's foot
were not used against a live Azure DevOps organization; see what the
acceptance below lists as not verified.

## 0.4.4 release candidate acceptance (2026-11-19)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.0 and tmux 3.2a, with isolated OpenCode profiles and the fake model and
Azure DevOps services. Nothing here used a real model or Azure DevOps; what
0.4.3 showed with both, the day before, is in the next section.

0.4.4 lets the terminal panel offer the next step after a review or a preview
in one row at its foot, whose steps send the command, names a conversation
nobody named after its PR, and changes several texts of setup (see
[what can be done next](ARCHITECTURE.md#what-can-be-done-next)). Of the
server part, `comments.mjs` gained `previewActions`; `runtime.mjs` sends that
with the notices that offer a step, holds it to the preview its notice shows,
and names an unnamed conversation while it follows the renames the host
reports; `host.mjs` tells an unnamed conversation, `attribution.mjs` writes
its name, and `setup.mjs` describes what each model is for and where every
setting is described. The terminal part gained `src/tui-actions.mjs`;
`tui-model.mjs` reads the offer and checks it, and `tui-view.jsx` draws the
row. `install.sh` copies one more file. No prompt and no setting changed.

### Offline

`npm run check` passes, and `npm test` runs 646 tests (612 for 0.4.3),
all passing.

| Tests | What they establish |
| ---: | --- |
| 10 | What the steps do (`tests/tui-actions.test.mjs`, new), with scripted dialogs: what a notice offers, each with its key, and the step the others lead to; a label that ends in "…" asks before anything is sent, and one that does not is sent at once; a command is made only of a review ID, finding IDs, level names and the word for the review's comments, and is read by the same parser as a typed one; posting asks first with "no" first and sends nothing otherwise; findings are adjusted in a list whose last row applies every change with both lists in full, and what is saved is where a person starts; the same from the foot of the list, which acts once and only while that list is open, also where a dialog that was closed answers nothing; an answer for what the panel no longer offers sends nothing and says so, for every step, and a finding picked from the list of an offer that is gone is not asked about; a command that was refused or did not get there is said with its reason, on one line; one action at a time; nothing is asked or sent after the part was unloaded. |
| 3 | What the panel shows of it (`tests/tui-model.test.mjs`): every value of an offer is checked, and anything unexpected, or an offer without the word for the review's comments, offers nothing; the offer is taken from the notice that happened last, for the review shown, from the inbox and from a delivered message alike, goes with its kind of document (a preview is planned under a report and never posted from there), names its notice, and is gone once a run starts or another receipt arrives; the receipt of a run whose preview was replaced (`REPLACED`) ends that run in a panel that showed it running, with no progress and nothing offered, but is not what happened last, so another command's preview stays in view; a session at rest is `finished` until a receipt names it, and stays so where none does. |
| 4 | The view (`tests/tui-view.test.mjs`): the steps are one row at the foot, each with its key in brackets and the main one bold, wrapping as whole items under a line; a click and the key ask first and then send `/pr-comment` with the review's ID and the word to the session on screen; a left mouse-down on a step is stopped, so the keyboard stays where it was, and a key is dim while the prompt has the keyboard; the release that ends a selection of text picks no step, also not the one that asks nothing, and neither does a release without its press on that step, one for an offer that changed while the button was held, one after the pointer left the step, or one whose press was given up (by the release of a selection, another button, or a press or release elsewhere in the panel); an answer counts only while the panel still shows that offer there (not after another notice, a run that started, a closed panel, another session, another plugin's panel or a panel no longer drawn); nothing is offered while a run is under way, for a notice without the data, or on a host that cannot send a command or has no list dialog; an action that is open when the part is unloaded sends nothing. |
| 13 | The runtime (`tests/runtime.test.mjs`): a preview's notice, the saved preview shown again, and the receipt of a review that no preview follows carry the offer as the review is at that moment (after an adjustment, after publication started, held, or with nothing left to post), and a review that a preview follows carries none; the commands of the steps adjust and post like typed ones; after a command typed in the review's own session planned the preview again, the conversation's panel still shows the first preview, and each of its steps is refused before anything is posted, adjusted or planned, while the saved preview shown again offers steps that are taken and a typed command acts as before; a preview that another command adjusted or posted while its run's sessions were deleted (also one posted after an earlier publication of that review) is neither enclosed nor offered, its run ends with a receipt that says `REPLACED`, and the panel's model is the same before and after that receipt; such a run does not make its review the current one (a command without a review ID still acts on the review that was used last), and a panel that showed it running sees it end; a preview that is planned again while the first run saves the record after its receipt was made leaves that receipt offering the preview it shows, whose step is then refused; a step refused for its word leaves the conversation's current review as it is, in the process and on disk, so that a command without an ID still posts to the other pull request; a review's receipt offers nothing once a preview of that review was planned during its cleanup; a conversation nobody named is named after the PR by a check or a review, a name that is there stays, a refused command names nothing, and a host that cannot rename, fails or does not answer holds no command up. The renames the host reports decide, in scripted orders that the tests follow by the naming's own events (the turn in which the host answers a write of a name), not by how long a command takes: a name given between the read and the write is written back, also when it is given twice; so is a name that follows someone's choice of AZPR's very words while AZPR's write is under way, whether the host reports all of it at once or a little later, and a name that is followed by AZPR's words afterwards (in doubt the other name stays); of several names in a row the last one is written back, in one write when the host has reported all of them, and AZPR's own words are never written back as someone's name, also when the report of AZPR's first write comes after a name was written back; once that write-back was reported, someone's own choice of AZPR's words stands; AZPR writes four times at most; a rename reported during the read stops the naming, also when the host reported other conversations' renames before it; another conversation's rename is ignored and does not put a write-back off; a host without the feed gets no name, one that never reports AZPR's own rename or refuses the write ends the watch by itself, a feed that fails while the conversation is read leaves no rejection without a handler, a second command starts no second watch of the same conversation, and a write that the host answers long after the watch would have closed is still followed by the name it replaced. Unloading the plugin waits for a write that is under way and writes back the name it replaced, ends a watch that only waits within a moment, and does not wait without end for a host that never answers. In each case the subscription is closed. |
| 2 | `previewActions` itself (`tests/comments.test.mjs`): the offer for an unadjusted, an adjusted, a held, an unplanned and a published review, a summary cut to 160 characters, and no offer beyond 200 findings; and the word for a review's comments: the same from the saved record, another one for another preview, no preview, another review or other adjustments, whatever order they were typed in, and unchanged by posting. |
| 2 | The name a conversation gets, from the URL alone, without the organization or the PR's own title (`tests/attribution.test.mjs`); and that the sections of the README which the runtime names are there (`tests/release.test.mjs`). |

The other changed expectations are in existing tests: the `--seen` option of
`/pr-comment` (`tests/output.test.mjs`), the description of the commands of
an AZPR without settings, the hints and the search lines of the
model rows, the section of the README that "Settings file" and `--help` name
(a test also checks that the README has that heading), the **Deep models**
rows of `/pr-check` (the same model with a higher variant is not a repeat),
the untitled rule and the new host capability, and the rule that the terminal
part sends a command in one place, `/pr-comment` alone
(`tests/release.test.mjs`).

### In the real terminal UI

The eleven host fixture runs passed on one tree (the hash of the code and
tests was the same before and after).

- **The steps at the panel's foot** (`tests/host-v2-tui-panel.mjs`, from
  source and as the package, in a terminal of 170 by 46). After a review that
  no preview follows, the row offers **Preview comments** and the adjustment,
  and no posting. After a preview it offers **Post 5 comments…** and the
  adjustment, and nothing to reset; the row is on the line of OpenCode's
  status bar, the line above it is level with the lower edge of the prompt,
  and nothing is drawn under it. The panel is then read to its end, where the
  row is still in its place, and the keyboard is given back to the prompt: a
  `p` typed there is a letter and asks nothing. A click on the adjustment
  opens the list of findings, with nothing to apply yet; typing filters it;
  one finding is left out, and a click on **apply** at the foot of the list
  applies it: the runtime answers in the session on screen with a new preview
  that says what a person left out, the panel shows it from its beginning and
  offers 4 comments and the reset, and what is typed next still goes to the
  prompt. Text is then selected with the mouse from the preview's heading
  down to the row and let go over **Reset adjustments**, which asks nothing:
  no command is sent and the panel shows what it showed. (With the release
  taken for a click, as the candidate had it until then, the same step of
  this fixture failed on OpenCode 2.3.0: the reset was sent.) The button is
  then pressed on **Reset adjustments** and let go after the pointer has
  left it: nothing is sent either. (Without a look at where the pointer is,
  that step failed as well: OpenTUI sends the release to the step that was
  pressed.) With the keyboard in the panel, `a` opens the list again, a second
  finding is left out, and `ctrl+s` applies it. The key `p` asks before
  posting with "No, post nothing" first: Enter posts nothing, and "Yes" ends
  in `POSTED` with the summary and two comments on the fake PR, after which
  nothing is offered. With the default setting only the notices that offer a
  step carry metadata, and only that offer; with `terminalPanel: manual` they
  carry both. The runs made 18 model requests by AZPR's sessions
  (15 for 0.4.3; the others plan the two adjusted previews) and
  49 Azure DevOps requests (31), and still exactly 1 request of
  the conversation's own model.
- **Setup** (`tests/host-v2-tui-setup.mjs`, from source and as the package).
  Without settings the command list describes the six review commands as
  "AZPR is not ready here; run /pr-setup to see what it needs". The settings
  list shows `Review model for /pr-review` and `Deep model for /pr-deep` with
  their values; the deep model's dialog says "Stronger than the review model,
  or a higher variant" in its search line, the variant dialog "A higher
  variant reasons longer", and leaving them saves nothing. "Settings file"
  names the README's section "All settings and defaults" and its address. No
  model request and 16 Azure DevOps requests, as for 0.4.3.
- **A conversation's name** (`tests/host-v2-smoke.mjs`, fresh, replacement
  and native). A conversation created without a title has none on OpenCode
  2.3.0; after `/pr-check` in it its title is `AZPR: PR #123 (repository)`,
  the conversation that was created with a title keeps it, and no model was
  asked. The check's debug record says `named`: OpenCode 2.3.0 reported
  AZPR's rename to the plugin's subscription, which is what the guard against
  replacing a name given in the same moment rests on; the record of the check
  in the named conversation says `kept`. That check adds 7 Azure DevOps
  requests to each run: fresh 110 model and 194 Azure DevOps requests,
  replacement 92 and 164, native 110 and 201.
- **Unchanged**: comment scale 34 and 75, with debug off 34 and 71,
  and background compaction 8 model requests in both runs, as
  for 0.4.3.

`npm pack --dry-run` lists 38 files (37 for 0.4.3); `src/tui-actions.mjs` is
new. `package.json` has no dependency and no lifecycle script.

### How the row got its place

The first candidate drew the steps as rows of full sentences under the
panel's header, each with the command it sends beside it. The maintainer
installed that candidate (the pull request's commit, as a Git package) and
used it: after a preview was read to its end, what could be done with it was
at the other end of the panel. Three layouts were then recorded in the real
terminal UI with stand-in services and read as text, row by row, before one
was chosen: the same block at the foot of the panel, a band as tall as the
prompt area beside it (at 150 by 42, 120 by 32 and 200 by 50), and one row on
the panel's own ground (at 150 by 42 and 120 by 32). The row is what this
candidate has. The same
recordings showed three things the fixtures now check: a click on a step
gave the panel the keyboard, so that the next key typed was taken for the
panel's; a preview that was planned again arrived scrolled to where the one
before it was left; and text that scrolled touched the panel's header.

### The pictures of setup

`docs/assets/setup-dialogs.gif` and `docs/assets/setup-settings.png` show
AZPR's dialogs in the real terminal UI of OpenCode 2.3.0, with this
candidate installed from source. They were recorded with
`docs/assets/record-terminal.py` and rendered with
`docs/assets/render-terminal-demo.py`, as the other recordings are, but not
against Azure DevOps: the organization (`contoso`) and the token are test
values, a stand-in on the same machine answered the one request that checks
the token, and two of the listed models are entries of the recording's
configuration. A live recording would show the maintainer's organization.
Both pictures say so in the line above the terminal and in the line below it;
the terminal's status bar is cropped. The recording opens the dialogs from
the command palette, so that the conversation holds no notice with a path of
the recording machine; every frame shown was read as text for paths and
names before it was used.

### Reviews by a second model

Nine reviews of the pull request followed (GPT-6 Astra at its highest
reasoning effort through the Codex CLI, in a read-only sandbox on a clean
clone), each of the tree as corrected after the one before. The reviewer ran
the build check and the tests that write nothing, and reproduced what it
found with probes of its own; the tests that write files and the host
fixtures ran here, on every corrected tree. The first eight reviews reported
nineteen defects (3, 4, 2, 3, 2, 2, 2 and 1), each confirmed against the code
and corrected, with a regression test where the defect was in the code; the
ninth, of the code described above, found nothing to change:

- **An answer for what the panel no longer offered was acted on** (first
  review; one more step in the sixth, and the mouse in the seventh and the
  eighth). A dialog can stay open for any time.
  When the preview was planned again meanwhile, "Yes" still sent the command,
  which would have posted a preview nobody had read; a panel that was closed,
  or another session on screen, changed nothing either. Each step now comes
  with a check that the panel still shows that notice's offer in that
  session. The sixth review found that a finding picked from the list of an
  offer that was gone still opened the question about that finding (nothing
  could be sent from it, but the action went on); the list's answer is
  checked as well now. The seventh found that an offer which changed while
  the mouse button was held on a step let the release act on the new one:
  **Reset adjustments**, which asks nothing, would have reset a preview that
  was not the one pressed. A click is now the press and the release on one
  step of one offer. The eighth found that a press which was given up (its
  release was the end of a selection, or never reached the step) stayed on
  record and could make a later release a click; a press now ends with every
  other press or release the panel sees.
- **A command was bound to its review, not to the preview on screen** (second
  review). That check knows only what its conversation was told: after a
  command typed in the review's own session had planned the preview again,
  the conversation's panel still offered the first one, and posting from it
  posted the second. Every command of the panel now names the preview and the
  adjustments it was picked for (`--seen`), and the runtime refuses it when
  they are others. The fifth review found that a step refused like that had
  already made its review the conversation's current one, so that the next
  command without an ID could act on another pull request than the one used
  last; the word is compared first now, and a refused step changes nothing.
- **A late receipt showed one preview and offered another** (first review;
  two consequences of the correction in the fourth, one more in the fifth). The command locks are
  released before a run's sessions are cleaned up, and the offer was read
  after that. A preview that another command replaced or posted before its
  receipt is neither shown nor offered now. The fourth review found that
  such a run still made its review the conversation's current one, so that a
  command without a review ID acted on another review than the panel showed,
  and that a panel which showed the run as running never saw it end when the
  other command was answered in another session: the run now ends with a
  receipt of its own status, `REPLACED`, which changes neither. That
  correction had put the save of the record between the look at the review
  and the receipt, and the fifth review showed that a preview planned again
  during that save was offered under the text of the one before. The
  receipt's text and offer are made in one moment now, and the record is
  saved after them.
- **Naming a conversation could replace a name given in the same moment**
  (first review; three more cases in the second, two in the third and one in
  the fourth). The
  title was read and then written. The host has no rename that applies only
  to an unnamed conversation, and nothing ties a rename it reports to the
  call that made it, so no plugin can rule this out; the renames the host
  reports now decide, and AZPR's own name gives way wherever there is doubt.
  The second review found that a read of that report could reject with
  nobody listening, that two commands in a row could each watch the same
  conversation, and that the watch gave up while its own write was still
  under way. The third found that a report with AZPR's own words was taken
  for AZPR's write although someone else could have chosen the same words,
  and that unloading the plugin closed a watch whose write was still under
  way. The fourth found an order of three renames in which AZPR's own words
  were written back as if they were someone's name. Each is corrected; what
  remains is said in
  [the architecture](ARCHITECTURE.md#authorization-and-isolation): a person
  who gives a name and then exactly the words AZPR wrote last, both in that
  moment, keeps the name given first.

- **The naming tests depended on how long a command took** (sixth review;
  one case left over in the seventh).
  Several cases looked at the watch after the check's receipt and expected it
  open, which holds only while the check ends within the 60 ms the watch
  stays open there; a busy machine would have failed them. They follow the
  naming itself now: the fixture's host says in which turn it answered a
  write of a name, what has to happen is waited for, and what must not happen
  is given a pause in which it would have. Run eight times at once with every
  processor kept busy, they passed each time; four earlier defects put back
  into the code one at a time each made them fail.

Between the reviews the corrections, and what they touch, were read again
here, which found five more defects; each has a test that fails without its
correction:

- The release of the mouse button that ends a selection of text was taken for
  a click. OpenTUI sends that release to whatever lies under the pointer, so
  text selected down the panel and let go over **Reset adjustments**, which
  asks nothing, sent that command; the fixture's step showed it on OpenCode
  2.3.0 before the correction. The same release over a session's row opened
  that session, and over `close` closed the panel, since 0.4.2; both were
  seen on that host with the earlier handlers.
- A step that was pressed and then left was still picked when the button was
  let go elsewhere, since OpenTUI sends that release to the element that was
  pressed; the fixture showed this as well.
- The check for a rename that the host reports while the conversation is read
  looked only at the first event the feed held, so a name of this
  conversation behind another conversation's rename was missed, written over
  and then written back.
- The moment AZPR waits before it writes a name back began again with every
  event of the feed, so other conversations' renames could put the write off.
- Whether a preview was posted since it was rendered was told by whether
  publication had begun: a review published before, planned again and posted
  by another command while that run ended still got a receipt that said
  `PREVIEW`.

### Not verified

- The steps at the panel's foot were not used against a live Azure DevOps
  organization or after a review by a real model. The candidate the
  maintainer used at home was the first one, with the rows under the header.
- That a name given in the very moment AZPR names a conversation is written
  back was shown with scripted orders of renames; on the real host only that
  the renames are reported was checked. A host that reported renames in
  another order than they took place would mislead it.
- The recording at the top of the README predates the row; it shows the panel
  of 0.4.2.
- The pictures of setup show stand-in services, as said above.
- Other OpenCode clients (the desktop app) were not run; they load no
  terminal part.

## 0.4.3 in use: a first setup and a review with a real model (2026-11-19)

Environment: the maintainer's everyday OpenCode 2.3.0 background service on
Ubuntu 22.04.5 under WSL2, with `opencode-azure-devops-pr-review@0.4.3` from
npm, the maintainer's Azure DevOps test organization and `openai/gpt-6-luna`.
0.4.3 was released without these two checks (see
[its acceptance](#043-release-candidate-acceptance-2026-11-18)); they were
made the day after. Nothing was posted.

**A first setup in the dialogs.** The plugin entry and the settings file
were removed (after backups) and the service restarted, so that it had no
AZPR command and no private role. The maintainer then installed 0.4.3 with
`opencode plugin add`, opened the terminal UI and answered the dialogs:
organization, no proxy, the token, a model. What the dialogs showed was not
recorded; what they left was read afterwards:

- The settings file, complete and readable by its owner only (mode 600), and
  a token file made for it, `pat-<organization>` beside it (mode 600), with
  the same bytes as the token file used before. So the token Azure DevOps
  was asked about is the one that was saved.
- In the project directory where the setup ran, the seven commands and seven
  private roles (five of the review profile, two of the quick profile; the
  deep profile has no model after a first setup), without a restart.
- In another project directory, which the service had opened before the
  package was added, the review commands were still the ones that only say
  so. This is as designed: settings saved from another directory are read
  after a restart. But the command list described them as "AZPR setup
  required", although setup was done and only the restart was missing.
  0.4.4 changes those words. After a restart both directories had the
  commands and the roles.

**A review with a real model.** The review and quick models were then set to
`openai/gpt-6-luna` and the service restarted; the other settings were those
a first setup leaves (`outputLanguage: en`, debug off, a preview after each
review). On Test PR 2 of the maintainer's Azure DevOps test project (1
changed file), through OpenCode's HTTP API:

| Step | Result | Time |
| --- | --- | ---: |
| `/pr-check` | `READY` | 5 s |
| `/pr-review <URL> --preview` | `COMPLETE`: 2 reviewer sessions, 5 candidate findings, 3 confirmed, all medium | 60 s |
| The preview that follows | `PREVIEW`: a summary and 3 inline comments; nothing posted | 10 s |

With debug off the run deleted its two reviewer sessions when it ended and
kept the verification session, which holds the report; the comment run kept
none.

**The notices and the conversation's own model.** During the three commands
the conversation's model never ran: the conversation had no message, and ten
notices waited in its inbox, each steered and none waking a model. One
ordinary prompt was then sent to that conversation, with its model set to
`openai/gpt-6-luna`. Its messages afterwards, in order: the model switch,
the ten notices, the prompt, one answer of the model (19,505 input and 89
output tokens), and the end of the turn. The inbox was empty, 15 seconds
after the prompt. The answer named the three findings and said that the
preview was not posted. With notices queued as before 0.4.3, OpenCode would
have given each a turn of its own, eleven in all (measured only in the
fixtures: 17 requests for 16 notices and a prompt).

**Limits.** One run each, on a 1-file PR. The review was driven through the
HTTP API, so the terminal panel was not on screen. The steps of the
maintainer in the dialogs were not recorded, and the dialogs were not used
to change an existing setup. The earlier settings were put back afterwards.

## 0.4.3 after publication (2026-11-18)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9, OpenCode
2.3.0 and tmux 3.2a, in isolated OpenCode profiles with the fake model and
Azure DevOps services.

- **The merged tree.** The pull request was merged with a merge commit whose
  tree is that of the candidate's last commit. CI passed on that commit, on
  `main` and on the tag.
- **Source archives.** The release's source archive, downloaded again, is
  byte-identical to the one built from the tag, and so is GitHub's own archive
  of the tag. Both passed the clean-directory installation check: 22 runtime
  modules, 9 prompts and the license as in the archive, the view's JSX source
  not installed, and `--replace` keeping the settings file byte for byte.
- **The Git package.** `github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.4.3`,
  installed by OpenCode's plugin manager, passed the native smoke fixture
  (110 model and 187 Azure DevOps requests), the terminal panel's fixture
  (15 and 31, with one request of the conversation's model) and the setup
  fixture (no model request, 16 Azure DevOps requests): the dialogs set AZPR
  up from a profile without settings, and the review commands worked without
  a restart.
- **The npm package.** The registry's integrity and shasum for 0.4.3 equal
  those of the package built from the tag (37 files), and the tarball
  downloaded from the registry is byte-identical to it. Installed from the
  registry, the package passed the same three fixtures with the same request
  counts.

No review with a real model ran on 0.4.3, and its dialogs were not used
against a live Azure DevOps organization; see the acceptance below for what
was probed live.

## 0.4.3 release candidate acceptance (2026-11-18)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, OpenCode 2.3.0 and
tmux 3.2a, with isolated OpenCode profiles and the fake model and Azure DevOps
services. One read-only probe, described below as live, sent a few `GET`
requests to the maintainer's Azure DevOps test organization; everything else
used neither a real model nor Azure DevOps. Nothing was posted.

0.4.3 brings setup into OpenCode's terminal UI and changes how AZPR leaves
its notices in a session's inbox (see [architecture](ARCHITECTURE.md#setup)
and [commands and workflows](ARCHITECTURE.md#commands-and-workflows)). Of the
server part, `setup.mjs` was largely rewritten (the table of rows, the RPC,
the access check, the token file, the loading of a first setup),
`azure.mjs` gained `access` and an option of `request` (how often a read is
repeated), `config.mjs` exports its single-value checks, `runtime.mjs`
exports the reading of the CA file (a regular file only, now) and says with
the rule of its preflight whether the settings and the PAT file are still
what it loaded, and `session.mjs` leaves notices steered.
The terminal part gained `src/tui-setup.mjs`, and `tui-view.jsx` the token
field and the wiring of the dialogs. `install.sh` copies one more file. No
prompt and no setting changed.

### Setup in the terminal UI

**What the terminal UI offers a plugin.** Read from OpenCode 2.3.0's source
and then used on the real host: the TUI plugin API has the host's own dialogs
(a searchable list with groups, a one-line text prompt, a confirmation, an
alert), a plugin's terminal part can call RPC methods its server part
registered, and a plugin's own dialog can take keys and pastes itself. The
host's text prompt shows what is typed, and OpenTUI 0.8.4's text fields have
no hidden mode: OpenCode's own `/connect` shows a pasted API key. A token
field that draws only bullets and a count is therefore AZPR's own.

**The request that checks a token, live.** `GET
https://dev.azure.com/{organization}/_apis/git/pullrequests?$top=1&api-version=7.1`
with a PAT that has only Code (Read) and Pull Request Threads (Read & write):

| Sent | Answer |
| --- | --- |
| The valid PAT | 200, JSON with a list of at most one pull request (2.6 KB) |
| A token Azure DevOps does not know | 401, no content, with Azure DevOps's own response header |
| The same, for an organization that does not exist | 404, `text/plain`, with that header |

`_apis/git/repositories` answered the same way but ignores `$top`, so its
answer grows with the organization. `_apis/connectionData`, which names the
token's owner, answered `api-version=7.1` with 400
(`VssInvalidPreviewVersionException`): it exists only as a preview version,
so AZPR does not use it and names no account. The valid PAT was sent only to
its own organization.

**Offline.** `npm run check` and 612 tests (554 before this work). New:

| Tests | What they establish |
| --- | --- |
| 21 | What the dialogs ask and in which order (`tests/tui-setup.test.mjs`), with scripted answers and a stand-in for the server part: organization, proxy, token, model, one save; the CA file only after a proxy; leaving at any step saves nothing; a refused answer is asked again with its reason and the text typed; a refused token and an unknown organization; an unreachable Azure DevOps offers the proxy or the CA file and checks the same token again; unchecked saving, and a saved token kept unchecked; the settings list, its values and the restart note; the confirmation of posting without a preview, with the safe answer first; models with variants, and a model that may be off switched off also where OpenCode offers none; a token saved with the organization it was checked for, and another organization asking for a token of its own, both saved together or neither, with the place of the earlier token shown; one server part for a setup from its first question to its save; a setup that is stopped ending at its next step without saving; one setup at a time; the hint once. No dialog text and no toast holds a token. |
| 28 | The server part (`tests/setup.test.mjs`): the dialogs against the real handlers, ending in an owner-only token file named for its organization, complete owner-only settings and a loaded runtime; the access check for each kind of refusal, each one request, and nothing sent for an answer that is not text or for a token with quotes or other signs in it, which setup could not replace later; the saved token sent only to its organization, through the saved proxy and with the saved CA file; answers checked without being saved, a CA file that is no regular file refused, and a proxy's user name and password in no answer, the saved one's or a newly typed one's; one setting saved at a time and the restart state, and a value that is chosen again writing nothing; the restart state following the runtime's own rule (another token in the PAT file, any other settings text, defaults another load wrote in), whoever made the change; the token file these settings name for their organization replaced in one step, and refused for a symbolic link, a directory others can write to and a file that holds something other than one token (a private key, a line of JSON, a KEY=VALUE pair, a path, a short word); the token and the settings written under one lock, so that two setups saving at the same moment leave no organization with the other's token; every other token in a file that did not exist: two settings files that share AZPR's directory, also for one organization, a name another settings file already uses, a token file named without an organization, the default PAT file of setup with options, and another organization, with the settings switching organization and token in one write, the earlier pair intact when that write fails, a failed save taking away only the file it made, and settings and a token that are in place staying reported as written when the cleanup after them fails; a token saved only for the organization it names, and an organization asked for a token of its own also while the earlier token's file cannot be read, and where the settings named a token but no organization; the default PAT file neither taken for a saved token nor written unless the settings name it; a settings file removed while AZPR runs; a settings file setup cannot change; the options of `/pr-setup`; a process that found no settings loading none when another process saves them, also after a save of its own, and settings or a token that took the place of the ones this setup saved (after a load that failed, in the moment its save ended, or in the moment before the load), settings its save left unusable (also where the token arrives right after the one look at its file, in the dialogs' save and in `/pr-setup --replace`), and settings switched off during the load, all left for the restart; one save at a time through the RPC and the options, until the load that follows it has ended; a first setup that cannot be loaded, a host call that fails on the way, a command name another plugin took (while AZPR starts, before a load, or at the last moment) left to that plugin, no command registered where the host cannot say which names are taken, a `/pr-setup` during a load putting nothing in its way, the commands that say "setup required" never put back over a runtime that was loaded meanwhile, and a save that ends after the plugin was unloaded. |
| 8 | The view itself (`tests/tui-view.test.mjs`, which loads the compiled `src/tui.js` with stand-ins for what the host provides). The wiring of the dialogs: the dialogs of one setup talk to the server part of the project whose session was on screen when they opened, also when a session of another project comes on screen before the save; they open only for the marked notice in the session on screen; a setup that is open when the part is unloaded saves nothing afterwards; a loaded first setup makes the terminal UI read that project's commands again; the hint's timers end with the part; and on a host without the dialogs or the RPC the part does nothing. The token field: typed characters, a paste with blanks and line breaks, keys that are no characters, backspace and ctrl+u; nothing it shows holds four characters of what was entered in a row, only bullets and a count; Enter hands the value on once; at most 2,048 characters are kept; an empty value is given only where a saved token may be kept; and the field forgets the value when it is unmounted. |
| 1 | `access` in the REST client: its request, one attempt also for transient failures, and the kind of each refusal, including the answers the live probe saw. |

**In the real terminal UI** (`tests/host-v2-tui-setup.mjs`, new). OpenCode's
TUI runs in a detached tmux session of 150 by 44 cells, and the fixture reads
its screen and types and pastes into it. AZPR starts without usable settings:
from source the installer's placeholder file, as the package no settings
file at all. Both installations passed every step:

| Step | Seen on the screen and on disk |
| --- | --- |
| The TUI starts | It says once that AZPR is not set up and names `/pr-setup`; every review command is described as "setup required". |
| `/pr-setup` | The organization dialog opens. An answer that names no organization is refused in the dialog; the URL of a pull request is taken. |
| Proxy | Asked next, with the note that Enter skips it; skipped. |
| Token | The dialog names where to create one for this organization. A pasted token appears as 16 bullets and its length. A token the fake Azure DevOps refuses is reported there and asked for again. |
| Azure DevOps unreachable | With every connection dropped, the dialogs report that Azure DevOps could not be reached, offer the proxy, and after it check the same token again, which is accepted. |
| Model | The host's models under their provider's name; typing filters them; the model's variants follow, with its own default first. |
| Saving | A summary, then the result with the next commands. The token file, made for it and named for the organization (`pat-fixture` in AZPR's directory), holds the token alone with mode 600 in a directory of mode 700; the settings file is complete, mode 600, and names it. Azure DevOps was asked twice: for the refused token and for the accepted one. |
| No restart | The review commands are the real ones, in the server's list and in the TUI's suggestions, and `/pr-check` answers READY. |
| `/pr-setup` again | The settings as a list with their values; typing filters them. The output language is changed: it is saved, a toast and the list's title name the restart, and `status` says `restart`. |
| After a restart | The change is in use, `/pr-check` is READY, and the TUI gives no hint. |

Setup asked no model. Neither token is on any screen the fixture read, in the
host's log, or in the conversation's inbox or messages; of everything the
fixture's OpenCode wrote (configuration, data, cache, state and home), only
the token file holds the accepted token, and nothing holds the refused one.

Two things about the host surfaced while this fixture was written. A change
of commands that a plugin makes after it was loaded is announced without a
location, and the terminal UI then keeps the suggestions it has: the server
part now publishes an event of its own, and the terminal part reads the
commands again. And the runtime's `fetch` tries a dropped connection again by
itself, so a fixture must drop every connection to be unreachable.

### Notices and the conversation's own model

**How OpenCode 2.3.0 hands waiting notices to a conversation's model.**
Measured on the real host without any plugin, with a fake model that records
each request: synthetic notices admitted through the HTTP API with
`resume: false`, queued or steered, then the conversation's model made to
run.

| Situation | Queued notices | Steered notices |
| --- | --- | --- |
| Idle conversation, 3 notices, before any prompt | 0 requests | 0 requests |
| The same, then one prompt | 4 requests: the prompt, then one per notice | 1 request: the 3 notices and the prompt together |
| The same, the prompt itself sent queued | 4 requests | 2 requests: the notices, then the prompt |
| 2 notices arrive while the model answers (one step) | 2 further requests after the answer, without a prompt | 1 further request |
| 2 notices arrive while the model is between tool calls | 2 further requests after the turn | none: both notices are in the turn's next request |
| Idle conversation, 2 notices, interrupted with `resume: true` | 0 requests; the notices wait | 0 requests; the notices wait |
| Idle conversation, 2 steered notices, the host restarted | — | 0 requests after the restart; 1 with the next prompt |

So a notice starts no model response only in an idle conversation, queued or
steered; that was already so before 0.4.3. What the change removes is the
request per notice. The terminal panel's fixture now requires it: after a
review, a comment run and the saved preview shown again, 16 notices wait in
the conversation's inbox; the fixture's one prompt then makes exactly 1
request of the conversation's model (17 with 0.4.2), and the inbox is empty
afterwards. The panel reads the same notices as before, from the inbox and
from the delivered messages.

### The host fixtures

The eleven host fixture runs passed on one tree (the hash of the code and
tests was the same before and after), the nine that existed with the request
counts of 0.4.2: fresh 110 model and 187 Azure DevOps requests, replace 92
and 157, native 110 and 194, comment scale 34 and 75, and with debug off 34
and 71, background compaction 8 and 8, and the terminal panel 15 model
requests by AZPR's sessions and 31 Azure DevOps requests, from source and as
the package. The two new setup runs made no model request and 16 Azure DevOps
requests each. In the native smoke run `/pr-setup` with options now ends in a
loaded runtime: its answer says so, the private roles are registered and
`/pr-review --help` answers, before the host is restarted.

`npm pack --dry-run` lists 37 files (36 for 0.4.2); `src/tui-setup.mjs` is
new. The native fixtures install that package. `package.json` has no
dependency and no lifecycle script.

### Reviews by a second model

Thirteen reviews of the pull request followed (GPT-6 Astra at its highest
reasoning effort through the Codex CLI, in a read-only sandbox on a clean
clone), each of the tree as corrected after the one before. The reviewer ran
the build check and the tests that write nothing, and reproduced what it
found in memory; the tests that write files and the host fixtures ran here,
on every corrected tree. The first twelve reviews reported 33 defects (5, 5,
4, 3, 3, 2, 2, 3, 1, 2, 2 and 1), each confirmed against the code and
corrected with a regression test; the thirteenth, of the code described
above, found nothing to change. All 33 were in setup, which is new in this
release, and none in the notices:

- **Which token belongs to which organization, and which file holds it**
  (11). Token and settings were not written under one lock. A token checked
  for one organization could be saved under another, and a check could read
  organization and token on either side of a save. A change of organization
  overwrote the earlier organization's token file before the settings were
  written. A first setup wrote the default PAT file, which several settings
  files of one person share, then a file of a name that other settings
  could already use, and two first setups for one organization chose one
  file, of which the failing one deleted the other's token. A token file
  that settings named without an organization was overwritten, and an
  organization could be given to such settings without a token of its own.
  Whether another organization needed its own token was decided by whether
  the token file could be read at that moment. A token in the default file
  was offered as saved although the save then failed.
- **Loading a first setup, and what setup reports as loaded** (9). `status`
  said ready where the runtime's preflight refuses new runs. Whether a save
  made the settings usable was judged on an earlier read; a save that left
  them unusable still made them the setup's own; what a save left was read
  from the files afterwards, and whether the settings could be used and
  which token went with them came from two looks at the token file (in the
  dialogs' save and in `/pr-setup --replace`). After a load that failed, a
  later save loaded whatever the settings file held by then. A load that
  loaded nothing (settings switched off meanwhile) counted as a load. A
  save through the dialogs and one through the options could overlap.
- **Other plugins' commands** (5). The commands that say "setup required"
  replaced a command that another plugin had registered under a review
  command's name: after a failed load, between AZPR's look and the
  runtime's, at startup, where the host could not list the commands, and
  after a load that succeeded while they were being put back.
- **What a save takes, reports and replaces** (4). One line of JSON passed
  for a token file and was replaced. A token with quotes around it was
  written and could then not be replaced. A settings write and a token
  replacement that had taken place were reported as failed when a
  temporary file could not be removed afterwards; in one case the token
  file was then deleted.
- **The terminal part** (3). The server part to talk to was chosen anew for
  every call, so a session of another project that came on screen got the
  save. A setup that was open when the part was unloaded went on to save. A
  model that may be off could not be switched off when OpenCode offered no
  model.
- **The answers of the RPC** (1). `validate` returned a newly typed proxy
  with its user name and password.

Between the reviews, a reread of the same code by its author changed
fourteen more things. The weightiest: a check without a token goes only
through the saved proxy and with the saved CA file, since a proxy and a CA
file of the caller's choosing could otherwise read the saved token; a CA
file must be a regular file; the default PAT file is no saved token unless
the settings name it; and a process loads only settings that a save of its
own setup made usable, where the first version loaded whatever was usable
after any save of its own. `tests/tui-view.test.mjs` came out of the second
finding about the terminal part: it loads the compiled view with stand-ins
for what the host provides, so that the wiring of the dialogs and the token
field are tested without a terminal.

Not covered: the dialogs against a live Azure DevOps organization (only the
request they send was probed); a real model's answer to a prompt that arrives
together with notices; terminal emulators other than tmux, and their way of
pasting; several settings files and several OpenCode processes on a real
host (the unit tests run them against the real handlers and file system);
other OpenCode versions.

## 0.4.2 after publication (2026-11-17)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
2.3.0, in isolated OpenCode profiles with the fake model and Azure DevOps
services.

- **The merged tree.** The pull request was merged with a merge commit whose
  tree is that of the candidate's last commit. CI passed on that commit, on
  `main` and on the tag.
- **Source archives.** The release's source archive, downloaded again, is
  byte-identical to the one built from the tag, and so is GitHub's own archive
  of the tag. Both passed the clean-directory installation check: 21 runtime
  modules, 9 prompts and the license as in the archive, the view's JSX source
  not installed, and `--replace` keeping the settings file byte for byte.
- **The Git package.** `github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.4.2`,
  installed by OpenCode's plugin manager, passed the native smoke fixture
  (110 model and 187 Azure DevOps requests) and the terminal panel's fixture
  (15 and 31), the compiled view loading from the package cache.
- **The npm package.** The registry's integrity and shasum for 0.4.2 equal
  those of the package built from the tag (36 files), and the tarball
  downloaded from the registry is byte-identical to it. Installed from the
  registry, the package passed the same two fixtures with the same request
  counts.

## 0.4.2 release candidate acceptance (2026-11-17)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, OpenCode 2.3.0 and
tmux 3.2a, with isolated OpenCode profiles and the fake model and Azure DevOps
services. One review, described below as live, ran with a real model on the
maintainer's OpenCode service and a test PR of an Azure DevOps organization;
everything else used neither. Nothing was posted.

0.4.2 adds the terminal panel (see [architecture](ARCHITECTURE.md#terminal-panel)),
lets a completed or abandoned PR take comments, and writes the settings a
version brings into the settings file. `src/` gained `tui-model.mjs`,
`tui-view.jsx` and the compiled `tui.js`. Of the server part, `config.mjs`
(one table of defaults, the setting `terminalPanel`), `setup.mjs` (the
completion of the settings file at load), `session.mjs` and `runtime.mjs`
(metadata on notices, two `/pr-check` rows), and `comment-work.mjs` and
`attribution.mjs` (publication and its receipt) changed; the prompts did not.
`install.sh` copies two more files, and `package.json` gained the `./tui`
entry and two development dependencies.

The candidate was built in two steps. The first held the panel alone, with
three commands and a preference kept by the terminal UI, and no change to the
server part; the nine fixture runs passed on it. The second reduced the panel
to `/pr-panel` and the setting `terminalPanel`, and added the two other
changes. What follows was run on the final tree unless it says otherwise.

- **Offline.** `npm run check`, which now also compiles `tui-view.jsx` and
  compares the result with `src/tui.js`, and 554 tests (489 for 0.4.1). Of the
  65 new tests:

  | Tests | What they hold |
  | --- | --- |
  | 30 | What the panel shows (`tests/tui-model.test.mjs`), one of them against the runtime's own `renderReceipt`: which run, status, rows and document for sequences of notices; a notice marked `terminalPanel: manual` opens nothing; only the runtime's own lines name sessions, and a session is a row or read only when it says itself that it is this conversation's and that run's; a run's other notices change nothing; a saved preview shown again is about its review, and a status never stands above another review's document; a comment run that ends without a preview leaves the report in view; commands typed in a review's own session; a quoted code block is shown as saved and a summary cell literally; a document that quotes its block's closing tag, or the form the runtime writes that tag in, is shown as it was written; a session counts as deleted only on the server's word, and then whatever the host still holds of it. |
  | 15 | What the panel reads of other sessions (`createReader`), with answers and waits that end when the test says so: a session is looked up before anything it holds is read; the inbox is read before the delivered messages, and its answer is held when the messages cannot be read; a notice the host reports is kept from the moment a session's notices are asked for, also when no request succeeds; a report is looked for in the inbox and then among the messages; a failed request is made again and a not-found answer is final; a lookup that failed waits for its next attempt however often it is asked for; a session reported as deleted stays gone when a lookup of it answers later; what was asked before a reconnection is dropped and read anew; the sessions read last are held, and one let go while its own read ended is read again; a session is not let go while a read of it is under way, however many others are read meanwhile, so that what its requests answer is held together; what was read stays held, and is not asked for again, while as many other reads as sessions are kept wait for their answers; a conversation's sessions are asked for once, page by page; nothing is asked after the plugin was unloaded. The last of them draws the order of events from fixed seeds: 240 runs of 160 steps, in which a small model of the server answers or fails the reader's requests while notices arrive and are delivered, sessions are deleted, waits end and the server reconnects, with 1, 2 or 3 sessions kept. After every step what the reader holds is compared with what it was told and with what the server has, and a read that ended must be marked as read; each of nine defects put back into the reader for a trial, eight of them ones that the reviews of this pull request had reported, failed it. The same model ran 12,000 further orders once, also with 24 sessions kept. |
  | 5 | Whole runs through the runtime, their notices read with the panel's model: a review, a preview, `--show` and a check; a review without findings and the note that no preview follows; a comment run typed in the session that holds the report, with `returnReport: full`; a comment run whose planning fails; a comment that quotes the closing tag of AZPR's own notice, which the preview, `--show` and the panel show as publication posts it. |
  | 1 | The text of a notice's block (`enclose`): it never holds the block's closing tag, and one level taken off gives back exactly the text, for the tag, the escaped form, forms escaped further or by halves and the other block's tag. |
  | 1 | The compiled file: no JSX left; imports only from `@opentui/solid`, `@opentui/core`, `solid-js` and the model beside it; no file or environment access; one slash command; nothing stored. |
  | 3 | The defaults: `terminalPanel`; one table of defaults that equals the settings example and the schema; a completed file validates to exactly what the file did, keeps every value and the order of its names, and lacks nothing afterwards. |
  | 8 | The completion at load: a file as 0.4.1's `/pr-setup` wrote it is completed, with mode 600 and no lock or temporary file left, and `/pr-check` is READY and lists what was added; a complete file is not replaced; a file that is switched off, invalid or a symbolic link is never rewritten, and `/pr-check` names what the link leaves out; a held lock is waited for, a lock left behind is not, and an unsafe directory or a hard link is refused with a reason that names no value; sixteen loads at once, in 25 rounds, write the file once per round and all read the same text; a save made by an editor while the file is completed is kept; a file switched off meanwhile is not rewritten; a load that stopped waiting accepts the completed file later, while a changed value still blocks. |
  | 1 | A completed and an abandoned PR: `/pr-check` READY with a WARNING row, the review, the preview, a typed and an automatic publication, each receipt naming the status; an active PR's check row and receipt as before. |
  | 1 | With `terminalPanel: manual` every notice of a review, a preview, `--show` and a check carries the mark; with the default no notice has metadata, and its fields are those of 0.4.1. |

  The publication test of 0.4.1 that expected a refusal for a completed PR now
  expects the comments, the status in the result and no second post; a changed
  source commit of such a PR is still STALE.
- **Loads at the same time.** The runtime compares the settings file with the
  text it read at load, so loads that happen together must all end up with
  the completed text. A first version failed the offline suite once in
  several runs: a load that opened the file just before another load replaced
  it found a file without a name and reported that the settings file was not
  a regular one. The file itself was complete and every load read it; the
  report would have been a false WARNING row in `/pr-check`. A stress script
  reproduced it, 11 such reports in 7,200 loads (300 rounds of 24). Since a
  load reads the file that is there now in that case, 900 rounds of 24 and of
  64 loads in one process, and 60 rounds of 8 separate Node processes started
  at the same moment, gave one writer per round, the final text for every
  load, no report and no file left behind.
- **The server part on the host.** The seven existing fixture runs passed with
  the request counts of 0.4.1: fresh 110 model and 187 Azure DevOps requests,
  replace 92 and 157, native 110 and 194, comment scale 34 and 75 (largest
  request 38,240 characters), background compaction 8, and with debug off 34
  and 71, and 8. The smoke fixture's own terminal step, which types
  `/pr-review` and `/pr-stop` into a real TUI, passed with the panel loaded.
  In the native run `/pr-setup` wrote a settings file that names every
  setting, and the host then loaded it unchanged.
- **The panel in the real terminal UI** (`tests/host-v2-tui-panel.mjs`, new).
  OpenCode's TUI runs in a detached tmux session of 170 by 46 cells; the
  fixture reads the screen and sends keys and mouse clicks. A 6-file review is
  typed into the TUI, and its reviewers are held until the panel was seen.
  The settings file starts without `terminalPanel`, `deletePrivateSessions`,
  `progressNotices` and `workflow.stageIdleSeconds`, as a version before them
  would have left it. Checked for a source installation and for the package
  as OpenCode's plugin manager installs it:

  | Step | What was seen |
  | --- | --- |
  | The host loads AZPR | The four settings are in the file at their defaults, the other values are unchanged, the file has mode 600 and no lock or temporary file is left. The review that follows starts, so the runtime read the completed file. |
  | A review starts | The panel opens by itself with the four reviewer sessions as running; text typed at that moment arrives in the prompt. |
  | A click on a session row | That session opens in a tab; back in the conversation the panel is there again. |
  | The review completes | Status COMPLETE; the report's table drawn as a grid; the report session listed; "4 session(s) were deleted". The receipt did not enclose the report (`returnReport: receipt`): the panel read it from the report session's inbox. |
  | `/pr-comment` | The panel opens again and shows the preview, named by its run and its source review; nothing was posted. |
  | Keyboard | After a click in the panel, Page Down scrolls, Home returns and Escape closes it. |
  | `/pr-panel` | The panel is shown and hidden; `q` closes a panel that has the keyboard. The TUI suggests no `/pr-panel-auto` and no `/pr-sessions`. A `--show` answer opens the panel again, and no notice in the conversation has metadata. |
  | 100 columns | A `--show` answer does not open the panel: a toast says that something is ready and the conversation stays on screen; `/pr-panel` shows the panel full screen, and Escape gives the screen back. |
  | `terminalPanel: manual` | The host is stopped, the setting changed and the host and the TUI started again. A comment run that starts, the preview it returns and a `--show` answer each carry `metadata.azpr.panel: "manual"` in the conversation's inbox, and the panel stays closed without announcing itself; `/pr-panel` then shows the newest preview. |
  | The TUI started in the report session | The conversation is neither on screen nor in a tab, and its notices were delivered beforehand (the fixture prompts the conversation's own model once). `/pr-panel` shows what the conversation was told last, read from the server, and lists the session on screen as the one holding the report. `/pr-comment` typed there is answered in that session, and the panel shows the new preview; the conversation is told nothing more. |

  Each run made 15 model requests by AZPR's reviewers, verifier and planner
  and 31 Azure DevOps calls. The panel asked no model. The conversation's own
  model ran only when the fixture prompted it before the last step; OpenCode
  2.3.0 then answered the prompt and gave each of the 16 notices waiting in
  the conversation's inbox a turn of its own (17 requests).
  The host's log has no `plugin operation failed` line. With the package, the
  compiled view loaded from OpenCode's package cache, and the cache held
  neither `@babel` nor `babel-preset-solid`. On the first step of the
  candidate the fixture had passed nine times, with 11 model requests and 17
  Azure DevOps calls; its first run on GitHub's runner then failed before the
  TUI started, because the checkout's path made tmux's socket path longer
  than a Unix socket allows. The socket is now created in a short temporary
  directory.
- **Settings closer to an everyday installation**, by hand in the same kind of
  profile, on the first step. With `debug.enabled`, `afterReview: preview` and
  `returnReport: full`, the panel showed the preview that followed the review
  by itself, and listed all seven sessions of the review and its preview. The
  TUI was closed and started again while a review ran: `/pr-panel` then listed
  that run's sessions, which it found through the server.
- **A receipt of a live run**, on the first step. The preview receipt of the
  1-file PR from the 0.4.1 live runs (zh-TW, with a three-column table) was
  queued into a fixture conversation. The panel drew the table with the CJK
  text aligned and showed the escaped table cells (`&#96;reserve&#96;`) as
  their characters.
- **A live review with the panel.** Commit `74d450d` of the candidate was
  installed through the plugin manager on the maintainer's OpenCode 2.3.0
  service, with every role on `openai/gpt-6-luna`, `afterReview: preview`,
  `returnReport: full`, English output and no debug records. The TUI was
  attached to a conversation in a recorded terminal of 132 by 38 cells, and
  `/pr-review` of the 35-file test PR was sent to that conversation through
  the host's command API.

  | Moment | What the panel showed |
  | --- | --- |
  | The run starts | It opens by itself beside the conversation: the run as RUNNING, then the four reviewer sessions (two roles, two shards) as running and, one by one, as idle, and the verifier. |
  | The review completes, after 76 seconds | The report rendered, with its summary table; the session that holds the report; "4 session(s) were deleted when their run ended". The four reviewers had reported no candidate; the verifier found the seeded regression in `json_schema.py` itself, one medium finding. |
  | The automatic preview, 8 seconds later | The comment run with its planning session while it ran, then the preview in the report's place: a summary and one inline comment. Nothing was posted. |
  | A click in the panel, Page Down, Home | The preview scrolled to the inline comment and back to its top. |

  With `returnReport: full` the receipt encloses the report, so the panel
  took it from there; reading it from the report session's inbox, the path
  of the default setting, ran in the fixtures only. No session row was
  opened. The [demonstration](DEMO.md#the-terminal-panel) is an edit of this
  recording. The service's plugin entry and settings were then restored from
  their backups, byte for byte.
- **Package.** `npm pack --dry-run` lists 36 files (33 for 0.4.1); the three
  files of the terminal part are new. The native fixtures install that
  package. `package.json` has no dependency and no lifecycle script.
- **Reviews by a second model.** Ten reviews of the pull request followed the
  second step (GPT-6 Astra at its highest reasoning effort through the Codex
  CLI, in a read-only sandbox on a clean clone), each of the tree as
  corrected after the one before. The first nine reported 33 defects (8, 5,
  7, 3, 3, 4, 1, 1 and 1); the tenth, of the tree to which only the
  recording and its documentation were added afterwards, found nothing to
  change. Three were in the completion of the settings file: a save from an
  editor while the file was completed was overwritten, a load that had
  stopped waiting later refused every command over the defaults another load
  wrote, and a file switched off meanwhile was still rewritten. The other 30
  were in the panel, which is new in this release:
  - What it is about. A status stood above another review's report; a saved
    preview of an older review was shown under the newest run; a run's note
    after its receipt was taken for the receipt; the empty preview block of a
    comment run that failed blanked the panel.
  - What it takes as fact. Stage lines and the report session were read from
    the enclosed report as well, whose text a model wrote; an inbox was read
    before its session had proved to be this conversation's, and a report
    from a session of another run; a session of 0.4.0 was taken for a
    conversation.
  - What it reads of other sessions. The notices of a command typed in a
    review's own session, of a conversation after the TUI was restarted, and
    those already delivered were not read; a notice that arrived during a
    read, between its two requests or after requests that failed was lost;
    an answer from before a reconnection was kept; a session counted as
    deleted after a request that had merely failed, and a deleted one came
    back when a lookup answered late; the attempts of a lookup that failed
    were used up at once; paging went on after the plugin was unloaded; a
    session was let go between the two requests of its own read, and, once
    that was corrected, a session just read lost its place to reads that
    were waiting and was read again and again.
  - What it shows of a document. References and markers were decoded or
    removed inside quoted code; decoded underscores became emphasis; a
    document that quotes its block's closing tag was shown in the escaped
    form of the notice.
  - Its timers could act on another plugin's panel after it had closed.

  The corrections moved the panel's reading of other sessions out of the view
  into `createReader`, where its order and its races are tested with answers
  that arrive when the test says so, and added the test that draws the order
  of events from fixed seeds.

What the development of the panel showed about OpenCode 2.3.0, each handled in
the code and described in the architecture page:

| Observation | Consequence |
| --- | --- |
| A `.tsx` terminal entry in a package that the plugin manager installed fails to load ("Cannot find package 'react'"): OpenTUI 0.8.4 compiles no JSX under `node_modules`. | The package ships the view compiled. anomalyco/opentui#2051 restores the compilation in OpenTUI 0.9.0; OpenCode's `dev` branch still pinned 0.8.4 on 2026-11-17. |
| The host gives the keyboard to a panel that opens. | The panel hands it back with the host's `pane.focus.left` command, and withdraws where that is not possible. |
| The host drops the messages and the inbox of sessions that are neither on screen nor in a tab, also after a plugin loaded them. | A first version read the report from the host's cache and intermittently found none. The panel reads the report session's inbox from the server. |
| The host closes a panel when the screen leaves its session. | The panel opens again when the screen returns. |
| A toast wraps at about fifty characters. | The panel's messages fit one line. |

Not covered: more than one review with a real model and the panel open, and
such a review with the default `returnReport`; terminal emulators
other than tmux, in particular their mouse reporting; a change of theme while
the panel is open; a review with dozens of sessions in the panel; OpenCode
versions other than 2.3.0; the desktop app, which does not load the panel;
comments on a completed or abandoned PR of a real Azure DevOps organization
(the fake service accepts a thread on any PR; if Azure DevOps refused one, the
item would be FAILED with its error in the receipt); the completion of a
settings file by several OpenCode processes at once on a real host (the
stress runs above used loads in one process and separate Node processes).

## 0.4.1 after publication: live reviews and session cleanup on real hosts (2026-11-16)

Environment: Ubuntu 22.04.5 under WSL2 and Node 22.23.3. AZPR 0.4.1 was
installed from npm as a native package on the maintainer's OpenCode service,
first on OpenCode 2.2.4 and, after that host was upgraded, on 2.3.0. Every
role used `openai/gpt-6-luna`, `afterReview` was `preview`, and nothing was
posted to Azure DevOps. The fixture runs at the end used isolated profiles
and the fake model and Azure DevOps services.

- **Publication.** The registry's integrity and shasum for 0.4.1 equal those
  of the package built from the tag, and the tarball downloaded from the
  registry is byte-identical to it. The native smoke fixture passed with the
  package installed from npm and with the Git package at the tag, each with
  110 model and 187 Azure DevOps requests. The release's source archive and
  GitHub's archive of the tag passed the clean-directory installation check.
- **Live reviews.** `/pr-review` with its automatic preview, once per PR and
  host:

  | OpenCode | PR | Review | Stages | Confirmed | Preview | Cached input |
  | --- | --- | --- | --- | --- | --- | --- |
  | 2.2.4 | 1 file | COMPLETE, 75 s | 3 | the 3 known defects | PREVIEW | 58% |
  | 2.2.4 | 35 files | COMPLETE, 65 s | 5 | seeded defect 1 of 2, one test weakness | PREVIEW, 1 inline comment | 52% |
  | 2.3.0 | 1 file | COMPLETE, 70 s | 3 | the 3 known defects | PREVIEW | 57% |
  | 2.3.0 | 35 files | COMPLETE, 65 s | 5 | seeded defect 1 of 2 | PREVIEW, 1 inline comment | 55% |

  Times are to the nearest 5 seconds. Every stage completed in its first
  session, without a tool failure, a retried step or a continuation, and
  Azure DevOps calls needed no retry.
  Every private session had no parent, AZPR's metadata and the
  conversation's directory. On both hosts the conversation itself made no
  model request: its session had no messages and no tokens. The seeded defect
  that was missed is the one gpt-6-luna has missed before (see
  [known limitations](#known-limitations)). On 2.3.0 `/pr-check` showed the
  OpenCode row as the tested version; on 2.2.4 it showed the WARNING row. The
  commands without a review ID (`--list`, `--help`, `--show` and
  `--exclude F-1`, which planned a new preview) were used in the 1-file
  conversation on 2.2.4.
- **Prompt cache.** Cached tokens were 52% to 58% of the input in these four
  reviews. The last review of the 1-file PR with child sessions (the 0.3.7
  candidate on OpenCode 2.2.4, same prompts and model) had 65%, and earlier
  reviews of the 35-file PR with child sessions, on other AZPR versions and
  hosts, had roughly 40% to 70%. With one run per case this does not separate
  an effect of sessions of their own from the variation between runs.
- **Deletion with a real provider.** The reviews above ran with
  `debug.enabled`, which keeps every session. One more review of the 1-file
  PR ran on OpenCode 2.3.0 with debug off: the receipt reported 2 reviewer
  sessions deleted, the service no longer had the two reviewers' sessions,
  the session holding the report was still there, no session of the
  automatic preview's run was listed afterwards, and the saved review named
  one session and none still to be deleted.
- **Deletion in the host fixtures.** Until now every host fixture ran with
  debug on, to read its records, so the deletion of a run's sessions was
  covered by the offline tests and had not run on a real host. The
  comment-scale and background-compaction fixtures now have a `--cleanup`
  mode with debug off, which CI runs. On OpenCode 2.3.0: the 120-file review
  named 15 sessions in its receipt, 14 were deleted and counted in the
  `Session notice`, and the host listed one private session, the report; a
  preview planned in 8 sessions and left none; publication from that preview
  created the 20 threads; a command typed in the report session was
  answered; no session record was left (34 model and 71 Azure DevOps
  requests). The review that ends PARTIAL named 3 sessions, 2 were deleted,
  and the session holding the draft was the only one left, named by the
  run's record of kept sessions (8 model requests). The default modes of both
  fixtures passed unchanged (34 and 75 requests, largest 38,240 characters;
  8 model requests). Before the host was upgraded, the same checks, made
  with a copy of the released tree, passed on OpenCode 2.2.4 with the same
  session counts.

Not covered: the 316-file PR, `/pr-quick`, `/pr-deep`, publication and other
models on OpenCode 2.3.0; a person stopping a private session's tool call;
and repeated runs that would measure the prompt cache.

## 0.4.1 release candidate acceptance (2026-11-16)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.3.0, installed into a disposable prefix next to the system's 2.2.4. The
candidate moves the tested host to OpenCode 2.3.0. It changes how private
sessions are created and which of them are kept, how a model stream that
OpenCode recovered by itself is read, and how a stopped tool call ends, as
described under
[OpenCode 2.3.0 compared with 2.2.4](#opencode-230-compared-with-224-2026-11-15-and-16).
The prompts under `src/prompts` are those of 0.4.0, byte for byte, so the
locked prompt hashes did not change.

- `npm run check` and **489 offline tests** passed (449 for 0.4.0). Of the 40
  new tests, 13 cover the changes themselves: a session of its own at the
  conversation's location, with AZPR's metadata and no parent, and what
  creation refuses; a cancellation while the conversation is read; a
  completed review that keeps only the session holding its report, while its
  other sessions and those of a comment run are deleted, and debugging, which
  keeps them all; a deletion that fails and stays on record, for a completed
  and for an unfinished review; a step the host retried, alone, after tool
  calls, twice in a row and next to a continuation, and 18 altered turns it
  must not excuse; the `step-retries` counter; and a stopped tool call whose
  own request is aborted while a read the run shares goes on. The other 27
  were added with the corrections described below.
- All five real-host fixtures passed on OpenCode 2.3.0 with isolated profiles
  and fake model and Azure services: fresh 110 model and 187 Azure DevOps
  requests, replacement 92 and 157, native packed package installation 110
  and 194, the comment-scale fixture 34 and 75 (largest provider request
  38,240 characters) and background compaction 8 model requests. These are
  the counts of 0.4.0 plus the new stream-cut step (3 model and 7 Azure
  DevOps requests) and one more read in the background fixture. In the smoke
  fixture the conversation's model received no request while the review ran,
  each of the review's four private sessions had no parent, the
  conversation's location and AZPR's metadata, a quick answer that broke off
  mid-stream was retried by OpenCode in the same session (3 requests,
  `step-retries=1`), and the TUI step told its conversation from the private
  sessions by that metadata.
- The same tree passed all five fixtures on OpenCode 2.2.4 with the same
  request counts, in a copy whose tested-version constant was 2.2.4 and whose
  stream-cut step expected what that host does (a continuation notice,
  `stream-continuations=1`).
- `npm pack --dry-run --json` lists **33 files** (about 202 KB), the same
  files as 0.4.0.
- The 230 local Markdown links, images and anchors outside code examples
  resolve.
- Seven reviews of the pull request by a second model followed, each of the
  tree as corrected after the one before. The first six reported 17 defects,
  and three more of the same kind were found while correcting them; the
  seventh found nothing to change. One defect was in the stopped tool call:
  a call stopped while the text it had read was being saved for comment
  planning waited for that save and was credited with the read. One was a
  sentence in the README and the changelog. The others were in the cleanup
  of private sessions, which is new in this release. They needed a command
  typed in a reviewer session while its run ended, an OpenCode that is slow
  or fails to delete a session, or a process that ends during a cleanup:
  - A session that a running command still answered in was deleted.
  - A review, or an unfinished run's record of its sessions, was evicted
    while its cleanup, its receipt or the comment step after it still needed
    it, and a later save could bring an evicted review's record back.
  - Sessions were deleted before a record named them, or a record was removed
    before its sessions were gone, so a process that ended in between forgot
    them. A session that could not be deleted was not tried again, or was
    recorded as one its run keeps.
  - A deletion OpenCode had not answered in time counted as settled, so the
    session took commands again, also after a plugin reload.
  - A review could be started from a private session once the review that
    kept it was evicted.
  - Two were introduced by corrections. A comment run whose planning had
    failed erased the preview that a later command saved while the first
    run's sessions were being deleted. Its correction then let a run choose
    its review as the conversation's current one before that wait, so that
    its receipt could arrive last while a command without an ID acted on
    another review and its PR.

  The cleanup as it is now is described under
  [authorization and isolation](ARCHITECTURE.md#authorization-and-isolation).
  The 27 offline tests added for these cases include a restart during a
  cleanup, deletions that OpenCode refuses, never answers or answers with
  `Session.NotFoundError`, 20 later runs while a cleanup waits, and commands
  typed while sessions are being deleted. On a copy of the tree each
  correction was removed in turn and a test failed, except for safeguards
  that another check also covers.
- The final tree passed `npm run check`, the 489 offline tests and the five
  real-host fixtures again, on OpenCode 2.3.0 and, in the copy described
  above, on 2.2.4, with the request counts above.
- The Git archive of the final code commit, extracted into a clean directory,
  installed with `install.sh`: the 19 runtime modules, 9 prompts and the
  license match, and `--replace` kept the settings byte for byte with mode
  600 and an unrelated file in place. The link and package checks above
  passed on that archive too.
- That commit, installed from GitHub as a public Git package in an isolated
  profile on OpenCode 2.3.0, passed the native smoke test with 110 model and
  187 Azure DevOps requests.
- No live review with a real model ran on this candidate, on either host, and
  nothing was posted to Azure DevOps. The effect of sessions of their own on
  a provider's prompt cache is therefore not measured.

This is a pre-publication record. Registry integrity and installation from npm
are checked only after publication, following the
[releasing guide](RELEASING.md).

## OpenCode 2.3.0 compared with 2.2.4 (2026-11-15 and 16)

Environment: Ubuntu 22.04.5 under WSL2 and Node 22.23.3. OpenCode CLI 2.3.0
(published 2026-11-13, 908 commits after 2.2.4) was installed into a
disposable prefix next to the system's 2.2.4; both embed Bun 1.4.4. Every run
used isolated profiles and the fake model and Azure DevOps services; no real
model or Azure request was made. The upstream source of both tags was read
for each host interface AZPR uses. "0.4.0" below is the released tree and
"the candidate" is 0.4.1.

| Check | Observed |
| --- | --- |
| Sessions with a parent | OpenCode 2.3.0 hands every answer of a session that has a parent to the parent as a `<subagent>` message and wakes the parent's own model; 2.2.4 does not. 0.4.0, whose private sessions are children of the conversation, on 2.3.0 with a 2-file review: 12 model requests, 7 of them by the conversation's own model (agent `build`, offered 12 tools, among them edit, shell and write), which received three `<subagent>` messages with reviewer and verifier output and answered each AZPR notice. With the 120-file fixture, one run made 64 model requests instead of 34 (the number varies with timing), the largest 66,776 characters instead of 38,266. The candidate on 2.3.0: 5 requests, none by the conversation, and its five notices stayed in the conversation's inbox. |
| Model requests | The comment-scale fixture's 34 requests are byte-identical between 0.4.0 (children) and the candidate (sessions of their own) on OpenCode 2.2.4, once per-run values (paths, IDs, dates) are normalised. Between 2.2.4 and 2.3.0 the candidate's system prompts and AZPR tool definitions are identical; every request differs only in the host's own `read` tool definition, which is 12 characters shorter on 2.3.0. |
| Interrupted stream | OpenCode 2.3.0 no longer queues a continuation notice after a stream breaks off. It retries the step: the errored assistant message stays, marked for retry, and the next assistant message is the retried step, sent with the step's tool calls that ran and without the text that was cut off. 0.4.0 on 2.3.0, a quick review whose answer broke off once: both sessions FAILED as transient and the review was INCOMPLETE. The candidate: COMPLETE in the same session with 3 requests, `step-retries=1` on 2.3.0 and `stream-continuations=1` on 2.2.4. |
| Session placement | A session created without a parent takes the location it is given, otherwise the plugin instance's. The candidate passes the conversation's location; the created sessions reported the conversation's directory on both hosts. |
| Session list and archive | OpenCode lists sessions without a parent that are not archived. On 2.3.0 a plugin's `session.update({ archived: true })` is accepted and has no effect (the HTTP API does archive), so AZPR deletes instead. Session metadata set at creation is returned by the session API on both hosts. |
| Missing sessions | A probe plugin created a session, deleted it, deleted it again and read it. On both hosts the second deletion and the read, like the read of an ID that never existed, were rejected with an error whose `_tag` and `name` are `Session.NotFoundError`. The candidate takes only that answer, or a confirmed deletion, as a session that is gone. |
| Background summary | 2.2.4 starts one at 85% of the compaction ceiling; 2.3.0 starts one within 60,000 tokens of the ceiling, at most half the room the session began with, so a single response never reaches it. The fixture's functional reviewer now reads two files and reports the large context with its second response; the refused summary and the permanent failure that follows are as before on both hosts. |
| Full workflow | The fresh smoke fixture made 110 model and 187 Azure DevOps requests on both hosts, replacement 92 and 157, native 110 and 194; the inactivity watchdog stopped a stalled stream after 60.0 s on both, and a provider 503 was retried in the same session. |
| Tool scopes | Private reviewers saw the six AZPR tools plus `read`, `glob` and `grep` on both hosts, also with a foreign MCP server behind CodeMode and an image model configured. |
| Stopping a tool call | On both hosts a tool's `signal` aborts when its call is interrupted. On 2.3.0 a tool that read the signal is also told when a person stops the call, and is interrupted if it has not settled 5 seconds later (source). The candidate reads the signal once per call; this path is covered by an offline test, not by a host fixture. |
| Unreachable provider | With a provider host name that does not resolve, 2.2.4 gave up after 10 retries in each session (89 s and 82 s), and the review was INCOMPLETE after 172 s and two sessions. 2.3.0 retries such failures on a budget of its own, with gaps up to 30 s for up to an hour (source): after 161 s the first session was still retrying (9 retries, all allowed by AZPR), and `/pr-stop` ended the review as CANCELLED. |
| Cache warming | With warming every 3 seconds for 20 seconds configured, no provider request followed the two of a quick review of the candidate on 2.3.0. |
| Routing models | 2.2.7 added GitHub Copilot's Auto, which resolves a session's model through the `experimental.model.resolve` hook; the session hooks then receive the routed model (source only, not run with a Copilot account). AZPR refuses a request on another model than the configured one, so such an entry cannot be an AZPR model. |
| Plugin loading | On 2.3.0, `opencode plugin add …@0.3.7` while the server ran: the seven commands appeared 0.5 s later. Adding 0.4.0 and removing 0.3.7: 0.4.0 was the only active entry 0.5 s later, without a restart. A server started with `OPENCODE_DISABLE_FILEWATCHER`, as the fixtures' servers are, did not pick up the change. |
| Plugin API | Otherwise additive in the parts AZPR uses: a `fork` session hook, the experimental `experimental.model.resolve` hook, freeform tools, the cooperative stop above, and a `session.step.first-token` event. The hooks, session methods, request kinds, message types, permission actions and plugin list AZPR uses are unchanged. |
| Proxies | 2.3.0 still adds `127.0.0.1`, `localhost` and `::1` to `NO_PROXY`; the smoke fixture reached its proxied Azure DevOps service on 127.0.0.2 through one `CONNECT` tunnel. |
| Database | No migration was added between 2.2.4 and 2.3.0 (the same 59 migration files). |
| Terminal UI | `opencode --prompt "/pr-review …"` can still submit before the command catalog loads (the same source path; see [debugging](DEBUGGING.md)). The fixture's interactive submission and `/pr-stop` in new and existing conversations passed. |

Not covered: real providers and Azure DevOps on 2.3.0, a provider's prompt
cache with sessions of their own, a person stopping a private session's tool
call in the TUI, GitHub Copilot's Auto with a real account, and Desktop
features.

## 0.4.0 release candidate acceptance (2026-11-14)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.2.4. The candidate changes command texts, which review a `/pr-comment`
command without an ID acts on, two defaults and two reports, as described
under [commands without review IDs](#commands-without-review-ids-a-preview-by-default-and-two-report-checks-2026-11-13-and-14).
The prompts under `src/prompts` are those of 0.3.7, byte for byte, so the
locked prompt hashes did not change.

- `npm run check` and **449 offline tests** passed (432 for 0.3.7).
- All five real-host fixtures passed on OpenCode 2.2.4 with isolated profiles
  and fake model and Azure services, with the request counts of 0.3.7: fresh
  107 model and 180 Azure DevOps requests, replacement 89 and 150, native
  packed package installation 107 and 187, the comment-scale fixture 34 and 75
  (largest provider request 38,252 characters) and background compaction 7
  model requests. The fixtures set `afterReview` to `none` and start each
  comment step themselves; the default preview is covered by the offline
  tests. In the smoke fixture the OpenCode TUI, 160 columns wide, lists
  `/pr-review` with the start of its new description before the command is
  typed. On the first run the three smoke fixtures failed at that step, which
  still waited for the earlier description; they passed once it waited for the
  new one.
- `npm pack --dry-run --json` lists **33 files** (about 193 KB), the same
  files as 0.3.7.
- The 223 local Markdown links, images and anchors outside code examples
  resolve.
- The Git archive of the first release commit, extracted into a clean
  directory, installed with `install.sh`: the 19 runtime modules, 9 prompts
  and the license match, and `--replace` kept the settings byte for byte with
  mode 600 and an unrelated file in place. The link and package checks above
  passed on that archive too.
- That commit, pushed and installed from GitHub as a public Git package in an
  isolated profile, passed the native smoke test with 107 model and 180 Azure
  DevOps requests.
- A review of the pull request then found that looking at a saved preview
  with `--show`, or repeating a review's adjustments, made that review the
  current one in the running process only. Reproduced offline with two PRs
  behind the fake service: after a restart, `/pr-comment --publish` without
  an ID acted on the conversation's other review and posted to its PR. The
  choice is now saved when it is made; a comment run makes its review the
  current one when it ends, which the automatic preview did not do although
  its receipt says no ID is needed; and the times that order reviews come
  from a counter that never repeats or runs backwards. Three offline tests
  cover two PRs with a restart before a publication without an ID, an
  automatic preview that ends after another review was looked at, and a
  saved review whose time of use lies ahead of the clock. The corrected tree
  passed `npm run check`, the 444 offline tests and the five real-host
  fixtures again, with the same request counts. Both installation checks
  above were repeated on the corrected commit and passed: its Git archive in
  a clean directory, with the link and package checks, and the commit
  installed from GitHub as a public Git package, again with 107 model and 180
  Azure DevOps requests.
- A second review found the same loss when commands overlap: a choice made
  while the save of an earlier choice of that review was under way shared
  that save, which had read the review before, so the record kept the earlier
  choice. Reproduced offline: `--show` of A, B and A again, without waiting;
  after a restart B was current and `/pr-comment --publish` posted to B's PR.
  Every write of a review's record now goes through one queue per review, and
  a selection is saved by a write that reads the review when it starts: a
  choice made while a save writes gets a save of its own after it. The removal
  of an evicted review uses the same queue, so a save under way cannot bring
  its file back. Five offline tests were added: the overlap with and without
  the first save already writing, which both failed on the earlier commit
  (the second takes the path where a choice arrives during a save, checked
  with a temporary log), a command refused because another one is running
  that still saves its choice, and three tests of the queue with saves the
  test finishes by hand. The corrected tree passed `npm run check`, the 449
  offline tests and the five real-host fixtures with the same request counts.
  Both installation checks were repeated on that commit and passed: its Git
  archive in a clean directory, with the link and package checks, and the
  commit installed from GitHub as a public Git package, with 107 model and
  180 Azure DevOps requests.
- No live review with a real model ran on this candidate, and nothing was
  posted to Azure DevOps.

This is a pre-publication record. Registry integrity and installation from npm
are checked only after publication, following the
[releasing guide](RELEASING.md).

## Commands without review IDs, a preview by default and two report checks (2026-11-13 and 14)

0.4.0 changes how commands are typed and what two reports say; it does not
change what reviewers and verifiers are told.

- A `/pr-comment` command without a review ID, adjustments included, acts on
  the conversation's current review: the one completed or used there last, or
  in one of a review's own sessions that review. The start notice and the
  receipt of a comment run name the review and its PR by number and
  repository; the PR's title, which is text from the PR, stays inside the
  report's data block. A preview's receipt ends with the next commands.
- `/pr-comment --list` and `--help` of every command answer without a run.
- `afterReview` defaults to `preview` for every mode, `workflow.parallelSessions`
  to 8 and `azure.concurrency` to 6.
- A review whose content search was refused states that among its limitations
  and in its receipt.
- A verifier's confirmation whose suggestion is only a placeholder gets a
  correction turn and is NEEDS_INFO if it stays that way.

What supports them:

- **Offline tests** drive the runtime with a fake host and a fake Azure DevOps
  service: two reviews in one conversation, where commands without an ID
  follow the review used last, also from a review's own session and after a
  restart, with two PRs and a publication without an ID after the restart, also
  when the commands overlap; the receipt lines and next steps, including examples that keep
  saved adjustments; `--list` and `--help` without a model or Azure DevOps
  request; a review followed by a preview where the settings do not name
  `afterReview`, and `--no-comment`; and a review of a repository whose
  archive exceeds a 1 MB limit, with the notice in the receipt, the saved
  review and the debug record.
- **The placeholder check, replayed on stored results.** We ran the check over
  the verifier results of our stored benchmark runs (the ReviewBench test set
  and Martian's benchmark, with 0.3.4 to 0.3.7 and experimental builds):
  15,376 confirmations, 6,136 by Claude Opus 5.5, 5,921 by GPT-6.1 Sol, 2,752
  by GPT-6 Luna and 567 by other models. It sent back 3, all from GPT-6 Luna:
  their suggestions were "N/A", "Not applicable." and "No correction needed.",
  and in each the verifier's own reason refuted the finding. Two of the three
  were medium and would have received an inline comment. No other confirmation
  matched, so the check added no correction turn to a GPT-6.1 Sol or Claude
  Opus 5.5 review.
- **Parallelism** rests on the earlier
  [parallelism runs](#live-runs-parallelism-and-the-corrections-review-only):
  one 316-file PR, one provider and one organization. Nothing new was
  measured.

Limits:

- No live model run used this build. The comment commands, the default
  preview and both report checks were exercised with fake models only, and the
  content-search notice was not seen against Azure DevOps Services.
- The placeholder check reads a few fixed spellings in English and Chinese and
  only a verifier's confirmations. In the same stored runs, 21 of 3,936
  findings filed by GPT-6 Luna reviewers carried such a suggestion (none of
  about 17,800 from GPT-6.1 Sol and Claude Opus 5.5); verifiers rejected 19 of
  them. `/pr-quick` has no verifier and is not covered: too few quick results
  are stored to measure it.
- The real-host fixtures do not run the default preview, and the TUI step
  shows only `/pr-review`'s description at one terminal width. In a screenshot
  of a narrower terminal the list showed 58 characters of a description; the
  new descriptions say what a command is for within 52.
- Which review is current depends on the order of commands in a conversation;
  a command copied from an older receipt without an ID acts on the current
  review, which is why receipts keep the form with the ID.

## 0.3.7 release candidate acceptance (2026-11-12)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.2.4. The candidate changes the reviewer and verifier instructions, hands
candidates to the verifier without the reviewer's severity and adds an
optional severity rating, as described and run under
[severity from verified harm](#severity-from-verified-harm-2026-11-11-and-12).
Without a rater a review runs the same stages as in 0.3.6, and `/pr-quick`
keeps its flow.

- `npm run check` and **432 offline tests** passed (424 for 0.3.6). The locked
  prompt hashes changed for the functional, risk, verifier and duplicate-check
  roles in both checked variants, and the rating role has its own; the
  comment-plan prompts are unchanged.
- All five real-host fixtures passed on OpenCode 2.2.4 with isolated profiles
  and fake model and Azure services. The smoke fixture names a rater with a
  model of its own. Its fresh run made 107 model and 180 Azure DevOps requests
  (99 and 180 for 0.3.6; the eight additional model requests are the
  rating's), replacement 89 and 150 (83 and 150; six for the rating) and
  native packed package installation 107 and 187. The rating session was
  offered no tool and received the confirmed finding without a severity. The
  comment-scale fixture names no rater: no rating session ran and no rating
  role was registered (largest provider request 38,252 characters, 37,119 for
  0.3.6, from the longer instructions). Background compaction passed too.
- A clean copy of the candidate tree installed with `install.sh`: the 19
  runtime modules, 9 prompts and the license match, and `--replace` kept the
  settings byte for byte with mode 600 and an unrelated file in place. For
  settings written by an earlier version, the offline tests check that
  `--replace` adds the empty `rater` entries and keeps every other value. The
  214 local Markdown links, images and anchors outside code examples
  resolve.
- `npm pack --dry-run --json` lists **33 files** (about 184 KB): the 32 of
  0.3.6 and `src/prompts/rating.md`.
- A review of the pull request found that the README still gave the session
  count of a build in which the rating ran by default; it now says three
  sessions, or four with a rating model.
- The pushed release commit, installed from GitHub as a public Git package in
  an isolated profile, passed the native smoke test with 107 model and 180
  Azure DevOps requests. Its Git archive, extracted into a clean directory,
  passed the installation, link and package checks above again.
- Live, with a comment preview (2026-11-12): the candidate, installed from its
  public Git commit in the home OpenCode 2.2.4 service, ran with
  `openai/gpt-6-luna` on the 1-file test PR, with settings written by 0.3.6
  that name no rater. `/pr-check` was READY in 5 s. `/pr-review` was COMPLETE
  in 70 s with three sessions, no rating session, no retry and no repair
  turn: it confirmed the PR's three known medium defects (reservation
  atomicity, snapshot isolation and absolute-time ordering) and merged the
  three other candidates into them. The comment preview, planned with the same
  model, proposed the summary and no inline comment, since existing threads
  on the PR already discuss all three findings. Nothing was published; the
  service then returned to 0.3.6.
- After these checks, ReviewBench's judge
  [scored the Claude Opus 5.5 run](#scored-by-reviewbenchs-judge-2026-11-12),
  and the README, the release notes and this record were updated with its
  scores; `src/` did not change. The updated tree passed `npm run check`, the
  432 offline tests, the link check (217 links) and the five real-host
  fixtures again.
  The `v0.3.7` tag, first created before this update, was moved to the commit
  that includes it before the npm package was published.

This is a pre-publication record. Registry integrity and installation from npm
are checked only after publication, following the
[releasing guide](RELEASING.md).

## Severity from verified harm (2026-11-11 and 12)

Severity decides where a finding appears: high and medium findings get an
inline comment, low findings only a line in the summary. In the
[0.3.6 measurement](#reviewbench-which-was-not-used-to-write-it), `/pr-deep`
with Claude Opus 5.5 labeled low 96 of the 190 findings that ReviewBench's
judge rated medium or high. 0.3.7 changes how the level is set and tightens a
few rules about what a finding states:

- A change that breaks something the base commit handled is at least medium,
  however rarely it is used, and documented steps that worked before the
  change and fail after it count as such a regression. An easy fix and an
  effect the reviewer could not confirm no longer lower a level.
- The verifier receives candidates without the reviewer's severity and sets
  the level from the harm and trigger it verified.
- An optional severity rating (`models.<mode>.rater`): after verification, a
  session without tools sets each confirmed finding's final level from the
  finding's text and the PR's title and description. It runs only where a
  rater is named.
- A finding states one defect, and a merge in verification keeps a defect that
  only the merged finding named. Before asking the author about intent, a
  reviewer looks for a statement of it; before answering, a reviewer makes the
  read that would settle a suspicion. NEEDS_INFO is for behavior the verifier
  could not establish, not for intent.

Every run below used the 25 pull requests of the public
[ReviewBench](https://github.com/review-bench/ReviewBench) test set, or the
subset named, behind the Azure DevOps fixture of the
[0.3.4 comparison](#reviewer-instructions-compared-on-the-reviewbench-test-set),
in an isolated profile; nothing was published. What a run was to show, and its
thresholds, were written down before it started, and every configuration ran
once unless stated. ReviewBench's judge scored the Claude Opus 5.5 run, after
the comparisons of the next section had been made; its
[scores](#scored-by-reviewbenchs-judge-2026-11-12) follow them. The other runs
show whether reviews complete, how many findings they report and how the
findings are labeled.

### Claude Opus 5.5 with the release's instructions

`/pr-deep` with Claude Opus 5.5 at medium effort for all three roles, the
setup of the 0.3.6 measurement, ran with the runtime and instructions of the
release: `src/` is the same in the measured commit and in the release.
`models.deep.rater` named the same model, so one run gives every finding two
levels: the verifier's, which is the result when no rater is set, and the
rating's.

All 25 reviews were COMPLETE, with no failed or retried stage. Of 434
candidates the verifier confirmed 270, merged 154 into other findings,
rejected 7 and answered NEEDS_INFO for 3; of the 453 candidates of the 0.3.6
measurement it confirmed 291, merged 158, rejected 3 and answered NEEDS_INFO
for 1. In ReviewBench's format, which needs a line number, the run has 269
findings:

| Claude Opus 5.5, `/pr-deep` | Findings | High | Medium | Low | Inline comment |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.3.6 measurement | 283 | 19 | 83 | 181 | 36% |
| 0.3.7, the verifier's level (no rater) | 269 | 18 | 117 | 134 | 50% |
| 0.3.7, with the rating | 269 | 36 | 117 | 116 | 57% |

**Against the levels of ReviewBench's judge.** ReviewBench's pipeline and
Claude Sonnet 5 had judged every finding of the 0.3.6 measurement. Each
finding of the new run was paired with at most one finding of that run on the
same PR by the overlap of their wording (shared words over all words): in the
same file, on lines within five of each other, with an overlap of at least
12%; in the same file with at least 25%; or anywhere with at least 40%. The
most similar pairs were formed first. The pairing is ours and automatic, not
a judge's. 204 findings of the new run are paired with
a finding the judge had rated valid, and take its judged level (35 high, 118
medium and 51 low):

| On those 204 findings | Judged medium or high, labeled low | Inline decision: precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: |
| 0.3.6 measurement | 67 of 153 (43.8%) | 98.9 | 56.2 | 71.7 |
| 0.3.7, the verifier's level | 45 of 153 (29.4%) | 95.6 | 70.6 | 81.2 |
| 0.3.7, with the rating | 39 of 153 (25.5%) | 93.4 | 74.5 | 82.9 |

Written down beforehand: the share labeled low was to fall by at least 8
points, and F1 was not to fall. The share fell by 14.4 points and F1 rose by
9.5.

**The rating.** Its 27 sessions made no tool call and needed no correction
turn; together they took 6.7 minutes, 3.2% of the run's session time. The
rating changed 46 of the 270 levels: 23 from low to medium, 18 from medium to
high and 5 from medium to low. Against the judged levels it added 1.7 points
of F1. The bar set beforehand for recommending a rater of the reviewers' own
model was 5 points, so the documentation recommends a rater only when it is
stronger than the reviewers' model.

**Documented steps.** Two findings of the kind the regression rule names were
medium in this run: a README whose manual installation steps the PR breaks,
and a Docker example whose `seed` command fails. The 0.3.6 measurement had
labeled the Docker example low.

### Scored by ReviewBench's judge (2026-11-12)

After the release candidate had passed its acceptance, ReviewBench's judging
pipeline (`scripts/eval/eval.ts` at its commit 228f2a8) scored the Claude Opus
5.5 run with Claude Sonnet 5, the model that judges its leaderboard, with the
settings of the
[0.3.6 measurement](#reviewbench-which-was-not-used-to-write-it): the same
golden set, matcher prompt and classifier prompt. We ran the pipeline
ourselves, once, so these are not leaderboard results. The four measures and
the largest falls allowed are those fixed for that measurement:

| Claude Opus 5.5, ReviewBench's judge | Findings | Reference recall | Judged valid | High and medium recall | Inline decision (F1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.3.6 measurement | 283 | 39.5 | 96.5 | 55.3 | 65.5 |
| 0.3.7, the verifier's level (no rater) | 269 | 37.5 | 97.4 | 54.7 | 83.0 |
| 0.3.7, with the rating | 269 | 37.5 | 97.4 | 54.7 | 84.8 |
| Largest allowed fall | | 2.8 | 2.0 | 3.6 | 5.8 |

All four held. The run matched 132 of the 352 reference issues against 139,
and 93 of the 170 high and medium ones against 94. The judge rated 262 of the
269 findings valid; the seven others match reference issues that the reference
set itself lists as invalid. Of the 175 findings the judge rated medium or
high, 48 were labeled low (27.4%), against 96 of 190 (50.5%); the paired
comparison above, made before the judge ran, had put that share at 29.4% and
the F1 at 81.2. With the rating, 38 of the 175 were labeled low and F1 was 1.8
points higher, again below the 5 points set for recommending a rater of the
reviewers' own model. Scoring cost about US$16.

### GPT-6 Luna with the release's instructions

`/pr-review` with GPT-6 Luna for all three roles and no rater, the default,
ran twice on the 25 PRs: all 50 reviews were COMPLETE with no failed or
retried stage, and no rating session ran. The runs reported 67 findings (2
high, 51 medium and 14 low) and 57 (0, 47 and 10). Single runs of 0.3.6 and of
its measured instructions had reported 82 and 66. With `models.review.rater`
set to the same model, three PRs were COMPLETE; each of the three rating
sessions made one request and no tool call.

### GPT-6.1 Sol

- An earlier build of this change ran `/pr-deep` on the 25 PRs with GPT-6.1
  Sol for all three roles and as the rater: all COMPLETE, 333 findings (324
  in the 0.3.6 measurement). The verifier's levels were 41 high, 171 medium
  and 121 low (54, 134 and 136 in the 0.3.6 measurement) and the rating's 65,
  148 and 120; the two agreed on the inline decision for 318 of the 333
  findings. A model rating its own review changed little about which findings
  get a comment, which is why the rating is off unless a rater is named. That
  build still had the two verifier sentences listed under
  [measured and left out](#severity-changes-measured-and-left-out), and not
  yet the sentences about documented steps and NEEDS_INFO.
- Without those two verifier sentences, five of the PRs: all COMPLETE, 69
  findings.
- With the release's instructions, two of the PRs: both COMPLETE, 25
  findings. The finding about the README's installation steps was medium, and
  the verifier confirmed, as a question to the author, a candidate it had
  answered NEEDS_INFO in earlier runs of that PR.

### A stronger rater

On an experimental build of this change, GPT-6 Luna reviewed the 25 PRs, and
both Luna and GPT-6.1 Sol then rated its 78 findings. Luna's verifier had set
no finding high, 66 medium and 12 low. Luna's own rating gave 2, 59 and 17;
Sol's gave 11, 51 and 16 and differed from the verifier in 17 findings: 11
from medium to high, 5 from medium to low and 1 from low to medium. No judge
scored these levels.

### Severity changes measured and left out

- Two verifier sentences: one to reject a claim that the verifier's own check
  refutes, and one to reject a question about intent that the code, tests or
  documents already answer. With GPT-6.1 Sol the first had nothing to act on
  and the second was used on findings that were valid; with GPT-6 Luna both
  made the verifier file findings it had found support for under rejected.
- Running the rating by default on the verifier's model, for the reasons
  above; with GPT-6 Luna rating its own review, some regressions also went
  from medium to low.
- A reviewer sentence saying that minor issues and edge cases are findings
  too: it added findings without evidence that the additions were valid.

### Limits of the severity runs

- ReviewBench's judge scored only the Claude Opus 5.5 run, once. How much its
  scores vary between runs was not measured; the allowed falls are those of
  the 0.3.6 measurement, which come from two GPT-6.1 Sol runs scored by the
  local judge. Before that, a local judge (Claude Opus 5.5 subagents applying
  ReviewBench's rubric, as in the 0.3.6 record) had scored the same run
  against thresholds fixed in advance for recall and the share of valid
  findings, and they held. Its numbers are not recorded here: in the 0.3.6
  record the two judges differed by as much as the effect measured.
- The paired comparison covers the 204 of 269 findings that could be paired
  with a judged finding of the earlier run, uses the levels of that run's
  findings and depends on our pairing. Each configuration ran once, apart
  from the two GPT-6 Luna runs.
- GPT-6.1 Sol ran the release's instructions on two PRs only; its 25-PR run
  used an earlier build.
- In the Claude Opus 5.5 run, some findings still asked the author about an
  intent that a test, a document or the change description already states.
- `/pr-quick` follows the new reviewer rules too but was not run, and comment
  planning and publication were not exercised in these runs.

## 0.3.6 release candidate acceptance (2026-11-10)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.2.4. The candidate changes only reviewer instructions: the shared ones
(`src/prompts/common.md`) and the verifier's (`src/prompts/final.md`), as
described and measured under
[defects in moved code and unknown intent](#defects-in-moved-code-and-unknown-intent-2026-11-09).
The runtime logic, settings and installers are those of 0.3.5.

- `npm run check` and **424 offline tests** passed, with the locked prompt
  hashes updated for the functional, risk, verifier and duplicate-check roles
  in both checked variants; the comment-plan prompts are unchanged.
- All five real-host fixtures passed on OpenCode 2.2.4 with isolated profiles
  and fake model and Azure services. The fresh run made 99 model and 180 Azure
  DevOps requests, replacement 83 and 150 and native packed package
  installation 99 and 187, all as for 0.3.5. Comment scale (largest provider
  request 37,119 characters, 36,027 for 0.3.5, from the longer instructions)
  and background compaction passed too.
- A clean copy of the candidate tree installed with `install.sh`: the 19
  runtime modules, 8 prompts and the license match, and `--replace` kept the
  settings byte for byte with mode 600 and an unrelated file in place. The 207
  local Markdown links, images and anchors outside code examples resolve.
- A review of the candidate found that a question about intent could be lost
  in publication: a low finding gets no inline comment, the summary index
  shows only each finding's summary, and the comment planner's further details
  are optional. Reviewers and the verifier now ask the question in the summary
  itself. With `/pr-deep` and Claude Opus 5.5 on five ReviewBench PRs where
  the earlier runs had asked about intent, all 13 findings that asked the
  author about intent did so in their summary (for example, "Is replacing the
  existing note intended?"); in the Claude Opus 5.5 run measured below, none
  of the 12 such findings did. With Claude Opus 5.5 as the `/pr-quick`
  reviewer on the same PRs, and with GPT-6 Luna in both modes, no finding
  asked about intent, so those summaries were not exercised.
- `npm pack --dry-run --json` lists **32 files** (about 180 KB), as for 0.3.5.
- The pushed release commit, installed from GitHub as a public Git package in
  an isolated profile, passed the native smoke test with 99 model and 180 Azure
  DevOps requests.
- Live, with a comment preview (2026-11-10): the candidate, installed from its
  public Git commit in the home OpenCode 2.2.4 service, ran with
  `openai/gpt-6-luna` on the 1-file test PR. `/pr-check` was READY in 5 s.
  `/pr-review` was COMPLETE in 65 s with three sessions, no retry and no repair
  turn, as before the summary change above: it confirmed the PR's three known
  medium defects (reservation atomicity, snapshot isolation and absolute-time
  ordering), merged the three other candidates into them and added no low
  finding. The comment preview, planned with the same model, proposed the
  summary and no inline comment, since existing threads on the PR already
  discuss all three findings. Nothing was published; the service then
  returned to 0.3.5.

This is a pre-publication record. Registry integrity and installation from npm
are checked only after publication, following the
[releasing guide](RELEASING.md).

## Defects in moved code and unknown intent (2026-11-09)

Two changes to the shared reviewer instructions, released in 0.3.6, follow the
[Martian run](#martian-code-review-bench-2026-11-05-and-06): among the golden
comments that no run posted were defects in code the PR moved unchanged, which
the instructions left out as pre-existing, and findings rejected because the
behavior might be intended.

- Reviewers file a correctness or security defect on lines the PR adds or
  moves even when the base commit had the same code elsewhere, and say that
  the PR carries it over.
- Behavior that is wrong only if the author did not mean it, with nothing in
  the code, tests, documentation or PR text showing whether they did, is a low
  finding whose summary asks whether the author meant it and whose suggested
  fix asks them to confirm or document the intent.
- Neither identical base code nor a possible intention is a reason for the
  verifier to reject a finding.

The question in the summary was added after the measurements below, when a
review of the release candidate found that it could otherwise be lost from
the summary index; see the
[0.3.6 acceptance](#036-release-candidate-acceptance-2026-11-10).

The runtime changes are in `src/prompts/common.md` and `src/prompts/final.md`
only. `npm run check` and the 424 offline tests passed, with the locked prompt hashes updated
for the functional, risk, verifier and duplicate-check roles in both checked
variants; the comment-plan prompts are unchanged. The four real-host fixtures
passed on OpenCode 2.2.4: fresh installation with 99 model and 180 Azure
DevOps requests and replacement with 83 and 150, as for 0.3.5; comment scale,
whose largest provider request grew from 36,027 to 37,119 characters with the
longer instructions; and background compaction.

The wording was written after reading three of those golden comments: two
defects in moved code and one finding rejected as possibly intended. Scores on
Martian's benchmark can therefore overstate the effect, so the changes were
also run on the [ReviewBench](https://github.com/review-bench/ReviewBench) test
set, which was not used to write them. Every configuration below ran once, and
the pass criteria were written down before the runs. Martian's benchmark was
scored by Claude Opus 5.5 with its own judging prompts (local scores, as in
[choosing models](#choosing-models-for-pr-deep)). On ReviewBench, the Claude
Opus 5.5 runs were scored with ReviewBench's own judging pipeline and the model
that judges its leaderboard, and every run was also scored by the local judge
of the
[0.3.4 comparison](#reviewer-instructions-compared-on-the-reviewbench-test-set).

### Martian's benchmark, which the wording was written from

`/pr-deep` with Claude Opus 5.5 at medium effort for all three roles, the
recommended setup, on the 50 PRs (core golden comments, local judge):

| Instructions | Comments | Precision | Recall | F2 | High and Critical recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.3.5 | 323 | 28.1 | 65.2 | 51.6 | 72.7 |
| With the changes | 334 | 28.6 | 67.7 | 53.2 | 77.3 |

The 0.3.5 row is the run in [choosing models](#choosing-models-for-pr-deep).
F2 and precision were not to fall by more than 2.5 and 3 points, and comments
were not to grow by more than 15%; all three held. At least two of the three
golden comments the wording was written from were expected to be posted; one
was. The function that computes a new value and returns the old one, which
all twelve 0.3.5 runs had noted and none had filed, was filed and marked as
carried over. This run's reviewers did not mention the other two at all, so
the new rules never came into play for them. Nine findings asked the author to
confirm an intent; in those we checked, behavior changed without a stated
reason.

### ReviewBench, which was not used to write it

The harness is that of the
[0.3.4 comparison](#reviewer-instructions-compared-on-the-reviewbench-test-set):
`/pr-deep` on the 25 PRs of the public test set behind a fixture of the Azure
DevOps API. Four measures were fixed in advance: recall of the reference
issues, the share of findings judged valid, recall of the high and medium
reference issues, and agreement with the judge on which findings deserve an
inline comment (F1). None was to fall by more than twice the variation between
two runs of the same instructions, found by swapping their results PR by PR;
that variation comes from two runs with GPT-6.1 Sol scored by the local judge.

With Claude Opus 5.5 at medium effort for all three roles, the setup measured
on Martian's benchmark, 0.3.5 and the version with the changes each ran once.
Their findings were scored with ReviewBench's judging pipeline
(`npm run judge` at its commit 228f2a8) and Claude Sonnet 5, the model that
judges its leaderboard. We ran the pipeline ourselves, so these are not
leaderboard results.

| Claude Opus 5.5, ReviewBench's judge | Findings | Reference recall | Judged valid | High and medium recall | Inline decision (F1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.3.5 | 252 | 35.5 | 95.6 | 55.3 | 70.0 |
| With the changes | 283 | 39.5 | 96.5 | 55.3 | 65.5 |
| Largest allowed fall | | 2.8 | 2.0 | 3.6 | 5.8 |

All four measures held. The run with the changes matched 139 reference issues
against 125: 45 low ones against 31, while the high and medium ones stayed at
94 (21 high against 23). Inline decisions fell by 4.5 points: 96 of the 190
findings the judge rated medium or high were labeled low, against 74 of 164.
Eight of those 96 ask the author to confirm an intent, which the changes rate
low. The reviewers asked the author to confirm an intent in 14 findings,
against 2 in the 0.3.5 run, and the judge rated 13 of the 14 valid.

### ReviewBench scored by the local judge

The same runs, and a pair with GPT-6.1 Sol, the model of the earlier
ReviewBench comparisons, were also scored by the local judge: Claude Opus 5.5
subagents applying ReviewBench's matcher and classifier rubric.

| GPT-6.1 Sol, local judge | Findings | Reference recall | Judged valid | High and medium recall | Inline decision (F1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.3.5 | 299 | 32.1 | 96.0 | 50.6 | 82.0 |
| With the changes | 324 | 32.7 | 96.3 | 51.2 | 82.2 |

| Claude Opus 5.5, local judge | Findings | Reference recall | Judged valid | High and medium recall | Inline decision (F1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.3.5 | 252 | 40.1 | 96.0 | 58.8 | 74.7 |
| With the changes | 283 | 40.1 | 93.6 | 56.5 | 75.5 |

With GPT-6.1 Sol all four measures rose slightly, and the run used about as
many tokens as earlier runs with that model. With Claude Opus 5.5 three held,
but the share of findings judged valid fell by 2.4 points, more than the 2.0
allowed: 18 findings were invalid against 10. Five of those 18 report problems
that the 0.3.5 run also reported and the judge also rated invalid. Of the
other 13, two ask the author to confirm an intent that a doc comment or a
commit message in the PR already stated, and two report blank site titles, a
problem the 0.3.5 run also reported but the judge then rated valid. The rest
are of kinds both runs had: findings that match issues the reference set
itself lists as invalid, and others the judge rated invalid; the 0.3.5 run had
five such findings that this run did not. ReviewBench's judge rated those two
intent questions and the two blank-title findings valid.

The two judges moved in opposite directions on the share of valid findings
and on inline decisions: the difference between judges is as large as the
effect of the changes.

- 0.3.5's verifier rejected 9 findings, 6 of which the local judge rated
  valid, including two it rejected as an intended, documented fallback. With
  the changes the verifier rejected 3, none of them valid, and that run filed
  one of the two fallback problems, which matched a reference issue.
- Both Claude Opus 5.5 runs used about as many tokens.

### Limits

- One run per configuration. On Martian's benchmark one run's recall varies
  by about 3.7 points. The allowed falls on ReviewBench come from two runs
  with GPT-6.1 Sol scored by the local judge; how much Claude Opus 5.5, or
  ReviewBench's judge, varies between runs was not measured.
- On Martian's benchmark the scores are local; the dashboard's judge scored
  0.3.5, not the changes. On ReviewBench, the leaderboard's judge scored only
  the Claude Opus 5.5 runs. Its bundled model list did not include Claude
  Sonnet 5 yet, so a model setting was added as ReviewBench's documentation
  describes, with adaptive thinking, the only thinking mode Sonnet 5 accepts.
  The pipeline ran outside this repository, because the judge's agent library
  adds AGENTS.md files from its working directory's parents to the judge's
  instructions. Scoring both runs cost about US$35.
- ReviewBench's test set holds 36 high reference issues. The Sol run with the
  changes matched 16 of them, against 20 for 0.3.5 and 18 and 19 for two runs
  of earlier instructions. Of the five that 0.3.5 matched and it did not,
  three, covering two defects that span two files, were reported in the other
  file, which ReviewBench's per-file matching cannot count. One was noted only
  in a part of the finding that does not reach the comment, and one was not
  noticed, as in one of the earlier runs. It also matched one that 0.3.5 had
  missed.
- `/pr-quick` follows the new reviewer rules too but was not measured, and
  comment planning and publication were not exercised.

### A second initial-review round, measured and removed

A second round was built and measured with the changes: each shard was
reviewed again in a new session that saw the findings already filed on its
files and was asked only for defects they miss. On Martian's benchmark with
the setup above it raised recall from 67.7 to 74.1 and High and Critical
recall from 77.3 to 80.3, but precision fell from 28.6 to 23.4 and F2 from
53.2 to 51.6, comments grew by 38% and the tokens about doubled. Its criteria
asked for no fall in F2 and at most twice the tokens, so it was removed (see
the [roadmap](ROADMAP.md#a-second-initial-review-round)).

## Martian Code Review Bench (2026-11-05 and 06)

[Code Review Bench](https://github.com/withmartian/code-review-benchmark) is
Martian's open benchmark for AI code review. Its offline set holds 50 real pull
requests from cal.com, Discourse, Grafana, Keycloak and Sentry, each with
golden comments: the issues a reviewer should catch, each with a severity and
a category. Its [dashboard](https://codereview.withmartian.com) ranks tools by
F2, which weighs recall above precision, on the 158 core golden comments
(bugs, security, concurrency, data, API, performance, test gaps and
documentation defects; style and speculative remarks are left out).

AZPR is not on that dashboard. Its inclusion criteria count a tool's reviews on
public GitHub pull requests, and AZPR reviews Azure DevOps pull requests.
For tools that do not meet them, Martian invites running the public harness
and publishing the results, which is what this section records. We ran the
offline benchmark (repository commit e616e84 of 2026-08-30, the latest on
2026-11-06) with AZPR 0.3.5 from npm on OpenCode 2.2.4. AZPR's prompts and
code were not changed for it.

- **Review.** The benchmark's PRs are GitHub pull requests, so each was served
  at its base and head commits through a local implementation of the Azure
  DevOps REST calls AZPR makes; the review stages, prompts and models are the
  ones AZPR uses on Azure DevOps. Every PR ran `/pr-deep` with English output
  and eight sessions in parallel (the default is four, which changes only
  speed). The comments are AZPR's confirmed findings, the ones it would comment
  on, each as one inline comment with its summary, evidence and suggested fix;
  comment planning and publication were not run.
- **Scoring.** The benchmark's pipeline extracts the issues in a tool's
  comments, merges duplicates and has a judge model decide which issues match
  which golden comments. Every extracted issue that matches no golden comment
  counts against precision, whether or not it is a real problem.

### Choosing models for `/pr-deep`

The models matter more than any setting, so we compared model and
reasoning-effort combinations on all 50 PRs to choose what to recommend for
`/pr-deep`. Each combination ran once and was scored with the benchmark's
pipeline and prompts, judged by Claude Opus 5.5 instead of the dashboard's
judge (local scores). With 158 golden comments, one run's recall has a
sampling error of about 3.7 points, so differences of a point or two are not
meaningful.

| Models: functional / risk / verifier (reasoning effort) | Comments | Precision | Recall | F2 | High and Critical recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Opus 5.5 ×3 (medium) | 323 | 28.1 | 65.2 | **51.6** | 72.7 |
| Claude Opus 5.5 ×3 (high) | 388 | 25.5 | 68.4 | 51.2 | 74.2 |
| Claude Opus 5.5 ×3 (high / high / extra high) | 381 | 25.9 | 66.5 | 50.6 | 69.7 |
| Claude Opus 5.5 ×3 (low) | 174 | 41.2 | 50.6 | 48.4 | 63.6 |
| Claude Opus 5.5 ×3 (extra high) | 483 | 22.0 | 69.0 | 48.4 | 75.8 |
| Claude Opus 5.5 / GPT-6 Astra / Claude Opus 5.5 (high) | 489 | 21.5 | 69.6 | 48.1 | 80.3 |
| Claude Opus 5.5 ×3 (extra high / extra high / high) | 473 | 21.3 | 69.0 | 47.7 | 75.8 |
| Claude Opus 5.5 / GPT-6 Astra / Claude Opus 5.5 (extra high / extra high / high) | 604 | 18.5 | 73.4 | 46.0 | 80.3 |
| Claude Opus 5.5 / Claude Opus 5.5 / GPT-6 Astra (extra high / extra high / high) | 470 | 21.0 | 63.9 | 45.4 | 72.7 |
| GPT-6.1 Sol ×3 (model default) | 334 | 24.9 | 52.5 | 43.0 | 62.1 |
| GPT-6 Astra / GPT-6 Astra / Claude Opus 5.5 (extra high / extra high / high) | 561 | 17.5 | 62.0 | 41.1 | 72.7 |
| GPT-6 Luna ×3 (model default), `/pr-review` | 91 | 46.8 | 27.8 | 30.3 | 42.4 |

The model IDs were `claude-agent/opus` (OpenCode's claude-agent provider with
Claude Code CLI 2.1.314, which ran Claude Opus 5.5), `openai/gpt-6-astra`,
`openai/gpt-6.1-sol` and `openai/gpt-6-luna`; the reasoning effort is the
model variant, such as `claude-agent/opus#medium`.

- Medium and high effort scored best, within each other's sampling error.
  Extra-high effort found about as much but also reported more marginal issues.
  Low effort posted about half as many comments as medium and found about a
  fifth fewer of the golden issues.
- The verifier's effort made no measurable difference in two comparisons. In
  these runs the verifier rejected only 1 to 5% of the findings and merged 30
  to 40% into others as duplicates, so precision is set mainly by the
  reviewers.
- GPT-6 Astra as the second reviewer found the most High and Critical golden
  issues (80.3%) but added more unmatched issues than matches; as the verifier,
  or as both reviewers, it scored below Claude alone.
- We recommend Claude Opus 5.5 at medium effort for all three deep roles: the
  best score and, apart from low effort, the shortest run. The 50 PRs took 35
  minutes, four at a time; the median PR took 153 seconds and the longest 301.

### Scored by the dashboard's judge

The recommended combination's comments were then scored with the benchmark's
pipeline and the dashboard's default judge, Claude Opus 4.5
(`claude-opus-4-5-20251101`, temperature 0 as the pipeline sets it), called
through Anthropic's OpenAI-compatible endpoint instead of the pipeline's
default, Martian's model router. No PR was reviewed again for this.

| | Precision | Recall | F2 | High and Critical recall | Issues per PR |
| --- | ---: | ---: | ---: | ---: | ---: |
| AZPR 0.3.5 `/pr-deep`, Claude Opus 5.5 (medium) | 30.0 | 67.7 | 54.1 | 74.2 | 7.6 |

On the dashboard's default view (core golden comments, the same judge), this
is the highest recall of its 21 tools (next: copilot-v2 66.5, cubic-v2 65.8),
the highest High and Critical recall, shared with qodo-extended-v2 and augment
(74.2), and the sixth F2: after qodo-extended-v2 (65.1), cubic-v2 (64.9),
augment (64.0), qodo-v2 (60.6) and copilot-v2 (58.0), and ahead of gemini-v2
(52.8), gitlab (52.7) and coderabbit (51.1). With the strict profile (bugs,
security, concurrency, data and API) recall is again the highest (68.3) and F2
tenth (52.7); with all categories recall is second (65.9) and F2 sixth (54.0).
Martian's published results also hold 28 tools and versions that the dashboard
does not show; three of them, cubic-dev and two qodo variants, have a higher
core recall (68.4 to 76.5) and F2 scores of 53.0 to 58.4.

The local judge had scored the same comments 51.6 (precision 28.1, recall
65.2). The two judges agreed on 101 of the 109 golden comments that either of
them matched, so the local scores above are likely slightly below what the
dashboard's judge would give.

### What the unmatched comments are

The golden comments average about three per PR. AZPR posted 6.5 comments per
PR, and every issue in them that matches no golden comment lowers precision.
To see what those issues are, we checked a random sample of 40 of the 264
unmatched issues (local judge), stratified by repository, against the code at
each PR's head:

| Verdict | Issues |
| --- | ---: |
| A defect the PR introduces or exposes, worth raising | 18 |
| Accurate, but of low value (naming, wording, a missing test with no known bug behind it) | 18 |
| Depends on the author's intent | 1 |
| Wrong or overstated | 3 |

Examples of the 18: a Webex token refresh that validates the reply of the PR's
new sync endpoint against the full provider schema, so the minimal reply that
endpoint is meant to return is rejected; a cancellation of a recurring booking
that deletes the series only through the organizer's credential, leaving the
copies the PR adds for other hosts; and an unsubscribe link that changes state
on GET, so reloading it lowers the notification level again. A reviewer
decides in the comment preview what to post.

### Golden comments that no combination matched

Across the twelve runs, 129 of the 158 core golden comments were matched at
least once (local judge). We read the code at the PR head for the other 29:

- 8 are contradicted by the code, for example an import of a class described
  as missing that the same PR defines, and orphaned rows that a cascading
  delete removes.
- 9 describe no practical effect, for example a nil request that an outer
  layer already rejects.
- 1 was raised in eight runs, but the local judge did not count it.
- Of the other 11, the reviewers of at least one run had noted 10 in the
  review report and explained why they did not file them. Most were defects in
  code that the PR moved unchanged from elsewhere, which AZPR's instructions
  leave out as pre-existing, or issues judged harmless or intended. Such notes
  appear in AZPR's report, not in the PR comments the benchmark reads.

### Limits

- One run per combination; the dashboard's judge scored one run of one
  combination.
- Comment planning and publication were not exercised: each confirmed finding
  counted as one inline comment, and the PRs were served by a local
  implementation of AZPR's Azure DevOps calls, not by Azure DevOps Services.
- With OpenCode 2.2.4's claude-agent provider, the Claude CLI process behind
  each finished private session (about 200 MB) stayed alive for minutes after
  the session was deleted. The low-effort run, which finishes PRs fastest, ran
  out of memory on the 8 GB test machine and was completed in chunks, each
  ending its OpenCode server to release the memory; its results were not
  affected.

## 0.3.5 release candidate acceptance (2026-11-04)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.2.4. The candidate changes only reviewer instructions: the severity scale
and the rating of gaps in the shared instructions (`src/prompts/common.md`),
how the verifier sets severity (`src/prompts/final.md`), the role prompts
(`functional.md`, `risk.md`, `quick.md`), which no longer repeat shared rules,
and the shared tool guidance in `src/config.mjs`, which leaves what each tool
returns to the tools' own descriptions. The runtime logic, settings and
installers are those of 0.3.4.

- `npm run check` and **424 offline tests** passed. The locked prompt hashes
  were updated for every review role, comment planning included, in both
  checked shell and language variants; the comment-plan prompts changed only
  in the shared tool guidance. With shell denied and English output, each
  review role's system prompt is 970 to 1,380 characters longer than in
  0.3.4, since the severity guidance adds more than the cleanup removes, and
  each comment-plan prompt is 815 characters shorter.
- All five real-host fixtures passed on OpenCode 2.2.4 with isolated profiles
  and fake model and Azure services. The fresh run made 99 model and 180 Azure
  DevOps requests, replacement 83 and 150 and native packed package
  installation 99 and 187, all as for 0.3.4. Comment scale (largest provider
  request 36,027 characters, 34,633 for 0.3.4, from the longer review
  instructions) and background compaction passed too.
- A clean copy of the candidate tree installed with `install.sh`: the 19
  runtime modules, 8 prompts and the license match, and `--replace` kept the
  settings byte for byte with mode 600 and an unrelated file in place. The 186
  local Markdown links, images and anchors outside code examples resolve.
- `npm pack --dry-run --json` lists **32 files** (about 176 KB), as for 0.3.4.
- The pushed release commit, installed from GitHub as a public Git package in
  an isolated profile, passed the native smoke test with 99 model and 180 Azure
  DevOps requests. Later commits on the branch change only documentation.
- Live, with a comment preview (2026-11-04): the candidate, installed from its
  public Git commit in the home OpenCode 2.2.4 service, ran with
  `openai/gpt-6-luna` on the 1-file test PR. `/pr-check` was READY in 10 s.
  `/pr-review` was COMPLETE in 80 s with three sessions, no retry and no repair
  turn: it confirmed the PR's three known medium defects (snapshot isolation,
  reservation atomicity and absolute-time ordering), each with the verifier's
  own severity, merged the three other candidates into them and added no low
  finding. The comment preview, planned with the same model, proposed the
  summary and no inline comment, since existing threads on the PR already
  discuss all three findings. Nothing was published; the service then returned
  to 0.3.4.

This is a pre-publication record. Registry integrity and installation from npm
are checked only after publication, following the
[releasing guide](RELEASING.md).

### Severity compared on the ReviewBench test set

The new instructions were compared with those of 0.3.4 before release, with
the harness and judging described for
[0.3.4](#reviewer-instructions-compared-on-the-reviewbench-test-set):
`/pr-deep` with `openai/gpt-6.1-sol` and `/pr-review` with `openai/gpt-6-luna`
on the public ReviewBench test set, in isolated OpenCode 2.2.4 profiles behind
a fixture of the Azure DevOps API, scored with ReviewBench's matcher and
classifier rubric by Claude Opus 5.5 subagents instead of the benchmark's
official judge. Before is the run measured for 0.3.4. Each valid finding's
severity was compared with the judged severity: that of the reference issue
it matched or, for a valid finding outside the reference set, the
classifier's. Three questions were asked: were issues judged high labeled
high, were findings that deserve an inline comment (judged high or medium)
labeled high or medium, and did what reviews found change.

The instructions changed in two steps: the severity scale, then a cleanup that
states each shared rule once and shortens the tool guidance. To tell a change
from the variation between runs, the severity-scale instructions ran twice
with each model, and swapping the two runs' results PR by PR gave the
variation of each measure. The cleanup was accepted only if, with
gpt-6.1-sol, none of five measures fixed in advance (recall of the reference
issues, the share of findings judged valid, recall of high and medium
reference issues, and agreement on the inline decision and on high labels)
fell below the mean of those two runs by more than that variation allows.

- With gpt-6.1-sol, many more of the issues the judges rated high were
  labeled high, and fewer findings that deserve an inline comment were labeled
  low; both differences exceed the variation between runs. The share of high
  labels that the judges also rated high stayed about the same, so with more
  high labels, more findings are labeled high that the judges rated medium or
  lower.
  Findings labeled medium that the judges rated low stayed about as frequent
  as with 0.3.4, and agreement on the inline decision improved only within the
  variation between runs.
- What reviews found did not change beyond that variation: recall of the
  reference issues, including the high and medium ones, and the share of
  findings judged valid. Reviews used about as many tokens as with 0.3.4.
- The cleanup passed its check: all five measures stayed within the variation
  between runs, and reviews used slightly fewer tokens and no more source
  reads.
- With gpt-6-luna, which reports far fewer findings, every measure stayed
  within the variation between runs, which is large for this model: two runs
  of the same instructions differed widely in their agreement on high labels.
  The one run of the final instructions had more findings judged invalid than
  the earlier runs, still within that variation.
- Limits: at most two runs per instruction version, and one each of 0.3.4 and
  of the final instructions; severity is a judgment on which the reference
  labels, the classifier and AZPR's reviewers can each reasonably differ; the
  test set holds few high reference issues. In one PR, four menu and
  key-binding handlers each start their own thread for repository operations
  that should run one at a time; the final instructions reported each handler,
  where earlier runs reported one finding. This follows the rule of one
  finding per place that needs its own fix, but adds comments. `/pr-quick` and
  comment planning were not measured, and the fixture API does not exercise
  comment publication.

## 0.3.4 release candidate acceptance (2026-11-01)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.2.4. The candidate changes the reviewer instructions shared by all review
modes (`src/prompts/common.md`) and the matching line of the quick reviewer's
checklist; the runtime modules, settings and installers are those of 0.3.3.

- `npm run check` and **424 offline tests** passed. The locked prompt hashes
  were updated for the functional, risk, verifier and dedupe prompts in both
  checked shell and language variants; the comment-plan prompts are unchanged.
- All five real-host fixtures passed on OpenCode 2.2.4 with isolated profiles
  and fake model and Azure services. The fresh run made 99 model and 180 Azure
  DevOps requests, as for 0.3.3. Replacement, native packed package
  installation, comment scale (largest provider request 34,633 characters,
  33,419 for 0.3.3, from the longer shared instructions) and background
  compaction passed too.
- A clean copy of the candidate tree installed with `install.sh`: the 19
  runtime modules, 8 prompts and the license match, and `--replace` kept the
  settings byte for byte with mode 600 and an unrelated file in place. The 161
  local Markdown links and images outside code examples resolve.
- `npm pack --dry-run --json` lists **32 files** (about 175 KB), as for 0.3.3.
- The first pushed release commit (`5aea254`), installed from GitHub as a
  public Git package in an isolated profile, passed the native smoke test with
  99 model and 180 Azure DevOps requests. The final commit is checked the same
  way before tagging.
- Live, review only (2026-11-02): commit `5aea254`, installed from GitHub in the
  home OpenCode 2.2.4 service, ran with `openai/gpt-6-luna` on the 1-file test
  PR. `/pr-check` was READY in 5 s. `/pr-review` was COMPLETE
  in 92 s with three sessions and no retry: it confirmed the PR's three known
  medium defects (snapshot isolation, reservation atomicity and absolute-time
  ordering), merged the two other candidates into them and added no low
  finding, after one repair turn in which the verifier corrected its answer.
  No comment was published; the service then returned to 0.3.3.
- Live, quick only (2026-11-02): after the identical-copies rule was limited to
  one reviewer's assigned files, the candidate, installed in the same service
  as a local Git package of the working tree, ran `/pr-quick` with
  `openai/gpt-6-luna` on the 1-file test PR. It was COMPLETE in 36 s with one
  session and complete coverage, and reported the same three known medium
  defects and nothing else. No comment was published; the service then
  returned to 0.3.3.

This is a pre-publication record. Registry integrity and installation from npm
are checked only after publication, following the
[releasing guide](RELEASING.md).

### Reviewer instructions compared on the ReviewBench test set

The new instructions were compared with 0.3.3 before release on the public
[ReviewBench](https://github.com/review-bench/ReviewBench) test set. A local
harness served each PR's public repository to an isolated OpenCode 2.2.4
profile through a fixture of the Azure DevOps API built from its Git history,
ran `/pr-deep` with `openai/gpt-6.1-sol` and `/pr-review` with
`openai/gpt-6-luna` at their default reasoning effort, and converted the
findings AZPR would comment on into ReviewBench's judging input. Before is the
published 0.3.3 package, after is a package built from this change.

The findings were scored with ReviewBench's matcher and classifier rubric by
Claude Opus 5.5 subagents that saw the rubric, the PR and the findings, but not
the reference labels or which candidates AZPR's verifier had rejected. This is
not the benchmark's official judge, so the comparison shows the direction of
the change between the two instruction versions, not a leaderboard result.

- With gpt-6.1-sol, 0.3.4 matched more of the high- and medium-severity
  reference issues than 0.3.3, including high ones, and clearly more in the
  testing category. Most added findings are low: missing tests where the
  project tests comparable code, stale comments and documents, and the same
  mistake at each place that needs a fix. The share of all findings judged
  valid stayed about the same, while a few more findings matched reference
  issues labelled as false alarms. Reviews took somewhat longer and used
  somewhat more tokens.
- In one PR, several routes built an OAuth URL from the internal request
  origin. 0.3.3 matched the high reference issue of only one route; 0.3.4
  reported each route and matched all of them. Before the identical-copies
  rule, a documentation example copied into many templates produced a finding
  for each copy; with the rule each initial-review shard reported it once, so
  copies in different shards still kept a finding each, without losing high
  matches. The rule therefore promises one finding per reviewer's assigned
  files, not per PR.
- With gpt-6-luna, `/pr-review` matched slightly more, within the variation
  between runs, and high matches stayed the same.
- Limits: the comparison has few runs per configuration and runs of the same
  configuration vary noticeably; the test set holds few high reference issues.
  `/pr-quick` was not measured, and the fixture API does not exercise comment
  publication.

## 0.3.3 release candidate acceptance (2026-10-31)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.2.4 installed into a disposable prefix. The candidate moves the tested
host to OpenCode 2.2.4 and contains the changes listed in the
[changelog](../CHANGELOG.md); prompts and settings are those of 0.3.2, and the
installers differ only in the target host they print.

- `npm run check` and **424 offline tests** passed, including the `/pr-check`
  OpenCode row for the tested and for another version, a used-up ChatGPT
  usage limit whose host retry is refused, the progress-only event
  subscription and test-only base URLs anywhere in 127.0.0.0/8.
- All five real-host fixtures passed on OpenCode 2.2.4 with isolated profiles
  and fake model and Azure services. The fresh run made 99 model and 180 Azure
  DevOps requests, as on 2.1.4; it reached the proxied Azure DevOps fixture
  on 127.0.0.2 through one `CONNECT` tunnel, and private reviewers saw neither
  the tool of the foreign MCP server behind CodeMode nor image generation.
  Replacement, native packed package installation, comment scale (largest
  provider request 33,419 characters, as for 0.3.2) and background compaction
  passed too. The changed smoke test also passed on OpenCode 2.1.4.
- A clean archive of the candidate installed with `install.sh`: the 19 runtime
  modules, 8 prompts and the license match, and `--replace` kept the settings
  byte for byte with mode 600 and an unrelated file in place. The 189 local
  Markdown links and images resolve, apart from an image path inside an inline
  code example.
- `npm pack --dry-run --json` lists **32 files** (about 174 KB), as for 0.3.2.
- Live, review only: the candidate, installed as a local Git package in the
  home OpenCode service (still OpenCode 2.1.4), ran with `openai/gpt-6-luna`
  on the 1-file test PR. `/pr-check` was READY in 5 s with the OpenCode WARNING
  row for 2.1.4 and without a host notice. `/pr-review` was COMPLETE in 86 s
  with three sessions and no retry: it confirmed the PR's three known medium
  defects (snapshot isolation, reservation atomicity and absolute-time
  ordering), after one repair turn in which the verifier supplied two missing
  decisions. No comment was published; the service then returned to 0.3.2.
  A live run on OpenCode 2.2.4 follows once that host is installed.

This is a pre-publication record. Public Git installation is checked once the
candidate is pushed; registry integrity and installation from npm are checked
only after publication, following the [releasing guide](RELEASING.md).

## OpenCode 2.2.4 compared with 2.1.4 (2026-10-31)

Environment: Ubuntu 22.04.5 under WSL2 and Node 22.23.3. OpenCode CLI 2.2.4
(published 2026-10-30, 963 commits after 2.1.4) was installed into a
disposable prefix next to the system's 2.1.4; both embed Bun 1.4.4 (revision
`38afee6c`). Every run used isolated profiles and the fake model and Azure
DevOps services; no real model or Azure request was made. The upstream source
of both tags was compared for each host interface AZPR uses.

| Check | Observed |
| --- | --- |
| Plugin API | Additive only: session instruction entries, `experimental.generate`, typed `event.subscribe({ types })`, the experimental `experimental.idle` session hook and artifact providers. The hooks, session methods, request kinds, continuation text, session events, message types, permission actions and plugin list AZPR uses are unchanged. |
| Model requests | The comment-scale fixture, run on both hosts from the same unchanged 0.3.2 revision, sent 34 requests that were byte-identical once per-run values (paths, IDs, review ID, date) were normalised; all 15 counters matched (75 Azure calls, largest request 33,445 characters in that checkout). |
| Full workflow | The fresh smoke fixture made 99 model and 180 Azure DevOps requests on both hosts; only retry and watchdog timings differed. |
| Tool scopes | Private reviewers saw the six AZPR tools plus `read`, `glob` and `grep` on both hosts, also with a foreign MCP server behind CodeMode. With an image model configured, OpenCode 2.2.4 offered `experimental_image_generate` to an ordinary session but not to private reviewers. |
| Plugin loading | `opencode plugin add …@0.3.1` while the server ran: the seven commands appeared 0.5 s later. Adding 0.3.2 and removing 0.3.1: 0.3.2 was the only active entry 0.5 s later, without a restart. |
| Proxies | OpenCode 2.2.4 merges `NO_PROXY` and `no_proxy` and adds `127.0.0.1`, `localhost` and `::1`. Bun skips even an explicit `proxy` option for a listed host: 127.0.0.1 and localhost were fetched directly, 127.0.0.2 through the proxy. The smoke fixture's proxied Azure DevOps service therefore listens on 127.0.0.2, which the test-only base URL check now accepts with the rest of 127.0.0.0/8. |
| Provider errors | OpenCode 2.2.0 added `provider.budget-limit` and `provider.model-budget-limit`; 2.2.3 reports a used-up ChatGPT usage limit as `provider.chatgpt-limit` (previously a rate limit) and the OpenCode Go limit as `provider.go-limit`. Retry hooks receive the error type. |
| Database | Nine migrations between 2.1.4 and 2.2.4 create, drop and move tables; they cannot be undone, so the database is backed up before an upgrade. |
| Terminal UI | `opencode --prompt "/pr-review …"` can still submit before the command catalog loads (see [debugging](DEBUGGING.md)). |

Not covered: real providers and Azure DevOps on 2.2.4, a ChatGPT usage limit
actually being reached, and Desktop features.

## 0.3.2 release candidate acceptance (2026-10-30)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.1.4. The candidate contains PR #32: the results-first README and demo
(commits `2a48d5c` and `792836b`), their follow-up documentation (`2385e15`),
the receipt's status sentence (`aa5cb36`) and the smaller npm package
(`6de34ad`). Release preparation changes the package version, changelog,
release notes, version pins and this record. Apart from that sentence, the
runtime, prompts, settings and installers are those of 0.3.1.

- `npm run check` and **421 offline tests** passed, including a final version
  recheck that fails after the snapshot: the review stays COMPLETE and its
  report lists the warning. A release test fixes the npm `files` list.
- All five real-host fixtures passed with isolated profiles and fake model and
  Azure services: fresh source installation, replacement installation, native
  packed package installation, comment scale and background compaction. The
  native run installed the 32-file package. The scale fixture's largest
  provider request was 33,419 characters, as for 0.3.1.
- `npm pack --dry-run --json` lists **32 files** (about 170 KB):
  `package.json`, `server.js`, the 27 runtime and prompt files, the README,
  the changelog and the license. Documentation, media, installers, the
  settings example and schema and the repository guides are left out;
  npmjs.com resolves the README's relative links and images against the
  GitHub repository, as checked on the 0.3.1 package page.
- No paid-model request or real Azure publication was made for the candidate.
  The README and [demonstration](DEMO.md#actual-azure-devops-comments)
  screenshots come from a live English run on 2026-10-29 with AZPR 0.3.1,
  OpenCode 2.1.4 and `openai/gpt-6-luna` on the 1-file test PR: the review
  confirmed three medium findings, and publication posted a summary and three
  inline comments, all four read back as `VERIFIED`.

This is a pre-publication record. Public Git installation and clean-source
archive acceptance are checked on the release candidate; registry integrity
and installation from npm are checked only after publication, following the
[releasing guide](RELEASING.md). After publication on 2026-10-30, the registry
package's integrity matched the package built from the tag, and installing
`opencode-azure-devops-pr-review@0.3.2` and the `v0.3.2` Git tag passed
`host-v2-smoke.mjs --native --package`.

## 0.3.1 release candidate acceptance (2026-10-27)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.1.4. The candidate contains the installation, setup and upgrade changes
of PR #31 and the fixes from its review (commits `6e2c71e` and `4b3b6af`).
Release preparation changes the package version, changelog, release notes,
version pins and documentation; the runtime, prompts, settings and installers
are those of the reviewed commits.

- `npm run check` and **420 offline tests** passed, including the `/pr-check`
  AZPR row, masked package specifications and the `/pr-setup` defaults.
- All five real-host fixtures passed with isolated profiles and fake model and
  Azure services: fresh source installation, replacement installation, native
  packed package installation, comment scale and background compaction. The
  native run also covers setup with the default PAT file and a PR URL, the
  AZPR row and a second AZPR entry that stays unloaded. The scale fixture's
  largest provider request was 33,419 characters, as for 0.3.0.
- `npm pack --dry-run --json` lists **76 files**, adding the 0.3.1 release
  notes. Tests, private settings and `.local/` records are excluded.
- No paid-model request or real Azure publication was made: setup and the
  AZPR row make neither, and reviews and publication are unchanged from 0.3.0.

This is a pre-publication record. Public Git installation and clean-source
archive acceptance are checked on the release candidate; registry integrity
and installation from npm are checked only after publication, following the
[releasing guide](RELEASING.md). After publication on 2026-10-27, the registry
package's integrity matched the package built from the tag, and installing
`opencode-azure-devops-pr-review@0.3.1` and the `v0.3.1` Git tag passed
`host-v2-smoke.mjs --native --package`.

## Installation, setup and upgrades on OpenCode 2.1.4 (2026-10-27)

Environment: Ubuntu 22.04.5 under WSL2, OpenCode CLI 2.1.4 and the published
packages 0.2.2, 0.2.3 and 0.3.0 from npm. Each probe used an isolated profile
(its own `XDG_*` directories and `OPENCODE_CONFIG_DIR`) with `opencode serve`
and OpenCode's file watcher on, as in a normal installation. Where a proxy was
set, a loopback proxy recorded and refused every request. No model or Azure
DevOps request was made.

| Step | Observed |
| --- | --- |
| `opencode plugin add …@0.2.3` while the server runs | Installed in 1.2 s; the running server listed the seven commands 0.5 s later, without a restart. |
| `opencode plugin add …@0.3.0` with 0.2.3 configured | A second entry: 0.2.3 kept running and 0.3.0 was listed as failed with `Duplicate plugin ID: azpr`. |
| `opencode plugin remove …@0.2.3` | 0.3.0 was running 0.5 s later, without a restart. |
| `/pr-setup` saved settings | The commands still answered `SETUP REQUIRED` until the plugin was loaded again. |
| Changing the version in the `plugins` entry | The running server switched versions within 0.5 s. A long-running managed service on the same machine had likewise loaded each of three earlier entry changes before its planned restart. |
| The same change to a version not yet installed, with the server behind the refusing proxy | The server downloaded it itself (`CONNECT registry.npmjs.org:443` through its proxy). AZPR's commands disappeared, and installing the package from the terminal did not bring them back until the server restarted. |
| `plugin add` with `HTTPS_PROXY`, `npm_config_https_proxy` or `https-proxy` in `~/.npmrc` | Each sent `CONNECT registry.npmjs.org:443` to the proxy, and the refusal failed the command (HTTP 403). `plugin add` writes the configuration only after a successful download. |

`tests/host-v2-smoke.mjs --native` now also checks on the exact host that
`/pr-setup` takes the organization from a PR URL and uses the default PAT file
without `--pat-file`, that `/pr-check` names the running package, and that a
second AZPR entry stays unloaded (`Duplicate plugin ID: azpr`) while
`/pr-check` warns about it. The fresh and replacement runs check that the row
names a local source installation.

Not covered: the terminal UI's command list after a reload, what a reload does
to a command that is running, authenticating or NTLM proxies and company CAs
for package downloads, Git-package downloads through a proxy, and proxy
inheritance between Windows and WSL.

## 0.3.0 release candidate acceptance (2026-10-26)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3, npm 10.9.9 and OpenCode
CLI 2.1.4. The candidate contains the finding-adjustment workflow merged in
PR #29, including the final fixes in `d4fd8dd`. Release preparation changes
the package version, description, documentation and recording tool, and adds
the code of conduct and a recorded demonstration to the npm package; the
runtime, prompts, settings and installers are unchanged from that reviewed
revision.

- `npm run check` and **417 offline tests** passed, including the adjustment
  save failure, the final summary's excluded-ID check, and an earlier comment
  read back after a refused write without a local publication record.
- All five real-host fixtures passed with isolated profiles and fake model
  and Azure services: fresh source installation, replacement installation,
  native packed package installation, comment scale and background compaction.
  Fresh and native runs cover the authenticating proxy, custom CA, external
  settings, restart and idempotent publication. The scale fixture reviewed
  120 files with one overflow split and eight planning sessions, at most two
  in flight; its largest provider request was 33,419 characters. The
  background-compaction fixture classified the failure as permanent and ran
  one functional session.
- `npm pack --dry-run --json` lists **75 files**, including the entry, runtime,
  prompts, configuration example and schema, license, code of conduct, 0.3.0
  release notes and the new demonstration media. Tests, private settings and
  `.local/` records are excluded.
- These release fixtures make no paid-model request or real Azure publication.
  The live adjustment runs below used the earlier `cbbed6b` implementation;
  the subsequent persistence, read-back and final-summary fixes have offline
  regression tests. Host fixtures exercise the surrounding workflow.
- A live run on the candidate's runtime was recorded for the
  [demonstration](DEMO.md): OpenCode 2.1.4 with `openai/gpt-6-luna`, the plugin
  installed from public Git commit `dfba561`, on the 1-file test PR. The review
  completed in 66 seconds with three confirmed findings and two merged
  duplicates, and its automatic preview took 14 seconds. `--exclude F-3
  --severity F-2=low` planned a new preview in 8 seconds with one inline
  comment and F-2 in the summary only. Publication posted the summary and that
  comment, both read back as `VERIFIED`, and a repeated publication reported
  `ALREADY_PRESENT=2`. This run took the normal adjustment and publication
  path; the failure paths of the later fixes are covered by the offline tests.

This is a pre-publication record. Public Git installation and clean-source
archive acceptance are checked on the release candidate; registry integrity
and installation from npm are checked only after publication, following the
[releasing guide](RELEASING.md). This record does not claim a published 0.3.0
package has been tested. After publication on 2026-10-26, the registry
package's integrity matched the package built from the tag, and installing
`opencode-azure-devops-pr-review@0.3.0` and the `v0.3.0` Git tag passed
`host-v2-smoke.mjs --native --package`.

## Adjusting findings after a preview (2026-10-25)

Commit `cbbed6b` (branch `comment-adjustments`) was installed through
OpenCode's plugin manager as `github:WTLAIB/opencode-azure-devops-pr-review-v2#cbbed6b…`
on the OpenCode 2.1.4 service (its 29 installed files equal the commit), with
gpt-6-luna for every review and quick role, gpt-6.1-sol for every deep role,
output in zh-TW and `afterReview` none for every mode; the service was restored to the published 0.2.3 package
afterwards. Every command ran in the conversation of its review unless noted.
Before the runs that publish, the earlier AZPR comments of the 1-file PR were
deleted and the local publication records of the 1-file and 316-file PRs were
moved aside, so that comments on the same lines were posted again instead of
being reported as `DELETED`.

**Preview only, with the earlier comments still on the 1-file PR.** Its four
AZPR threads made the planner skip all three findings as already discussed, so
these previews had no inline comment.

| Command | Planner input | Result | Planning |
| --- | --- | --- | --- |
| `/pr-review <URL>` | — | COMPLETE in 89 s: 6 candidates, 3 confirmed medium findings F-1, F-2, F-3 (the 3 known defects) | — |
| `/pr-comment` | F-1, F-2, F-3; no `adjustments` field | Index medium 3; the review note named the snapshot, reservation and ordering contracts | 1 request, 9 s |
| `/pr-comment <id> --show` | — | The saved preview; no model or Azure DevOps request | — |
| `/pr-comment <id> --exclude f1` | F-2, F-3; `adjustments.excludedFindings` F-1 | Index medium 2; F-1 named nowhere, and the note no longer mentioned the snapshot contract | 1 request, 12 s |
| `/pr-comment <id> --severity F-2=low,F-3=high` | F-2 low, F-3 high; F-1 still excluded; `severityChanges` | Index high 1, low 1; F-2 skipped as low severity | 1 request, 5 s |
| The same adjustments again | — | "already has these adjustments; nothing was planned"; no model | — |
| `/pr-comment <id> --reset` | F-1, F-2, F-3; no `adjustments` field | Index medium 3, as before the adjustments | 1 request, 8 s |

**The 1-file PR without earlier comments** (three reviews, each COMPLETE in
86–93 s):

- Review A: excluding all three findings answered `NOTHING_TO_POST` in 3 s
  without a model, and `--publish` posted nothing. `--exclude none` stopped
  with `/pr-stop` while it was planned ended `CANCELLED` with the adjustment
  saved and no preview: `--publish` was refused ("was adjusted and has no
  preview planned since") and `--show` reported no saved preview. Setting all
  three to low then planned a summary without inline comments, which was posted.
- Review B, of the same commit: excluding one finding and setting the other two
  to low gave a summary with the marker of review A's summary. Publication
  skipped it as `ALREADY_PRESENT`, and the receipt said that the PR keeps its
  earlier text, which may still list findings you excluded. Afterwards
  `--exclude none` and a plain `/pr-comment <id>` were refused, `--show` said
  that publication had started, and `--publish` again changed nothing.
- Review C confirmed five medium findings, two pairs of them the same defects
  from both reviewers (F-1 and R-1, F-2 and R-3). `--exclude R-1,R-3 --severity
  R-2=high,F-2=low` planned 2 inline comments (R-2 high, F-1 medium) and a
  summary with high 1, medium 1, low 1; all three were posted and read back,
  and no posted text names R-1 or R-3. They were deleted again before the deep
  run below.
- `/pr-deep` COMPLETE in 116 s: 6 candidates, 3 confirmed medium findings
  (the verifier merged the duplicates). `--exclude F-3 --severity F-1=high`,
  planned by gpt-6.1-sol in 19 s (1 request, no correction turn), gave 2 inline
  comments (F-1 high, F-2 medium) and a summary with high 1, medium 1; all
  three were posted and read back with the gpt-6.1-sol disclosure, and no
  posted text names F-3. Afterwards an adjustment was refused and `--publish`
  again reported `ALREADY_PRESENT` for all three. These comments are kept on
  the PR.

**The 316-file PR** (no comments before):

- `/pr-quick` COMPLETE in 186 s (48 findings reported), preview with 25 inline
  comments, 13 of them combining findings of two shards. `--exclude Q-11001
  --severity Q-12014=medium,Q-1013=low` (preview only, 102 s): Q-1001, combined
  with Q-11001 before, got a comment of its own; Q-12014, raised from low, was
  combined with Q-1022 on the same line; Q-1013 stayed in the summary only; the
  disclosure still says the review was not independently verified, and the
  preview names Q-11001 nowhere.
- `/pr-review` COMPLETE in 333 s: 27 confirmed (37 merged), preview with 26
  inline comments and 1 low finding in the summary. R-1009, R-1010 and R-1011
  repeat F-1009, F-1010 and F-1011 from the other reviewer.
- Refused without a change: the same command from another conversation ("No
  completed review is available for this conversation"), `--exclude F-9999`
  ("not a finding of review …", listing the IDs that can be adjusted) and
  `--exclude R-1001` ("was merged into F-1001; adjust F-1001 instead").
- `--exclude R-1009` with the OpenCode service restarted while it was planned:
  the service reloaded in 7 s; `--show` reported no saved preview and
  `--publish` was refused. A plain `/pr-comment <id>` then planned the preview
  with R-1009 still excluded (85 s).
- `--exclude R-1009,R-1010,R-1011 --severity F-1013=high,F-1016=low,F-1022=medium`
  (63 s) planned 23 inline comments and a summary with high 5, medium 18, low 1:
  F-1013 titled high, F-1022 (raised from low) with an inline comment, F-1016
  in the summary only. All 24 items were posted and read back; the three
  repeated defects have one comment each, and no posted text names R-1009,
  R-1010 or R-1011. After publication, adjustments and a plain re-plan were
  refused and `--publish` again reported `ALREADY_PRESENT` for all 24 items.
  These comments are kept on the PR.

No planning stage of these runs needed a correction turn, and the runtime's
check for published text that names an excluded finding never had to act: the
model left excluded findings out of its text. That check, and the receipt line
that counts other AZPR comments of the PR, are covered by the offline tests
only.

## 0.2.3 release acceptance (2026-10-24)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3 and OpenCode CLI 2.1.4.
This release carries the OpenCode 2.1.4 changes recorded
[below](#opencode-214-the-tested-host-2026-10-24): the refused-tunnel mapping,
the Azure DevOps call timeout and the overflow classification after a refused
background summary. Prompts, settings and installers are unchanged from 0.2.2.

- `npm run check` and **394 offline tests** passed.
- All five real-host fixture runs passed with isolated profiles and fake model
  and Azure services: fresh source installation, replacement installation,
  native packed package installation, comment scale, and background
  compaction followed by a permanent failure. The fresh and native runs
  include the authenticating proxy, the untrusted certificate and the 407. The
  scale fixture split the overflowing shard and used eight planning sessions
  with at most two in flight; its largest provider request was 33,419
  characters. The background-compaction fixture ran one functional session,
  classified permanent.
- `npm pack --dry-run --json` lists **70 files** (about 882 KB), including the
  entry, runtime, prompts, configuration example and schema, license and the
  new release notes. It excludes tests, private settings and `.local/` records.
- The release notes use absolute HTTPS links; the relative links and anchors
  of the README, quickstart, changelog and the changed guides resolve.
- These fixtures make no paid-model request or real Azure publication. The
  live reviews on 2.1.4 preceded the call-timeout and background-summary
  changes. Public Git installation, archive acceptance, and post-publication
  registry integrity and native installation are checked on the pushed commit
  and the published package as the [releasing guide](RELEASING.md) describes.

## 0.2.2 release acceptance (2026-10-23)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3 and OpenCode CLI 2.1.2.
This release updates documentation and package metadata. The runtime, prompts,
settings and installers are unchanged from 0.2.1.

- `npm run check` and **392 offline tests** passed.
- All four real-host fixtures passed with isolated profiles and fake model
  and Azure services: fresh source installation, replacement installation,
  native packed package installation and comment scale. The native fixture
  covers first-run setup, default external settings and `options.settingsFile`.
  The scale fixture used eight planning sessions with at most two in flight;
  its largest provider request was 33,479 characters.
- `npm pack --dry-run --json` lists **69 files**, including the entry, runtime,
  prompts, configuration example and schema, license and the new release notes.
  It excludes tests, private settings and `.local/` records.
- The release notes use absolute HTTPS links. Current installation commands,
  local documentation links and anchors were checked, and the existing
  demonstration remains linked to its original v0.2.0 release.
- These fixtures make no paid-model request or real Azure publication. Public
  Git installation, archive acceptance, and post-publication registry integrity
  and native installation results are not included in this pre-publication
  record; they are recorded separately under the [releasing guide](RELEASING.md).

## 0.2.1 release acceptance (2026-10-23)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3 and OpenCode CLI 2.1.2.
The release publishes the 0.2.0 runtime to the npm registry as
`opencode-azure-devops-pr-review`; it changes package metadata, documentation
and test tooling only.

- `npm run check` and **392 offline tests** passed. New tests check that the
  package is publishable (no private flag, dependencies or install scripts),
  that the changelog, release notes, README and quickstart name its version,
  and that release notes, which become the GitHub Release body, link only
  absolute URLs.
- All four real-host fixtures passed with isolated profiles and fake model
  and Azure services: fresh source installation, replacement installation,
  native packed package installation and comment scale (eight planning
  sessions with at most two in flight; largest provider request 33,419
  characters). The native fixture now also checks that the copy OpenCode
  installed in its package cache holds no settings.
- `--native --package` installed the public v0.2.0 Git tag through the plugin
  manager and passed the same native workflow; this is the option used to
  check the published npm package.
- `npm pack --dry-run --json` for `opencode-azure-devops-pr-review@0.2.1`
  lists 68 files (about 874 KB): the entry, runtime, eight prompts,
  configuration example and schema, license and release notes. No private
  settings, tests or `.local/` files are included.
- Relative links and anchors in the changed documentation resolve.
- Publication to npm and the checks after it (registry integrity, the native
  fixture against the registry package) follow the [releasing guide](RELEASING.md)
  once the tag exists; they are not part of this record. No live model request
  or Azure publication was made.

## 0.2.0 release acceptance (2026-10-23)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3 and OpenCode CLI 2.1.2.
The release packages the automatic-comment implementation merged in PR #18;
release preparation changes version metadata and documentation only.

- `npm run check` and **389 offline tests** passed.
- All four real-host fixtures passed with isolated profiles and fake model
  and Azure services: fresh source installation, replacement installation,
  native packed package installation and comment scale. They exercise
  automatic preview/publication, held items, no-findings and repeated-summary
  handling, cancellation, restart, overflow splitting and idempotent writes.
  The scale fixture used eight planning sessions with at most two in flight;
  its largest provider request was 33,470 characters.
- `npm pack --dry-run --json` includes the entry, runtime, eight prompts,
  configuration example/schema, license and release notes. No private settings
  or `.local/` files are included.
- A clean Git archive passed fresh and replacement source installation,
  runtime/entry, license and prompt checks. An actual v0.1.0 source installation
  upgraded with `--replace`, preserving its settings and adding `afterReview`
  as `none` for every mode. Unrelated files and owner-only settings permissions
  were preserved. Archive-relative documentation and image links were checked;
  two obsolete MCP links in the historical record now point to the original
  version of that document.
- The release reuses the inspected v0.1.0 demonstration video unchanged. Its
  recording date, source commit and manual workflow remain explicit in the
  demo guide. No live model request or Azure publication was made for this
  release acceptance; the development evidence below records earlier live runs.

## Automatic comments after a review (0.2.0 development, 2026-10-22 and 23)

Environment as below (Ubuntu 22.04.5 under WSL2, Node 22.23.3, OpenCode CLI
2.1.2). `afterReview`, the review commands' `--preview`, `--publish` and
`--no-comment` flags, the safeguards of automatic publication and the setup
problem messages were added on top of 0.1.0; review prompts were unchanged.

- `npm run check` and **387 offline tests** passed. The new tests cover the
  setting (defaults, partial objects, values never echoed), the flag parser
  (one flag right after the URL, refused typos, dashes and second flags,
  `/pr-check` taking none, context starting after the flag), the hand-off
  (a COMPLETE review previews or publishes in a run of its own; STALE and
  cancelled reviews hand on nothing; a review without findings gets one
  notice and no model request; a flag overrides the setting both ways), the
  safeguards item by item (an `@<…>` mention, an image, HTML that embeds
  content or runs a script, or a `javascript:`, `vbscript:`, `data:` or
  `file://` link in the summary or an inline comment holds back that item
  while the others are posted and read back, and a typed `--publish` then
  posts it; mentions and script links also when written with backslash
  escapes or character references; when every item is held nothing is
  posted; when the PR changed before publication the run is STALE, posts
  nothing and does not offer the held items), what passes (ordinary links, also encoded, protocol-relative, in
  reference definitions inside block quotes and list items, `mailto:` and
  email autolinks; markup such as `<input name="id">` or `<a href>`;
  generics, decorators, AZPR's marker and its own `&lt;!--` escaping), a
  quick review whose high-severity finding or incomplete coverage is posted
  with the quick disclosure and an advisory hint, a plan that would only
  repeat the summary because every finding is already discussed on the PR
  (`NOTHING_TO_POST`, while a typed `--publish` still posts it), a
  `/pr-stop` that arrives while a finished review's report is delivered (the
  review stays COMPLETE and nothing follows), a PR held by another comment
  command, `/pr-stop` of the automatic step, the `/pr-check` row (information,
  no warning), the installer adding `afterReview` and setup naming the problem
  without values. Removing any one safeguard, the per-item filter, the
  nothing-new rule, the no-findings check, the busy-lock handling, the typo
  refusal or the setting itself makes a test fail; so does holding ordinary
  links or `<a>` again, or offering held items for publication after a STALE
  check (14 mutations of this revision's changes, all caught).
- All four real-host fixtures passed on OpenCode 2.1.2 with fake model and
  Azure services: fresh, replacement and native installation, and comment
  scale. The smoke fixture additionally ran `/pr-review <URL> --preview`
  (COMPLETE, then a PREVIEW in a run of its own, nothing posted),
  `/pr-quick <URL> --publish` with a high-severity finding (POSTED, no item
  held; its markers were settled by an earlier step, so nothing new was
  created), `/pr-review <URL> --publish` with an image in its inline comment
  (the summary POSTED and read back, VERIFIED=1, that comment held back with
  the reason; a typed `/pr-comment <id> --publish` then posted it with the
  summary ALREADY_PRESENT and no model request), a quick review without
  findings (one notice and no further provider request), and, after a restart
  with `afterReview.review: publish`, a plain `/pr-review` whose automatic
  publication was POSTED and read back (VERIFIED=2), then the same review
  again with every finding planned as already discussed by that comment:
  `NOTHING_TO_POST`, no second summary.
- The 15 comment previews saved from real reviews (76 items) contain none of
  the held constructs, so the item checks hold back nothing in them. The
  earlier quick-review rule would have held back one of them in full: a quick
  preview of the 316-file test PR with two high-severity findings (24 items),
  which is now posted with the quick disclosure.
- **Live** with this revision installed in the user's OpenCode 2.1.2 service:
  gpt-6-luna for every role, `afterReview` none for every mode and `--preview`
  on the command, so nothing was posted. Times are from first stage start to
  last stage end.
  - The one-file test PR: `/pr-quick <URL> --preview` was COMPLETE in 36 s
    with two REPORTED findings (two of the three known defects), and its
    automatic preview took 6 s.
    `/pr-review <URL> --preview` was COMPLETE in 93 s with the three known
    defects confirmed, and its automatic preview took 24 s. Both previews
    proposed no inline comment: each finding was skipped as `existing-thread`,
    naming the demo threads that already discuss it.
  - The 35-file test PR: `/pr-quick <URL> --preview` was COMPLETE in 44 s
    with no finding (both seeds missed). It got the one notice (`Automatic preview skipped: the
    review has no findings to comment on …`) and no planning session.
    `/pr-review <URL> --preview` was COMPLETE in 88 s with the seeded
    millisecond-format regression confirmed; the other seed was missed, as
    in earlier gpt-6-luna runs. Its automatic preview took 10 s and proposed
    one inline comment.
  - Each automatic preview started less than a second after its review's
    last stage, as a run of its own. Its STARTED notice and receipt named the
    source (`--preview`), and its Azure DevOps calls were reads only.
    `/pr-check` was READY with the new `Automatic comments` row
    (`afterReview: review none, deep none, quick none (no automatic
    comments)`).
  - Earlier attempts that day failed before any model request
    (`provider.auth`: the OpenAI sign-in could not be refreshed until it was
    renewed). Those INCOMPLETE reviews started no comment step.
- **Live automatic publication**, with the user's consent, on the 35-file test
  PR: gpt-6-luna, `/pr-review <URL> --publish`. Before the first run the PR's
  publication record was moved aside: it held seven comments from an earlier
  test that had been deleted on the PR, and with it AZPR would have reported
  matching items as `DELETED` instead of posting them.
  - The first review was COMPLETE in 92 s with the millisecond-format seed
    confirmed. Its automatic publication, a run of its own, planned the
    summary and one inline comment on `json_schema.py:874` and posted both in
    10 s: VERIFIED=2, read back from Azure DevOps, and an independent thread
    listing went from 0 to 2 live AZPR comments. No safeguard applied:
    the findings were verified, and the text had no link, mention, image or
    HTML.
  - A second `/pr-review <URL> --publish` of the unchanged head confirmed the
    same finding (76 s). Its planner skipped the finding as `existing-thread`,
    naming the inline comment just posted, so no inline comment was repeated.
    The summary's marker depends on the set of inline comments, though, so
    the summary differed from the first one and was posted again (VERIFIED=1,
    3 live AZPR comments).
  - That repeated summary led to the repeated-summary rule: automatic
    publication posts no summary for such a plan (no inline comment, every
    finding skipped as `existing-thread` with a live thread). It first kept
    the plan to a preview; it is now `NOTHING_TO_POST` (below).
- **Live, with the review fixes** (the repeated-summary rule, links and
  mentions checked after decoding, and no hand-off after a stop during report
  delivery), on the same PR with those comments deleted and its record moved
  aside again, six more `/pr-review <URL> --publish` runs:
  - Two reviews confirmed the millisecond-format seed. The first was posted
    automatically in 9 s (summary and one inline comment,
    VERIFIED=2, two thread creations). The decoded checks found nothing in
    the real comment text.
  - The second, run while that inline comment was live, was held back to a
    preview in 4 s with "every finding is already discussed on the PR
    (thread …), so there is no new inline comment and only a repeated
    summary would be posted", and created no thread (the behavior of that
    revision; see below for `NOTHING_TO_POST`).
  - Four reviews confirmed no finding: three had no candidate and one had a
    candidate that verification did not confirm. Each got only the
    "Automatic publication skipped: the review has no findings to comment on"
    notice, with no planning session and no write.
  - A stop during report delivery and encoded links cannot be produced on
    demand with a real model; those cases are covered offline. The test
    comments were deleted afterwards.
- **Live, with the per-item safeguards** (the revision before the literal-code
  rule below), on the same PR with those comments deleted and its record
  moved aside again, two `/pr-review <URL> --publish` runs with gpt-6-luna:
  - The first review was COMPLETE in 73 s with the millisecond-format seed
    confirmed. Its automatic publication posted the summary and one inline
    comment on `json_schema.py:874` in 9 s: VERIFIED=2, no item held, and an
    independent thread listing went from 0 to 2 live AZPR comments.
  - The second review of the unchanged head confirmed the same finding
    (84 s). Its automatic run took 7 s: the planner skipped the finding as
    already discussed in the inline comment just posted, and the run ended
    `NOTHING_TO_POST` with "Automatic publication found nothing new to post:
    every finding is already discussed on the PR (thread …). The plan is
    saved." It made two Azure DevOps reads and no write; the listing stayed
    at 2 live AZPR comments.
  - The real comment text again had none of the held constructs. The test
    comments were deleted afterwards.
- **Literal code** (the revision before the closed gaps below, after an
  external review found that a code example such as `` `<img src="avatar.png">` ``
  or a fenced `<script>` example still held back its comment): the checks
  other than mentions now skip fenced code and code spans where every reading
  of the Markdown agrees.
  - `npm run check` and **388 offline tests** passed. The review's four
    examples are posted; texts whose backticks or fences could be read
    another way stay checked (an escaped backtick, a span across lines or a
    heading, a link destination, attribute value, math or bare address that
    takes a backtick, a backslash that a linked address takes along, a pipe
    in a table cell, an HTML block, a fence in a list or indented, a table
    header, a backtick in the info string, CRLF closers, UTF-16 offsets after
    emoji), and mentions stay checked in code. Removing any one of those
    rules, or blanking nothing, makes a test fail (18 mutations); the 13
    mutations of the previous revision are still caught. A 176,000-character
    summary is checked in 15 ms, and the check is linear (a 400,000-character
    line of code spans: 150 ms).
  - Differential fuzzing against commonmark.js 0.31.2 and markdown-it 14.1.0
    (`html` and `linkify` on), outside the repository: 1,000,000 generated
    texts, half random tokens and half templates that put a backtick-taking
    construct before code with markup, blanked about 240,000 code spans and
    124,000 fenced lines; on its source line none of them was raw HTML, a
    link or image destination, or image text for either renderer. Copies
    with one rule removed were caught each time (from 24 to 2,191 hits per
    100,000 texts); two such cases found this way, a backslash or escaped
    backtick taken into a linked address, are fixed and tested.
  - Rendering both renderers' HTML with parse5 7.1.2 over 300,000 texts:
    about 6,600 per 100,000 that the previous revision held are now posted,
    and all but 0 to 6 of them render no active markup. Those few contain
    `<!X…>` or `<?…>`, which browsers turn into comments and no rule checks;
    the previous revision held them only because of code elsewhere in the
    text. The same run found the gaps closed below.
  - All four real-host fixtures passed on OpenCode 2.1.2. The 15 previews
    saved from real reviews still have no held item. No live run: real
    comment text has not contained the held constructs, in code or not.

- **Closed gaps of the literal HTML checks** (the revision before script links
  with a tab or line break, below): HTML that
  hides text (a comment, `<!…>`, `<?…>` or `</` without a tag name, which a
  browser turns into a comment) is a kind of its own; attributes are also read
  the way a browser reads a tag (a quoted value may hold `<` and `>`, a slash
  separates attributes, a tag name runs to a space, slash or `>`, and every
  `<` may start a tag, since a renderer may show an earlier one as text); and
  code in a paragraph that runs into the first line where blanking stops is
  checked as written.
  - That last rule closes a literal-code case the previous revision posted:
    once a link label's lookahead in markdown-it 14.1.0 reaches an unpaired
    backtick later in the paragraph, markdown-it reads every earlier backtick
    as text, so `` [`![a](b.png)` x `` followed by `<b>`` ` `` on the next line
    renders an image. Extended fuzz templates found it; a copy without the
    rule has 244 such cases per 100,000 texts.
  - `npm run check` and 388 offline tests passed. 11 mutations of these rules
    (each hidden-text form, the browser reading of attributes and its every-`<`
    start, attribute-name case, the shared attribute list, the paragraph at a
    stop) are caught, as are the 18 and 13 of the two revisions before.
    Reading attributes from every `<` stays linear: 100,000-character
    adversarial texts take 12 to 40 ms.
  - Gap statistics with parse5 over both renderers' HTML (100,000 texts each,
    random tokens and templates): the previous revision missed 2,235 hidden
    comments and 1,344 active attributes behind quotes or unusual tag names;
    this revision misses none of either. Against the previous revision, no
    text that it held is posted now (200,000 texts). The exact check of
    blanked code found nothing active in 1,000,000 texts.
  - All four real-host fixtures passed on OpenCode 2.1.2. No live run.

- **Script links with a tab or line break** (the revision before linear
  attribute reading, below): a browser drops
  tabs and line breaks from a URL, so `<a href="java&#9;script:…">`, or one
  with a raw tab or line break inside the scheme, is a script link. The
  script-link check now also reads the text, as written and decoded, without
  them, and character references are decoded as a browser decodes them in
  raw HTML: numeric ones with any number of digits or without a semicolon,
  and `&Tab;` and `&NewLine;`.
  - `npm run check` and 388 offline tests passed. 7 mutations of these rules
    are caught, as are the 19, 10 and 13 of the revisions before.
  - The fuzz detector now reads a URL as a browser does (leading and trailing
    control characters and spaces trimmed, tabs and line breaks removed).
    With it, the previous revision missed 674 such links per 100,000 texts;
    this revision misses none, and over 500,000 texts the gap statistics
    found no active construct that the checks miss. No text the previous
    revision held is posted now (200,000 texts), and the exact check of
    blanked code found nothing active in 300,000.
  - All four real-host fixtures passed on OpenCode 2.1.2. The 15 previews
    saved from real reviews still have no held item. No live run.

- **Linear attribute reading** (this revision, after an external review found
  that reading attributes from every `<` rescanned the rest of a tag name
  each time): a tag name runs to a space, slash or `>`, so a long run such as
  `<a<a<a…`, also inside a quoted value, took quadratic time and blocked the
  plugin while the check ran. The end of every tag name, attribute name and
  value is now looked up in tables built once per text, and each point
  between attributes is read once. Attributes are separated by ASCII
  whitespace only, as in a browser, since a no-break space ending a value
  could pair quotes differently and hide an `on…=`.
  - Measured on the same machine for `<a` repeated: 212, 854 and 3,439 ms for
    32,000, 64,000 and 128,000 characters before; 20, 18, 32 and 62 ms for
    32,000 to 256,000 characters now. The same inside a quoted value: 245 and
    883 ms for 32,000 and 64,000 characters before; 65 and 136 ms for 64,000
    and 256,000 now. Other repeated tag-like units of 256,000 characters take
    47 to 122 ms, and 40 random 100,000-character tag-like texts at most
    56 ms.
  - `npm run check` and **389 offline tests** passed, among them a test that
    bounds the time for five long tag-like texts and one for the no-break
    space. 9 mutations of the reading (the tables, the quoted values, slashes,
    name case, every `<` as a start, ASCII whitespace, the read points, long
    event-handler names, a rescanned tag name) are caught, the slow ones by
    the time bound, as are the 19, 7 and 13 of the revisions before.
  - Fuzzing: no gap over 200,000 texts, the same holds as the previous
    revision on 200,000, and nothing active in blanked code on 100,000. All
    four real-host fixtures passed on OpenCode 2.1.2. No live run.

## 0.1.0 release acceptance (2026-10-22)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3 and OpenCode CLI 2.1.2.
The native package entry and first-run setup were added on top of the merged
2.1.2 compatibility revision (`e1597ca`); review prompts were unchanged.

- `npm run check` and **367 offline tests** passed. The ten setup tests cover
  settings-path precedence, literal argument parsing, unavailable models and
  variants, private PAT-file validation, refusal to overwrite without
  `--replace`, preservation of advanced settings, atomic saves and blocked
  review commands before setup. They make no model or Azure requests.
- All four real-host fixtures passed with isolated profiles and fake model
  and Azure services: fresh source installation, replacement installation,
  native package installation and comment scale. The native fixture packs the
  package, installs an isolated Git commit through `opencode plugin add`,
  configures it with `/pr-setup`, restarts the host and exercises the review
  and publication workflow. Both the default external settings path and
  explicit `options.settingsFile` work; the file remains mode 600 and is
  outside the package cache.
- A separate clean profile installed public GitHub commit `f323aaa` with the
  documented `github:WTLAIB/opencode-azure-devops-pr-review-v2#COMMIT` syntax.
  The actual cached entry loaded, setup blocked reviews until configuration,
  and restart enabled the review and quick agents with the external settings
  unchanged. This acceptance made zero model or Azure requests. A clean source
  archive also passed fresh and replacement installation, entry loading,
  license and prompt checks, and preservation of settings and unrelated files.
- The scale fixture reviewed 120 changed files, recovered one overflow split,
  used seven functional, five risk and two verifier sessions plus one duplicate
  check, and planned eight pages with at most two in flight. Its largest
  captured provider request was 33,488 characters. It created 20 fake Azure
  threads and re-published without duplicates. These are controlled fixture
  measurements, not a bound on arbitrary real PRs or model behavior.
- A separate **live** run used `openai/gpt-6-luna` for all three review roles
  against the dedicated one-file Azure test PR #2, head `e8fc383` and base
  `406f5b2`. Review `268cc3f3` completed in 65.0 seconds: six initial candidates,
  three CONFIRMED findings and three MERGED duplicates. The findings matched
  the fixture's seeded atomicity, snapshot-isolation and timestamp-ordering
  regressions. The reviewers did not execute the fixture's tests.
- Its comment preview completed in 15.6 seconds with three inline comments
  and no skipped finding. Explicit publication took 1.5 seconds and read back
  four VERIFIED threads (one summary and three inline comments). A repeated
  publish took 0.5 seconds and reported four ALREADY_PRESENT items. An
  independent Azure REST GET also found exactly those four active threads;
  they were retained on the test PR. No active comment existed before this
  run, and historical deleted comments were left alone.

The [demo](DEMO.md) uses the actual terminal output and actual Azure comment
read-back from this run. It shortens waits and navigation, as documented with
the recording. It is evidence of this workflow on this test PR, not a claim of
general model accuracy, and the Azure read-back is terminal output rather than
an Azure web UI screenshot. The live run used an isolated source installation;
native setup and package loading were tested separately by the host fixture.

The first CI native-package run failed before the TUI admitted its startup
command. Local failure traces and the OpenCode 2.1.2 source identified a startup
race: `--prompt` can run before plugin commands reach the TUI catalog and become
an ordinary model prompt. CI did not retain its raw terminal capture, so that
run's cause cannot be established from its log alone. The fixture now waits for the actual native command in
slash completion and submits it interactively, preserving both new/existing
conversation and same-TUI cancellation checks. The runtime was unchanged;
the [troubleshooting note](DEBUGGING.md#a-startup-slash-command-becomes-an-ordinary-prompt)
records the host limitation.

## Onboarding and source distribution (2026-10-19)

The `codex/project-launch` changes, based on `d7cd0ac`, add onboarding,
synthetic demo assets, an MIT license and release preparation. The installer
now includes the license in the installed package; the documented minimal
source package contains 31 files (30 since `deep.md` was dropped, see
[deep versus review](#deep-versus-review-2026-10-19)). Review and publication
runtime code and prompts are unchanged.

- `npm run check` and all **345 tests** passed, including the updated manual
  source-package list, directory loading and installed license contents.
- Fresh and replacement installation passed with **OpenCode 2.0.32**. The
  comment-scale fixture passed with 120 changed files, eight planner sessions,
  at most two planning sessions in flight and 20 fake Azure threads.
- These host tests use loopback fake Azure DevOps and model services in
  isolated directories. No live model or Azure publication was run for this
  documentation/distribution change.
- Local guide links and anchors were checked. The demo's synthetic finding
  passes the actual comment-plan validator and renderer; the SVG and GIF were
  inspected visually. They demonstrate presentation, not model accuracy or
  real Azure UI rendering.

At that point, the 0.1.0 release notes were still a draft. See the release
acceptance above for the subsequent native package and recorded live run.

## Environment

Ubuntu 22.04.5 LTS (WSL2, kernel 6.18), Node 22.23.3, OpenCode CLI 2.0.22,
Azure DevOps Services REST api-version 7.1. Date: 2026-10-10. From
2026-10-17 the tested host was OpenCode CLI 2.0.32
([below](#opencode-2032-2026-10-17)), from 2026-10-22 2.1.2
([below](#opencode-212-2026-10-22)); since 2026-10-24 it is 2.1.4
([below](#opencode-214-the-tested-host-2026-10-24)).

## Offline tests

`npm run check` and `npm test` pass: 384 tests across settings (including the
`mcp` → `azure` migration, the proxy and TLS settings and `afterReview`), host helpers, session
transport, the shared queue,
the REST client (change paging, merge base, error classes, retries, timeouts
that abort requests, binary and oversized files, the per-run cache, PAT never
logged, commit messages, the repository zip with a streaming size limit, proxy
and TLS options on every request, certificate, proxy-authentication, gateway and
Bun connection errors, proxy credentials never logged),
content search (zip reading, refused ZIP64, encrypted and damaged archives,
literal, case and whole-word matching, path filters, result bounds, one archive
per run and commit), line diffs (minimal edits checked against brute force on random
inputs, context, enclosing blocks, folded repeats, and every changed line shown
in a hunk or a folded repeat on random inputs), the reviewers' tools
(diffs of edited, added, deleted and renamed files, paging, file and content
search, optional arguments sent as null or blank text),
output acceptance and correction prompts (including verifier rows judged by
their own fields, confirmations that move a finding to another file and the
same-file duplicate check), comment validation and markers (including skips
that rely on another finding, and skip causes checked against the finding, the
page's source excerpts and the live threads, and pages of a large PR carrying
only their own files and dispositions), planning and publication, review sharding,
persistence, rendering, installation (including an output pipe closed
mid-install, which used to leave the lock and a staged copy of the previous
settings) and the runtime integration (fake host plus a fake Azure DevOps REST
service, including session deletion when the host never confirms one, a host
retry that OpenCode prepares again, the stage inactivity watchdog stopping,
naming and retrying a stalled stage while steady activity, streamed output, a
slow AZPR tool and an announced retry wait are never stopped, a PR without changed files, a
review without candidate findings that still gets its verifier, the token usage
kept per request in stage records, the project boundary for private roles
whatever the host's default for external directories, and the `/pr-check`
warning on a host without the permission hook).

The quick review (2026-10-18) adds tests for: one reviewer per shard and no
verifier; REPORTED and NEEDS_INFO decided by the runtime's form and source
checks (deleted, renamed, unchanged and binary files, line ranges, and reads
counted only for the session that made them, never another shard's or the
runtime's own, and only for versions whose source the answer showed, so a
line, column or hunk past the end, an empty file or identical versions are no
read; a diff showing only removed or only added rows, cut before the other
version's rows or showing only folded repeats reads just what it showed, and
an answer cut to the tool-output limit reads nothing);
different defects on the same line kept apart while only
records identical in every field are merged; a parsed answer without a usable
review giving PARTIAL; zero findings with incomplete coverage (a failed shard,
reviewer gaps, a partial change list); a usable PARTIAL answer that names
unfinished work getting one follow-up turn in the same session (completed, a
second PARTIAL that stands, none for COMPLETE answers, without turn budget or
in the verified pipeline, and an unusable, failed or watchdog-stopped
follow-up keeping the answer it followed while an overflow still splits the
shard); the quick disclosure line, report and
receipt; quick inline comments needing a changed HEAD file and an anchor found
in the source; a saved quick review commented on after a restart, and saved
records without a verification field trusted only for review and deep;
quick-then-review publication where only an identical complete marker is
ALREADY_PRESENT (the same anchor with a second defect posts ordinal 1); an
unavailable quick model or a changed quick agent blocking only `/pr-quick`;
the installer adding an empty `models.quick.reviewer`; and the review and deep
system prompts byte-identical to the previous revision (SHA-256 per role).
Combining cross-shard duplicates in comment planning adds tests for: candidate
groups only across sessions, with one severity and overlapping lines (never
within a session, across files, for summary-only or low findings, or beyond a
page); groups kept on one page and oversized groups planned apart; the
combination rules (a chain of overlaps with no common line or two members of
one session refused, a missing reason, an anchor outside the shared lines,
verified reviews never combining); a refused combination keeping valid single
comments and accounting for every ID; separate comments on one line staying
separate; summary rows and counts following accepted combinations only;
`findingIds` in the ledger with older plans still readable; and, end to end,
one comment for a duplicate pair that a refreshed preview and a second
publish leave alone, a later `/pr-review` finding the combined comment by its
ordinal-0 marker, and a combination that never meets the rules leaving both
findings in the summary index.
Planning two pages at a time (2026-10-19) adds tests for: a plan identical to
planning one page at a time, finding by finding and marker by marker, when page
2 finishes first (including two pages quoting the same line, whose ordinals
follow page order); at most `parallel` pages in flight and two lanes that do
overlap; only the first page writing the summary note, a note from another page
dropped without a correction turn while its details stay, and the first page's
continuation still allowed to write it; a continuing page whose checkpoint and
continuation evidence ignore another page's reads and details; after a failure
no new page or continuation, a page still preparing its input starting no model
work, the running page finishing before the failure is thrown, and the lower
page's failure winning; anchor checks that see exactly the HEAD source of the
page's own and earlier pages whichever fetch finishes first (review and quick);
and, in the runtime, two planner sessions at once but one when
`workflow.parallelSessions` is 1, session titles and evidence carrying the page,
a failed page whose running neighbour finishes before INCOMPLETE, and `/pr-stop`
cancelling both running pages and keeping no plan. Removing one rule at a time
from a copy of the code (assembly in page order, the page's own observed
source, page-scoped evidence, the check before a model call, the summary rule,
waiting for running pages, two lanes, the `parallelSessions` cap, page labels,
page-tagged evidence) made the matching tests fail; their waits are bounded, so
a broken lane fails a test instead of hanging it.
Dropping the deep-only prompt text (2026-10-19) changes the prompt test: every
deep role must have the review role's system prompt and permissions with a
different model, and the review roles keep their SHA-256 hashes; the installer
and the manual copy list no longer carry `src/prompts/deep.md` (30 files with
the license). New tests cover `/pr-check` saying that `/pr-deep` is off (no or
only some deep models), would repeat `/pr-review` (the same models in all three
roles, not when one differs) or lacks a model (a WARNING that leaves the check
READY and `/pr-review` running), the command descriptions OpenCode lists and
the error of an unconfigured `/pr-deep`.
The PAT file (2026-10-21) adds tests for: `azure.patFile` as an absolute path in
place of `azure.pat` and never both; a PAT read from an owner-only file that the
fake service accepts, while neither the PAT nor the path appears in a receipt;
a file that is missing, a symbolic link, a folder, readable by others, larger
than 4 KB, empty, holding two tokens or a placeholder stopping the load with an
error that never contains the content; a FIFO refused at once instead of
waiting for a writer, which would hang loading and every later command; a replaced or newly shared file blocking
new commands while the running review completes; and the installer adding an
empty `azure.patFile` without printing the PAT. Removing each check from a copy
of the code (mode, symbolic link, recheck before a command, the file's PAT
used for requests, both settings at once, the content check, the non-blocking
open) made its test fail.
Comments deleted on the PR (2026-10-22) add tests for: a thread recognized as
deleted when Azure DevOps lists it flagged deleted or with its first comment
deleted and without content (a deleted reply leaves it live); a created item
whose thread is deleted reported as `DELETED`, counted as settled and never
posted again, by the same review or another one with the same marker, also
when a run in between saw the comment and when the comment was found without
a record of its own; a thread already deleted at read-back; and the receipt
saying that `DELETED` items are not posted again and that `UNVERIFIED` items are
never posted twice. The host fixture deletes the inline comment after the
re-run and expects `DELETED` without a write. Reading back without the deleted
check, or dropping the record of a comment once it is seen (the earlier
behaviour, which posted it again after a deletion), made the matching tests
fail.
The move to OpenCode 2.1.2 (2026-10-22) adds tests for: a used-up provider
quota (`provider.quota`) or OpenCode free-model limit (`provider.free-limit`)
named in the stage error, with or without a valid HTTP status and without the
provider's own text, classified as permanent, and, end to end, a 429 quota
failure that starts no second session and says why in the receipt; and the
tested host version. Removing the quota rule from a copy of the code made
these tests fail.
The move to OpenCode 2.1.4 (2026-10-24) adds tests for a proxy that refuses
the CONNECT tunnel as Bun 1.4.4 reports it, a rejection with
`ERR_PROXY_TUNNEL` and the proxy's status: 407, 403 and 502 keep the messages
and retry rules of the answers Bun 1.4.2 returned, and a refused tunnel never
makes a write uncertain. Removing the mapping, the not-sent code or the
not-forwarded flag from a copy of the code made these tests fail. Every Azure
DevOps request now also asks the runtime for no idle limit of its own
(`timeout: false`), so `azure.callTimeoutSeconds` alone ends a silent call;
removing the option made its test fail. A refused background summary no longer
marks a stage as overflow: tests cover it followed by an HTTP 401 in the first
turn and in a follow-up (permanent, no split, the earlier answer stands) and a
failed turn with and without the host's compaction message. The previous code
failed them.

## REST API version check

Read-only requests against a live Azure DevOps Services organization: every
resource AZPR uses reports a minimum version of 1.0 or 3.0, a released version
of 7.1 and a maximum of 7.2. The PR, iterations, iteration changes, threads,
item (raw and JSON) and folder requests returned identical fields on 5.0, 5.1,
6.0, 7.0, 7.1 and 7.2-preview. An invalid PAT or a missing credential returns
HTTP 203 with an HTML sign-in page, an out-of-range version returns 400
`VssVersionOutOfRangeException`, and a missing PR returns 404 `TF401180`. Thread
creation with 7.1 was exercised in the live run below.

## Exact-host fixtures

`tests/host-v2-smoke.mjs` (fresh install and `--replace`) runs the real OpenCode
2.0.22 binary with a loopback fake model provider, a loopback fake Azure DevOps
REST service and one foreign stdio MCP server. Both passed:

| Scenario | Observed |
| --- | --- |
| `/pr-check` | READY with zero model requests; REST reads only. |
| `/pr-review` | COMPLETE; reviewers read HEAD through `azpr_read_file` and searched HEAD's file contents through `azpr_search_code` (one repository zip for the run); `shell`, `execute` and the foreign MCP tool were absent from every private model request; the verifier was corrected by one repair turn in the same session; the runtime read the change list and rechecked versions; PROGRESS notices reached the conversation; the review was persisted. |
| `/pr-comment` | PREVIEW, then `--publish` POSTED one summary and one inline comment with markers and file context. |
| Restart | After restarting the host, `/pr-comment --publish` returned POSTED with ALREADY_PRESENT, no new writes and no model request. |
| Deleted comment (2026-10-22, OpenCode 2.0.32) | After the inline comment was deleted the way Azure DevOps deletes one (thread listed, flagged deleted, comment without content), `/pr-comment --publish` returned POSTED with that item `DELETED` and no new write. Fresh and `--replace` runs. |
| Tool scopes | An ordinary conversation's model request carried the foreign MCP tool and no `azpr_*` tool. |
| Unattended approvals | A reviewer's native `grep` on the repository path `/scale_lab` was refused with a pointer to the azpr tools (`permission.rejected`) instead of waiting; no approval request remained open. Since 2026-10-17 the fixture also greps `/etc`, an existing directory outside the project, which is refused with the same pointer on 2.0.22, 2.0.31 and 2.0.32 (see [OpenCode 2.0.32](#opencode-2032-2026-10-17)). |
| `/pr-stop` | A review hanging at the provider was CANCELLED. |
| Provider retry (2026-10-14) | The fake provider answered the risk reviewer's first request with HTTP 503. OpenCode retried it in the same session after its backoff (1.6–2.3 s in eleven runs, two of them in CI); AZPR's `retry` hook allowed it (attempt 2), the resend passed the primary-request check (4 authorized primary requests, none rejected) and the review was COMPLETE without a new session. Fresh and `--replace` runs. |
| Stalled and long streams (fresh run, 2026-10-15) | With `workflow.stageIdleSeconds` 60, two reviews ran at once. In the first, the fake provider sent the functional reviewer's response headers and then nothing. After 60.0 s the watchdog stopped the stage: `failure=idle`, error `Stage inactivity watchdog stopped this stage: no activity for 60 s after model request 1 was sent (workflow.stageIdleSeconds).`, an inactivity notice and a PROGRESS retry notice naming it. AZPR interrupted the session, OpenCode closed the provider stream and confirmed settlement (no cancellation warning), and a new session completed the review. In the second, the functional answer streamed one chunk per second for 66.0 s, longer than the window, and ran on without a stop or a new session. Both were COMPLETE 66.3 s after the commands. |
| Private sessions | Generate and compaction on a private session sent no provider request; ordinary generation still worked. |
| TUI | New and existing TUI sessions kept their origin and cancelled from the same TUI. |
| Proxy (fresh run, 2026-10-13) | The fake service served HTTPS with a certificate from a fixture CA, reachable through a CONNECT proxy that demands Basic credentials. With `azure.proxy` (credentials containing `@` and a space, percent-encoded) and `azure.caFile`, `/pr-check` was READY over one tunnel; the proxy saw the percent-decoded credentials and no `Authorization` header. Without the CA file: NOT_READY with the certificate message, no retry, no request reached the service. Without proxy credentials: NOT_READY explaining HTTP 407. `verifyTls: false`: READY with a WARNING row. The proxy password appeared nowhere in the fixture except the installed `settings.json`. |

The first smoke attempt failed: AZPR's tools were registered without
`codemode: false`, so OpenCode placed them behind CodeMode `execute`, which
private reviewers may not use, and reviewers saw no AZPR tool. The tools are now
registered with `codemode: false`, and the test tool registry applies the same
rule so the offline runtime tests catch a regression.

`tests/host-v2-comment-scale.mjs` passed on the same host:

| Property | Observed |
| --- | --- |
| Changed files | 120, reviewed in 5 shards of 24 per role; functional reviewers read whole files, risk reviewers read diffs |
| Context overflow | One functional shard reported a nearly full context; the host attempted compaction, AZPR refused it, and the shard was split into `1/5a` and `1/5b`, both COMPLETE |
| Verification | 30 findings in 2 verification sessions; the second verifier moves one high finding into a file of the first |
| Duplicate check | One `dedupe` session for that file, which merges the moved duplicate |
| Planning | 8 pages of at most four findings (29 findings); since 2026-10-19 two at a time: the fake provider holds the first page until a second arrives, and at most two planning requests were in flight |
| Publication | 20 threads (19 inline, 1 summary; 10 low findings in the summary); a second publish wrote nothing |
| Largest provider request | 31,136 characters (27,185 before the duplicate rules and the diff and search tools) |
| REST calls | 74 |

## OpenCode 2.1.4, the tested host (2026-10-24)

Since 2026-10-24 the tested host is OpenCode CLI 2.1.4 (`TESTED_HOST_VERSION`;
CI runs the exact-host fixtures with it). 2.1.3 was not tested on its own.
Reviewing the 137 commits from `v2.1.2` to `v2.1.4` of the OpenCode source and
running the fixtures found one change AZPR had to absorb, in the proxy
behaviour of the embedded runtime:

| Area | 2.1.2 → 2.1.4 |
| --- | --- |
| Plugin context | Every method AZPR calls is unchanged; the plugin package changed only its types. |
| Hooks AZPR uses | `prompt`, `context`, `model.request` (kinds `primary`, `compaction`, `generate` and `title`), `retry`, `permission.evaluate` and the tool hooks keep their shapes, as do the token counts on assistant messages. |
| Host constants | The continuation text, the streamed event names and the permission defaults are unchanged. |
| Runtime | The embedded Bun moved from 1.4.2 to 1.4.4. When a proxy refuses the CONNECT tunnel, for example with HTTP 407, `fetch` now rejects with `ERR_PROXY_TUNNEL` and the proxy's status instead of returning the proxy's answer, and it resets the proxy connection. AZPR maps the rejection to the same proxy messages and retry rules as before, and a refused tunnel never makes a write uncertain. A refused connection is now `ECONNREFUSED` rather than `ConnectionRefused`; AZPR already recognized both. |
| Compaction | `experimental.background_compaction` (off by default) prepares summaries through the same `compaction` request, which AZPR refuses for private reviewers before anything is sent; the turn goes on. A compaction the host attempts in the turn opens its message first and ends the turn, so overflow is now read from the failed turn's messages (see below). More provider context-overflow errors now reach AZPR as compaction attempts and therefore split the shard. |
| Models | With a ChatGPT sign-in, the OpenAI context caps moved into a built-in plugin with the same input limits (272,000 tokens; 500,000 for gpt-6.1-sol). A session without its own model now uses its agent's model; AZPR always sets both. |
| New tools | The experimental TUI terminal tools and client-hosted MCP tools are outside the private roles' allowlist, so reviewers neither see nor run them. |

- Exact-host fixtures with 2.1.4 installed into a disposable prefix: with only
  the tested version changed, the fresh and native runs failed in the proxy
  step. The 407 check received `ERR_PROXY_TUNNEL`, AZPR retried it as a
  network error, and the fixture proxy stopped on the reset connection; the
  replacement and comment-scale runs passed. With the mapping and a fixture
  proxy that tolerates a reset, all four passed: fresh, replacement, native
  and comment scale.
- An external review of this revision found that a refused background summary
  still marked its stage as overflow. On the exact host with background
  compaction on, a functional reviewer whose first response passed the
  background threshold and whose next request failed with HTTP 401 was split
  into new sessions that failed the same way: 7 functional sessions for 4
  files. Overflow is now read from the failed turn's messages. The new
  `host-v2-background-compaction.mjs` fixture passes with one functional
  session classified permanent and fails with the previous code; the other
  four fixtures still pass, including the refused foreground compaction and
  split at scale, whose failed turn holds the host's compaction message (still
  `running` when the turn ended).
- A probe in each runtime (`BUN_BE_BUN=1 opencode`) showed the difference: for
  407, 403 and 502 answers to CONNECT, Bun 1.4.2 resolves with that status and
  Bun 1.4.4 rejects with `ERR_PROXY_TUNNEL` carrying it; a proxy that closes
  without an answer gives ECONNRESET in both.
- The same probe found that `fetch` in both runtimes ends a request that
  receives nothing after about 370 seconds unless it passes `timeout: false`.
  `azure.callTimeoutSeconds` accepts up to 1,800 seconds, so a longer setting
  used to end at that point with a retried network error. AZPR now passes
  `timeout: false`, and its own per-call timeout decides. In 2.1.4's runtime,
  AZPR's client sent one comment write to a silent server with a 400-second
  timeout: without the option it ended at 372 seconds with `network error (23)`,
  with it through AZPR's per-call timeout (413 seconds by the wall clock).
- Upgrade: `npm install -g @opencode/cli@2.1.4`; the background service,
  still running 2.1.2, was then stopped and its database copied before 2.1.4
  first opened it, and the service was started on 2.1.4. With this revision
  `/pr-check` on the 1-file PR was READY without a host notice.

Live on the upgraded background service with this revision (gpt-6-luna for
quick and review, `workflow.parallelSessions` 8, each review followed by a
comment preview; nothing was posted):

| PR | Mode | Review | Sessions / requests | Input (cached) | Findings | Preview (inline) |
| --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | quick | COMPLETE, 48 s | 1 / 6 | 39 K (60 %) | the 3 known defects | 7 s (0; the PR's threads already discuss all 3) |
| | review | COMPLETE, 75 s | 3 / 12 | 84 K (52 %) | the 3 known defects | 7 s (0; already discussed) |
| PR #4, 35 files | quick | COMPLETE, 36 s | 2 / 7 | 167 K (52 %) | no candidate for either seeded regression | 3 s (0) |
| | review | COMPLETE, 75 s | 5 / 15 | 309 K (55 %) | the seeded regression in the diff | 10 s (1) |
| PR #3, 316 files | quick | COMPLETE, 136 s | 13 / 51 | 1.81 M (66 %) | all 24 seeded policy defects | 74 s (23) |
| | review | COMPLETE, 297 s | 30 / 128, 1 correction | 4.45 M (72 %) | all 24 seeded policy defects, no other finding | 98 s (30) |

All six reviews and previews completed with no AZPR retry, failed stage,
inactivity stop, tool timeout, blocked tool, host retry, rejected model request
or Azure DevOps retry; one reviewer once called a diff tool without its path
and got the host's argument error. The results stay within gpt-6-luna's range
on 2.1.2: which of the two seeded regressions in the 35-file PR a run finds
still varies between runs. These live runs preceded the `timeout: false`
change, which the fixtures and the probe above cover.

## OpenCode 2.1.2 (2026-10-22)

From 2026-10-22 to 2026-10-24 the tested host was OpenCode CLI 2.1.2, which
the user's company ran then (`TESTED_HOST_VERSION`; CI ran the exact-host
fixtures with it).
2.1.0 and 2.1.1 were not tested. Reviewing the 146 commits from `v2.0.32` to
`v2.1.2` of the OpenCode source found nothing AZPR depends on changed:

| Area | 2.0.32 → 2.1.2 |
| --- | --- |
| Plugin context | `session.list` was added (paged, 50 per page); every method AZPR calls is unchanged. Session archiving exists only in the HTTP API. |
| Hooks AZPR uses | `prompt`, `context`, `model.request` (its `kind`), `retry` (`attempt`, `decision`), `permission.evaluate` and the tool hooks keep their shapes; the retry schedule moved into a shared module with the same event. |
| v2.1 breaking changes | Provider replay data renamed to `native`, compactions referencing kept messages, `session.compacted` removed, credential form answers in `metadata`: AZPR reads none of them. A session that 2.1 compacts cannot be loaded by 2.0.x, so a downgrade needs the database backup taken before the upgrade. |
| Host constants | The continuation text, the streamed event names and the embedded Bun 1.4.2 are unchanged; permission defaults are unchanged. A built-in `todowrite` tool exists behind an experimental flag; private roles see only their allowlist. |
| Errors | Provider session errors may carry `retryAfterMs`, and OpenCode's free models report `provider.free-limit`. AZPR now treats it and `provider.quota` as permanent (see offline tests); before, a 429 status made them look transient and a new session repeated the failure. |
| Idle locations | 2.0.32 interrupted the sessions of a location without session events for 60 minutes; 2.1.2 keeps a location with running sessions or background jobs (`experimental.location_idle_timeout` changes the period). A review's sessions emit events throughout, and AZPR's stage inactivity watchdog stops a silent stage after 600 s by default, long before either host would. |

- Exact-host fixtures: `host-v2-smoke.mjs` fresh and `--replace` and
  `host-v2-comment-scale.mjs` passed on 2.1.2 twice: first with the previous
  revision changed only in its tested version (2.1.2 installed into a
  disposable prefix), then with this revision on the upgraded system
  install. Every scenario passed, including the provider 503 retried in place
  (4 authorized primary requests, none rejected), the inactivity watchdog, the
  refused compaction and shard split, publication with a deleted comment, and
  the proxy.
- Upgrade: with the background service stopped, its database was copied
  first; then `npm install -g @opencode/cli@2.1.2` and a start. The previous
  revision's `/pr-check` on the 1-file PR was READY on 2.1.2 with a host
  notice; with this revision it was READY without one.

Live on the upgraded background service with this revision (gpt-6-luna for
quick and review, `workflow.parallelSessions` 8, each review followed by a
comment preview; nothing was posted):

| PR | Mode | Review | Sessions / requests | Input (cached) | Findings | Preview (inline) |
| --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | quick | COMPLETE, 35 s | 1 / 4 | 26 K (63 %) | the 3 known defects | 20 s (3) |
| | review | COMPLETE, 79 s | 3 / 14, 1 correction | 100 K (72 %) | the 3 known defects | 19 s (3) |
| PR #4, 35 files | quick | COMPLETE, 52 s | 2 / 7 | 176 K (61 %) | the seeded regression in the diff | 8 s (1) |
| | review | COMPLETE, 86 s | 5 / 25 | 684 K (72 %) | no candidate for either seeded regression; the verifier rightly rejected the one other candidate | 3 s (0) |
| PR #3, 316 files | quick | COMPLETE, 134 s | 13 / 56 | 2.07 M (71 %) | policies 23 of 24 (not `queue_priority`), not the configuration defect | 65 s (23, 3 combined) |
| | review | COMPLETE, 370 s | 39 / 151, 2 corrections | 4.68 M (71 %) | policies 24 of 24, not the configuration defect, one false low finding on a test file (summary index only) | 87 s (25; 3 low skipped) |

- The 12 runs had no AZPR retry, failed stage, inactivity stop, tool timeout,
  blocked native tool, host retry, Azure DevOps retry or warning, and every
  session was confirmed stopped; one reviewer tool call on PR #3 returned an
  error. `/pr-check` was READY before each review, without a host notice.
- The results stay within gpt-6-luna's earlier runs on 2.0.32: the PR #4
  regression outside the diff is still missed, and the quick miss of one
  policy and the false test-file finding occurred before. PR #3's review took
  longer than earlier runs (226–300 s); it ran eight duplicate checks, for
  verified findings that ended up in the same files.

## OpenCode 2.0.32 (2026-10-17)

From 2026-10-17 to 2026-10-21 the tested host was OpenCode CLI 2.0.32, the release the
user's company ran (`TESTED_HOST_VERSION` in `src/host.mjs`; CI runs the
exact-host fixtures with it), and receipts add a host notice for any other
version. Other results on this page used 2.0.22 unless noted; 2.0.31 was
checked on the way. The published 2.0.31 and 2.0.32 binaries embed Bun 1.4.2
like 2.0.22:

| Check | Observed |
| --- | --- |
| Exact-host fixtures | `host-v2-smoke.mjs` fresh and `--replace` and `host-v2-comment-scale.mjs` passed on 2.0.32 (and on 2.0.31 and 2.0.22 with the same checks): every scenario of the tables above, plus token usage in the debug stage records for every model request of the review. Since 2026-10-18 the smoke fixture also runs `/pr-quick` (one quick session, no verifier, the session's reads recorded) and its comment preview with the zh-TW quick disclosure line; fresh, `--replace` and the scale fixture passed on 2.0.32. Since the quick follow-up, two more `/pr-quick` runs have a fake reviewer that answers PARTIAL first: its one follow-up prompt reaches the same session and completes the review, or gives no usable answer and the earlier answer with its finding stands (receipt `follow-up=completed` / `unusable`); fresh, `--replace` and the scale fixture passed on 2.0.32. With planning two pages at a time (2026-10-19) fresh, `--replace` and the scale fixture passed on 2.0.32, the scale fixture with two planning requests in flight at once (8 planner sessions, 20 threads, a second publish writing nothing). |
| Project boundary | 2.0.31 dropped the `external_directory: ask` rule that 2.0.22 put in every new agent's default permissions, and 2.0.32 keeps it out, so external paths fall under `*: allow`. AZPR's permission hook only turned `ask` into `deny`, and on 2.0.31 a private reviewer's native `grep` on `/etc` ran and returned file contents. The hook now decides `external_directory` for private roles itself: allowed only when every resource is in AZPR's private data directory, otherwise refused with the pointer to the azpr tools. No live run used a native read tool outside the project; the one live review on 2.0.31 before the fix used only AZPR's tools. |
| Missing local paths | 2.0.31 and 2.0.32 answer a native `grep` on a path that does not exist locally, such as the repository path `/scale_lab`, at once with `Search path does not exist`, before any permission request; 2.0.22 asked, and AZPR refused with the pointer. Neither waits. |
| Host constants | The continuation text, foreign message types and streaming event names in `host.mjs` are unchanged in 2.0.31 and 2.0.32; both send `session-id`, `thread-id` and `x-client-request-id` on the ChatGPT token-sharing route (below). |
| Live, after upgrading the user's background service from 2.0.22 to 2.0.31 | `/pr-check` of the 1-file PR was READY; a review-only `/pr-review` was COMPLETE in 75 s with the same three confirmed findings as on 2.0.22. With the boundary fix installed, `/pr-check` was READY again. |
| Live on 2.0.32 (the service upgraded again, this revision installed) | `/pr-check` was READY without a host notice; a review-only `/pr-review` of the 1-file PR was COMPLETE in 75 s with the same three confirmed findings. The debug stage records held one token row per model request (4, 5 and 4 requests), and 54.4% of the run's input was read from the cache. |

## Prompt cache with a ChatGPT subscription (2026-10-16/17)

OpenCode reports for each assistant message `input` (without cached input),
`cache.read` and `cache.write`; stage records keep these numbers as `tokens`
([debugging](DEBUGGING.md)), and the cached share is
`cache.read / (input + cache.read + cache.write)`. Measured with real models
through the user's OpenCode service, with OpenAI signed in through "Sign in with
ChatGPT" (token sharing: `api.openai.com/v1` over HTTP), gpt-6-luna unless
noted:

| Host and workload | Cache |
| --- | --- |
| 2.0.22, the same 2.8K-token prompt sent four times (`/generate`), on two days | 0 of 3 repeats each time |
| 2.0.22, one ordinary session with 8 growing turns (gpt-6-luna, gpt-5.6-luna, gpt-6.1-sol) | 1, 0 and 1 of 7 follow-up requests read the previous prompt |
| 2.0.22, review-only `/pr-review` of the 1-file PR, two runs | 4.4% and 4.6% of input |
| 2.0.22 with a test build of AZPR that set `session_id` and `session-id` to each private session's ID | 51.9% and 61.4%; 17 of 20 follow-ups read 75–99% of the previous prompt |
| 2.0.31, the same prompt four times | 2 of 3 repeats |
| 2.0.31, one ordinary session with 8 turns | 7 of 7 follow-ups, 92–98% each |
| 2.0.31, the same 1-file PR review with AZPR unchanged | 47.6% of input; 7 of 10 follow-ups |
| 2.0.32, the same prompt four times | 2 of 3 repeats |
| 2.0.32, one ordinary session with 8 turns | 7 of 7 follow-ups, 92–99% each |
| 2.0.32, the same 1-file PR review (this revision, from the debug token records) | 54.4% of input; 7 of 10 follow-ups |

AZPR's requests keep a stable prefix: with a loopback fake Responses provider,
every follow-up's input extended the previous one, and instructions and tools
did not change between requests. The low share came from the host: on 2.0.22
the token-sharing route sent no session headers
([anomalyco/opencode#53765](https://github.com/anomalyco/opencode/issues/53765)),
which [anomalyco/opencode#53767](https://github.com/anomalyco/opencode/pull/53767)
fixed with `session-id`, `thread-id` and `x-client-request-id` before 2.0.31.
The Codex sign-in route (device code, in an isolated environment) already cached
on 2.0.22: 3 of 3 repeats and 50% over 8 turns. Before 2026-10-10 the reviewers
used MCP tools whose definitions formed a long prefix shared by all sessions,
which most likely explains why the earliest live runs read 31–45% from the
cache (their sessions no longer exist, so this was not checked per request).

## Proxy and TLS behaviour of OpenCode's runtime

Measured on 2026-10-13 with the Bun runtime embedded in OpenCode 2.0.22 (Bun
1.4.2, run as `BUN_BE_BUN=1 opencode`), a local CONNECT proxy and a fixture CA;
`azure.proxy`, `azure.caFile` and `azure.verifyTls` are built on these results:

| Behaviour | Observed |
| --- | --- |
| `fetch(url, { proxy })` | HTTPS through a `CONNECT` tunnel and HTTP in absolute form, for loopback targets too; an `https://` proxy works as well. Credentials in the proxy URL are percent-decoded into `Proxy-Authorization: Basic`. |
| `tls: { ca }` | Replaces the built-in roots: with only the fixture CA, dev.azure.com failed with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. AZPR therefore appends to `tls.rootCertificates` (121 roots); a two-certificate bundle works. Host names are still verified (`ERR_TLS_CERT_ALTNAME_INVALID`). |
| `tls: { rejectUnauthorized: false }` | Skips verification, also through a proxy. |
| Proxy refusals | A 407 or a refused `CONNECT` (403) comes back as a `Response` with that status, not as an exception; it carries the proxy's headers only. |
| Errors | Thrown with `error.code`: `ConnectionRefused` (also for an unreachable proxy), `ENOTFOUND`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and other certificate codes. |
| `NO_PROXY` with `proxy` (2026-10-31, Bun 1.4.4) | A host listed in `NO_PROXY` is fetched directly even when the `proxy` option is set. |
| Environment | `HTTPS_PROXY` and `NO_PROXY` are honoured without the `proxy` option; `NODE_EXTRA_CA_CERTS` and `NODE_TLS_REJECT_UNAUTHORIZED=0` work process-wide. |
| Azure DevOps answers | A 302 sign-in redirect and a 404 for an unknown organization both carried `X-TFS-ProcessId` (and `ActivityId`, `X-VSS-E2EID`); the fixture proxy's answers did not. |

The first symptom that led to this work came from a corporate network: `/pr-check`
reported `Azure DevOps PR failed: network error (ConnectionRefused) after 3
attempts.` because dev.azure.com is reachable there only through a proxy.
On 2026-10-14 `/pr-check` passed on that network with `azure.proxy` set to the
company's HTTP proxy and `azure.verifyTls` false (shown as a WARNING row); no
`azure.caFile` was set.

## Live run (Azure DevOps Services, real model)

Test PR 2 of the maintainer's Azure DevOps test project (one changed file),
`openai/gpt-5.6-luna` for all three roles, `zh-TW`, through the user's OpenCode
service with the installed package, `azure.organization` and an existing PAT
in AZPR's settings. The AZPR comments of earlier runs were deleted first.

| Step | Result |
| --- | --- |
| `/pr-check` | READY, 5 s; 6 REST calls; head, merge base, 1 changed file, HEAD and BASE reads, 156 threads. |
| `/pr-review` | COMPLETE, 75 s; three medium findings confirmed; reviewers made 20 tool calls (file reads and root listings at exact commits) served by 9 REST requests thanks to the run cache; no correction turn, retry or tool error. |
| `/pr-comment --publish` | POSTED 4 items (summary and three inline), 25 s; planning took 1 model request and no tools. |
| Second publish | POSTED, all 4 ALREADY_PRESENT, no write. |

Independent REST read-back found the inline threads on `/fulfillment.py` at
right-side lines 19–24, 29 and 37, each with its marker; Azure DevOps attached
`pullRequestThreadContext` (iteration 1/1, change tracking ID 1) itself. The
four private sessions used about 54,500 input tokens (the two MCP-based runs used
about 241,000 and 80,000). All 34 REST calls of the four commands succeeded on
the first attempt. The test comments were deleted after the read-back.

`/pr-check` of PR #3 (316 changed files) returned READY with all 316 files as a
complete list and the merge base; through MCP 2.9.0 the runtime saw 100.

## Live run: large PR (Azure DevOps Services, real model)

Test PR 3 of the same project (316 changed files), the same models, language
and service; `/pr-review` only, nothing was posted.

The first attempt stalled 45 seconds in: in four reviewer sessions the model ran
native `grep` on the repository path `/scale_lab`, OpenCode asked for
`external_directory` approval, and the unattended private sessions waited for
30 minutes until the run was stopped (about 950,000 input tokens were spent).
Private sessions now refuse at once any request that would wait for an approval
(shell excepted when the `shell` setting allows it) and point the model to the
azpr tools; the exact-host smoke test reproduces the `grep` and passes.

The second attempt was COMPLETE:

| Property | Observed |
| --- | --- |
| Duration | 626 s: initial review 541 s, verification 80 s |
| Initial review | 26 sessions (2 roles × 13 shards of up to 25 files), all COMPLETE; no correction turn, stage retry, overflow, tool failure or blocked tool; about 1,550 tool calls |
| Verification | 4 sessions, all COMPLETE without a correction turn; 48 candidates → 25 confirmed (7 high, 17 medium, 1 low), 23 merged duplicates, none rejected |
| Azure DevOps | 593 REST calls: 587 file versions each fetched once (the run cache served every other read), one 404 for a path the model guessed, no retry needed; median 259 ms, p95 1.0 s |
| Approval prompts | None |
| Tokens | About 7.44 million input tokens (about 280,000 per initial session, 32,000 per verification session) and 79,000 output tokens |

One duplicate remained in the report (`F-2001` and `R-2001`, the same cause in
`worker_capacity.py`): count-based verification shards had put that file's two
findings into different verifiers. Verification shards now end only between
files; a unit test reproduces the 48-finding distribution.

## Live run: large PR with publication (commit 68c1f7e)

Test PR 3 again, at the same head, with the same models, language and
service, running the installed package of commit `68c1f7e` (the revision
before the verifier and planner corrections below). The 24 AZPR comments of an
earlier run were deleted first; the comments of this run were kept on the PR.

| Step | Result |
| --- | --- |
| `/pr-check` | READY, 9 s |
| `/pr-review` | COMPLETE, 719 s: initial review 589 s (26 sessions), verification 129 s (5 sessions); 66 candidates → 26 confirmed (6 high, 19 medium, 1 low), 40 merged duplicates, none rejected; one correction turn |
| `/pr-comment --publish` | POSTED, 157 s: 7 planning pages of one model request each and no tools (147 s), then 25 items (summary and 24 inline) created in about 5 s and all read back as VERIFIED |
| Second publish | POSTED, all 25 ALREADY_PRESENT, no write |

- 681 REST calls over the four commands, none retried; four 404s for paths that
  models guessed.
- About 7.60 million input and 88,000 output tokens; initial review sessions
  used 95 % of the input.
- Independent read-back: 23 of the 24 inline threads sit on changed right-side
  lines; the 24th reports a removed check and sits on the line after the
  removal, where HEAD has no line for it.
- The two `worker_capacity.py` findings that stayed separate in the previous run
  were merged, as file-grouped verification shards intend.
- Initial sessions used on average 3.71 of the 4 `workflow.parallelSessions`
  slots; the 26 sessions ran in about seven waves.

Two observations led to corrections in the current revision:

1. One verifier wrote four merges into `confirmed` (`{"id", "mergedInto",
   "reason"}`). They were treated as incomplete confirmations and cost one
   correction turn. A decision row is now judged by its own fields: an explicit
   status, or a merge target on a row without a finding.
2. A verifier moved R-12001, a test that asserts the wrong result, from the test
   file onto the implementation lines of F-1009 without saying so. The planner
   then skipped R-12001 as covered by F-1009's comment, so the test got no
   comment and the summary index showed the implementation file. A move to
   another file must now be declared with `movedFrom` (otherwise the verifier is
   asked to confirm or undo it, and an unconfirmed move is kept with a warning),
   the report shows the initial location, and the planner may not skip a
   finding because another finding of the review is commented (a prompt rule,
   plus a correction turn when a skip names another finding). Moves stay
   allowed: of the 60 confirmations in the live runs so far, 2 moved to another
   file, and the other one (R-4001, from a region JSON file to the code that
   drops its fields) was correct.

## Live runs: parallelism and the corrections (review only)

Two more `/pr-review` runs of PR #3 at the same head, same models, language and
service, nothing posted (the 25 comments above were unchanged afterwards). The
first used commit `628a78d` with `workflow.parallelSessions` 8 and
`azure.concurrency` 3; the second used this revision with 8 and 6.

| Property | 68c1f7e, 4 / 3 (above) | 628a78d, 8 / 3 | This revision, 8 / 6 |
| --- | --- | --- | --- |
| Review duration | 719 s | 460 s | 393 s |
| Initial review | 589 s; 3.71 sessions on average, peak 4 | 380 s; 6.07, peak 8 | 319 s; 6.71, peak 8 |
| Sum of initial session time | 2,187 s | 2,308 s | 2,143 s |
| Verification | 129 s, 5 sessions in two waves | 79 s, 4 sessions | 72 s, 5 sessions in one wave |
| Candidates → confirmed | 66 → 26 | 53 → 26 | 60 → 26 |
| Correction turns | 1 | 0 | 0 |
| Provider retries, stage retries | 0, 0 | 0, 0 | 0, 0 |
| REST calls (median, p95) | 616 (168 ms, 433 ms) | 646 (432 ms, 2.7 s) | 587 (90 ms, 244 ms) |
| Most REST calls issued in one second | 36 | 86 | 38 |
| Input tokens | 7.60 M | 9.17 M | 7.87 M |

- A call's duration includes waiting for a queue slot. Calls that started with
  fewer than three other calls in flight, so without waiting, took a median of
  73–75 ms in every run, so Azure DevOps did not slow down: with 8 sessions and
  a queue of 3, the queue was the bottleneck, and a queue of 6 removed it. No
  request was throttled.
- Token use varies between runs of the same commit (7.4 M to 9.2 M input so
  far) with the number of model requests and tool calls; it did not follow the
  parallelism.
- In the 628a78d run, a verifier declared two moves to another file with
  `movedFrom` in its first answer (from region JSON files to the normalization
  code that drops their fields); the report showed both initial locations.
- In the second run, a verifier again wrote merges into `confirmed` (nine
  `{"id", "mergedInto", "reason"}` rows and no `merged` list). They were
  classified as merges without a correction turn.
- No file held findings that different verifiers confirmed, so the duplicate
  check did not run; it is validated offline and with the exact-host scale
  fixture.

## Live A/B: reading diffs instead of whole files (review only)

Seven `/pr-review` runs of PR #3 at the same head, with the same models,
language and service; nothing was posted. Baselines A–C read whole files
(commits `68c1f7e`, `628a78d`, `fe0ee7b`; `parallelSessions`/`azure.concurrency`
4/3, 8/3 and 8/6). The variants used `azpr_read_diff`, `azpr_find_files` and the
reading rules, all with 8/6:

- V2 sent the diffs of all assigned files with the assignment;
- V1 let reviewers read diffs themselves, without folding;
- V3 (this revision) folds repeated changes and asks for few reading rounds.

| Run | Review | Input tokens | Requests per initial session | Candidates → confirmed | Policy defects found | Configuration defect |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline A | 719 s | 7.52 M | 5.08 | 66 → 26 | 24/24 | found |
| Baseline B | 460 s | 9.17 M | 5.42 | 53 → 26 | 24/24 | found |
| Baseline C | 393 s | 7.87 M | 5.35 | 60 → 26 | 24/24 | found |
| V2 | 419 s | 15.13 M | 5.31 | 107 → 25 | 24/24 | found |
| V1 | 451 s | 11.73 M | 5.58 | 74 → 27 | 24/24 | found |
| V3 | 381 s | 5.53 M | 5.54 | 84 → 25 | 24/24 | found |
| V3 | 429 s | 5.46 M | 5.54 | 69 → 25 | 24/24 | found |

- Reviewers made about 5.5 model requests per session in every variant; cost
  follows how much each request carries.
- 240 of the 316 files are 300-line JSON region profiles with the same
  migration on every route, so their plain diffs are 80 % of HEAD plus BASE.
  V2 put 25 such diffs into every request of a shard, and reviewers still read
  whole files: tokens roughly doubled, so sending diffs upfront was removed.
  V1's plain diffs and the new reading rules cost 49 % more than baseline C.
- Folding repeated changes brings PR #3's diff volume to 29 % of whole-file
  reads (measured offline over all 316 files). V3 used 27–41 % fewer input
  tokens than the baselines in two runs, with all 24 policy defects and the
  configuration defect found each time. These runs used a diff renderer that
  dropped the middle of long change blocks (see "Diff defect" below); the
  offline ratios here are measured with the corrected renderer.
- Offline over the latest 182 pydantic commits that modified source files (618
  files), diffs are 5.3 % of whole-file HEAD and BASE reads (median per commit 4
  %, 90th percentile 11 %), so code-centric PRs should save more.
- The duplicate check ran on a real model: in V1 it merged five duplicates that
  different verifiers had confirmed in one file and kept two different
  configuration findings apart.
- Severity varies between runs of every variant (high findings: 4 to 12).
  `azpr_find_files` was used 19–28 times per run, but guessed-path 404s did not
  drop (1–5 per run).

## Live run: real code (review only)

Test PR 4 of the same project was created for this test from pydantic (MIT):
a snapshot at `125921fdc9` as the base and the changes of the next 20 upstream
commits as the source (35 files, +1,074/−293 lines, Python and Rust; 13 changed
source files have more than 1,000 lines). Two regressions were seeded: one in a
changed hunk (`json_schema.py` declares millisecond temporal values as strings
although they serialize as numbers) and one outside the diff (a bare
`MutableSequence` still uses the sequence schema while the PR's new test expects
a list; the test and the implementation fell into different shards). Offline,
its diffs are 7.4 % of whole-file HEAD and BASE reads. Both revisions ran with
`parallelSessions` 8 and `azure.concurrency` 6; nothing was posted.

| Property | Whole-file reading (`fe0ee7b`) | This revision (`c1de65c`) |
| --- | --- | --- |
| Review | 331 s | 115 s |
| Initial sessions | 10: three sessions filled their model context and their shards were split | 4 |
| Input tokens | 6.15 M | 0.79 M (−87 %) |
| Seeded regression in a changed hunk | found and confirmed | found and confirmed |
| Seeded regression outside the diff, test and code in different shards | missed | missed |
| Other confirmed findings | none | none |

Diff-based reading kept the result of whole-file reading on real code at an
eighth of the input tokens and without context overflow. Neither revision
connects a new test with unchanged code in another shard.

## Live run: content search and commit messages (PR #4, review only)

`azpr_search_code` (literal search over the repository zip of HEAD or BASE) and
the PR's commit messages were added for the seeded regression outside the diff.
PR #4 has one commit with a generic message, so the messages carried no
evidence here. Two runs, same models and settings, nothing posted:

| Property | Run 1 | Run 2 (diff and argument fixes below) |
| --- | --- | --- |
| Review | 135 s | 135 s |
| Input tokens | 0.64 M | 0.55 M |
| Requests per initial session | 5.25 | 4.25 |
| Tool calls (diff / file / search) | 70 / 52 / 31 | 70 / 29 / 28 |
| Failed tool calls | 5 (4 searches with `path: ""`, one 404) | 0 |
| Repository zips (HEAD, BASE) | 4.10 MB in 1.5 s, 4.09 MB in 1.7 s | same |
| Seeded regression in a changed hunk | found and confirmed | found and confirmed |
| Seeded regression outside the diff | missed | missed |

Reviewers used content search for callers, definitions and the code behind
changed tests (for example `ser_json_temporal`, `as_ser_schema`, `SecretStr`),
but in both runs the reviewers of the test shard read the new
`test_bare_mutable_sequence` and never searched for `MutableSequence`; in run 1
a search for the test's name failed on the blank path. Searching is available
but not applied to every new test. Offline, a lexical cross-reference from the
identifiers on added test lines to the non-test files that use them (identifiers
found in at most three files) points at the seeded line
(`_generate_schema.py:375`, `MutableSequence` mapped to the sequence schema) and
adds about 15,600 characters for the whole PR, along with noise from comments.

## Live run: models and reasoning effort (PR #4, review only)

All three review roles on one model, same revision and settings, nothing
posted. "default" is the model's default variant, which AZPR always used before
`provider/model#variant` was supported; `#high` asks for high reasoning effort.

| Model | Seeded regression outside the diff | In the diff | Other confirmed | Review | Input tokens | Reasoning tokens | Searches |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-luna (default) | 0 of 2 | 2 of 2 | 0 | 130 s | 0.55–0.64 M | 3.9–5.4 K | 28–31 |
| gpt-6-luna (default) | 0 of 2 | 2 of 2 | 0 | 65–75 s | 0.24–0.27 M | 0.2–0.4 K | 5 |
| gpt-6-luna#high | 0 of 2 | 2 of 2 | 0 | 125–150 s | 0.58–0.79 M | 4.7–4.9 K | 25–27 |
| gpt-6.1-sol (default) | 2 of 2 | 2 of 2 | 3, the same in both runs | 261–306 s | 1.47–1.53 M | 2.1–2.3 K | 49–60 |

- gpt-6.1-sol searched for `MutableSequence` in both runs and explained the
  defect: the bare type is mapped to the sequence schema while the
  parameterized one uses the list schema the new test expects. Its suggested
  fix is the upstream fix.
- Its three other confirmed findings: validation JSON Schemas take the
  serialization temporal format (fixed upstream later in pydantic #13711);
  chained length constraints in the experimental pipeline now overwrite each
  other (the PR dropped the extra length check); and JSON Schema generation
  ignores the core schemas that the PR allows as serialization schemas (still
  so upstream). None is a false positive; the last two are debatable in
  severity.
- gpt-6-luna#high also searched for `MutableSequence` in one run and received
  the defective line next to the parameterized one, then reported no defect.
  A runtime hint would have added exactly that evidence, so the hint was not
  built: the miss is a limit of the model, and a stronger model finds the
  defect with the general tools.
- The default variant reasons little for some models (gpt-6-luna: 193 and 445
  reasoning tokens per review); `#high` raised that tenfold without finding
  the defect.
- Verification does not find what the initial reviews miss: over 21 live runs,
  59 verifier sessions decided 616 candidates and added 1 new finding.

### Diff defect

Run 1 showed `test_list.py` with HEAD lines 297–298 missing. Hunks were built
from the first and the last line of each change block, so a block longer than
the context before and after it (9 lines by default) lost its middle, and a
repeated block that reached into a hunk was cut instead of folded. In PR #4's 32
edited files, 451 of 1,111 changed lines (41 %) were not shown; reviewers
partly compensated with whole-file reads. Every changed block is now shown
whole (long hunks are still cut at 60,000 characters with a pointer to
`azpr_read_file`), a repeat that reaches into a hunk is shown in it, and a test
checks on random inputs that every changed line appears in a hunk or a folded
repeat. The corrected diffs of PR #4 are 23 % larger; run 2 still used fewer
tokens because reviewers made fewer whole-file reads. Tool arguments sent as
`null` or blank text now count as not given.

## Live A/B: filing rules in the reviewer prompts (PR #3 and PR #4, review only)

2026-10-11, OpenCode 2.0.22, api-version 7.1, `parallelSessions` 8,
`azure.concurrency` 6, `outputLanguage` zh-TW, all three review roles on one
model, nothing posted. Baselines are the runs of the sections above (prompts
of commit 56bc5d7).

Cause found before the change: with gpt-6-luna, both roles read all 25 diffs of
PR #3's shard 2 (22 policy modules), but the risk reviewer filed 4 findings and
described five more defects in `report` "because they are outside this
review's focus", and the functional reviewer filed 6 and listed 16 in `report`.
Only `findings` reach verification, so 9 of 24 defects survived; the 15 → 9
step in verification was six functional/risk duplicates merged correctly.

Prompt variants:

- v1: every concrete defect is its own finding (no maximum, one per defect and
  location); a role's focus orders attention and is not a filter; `report`
  never describes a defect; COMPLETE requires following the reading leads;
  "plan reads in few rounds" replaced by "never skip a read to save a round";
  the first verification shard checks defects described only in prose.
- v2: v1 plus "one entry per root cause" (code that is wrong once and affects
  many files or records is one finding at that code; separately wrong modules
  are separate findings).
- v3: v2 with "plan reads in few rounds" restored and the tool prohibition
  that the runtime enforces anyway removed from the prompt.
- v4: v3 without "followed the leads it raised" in the COMPLETE definition of
  the initial roles.
- v5: v4 with the scope rule "every changed file has its own reviewer: follow
  your assigned files' leads wherever they go; a defect you reach in unchanged
  code is yours to file; other changed files are context only", and "in any
  area" replaced by "of any kind".
- final (this revision): v5 without the verifier's prose check (removed after
  review, see below). gpt-6-luna and gpt-5.6-terra ran v5, gpt-5.6-luna ran
  the final revision four times (the last three with the merge-target
  checks), gpt-6.1-sol last ran v3.

PR #3 (316 files, 24 policy defects and one configuration defect):

| Model | Prompts | Policy defects | Config defect | Candidates → confirmed | Duplicate confirmations | Review | Input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | old | 9 of 24 | no | 15 → 9 | 0 | 250 s | 2.85 M |
| gpt-6-luna | v1 | 24 of 24 | no | 76 → 24 | 0 | 316 s | 3.90 M |
| gpt-6-luna | v2 | 24 of 24 | no | 60 → 25 | 0 | 286 s | 3.85 M |
| gpt-6-luna | v3 (2 runs) | 24 of 24 both | 1 of 2 | 65 → 25; 64 → 42 | 0; 17 | 271–296 s | 3.49–3.68 M |
| gpt-6-luna | v4 | 24 of 24 | no | 54 → 24 | 0 | 366 s | 3.94 M |
| gpt-6-luna | v5 | 24 of 24 | no | 56 → 24 | 0 | 321 s | 3.87 M |
| gpt-5.6-luna | old (2 runs) | 24 of 24 both | yes | 69–84 → 25 | 0 | 386–431 s | 5.46–5.53 M |
| gpt-5.6-luna | v1 | 24 of 24 | yes | 200 → 48 | 23 (the config defect once per region file) | 606 s | 7.73 M |
| gpt-5.6-luna | v2 | 24 of 24 | yes | 62 → 26 | 0 | 366 s | 6.30 M |
| gpt-5.6-luna | v3 | 24 of 24 | yes | 104 → 25 | 0 | 446 s | 7.43 M |
| gpt-5.6-luna | final (4 runs) | 22 of 24 (see below); then 24 of 24 three times | yes | 53 → 23; 58 → 26; 65 → 26; 59 → 25 | 0 | 351–406 s | 5.35–6.35 M |
| gpt-5.6-terra | old | 24 of 24 | no | 101 → 24 | 0 | 566 s | 4.59 M |
| gpt-5.6-terra | v2 | 24 of 24 | no | 126 → 24 | 0 | 581 s | 6.18 M |
| gpt-5.6-terra | v3 | 24 of 24 | no | 117 → 24 | 0 | 621 s | 4.92 M |
| gpt-5.6-terra | v5 | 24 of 24 | no | 76 → 24 | 0 | 496 s | 5.33 M |

PR #4 (35 files, two seeded regressions):

| Model | Prompts | In the diff | Outside the diff | Other confirmed | Review | Input tokens |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | old (4 runs) | 3 of 4 | 0 | 0 | 65–75 s | 0.22–0.29 M |
| gpt-6-luna | v1, v2 | 0 of 2 | 0 | 0 | 65–70 s | 0.42–0.57 M |
| gpt-6-luna | v3 (2 runs) | 2 of 2 | 0 | 0 | 80 s | 0.39–0.62 M |
| gpt-6-luna | v4 | 1 of 1 | 0 | 0 | 80 s | 0.33 M |
| gpt-5.6-luna | old (2 runs) | 2 of 2 | 0 | 0 | 130 s | 0.55–0.64 M |
| gpt-5.6-luna | v1 / v2 / v3 | 1 / 0 / 1 of 1 | 0 | 0 / 1 / 0 | 120–145 s | 0.76 / 0.92 / 0.86 M |
| gpt-5.6-terra | old (2 runs) | 2 of 2 | 0 | 0 | 180–196 s | 0.69–0.82 M |
| gpt-5.6-terra | v2, v3 (3 runs) | 3 of 3 | 0 | 0 | 170–185 s | 1.01–1.05 M |
| gpt-5.6-terra | v4 (2 runs) | 2 of 2 | 0 | 0 | 186–211 s | 0.96–1.04 M |
| gpt-5.6-terra | v5 (2 runs) | 2 of 2 | 0 | 0 | 180–181 s | 0.69–0.85 M |
| gpt-6.1-sol | old (2 runs) | 2 of 2 | 2 of 2 | 2 | 261–306 s | 1.47–1.53 M |
| gpt-6.1-sol | v2 / v3 | 1 / 1 of 1 | 1 / 1 of 1 | 3 / 5 | 406 / 351 s | 3.50 / 2.14 M |

- The filing rules are what helped. gpt-6-luna's functional reviewer on PR #3's
  shard 2 filed 22 findings in two model requests after the same 25 diff reads
  that had produced 6 findings and 16 sentences of prose; all five new-prompt
  runs of gpt-6-luna on PR #3 found 24 of 24.
- "One per defect and location" made gpt-5.6-luna file the configuration
  defect once per affected region file; "one per root cause" removed those 23
  duplicates and kept the defect at `configuration.py`.
- "Never skip a read to save a round" cost tokens without a measurable gain:
  gpt-6.1-sol 1.5 → 3.5 M on PR #4 (2.1 M after the revert), gpt-5.6-terra
  6.2 → 4.9 M on PR #3 after the revert. No variant made gpt-5.6-luna or
  gpt-6-luna find the regression outside the diff.
- The prose check by the first verification shard added one finding in
  fourteen runs (v5, gpt-6-luna: a pagination defect another candidate
  already covered; the same-file duplicate check merged it). Once reviewers
  file their defects, nothing is left in prose. It was removed after review:
  its work grows with the number of initial reports, not with the shard's
  candidates, and every overflow split of the first shard (labels `1/N`,
  `1/Na`, ...) repeats the same sweep, so an overflow during it would leave
  that shard's candidates UNREVIEWED, and a shard without candidates cannot
  split at all.
- gpt-5.6-terra had no filing problem with the old prompts (both roles filed
  all 22 defects of shard 2) and gains nothing measurable: 24 of 24 and the
  regression inside the diff with every prompt set, the configuration defect
  and the regression outside the diff with none. v3 cost it 7 % more input on
  PR #3 and about 35 % more on PR #4: the sessions assigned the test files
  read and reviewed the implementation of other shards ("in any area"). v4
  changed nothing for it; the scope rule of v5 brought PR #4 back to the old
  0.69–0.85 M and PR #3 candidates from 117 to 76 (verification shards 9 → 6,
  496 s), with input inside the run-to-run spread of the old prompts
  (4.6–5.3 M).
- For gpt-6-luna, "followed the leads it raised" was what made its PR #4
  sessions read more (0.39–0.62 M → 0.33 M without it); PR #3 stayed at
  24 of 24 in v4 and v5. Its PR #3 reviews cost about 35 % more than with the
  old prompts (3.9 M) because they now file 24 defects instead of 9 and
  verification runs in 4–5 shards instead of 1.
- Under the scope rule a defect reaches verification two or three times
  (gpt-6-luna v5: 16 policy files with 2 candidates, 8 with 3; gpt-5.6-luna
  final: exactly 2 for all 24) instead of four, so the verifier has fewer
  same-line duplicates to merge.
- gpt-5.6-luna's final-revision run lost two defects in verification, not in
  review: both roles filed `worker_capacity` and `write_permissions`, and the
  verifier of that shard answered in 2,132 characters, merging R-2001 and
  R-2002 into F-2001 and F-2002 while listing those two under `rejected` with
  the reason "the candidate itself is a valid issue; see the F-2001
  confirmation", which it never wrote. Every assigned ID had one decision
  with a valid status and a reason, so no correction turn ran. It occurred in
  1 of 181 verification shards across all live runs; the runtime now treats a
  merge into a finding the same answer rejected as a contract problem (repair
  turn for the pair, UNREVIEWED if unresolved); a follow-up review showed the
  same gap across shards (a crowded or overflow-split file can put the pair
  in two verifiers), so the combined decisions are settled the same way with
  a warning; a verifier-added finding that survives counts as a confirmed
  target there, since the duplicate check may merge into it. Three repeat
  runs with the checks in place confirmed 24 of 24 and the configuration
  defect with no merge correction needed (58 → 26, 65 → 26 and 59 → 25;
  351–406 s; 5.4–6.1 M; the last one with a duplicate check and no false
  warning). The third run also saw the first provider
  stream interruption in these runs: the host's continuation message after a
  turn that had made tool calls is not accepted as the authorized answer, the
  shard was retried in a new session (`workflow.stageRetries`) and completed.
- Cross-shard discovery did not move with any variant: the regression outside
  PR #4's diff was found by gpt-6.1-sol with the old prompts and with v2/v3
  (4 of 4, filed from the test shard) and by no other model in any run.

### Live publication with this revision (gpt-5.6-terra)

After the earlier 25 comments on PR #3 were deleted, `/pr-review` and
`/pr-comment --publish` ran once per PR with gpt-5.6-terra on all three roles.
PR #3: 24 of 24 policy defects confirmed (57 candidates, 461 s, 4.3 M input);
24 items published, all VERIFIED on read-back (one summary, 23 inline; the
low-severity finding appears in the summary index only); a second
`--publish` reported ALREADY_PRESENT for all 24. PR #4: the regression inside
the diff confirmed (195 s, 0.6 M); 2 items VERIFIED (summary and
`json_schema.py:874`), the second `--publish` ALREADY_PRESENT for both. No
skip relied on another finding. On 2026-10-17 the maintainer inspected these
comments in the Azure DevOps web UI (the summary and 23 inline comments on
PR #3, the summary and the inline comment on PR #4) and found no problems with
their rendering or anchors.
- Risk: those same-line duplicates must be merged by the verifier.
  gpt-5.6-luna and gpt-5.6-terra merged them in every run; gpt-6-luna did in
  three of four runs and in the fourth confirmed 17 duplicates on the same
  lines (two of five verification shards merged nothing). Publishing that
  review would post two to four identical comments per line. A deterministic
  runtime merge of candidates with the same path and lines is the proposed
  fix; it is not part of this revision.
- The regression inside PR #4's diff was missed by gpt-6-luna in three
  consecutive runs around the prompt change (one of them with the old
  prompts) and found in both v3 runs, although every session had read the
  defective lines and the test asserting the opposite: model variance, not a
  prompt effect.
- The configuration defect of PR #3: gpt-5.6-luna 4 of 4 new-prompt runs,
  gpt-6-luna 1 of 4, gpt-5.6-terra 0 of 2.

## Live runs: `/pr-quick` versus `/pr-review` (2026-10-18, review only)

OpenCode 2.0.32, every review role and `models.quick.reviewer` on
`openai/gpt-6-luna` (default variant), `parallelSessions` 8,
`azure.concurrency` 6, debug on. Both modes ran twice on each PR at the same
heads, alternating quick and review, review only; nothing was posted. Time is
from the command to its receipt; requests count model requests of the review
stages; input is uncached plus cached prompt tokens from the debug stage
records.

| PR | Mode | Time | Sessions | Requests | Input (uncached + cached) | Output | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | quick | 45 s / 30 s | 1 / 1 | 5 / 4 | 32 K / 25 K (8 K uncached each) | 1.5 K / 1.0 K | 3 / 2 of the 3 known defects |
| PR #2 | review | 60 s / 60 s | 3 / 3 | 13 / 12 | 87 K / 82 K (41 K / 30 K) | 2.7 K / 3.0 K | 2 / 2 of the 3 |
| PR #4, 35 files | quick | 45 s / 40 s | 2 / 2 | 8 / 5 | 206 K / 114 K (70 K / 66 K) | 2.4 K / 1.8 K | seeded regression in the diff 1 of 2; outside the diff 0 of 2 |
| PR #4 | review | 70 s / 40 s | 5 / 5 | 15 / 11 | 268 K / 203 K (133 K / 125 K) | 4.4 K / 3.1 K | in the diff 1 of 2; outside 0 of 2 |
| PR #3, 316 files | quick | 115 s / 110 s | 13 / 13 | 60 / 42 | 1.79 M / 1.38 M (0.54 M / 0.56 M) | 23 K / 22 K | 24 of 24 policy defects both times; configuration defect 0 of 2 |
| PR #3 | review | 266 s / 230 s | 31 / 30 | 135 / 106 | 4.25 M / 3.38 M (1.25 M / 1.21 M) | 60 K / 50 K | 24 of 24 both times; configuration defect 1 of 2 |

- Cost: a quick review needed 36–50 % of the review's model requests and
  34–68 % of its input (42 % on the 316-file PR, 24–53 % of the uncached
  input). Time fell to 45–63 % on the 1-file and 316-file PRs; on PR #4 one
  review without candidates verified nothing and took 40 s, like the quick runs.
- Findings: no quick or review run reported a defect outside the known ones.
  Every quick finding passed the runtime's checks (no NEEDS_INFO, no correction
  turn); the location and read checks refused nothing in these runs. Severity
  agreed across all four PR #3 runs for 23 of the 24 policy files (one review
  rated `reservation_atomicity` high, the other runs medium).
- Duplicates across shards: on PR #3 the reviewer of the shard with eight
  policy tests followed them into the policy implementations (changed files of
  another shard) and filed the same defects there, so 7 and 8 of the 32 quick
  findings repeat another finding on the same lines. Restricting where a quick
  reviewer may file is not an option: the same path finds a defect whose test
  and code are in different shards (PR #4's seeded regression outside the
  diff). One review run also kept 13 same-line duplicates that its verifiers
  did not merge (38 confirmed findings for 25 defects); the other merged all
  of them. Single-shard PRs cannot produce cross-shard duplicates.
- Comment preview of a quick PR #4 review: the summary's disclosure line read
  "AI 審查，非人工審查或核准。審查方式：快速審查，未經獨立驗證。模型：" followed by
  the model ID, with the usual index and marker; the planner skipped the inline
  comment because thread 235 (the earlier publication) already covers the
  issue. Nothing was posted.
- Two runs per mode show how much both vary (the 1-file PR: 2 or 3 of 3; PR
  #4's seeded regression in the diff: 1 of 2 in each mode); they do not
  establish a quality difference.

After combining cross-shard duplicates in comment planning was added, two
more quick runs of PR #3 with a comment preview (nothing posted):

| Run | Review | Candidate pairs | Planning | Inline comments | Skipped |
| --- | --- | --- | --- | --- | --- |
| 1 | 160 s, 73 requests | 7 | 9 sessions, 12 requests (two correction turns on one page) | 1 | 31 |
| 2 | 120 s, 51 requests | 0 | 8 sessions, 9 requests | 2 | 30 |

- No combination was made, for two reasons outside the combination rules.
  PR #3 still carries the 24 comments published on 2026-10-11 (threads
  211–233, kept on purpose), and the planner skipped both members of every
  candidate pair because one of those threads already discusses the defect.
  In run 2 the reviewer of the shard with the policy tests located its eight
  findings on the line of a region file that enables each policy instead of
  the policy implementation, so they were in another file than their
  repeats and no candidate. The combination path is therefore covered by
  the offline and host fixtures only; a live check needs a multi-shard PR
  without earlier comments.
- Run 2's eight misplaced findings passed the runtime's checks (the file
  exists, the lines are in range, the session read it): the checks cannot
  tell that a location is the wrong place for a defect. The planner refused
  to anchor four of them on a region file, and the other four duplicate
  existing threads; in a summary index they would show the region file as
  their location. A verifier corrects such locations; a quick review does not.
- Run 1 reported one finding outside the known defects (a region route's
  fallback that differs from its destination), which is unverified. Its
  inline comment was refused after two correction turns because the planner
  quoted lines that are not in the file, so it would appear only in the
  summary index.

Two changes followed: the quick prompts now say to file a defect the
reviewer's files lead it to at that other changed file's defective lines (a
configuration entry, test or caller that only uses the code is evidence, not
the location), and the 24 earlier comments on PR #3 were deleted so that
existing threads no longer cover its defects. Three more quick runs with a
comment preview, nothing posted:

| Run | Review | Findings | Candidate pairs | Combined | Inline comments | Planning |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 130 s, 53 requests | 33: 24 of 24 policy defects and one unconfirmed region-fallback claim | 8 | 6 | 27 | 9 sessions, 10 requests, one correction turn |
| 2 | 120 s, 50 requests | 35: 24 of 24 | 9 | 9 | 25 | 9 sessions, 9 requests |
| 3 | 110 s, 63 requests | 32: 24 of 24 | 8 | 8 | 23 | 8 sessions, 9 requests, one correction turn |

- No finding sat on a line that only uses the defective code.
- 23 of 25 candidate pairs became one comment. In run 1 the planner kept two
  pairs apart, which the prompt allows when it is unsure, so those defects
  would each get two comments. The correction turns added a missing
  `mergeReason`. A combined comment keeps the usual layout and disclosure;
  the summary index lists its IDs in one row, and the counts follow the rows
  (run 3: 32 findings, 24 rows).
- Planning used one request per page of four findings, as without
  candidates: 8–9 sessions and 9–10 requests for 32–35 findings.
- The region-fallback claim (one of these three runs, and one run before) is
  not a planted defect, and neither review run reported it; it is
  unconfirmed.

## Live runs: three modes on main and the quick follow-up (2026-10-18, review only)

OpenCode 2.0.32, every role on `openai/gpt-6-luna`, `parallelSessions` 8,
debug on, nothing posted. Time is from the run's start to its end in the debug
records (without `/pr-check`); input is uncached plus cached prompt tokens.

Main at `33fb851` (the merged `/pr-quick`): quick and review twice per PR (the
first run of each followed by a comment preview), deep once.

| PR | Quick | Review | Deep |
| --- | --- | --- | --- |
| PR #2, 1 file | 34–36 s, 4 requests, 26–27 K input | 64–71 s, 12–13, 82–88 K | 68 s, 11, 77 K |
| PR #4, 35 files | 26–47 s, 4–7, 68–178 K | 60–62 s, 13, 203–212 K | 79 s, 18, 383 K |
| PR #3, 316 files | 119–151 s, 57–58, 2.07–2.18 M | 241–274 s, 127–147, 3.90–4.82 M | 245 s, 142, 4.44 M |

- Comment planning on PR #3: after quick 169 s, 10 sessions, 136 K input, 24
  inline comments (15 of them combined); after review 161 s, 8 sessions,
  162 K, 26 inline comments. On PR #2 and PR #4 existing threads already
  covered every finding (5–8 s).
- Planted defects: PR #3 policies quick 24 and 23, review 24 and 24, deep 24;
  its configuration defect quick 0 of 2, review 1 of 2, deep 0 of 1; PR #4's
  seeded regression in the diff quick 1 of 2, review 2 of 2, deep 1 of 1, the
  one outside the diff in no run.
- In the second PR #4 quick run the reviewer of the 25-file shard read the 25
  diffs in one request and answered PARTIAL in the next ("callers, related
  tests and function context not read") without a tool error, truncation or
  limit; the run reported incomplete coverage and no finding. In all recorded
  PR #4 initial sessions since 2026-10-11, those that answered after two
  requests found the seeded regression in 2 of 24, the others in 85 of 144. On
  PR #3, whose planted defects are visible in the diff, two-request sessions
  found all of theirs.

This revision adds the quick follow-up (a usable PARTIAL answer that names
unfinished work gets one more turn in the same session). The two AZPR comments
on PR #4 were deleted first (one described the seeded regression; earlier
quick runs had not read threads). Ten PR #4 and two PR #3 quick runs each: A
is this revision, B adds one sentence to `quick.md` ("If a check you need is
unfinished and the source it needs is readable with AZPR's tools, continue it
before you answer; if a limit remains, keep PARTIAL and state it in
coverage.gaps.").

| | PR #4 A | PR #4 B | PR #3 A | PR #3 B |
| --- | --- | --- | --- | --- |
| Time (mean) | 40 s | 45 s | 156 s | 116 s |
| Requests (mean) | 5.3 | 6.5 | 73 | 61 |
| Input (mean, uncached) | 124 K (55 K) | 170 K (64 K) | 2.22 M (0.62 M) | 2.27 M (0.58 M) |
| Sessions with at most two requests | 11 of 20 | 7 of 20 | 0 of 26 | 3 of 26 |
| Planted defects | regression 7 of 10 | 8 of 10 | policies 24, 22; configuration 0 of 2 | 24, 24; 0 of 2 |
| PARTIAL answers and follow-ups | 0 | 0 | 0 | 0 |

- No reviewer answered PARTIAL in these 24 runs, so the follow-up never ran
  live; its behaviour rests on the offline and exact-host tests.
- With B the reviewer of PR #4's first shard read past the diffs in every run
  (A: two runs answered after two requests), for 37% more input on PR #4 and
  about the same on PR #3, where B had more two-request sessions. One more
  regression hit in ten runs is within run-to-run variation (one A run on PR
  #3 spent 30 requests in one shard). B is not part of this revision.

## Live runs: skip causes and page-scoped planning input (2026-10-18, preview only)

Same setup. The AZPR comments on PR #2 and PR #4 were deleted first (PR #3 had
none), so every PR's planning writes real comments; nothing was posted. One
quick and one review run per PR with a comment preview, compared with the
preview runs on `33fb851` above (PR #2 and PR #4 skipped every finding there
because earlier threads covered them).

| PR #3 planning | `33fb851` quick | this revision quick | `33fb851` review | this revision review |
| --- | --- | --- | --- | --- |
| Payload per page (mean) | 27.8 K characters | 11.0 K | 27.8 K | 11.1 K |
| Input (uncached + cached) | 136 K (93 K + 43 K) | 67 K (44 K + 23 K) | 162 K (86 K + 76 K) | 80 K (38 K + 42 K) |
| Time | 169 s | 140 s | 161 s | 163 s |
| Sessions, requests, correction turns | 10, 12, 3 | 9, 9, 0 | 8, 13, 1 | 9, 11, 0 |
| Inline comments | 24 (15 combined, 15 candidate pairs) | 24 (10 combined, 10 pairs) | 26 of 30 findings | 33 of 34 |
| Skips | none | 1 `low-severity` | 2 low, 2 "no source passage" with the file in the page | 1 `low-severity` |

- The page-scoped lists halved planning input on the 316-file PR; time did not
  follow the input, since a page's time goes to writing its answer.
- Every planner skip named a valid cause and none needed a correction turn. No
  planner claimed missing source this time, so the cause check did not trigger
  live; the offline tests and the planning test cover it.
- Every candidate pair of the quick runs became one comment, as before.
- PR #2 now gets its three comments in either mode (18 s of planning); PR #4's
  review gets one, and its quick run had no finding to plan.

## Live runs: gpt-6.1-sol on the old and new revision (2026-10-18, preview only)

OpenCode 2.0.32, every role on `openai/gpt-6.1-sol` (default variant), the
same settings, no AZPR comments on the three PRs, nothing posted. Each PR ran
`/pr-quick`, `/pr-review` and `/pr-deep` once on `33fb851` (old) and once on
this revision (new), each followed by a comment preview; old and new were
installed alternately per PR. Cost is the API equivalent at OpenAI's Standard
prices (gpt-6.1-sol $2.00 input, $0.10 cached input, $10.00 output per million
tokens; gpt-6-luna $0.10, $0.01, $0.50; reasoning counted as output); the
ChatGPT sign-in the runs used reports no cost. Every reported finding outside
the planted defects was checked against the source at both commits.

| PR | Mode | Review time (old / new) | Review input | Review cost | Planning (old / new) | Findings |
| --- | --- | --- | --- | --- | --- | --- |
| PR #2 | quick / review / deep | 42 / 43 s, 99 / 100 s, 93 / 93 s | 25 K, 85 K, 87 K | $0.04, $0.13, $0.11–0.13 | 23–24 s, 6 K input | the 3 known defects in every run |
| PR #4 | quick | 132 / 155 s | 0.61 / 1.11 M | $0.41 / $0.52 | 45 s, 15–16 K | both seeded regressions in every run, plus 1–2 confirmed and 1 debatable defect |
| PR #4 | review | 260 / 310 s | 1.74 / 1.87 M | $1.09 / $1.11 | 50 / 54 s | both seeds, plus 3 confirmed and 1–2 debatable |
| PR #4 | deep | 270 / 332 s | 1.82 / 2.25 M | $1.12 / $1.21 | 48 / 57 s | both seeds, plus 1–3 confirmed and 1–2 debatable |
| PR #3 | quick | 191 / 198 s | 2.06 / 2.12 M | $1.75 / $1.79 | 219 / 218 s, 153 / 97 K | 24 of 24 policies (50 findings, planned as 24 comments); configuration 0 |
| PR #3 | review | 355 / 382 s | 4.22 / 4.51 M | $3.81 / $3.84 | 156 / 150 s, 76 / 47 K | 24 of 24 (24 findings); configuration 0 |
| PR #3 | deep | 390 / 371 s | 4.58 / 4.62 M | $4.05 / $3.91 | 154 / 153 s, 82 / 47 K | 24 of 24 (24 findings); configuration 0 |

- Accuracy: none of the 250 reported findings was false. On PR #4 the model
  also found five real regressions of the PR besides the seeds (chained
  pipeline constraints overwrite each other, a case transform exceeds
  max_length, nested serialization schemas disagree with the JSON schema, a
  PEP 585 generic alias skips `__get_pydantic_core_schema__`, a resolved `Self`
  keeps a stale origin) and two real but debatable changes (validation-mode
  schemas follow `ser_json_temporal`, model ser schemas use the prebuilt
  serializer). No verifier rejected a planted or known defect. gpt-6-luna on
  the same day never found PR #4's second seed, reported two false PR #3
  findings on test files (in review and deep) and had one review reject a
  known PR #2 defect.
- Cost and time: each version's nine runs cost about $13.4 with planning
  (luna: under $0.6), a PR #3 review about $3.8 (luna $0.17–0.19). The input
  volume was close to luna's; time was 1.3–1.6 times luna's on PR #2 and PR #3
  and 3–5 times on PR #4, where the model read more (13–41 requests against
  4–18).
- Old against new: the review stages did not differ beyond run-to-run
  variation and no PARTIAL answer occurred, so no follow-up ran. Planning input
  fell by 37–43 % on PR #3 (planning time unchanged), every skip of the new
  revision named a cause (`low-severity`) and none needed a correction turn.

## Live runs: planning two pages at a time (2026-10-19, preview only)

OpenCode 2.0.32, every role on `openai/gpt-6-luna`, nothing posted. Three
saved reviews were planned again with `/pr-comment <review-id>`, which gives
every run the same findings, report and source: two of PR #3 (a quick review
with 35 findings and a review with 34, nine pages each) and one of PR #4 (a
review with 7 findings, two pages). `03fcf8a` (pages one at a time, with
`priorPages`) planned each once; this revision planned each once with
`workflow.parallelSessions` 1 (one page at a time, no `priorPages`) and twice
with the usual 8 (two pages at a time).

| Planning time | `03fcf8a` | this revision, one at a time | this revision, two at a time |
| --- | --- | --- | --- |
| PR #3 quick, 9 pages | 141 s (140 s on 2026-10-18) | 157 s | 76 s, 71 s |
| PR #3 review, 9 pages | 175 s (163 s on 2026-10-18) | 161 s | 90 s, 86 s |
| PR #4 review, 2 pages | 48 s | 47 s | 28 s, 27 s |

- Two pages at a time halved planning on the nine-page plans and cut the
  two-page plan by 42 %. Every two-lane run had two planner sessions in flight
  and never more; with `parallelSessions` 1 the pages ran one at a time, and
  removing `priorPages` alone did not change the time.
- Every two-lane run finished pages out of order (page 2 before page 1, page 4
  before page 3, page 8 before page 7). Rebuilding each plan offline from its
  pages in page order reproduced the saved plan exactly (every finding's
  marker, the comment texts and the summary) for all 14 plans compared,
  including the earlier ones.
- Every finding got the same decision (comment or skip, with the same cause)
  in all plans of a review. Anchor lines agreed on 34 of 34 PR #3 quick
  comments in every pair of plans and on 31–33 of 33 review comments; on PR #4
  the planner chose different lines for 1–5 of 7 comments between any two
  plans, including the two two-lane runs (4 of 7 equal), so this is the
  planner's own variation. The quick plans combined the same 10 candidate
  pairs in the two runs of `03fcf8a` and both two-lane runs; the one-lane run
  combined 6: it left apart the two pairs of page 4 and those of page 1, whose
  input carries nothing from other pages in either version.
- The first page wrote the summary note in every plan; no other page wrote one,
  so the runtime never had to drop one. One correction turn occurred, in the
  one-lane quick run (a page left a finding unaccounted).
- Input and output stayed at 63–80 K and 6–8 K tokens per PR #3 plan. The
  cached share of the input rose from 29–34 % in the first runs to 84–100 % in
  the two-lane runs because the same pages had just been planned, not because
  of the lanes.
- End to end on this revision, a new `/pr-quick` of PR #3 was COMPLETE in
  255 s and its preview planned 8 pages in 62 s (24 inline comments, 6 of them
  combined pairs); a new `/pr-review` was COMPLETE in 223 s and its preview
  planned 8 pages in 80 s (29 inline comments; one correction turn for a skip
  that relied on another finding, after which the planner commented on it).
  Both finished pages out of order and rebuilt exactly. On 2026-10-18 the same
  PR's previews had planned 9 pages in 140 s (quick) and 163 s (review).

## Deep versus review (2026-10-19)

No new runs: this compares the 2026-10-18 runs above. Until this revision a
deep agent's system prompt was the review agent's plus `deep.md` (854
characters, the same text for all four roles) asking for more scrutiny; most of
it restated `common.md`, `functional.md`, `risk.md` and `final.md`. Stages,
inputs, tools, shards and correction turns were already the same. gpt-6-luna
ran `/pr-review` five times per PR (twice on the `/pr-quick` branch, twice on
`33fb851`, once on the following revision) and `/pr-deep` once on `33fb851`;
gpt-6.1-sol ran each twice.

| PR | gpt-6-luna review | gpt-6-luna deep | gpt-6.1-sol review | gpt-6.1-sol deep |
| --- | --- | --- | --- | --- |
| PR #2, 1 file | 57–75 s, 82–93 K input; the 3 known defects in 2 runs, 2 of them in 3 (one rejected by the verifier) | 68 s, 77 K; all 3 | 99–100 s, 85–86 K; all 3 | 93 s, 87–88 K; all 3 |
| PR #4, 35 files | 37–68 s, 203–278 K; seeded regression in the diff 4 of 5, outside the diff 0 of 5 | 79 s, 383 K; in the diff only | 260–310 s, 1.74–1.87 M; both, plus 3 other real regressions in each run | 270–332 s, 1.82–2.25 M; both, plus 1 and 3 |
| PR #3, 316 files | 226–289 s, 3.38–4.82 M; policies 24 of 24, configuration 2 of 5, one false finding in five runs | 245 s, 4.44 M; 24 of 24, no configuration, one false finding | 355–382 s, 4.22–4.51 M; 24 of 24 | 371–390 s, 4.58–4.62 M; 24 of 24 |

- The deep text changed what gpt-6-luna read on PR #4, not what it found: the
  review's functional and risk sessions read the 35 diffs with 0–5 whole files
  and 0–3 searches, while deep's functional reviewer searched 10 times and its
  risk reviewer read 7 files and searched 8 times (8 requests against 4–5).
  That cost 38–89 % more input, and the regression outside the diff stayed
  missed. On PR #2 and PR #3 deep stayed within the review's run-to-run range.
- gpt-6.1-sol already reads past the diffs in a review, and deep made no
  difference beyond run-to-run variation (on PR #3 about 5 % more input).
- What changed results was the model: on 2026-10-18 gpt-6.1-sol found both
  seeded regressions in all six of its runs (quick, review and deep), while
  gpt-6-luna never found the one outside the diff, nor did it with high
  reasoning effort earlier (see the model runs above).

This revision drops `deep.md`: `/pr-deep` runs exactly the review's system
prompts with the models of `models.deep`, so the gpt-6.1-sol review runs above
describe a deep review with that model. Since the models are the only
difference, `models.deep` is for stronger models than `models.review`; with the
same models `/pr-deep` repeats `/pr-review`.

Live check of this revision (2026-10-19, `models.deep` on gpt-6.1-sol, review
and quick on gpt-6-luna, previews only): `/pr-check` was READY and listed the
deep models as checked; every deep stage's system prompt was the review
prompt byte for byte.

| PR | Review | Input (cached) | API cost | Findings | Preview |
| --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | COMPLETE, 86 s, 12 requests | 86 K (58 %) | $0.12 | the 3 known defects | 3 inline comments, 22 s |
| PR #4, 35 files | COMPLETE, 351 s, 41 requests | 2.29 M (83 %) | $1.22 | both seeded regressions, two findings on another real one (chained pipeline constraints) and two debatable ones; none false | 1 inline comment; 5 findings skipped because threads of an earlier publication covered them, 21 s |

No stage was retried, failed, stopped idle or hit a tool error; one PR #4
reviewer answer repeated a JSON key and was fixed in its correction turn.

## Live runs: the three modes after the deep change (2026-10-19, preview only)

Two batches on OpenCode 2.0.32 with `workflow.parallelSessions` 8 and
`azure.concurrency` 6, each review followed by a comment preview; nothing was
posted. `d7cd0ac` ran `/pr-quick` and `/pr-review` with every role on
`openai/gpt-6-luna`; `e673889` ran all three modes, `/pr-deep` with
`openai/gpt-6.1-sol` in `models.deep`. Later revisions changed only how the PAT
is read. The `e673889` batch:

| PR | Mode (model) | Review | Sessions / requests | Input (cached) | API cost | Findings | Preview (inline) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | quick (luna) | COMPLETE, 37 s | 1 / 5 | 32 K (70 %) | < $0.01 | the 3 known defects | 18 s (3) |
| | review (luna) | COMPLETE, 84 s | 3 / 15, 2 corrections | 115 K (66 %) | $0.01 | 2 of the 3; the verifier rejected the partial reservation with a reason that confirms it | 22 s (3) |
| | deep (sol) | COMPLETE, 100 s | 3 / 12 | 86 K (64 %) | $0.11 | the 3 known defects | 22 s (3) |
| PR #4, 35 files | quick (luna) | COMPLETE, 47 s | 2 / 9 | 240 K (70 %) | $0.01 | the seeded regression in the diff only | 10 s (1) |
| | review (luna) | COMPLETE, 58 s | 5 / 14 | 342 K (64 %) | $0.02 | no candidate for either seeded regression | 3 s (0) |
| | deep (sol) | COMPLETE, 249 s | 5 / 36 | 1.61 M (78 %) | $1.07 | both seeded regressions, 2 other real ones, 1 debatable, none false | 32 s (5) |
| PR #3, 316 files | quick (luna) | COMPLETE, 107 s | 13 / 53 | 1.91 M (67 %) | $0.09 | policies 24 of 24, not the configuration defect, nothing else | 56 s (25) |
| | review (luna) | COMPLETE, 239 s | 31 / 143 | 4.60 M (71 %) | $0.19 | 24 of 24 (one rejected candidate was covered by another), not the configuration defect, nothing else | 51 s (23; 1 low skipped) |
| | deep (sol) | COMPLETE, 394 s | 32 / 145 | 4.51 M (70 %) | $3.80 | 24 of 24, not the configuration defect, nothing else | 75 s (24) |

- Execution: the 18 runs of this batch (nine reviews, nine previews) had no
  AZPR retry, failed stage, inactivity stop, PARTIAL answer (so no quick
  follow-up), tool error or timeout, blocked native tool, Azure DevOps retry or
  warning, and every session was confirmed stopped. The only correction turns
  were two for the PR #2 luna verifier: it merged a duplicate into a finding it
  had rejected, then confirmed that finding without its fields. When the eight
  gpt-6.1-sol functional shards of PR #3 started together, OpenCode resent each
  first request once after about 2 s; no stage needed a second attempt.
- All nine plans rebuilt exactly from their pages in page order; four had
  finished pages out of order.
- The `d7cd0ac` batch (12 runs) was as clean, without a correction turn. PR #2
  had the 3 known defects and PR #3 24 of 24 in both modes. On PR #4 quick
  found the seeded regression in the diff; in the review the risk reviewer
  found it too, but the verifier rejected it with a reason ending "so the
  candidate's claim does in fact hold". PR #3's 8–9 planning pages took
  71–72 s (140–175 s one page at a time on 2026-10-18).
- The `e673889` batch took 12.2 minutes and $0.33 API-equivalent for the six
  luna runs (reviews and previews), and 14.5 minutes and $5.19 for the three
  sol runs, $0.20 of it planning.
- Prompt cache: the 316-file PR read 67–71 % of its input from the cache in
  all three modes (11–21 % on OpenCode 2.0.22).

## PAT scopes and `azure.patFile` (2026-10-21)

A new PAT for the test organization, organization-scoped with an expiry and only
**Code (Read)** and **Pull Request Threads (Read & write)**, replaced the earlier
token on OpenCode 2.0.32 with `e673889` installed.

- Reads: `/pr-check` was READY on PR #2 (PR metadata, changed files, HEAD and
  BASE reads, 164 threads), and `/pr-quick` with a comment preview was COMPLETE
  (PR, iterations, changes, commits, files and a folder listing). The repository
  archive that content search downloads answered HTTP 200 with a zip.
- Write: thread creation, the only Azure DevOps write AZPR makes, answered
  HTTP 200 on the same PR; the comment read back and was then deleted, which
  the same scope allows. `/pr-comment --publish` could not show the write on
  that PR: AZPR records each thread it created by marker and never sends that
  marker again, and the PR's earlier AZPR comments had been deleted by hand, so
  all four items stayed UNVERIFIED without a request.
- `azure.patFile`: with this revision installed, `settings.json` set `pat` to
  empty and `patFile` to the PAT file (mode 600). `/pr-check` was READY and
  showed "PAT from azure.patFile" without the path, `/pr-quick` with a preview
  was COMPLETE, and a scan of the configuration, state and OpenCode data
  directories found the PAT only in that file.
- An external review found that a FIFO named by `azure.patFile` made opening it
  wait for a writer, so loading hung (even process exit waited for the blocked
  thread). Opened without blocking, a FIFO is now refused in 5 ms under
  OpenCode's Bun 1.4.2 and 7 ms under Node 22, and `/pr-check` with the PAT
  file stayed READY on OpenCode 2.0.32.

## Verifier decisions on known defects (debug records, 2026-10-10 to 2026-10-19)

The saved results and debug records of the 108 review and deep reviews of the
three test PRs, earlier revisions included, were checked offline: for every
functional or risk candidate that matches a known defect, the verifier's
decision, and whether the defect was still among the publishable findings
afterwards.

| Verifier | Reviews | Known defects among the candidates | Lost at verification |
| --- | --- | --- | --- |
| gpt-6-luna | 48 | 423 | 3, in 3 reviews |
| gpt-6.1-sol | 21 | 158 | none |
| gpt-5.6-luna | 22 | 373 | 2, in 1 review |
| gpt-5.6-terra | 15 | 135 | 5, in 5 reviews |

- gpt-6-luna lost PR #2's partial reservation in 2 of 14 reviews and PR #4's
  regression in the diff in 1 of 18, and none of 371 on PR #3. In two of the
  three the rejection's own reason establishes the defect ("so the candidate's
  claim does in fact hold"; "contradicts the README's contract that a rejected
  batch leaves stock and history unchanged"): the answer filed a defect it had
  checked under `rejected`. In the third the verifier described the base's
  validate-then-deduct order as the head's. All three came from the first
  answer, not from a correction turn. Two reviews with gpt-6-luna#high lost
  none.
- gpt-5.6-luna lost two policies in one review: it rejected two candidates as
  "a valid issue; see the confirmed item with the same root cause" and merged
  their duplicates into them. A merge into a rejected finding now gets a
  correction turn.
- gpt-5.6-terra rejected the configuration defect in all five reviews whose
  reviewers found it, each time because no code reads the routing settings the
  change drops, so no failure is reachable: a stricter bar for evidence, not a
  contradiction.

### A stronger verifier behind gpt-6-luna reviewers (2026-10-22, review only)

OpenCode 2.0.32 with this revision; `models.deep` held gpt-6-luna functional
and risk reviewers and a gpt-6.1-sol verifier, so `/pr-deep` ran the review
with only the verifier changed, alternating with `/pr-review` on gpt-6-luna.
All 28 reviews were COMPLETE; nothing was posted.

| PR | Verifier | Reviews | Review | API cost per review (verifier) | Known defects kept | Correction turns |
| --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | gpt-6-luna | 8 | 58–82 s | $0.006 ($0.002) | all 3 in 7 runs; in the 8th no reviewer proposed the partial reservation | 1 |
| | gpt-6.1-sol | 8 | 75–88 s | $0.049 ($0.046) | all 3 in all 8 | none |
| PR #4, 35 files | gpt-6-luna | 4 | 41–69 s | $0.016 ($0.002) | the regression in the diff in 2 | none |
| | gpt-6.1-sol | 4 | 39–95 s | $0.065 ($0.050) | the regression in the diff in 3 | none |
| PR #3, 316 files | gpt-6-luna | 2 | 245–300 s | $0.19 ($0.02) | policies 24 of 24 | 3 |
| | gpt-6.1-sol | 2 | 266–335 s | $0.66 ($0.41) | policies 24 of 24 | none |

- Neither verifier lost a known defect this time. The gpt-6-luna verifier once
  more rejected PR #2's partial reservation with a reason saying that it should
  not be rejected; a duplicate candidate that it confirmed kept the defect. The
  gpt-6.1-sol verifier rejected no known defect; on PR #3 it rightly rejected a
  luna candidate claiming that schema-1 routes lose their retry fields.
- The PR #4 difference came from the reviewers: in the other runs no candidate
  named the regression in the diff. Neither combination found the one outside
  the diff.
- The gpt-6.1-sol verifier cost 8, 4 and 3.4 times the luna review on the
  three PRs and added 9–29 s; a gpt-6.1-sol deep review costs $0.11, $1.07 and
  $3.80 there.

With the debug records above, the gpt-6-luna verifier lost 3 known defects in
62 reviews and the gpt-6.1-sol verifier none in 35. A stronger model in
`models.review.verifier` keeps more of what the reviewers find at a few times
the luna cost; it does not change what they find.

## Live publication with this revision (2026-10-22)

OpenCode 2.0.32 with this revision, gpt-6-luna for review and quick.

- PR #3, 316 files: `/pr-review` was COMPLETE in 271 s (policies 24 of 24;
  66 candidates, 24 publishable; $0.18 API-equivalent). `/pr-comment
  --publish` planned 6 pages in 67 s without a correction turn and posted the
  summary and 23 inline comments, all VERIFIED; the one low finding went to
  the summary index. No skip relied on another finding (the correction turn
  for one was seen live in a preview on 2026-10-19). A second publish found
  all 24 ALREADY_PRESENT.
- Deleting three of those inline comments in Azure DevOps left their threads
  listed, flagged deleted, with the comments flagged deleted and without
  content. The next publish was POSTED with 21 ALREADY_PRESENT and 3 DELETED,
  using four GET requests and no write.
- PR #2, 1 file: a `/pr-quick` (35 s) planned exactly the four items that AZPR
  had posted there on 2026-10-11 and that were later deleted by hand; on
  2026-10-21 publishing them had given four UNVERIFIED items and FAILED. This
  revision reported four DELETED items, the receipt POSTED, with four GET
  requests and no write. With that PR's publication record moved aside, the
  same quick review then posted its summary and three inline comments, all
  VERIFIED and each naming the quick method in its disclosure line; a second
  publish found all four ALREADY_PRESENT.
- PR #4: two quick reviews (25 and 34 s) reported no finding, so nothing was
  posted there.

## Reviewer rounds and session cleanup (debug records, offline tests)

A stability review proposed batch parameters for `azpr_read_diff` and
`azpr_read_file`, because one gpt-6-luna session under the earlier prompts had
made 28 model requests with about one tool call each. The debug records of all
133 live runs above show that this was an outlier: reviewers already batch by
making several tool calls in one response. With the final prompts:

| Model | Sessions | Model requests per session (most) | Tool calls per round |
| --- | ---: | ---: | ---: |
| gpt-5.6-luna | 123 | 5.4 (10) | 10.5 |
| gpt-5.6-terra | 78 | 4.4 (6) | 12.2 |
| gpt-6-luna | 30 | 4.4 (9) | 9.3 |

The first round reads every assigned diff at once (25 in a full shard); later
rounds follow leads that depend on what was read. gpt-6-luna makes 29 of its 71
later rounds with a single call, so a batch parameter could save it about one
request per session at most. Batch parameters were not added. The comment
planner's forced final answer (tools removed and an instruction added after 12
requests) never triggered in 21 live planning sessions (18 needed one request,
the most was 9), so its effect on prompt caching was left as is. Only 1 of
those 21 sessions returned CONTINUE (an early revision that made the planner
read the PR threads; a second session finished the page). A page now gets at
most three continuation sessions, so a planner that keeps reading without
finishing cannot open sessions without end; an offline test shows the fourth
session ending the page while the next page is planned as usual. Cache reads
stay at 11–21 % of input in these runs; see the roadmap.

Reviewer sessions of an evicted review or an unfinished run are now deleted
eight at a time, each deletion still limited to five seconds. A host that
stalls on deletion delays the receipt by one limit per eight sessions instead
of one per session: about 20 s instead of 2.5 minutes for the 30 sessions of a
PR #3 review. An offline test uses a host that never confirms a deletion.

## Host retries and stage inactivity (OpenCode 2.0.22, debug records)

A stability review asked whether OpenCode's own retry of a failed provider
request is refused by AZPR's `model.request` hook, which accepts a primary
request only after an authorized `context` hook, and noted that a stage could
wait without limit. Checked on 2026-10-14 in the OpenCode 2.0.22 binary, the
debug records of the live runs above and the exact-host fixture:

| Question | Observed |
| --- | --- |
| How OpenCode retries | `SessionRunner.runStep` handles a retry before any output, a continuation after partial output and a WebSocket recovery the same way: it waits, then prepares the request again, and `SessionModelRequest.prepare` triggers `context` and then `model.request`. A resend therefore always follows an authorized context. Backoff starts at 2 s and is capped at 10 s, at most 10 retries; `Retry-After` of rate-limit and provider-internal errors is honoured up to 15 minutes; transport timeouts are retried at most 3 times. |
| Host retries in live runs | 1,101 stage records of 71 live runs (2026-10-10 to 10-14): 10 stages saw a host retry (attempt 2, allowed by the `retry` hook). In each, the authorized primary requests equalled the observed ones and none was rejected; 9 completed and 1 failed for an unrelated reason (a continuation after a turn with tool calls, which is refused by design and retried in a new session). The only rejected requests, in 3 stages, were compaction requests. The stability review had counted no host retry. |
| How long OpenCode waits for a provider | An HTTP (SSE) response is aborted after 5 minutes without headers or data (`headerTimeout` and `chunkTimeout` default to 300,000 ms). OpenCode's OpenAI integration uses the WebSocket session transport by default, whose wait for data defaults to 30 minutes, and a timed-out read can be retried. |
| Normal quiet time | In the 1,097 live stages that ended normally, the longest stretch without a prompt admission, model request, tool start or end or host retry was 151 s, while a final answer was written; the 99th percentile was 120 s and the median 23 s. These stretches include answers being streamed, which count as activity too (next row), so the quiet time the watchdog sees is shorter. The 4 other stages are the 2026-10-10 run in which native `grep` calls waited for an approval for 1,688–1,813 s (such requests are refused at once since). |
| What a plugin sees while a model streams | A probe plugin on OpenCode 2.0.22, while a fixture provider streamed one chunk per second: the projected session context kept the answer text empty until the step ended and `session.get` did not change, but `event.subscribe()` delivered one `session.text.delta` event per chunk, carrying the session ID. The feed also has reasoning and tool-input deltas, tool progress and step events, and `return()` on its iterator ends the subscription at once. An external review of this revision showed why it matters: before streamed output counted as activity, an answer streaming one chunk per second through a 60 s window was stopped at 60.9 s, 0.9 s after its last chunk. AZPR now follows these events while a stage is watched. |
| Reviews without candidates | 3 of 71 runs (PR #4, gpt-6-luna) produced no candidate finding. Their verifier sessions took 6–14 s with 1–3 requests and added no finding, but they condensed the four initial reports into the report's checks and limitations; one checked and relayed a narrowed test assertion, the same advice that comment planning turned into the published PR #4 summary. Without the verifier that section would be empty or four unedited reports, so it still runs. No PR without changed files occurred; such a PR now stops before any session. |

So host retries needed no change. The watchdog's default of 600 s is four
times the longest quiet stretch observed; a stopped stage is retried like a
transient failure, and its error names the last activity.

## Known limitations

- **Tested environment.** OpenCode CLI 2.4.1 (V2 plugin API) on Ubuntu 22.04
  under WSL2 since 0.5.1 (2.3.2 for 0.5.0, 2.3.0 for 0.4.1 to 0.4.6). Other
  OpenCode 2.x versions get an OpenCode WARNING row in `/pr-check` and are not
  validated, apart from what the records of 0.4.1 (2.2.4) and of 0.5.1 (2.3.0
  to 2.4.0) say was run there; OpenCode 1.x is not supported. Other operating
  systems are not validated yet.
- **0.5.1 with real models.** No review with a real model ran on the 0.5.1
  candidate. Its review prompts are those of 0.5.0, but its private sessions
  no longer get the local instructions OpenCode collects, and what a real
  model does after the notice of a background command was not seen. The
  benchmark runs of 0.5.0 were made in directories without such instructions,
  which is the state every review is in now.
- **What a private session is told rests on OpenCode's interface.** Keeping
  local instructions out of private requests uses a field OpenCode marks as
  experimental (for `claude-agent` models, also the text that provider keeps
  in a request's options), and recognising a background command's notice uses
  the metadata OpenCode writes on it. Where a later OpenCode changes either,
  AZPR falls back: the system parts go out as OpenCode builds them (the stage
  record counts those requests), and such a notice fails the turn again, as
  before 0.5.1. With shell allowed, a notice is taken for the host's own by
  that metadata alone, once for each command the session started in the
  background; whoever can write to the session and sends such a notice before
  the host does is believed. The default, `shell: "deny"`, accepts none. This
  keeps OpenCode's collected instructions out of a review; it does not make a
  review the same in every directory: the environment names the directory,
  and a reviewer can read local files on purpose.
- **With shell allowed, a command that ends after the answer.** The session
  it wakes gets no model request and no tool, so the command's result is not
  looked at, and OpenCode leaves that session in a failed state, which is the
  state of the session that keeps the report when it was the last one. A
  request that nobody approves (`shell: "ask"`) stops the stage after
  `workflow.stageIdleSeconds`, in its retry too.
- **An answer that reaches the model's output limit fails its pass.** OpenCode
  then asks the model to go on, with a message of its own that AZPR takes for
  someone else's: both sessions of the pass fail, and the receipt speaks of
  another message in the turn, not of the limit (OpenCode 2.3.0 to 2.4.1,
  measured with the fake model). Smaller shards (`workflow.shardFiles`) or a
  model with a larger output limit avoid it.
- **A command sent as a prompt at startup.** AZPR stops one of its commands
  that reaches OpenCode as an ordinary prompt only once AZPR itself is
  loaded, and the terminal UI answers the refusal by trying again in new
  conversations, which stay empty (two to four in the fixture runs). How the
  desktop app and other clients show the refusal was not tried.
- **0.5.0 with real models.** The candidate's real-model runs reviewed public
  pull requests against a local stand-in for Azure DevOps (see
  [the record](#050-release-candidate-acceptance-2026-11-23)); no 0.5.0 review
  has run against Azure DevOps Services or posted there, and no real settings
  file of 0.4.x has been updated. Its review quality rests on one benchmark,
  scored by our local judge.
- **OpenCode 2.3.0 with real models.** On 2.3.0, AZPR 0.4.1 has reviewed and
  previewed the 1-file and the 35-file test PR with gpt-6-luna, once each
  (see [the record](#041-after-publication-live-reviews-and-session-cleanup-on-real-hosts-2026-11-16)).
  The 316-file PR, `/pr-quick`, `/pr-deep`, publication and other models have
  not run there, and the effect of sessions of their own on a provider's
  prompt cache is not measured: one run per case cannot separate it from the
  variation between runs.
- **The terminal panel.** It is part of OpenCode's terminal UI and was
  exercised on OpenCode 2.3.0, 2.3.2 and, since 0.5.1, 2.4.1 in its new and
  its classic design, inside tmux with fake services (see
  [the record](#042-release-candidate-acceptance-2026-11-17) and
  [the comparison of the hosts](#opencode-231-to-241-compared-with-230-2026-11-24-to-26)).
  On 2.4.1 no review with a real model has run with it; other terminal
  emulators and their mouse reporting are untested, and the desktop app does
  not load it. The package carries its view compiled, which loads on OpenCode
  2.3.0 to 2.4.1.
  Three things are as they were on 2.3.0: in the list that adjusts findings,
  what is typed selects by the host's fuzzy search, so with ten or more
  findings `F-1` selects `F-11` (the dialog that opens names the finding); a
  panel that fills a narrow terminal shows bands of the Markdown's
  background; and the second line of a question's row is cut at the dialog's
  width.
- **A release the terminal UI makes up.** On OpenCode 2.4.0 and later a step,
  a session's row or `close` that was pressed and moved on, and whose release
  never arrived, gets a release at the next press anywhere. AZPR takes a
  release as a click only within a second of the pointer's last movement, so
  a second press within that second can still pick what was pressed, and a
  click whose release comes more than a second after a movement does nothing
  and must be made again. The second is measured between handling the two
  events, since an event carries no time of its own: where the terminal's
  input waited (the process was stopped or busy), a made-up release that is
  handled right after its movement is taken for a click. The questions that a
  step opens, and the foot of the list of adjustments, are the host's own
  lists, which act on a release alone. Whether and how often real terminals
  lose a release was not measured: every gesture here was injected in tmux.
- **Setup in the terminal UI.** The dialogs of `/pr-setup` exist in
  OpenCode's terminal UI only; the desktop app and other clients get the
  instructions and the options. They were exercised on OpenCode 2.3.0, 2.3.2
  and 2.4.1 inside
  tmux with fake services (see
  [the record](#043-release-candidate-acceptance-2026-11-18)): pasting and
  typing in other terminal emulators are untested, Page Up and Page Down
  close the token dialog as they close OpenCode's own dialogs (nothing is
  saved then), and the dialogs have not
  been used against a live Azure DevOps organization, only the one request
  they make was. The check tells that Azure DevOps accepts the token for the
  organization and lets it read code; it cannot tell whether the token may
  write pull request threads or reach a particular repository, which
  `/pr-check` and the first publication show. A first setup is loaded at once
  in the project directory where it ran; a change to settings that are in
  use, and another project directory that the OpenCode service had already
  opened without settings, still need a restart of the OpenCode service. After a first setup, a client other than the terminal UI
  with AZPR's part may go on suggesting the review commands as "setup
  required" until it reconnects, because OpenCode 2.3.0 through 2.4.1 announce
  that change of commands without a location; the commands themselves work. The token
  passes through the terminal UI's memory and its connection to the OpenCode
  server on its way to the token file.
- **Notices and the conversation's own model.** AZPR leaves its notices in
  the conversation's inbox without waking it, so a review costs the
  conversation's model nothing while the conversation is idle. When a person
  later prompts that same conversation, its model reads the notices that
  wait together with the prompt, in one request (until 0.4.2 each notice
  took a request of its own; see
  [0.4.3](#043-release-candidate-acceptance-2026-11-18)). The text of the
  notices still enters that conversation's context once; a conversation used
  only for AZPR's commands never sends it to a model. A notice that arrives
  while the conversation's model is working is handed to it during that
  work, or in one request right after it, without a prompt: OpenCode offers
  a plugin no notice that a session's model never reads.
  `progressNotices: false` leaves fewer notices.
- **Private sessions in the session list.** OpenCode lists AZPR's private
  sessions next to conversations, and its plugin API cannot archive them.
  AZPR deletes all but the report session when a run ends; with debug enabled
  every session stays until its review is evicted. A review interrupted by an
  OpenCode restart leaves its sessions behind: AZPR had not recorded them yet
  and does not delete them later. Their titles (`[AZPR <id>] …`) and
  `metadata.azpr` identify them.
- **Azure DevOps Services only.** Azure DevOps Server (on-premises) is not
  supported by the current URL handling.
- **File encoding and size.** Files are read as UTF-8, so text in another
  encoding, such as Big5 or Shift_JIS, reaches the reviewers with replacement
  characters. Binary files and files over 10 MB are reported but not shown,
  and content search covers a commit archive of at most
  `azure.archiveMegabytes` (100 MB by default).
- **Corporate proxies.** AZPR has run live through a company HTTP proxy with
  `azure.verifyTls: false`. Trusting an inspecting proxy's root CA with
  `azure.caFile` is verified with a test proxy only, and proxies that require
  NTLM or Kerberos authentication are not supported directly.
- **Quick reviews are not independently verified.** `/pr-quick` reports what
  one reviewer per shard found and says so in its report and comments; use
  `/pr-review` when findings need a second check.
- **Findings depend on the model.** Results vary between models and between
  runs of the same model, and so do severities: another run can label the same
  issue differently. On the 35-file test PR, gpt-6.1-sol found a defect
  whose evidence spans a test and unchanged code in another shard, which
  gpt-6-luna missed; `/pr-deep` runs the same review with stronger models. On
  the 50 PRs of Martian's benchmark, recall ranged from 27.8% to 73.4% across
  the [model combinations we compared](#choosing-models-for-pr-deep).
- **Claude through the claude-agent provider.** The Claude CLI process behind
  each private session (about 200 MB) stays for five minutes after the
  session's last turn; OpenCode 2.4.0 and later end it when AZPR deletes the
  session, earlier versions do not. Many reviews in quick succession can
  therefore hold several gigabytes, on 2.4.x with `debug.enabled` too, which
  keeps every session; restarting the OpenCode service releases them. Claude
  Code also keeps a transcript of each session under its own configuration
  directory, which AZPR does not remove.
