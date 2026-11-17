// AZPR's part in OpenCode's terminal UI: a panel beside the conversation, and the dialogs of /pr-setup.
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
// The dialogs of /pr-setup ask for AZPR's settings (src/tui-setup.mjs says what and in which order) and
// hand every answer to the server part over the plugin's RPC. They read and write no file and make no
// request to Azure DevOps; a token is typed into a field that shows nothing of it, and is kept nowhere.
//
// This is the source. OpenCode loads src/tui.js, which scripts/build-tui.mjs compiles from it:
// OpenCode 2.3.0 compiles no JSX of a package it installed, so the package carries the result.
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { MouseButton, SyntaxStyle, TextAttributes } from "@opentui/core"
import { PANEL, buildPanel, conversationOf, createReader, opensPanel } from "./tui-model.mjs"
import { SETUP_RPC, createSetup, isSetupNotice } from "./tui-setup.mjs"

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

/** The review panel: opens by itself or with /pr-panel, and only reads. Returns its cleanup, or nothing on a host without a place for it. */
function panelPart(context) {
  // A host without these parts of the plugin API has no place for the panel: stay out of its way.
  const needed = [context?.ui?.slot, context?.ui?.panel?.open, context?.ui?.router?.navigate, context?.keymap?.layer, context?.data?.listen, context?.data?.session?.pending?.list]
  if (needed.some((part) => typeof part !== "function")) return undefined
  const data = context.data
  // Set when the TUI unloads the plugin: nothing is asked of the host after that.
  let disposed = false
  // The host keeps the messages and the inbox of the session on screen and of open tabs, and drops those of
  // other sessions again. What the panel needs of another session (the report waiting in a review session's
  // inbox, the notices of the conversation when one of AZPR's own sessions is on screen) is read from the
  // server by the reader in tui-model.mjs, which also knows which sessions are gone. `version` makes what it
  // holds reactive.
  const [version, setVersion] = createSignal(0)
  const reader = createReader({
    inbox: (sessionID) => context.client.session.inbox.list({ sessionID }),
    context: typeof context.client?.session?.context === "function" ? (sessionID) => context.client.session.context({ sessionID }) : undefined,
    lookup: (sessionID) => data.session.sync(sessionID),
    present: (sessionID) => data.session.get(sessionID),
    list: (cursor) => context.client.session.list(cursor ? { cursor } : {}),
    changed: () => setVersion((count) => count + 1),
  })
  const source = {
    session: (id) => data.session.get(id),
    sessions: () => data.session.list(),
    status: (id) => data.session.status(id),
    messages: (id) => data.session.message.list(id),
    pending: (id) => (version(), [...data.session.pending.list(id), ...reader.entries(id)]),
  }
  const known = () => (version(), reader.known())
  const read = () => (version(), reader.read())

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
    lookup: reader.lookup,
    readInbox: reader.readInbox,
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
    // After a TUI restart the host has not loaded a run's sessions: the reader asks the server for them.
    void reader.discover(conversationOf(data.session.get(sessionID)) ?? sessionID)
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
    if (details?.type === "session.deleted") return reader.deleted(details.data?.sessionID)
    if (details?.type === "server.connected") {
      // What was published while the TUI was away was missed: look everything up again, and let nothing that
      // was asked before the reconnection answer for now.
      reader.reconnected()
      return
    }
    if (details?.type !== "session.inbox.enqueued") return
    const item = details.data?.item
    // What was read of a session from the server is kept current: the host tells of each new notice.
    reader.arrived(details.data?.sessionID, item)
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
    reader.dispose()
    stop?.()
  }
}

/**
 * A dialog that takes a secret and shows nothing of it. The host's own text prompt shows what is typed, and
 * its text fields have no hidden mode, so keys and pastes are taken here: the value lives in this closure
 * only and the screen holds bullets and a count, which neither a glance nor the terminal's own copy can read.
 * Resolves with the value ('' only where `optional`), or with undefined when the dialog was closed.
 */
