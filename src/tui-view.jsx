// AZPR's part in OpenCode's terminal UI: a panel beside the conversation.
//
// Its upper part lists the sessions of the run under way or last ended, each a row that opens
// that session when it is clicked; its lower part shows the newest report or comment preview as
// rendered Markdown. A run that starts, and a report or preview that arrives, opens the panel in
// the session on screen and leaves the keyboard with the prompt; with the setting
// terminalPanel: manual it opens only with /pr-panel, its one command.
//
// The panel only reads: AZPR's own notices in the conversation, the report queued to a review
// session, and the sessions' `metadata.azpr` (src/tui-model.mjs works out what to show). It sends
// no prompt, runs no command of the server part and reads no settings file: the server part writes
// that setting into the metadata of its notices.
//
// This is the source. OpenCode loads src/tui.js, which scripts/build-tui.mjs compiles from it:
// OpenCode 2.3.0 compiles no JSX of a package it installed, so the package carries the result.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { MouseButton, SyntaxStyle, TextAttributes } from "@opentui/core"
import { PANEL, buildPanel, conversationOf, lookupOutcome, mergeEntries, notFound, opensPanel, reportIn, syntheticOf } from "./tui-model.mjs"

// Short enough for one line of a toast, which the host wraps at about fifty characters.
const READY = "AZPR: report or preview ready. /pr-panel shows it."

/** The first of these theme tokens that this OpenCode defines; their names have changed between releases. */
const token = (theme, ...paths) => {
  for (const path of paths) {
    const value = path.split(".").reduce((node, name) => node?.[name], theme)
    if (value !== undefined) return value
  }
}
const colors = (theme) => {
  const base = token(theme, "text.base", "text.default")
  return {
    base,
    muted: token(theme, "text.muted", "text.subdued") ?? base,
    running: token(theme, "text.feedback.info.base") ?? base,
    failed: token(theme, "text.feedback.error.base") ?? base,
    done: token(theme, "text.feedback.success.base") ?? base,
    link: token(theme, "markdown.link") ?? base,
    text: token(theme, "markdown.text") ?? base,
    surface: token(theme, "background.raised.base"),
    hover: token(theme, "background.raised.high"),
  }
}

/** Markdown colors from the theme's own tokens, for the renderer of this TUI. */
function markdownStyle(context) {
  const theme = context.theme
  const base = token(theme, "text.base", "text.default")
  const of = (name) => token(theme, `markdown.${name}`) ?? base
  const styles = {
    default: { fg: of("text") },
    "markup.heading": { fg: of("heading"), bold: true },
    "markup.strong": { fg: of("strong"), bold: true },
    "markup.bold": { fg: of("strong"), bold: true },
    "markup.italic": { fg: of("emphasis"), italic: true },
    "markup.strikethrough": { fg: token(theme, "text.muted", "text.subdued") ?? base, dim: true },
    "markup.raw": { fg: of("code") },
    "markup.raw.inline": { fg: of("code") },
    "markup.raw.block": { fg: of("codeBlock") },
    "markup.link": { fg: of("link"), underline: true },
    "markup.link.label": { fg: of("linkText"), underline: true },
    "markup.link.url": { fg: of("link"), underline: true },
    "markup.list": { fg: of("listItem") },
    "markup.quote": { fg: of("blockQuote"), italic: true },
  }
  for (const level of [1, 2, 3, 4, 5, 6]) styles[`markup.heading.${level}`] = { fg: of("heading"), bold: true }
  return SyntaxStyle.fromStyles(styles, context.renderer.nativeScene)
}

function Row(props) {
  const [hover, setHover] = createSignal(false)
  const mark = () => (props.row.state === "running" ? props.colors.running : props.row.state === "failed" ? props.colors.failed : props.colors.done)
  return (
    <box
      flexDirection="row"
      gap={1}
      backgroundColor={hover() ? props.colors.hover : undefined}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(event) => {
        if (event.button !== MouseButton.LEFT) return
        event.stopPropagation()
        props.open(props.row.id)
      }}
    >
      <text fg={mark()} flexShrink={0} selectable={false}>
        {props.row.state === "running" ? "●" : "○"}
      </text>
      <text fg={props.colors.base} flexShrink={0} selectable={false}>
        {props.row.label}
        {props.row.report ? " (report)" : ""}
      </text>
      <text fg={props.colors.muted} flexShrink={0} selectable={false}>
        {props.row.state}
      </text>
      <Show when={props.wide}>
        <text fg={props.colors.link} attributes={TextAttributes.UNDERLINE} wrapMode="none" selectable={false}>
          {props.row.id}
        </text>
      </Show>
    </box>
  )
}

