# Phase 2 plan — user-scope memory + isolated consolidation (0.33.0)

Phase 2 turns the fork from "per-workspace memory with honest docs" into "user-scope memory +
bounded, out-of-band consolidation". The pre-fork design audit named three architectural blockers
for a 90+ score:

1. **"Global" memory is per-workspace.** soul / user / global rules live in `<cwd>/.dsh-meow/memory.db`,
   so every new working directory starts empty. Fix: a **user-scope global store** under the
   instance global home, layered under the workspace store.
2. **Keyword-only recall.** Fix: hybrid lexical scoring (BM25 + CJK n-gram fuzzy complement) and
   keyword-variant guidance; keep it dependency-free and offline.
3. **Consolidation runs in the main session context.** Fix (separate workstream): dream/reflection
   in an isolated subagent/session so the main log doesn't grow by 8–15k tokens per dream.
   This plan only prepares the interface; implementation is Round 2.

---

## 1. Layered store model (Round 1 of Phase 2)

```
<activeHomeDir>/global/memory.db     ← user-scope: soul, user, rules(全局)
<workspace>/.dsh-meow/memory.db      ← workspace-scope: project, fact, lesson, topic, rules(项目)
```

- The global store is ours (under our home) but still carries an `.owner.json` marker
  (installId + workspace-less marker) so a copied/synced global dir from another machine is
  rejected; `ensureGlobalStore()` returns `StoreTrust`.
- **Backward compatible fallback**: if the global store is empty/absent, snapshot reads
  soul/user/global-rules from the workspace store exactly like 0.32. Once migration runs,
  global wins (dedupe by id — migration copies rows preserving ids, then archives the
  workspace originals so dream/list don't double-count).
- Migration is lazy, per workspace, only for **trusted** workspace stores, idempotent, and
  recorded in `dream_meta` key `globalmigrated:<version>:<dir>`:
  1. copy levels `soul`, `user` and `rules` rows whose project is global (via `isGlobalScope`)
     from workspace DB into global DB **with the same id** (new `MemoryDb.insertRow`);
  2. archive the copied workspace rows (`status='archived'`) so injected/ dream lists don't
     duplicate them; content remains recoverable.

## 2. Interfaces

### `src/db.ts` (db-trust)
```ts
export function globalDbPath(): string            // join(activeHomeDir(), 'global', 'memory.db')
export function getGlobalDb(): MemoryDb           // cached instance
export function ensureGlobalStore(): StoreTrust   // marker in <activeHomeDir>/global/.owner.json
export function closeAllDbs(): void               // also closes the global DB
// MemoryDb:
insertRow(row: MemoryRow & { level: Level }): MemoryRow   // insert with caller-supplied id (for migration)
```
`ensureGlobalStore()` uses the same installId marker logic as workspace stores but without a
workspace-path binding (marker.workspace = '').

### `src/global-store.ts` (new, db-trust)
```ts
export function migrateWorkspaceToGlobal(workspace: string, dir: string): { copied: number; archived: number; skipped: boolean }
export function globalStoreRows(): { soul: MemoryRow[]; user: MemoryRow[]; rules: MemoryRow[] }
```
`migrateWorkspaceToGlobal` must be safe to call on every first session per workspace (idempotent
via `dream_meta`), never throw (best effort, log via console.warn), and only run when
`storeTrustOf(workspace, dir)?.trusted === true`.

### `src/inject.ts` (retrieval)
- All builder options gain `globalDb?: MemoryDb` (undefined = 0.32 behaviour).
- Snapshot: soul/user/global-rules read from `globalDb` when provided **and** it has rows;
  otherwise from workspace DB. Dedupe by id (global precedence).
- Per-message hits: `rules` from both stores (global rules from global DB; project rules from
  workspace); dedupe by id; other levels workspace only.
- Project panorama (`memory_project`, reinjection) stays workspace-scope.
- Caps unchanged.
- Hybrid lexical scoring in `bm25.ts`: add `fuzzyScore` using character trigram/bigram Jaccard
  over the match surface (works for CJK without spaces), blended only when BM25 has no/weak
  match: `score = max(bm25Score, 0.55 * fuzzyJaccard * recency * importance)`. Zero new deps,
  deterministic; expose in `explain` as `fuzzy`.

### `src/tools.ts` (Lead)
- `registerMemoryTools(..., opts: { allowHomeSwitch?, globalDb?: () => MemoryDb | undefined })`.
- Write routing: level `soul`/`user` → global DB; `rules` with global project → global DB;
  everything else workspace. Dedupe/merge checks the target DB.
- Read/update/forget/list/find-similar/search read both DBs and dedupe by id (workspace wins on
  id collision for project levels; global wins for soul/user/rules-global).
- `memory_list`/`memory_search` merge both sets, then filter/sort/paginate.
- `memory_project` workspace only.

### `src/index.ts` (Lead)
- At apply (after home switch): `ensureGlobalStore()`; export a `globalDb()` getter.
- On first trusted pre-step per workspace: `migrateWorkspaceToGlobal(ws, dir)` once.
- Pass `globalDb` into injection builders and tool registration.
- System prompt/guide: one short line that soul/user/global rules are user-scope.

## 3. Non-goals for this round
- Isolated dream/subagent consolidation (Round 2; the host `subagents` service exists —
  `ctx.get('subagents').startActivation(...)` — feasibility to be proven in a spike).
- Semantic embeddings (no embedding provider in this host; hybrid stays lexical/fuzzy, documented).

## 4. Definition of done (Phase 2 Round 1)
- `node build.mjs` + `npm test` green (existing assertions updated where behaviour intentionally
  changes: snapshot source, tool routing, migration).
- New hardening tests: global store created/trusted; migration copies soul/user/global rules,
  archives workspace duplicates, idempotent; snapshot uses global when present and falls back
  when empty; tool write routing; search/list dedupe; untrusted workspace never migrates.
- Isolated live load on 0.2.1-rc.2 stays green.
- Docs: storage model, migration, fallback, uninstall paths updated; version 0.33.0.
