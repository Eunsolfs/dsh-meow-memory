# Hardening plan — fork 0.32.0 (working contract)

Fork of `Phant0Meow/dsh-meow-memory` v0.31.1 → this repo, branch `hardening`.
Goal: fix the four 90-blockers found in the pre-install audit (see `research/meow-memory-evaluation.md`
in the parent workspace): security P1s, unbounded token spend, dream auto-run traps, and design/compat debt.

Everyone: **only edit the files in your ownership list**, run `node build.mjs` + the tests you touch,
and report `git diff --stat` + test output. Do not reformat unrelated code. Keep the public plugin id
`meow-memory` and the `memory_*` tool names unchanged.

---

## 1. New config (Lead implements in `src/defaults.ts` + `src/index.ts` Config schema)

```ts
security: {
  trustWorkspaceMemory: false, // trust a non-empty memory.db that this plugin did not create
  allowHomeSwitch: false,      // allow the model to switch the global data dir via memory_home
  autoGitignore: true,         // write <projectDir>/.gitignore ("*") so memories never get committed
  debugLogs: false,            // verbose diagnostics files (settings-diag/apply-error/perf)
},
budget: {
  snapshotMaxChars: 6000,      // first-turn long-term memory cap
  hitMaxChars: 1500,           // per injected keyword-hit entry cap
  reinjectMaxChars: 8000,      // post-compaction re-injection cap
  dreamMaxContextTokens: 40000,// skip auto-dream when the session context is bigger than this
  dreamMaxPerWindowPerDay: 1,  // auto-dream frequency cap
  reflectMaxPerDay: 6,         // reflection frequency cap
  reflectMinIntervalMinutes: 20,
},
retrieval: {
  halfLifeDays: 30,            // exponential recency half-life
  minScore: 0.35,              // keyword-hit injection threshold
  hitBoost: true,              // reinforce by hit_count
  importanceWeight: true,      // importance participates in ranking
},
dream: {
  ...existing,
  requireLiveAgent: true,      // never agents.resume() for auto-dream (fix #49)
},
```

All new fields optional with these defaults. `promptLang`, `projectDir`, `hitTopK`,
`reflect`, `reflectTurns`, `autoMigrate` keep their current meaning; **`autoMigrate` default flips to `false`**.

---

## 2. Ownership (Phase 1)

| Owner | Files | Work |
|---|---|---|
| Lead | `src/index.ts`, `src/defaults.ts`, `src/tools.ts`, `package.json` | config schema/defaults, trust-aware wiring, memory_home gate, memory_list/memory_forget, connection re-read, diagnostics gating, ToolCallKind, version |
| T1 `db-trust` | `src/db.ts`, `src/home-dir.ts`, `src/migrate-v0.ts`, `src/prompt-loader.ts` | trust marker + `.gitignore`, indexes, hit_count API, v4 migration filename, override dir decoupled from homeDir |
| T2 `retrieval` | `src/bm25.ts`, `src/inject.ts` | exponential recency + hit boost, coverage fix, minScore, importance weight, size caps, trust-aware injection |
| T3 `cost-stability` | `src/dream.ts`, `src/reflect.ts` | no resume, live-agent gate, context-size cap, per-day caps, min interval, skip archived/oversize, dream list cap |
| T4 `docs-i18n` | `README*.md`, `docs/*.md`, `CHANGELOG.md`, `src/i18n/*.ts`, `src/prompts/**/*.md` | honest docs (0.2.1 compat, cost, security model, install), new i18n keys, prompt fixes |
| T5 `verifier` | `test.mjs`, `tests/*.mjs`, `smoke.mjs` | run build/full tests/live load, update assertions for changed behavior, add `tests/hardening.mjs` |

Do not touch another owner's files. Cross-file contracts are below; if you need a change in
someone else's file, report it to the Lead instead of editing.

---

## 3. Interfaces

### `src/db.ts` (T1 produces, Lead/T2 consume)

```ts
export interface StoreTrust {
  trusted: boolean
  reason: 'created' | 'marker' | 'config-trusted' | 'foreign'
}
/** Called once per workspace at apply/first-use. Creates projectDir, .gitignore and .owner.json. */
export function ensureMemoryStore(
  workspace: string, dir: string,
  opts: { autoGitignore: boolean; trustWorkspaceMemory: boolean },
): StoreTrust
/** Cached trust for a workspace (undefined before ensureMemoryStore ran). */
export function storeTrustOf(workspace: string, dir: string): StoreTrust | undefined
/** Increment hit_count + last_accessed_at for one entry (no-op on unknown id). */
export function bumpHitCount(level: Level, id: string): void
```

Trust rules:
- `.owner.json` exists and matches `{schema:1}` → `trusted:true, reason:'marker'`.
- `memory.db` absent or all tables empty → create schema + marker → `trusted:true, reason:'created'`.
- `memory.db` exists and non-empty, no marker → `trusted:opts.trustWorkspaceMemory`, reason `'config-trusted'|'foreign'`.
- `.owner.json` is `{schema:1, installId, workspace, createdAt}` (installId = random per process/install persisted in global home).
- `.gitignore` content: `*\n` (self-ignoring directory), only when missing.
- The marker lives next to `memory.db` in `projectDir`; never in the workspace root.