function Panel(props) {
  const context = props.context
  const state = props.state
  const model = createMemo(() => buildPanel(state.source, props.panel.sessionID, { known: state.known(), read: state.read(), titles: state.titles }))
  const palette = createMemo(() => colors(context.theme))
  let scroll

  // The style follows the theme; a style no longer drawn is destroyed once the renderer is idle.
  const release = (style) =>
    Promise.resolve(context.renderer.idle?.())
      .catch(() => undefined)
      .finally(() => style.destroy?.())
  const syntax = createMemo((previous) => {
    const next = markdownStyle(context)
    if (previous) release(previous)
    return next
  })
  onCleanup(() => release(syntax()))

  const close = () => {
    state.dismiss(props.panel.sessionID)
    props.panel.close()
  }
  const open = (sessionID) => context.ui.router.navigate({ type: "session", sessionID })

  // The host gives the keyboard to a panel that opens, and has no way to open one without it. AZPR is
  // driven by commands, so the panel hands the keyboard back to the prompt: the next command can be typed
  // while the report is on screen, and a click in the panel (or the host's "Focus right pane") gives it
  // the keyboard. A terminal too narrow for two panes shows the panel alone, with no prompt to return to.
  // A panel that opened by itself must never be left with the keyboard: where it cannot hand it back, it
  // closes again, and says that something is ready when a notice opened it.
  // The two steps below run a moment after the panel mounted. By then the host may show another plugin's panel in
  // this place, or another session: each step acts only while this panel is the one open here, and none outlives it.
  const timers = new Set()
  const mine = () => {
    const current = context.ui.panel.current()
    return current?.name === PANEL && current.sessionID === props.panel.sessionID
  }
  const later = (step, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (mine()) step()
    }, delay)
    timers.add(timer)
  }
  onCleanup(() => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  })
  onMount(() => {
    const unasked = state.takeUnasked()
    const withdraw = () => {
      state.dismiss(props.panel.sessionID)
      props.panel.close()
      if (unasked === "notice") context.ui.toast.show({ message: READY, variant: "info" })
    }
    if (props.panel.presentation === "fullscreen") return unasked ? withdraw() : undefined
    later(() => {
      context.keymap.dispatch("pane.focus.left")
      if (unasked) later(() => props.panel.focused && withdraw(), 50)
    }, 0)
  })

  // Sessions the host has not loaded here: a run's sessions after a TUI restart, the conversation of one of them.
  createEffect(() => {
    for (const sessionID of model().needs) void state.lookup(sessionID)
  })
  // The report of a review waits in its session's inbox; in one of AZPR's own sessions the notices are in the
  // conversation's. The model names an inbox only once the session proved to be this conversation's.
  createEffect(() => {
    const inbox = model().inbox
    if (inbox) state.readInbox(inbox.sessionID, inbox.token, true)
    const notices = model().notices
    if (notices) state.readInbox(notices.sessionID, notices.token, false)
  })

  // Active only while the panel has the keyboard; the IDs let a user bind other keys in the TUI's configuration.
  const page = () => Math.max(4, (scroll?.viewport?.height ?? scroll?.height ?? 10) - 2)
  context.keymap.layer(() => ({
    commands: [
      { id: "azpr.panel.close", title: "Close the AZPR panel", group: "AZPR", bind: "escape,q", run: close },
      { id: "azpr.panel.up", title: "AZPR panel: scroll up", group: "AZPR", bind: "up,k", run: () => scroll?.scrollBy(-1) },
      { id: "azpr.panel.down", title: "AZPR panel: scroll down", group: "AZPR", bind: "down,j", run: () => scroll?.scrollBy(1) },
      { id: "azpr.panel.page.up", title: "AZPR panel: page up", group: "AZPR", bind: "pageup", run: () => scroll?.scrollBy(-page()) },
      { id: "azpr.panel.page.down", title: "AZPR panel: page down", group: "AZPR", bind: "pagedown", run: () => scroll?.scrollBy(page()) },
      { id: "azpr.panel.top", title: "AZPR panel: go to the top", group: "AZPR", bind: "home", run: () => scroll?.scrollTo(0) },
      { id: "azpr.panel.bottom", title: "AZPR panel: go to the end", group: "AZPR", bind: "end", run: () => scroll?.scrollTo(scroll.scrollHeight) },
    ],
  }))

  // Rows are keyed by session, so a row keeps its place and its hover while the list is worked out again.
  const ids = createMemo(() => model().rows.map((row) => row.id), [], { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) })
  const row = (id) => model().rows.find((item) => item.id === id) ?? { id, label: "", state: "", report: false }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={palette().base} flexShrink={0}>
          <b>AZPR</b>
          <Show when={model().run}>
            <span> {model().run}</span>
          </Show>
          <Show when={model().status}>
            <span style={{ fg: palette().muted }}> · {model().status}</span>
          </Show>
        </text>
        <box flexGrow={1} />
        <text
          fg={palette().muted}
          flexShrink={0}
          selectable={false}
          onMouseUp={(event) => {
            if (event.button !== MouseButton.LEFT) return
            event.stopPropagation()
            close()
          }}
        >
          close
        </text>
      </box>
      <Show when={model().progress}>
        <text fg={palette().muted} flexShrink={0}>
          {model().progress}
        </text>
      </Show>
      <scrollbox ref={(element) => (scroll = element)} flexGrow={1} minHeight={0} paddingTop={1} verticalScrollbarOptions={{ visible: false }} contentOptions={{ minHeight: 0 }}>
        <Show when={ids().length > 0 || model().deleted > 0}>
          <box flexDirection="column" flexShrink={0} paddingBottom={1}>
            <Show when={ids().length > 0}>
              <text fg={palette().muted} selectable={false}>
                Sessions (click one to open it)
              </text>
            </Show>
            <For each={ids()}>{(id) => <Row row={row(id)} colors={palette()} wide={props.panel.width >= 64} open={open} />}</For>
            <Show when={model().deleted > 0}>
              <text fg={palette().muted}>{model().deleted} session(s) were deleted when their run ended.</text>
            </Show>
          </box>
        </Show>
        <Show
          when={model().markdown}
          fallback={
            <text fg={palette().muted}>
              {model().loading
                ? "Loading the report…"
                : model().inbox
                  ? "The report is in its session: open it above."
                  : model().run
                    ? "No report or preview yet."
                    : "No AZPR run in this conversation yet."}
            </text>
          }
        >
          <Show when={model().documentHead}>
            <text fg={palette().muted} flexShrink={0} paddingBottom={1}>
              {model().documentHead}
            </text>
          </Show>
          <markdown syntaxStyle={syntax()} content={model().markdown} conceal tableOptions={{ style: "grid", cellPaddingX: 1 }} fg={palette().text} bg={palette().surface} />
        </Show>
      </scrollbox>
    </box>
  )
}