function askSecret(context, options) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    context.ui.dialog.show(
      () => (
        <Secret
          context={context}
          options={options}
          done={(value) => {
            done(value)
            context.ui.dialog.clear()
          }}
        />
      ),
      () => done(undefined),
    )
  })
}

function Secret(props) {
  let field
  let value = ""
  const [length, setLength] = createSignal(0)
  const palette = createMemo(() => colors(props.context.theme))
  // Far longer than any token: what is pasted beyond that is not kept.
  const set = (next) => {
    value = next.slice(0, 2048)
    setLength(value.length)
  }
  const submit = () => {
    if (value || props.options.optional) props.done(value)
  }
  const key = (event) => {
    const name = event?.name
    if (name === "return" || name === "enter" || name === "kpenter") {
      event.preventDefault?.()
      return submit()
    }
    if (name === "backspace" || name === "delete") {
      event.preventDefault?.()
      return set(value.slice(0, -1))
    }
    if (event?.ctrl && name === "u") {
      event.preventDefault?.()
      return set("")
    }
    const typed = event?.sequence
    // One printable character; what a terminal sends for other keys is longer or starts with a control character.
    if (!event?.ctrl && !event?.meta && typeof typed === "string" && [...typed].length === 1 && typed >= " " && typed !== "\x7f") {
      event.preventDefault?.()
      set(value + typed)
    }
  }
  // A token is one word: line breaks and blanks around a pasted one are not part of it.
  const paste = (event) => {
    event?.preventDefault?.()
    let pasted = ""
    try {
      pasted = new TextDecoder().decode(event?.bytes ?? new Uint8Array())
    } catch {}
    set(value + pasted.replace(/\s+/g, ""))
  }
  onMount(() => {
    const timer = setTimeout(() => {
      if (field && !field.isDestroyed) field.focus()
    }, 1)
    onCleanup(() => clearTimeout(timer))
  })
  onCleanup(() => {
    value = ""
  })
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <text fg={palette().base}>
        <b>{props.options.title}</b>
      </text>
      <Show when={props.options.problem}>
        <text fg={palette().failed}>{props.options.problem}</text>
      </Show>
      <text fg={palette().muted}>{props.options.description}</text>
      <box
        ref={(node) => {
          field = node
        }}
        focusable={true}
        onKeyDown={key}
        onPaste={paste}
        onMouseDown={() => {
          if (field && !field.isDestroyed) field.focus()
        }}
        backgroundColor={palette().hover ?? palette().surface}
        height={1}
        paddingLeft={1}
        flexShrink={0}
      >
        <text fg={length() ? palette().base : palette().muted}>
          {length() ? `${"•".repeat(Math.min(length(), 16))}  (${length()} characters, hidden)` : "Paste the token here; it is not shown"}
        </text>
      </box>
      <text fg={palette().muted}>enter save · ctrl+u clear · esc leave</text>
    </box>
  )
}

/**
 * The dialogs of /pr-setup: they open when the server part answers /pr-setup without options in the session
 * on screen, and from the command palette. Returns its cleanup, or nothing on a host without dialogs or RPC.
 */
