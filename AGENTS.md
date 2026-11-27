# AI development guide

This repository targets the OpenCode V2 plugin API (tested with the
`@opencode/cli` release that `TESTED_HOST_VERSION` in `src/host.mjs` names), the
Azure DevOps Services REST API (api-version 7.1) and Ubuntu 22.04. Public source and documentation use English. Follow the user's
conversation language and current authorization scope.

## Before changing anything

Confirm the Git root, branch, HEAD, working tree and installed paths. Read
README, architecture, roadmap and the task-relevant docs. Local handover notes
under `.local/` (their file name differs between checkouts) give background
and hand-off state, never new authorization; check what they say against Git
and the actual environment. Preserve unrelated changes, credentials, private
settings, backups and failure records. Never upload `.local/`.

## Design rules

**Deterministic facts are code; judgment is model work.**
- PR identity, commit SHAs, the changed-file list, version rechecks, existing
  threads and all Azure DevOps writes go through `azure.mjs`, which calls the
  REST API with `azure.organization` and the PAT from AZPR's settings
  (`azure.pat`, or the owner-only file named by `azure.patFile`, which is read
  only through its symbolic-link, owner and mode checks). Keep
  REST paths and the pinned api-version in `azure.mjs` only; never log, echo or
  persist the PAT, and send it only to the organization's REST endpoint.
  `azure.proxy`, `azure.caFile` and `azure.verifyTls` shape only that
  connection; never show proxy credentials.
- Models read the repository only through the read-only tools in
  `review-tools.mjs`, registered with `codemode: false`; private roles see an
  explicit tool allowlist (empty for the `rating` role) and ordinary sessions
  never see AZPR's tools: also not in the requests the host builds outside a
  turn, a summary or a generation, which pass the `compaction` and `generate`
  hooks instead of `context`.
- Models review, compare, rate and plan comment text. They never echo identity
  or SHAs and never write to Azure DevOps.

**A private session is told what AZPR tells it, and runs only for AZPR's prompt.**
- A private role works from AZPR's own instructions and the host's date and
  environment. What the host collects for the place a conversation is in stays
  out of its requests: instruction files (AGENTS.md, CLAUDE.md, configured
  ones), and what MCP servers, references, skills and CodeMode say of
  themselves (`withoutPlaceInstructions` and `HOST_FACT_SOURCES` in
  `host.mjs`). Those speak of the local directory, which is not the PR's
  repository, and are no instructions for a review. Claim no more than that:
  the environment still names the directory, and a reviewer can read local
  files on purpose. Ordinary sessions are never touched.
- The host's parts are told apart by a field it marks as experimental. Where
  they cannot be (no such part, several, a text that is not its sources
  joined), the system parts stay as they are and the stage record counts the
  request (`placeInstructionsNotToldApart`); never tell them apart by their
  text. OpenCode's Claude Code provider (`claude-agent`) does not send the
  parts: it hands the model a text it made of them before any plugin's hook
  ran, in the request's options, when the parts were not yet what a plugin
  sees. For a request to that provider, leave the sources out only where
  that option holds exactly what they give (`claudeInstructions`), and empty
  it with them; where it holds anything else, or is missing, the parts and
  the option stay as they are. That is a rule for what OpenCode hands the
  Claude Code program, and no more is claimed: what that program reads of
  the working directory by itself was not tried with the real one. An option of that name on another provider's
  request decides nothing. The messages below are taken out either way.
