import { Plugin } from "@opencode/plugin"

// Server-side stub. The TUI extension lives in ./tui.tsx, loaded by the TUI
// through this package's "./tui" export (V2 plugin layout).
export default Plugin.define({
  id: "opencode-go-usage",
  setup() {
    console.log("[opencode-go-usage] plugin activated")
  },
})