function setupPart(context) {
  const needed = [context?.ui?.dialog?.select, context?.ui?.dialog?.prompt, context?.ui?.dialog?.confirm, context?.ui?.dialog?.alert, context?.ui?.dialog?.show, context?.ui?.toast?.show, context?.client?.rpc, context?.keymap?.layer, context?.data?.listen, context?.data?.location?.model?.list]
  if (needed.some((part) => typeof part !== "function")) return undefined
  let disposed = false
  const rpc = context.client.rpc(SETUP_RPC)
  // Each project directory has a server part of its own. Setup talks to the one of the session on screen, where
  // the review commands that follow will run; without a session, to the one of the directory this TUI works in.
  const onScreen = () => {
    const route = context.ui.router?.current?.()
    const session = route?.type === "session" ? context.data.session?.get?.(route.sessionID) : undefined
    return session?.location ?? context.location ?? context.data.location.default?.()
  }
  // While a setup is open its place is fixed: another project's session may come on screen meanwhile, and what
  // was checked for one project's server part must not be saved by another's.
  let pinned
  const place = () => (pinned ? pinned.at : onScreen())
  const call = (method, input = {}) => {
    const directory = place()?.directory
    return rpc[method](input, directory ? { location: { directory } } : undefined)
  }
  // The models the host offers that can call tools, as the server part will accept them.
  const models = async () => {
    const at = place()
    await Promise.all([context.data.location.model.sync?.(at), context.data.location.provider?.sync?.(at)]).catch(() => {})
    const providers = new Map((context.data.location.provider?.list?.(at) ?? []).map((provider) => [provider.id, provider.name ?? provider.id]))
    return (context.data.location.model.list(at) ?? [])
      .filter((model) => model?.enabled !== false && model?.capabilities?.tools === true && typeof model.providerID === "string" && typeof model.id === "string")
      .map((model) => ({
        id: `${model.providerID}/${model.id}`,
        name: typeof model.name === "string" && model.name ? model.name : model.id,
        provider: providers.get(model.providerID) ?? model.providerID,
        variants: (Array.isArray(model.variants) ? model.variants : []).map((variant) => variant?.id).filter((id) => typeof id === "string" && id),
      }))
  }
  // The commands as the server has them now. OpenCode 2.3.0 does not tell its clients where commands changed
  // when a plugin changes them after it was loaded, so after a first setup the list is read again here.
  const commandsChanged = () => {
    if (disposed) return
    const at = place()
    try {
      context.data.location.command?.invalidate?.(at)
      void Promise.resolve(context.data.location.command?.sync?.(at)).catch(() => {})
    } catch {}
  }
  const setup = createSetup({
    call,
    dialog: context.ui.dialog,
    secret: (options) => askSecret(context, options),
    toast: (options) => {
      if (!disposed) context.ui.toast.show(options)
    },
    models,
    loaded: commandsChanged,
    pin: () => {
      const mine = (pinned = { at: onScreen() })
      return () => {
        if (pinned === mine) pinned = undefined
      }
    },
  })
  // Also when the settings were saved with options, or loaded by another command: the server part says so.
  let unsubscribe
  try {
    unsubscribe = rpc.events?.on?.("loaded", commandsChanged)
  } catch {}

  const stop = context.data.listen((event) => {
    if (disposed) return
    const details = event?.details
    if (details?.type !== "session.inbox.enqueued") return
    const item = details.data?.item
    if (item?.type !== "synthetic" || !isSetupNotice(item.payload?.metadata)) return
    // Only where the person just typed /pr-setup: the session on screen.
    const route = context.ui.router?.current?.()
    if (route?.type === "session" && route.sessionID === details.data.sessionID) void setup.open()
  })

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "azpr.setup",
        title: "AZPR: settings",
        description: "Set AZPR up, or show and change its settings: organization, token, proxy, models and more.",
        group: "AZPR",
        palette: true,
        run() {
          void setup.open()
        },
      },
    ],
  }))

  // Say once how to set AZPR up when it has no usable settings. The server part may still be loading when the
  // TUI starts, so it is asked a second time a little later; neither timer outlives this part.
  const timers = [1500, 6000].map((delay) => setTimeout(() => !disposed && void setup.hint(), delay))

  return () => {
    disposed = true
    timers.forEach(clearTimeout)
    stop?.()
    try {
      unsubscribe?.()
    } catch {}
  }
}

export default {
  id: "azpr.tui",
  setup(context) {
    // Each part checks for itself what it needs of the host, and stays out of the way where that is missing.
    const stops = [panelPart(context), setupPart(context)].filter((stop) => typeof stop === "function")
    return () => stops.forEach((stop) => stop())
  },
}