export default {
  id: "azpr.tui",
  setup(context) {
    // A host without these parts of the plugin API has no place for the panel: stay out of its way.
    const needed = [context?.ui?.slot, context?.ui?.panel?.open, context?.ui?.router?.navigate, context?.keymap?.layer, context?.data?.listen, context?.data?.session?.pending?.list]
    if (needed.some((part) => typeof part !== "function")) return
    const data = context.data
    // Set when the TUI unloads the plugin: nothing is asked of the host after that.
    let disposed = false
    // Which sessions were looked up and are gone, and which inboxes were read.
    const [known, setKnown] = createSignal({})
    const [read, setRead] = createSignal({})
    // The host keeps the messages and the inbox of the session on screen and of open tabs, and drops those of
    // other sessions again. What the panel needs of another session, such as the report waiting in a review
    // session's inbox, it therefore reads from the server itself and keeps here: the inboxes of the sessions
    // read last, so that a terminal UI left open for weeks does not hold every report it ever showed.
    const KEPT_INBOXES = 24
    const [fetched, setFetched] = createSignal({})
    const keep = (sessionID, items) => {
      const { [sessionID]: _replaced, ...others } = fetched()
      const entries = Object.entries(others)
      const dropped = entries.slice(0, Math.max(0, entries.length - (KEPT_INBOXES - 1))).map(([id]) => id)
      setFetched(Object.fromEntries([...entries.slice(dropped.length), [sessionID, items]]))
      // An inbox that was let go is read again when the panel needs it.
      if (dropped.length) setRead((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !dropped.some((id) => key.startsWith(`${id}:`)))))
    }
    const listOf = (result) => (Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : [])
    // Notices that the host reported for a session while a read of that session was under way: the answer to the
    // read may be older than they are.
    const arriving = new Map()
    /**
     * Read a session's notices from the server: what waits in its inbox and, with `delivered`, what it was
     * already told (its messages since the last compaction), since a notice is delivered once its conversation's
     * model runs. What arrives during the read is kept with the answer.
     */
    const fetchEntries = async (sessionID, delivered) => {
      if (disposed) return []
      const waiting = arriving.get(sessionID) ?? { count: 0, items: [] }
      waiting.count++
      arriving.set(sessionID, waiting)
      try {
        const [pending, told] = await Promise.all([
          context.client.session.inbox.list({ sessionID }),
          delivered && typeof context.client.session.context === "function" ? context.client.session.context({ sessionID }) : [],
        ])
        // With what was read of this session before: a later read of its inbox alone must not lose what it was told.
        const entries = mergeEntries(fetched()[sessionID] ?? [], listOf(told).filter((entry) => entry?.type === "synthetic"), listOf(pending), waiting.items)
        keep(sessionID, entries)
        return entries
      } finally {
        if (--waiting.count === 0) arriving.delete(sessionID)
      }
    }
    const source = {
      session: (id) => data.session.get(id),
      sessions: () => data.session.list(),
      status: (id) => data.session.status(id),
      messages: (id) => data.session.message.list(id),
      pending: (id) => [...data.session.pending.list(id), ...(fetched()[id] ?? [])],
    }
    const mark = (sessionID, value) => setKnown((current) => (current[sessionID] === value ? current : { ...current, [sessionID]: value }))
    const looking = new Map()
    // How often a session's lookup failed without an answer about the session itself; reset when the server reconnects.
    const failed = new Map()
    /**
     * Look a session up, once at a time: the session itself, nothing it holds. Whose it is must be known before
     * its inbox is read, and the model decides that from the session's own metadata. A session is remembered as
     * missing only when the server said so (see lookupOutcome); a lookup that failed on the way is made again a
     * few times, further apart, and then left until the server reconnects.
     */
    const lookup = (sessionID) => {
      if (disposed || known()[sessionID] === "missing" || failed.get(sessionID) >= 4) return Promise.resolve()
      const running = looking.get(sessionID)
      if (running) return running
      const started = Promise.allSettled([Promise.resolve().then(() => data.session.sync(sessionID))])
        .then(([looked]) => {
          const outcome = lookupOutcome(looked, Boolean(data.session.get(sessionID)))
          if (outcome !== "retry") {
            failed.delete(sessionID)
            return mark(sessionID, outcome)
          }
          const count = (failed.get(sessionID) ?? 0) + 1
          failed.set(sessionID, count)
          if (count < 4) setTimeout(() => void lookup(sessionID), 500 * 2 ** count)
        })
        .finally(() => looking.delete(sessionID))
      looking.set(sessionID, started)
      return started
    }
    const reading = new Set()
    /**
     * Read the inbox of a session the model named: the one that holds a report (`report`: a report that is not
     * there after a moment is not coming), or a conversation's, for its notices. A request that failed on the way
     * is made again; only a not-found answer says that the session is gone.
     */
    const readInbox = (sessionID, token, report) => {
      const key = `${sessionID}:${token}`
      if (read()[key] || reading.has(key)) return
      reading.add(key)
      const attempt = async (left, delivered) => {
        try {
          // A report waits in the inbox unless someone prompted its session since: then it is among the messages.
          const entries = await fetchEntries(sessionID, delivered)
          if (!report || reportIn(syntheticOf(entries, []))) return
        } catch (error) {
          if (notFound(error)) return mark(sessionID, "missing")
        }
        if (left <= 1 || disposed) return
        await new Promise((done) => setTimeout(done, 400))
        return attempt(left - 1, true)
      }
      attempt(4, !report).finally(() => {
        reading.delete(key)
        setRead((current) => ({ ...current, [key]: true }))
      })
    }

    // Sessions whose panel this plugin opened and the user has not closed. The host closes a panel when the
    // screen leaves its session; coming back to such a session opens it again.
    const wanted = new Set()
    // Why the panel is being opened without the user asking: "notice" or "return"; undefined when asked.
    let unasked
    // The session in which another plugin's panel is open; the host shows one panel at a time.
    let occupied
    const state = {
      source,
      known,
      read,
      titles: new Map(),
      lookup,
      readInbox,
      dismiss: (sessionID) => void wanted.delete(sessionID),
      takeUnasked: () => {
        const value = unasked
        unasked = undefined
        return value
      },
    }

    context.ui.slot({
      append: "session.panel",
      render: (panel) => {
        // Every contribution is told which panel is open: remember where it is someone else's.
        createEffect(() => {
          occupied = panel.name === PANEL ? undefined : panel.sessionID
        })
        onCleanup(() => {
          occupied = undefined
        })
        return (
          <Show when={panel.name === PANEL}>
            <Panel context={context} panel={panel} state={state} />
          </Show>
        )
      },
    })

    /** After a TUI restart the host has not loaded a run's sessions: ask the server once per conversation. */
    const discovered = new Set()
    const discover = (conversation) => {
      if (discovered.has(conversation)) return
      discovered.add(conversation)
      const page = (cursor, left = 5) =>
        Promise.resolve(context.client.session.list(cursor ? { cursor } : {})).then((result) => {
          for (const session of result?.data ?? []) if (conversationOf(session) === conversation) void lookup(session.id)
          if (result?.cursor && result.cursor !== cursor && left > 1) return page(result.cursor, left - 1)
        })
      page().catch(() => discovered.delete(conversation))
    }

    const shown = (sessionID) => {
      const current = context.ui.panel.current()
      return current?.name === PANEL && current.sessionID === sessionID
    }
    /**
     * Show the panel in the session on screen. `byItself` says why when the user did not ask ("notice": one
     * arrived; "return": the screen came back to a session that had the panel): then neither a dialog nor
     * another plugin's panel is disturbed.
     */
    const show = (byItself) => {
      if (disposed) return false
      const route = context.ui.router.current()
      if (route.type !== "session") return false
      const sessionID = route.sessionID
      discover(conversationOf(data.session.get(sessionID)) ?? sessionID)
      wanted.add(sessionID)
      if (shown(sessionID)) return true
      if (byItself && (occupied === sessionID || context.keymap.mode?.current?.() === "modal")) {
        if (byItself === "notice") context.ui.toast.show({ message: READY, variant: "info" })
        return false
      }
      unasked = byItself
      return context.ui.panel.open(PANEL)
    }

    const stop = data.listen((event) => {
      if (disposed) return
      const details = event?.details
      if (details?.type === "session.deleted") return mark(details.data?.sessionID, "missing")
      if (details?.type === "server.connected") {
        // What was published while the TUI was away was missed: look everything up again.
        discovered.clear()
        failed.clear()
        setKnown({})
        setRead({})
        setFetched({})
        return
      }
      if (details?.type !== "session.inbox.enqueued") return
      const item = details.data?.item
      // What this plugin read of a session itself is kept current: the host tells of each new notice. One that
      // arrives while a read is under way is handed to that read, whose answer may not have it yet.
      const about = details.data?.sessionID
      if (item?.type === "synthetic" && typeof item.id === "string") {
        arriving.get(about)?.items.push(item)
        if (fetched()[about] && !fetched()[about].some((held) => held.id === item.id)) keep(about, [...fetched()[about], item])
      }
      // A run that starts, and a report or preview that arrives, opens the panel in the session on screen,
      // unless the notice says that the settings leave the panel to /pr-panel.
      if (item?.type !== "synthetic" || !opensPanel(item.payload?.text, item.payload?.metadata)) return
      const route = context.ui.router.current()
      if (route.type === "session" && route.sessionID === details.data.sessionID) show("notice")
    })

    context.ui.slot({
      append: "app",
      render: () => {
        createEffect(() => {
          const route = context.ui.router.current()
          if (route.type !== "session" || !wanted.has(route.sessionID)) return
          const sessionID = route.sessionID
          // After the session's view has mounted.
          setTimeout(() => {
            const now = context.ui.router.current()
            if (now.type === "session" && now.sessionID === sessionID && wanted.has(sessionID)) show("return")
          }, 0)
        })
        return null
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "azpr.panel",
          title: "AZPR: show or hide the review panel",
          description: "The sessions of the review in this conversation and its report or comment preview, rendered.",
          group: "AZPR",
          palette: true,
          slash: { name: "pr-panel" },
          run() {
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({ message: "AZPR: open a conversation first.", variant: "info" })
              return
            }
            if (shown(route.sessionID)) {
              wanted.delete(route.sessionID)
              context.ui.panel.close()
            } else show()
          },
        },
      ],
    }))

    return () => {
      disposed = true
      stop?.()
    }
  },
}
