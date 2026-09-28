/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { SIDEBAR_ROW_WIDTH, UsageGauge, type ThemeTokens, type UsageWindow } from "../src/tui"

const theme: ThemeTokens = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  error: RGBA.fromHex("#ff0000"),
  warning: RGBA.fromHex("#ffaa00"),
  success: RGBA.fromHex("#00ff00"),
  accent: RGBA.fromHex("#00aaff"),
}

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString()
const windowAt = (percent: number, resetsAt: string): UsageWindow => ({ status: "ok", percent, resetsAt })

const ROWS: Array<{ label: string; window: UsageWindow }> = [
  { label: "5h", window: windowAt(0, inMs(5 * 3600_000)) },
  { label: "wk", window: windowAt(0, inMs(7 * 86400_000)) },
  { label: "mo", window: windowAt(33, inMs(17 * 86400_000)) },
  { label: "5h", window: windowAt(100, inMs(12 * 60_000)) },
  { label: "wk", window: windowAt(0.4, inMs(0)) },
  { label: "mo", window: windowAt(9, "") },
]

const LABEL_WIDTH = 3
const GAUGE_WIDTH = 14
const GAUGE_CHARS = /^[█▏▎▍▌▋▊▉░]+$/

async function renderRows(sidebarWidth: number): Promise<string[]> {
  const setup = await testRender(
    () => (
      <box flexDirection="column">
        {ROWS.map(({ label, window }) => (
          <UsageGauge label={label} window={window} theme={theme} />
        ))}
      </box>
    ),
    { width: sidebarWidth, height: 12, exitOnCtrlC: false },
  )
  await setup.renderOnce()
  const lines = setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0)
  setup.renderer.destroy?.()
  return lines
}

describe("UsageGauge sidebar rows", () => {
  for (const width of [40, 32, 30, 29, 28, 27, 26, 24, 20]) {
    test(`aligns every row in a ${width}-column sidebar`, async () => {
      const lines = await renderRows(width)

      expect(lines).toHaveLength(ROWS.length)

      lines.forEach((line, i) => {
        expect(line.slice(0, LABEL_WIDTH).trim()).toBe(ROWS[i].label)

        const gauge = line.slice(LABEL_WIDTH, LABEL_WIDTH + GAUGE_WIDTH)
        expect(gauge).toHaveLength(GAUGE_WIDTH)
        expect(gauge).toMatch(GAUGE_CHARS)

        expect(line.length).toBeLessThanOrEqual(SIDEBAR_ROW_WIDTH)
      })
    })
  }

  test("renders each window on the same column grid", async () => {
    expect(await renderRows(40)).toEqual([
      "5h ░░░░░░░░░░░░░░   0% · 5h",
      "wk ░░░░░░░░░░░░░░   0% · 7d",
      "mo ████▋░░░░░░░░░  33% · 17d",
      "5h ██████████████ 100% · 12m",
      "wk ░░░░░░░░░░░░░░  <1% · now",
      "mo █▎░░░░░░░░░░░░   9%",
    ])
  })
})