- What the host writes of instructions into a running private session by
  itself is kept from the model: the instruction files it loads beside a
  file the native read tool read (`isInstructionLoad`), and its updates of
  the sources (`isInstructionUpdate`), whatever source an update is of.
  Which messages those are is the session's own word, not a request's
  (`hostInstructions`): an update is a `system` message, which only the
  host writes; a load is a synthetic message that names the files it holds,
  which is what the host itself goes by, and like the notice of a
  background command it is the late result of the session's own tool call:
  it counts only after an assistant message of the session called the
  native read tool. The `context` hook reads the session's messages and
  takes out of the request what is such a message as the host builds it
  (`withoutHostMessages`): the user message with a load's ID and the load's
  text as one text part, and a system message of the host's form that holds
  exactly an update's text (another plugin's system message that is the
  same in form and text cannot be told from it). As the host builds it means
  the whole message, each field of it, and what the host builds is plain
  data: a plain object for a load, an ordinary array of one plain text part
  for a content, plain objects and arrays for a load's metadata (seen on
  OpenCode 2.3.0 and 2.4.1; `host.mjs` says what plain data is). A message,
  a part or metadata that carries anything the host did not give it holds
  what a hook added, and taking it out would drop that. Ask it of an
  object's own properties, each taken once from its descriptor, so that
  nothing of the object's own is ever called and looking changes nothing:
  every one of them is listed, has a string for its name and holds its
  value itself (an array's length aside). A field that is not listed, one
  under a symbol, an accessor, an array or an object of another class, an
  object that answers for another (a proxy), metadata that is other data
  than the stored message's are each no longer the host's, and the message
  stays. The list of a request's messages is looked at like its items, and
  left whole where it is no ordinary list. Ask whether a value answers for
  another before anything else is asked of it: a proxy that was revoked
  throws at any question, also at whether it is a list. Never read a message through its properties (not its ID either),
  and compare metadata to its end, without a limit that data can exceed:
  what the hook takes out of a request as OpenCode builds it must be
  exactly what `requestReview` takes for no one else's input, or a message
  that someone posted reaches the model and its answer is accepted. That is
  the whole rule, so never add a case for one more shape: what is not plain
  data is not the host's. The same rule reads a request's system parts
  (`withoutPlaceInstructions`): a part that is no plain data is not looked
  into, and the instructions part is made anew only from plain data, with
  what a hook added to it in plain sight kept; where no source of it stays
  the part goes, so only a part that holds nothing but what the host gave
  it, and that part is a text part. The Claude provider's option is emptied
  only where it is a text that plain options hold of their own
  (`claudeOption`) and take the empty one, and a tool is taken out of a request's list
  only where the list lets it: a tool is what the list lists under a name
  (what a hook keeps there unlisted is none), and one that cannot be taken
  out stays listed, since whether a tool may run is decided where it is
  called, and the stage's record counts the request (`toolsLeftListed`). A
  planning session that is told to finish without tools is held to that
  where a tool is called too, since a list that could not be emptied still
  offers them. A part of AZPR's own is added after a request's system
  parts as a new list, where they are an ordinary one (`withPart`). A source
  that goes takes with it what it holds, so only one that holds nothing but
  its key and its text. The event itself is read the same way: what it holds
  under `system`, `messages`, `options` and `tools` is taken once from its
  own descriptors (`requestSlots`), and a place is given another value only
  where it can be written; make a change only where it can be made whole,
  and look at what a write answers (the parts and the Claude option
  together, the option put back where the parts took no new value; the
  messages before anything is recorded as taken out; a note that could not
  be added is counted, `notesNotAdded`). Whose request it is (session, agent, model) is
  read as the host reads it. None of these refuses a request, and these are
  all the places where the `context` hook touches one. Its limit is said with it: a
  message is what it holds of its own, what an object inherits is not
  looked at, and an update is an object of the host's own class, which a
  plugin cannot name. Never tell them by what a request message looks like
  alone, never take a message out for the ID it has alone (one that a hook
  before AZPR's changed may hold what is not the host's), and never take a
  message of the load's form for the host's in a session that did not read.
  Beyond that nothing proves who wrote a message, and the text of a load
  proves nothing more than its metadata: one of that form that someone
  posts after such a read is kept from the model like the host's, so its
  text reaches no answer.
- What AZPR cannot identify in a request stays as it is, and no request is
  refused for what it holds: a message with a load's ID that is not the
  load as the host builds it goes out as it is, and the stage record counts
  the request with those whose parts could not be told apart. AZPR does not
  police other plugins. A plugin's hook may add to a request, so no check
  of what a request holds could be complete, and a request refused for its
  form would fail every review on a host that builds requests another way.
  Say that and no more: AZPR's rules hold for a request as OpenCode builds
  it and for a tool's result as AZPR's tool returns it. What another
  plugin's hook makes of either, before or after AZPR's own, AZPR neither
  sees nor corrects, and a plugin in the same process can do anything. So
  `requestReview` asks for no proof of what a model saw: what the host
  wrote of instructions is no step of a turn and no one else's input,
  wherever it stands.
- `requestReview` fails a turn that received anyone else's message, wherever
  the turn's model was sent it: after the prompt, and between the turn
  before and the prompt (`since`; before a session's first prompt too). A
  turn that did not succeed fails by its own outcome first, which decides
  whether it is tried again. A message of the host passes only where it is
  one of those above, or the late result of the session's own tool call:
  the host's notice that a background command ended, which names a shell
  that a shell call of this same session reported as running, once for each
  such shell (`ownShellNotices`); that can only be with shell allowed, and
  it rests on the host's metadata, since nothing proves who wrote a message.
  Never accept a message that the model saw by its text or its form alone.
- A turn is the admitted prompt up to the first idle marker after it, and
  its answer is the last assistant message before that marker. A prompt
  becomes a message of the session only in the execution that takes it, and
  an execution leaves one marker however it ends, unless the host records
  that end as a shutdown, so that marker is the end of the execution that had
  the prompt and says how the turn ended; the session's own outcome is its
  latest execution's, which can be a later one. Never skip a marker: one
  before any answer is the turn's own end, not an earlier execution's. What
  follows the marker is no part of the turn; someone else's message there
  still fails it. The host records two ends as a shutdown: its own, which
  ends the run with the process, and that of a step that ended because a
  person declined one of its tool calls without a message (shell `ask` or
  `inherit`), after which the host runs on. The first marker after such a
  turn's prompt is then a later execution's, if one comes, and until then
  what the session does while the wait for it lasts counts to the turn (the
  requests and tool calls of whatever the host starts there, and what those
  return, which comment planning, for one, can hand to a later session of
  its page); the declined step carries the host's error, so no answer of
  such a turn is taken. A known limitation (docs/VALIDATION.md).
- A private session gets a model request, a retry and a tool only while a
  turn of it is open (`open` on the grant). A prompt opens it, and only
  while the call that sent it still waits for that turn (`turn`): one the
  host admits after that call ended, as when the inactivity watchdog stopped
  the stage meanwhile, is refused. The end of the wait for the session
  closes it. Neither end is the turn's own: the host may have begun an
  execution by itself before the prompt was admitted, whose request does not
  hold the prompt, and the wait also covers what the host starts in the
  session right after the turn, as when a background command that ended
  wakes it, whether the turn succeeded or failed. So before every request of
  a private session, read the session's messages (`turnState`): the request
  is the turn's only while the turn's prompt is among them and no idle
  marker follows it, which is the line `requestReview` draws afterwards. The
  prompt is known among them by the nonce it was sent with (`promptOf`),
  not by what a hook's event says. Before the prompt is a message, the
  request is refused and the turn is still to come; after the marker the
  turn has ended, the grant closes, and what the host does now gets nothing.
  Where the messages cannot be read, refuse: there is no weaker rule to fall
  back on. Never tell the end of a turn by time, by a hook the host may not
  run (its idle hook runs only when a turn succeeds), or by the wait alone.
  What follows a request (the request itself, a retry of it, the tool calls
  of its answer) needs a request of this very turn that was looked at so
  (`inTurn`), and a request of the turn that is refused, when it is
  prepared or when it is sent and whatever for (the turn, the session's
  agent or model, a look that failed, a dispatch that was not prepared),
  ends what an earlier one allowed; a summary or a generation that the host
  attempts beside the turn is none of its requests. What a hook reads of the host, it reads until the stage ends
  (`signal` on the grant), not the run: a stage that was stopped waits for
  its session to settle.
- What a session read is what its turns read, by the host's record and not
  by the time of a call: OpenCode names to a tool the assistant message that
  asked for the call, and a read counts for a finding only once the turn of
  that message is looked at and its answer taken (`readsBy` on the grant,
  `assistants` of the answer). So nothing is added to an answer that was
  taken: not a file the session reads later, and not one that a call read
  which names no message of the turn.

**Every mode runs one pipeline and differs only in its models.**
- `/pr-review`, `/pr-deep` and `/pr-quick` run the same stages with the same
  system prompts: reviewer passes, a duplicate check, a severity rating and
  comment planning. A mode's models are a list (`models.<mode>.reviewers`, one
  to four entries, which may repeat): pass i of every shard is a session of
  its own with entry i, so each position has a role of its own
  (`reviewerRoles` in `config.mjs`), and the first entry also checks duplicates
  and plans the comments. An empty list leaves `/pr-deep` or `/pr-quick` off;
  no mode ever falls back to another mode's models.
- A pass receives what any other pass receives: nothing says which pass it is
  or what another one found. Every pass of every shard shares one session pool
  (`workflow.parallelSessions`).
- The review's finding IDs are the runtime's: every answer numbers its own
  findings in its shard's range (the same for every pass, so no pass's input
  differs), and once all passes have answered the runtime numbers them by
  place and source (`byPlaceAndSource` in `review-work.mjs`). Where an
  answer's text (its finding fields, notes and gaps) names one of its own
  findings by an ID the answer gave it (not one the parser had to give), the
  runtime puts that finding's review ID in its place (`renameReferences`):
  until the merges are settled the ID the finding was given, afterwards the
  finding that stays, so that the rating, the comments and every reader see
  one set of IDs, each of a finding a person can see and exclude. Code stays
  as written: a fenced block (closed by a line of its fence character), an
  inline code span, and an ID written directly between quotes are quoted
  text, not references; underscore emphasis is not a name. Exact duplicates
  compare these texts with a finding's names of itself as itself, so copies
  that name different findings go to the duplicate check. Nothing a later
  stage or a person sees may depend on
  which session finished first or on an ID a model wrote: also not the tool
  observations and limitations the planner is given, which follow the order
  of their content. Nor on which session the host created first: a run
  records its stages in that order, so a receipt, its notices, a draft and
  the choice of the session that holds the report take them by their place in
  the pipeline (`stagesInOrder` in `attribution.mjs`). Only the sessions of
  one label keep the order they were recorded in: they ran one after another,
  and each continuation of a planning page counts its attempts anew.
- Add mode-specific or pass-specific instructions only with a measured
  benefit: deep-only prompt text and the split into a functional and a risk
  reviewer were both removed after runs showed no gain over repeating one
  reviewer prompt.
- Judge a change to a prompt, a stage or a check on models of the strength
  people review with. Never add prompt text, a check or a stage to steady a
  weaker model: that cost falls on every review, and the stronger models
  showed no need for it.

