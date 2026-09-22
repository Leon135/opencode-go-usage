import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./src/index.ts", "./src/tui.tsx"],
  target: "bun",
  outdir: "./dist",
  plugins: [solidPlugin],
  external: ["@opentui/core", "@opentui/solid", "solid-js", "@opencode/plugin"],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Strip bundler breadcrumb comments ("// node_modules/...") from the output.
for (const output of result.outputs) {
  const source = await output.text()
  await Bun.write(output.path, source.replace(/^\/\/ .*$/gm, "").replace(/^\n+/, ""))
}

console.log("built:", result.outputs.map((o) => o.path).join(", "))
