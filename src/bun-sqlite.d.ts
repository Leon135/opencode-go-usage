// Minimal ambient types for "bun:sqlite": the plugin runs inside the
// bun-compiled OpenCode binary, where only Bun's builtin sqlite is available
// ("node:sqlite" does not resolve under Bun). Declare just what readGoKey uses.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean })
    prepare(sql: string): { get(...params: unknown[]): unknown }
    close(): void
  }
}