**No stage verifies a finding, and every review says so.**
- A reviewer checks each of its findings against source it read, since
  nothing does afterwards. The runtime checks only the form and source of a
  finding (fields, a location that exists at that commit, a file this
  session's own tools read); it never judges whether a defect is real.
  Passing findings are `REPORTED`, the rest `NEEDS_INFO`, and the review
  records `verification: "none"` and how its findings were produced (`method`).
- Never present findings as verified: the report and receipt state status,
  coverage and verification separately, and the comment disclosure line names
  the method. The review system prompts stay byte-identical unless a change to
  them is deliberate (a hash test locks them).
- Reviews saved by 0.4.x stay what they were: a review whose findings a
  verifier confirmed, or a quick review. `reviewMethod` in `comments.mjs` is
  the one place that tells the kinds apart, from the record alone; a record of
  no known kind offers nothing to comment on. Only the comment prompts keep a
  second wording (`<!-- azpr:verified -->` / `<!-- azpr:reviewers -->`), for
  planning the comments of a verified review, with a planner role of its own
  whose text is the one 0.4.6 had.
- A parsed answer without a usable review never makes a commentable COMPLETE,
  and zero findings never hide unreviewed files. Coverage is two numbers of
  the changed files: reviewed in at least one pass, and reviewed in every
  pass. A pass that fails costs depth, which the second number shows; only a
  file that no pass reviewed is unreviewed.

**Duplicates: the runtime removes identical records; a model merges repeated reports.**
- The runtime itself merges only records identical in every field; findings
  on the same lines stay separate.
- The duplicate check compares what different reviewer sessions reported on
  one side of one file, one session per such file, and only merges: every
  finding it does not merge stays reported, and a failed check keeps them
  all with a warning. Two findings are duplicates only with the same root
  cause and the same correction; the same kind of mistake at several places
  is several findings (one comment may still cover them: see Publication).
- A reviewer session files one finding per place that needs its own
  correction, so the runtime refuses a merge that would put two findings of
  one session into one finding, directly or through a third
  (`evaluateDuplicates` in `output.mjs`). That rule is the program's, not the
  prompt's: it holds whatever model checks.
- The finding that stays keeps its own text and records what it stands for
  (`alsoReported`, `sessions`). Whether several passes reported a finding is
  never shown to the rating.

**A blind rating sets the final severity.**
- After the duplicate check, the `rating` stage sets the severity of every
  reported finding from its text alone, with no tools and no earlier level,
  so that the findings of different reviewers stand on one scale. It runs
  with `models.<mode>.rater`, or with the first reviewer model where that is
  empty. `rater: false` turns it off: its role is not registered and the
  reviewers' levels stay.
- It is on by default because the measured models scaled severity very
  differently, and a rating that does not see the earlier level corrected a
  model that underrated its own findings while changing nothing for one that
  rated well, at a small cost (docs/VALIDATION.md; one run, so keep the
  default under review). A model that underrates lowers other models'
  findings too: the first reviewer model, or the named rater, should be one
  whose scale is sound.
- The rating only sets levels: a finding without a usable rating, and every
  finding of a failed rating session, keeps its reviewer's severity with a
  warning. It never drops, adds or rewrites a finding, and the reviewer's own
  level stays on record beside it (`reviewerSeverity`).
- Its input is finding text (`RATED_FIELDS` in `review-work.mjs`) plus the PR
  title and description: no PR identity, commits, file list, tool data,
  earlier level, session or count of reports.

**Keep useful work; degrade per item.**
- Answers that break the output contract get a correction turn in the same
  session (`workflow.repairAttempts`) listing concrete problems. After that,
  degrade the affected item (NEEDS_INFO, a merge left out, a level kept, a
  skipped comment) and keep the rest. Never discard a whole review for one bad
  item or one failed pass, and never invent a decision, evidence or a location.
- A handler whose work is given up says so (`abandoned`: comment planning,
  once another page has failed), and the stage asks it before every further
  turn: no correction and no follow-up is asked for work that will not be
  used, and the answer that is there is taken as the last. A stage tells its
  handler of a failure that no new session will be tried for (`failed`) the
  moment it knows, before it awaits anything: the cleanup of the failed
  session takes time in which another stage would still ask.
- Each stage's handler says which answers it can use (`usable`: a reviewer
  answer that reviewed a file or holds a usable finding, a duplicate check
  that returned its list of merges, a rating that rated a finding, a
  grouping or planning page that parsed). A turn after the first that fails,
  a correction turn or a follow-up, leaves the latest usable answer
  standing, and so does a correction turn whose answer is not usable; the
  items it would have repaired stay degraded, and the stage record names the
  turn (`repairFailure`, or the follow-up's outcome). Only a stopped run, and
  a context that overflowed where the handler can split its work
  (`splittable`: a reviewer shard of several files), keep their rules.
- A reviewer whose usable answer is PARTIAL with named unfinished work
  gets one follow-up turn in the same session, within the same budget; a
  follow-up that fails or gives no usable answer never replaces the answer it
  followed.
- Transient execution failures retry once in a new session; overflow splits the
  shard. Permanent failures and cancellations are not retried.
- An interrupted stream that OpenCode recovered by itself costs no new session:
  a step it retried (OpenCode 2.3.0 and later) or a continuation it queued
  (earlier hosts). Accept an errored assistant message only with the host's retry mark
  and a complete, successful final answer on the granted agent and model; a
  retried step's answer is the final message alone. The continuation message
  of the earlier hosts is known by its text alone, which anyone can post:
  accept it only on a host whose version names a release of that protocol
  (`retriesSteps` in `host.mjs`: 2.0.x to 2.2.x; a host that does not say
  its version, or says what is no release, is taken for a current one). The
  fragments of a continued answer belong to the answer that ended them:
  where the model answered once more afterwards (the notice of its own
  background command woke it), that later answer stands alone. A turn can
  hold several continued answers; recognise each, wherever it stands, and
  count every stream that was recovered (`continuedText`).
- Only a changed source commit makes a review STALE.

**Bounded, recoverable execution.**
- All AZPR Azure DevOps traffic shares the queue in `tool-queue.mjs` (concurrency and
  per-call timeout). Release slots in `finally`; never depend on a hook running.
- A tool call the host stops ends at once (read the call's `signal` once).
  Abort only the request that call alone waits for; a read the run's sessions
  share (a file, a recursive listing, the repository archive) goes on.
- Large PRs are handled by sharding, not by compaction: private sessions may not
  compact, and a compaction the host attempts in a reviewer's turn means "split
  this shard". A refused background summary (OpenCode's `compaction.background`, on
  by default from 2.3.1 on; `experimental.background_compaction` in earlier releases)
  ends nothing, so the turn's own failure decides its class.
- There is deliberately no default whole-run timeout and no per-stage step cap;
  see the roadmap's Deferred section before adding either.

**Authorization.**
- Private sessions are sessions of their own, never children of the
  conversation: OpenCode 2.3.0 and later hand a child's answers to its parent
  and wake the parent's own model. Create them at the conversation's location
  with `metadata.azpr`, and tie them to the conversation through AZPR's own
  records (run stages, a saved review's sessions), never the host's session
  tree.
- The conversation is the person's: AZPR leaves its notices there and changes
  nothing else, but the name of a conversation nobody named. It refuses
  nothing a person sends but two kinds of prompt: one that names one of
  AZPR's private agents (they cannot be mentioned or delegated to, see
  below), and one of AZPR's own commands that arrives as a prompt (below). A
  conversation nobody named yet
  (`isUntitledSession` in `host.mjs`) gets a name when a check or a review
  starts in it, made of the PR's number and repository from the URL the
  person typed (`conversationTitle`): no model runs there to name it, and the
  session list would go on calling it "New session". Never put text from the
  PR into a title, and never let a command wait for the update or fail on
  it.
- OpenCode has no rename that applies only to an unnamed conversation, and
  nothing ties a rename it reports to the call that made it: a read followed
  by a write can replace a name given in between, and no plugin can rule
  that out. So AZPR's own name must give way wherever it can tell, and also
  where it cannot (`nameConversation` in `runtime.mjs`). Name a conversation
  only where the host reports renames (`session.renamed`), and follow them
  from before the read. A rename reported during the read stops the naming.
  A report with other words than AZPR wrote is someone else's name; one with
  AZPR's words that follows it may be the write that replaced it, so that
  name is written back: in doubt, the name that is not AZPR's stays. Write
  back the last name reported, after the host has reported no name of that
  conversation for a moment, and never AZPR's own words: once AZPR has
  written a name back, a report of its first words is that first write
  reported late, or someone's choice, and neither is a name to restore. Keep
  the watch open for a while after the host answered AZPR's last write,
  never close it while a write is under way or due, bound the number of
  writes, let one watch name a conversation at a time, and let unloading end
  what is under way first. No read of the feed may be left without a
  handler: a feed that fails has ended. A host without that feed names
  nothing, and a name that is not AZPR's own is never recorded. Say this
  limit where the naming is described; never write "never replaced".
- One of AZPR's commands can reach an ordinary conversation as text: the
  terminal UI submits a startup prompt (`opencode --prompt`) before it has
  loaded the commands, with OpenCode 2.4.0 and 2.4.1 nearly always, and then
  often to the host's built-in free model. No command ran, and a model would
  be sent the PR URL and the person's context. The `prompt` hook refuses such
  a prompt and leaves a notice in the conversation that says what happened.
  Refuse only a prompt that begins with one of AZPR's own command names
  followed by a blank or the end, at its very first character as OpenCode's
  prompt box requires of a command: one that mentions a command, begins with
  another name, or has the command after indentation or a blank line (an
  example, say) is the person's own. The names are every slash command AZPR
  has, whichever part registers it (`COMMAND_NAMES` in `config.mjs`). The
  rule and its words are one (`strayCommand`, `strayNotice`), and it needs
  no settings: a process that has no runtime (before a first setup, with
  settings that cannot be used, with settings of 0.4.x waiting for their
  update) refuses such a prompt too, in a hook that `setup.mjs` registers
  with the commands that say that AZPR is not ready and that stands aside
  once the runtime is loaded, whose own hook also knows the private
  sessions. Switched off (`enabled: false`), the server part registers
  nothing, also not this hook. The
  refusal has a cost that the documentation states (the terminal UI tries
  again in new conversations, which stay empty); never widen it to anything
  else a person types.
- Only explicit commands start private sessions, and the comment step a
  COMPLETE review hands on when `afterReview` or the review command's flag
  (`--preview`, `--publish`) asks for it; that step is a run of its own with a
  STARTED notice and a receipt. `afterReview` defaults to `preview`, which
  posts nothing; publication is never a default. Every private prompt is the
  exact runtime-pending text with a fresh nonce; private agents cannot be
  mentioned, delegated, compacted or used for auxiliary requests.
- A notice never wakes a model: leave it in the session's inbox with
  `resume: false`, steered, as the host leaves its own notices about
  background shells. The host hands the steered items that wait to the
  session's own model together with its next input, in one request; it gives
  each queued item a turn of its own, so never queue a notice.
- Settings are read once; a changed file blocks new runs only. Hooks check the
  grant, not files or catalogs. A first setup is that one read, not an
  exception to it: a process that found no usable settings has read none, so
  it loads them when a save of its own setup makes them usable (the text
  that save replaced could not be used, it wrote something, and they can be
  used after it). It tries again with that setup's next save when loading
  them failed, but only what this setup wrote is its own to load, the
  settings text and the token (as a digest, `pairWith`). What a save leaves
  is said from what it wrote, never from another look at the files, which
  could be at another writer's work; whether the settings could be used
  before it and which token went with them come from one look at the token
  file. One save has the turn at a time, whichever way it comes in (the
  RPC or `/pr-setup` with options), until the load that follows it has
  ended. Compare both with the files before the load, and afterwards require that the runtime read what the files hold
  and that they hold what was saved; give way when anything else has
  written either since. A load that answers nothing (settings switched off meanwhile) is
  no load. Settings
  that anything else made usable (another process's setup, an editor, a
  tool) are read after a restart, as always, also by a process that had
  none, whatever its own setup saves afterwards; and settings that are in
  use wait for the restart, which setup says where the change is made.
- Before that read, loading AZPR writes the settings a valid file leaves out
  into it, at the defaults validation assumes anyway (`SETTING_DEFAULTS` in
  `config.mjs`; the settings example and schema must match it), so a new
  setting shows where its user edits the others. Give every new setting a
  default there. The completion never changes how a file behaves, never
  touches a file that is invalid, disabled, a symbolic link or not safely
  replaceable, replaces the file as `/pr-setup` does (atomic, owner-only,
  under the setup lock) and never fails a load: a file it cannot complete is
  used as it is, and `/pr-check` says what it leaves out. The lock keeps
  AZPR's own writers apart, not a person's editor: compare the file with the
  text that was read once more, right before the new text replaces it, and
  give way when it changed. Loads that happen together wait for the one that
  writes, so each reads the finished file; a load that stopped waiting accepts
  the completed text when it appears later (the preflight compares with the
  completion of what it loaded), so its commands are never refused over
  defaults another load wrote. Any other difference still blocks new runs.
- Settings of AZPR 0.4.x (`version: 2`) are no settings of this version: a
  process that finds them has none, and its commands say so. Nothing rewrites
  such a file but the update a person confirms in `/pr-setup`: in the terminal
  UI in a list whose first row keeps the file, elsewhere with
  `/pr-setup --migrate <word>`. The word is a keyed digest of the text the
  update replaces and the text it writes (`migrationOf` in `setup.mjs`, with a
  key of the process), so a confirmation holds only for the change that was
  shown: a file that changed since, or a restart, needs another look. No
  other option, save or load implies that consent: not the completion of
  missing settings, not the options of a first setup, not the installer,
  which carries such a file over byte for byte. What the update writes is
  `migrateSettings` in `config.mjs`, a pure function that loses and invents no
  value and repairs nothing: a value 0.4.x refused in a slot that still
  exists stays where it goes now, and so does a key it does not know, for the
  settings check to name. What it shows names every change in behaviour, also those nobody
  asked for (a rating that now runs, automatic publication that now posts
  findings no verifier confirmed). A version-2 file with a fault is no
  exception: the update comes first and the repair after it, since a repair
  that rewrote the file in this version's layout would convert it unseen.
- The admission hooks treat as private every session that one of AZPR's
  roles runs, also a role of 0.4.x that no longer exists, and every session
  this process created or that a saved review or a session record names
  (`privateSession` in `runtime.mjs`): such a session runs nothing without
  the grant of a command that is under way, and no tool call either
  (`execute.before`), whatever agent the host names. A process without
  usable settings (settings of 0.4.x waiting for their update among them)
  loads no runtime and registers no agent, no tool and no hook but the one
  that refuses one of AZPR's commands sent as a prompt (above): a session an
  earlier process created runs there as it would without AZPR, with nothing
  of AZPR's and no token, and the admission hooks come with the runtime.
- Pin private agent definitions at first use and refuse later host changes.
- Shell for private roles follows the `shell` setting (default deny), enforced
  through the `permission` hook and by hiding the tool. Native edit, write,
  patch, delegation, web, question, session/model control and CodeMode execute
  stay denied. Allowed shell has real host authority; never call it a sandbox.
- `/pr-comment` and `/pr-stop` act only within the caller's conversation (or a
  session of that review). A `/pr-comment` command without a review ID acts on
  the conversation's current review (completed or used there last; in a
  review's own session, that review), and its STARTED notice and receipt name
  the review and its PR, so a wrong pick shows before and after it acts. Save
  the choice when it is made, also for a command that answers at once
  (`--show`, unchanged adjustments): a choice kept only in memory lets a
  command after a restart publish to another PR. A run that ends makes its
  review the current one next to its receipt, after the cleanup of its
  sessions: a choice made before a wait can be overtaken by a command typed
  meanwhile, and the receipt that arrives last then names another review
  than commands act on. Every write of a review's record goes through its
  queue in `store.mjs`, and a save reads the review when it starts, so
  overlapping commands never leave an older choice on disk. A command that
  starts a run registers the run before its first await, so it never waits
  for that save.