### `src/inject.ts` (T2)

Add optional `trust?: { trusted: boolean }` to the existing options objects of
`buildInjection()` and the per-message hit builder. When `trusted === false`:
- first-turn snapshot omits soul/user/global rules (return the memory-guide notice only; Lead owns the
  user-facing "untrusted store" notice),
- per-message hits return `[]`,
- project panorama keeps working only if the entry rows are locally created (same DB → treat as untrusted too: return no rows).
Callers (Lead, `src/index.ts`) pass `trust` from `storeTrustOf(...)`.

### `src/bm25.ts` (T2)

```ts
export function recencyWeight(ageMs: number, opts?: { halfLifeDays?: number }): number
export function keywordHitScore(query, docs, opts: { k?, minScore?, hitBoost?, importanceWeight? }): Hit[]
export function search(query, docs, opts: { k?, now?, explain?, halfLifeDays?, minScore?, hitBoost?, importanceWeight? }): RankedHit[]
```
- Recency: `0.05 + 0.95 * exp(-ln2 * ageDays / halfLifeDays)` (min 0.05, at age 0 → 1).
  `importance >= 3` exemption stays only as a floor of 0.85.
- Hit boost: `* (1 + 0.15 * ln(1 + hit_count))`, cap 2.0, only when `hitBoost`.
- Coverage: **query coverage** = matchedQueryTokens / max(1, queryTokenCount) (NOT keyword count).
- Importance: when `importanceWeight`, multiply by `(0.85 + 0.05 * importance)` (imp 1 → 0.9, imp 4 → 1.05).
- `minScore`: filter final score below it in `keywordHitScore` (search keeps all hits unless given).
- Keep `search()` BM25 math unchanged; recency/importance still multiply the final score.
- `explain` must expose bm25/importance/recencyWeight/score consistently with the ranking.

### `src/dream.ts` / `src/reflect.ts` (T3)

- `dream.requireLiveAgent` default true: auto-dream only when `ctx.agents.get(sessionId)` returns a live agent;
  **never** call `agents.resume()` in the auto path. Manual `/dream`/`memory_dream` from a live window keeps working.
  Keep the `sessionController` code only for the manual path if it is safe, otherwise delete it.
- Skip auto-dream when estimated context tokens > `budget.dreamMaxContextTokens`
  (estimate from session events: sum of `JSON.stringify(event.data).length` / 3.5, cheap sample is fine).
- Auto-dream cap: `budget.dreamMaxPerWindowPerDay` (store counters in `dream_meta`); log skip reason.
- Dream entry lists: exclude `status='archived'`, cap to 60 newest rows per round.
- Reflection: only if `reflect` enabled; skip when (a) a reflection already ran within
  `budget.reflectMinIntervalMinutes`, (b) today's reflection count >= `budget.reflectMaxPerDay`
  (persist per workspace in DB `dream_meta`), (c) estimated context > `budget.dreamMaxContextTokens`.
- Route `dream-debug.log` to the global home dir (Lead passes `activeHomeDir()`), never into the workspace.

### `src/prompt-loader.ts` / `src/home-dir.ts` (T1)

- Prompt overrides must resolve from a **fixed** override dir (global home `overrides/`), not from a
  switchable `activeHomeDir()`, so `homeDir` switching can never change the injected instructions.
- `resolveHomeDir` keeps its current presets; add no new danger.

---

## 4. Lead-owned behavior (for reference)

- `src/tools.ts`: `memory_home` becomes query-only unless `security.allowHomeSwitch`; with switch disabled a
  target returns a clear refusal. New `memory_list` (level/project/status/limit/offset, returns ids+titles+keywords,
  no full content) and `memory_forget` (archive/unarchive/delete by id, requires `confirm: true`; delete is hard delete).
  `presentCall.kind`: `write` → `edit` (0.2.1 `ToolCallKind` has no `write`).
- `src/index.ts`: pass trust into injection, inject the one-time untrusted-store notice, re-read
  `ctx.get('connection')` per request instead of capturing once, gate diagnostics behind `security.debugLogs`,
  write global-home logs instead of workspace `dream-debug.log`.
- `package.json`: version `0.32.0`, description mentions hardened fork.

---

## 5. Definition of done (Phase 1)

1. `node build.mjs` exit 0.
2. `npm test` exit 0 after T5 updates assertions; new `tests/hardening.mjs` covers trust gating, caps,
   recency/coverage/threshold, memory_list/forget, home gate, dream skip without resume, reflect caps.
3. Isolated live load on DSH 0.2.1-rc.2: plugin loads, routes 200/401, settings ns present, no apply error.
4. Docs describe the new defaults, cost model, security model, and honest limits.
5. Fresh audit re-score (security/cost/stability/design/compat) with the same rubric as the pre-install report.
