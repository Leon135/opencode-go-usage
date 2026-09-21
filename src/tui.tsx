/** @jsxImportSource @opentui/solid */
import { TextAttributes, type RGBA } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { Show } from "solid-js"
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import process from "node:process"

type WindowKey = "rolling" | "weekly" | "monthly"

type UsageWindow = {
  status: string
  percent: number
  resetsAt: string
}

type GoUsage = Partial<Record<WindowKey, UsageWindow>>

type FetchState =
  | { kind: "loading" }
  | { kind: "noauth" }
  | { kind: "ready"; usage: GoUsage }
  | { kind: "error"; message: string }

type ThemeTokens = {
  text: RGBA
  textMuted: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  accent: RGBA
}

type SessionMessageLike = {
  type?: string
  role?: string
  info?: SessionMessageLike
  model?: { providerID?: string }
  providerID?: string
}

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const POLL_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
const OK_AT = 50
const WARN_AT = 75
const DANGER_AT = 90
const GAUGE_WIDTH = 7
const SIDEBAR_GAUGE_WIDTH = 16
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

const WINDOWS: ReadonlyArray<{ key: WindowKey; label: string; short: string }> = [
  { key: "rolling", label: "5h", short: "5h" },
  { key: "weekly", label: "week", short: "7d" },
  { key: "monthly", label: "month", short: "30d" },
]

const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "session.created",
  "session.status",
  "session.idle",
  "session.deleted",
  "session.message.content.updated",
  "session.usage.updated",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

// --- theme ---

function resolveTheme(context: Plugin.Context): ThemeTokens {
  const surface = context.theme.surface("dialog")
  return {
    text: surface.text.base,
    textMuted: surface.text.muted,
    error: surface.text.feedback.error.base,
    warning: surface.text.feedback.warning.base,
    success: surface.text.feedback.success.base,
    accent: surface.text.action.primary.base,
  }
}

// --- auth ---

function databasePath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "opencode.db")
}