**Publication is idempotent.**
- Recheck the PR's head before writing; skip existing markers; save each
  result immediately; read markers back. Posting a saved preview runs no
  model: it reads neither the model catalog nor the private agents. Re-running is always safe. The PR's
  status stops nothing: a completed or abandoned PR (merged before its review
  was commented on, say) is checked, reviewed and commented on like an active
  one, and the check and the publication receipt name that status.
- Automatic publication (`afterReview: publish` or `--publish` after the PR
  URL) follows only a COMPLETE review with findings to comment on that nothing
  stopped. It posts item by item: an item whose text has an `@<…>` mention,
  an image, HTML that embeds content, runs a script or hides text, or a `javascript:`,
  `vbscript:`, `data:` or `file://` link (mentions and script links also after
  decoding escapes and character references, script links also without tabs
  and line breaks) waits for a person, and the
  receipt names it; ordinary links are posted, and literal code is skipped
  (except for mentions) only where every reading of the Markdown agrees. A
  plan that would post only a
  repeated summary (every finding skipped as already discussed on the PR) is
  `NOTHING_TO_POST`. Its checks are deterministic and prefer a false alarm;
  never relax them to model judgment. Commands the user types keep their
  behavior.
- Inline markers are stable (PR, path, normalized anchor, ordinal); do not put a
  review ID or model wording into them. A comment for several places has a
  marker of its own instead, which also takes its other places (see below).
- A person's adjustments (`/pr-comment [review-id] --exclude`, `--severity`,
  `--reset`) change only the findings handed to comment planning, never the
  review record or a prompt file; the planner input carries `adjustments` only
  when some exist, so unadjusted reviews plan exactly as before. A review
  adjusted once is posted only from a preview planned after its latest
  adjustment (an adjustment drops the earlier preview in the same save) and is
  neither adjusted nor planned again once its publication started. That save
  and the new preview's save must succeed; never let a failed save report an
  adjustment as applied. Text the runtime renders that names an excluded
  finding, or a finding merged into one (through every link of a chain),
  holds publication. Items an earlier
  publication already put on the
  PR are skipped as always; its receipt names those whose text differs, since
  posted comments are never changed.
- Comment planning pages run side by side, so nothing a page sees or produces
  may depend on which page finishes first: only the first page writes the
  summary note, each page keeps its own continuation state and evidence, and
  pages are assembled in page order (ordinals follow page order).
- One defect made at several places is several findings and may be one
  comment. Whether findings are the same defect is the planner's judgment (a
  grouping pass before the pages, then the page that writes the comment).
  Where the comment stands and what it lists is the runtime's: a comment for
  one finding stands in that finding's own file (a quote of another file is
  another place, sent back to the planner), a comment for several places at
  the finding whose lines hold the anchor, and under the planner's text the other
  findings' own locations (`renderOtherPlaces`), never locations a model
  wrote, as a plain list (nothing collapsed or linked: automatic publication
  holds text that hides). Settle the groups before the pages are made, so
  that no page depends on another; a grouping pass that fails costs only the
  grouping, and a stopped run starts no page. The review keeps every finding:
  each place keeps its row in the summary index, its ID and its adjustments.
  The list is read back (`listedPlaces`) only to tell a later plan which
  places a thread says it covers (`alsoAt`), as the start of a thread's text
  tells it: nothing is posted or skipped because of it. Read it only in the
  form the runtime writes: in the comment that opened a thread on a file and
  carries AZPR's marker, under the list's own heading, in rows of a place and
  a finding ID, followed by nothing but the attribution and the comment's two
  markers; a reply that quotes such a comment says nothing about its thread,
  and a planner's text that writes the heading is refused. Change
  `renderOtherPlaces`, the form of `commentAttribution` and `listedPlaces`
  together (a test reads back what the first two write), and list only a
  place that reads back as it was written (`listablePlace`).
  The runtime checks only the rules of a combination (`repeatProblems` and
  the page: one severity, high or medium, different lines that changed files
  have in the HEAD text the runtime read, an anchor found in that text,
  within the file and on the lines of exactly one member); it never combines
  findings by itself, never chooses between two places an anchor touches and
  never proposes a group from how alike two texts are. The grouping pass has
  one answer and reads its findings inline: no continuation, no reference it
  would need a tool for; it is asked only about findings that could share a
  page with another one (`pairable`), and no file is read ahead of the pages
  for any other. The files it needs are read a few at a time, like the
  pages'.
- A comment for several places is a comment of its own, so it has a marker
  of its own (`sharedMarker`: PR, path, normalized anchor, the other places,
  ordinal). Publication, its ledger and its attempt records know it by that
  marker alone and skip it only when that marker is on the PR: the comment
  found there is then this very comment, and a receipt never has to work out
  what a posted comment covers. Never infer that from a comment's text, a
  thread's position or an attempt's record, and never give publication a
  second marker to go by. A comment for several places and a comment for
  one place do not find each other by marker, so planning keeps them off
  each other's quoted lines (`occupiedLines` in `comments.mjs`, with the
  markers the PR had when planning began; the prompt says so too): the
  shared comment carries a second marker for this, made of its path and
  quoted lines only (`linesMarker`), which nothing but that rule reads.

**Persistence and privacy.**
- Completed reviews, plans and ledgers persist under the private state directory
  (owner-only permissions, newest 20). Clean only stale, unreferenced data.
- A model reads a large private value in pages, with the host's native read,
  one row per line. A row must be one that read returns whole: OpenCode cuts a
  longer line and says so only inside the line (`HOST_READ_LINE_CHARACTERS` in
  `host.mjs`). Measure a row as it is written, after escaping (`pageRows` in
  `comment-data.mjs`), and never rely on the prompt to work around a cut row.
  A model reads the pages by itself, row by row, so the layout of a pages
  file must never change under it. This version's pages are therefore a
  file of their own name beside the value's object (`.rows.jsonl`), in one
  layout for one text (`pagesOf`): a pages file is right exactly when it is
  that, by its bytes, and whoever writes it writes the same. A file of the name that
  versions before 0.5.1 gave their pages (`.pages.jsonl`, with rows the
  host's read cuts) is never changed, since a process of such a version may
  be reading it. Such a version hands that name out for every object it
  finds when it opens a store, and writes no pages for them: so a value
  that has no file of that name gets one, before its object is written or
  written again, these rows under that name too, as a link, which is there
  whole or not at all (`settlePages`). A review that this version saved can
  then be planned after going back to such a version. That rests on the
  link having been made: where it cannot be (a file system without hard
  links, something else under that name) the value is ready all the same,
  and going back is provided for only as far as the rows are there under
  the earlier name; say so wherever going back is promised. A version that changes the layout gives its pages
  another name (a test holds the layout).
  A value is ready when its object is what its name says and this version's
  pages are there as it writes them. It is made ready when it is put, from
  the text in hand, at every put; and when a reference that a review saved
  is handed to a model, from its files, each time (`handed`, `holds`): an
  earlier version, or a process that was cut off, may have written them.
  The reference that is handed out names this version's pages, whatever the
  saved one named; the one place that hands a saved review's references to
  a model lists them so, a few values at a time and each value once
  (`observationIndex`). The runtime's own reads need no pages (`read`, a few
  at a time where a list is read: `anchorObservations`). A list that its run
  no longer wants (the run was stopped, a planning page failed) is not
  looked at further and not written; a page whose check of its comments was
  cut short so is taken as it is, since a quote that was not found then says
  nothing, and no correction is asked for a plan that is given up. An
  observation whose arguments cannot be stored is left out of the list like
  one whose output cannot be handed out.
  Between a put and the end of its run a value is what the put made it, and
  is not looked at again when a reference is handed on within the run (the
  retry of a stage, the continuation of a planning page), nor put again
  where the run puts the same value once more (`putOnce`, for a run's
  payloads and for what its sessions' tools returned). Nothing that writes
  those files meanwhile makes them wrong, for two reasons that are not one:
  an earlier version creates its files exclusively, the object under the
  very name this version uses and the pages under its own, so it writes
  into no file that is there; and this version, also in another process
  that works on the same saved review, replaces a file in one step with the
  same content.
  This process does not clean a run's data up before its command has ended.
  Another process that shares the state directory can (it knows only its own
  commands, a known limitation); the command whose data is gone then fails,
  which no look before a reference is handed on would cure.
  Keep no mark that says a store, or a value of a saved review, is ready.
  An object is what its name says by its bytes, not by the text they decode
  to, and a value is the text a file can hold (no lone surrogate), so that
  object and pages are one value. Derive pages only from such an object;
  where the object is damaged or gone and pages are complete, of this
  version or of an earlier one, write the object again from them, after
  its pages, as a put does. Replace a file in one step. A value that cannot be made ready is not handed out,
  and the others are not held back for it: opening a store looks at its
  directory alone and never fails for one value. A file that a reviewer
  reads in several windows is one observation, known by its tool, commit
  and path, and saved once.
- OpenCode lists every private session like a conversation. When a run ends,
  delete its sessions except the one holding the report or draft (a comment
  run keeps none; all stay while debugging or after an unconfirmed abort).
  Choose the sessions to delete the moment the run ends, before any await:
  from then on a command typed in one is refused. Put every session on record
  before deleting it, those to delete apart from those kept (the review's
  record with `closingSessions`; for an unfinished review the run's own
  record and a retry record; a retry record for a session OpenCode creates
  after its stage was cancelled), and remove a review's record only after
  its sessions were dealt with, so that a process ending during a cleanup
  forgets none and the next one knows which are still to go.
- A session leaves the records only when it is gone: a confirmed deletion, or
  OpenCode's `Session.NotFoundError`. What is still to be deleted outside a
  saved review is on a retry record, apart from the sessions a run keeps on
  purpose; it takes no commands, also after a restart, and a background pass
  tries it again after every run and at load, leaving a run whose command
  has not ended to its own cleanup. Deal with a run's records together, so
  that neither list replaces the other, and never make a receipt wait for a
  pass.
- Never delete a session a command needs: the one it answers in, until its
  last notice is out, and its run's conversation and stage sessions. A session
  that is still there after the cleanup is its review's own again. A deletion
  OpenCode never answered may still be carried out: that session stays among
  `closingSessions` for good, closed to commands also after a restart, and
  goes with its review.
- Never evict a review, or an unfinished run's record of kept sessions, before
  the command working on it has ended: its run, a comment run's last steps,
  and after a review its cleanup, its receipt and the start of the comment
  step it hands on. A save of an evicted review must not bring its record back.
- Diagnostics are opt-in and never record reasoning, headers or provider
  configuration.

**The terminal panel reads; it sends only the command a person picks.**
- The panel of the package's terminal part (`src/tui-model.mjs`,
  `src/tui-actions.mjs` and `src/tui-view.jsx`, compiled to `src/tui.js`)
  shows what the runtime already produced: AZPR's
  notices in the conversation, the report queued to a review session and the
  sessions' `metadata.azpr`. It sends no prompt, makes no Azure DevOps
  request, reads no settings file and keeps no preference of its own. The one
  setting meant for it (`terminalPanel`) reaches it in the metadata of the
  runtime's notices, sent only when it is not the default; a notice that
  offers a next step carries that offer there as well (`azpr.next`), and
  every other notice stays as it was.