// OpenCode v2 stores credentials in SQLite 
function readGoKey(): string | undefined {
  try {
    const db = new Database(databasePath(), { readonly: true })
    try {
      const row = db
        .prepare(
          "SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC LIMIT 1",
        )
        .get("opencode-go") as { value: unknown } | undefined
      if (!row || typeof row.value !== "string") return undefined
      const raw: unknown = JSON.parse(row.value)
      const record = raw as { type?: unknown; key?: unknown } | null
      if (record?.type !== "key") return undefined
      return typeof record.key === "string" && record.key.length > 0 ? record.key : undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

// --- fetch + parse ---

function parseWindow(value: unknown): UsageWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.percent !== "number" || !Number.isFinite(record.percent)) return undefined
  return {
    status: typeof record.status === "string" ? record.status : "ok",
    percent: Math.max(0, Math.min(100, record.percent)),
    resetsAt: typeof record.resetsAt === "string" ? record.resetsAt : "",
  }
}

function parseUsage(body: unknown): GoUsage {
  const usage = (body as { usage?: Record<string, unknown> } | null | undefined)?.usage
  const out: GoUsage = {}
  for (const { key } of WINDOWS) {
    const window = parseWindow(usage?.[key])
    if (window) out[key] = window
  }
  if (!out.rolling && !out.weekly && !out.monthly) throw new Error("unexpected response shape")
  return out
}

async function fetchUsage(key: string): Promise<GoUsage> {
  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseUsage(await response.json())
}

// --- formatting ---

function percentLabel(percent: number): string {
  if (percent <= 0) return "0%"
  if (percent < 1) return "<1%"
  return `${Math.round(percent)}%`
}

function shortReset(iso: string, now = new Date()): string {
  if (!iso) return ""
  const diffMs = new Date(iso).getTime() - now.getTime()
  if (!Number.isFinite(diffMs)) return ""
  if (diffMs <= 0) return "now"
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.ceil(hours / 24)}d`
}

function gauge(fraction: number, width: number): { fill: string; track: string } {
  const cells = Math.min(1, Math.max(0, fraction)) * width
  let full = Math.floor(cells)
  let partial = ""
  const idx = Math.round((cells - full) * 8)
  if (idx >= 8) {
    full += 1
  } else {
    partial = EIGHTHS[idx] ?? ""
  }
  return {
    fill: "█".repeat(full) + partial,
    track: "░".repeat(width - full - (partial ? 1 : 0)),
  }
}

function levelColor(window: UsageWindow, theme: ThemeTokens) {
  if (window.status === "rate-limited" || window.percent >= DANGER_AT) return theme.error
  if (window.percent >= WARN_AT) return theme.warning
  if (window.percent >= OK_AT) return theme.accent
  return theme.success
}

function worstWindow(usage: GoUsage): { label: string; window: UsageWindow } | undefined {
  let worst: { label: string; window: UsageWindow } | undefined
  for (const { key, label } of WINDOWS) {
    const window = usage[key]
    if (window && (!worst || window.percent > worst.window.percent)) worst = { label, window }
  }
  return worst
}

function compactText(state: FetchState): string {
  if (state.kind !== "ready") return ""
  const found = worstWindow(state.usage)
  return found ? `Go ${found.label} ${percentLabel(found.window.percent)}` : ""
}

// --- session gating ---

function isGoSession(context: Plugin.Context, sessionID: string): boolean {
  const messages = context.data.session.message.list(sessionID) as ReadonlyArray<SessionMessageLike>
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i]
    const message = entry?.info ?? entry
    if (message?.type !== "assistant" && message?.role !== "assistant") continue
    const providerID = message.model?.providerID ?? message.providerID
    if (providerID) return providerID === "opencode-go"
  }
  const model = context.data.session.get(sessionID)?.model
  return model?.providerID === "opencode-go"
}

// --- polling ---

function createUsagePolling(context: Plugin.Context, sessionID: string, enabled: () => boolean) {
  const [state, setState] = createSignal<FetchState>({ kind: "loading" })
  let disposed = false
  let inFlight: Promise<void> | undefined
  let refreshAgain = false

  const runRefresh = async () => {
    if (!enabled() || !isGoSession(context, sessionID)) return
    const key = readGoKey()
    if (!key) {
      setState({ kind: "noauth" })
      context.renderer.requestRender()
      return
    }
    try {
      const usage = await fetchUsage(key)
      if (disposed) return
      setState({ kind: "ready", usage })
    } catch (error) {
      if (disposed) return
      setState({ kind: "error", message: error instanceof Error ? error.message : "Go usage unavailable" })
    }
    context.renderer.requestRender()
  }

  const refresh = () => {
    if (inFlight) {
      refreshAgain = true
      return inFlight
    }
    inFlight = runRefresh().finally(() => {
      inFlight = undefined
      if (refreshAgain && !disposed) {
        refreshAgain = false
        void refresh()
      }
    })
    return inFlight
  }

  createEffect(() => {
    if (enabled()) untrack(() => void refresh())
  })
  const timer = setInterval(() => void refresh(), POLL_MS)

  const unsubscribe = context.data.listen(({ details }) => {
    const type = details.type
    if (REFRESH_EVENTS.has(type)) void refresh()
  })

  onCleanup(() => {
    disposed = true
    clearInterval(timer)
    unsubscribe?.()
  })

  return state
}

// --- views ---

function UsageGauge(props: { label: string; window: UsageWindow | undefined; theme: ThemeTokens }) {
  const bar = () => gauge(props.window ? props.window.percent / 100 : 0, SIDEBAR_GAUGE_WIDTH)
  const color = () => (props.window ? levelColor(props.window, props.theme) : props.theme.textMuted)
  const reset = () => (props.window ? shortReset(props.window.resetsAt) : "")
  return (
    <box flexDirection="row">
      <text fg={props.theme.textMuted}>{props.label.padEnd(4)}</text>
      <text fg={color()}>{bar().fill}</text>
      <text fg={props.theme.textMuted}>{bar().track}</text>
      <text fg={color()}>{` ${props.window ? percentLabel(props.window.percent) : "--"}`}</text>
      <text fg={props.theme.textMuted}>{reset() ? ` · ${reset()}` : ""}</text>
    </box>
  )
}

function SidebarView(props: { context: Plugin.Context; sessionID: string }) {
  const state = createUsagePolling(props.context, props.sessionID, () => true)

  const visible = createMemo(() => isGoSession(props.context, props.sessionID) && state().kind !== "noauth")

  const fallbackText = (current: FetchState): string => {
    if (current.kind === "error") return current.message
    if (current.kind === "loading") return "loading…"
    return ""
  }

  const gauges = createMemo(() => {
    const current = state()
    if (current.kind !== "ready") return []
    return WINDOWS.map(({ key, short }) => ({ short, window: current.usage[key] }))
  })

  return (
    <box flexDirection="column">
      <Show when={visible()} fallback={<box />}>
        <text fg={resolveTheme(props.context).text} attributes={TextAttributes.BOLD}>{"Go plan usage"}</text>
        <Show when={gauges().length > 0} fallback={<text fg={resolveTheme(props.context).textMuted}>{fallbackText(state())}</text>}>
          <box flexDirection="column" >
            {gauges().map(({ short, window }) => (
              <UsageGauge label={short} window={window} theme={resolveTheme(props.context)} />
            ))}
          </box>
        </Show>
      </Show>
    </box>
  )
}

function CompactView(props: { context: Plugin.Context; sessionID: string }) {
  const state = createUsagePolling(props.context, props.sessionID, () => true)

  const footer = createMemo(() => {
    const current = state()
    if (current.kind !== "ready") return undefined
    const window = current.usage.rolling
    if (!window) return undefined
    const theme = resolveTheme(props.context)
    const bar = gauge(window.percent / 100, GAUGE_WIDTH)
    const reset = shortReset(window.resetsAt)
    return {
      label: "Go 5h ",
      fill: bar.fill,
      track: bar.track,
      percent: ` ${percentLabel(window.percent)}`,
      reset: reset ? ` · ${reset}` : "",
      color: levelColor(window, theme),
      muted: theme.textMuted,
    }
  })

  return (
    <box>
      <Show when={isGoSession(props.context, props.sessionID) && footer()} fallback={<box />}>
        <box flexDirection="row">
          <text fg={footer()!.muted}>{footer()!.label}</text>
          <text fg={footer()!.color}>{footer()!.fill}</text>
          <text fg={footer()!.muted}>{footer()!.track}</text>
          <text fg={footer()!.color}>{footer()!.percent}</text>
          <text fg={footer()!.muted}>{footer()!.reset}</text>
        </box>
      </Show>
    </box>
  )
}

export const GoUsageFormat = {
  percentLabel,
  shortReset,
  gauge,
  levelColor,
  compactText,
}

export default {
  id: "opencode-go-usage",
  setup(context: Plugin.Context) {
    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <SidebarView context={context} sessionID={sessionID} />,
    })
    context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => (sessionID ? <CompactView context={context} sessionID={sessionID} /> : <box />),
    })
  },
} satisfies Plugin.Definition