- The one thing the panel sends is the command of a step a person picked,
  with a click or with its key while the panel has the keyboard:
  `/pr-comment` for what a review or a preview offers, and `/pr-stop` for
  the run under way. Nothing is sent by itself: not on a notice, not on a
  timer. The command is made in `tui-actions.mjs`, which imports nothing so
  that its dialogs are tested with scripted answers, and is sent in one place
  of the view, with the host's `client.session.command`, to the session on
  screen. The server part takes it like a typed one: its checks, its notices
  and its receipt are the same. Add a step only for one a receipt or a
  STARTED notice names, and none that sends another command without changing
  this rule and the test that holds it (`tests/release.test.mjs`).
- What can be picked is the runtime's word, never worked out from a document:
  `previewActions` (`comments.mjs`) writes it into the metadata of the notice
  that offers it (a preview's receipt, the saved preview shown again, the
  receipt of a COMPLETE review that no preview follows by itself), and
  `nextOf` (`tui-model.mjs`) checks every value before a command is made of
  it: IDs by their form, levels by name, the review against the one shown.
  Anything unexpected offers nothing, and only the notice that happened last
  offers.
- A run that starts says with its STARTED notice that it can be stopped
  (`azpr.next.stop`, the run's ID, written where the notice is: `launch` in
  `runtime.mjs`), and `stopOf` holds that to its form and to the run the
  very notice starts. That notice offers from then until the run has a
  receipt, whatever progress the run reports in between, and offers nothing
  but stopping; a preview's steps are gone once a run starts. `/pr-stop`
  names its run and carries no word: the runtime stops only a run of the
  caller's conversation that is still under way, so a step that arrives
  late stops nothing, and no other run. What the runtime answers to a stop
  is not the run's end; the receipt is.
- An offer belongs to the document its notice encloses: it is true of the
  review as that document was rendered. Read both before anything is
  awaited, or check first that the review's preview is still the one that
  was rendered (`previewState` in `runtime.mjs`: the plan, the adjustments,
  and what publication has recorded, which every publication writes anew)
  and await nothing between that check and the receipt's text and offer:
  whatever is saved then is saved after them.
  Under a report a preview is planned, never posted,
  and only while nothing has acted on that review since; a preview offers
  what is done with that preview. The command locks are released before a
  run's sessions are cleaned up: a preview that another command adjusted,
  planned again or posted before its receipt is neither enclosed nor
  offered. Its run ends with a receipt of a status of its own (`REPLACED`),
  which does not make its review the current one, and which the panel takes
  for the end of that run but not for what happened last: the other
  command's receipt is, wherever it was answered. `buildPanel` holds an
  offer to its kind of document as well.
- A step's command names its review and, with `--seen`, what that review's
  comments were when the step was offered (`commentToken` in `comments.mjs`:
  the saved preview and the adjustments), so that what is on screen is what
  is acted on. A panel knows only what its own conversation was told; a
  command typed in a review's own session, or another client, changes the
  review without a notice there. The runtime refuses a command whose word
  is no longer the review's: when it arrives, before the review becomes
  the current one (a step refused there changes nothing, also not which
  review the next command without an ID acts on), and again under the
  comment lock, before anything is planned, saved or posted. Make the word of
  nothing but what the review's record holds, and never of whether posting
  began: what was shown can be posted again. A typed command carries none
  and keeps its behaviour. Posting asks first, in a list whose first row
  posts nothing, and stopping asks first, in a list whose first row lets the
  run go on. What is typed into such a question finds a row by the beginning
  of its title (`byBeginning`), not as the host searches (a letter anywhere
  in a title, the best match selected): the key that opened the question,
  pressed once more than meant, is typed into it and must leave no row to
  take. An adjustment gives both lists in full, since each replaces the
  saved one.
  One action runs at a time, and after `stop()` nothing is asked or sent,
  whatever answer arrives. An answer counts only for what the panel still
  offers (`still`): the same panel, drawn and the one the host shows in that
  session, with the same notice offering (`offer`, the notice's ID). A
  dialog stays open for any time, so check it whenever a dialog answers,
  before another one is opened, and right before a command is sent; say
  when nothing was sent, and never post a preview that was planned again
  while its question was open.
- The steps are one row at the panel's foot, on the panel's own ground under
  a line, in place while the text scrolls: where reading ends. A label that
  ends in "…" asks before anything is sent, and one that does not is sent at
  once. A key is drawn in its colour only while it works, which is while the
  panel has the keyboard. A click on a step is a button pressed: stop its
  mouse-down event, since the host gives a panel the keyboard on it, and a
  key of the panel would then act on what a person means to type. The
  release that ends a selection of text is no click (`clicked` in
  `tui-view.jsx`): OpenTUI sends it to whatever lies under the pointer,
  marked as dragging, and a step, a session's row or `close` there must not
  act on it. A click on a step is its press and its release on one step of
  one offer, with the pointer still on that step: the row can come to show
  another notice's steps while the button is held, and OpenTUI sends the
  release of a button that was dragged away to the element it was pressed
  on. A press is one gesture's: end it with every other press or release
  the panel sees (`forget`), so that a gesture that was given up never makes
  a later release a click. The host can also make a release up: OpenTUI 0.9
  (OpenCode 2.4.0 and later) ends a drag whose release it never saw at the
  next press of the button, anywhere and any time later, with a release at
  the place of the pointer's last movement, which the element that was
  pressed receives before anything sees that press, and nothing in that
  event tells it from a real one. So a release is a click, on a step, a
  session's row or `close`, only within a moment of the pointer's last
  movement with the button down (`hold` and `MOVED_MS` in `tui-view.jsx`);
  without a movement the host makes none up, so a button held still is a
  click for any time. Only a press of the left button begins a gesture: the
  host ends a lost one at the next left press, so another button must not
  forget the movement. And only a movement with the left button is one of
  the gesture: the host sends a drag with another button to whatever is
  under the pointer, also to an element that a lost gesture still holds.
  That moment is measured on two clocks, and a release
  is a click only where both call it a moment: the time of day can be set
  back, and the steady clock may stand still while the machine sleeps. A
  click that is refused can be made again; one that is made up cannot be
  taken back. An event carries no time of its own, so the moment is that
  between handling the two events: where the terminal's input waited, a
  made-up release can follow its movement at once. Say that limit where the
  rule is described.
  Draw the steps from their names, as the session
  rows are drawn from their IDs, so that each keeps its element while the
  panel's content is worked out again (with every notice and every answer
  of the server; often while a run is under way): an element made anew is
  not under the pointer until the next frame, and a press or a release in
  that moment goes nowhere.
  What
  applies a list of adjustments stays in view however long the list is (the
  foot of its dialog), and is also the list's last row, for a host that
  draws no such foot. The foot's action closes its dialog itself, since the
  host does not: let it act once, and only while that list is the dialog
  that is open.
- A row of a session says `running` while the host says so, then what the
  run's receipt says of its stage, and `finished` until a receipt names it:
  never the host's word for a session at rest, which reads like a fault for
  a reviewer that has answered.
- `/pr-panel` is the terminal part's only slash command. Add another only for
  what neither a setting nor OpenCode's own UI (its session list, say)
  already does; setup is reached through the server part's `/pr-setup` and
  an entry of the command palette.
- What names a session or a status is the runtime's own text only: a
  receipt's lines before the report or preview it encloses, whose text a
  model wrote. A session is listed, and a report read from it, only when its
  own `metadata.azpr` says that it belongs to that run and conversation (a
  session of 0.4.0 or earlier, which has none: when it is a child of the
  conversation). Look a session up before reading anything it holds: an
  inbox is read only of a session that proved to be ours, or of the
  conversation that the session on screen itself names. A run's notice that
  is neither its start, its progress nor its receipt (a status word followed
  by `;`, a line break or the end) changes nothing shown, and does not make
  its run the current one.
- What the panel is about is what happened last: a run that started,
  progressed or ended, or a saved preview shown again, which names its
  review (`/pr-comment <review> --show` makes that review the current one,
  so the panel shows that review's status and sessions). A status never
  stands above another review's document: the report of the session on
  screen is shown only for the review shown, or while nothing is known of
  any run yet. A receipt that encloses nothing (a comment run that failed
  before it had a preview) is no document: the review's report stays.
- The panel in a review's own session reads the conversation's notices and
  those of commands typed in that session, which the runtime answers there.
  The host has another session's notices only while it is on screen or in a
  tab: read them from the server, the inbox first and then the delivered
  messages (a notice is delivered once its conversation's model runs, and
  one delivered between the two reads must be in one of them), and keep with
  the answer what arrives while it is under way. From the moment a session's
  notices are asked for, every notice the host reports for it is kept,
  whatever becomes of the requests; what the inbox answered is kept when the
  messages cannot be read; a session is not let go, however many others are
  read meanwhile, while a read of it is under way, and such a session takes
  no place among the ones read last, so that what was read stays held while
  other reads wait; one lookup of a session, or its wait for the next
  attempt, exists at a time however often the panel asks. What was asked before a reconnection is dropped when it answers. This reading lives in
  `createReader` (`tui-model.mjs`), not in the view, so that its order and
  its races are tested with delayed answers; keep it there.
- The Markdown shown is the Markdown saved: only the cells of the summary
  table are decoded, each character escaped so that it stays literal as on
  the PR, and only AZPR's marker lines are left out. Both only where the
  runtime wrote them (a marker alone between blank lines; a table that
  begins after a blank line with the summary's header and delimiter row),
  never inside code, fenced or in a span over several lines. A preview on
  screen must be the preview that publication posts.
- A notice ends its block at the block's closing tag, so the runtime writes
  that tag inside the block in an escaped form (`enclose` in
  `attribution.mjs`), and the panel takes exactly that off again (`disclose`
  in `tui-model.mjs`). The two are each other's inverse for any text,
  including text that already holds the escaped form: change them together,
  and write every block through `enclose`.
- A session counts as deleted only when the server said so, and then it is
  gone whatever the host still holds of it and whatever answers later, until
  the server reconnects; a request that failed is tried again.
- A step the panel takes a moment after it mounted (handing the keyboard
  back, withdrawing) acts only while that panel is still the one open in
  that session, and no timer outlives the panel.
- The text of notices and receipts is therefore an interface. Change it
  together with `tui-model.mjs`, whose tests run against `renderReceipt` and
  against the notices of a whole run.
- `src/tui.js` is generated: edit `tui-view.jsx`, run `npm run build:tui` and
  commit both. OpenCode 2.3.x compiles no JSX of an installed package (2.4.0
  and later do), so the package ships the compiled file, which loads on all of
  them (see the roadmap's Deferred section before shipping the source
  instead); keep it free of JSX and importing only what
  the host provides (`@opentui/solid`, `@opentui/core`, `solid-js`). The
  compiler stays a development dependency at an exact version: the package
  has no dependency, no lifecycle script and no build at installation.
- A panel that opens by itself never keeps the keyboard, never takes a screen
  too narrow for two panes and never replaces another plugin's panel; where it
  cannot open like that, it says that something is ready.
- The host drops the data of sessions that are neither on screen nor in a tab:
  read another session's inbox from the server, not from the host's cache.

**Setup has one writer; its dialogs only ask.**
- `/pr-setup` is the one way to set AZPR up: with options, or in the terminal
  UI with dialogs, which open when the command's notice arrives marked
  `metadata.azpr.setup` in the session on screen. Both end in `setup.mjs`,
  which checks every value, is the only writer of the settings file and the
  token file, and is the only one to ask Azure DevOps whether a token works.
- What setup can set is one table (`ROWS` in `setup.mjs`): a row reads, shows,
  accepts and writes its value, and its option of `/pr-setup` and its dialog
  are the same row. Give a setting people change a row; leave the rest to the
  settings file. `shell` and `azure.verifyTls` get none. A row says what it
  is for where its name does not: `hint` in the list, where the host shows it
  between the name and the value and cuts what does not fit, so a few words
  only; `prompt` and `variantPrompt` in the search line of its dialogs, where
  there is room (the deep model: a stronger model, or a higher variant).
- A mode's models are one row whose value is a list (`reviewersFrom` in
  `setup.mjs`): one model alone stands for the mode's usual number of passes
  (`USUAL_PASSES`: two for `/pr-review` and `/pr-deep`, one for `/pr-quick`),
  `MODEL*N` for N passes, and entries separated by commas for different
  models. A first setup asks for one model and writes it twice for
  `/pr-review` and once for `/pr-quick`. The dialog asks for one model first
  and then for the passes, in a list whose first row takes what is shown.
- The dialogs (`src/tui-setup.mjs`, which imports nothing so that its order
  is tested with scripted answers, and the token field in `tui-view.jsx`) use
  the host's own dialogs and hand every answer to the server part over the
  plugin's RPC. They read and write no file, contact neither Azure DevOps nor
  a model, run no command and store nothing.
- A token is typed into AZPR's own field, which takes keys and pastes itself
  and draws only bullets and a count: the host's text prompt shows what is
  typed. The terminal part passes it on once and keeps it nowhere, not in a
  toast, a dialog text, a log or a store. The server part writes it to the
  token file in one step, owner-only, and empties `azure.pat`. Settings name
  that file and settings can be wrong: an existing file is replaced only when
  it is a regular file of the user's own that is empty or holds one token
  (one word of letters, digits, `-` and `_` as long as a token; a line of
  JSON or a KEY=VALUE pair is something else). Setup takes as a token only
  what passes that same test (`TOKEN_WORD`), so that it can replace what it
  wrote.
- A saved token is the one the settings name (`azure.patFile`, else
  `azure.pat`), as the runtime reads it; the default PAT file is none unless
  they name it. It is sent only for the organization it was saved for, like
  every other use of the PAT, and only the way the saved settings send it:
  a check for another organization, or through a proxy or with a CA file
  that the call names, needs a token that was entered with it (a proxy and
  a CA file of the caller's choosing could read a token).
- Organization and token change in one step, the write of the settings
  file. A save names the organization its token was checked for, which must
  still be the one in the settings. A token of the organization the settings
  named already replaces the token file they name. Every other token gets a
  file that did not exist (`createTokenFile`: `pat-<organization>`, or that
  name with the first free number, beside the file the settings name or in
  AZPR's directory; the name is taken in one step that refuses an existing
  one), which the settings name in the same write: a first setup's, another
  organization's, and one for settings that name the default PAT file
  (`azpr/pat`). Setup overwrites no file but the one these settings name for
  this organization: several settings files of one person share AZPR's
  directory and the default PAT file, their setup locks are not one lock,
  and a file's name proves nothing about whose it is. The RPC changes the
  organization of settings that name a token (usable at the moment or not;
  also from no organization to one) only together with a token of the new
  one. Whoever reads the settings and
  then the file they name must have a pair that belongs together, also
  during a save and after one that failed; a file a save made is removed
  when its settings are not written, and no other file is. A write that
  took place is not reported as failed for what could not be cleaned up
  after it (a temporary file, the lock): a caller would undo what belongs
  to it. The earlier token's file is left to its
  person, who is told where it is. (The options of `/pr-setup` keep their
  behaviour: there the person keeps the PAT file.)
- Several server parts share one settings file (one per project directory,
  and other processes). The token file and the settings that name it are
  therefore written under the setup lock, the token first, after the
  settings were compared once more under the lock with what the answers were
  checked against; a save that finds the lock held writes neither.
- The dialogs of one setup talk to one server part: the place is fixed when
  they open, since the session on screen can change while they are open.
- What setup reports as waiting for a restart is the loaded runtime's own
  answer (`settingsDrift` in `runtime.mjs`, the rule of its preflight), so
  that the two never disagree; do not compare texts in `setup.mjs`.
- A process without usable settings registers commands that only say so.
  What the command list says of them must hold for every reason a process
  has none: no settings yet, settings that cannot be used, and settings that
  were saved elsewhere since (another project directory's setup) and wait
  for a restart. It says that AZPR is not ready here and names `/pr-setup`,
  which tells which it is.
  They are AZPR's own: never register one under a name that another plugin
  has taken meanwhile, since adding a command replaces the one of that name.
  A plugin can take a name at any moment, so list the commands again right
  before registering them, at startup as well; where the list cannot be
  read, register none (what was known earlier is no longer known) and try
  again with the next `/pr-setup` or save. A load and putting them back run
  one after another, never interleaved (`inLane` in `setup.mjs`): a load
  must not find them half back, and what was listed for putting them back
  must not be older than a load.
- A setup that is open when the terminal part is unloaded ends at its next
  step: after `stop()` it asks nothing of the server part or the person and
  saves nothing, whatever answer arrives.
- The RPC never throws and never quotes a refused value: its schemas are
  loose, the server part checks every answer itself, and what it returns
  holds neither the token nor a proxy's user name and password (a proxy that
  comes back as it was shown stands for the saved one; for a proxy typed
  with them nothing comes back, and the dialog keeps what was typed).
- A token is checked before it is saved: one request through `azure.mjs`
  (`access`), not repeated, since a person waits. It runs in a queue of
  setup's own with one slot, because it must work before settings, and so
  the runtime and its queue, exist. A check that fails says what was
  refused; the token can still be saved unchecked.
- Ask first for what can make a later step fail, and let it be skipped: the
  proxy before the token is checked, the CA file after a proxy. Offer them
  again when the check cannot reach Azure DevOps.
- A dangerous value is confirmed in a list whose first row keeps the current
  setting, never with the host's confirm dialog, whose default is to confirm.
- OpenCode 2.3.0 announces commands that change after a plugin was loaded
  without their location, and its full-screen terminal UI ignores that event
  (`opencode mini` does not): when a first setup is loaded the server part
  publishes the RPC event `loaded`, and the terminal part reads the commands
  again.

**Compatibility.** Host response shapes and constants belong in `host.mjs`.
Detect capabilities; do not assume them. The terminal part runs in the TUI's
process: it checks the TUI plugin API it uses at setup and reads theme tokens
through fallbacks.
- The tested host is one constant, `TESTED_HOST_VERSION`. CI, the installer and
  CONTRIBUTING read it; the README's badge and Compatibility row show it, and
  `tests/release.test.mjs` holds the README to it. Name the tested version
  nowhere else outside dated records (the dated sections of VALIDATION, the
  changelog, release notes, ROADMAP's done entries): refer to the constant or
  link the Compatibility row.
- Date a host behaviour that AZPR relies on as "OpenCode A to the tested
  version": seen from A on and still there in the tested release. Every move of
  the tested version checks each such fact again on the new release, with a
  source read or a probe that the study of that release lists; a behaviour
  that ends gets a closed range then. Keep a measurement as measured ("measured
  on 2.3.0 and 2.4.1") and a change between two releases with both ("through
  2.4.1 …; from 2.4.2 …").
- A study of a new host release starts from the last release studied, which is
  the tested one, and covers every release between the two; VALIDATION records
  each study.

## Verification and delivery

Run `npm ci` once, then `npm run check` and `npm test`; `npm run check` compiles the
terminal panel's source and fails when `src/tui.js` differs. For changes touching hooks, sessions, tools, Azure access or
publication, also run `node tests/host-v2-smoke.mjs <opencode binary>` (fresh and
`--replace`), `node tests/host-v2-comment-scale.mjs <opencode binary>` and
`node tests/host-v2-background-compaction.mjs <opencode binary>`, the last two
also with `--cleanup`. The fixtures keep debug on to read its records, and
debug keeps every private session: only the `--cleanup` runs, with debug off,
exercise the deletion of a run's sessions on a real host.
The smoke and the scale fixture also hold the forms of the host that the
runtime tells things apart by: the sources of a request's instructions (a
configured instruction file reaches an ordinary conversation and no private
session), the message OpenCode leaves after a native read beside an
instruction file and what a request holds of it, the session's messages read
from inside a hook (the prompt is among them by the turn's first request,
with the nonce it was sent with, and no idle marker follows it while the
turn runs), the assistant message that OpenCode names to a tool for a call,
the error type of a used-up limit, a prompt that is one of AZPR's commands,
and the line length the native read returns. When one of these steps fails
on another OpenCode, read that version's source before changing the step.
Two kinds of fallback are behind them. Where the parts of a request cannot
be told apart, or a message is not what the host builds of its own, the
runtime leaves them as they are, which such a step is there to notice. Where
the session's messages cannot be read, or do not say that a request is its
turn's, the runtime refuses the request, and a review fails instead of going
on unchecked.
For package entry points, first-run setup or settings-path changes, also run
`node tests/host-v2-smoke.mjs <opencode binary> --native`; this installs the
packed artifact through OpenCode's plugin manager in an isolated profile.
For changes touching the terminal part, or the text of notices and receipts,
also run `node tests/host-v2-tui-panel.mjs <opencode binary>` and the same with
`--native`; for changes touching setup, the terminal part or the settings
path, also `node tests/host-v2-tui-setup.mjs <opencode binary>` and the same
with `--native`, and both again with `--migrate` (the confirmed update of
settings of AZPR 0.4.x). They drive the real terminal UI in `tmux`, which they
need.
Installer tests must preserve unrelated files and private settings, reject
conflicts and test rollback and archival uninstall. Keep the README manual-copy
list exact.

Fake-service fixtures and live Azure/model runs establish different claims;
record exact versions, environment and limitations in `docs/VALIDATION.md`, and
move superseded validation pages to `docs/VALIDATION_HISTORY.md` instead of
rewriting earlier results.

Do not start live models, publish PR comments, change personal settings,
upgrade installed tools or publish a repository or package without authorization
for that action. Authorization applies to the current request only.
