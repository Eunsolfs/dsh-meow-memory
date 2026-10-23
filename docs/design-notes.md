# Design notes (0.32 fork)

Why meow-memory is built the way it is: trade-offs and pitfalls, not a feature list. The 0.32 principle: keep upstream's correct transport/scheduler design, replace inflated claims with real boundaries, and turn unbounded cost into bounded cost.

---

## 1. Static manual in the system prompt, dynamic content in the first user message

| Content | Where | Why |
|---|---|---|
| Static memory manual (overview + tool usage + writing rules) | A fixed **system prompt** section (`meow-memory:guide`, order 130) | Constant text, so it cannot break the provider's prefix cache |
| Dynamic content (full soul/user, global rules, memory guide) | Prefix of the **first user message** | Varies per workspace; in the system prompt it would invalidate the cache every time |

Memory is injected as an independent plugin snapshot message **before** the real user message; the user prompt is never rewritten.

Cost: the static part (manual + every tool description/schema) is paid on **every request** — ≈6.7k tokens for the Chinese pack (measured), ≈6.3k for English. This is the plugin's largest fixed cost and 0.32 states it in the README.

---

## 2. No keyword hits on the first turn

The first turn injects only the long-term snapshot; hits start from the second user message. Rationale: the first user message can arrive in the same batch as plugin notices (e.g. an approval-policy change), and a hit on that turn would attach to the notice instead of the real user message. The snapshot is pinned immediately before the real user message; hits never arrive early.

---

## 3. Hits match keywords, not full text (and the real score)

Full-text matching is noisy. Hits therefore match entry keywords. **There is no vector/semantic retrieval by default**; 0.35 adds an **optional** semantic layer (off by default, zero network).

0.32 per-message score (`keywordHitScore`):

```
keyword intersection × IDF × query coverage × exponential recency × importance weight × title boost
```

- **Query coverage** = matched query tokens / total query tokens. The old denominator was the entry's keyword-token count, so following the prompt's "8–13 keywords" instruction *lowered* the score — a self-defeating design fixed in 0.32.
- **Exponential recency** = `0.05 + 0.95·exp(-ln2·ageDays/halfLifeDays)`, default half-life 30 days; `importance ≥ 3` only keeps a 0.85 floor. **Since 0.35.1 age = `now − max(updated_at, last_accessed_at)`**: injection hits and `memory_search` hits update `last_accessed_at`, so recently recalled memories decay more slowly (rehearsal-style); there is still **no review-count model or scheduling**, and `updated_at` is still refreshed by dream sealing/update — not a full Ebbinghaus implementation.
- **Hit reinforcement** = `×(1 + 0.15·ln(1+hit_count))`, cap 2.0 — `hit_count` was write-only upstream and now participates in ranking.
- **Importance weight** = `×(0.85 + 0.05·importance)`.
- **`retrieval.minScore`** (default 0.35) filters out weak hits.

`memory_search` is a separate **BM25** scorer (`ln(1+(N−df+.5)/(df+.5))`, k1=1.5, b=0.75, length normalisation + recency). The docs no longer conflate the two.

**0.33 hybrid lexical floor (fuzzy)**: BM25 is exact whole-word/bigram matching, so morphological variants, inflections and CJK word-boundary differences are missed. A pure character-level similarity is added (zero-dependency, offline, deterministic): character bigram Jaccard + **0.25×trigram Jaccard** (NFKC, lowercased, letters/digits only; CJK needs no segmentation), noise floor 0.2. It is only a **floor**: `score = max(BM25, 0.55·fuzzy·recency·importance)`; strong BM25 hits keep their ordering, and the complement only rescues recall when BM25 is 0/weak (per-message chain: `relevance = max(BM25 relevance, fuzzy)`, then multiplied by recency). **Not embedding/semantic retrieval** — it covers lexical variants/inflections/word boundaries only; paraphrases can still be missed. No config toggle (pure BM25 is a test/internal option).

**0.35 optional semantic floor (`retrieval.semantic`, off by default; 0.35.1 audit fixes)**: when enabled, `semantic.ts` calls an OpenAI-compatible `/embeddings` endpoint and cosine similarity is **also only a floor**: `relevance = max(lexical, fuzzy, cos·weight·importanceWeight)`, with a **0.25 noise floor** (cos < 0.25 counts as 0; negative/zero similarity counts as 0); `memory_search` multiplies by recency and `explain` gains `semantic`. **No rerank** — weak matches can slip in. Off (default) = **zero network** (with no endpoint configured `semanticEnabled()` is false and every call site short-circuits; network access lives only in `semantic.ts`, which static audit can prove). **Transport policy (0.35.1)**: only `https://` or loopback `http://` (localhost/127.x/[::1]); a remote plain-http base is rejected and falls back to lexical with zero requests (so bodies/queries/Bearer never cross the network in cleartext). **Latency**: a hanging endpoint adds up to `timeoutMs` (5s default) to each message/search/write — no throw, lexical results still returned (connection-refused fails fast); "never blocks" was too strong and is now "bounded by timeoutMs". Data/privacy: when enabled, **memory bodies/titles/keywords** and **user message/query text** go to your configured endpoint; the key comes from an env var (default var unset → keyless requests; only a custom var name that is missing counts as unconfigured). Failure/timeout/non-2xx/bad shape → null, **never throw**, silently falling back to lexical. The write path (`memory_remember`/`memory_update`) embeds inline after the write; plugin apply **backfills in the background** the global store and each trusted workspace (≤50 rows/level; **since 0.35.1 a cold start judges trust read-only first**, foreign skipped; retried next start); embeddings live in a lazy nullable `embedding TEXT` (JSON) column per table — **≈31 KiB/row at 1536 dims (1k entries ≈30 MB)**, plaintext derived data. **No local model is bundled**; changing the embedding model invalidates stored vectors (different dimensions count as 0).

---

## 4. "Seen" is tracked per session

Seen memories (`injected` + `searched`) live in `sessions/<id>.json`: injection never repeats; `memory_search` takes the first 5 by relevance without excluding seen entries and fills the rest while skipping them; a compaction signal releases the seen set.

---

## 5. Post-compaction re-injection now has a cap

After compaction the next turn re-injects the snapshot, project panoramas fetched this session, and entries written/updated this session. Upstream had **no character cap** here (8 projects × 613-char boilerplate + 20 entries, worst case 16k+ tokens); 0.32 adds `budget.reinjectMaxChars` (default 8000 chars).

---

## 6. Per-window dream, and the cages added in 0.32

A window idle ≥ `idleMinutes` (default 3 h) becomes eligible and its own main agent consolidates in three rounds: (1) atomic project/fact/lesson/rules/soul/user; (2) topic; (3) project summary.

Cost: each round is a **full-context request** — ≈90k input tokens for a 30k-token session, ≈300k for 100k. Instructions, responses and tool calls stay in the main session log (the UI fold is visual only): ≈+8–15k durable tokens per dream.

0.32 gates (all must hold for an automatic dream):

| Gate | Default | Fixes |
|---|---|---|
| Window has a **live agent**; never `agents.resume()` | `dream.requireLiveAgent: true` | #49 (resumed bare agent loses 26 host tools) |
| Estimated context ≤ `budget.dreamMaxContextTokens` | 40000 | prevents oversized dream / bill blow-up; **later rounds re-estimate** and finish early if oversized (entries stay unsealed, can be re-dreamed later) |
| Per window per day ≤ `budget.dreamMaxPerWindowPerDay` | 1 | unbounded frequency |
| Process-wide per day ≤ `budget.dreamMaxPerDayTotal` | 12 | N windows no longer mean N× automatic spend (process-scoped rolling 24h, reset on restart) |
| Exclude `archived`; cap each round's list at 60 (newest `updated_at`) | fixed | archived rows were re-fed forever and prompts grew monotonically; recently-touched old entries are no longer starved |
| Skip reason logged | — | explainability |

Manual `/dream` / `memory_dream` bypass all of these automatic gates (manual = explicit intent; only the automatic path calls `evaluateAutoDreamGate`): peak/frequency/live-agent/context gates do not apply, and they run up to 3 rounds over the **full session context** (atomic / topic / project summary). If the context is large, run `/compact` first.

**0.34 isolated path (`dream.isolated: true`, off by default)**: automatic dream runs in an **empty-context spawn child** (provider with `inheritsParentContext === false`), so the main session has no model-visible dream turn → **zero main-context growth**. The child prompt = the three dream prompt slots + a digest of recent user/assistant text and tool names (no tool results/plugin notices) + entry lists, capped by `isolatedMaxPromptChars` (default 20000 chars); **consolidation quality is therefore lower than the main-context path**. The main-context size gate does not apply to the isolated path (the child prompt is capped independently); frequency/cooldown/peak/process-wide caps still apply. On success, `adoptSessionEntries` reassigns child-written entries to the parent before sealing (partial results kept); failure/timeout/abort falls back to the main agent; HMR/dispose cancels in-flight runs; `delegate.model` is reused for the child. **Isolated dream cannot be aborted from the UI.**

---

## 7. Peak-hour suppression (defaults may not fit your provider)

`suppressWindows` defaults to 09:00–12:00 and 14:00–18:00 in `Asia/Shanghai`, plus 15 minutes before each. Those defaults come from upstream and follow GLM/Zhipu peak-tariff hours, not DeepSeek's discount window. Adjust to your provider.

---

## 8. Rules anti-churn

`dream.rulesReviewDays` default 2: stable `rules` whose `updated_at` is older than that skip dream round 1; `0` = no filter.

---

## 9. Restore-default vs. patch baseline

"Restore default" means **the plugin's factory default**, not the patch assembly baseline. Factory defaults are a single source (`src/defaults.ts`) shared by host and client. The 0.32 `security`/`budget`/`retrieval` fields are **not surfaced in the settings page**, so restore-default is unaffected.

---

## 10. Consolidation always runs in the main window

Forked sub-agent execution was removed in v0.24. Reflection and dream turns always run in the main window (steer); prompts, responses and tool calls land in the main session log (folded visually). Model override is `delegate.model`, implemented statelessly via the `agent/request` waterfall.

> #71 (unfixed upstream): with `delegate.model` set, a host-side `request/header` projection bug can leave later requests on the delegate model. Default empty value does not trigger.

---

## 11. Dream de-duplication

Four mechanisms: DB-atomic 60 s check throttle, idempotent start claim (`dream_pending`), interruption self-healing, orphan finalisation (cross-instance / hot reload). Injected plugin turns do not refresh window activity, so a dreamt window is not dreamt again.

> #66 (not fully fixed upstream): after a dream the session tool set can lock to 9 memory tools until dsh restarts; the plugin sets no tool filter, which points at host background-turn policy. 0.32's automatic dream now uses the live-agent path, but manual dream can still trigger it.

---

## 12. Session-list icons touch only their own nodes

The icon is appended to the session row's state slot; only its own node is added/removed — never React-owned children. Row identity is read from the React fiber (`__reactFiber$`) render key = session id. Data flows through a shared 60 s polling diff.

This is a **best-effort dependency on host internals**: a 0.2.x patch can silently disable it. Cosmetic only.

---

## 13. The global marker follows the language pack

`project.global` comes from the current `labels.md` (`全局` in zh, `global` in en/pt-br). It must follow `promptLang`, otherwise `"global"` entries in English mode become a project named global. Missing values fall back to the truth value rather than throwing on the retrieval hot path.

---

## 14. Zero runtime dependencies

`node:sqlite` (Node ≥22.13 by default; 22.5–22.12 needs `--experimental-sqlite`) + a self-contained esbuild bundle (`lib/index.js`). No native modules.

---

## 15. The 0.32 trust model

Three gates fix #64-1 / #64-2:

1. **Workspace store trust marker**: only when the `memory.db` file **does not exist at all** is it created and trusted; **any pre-existing store (even schema-only / row-empty) is untrusted by default** (closes "pre-seeded empty DB + SQLite triggers" poisoning). Creating a store writes `.owner.json` (`{schema:1, installId, workspace, createdAt}`); trust requires `installId` to equal this machine's **random** install id (`$DSH_HOME/storages/meow-memory/install-id`, not a machine fingerprint) and `workspace` to match the current path; forged/other-machine/moved markers are rejected, and a non-persistable install id is **fail-closed**. An untrusted store is **never opened by normal chat turns** (no upgrade/index/migration/read — read-only probe only); its content is not injected and **memory tools (read/write), dream and reflection are refused**, with a one-time notice. Only `security.trustWorkspaceMemory: true` allows it. `autoMigrate` now defaults off so a workspace's `PROJECT.md` is never imported without consent.
2. **`memory_home` query-only by default**: the tool is model-callable, and moving the global directory changes where logs / window index / migrate state live — a filesystem side effect the model should not have. Switching now requires `security.allowHomeSwitch: true`.
3. **Fixed prompt-override directory**: overrides resolve only from `$DSH_HOME/storages/meow-memory/prompts/` (`$DSH_HOME` defaults to `~/.dsh`), which does **not** follow `homeDir` / `memory_home` / `MEOW_MEMORY_HOME`; the old location is no longer read (no fallback).

Also: workspace paths are compared after **realpath normalisation** (junction / mapped-drive / subst aliases no longer look foreign; unresolvable aliases still fail closed), and the trust gate covers **HTTP data routes, session window-activity tracking and startup window-index restore** (0.32.1: none of them open/upgrade an untrusted store just for bookkeeping; POST `skip-dreams` returns 403 for untrusted). The global store is trust-gated too (`<activeHomeDir>/global/.owner.json`, installId marker, `workspace: ''`; a copied/synced global dir is foreign, and there is no `trustWorkspaceMemory`-style override — see §16). Creating the memory directory writes a self-ignoring `.gitignore` (`*`; if a pre-existing one lacks a `*` line, one is appended to block `!*` re-inclusion) so `git add .` cannot commit plaintext memories. `security.debugLogs` gates `perf.log` and settings/configEditor dumps; `dream-debug.log` is still written by default with minimal info (session ids/counts/skip reasons, no memory text; 48h cleanup, 5MB rotation), and error logs are error-only. Uninstall leaves data on purpose (the plugin must not delete memories for the user). The store is **not encrypted** — plaintext SQLite; disk/backups/sync remain the trust boundary.

---

## 16. 0.33 user-scope global memory and layered storage

0.32's "global" was global only inside one workspace; 0.33 makes it a **user-scope** two-layer store:

```
<activeHomeDir>/global/memory.db        ← user-scope: soul / user / rules(global), across workspaces
<workspace>/<projectDir>/memory.db      ← workspace-scope: project / fact / lesson / topic / rules(project)
```

- **Why not move everything into the global store**: project/fact/lesson/topic are workspace semantics (the project context of one cwd); putting them in the global store would cross-contaminate projects. soul/user/global rules are "who the user is" and naturally cross-workspace. Layering puts each kind of memory at the right lifetime.
- **Migration**: the first trusted session in each workspace copies existing soul/user/global rules **by original id** into the global store (ids/timestamps preserved so injection dedupe and links keep working), then **archives the workspace originals** (recoverable; otherwise snapshot and dream would double-count). Idempotency flag in workspace `dream_meta` (`globalmigrated:v1:<dir>`); only trusted workspaces are migrated, foreign stores are never touched (migration never reads across a trust boundary).
- **Fallback**: an absent/untrusted/unavailable global store falls back to 0.32 single-workspace behaviour, so a deleted global store or one synced from another machine can neither break the plugin nor inject foreign data as user memory.
- **Global store trust gate**: `<activeHomeDir>/global/.owner.json` (installId marker, `workspace: ''` — no workspace binding); absent → created, pre-existing without a valid marker → foreign; there is **no `trustWorkspaceMemory` config override** (the global store is "the user's own" data; no "trust an unknown store" switch).
- **Tool routing**: writes are routed by level (soul/user/global rules → global store); reads query both stores and dedupe by id (same id: **active wins over archived**, so a migration archive copy cannot shadow the original); `memory_project` reads the workspace store only (project panorama is workspace semantics).
- **Windows EPERM**: `homeDir` / `memory_home` switches move the global store; the connection is closed first via `closeGlobalDb()` (on Windows an open SQLite file blocks the rename).

**Known boundaries**: dream/reflection still consolidate the workspace DB only (global entries are maintained via tools/reflection); migration archives workspace originals and a lost global store is not re-injected automatically; since 0.34 `backup.enabled` backs up both the workspace store and the global store (an empty/untrusted global store is skipped).

---

## 17. 0.34 isolated dream (zero main-context growth)

0.33's automatic dream was still a full-context request inside the main session: it left the dream instructions/replies/tool calls in the main log (≈+8–15k durable tokens per dream), and large windows were blocked by the `dreamMaxContextTokens` gate. 0.34 moves **automatic** dream into an **isolated spawn child** (off by default):

- **Why spawn, not fork**: `fork` inherits the parent's full transcript (i.e. copies the main context again); `spawn` is a fresh empty-context session that only receives the prompt/digest/lists we build, so the main session grows by **zero**.
- **Process/cross-process semantics**: leases still live in the workspace DB (`claimDream`/heartbeat) and `dreamiso:<sid>` metadata records in-flight tasks for diagnostics; the child calls `memory_*` in the same workspace/cwd (**inheriting the parent's agent preset**, so tool visibility depends on that preset); on success `adoptSessionEntries(childId, parentSid)` reassigns `source_session` to the parent, then the existing `stampDream`/`finishDream` finalises; failure/timeout/abort uses the existing failure counter and retries (seals at 3), then falls back to the main-agent path.
- **Start compat (fixed in 0.34.1)**: 0.34.0's `startActivation` sent `request.maxDepth: 0`; DSH 0.2.1 reads `maxDepth` as the **child's own allowed depth** and rejected the start with `SubagentDepthError: subagent depth 1 exceeds maxDepth 0`, so with `dream.isolated: true` automatic consolidation never ran. 0.34.1 sends **no `maxDepth`** (host default 1). A rejected start (sync or async — depth/capacity/auth) is no longer swallowed: sync failure returns `'unavailable'` and the same sweep falls back to the main-agent dream; an async rejection releases the lease and starts the main-agent dream in the same sweep (log `isolated-dream rejection -> main-dream fallback`).
- **Lifecycle**: timeout `isolatedTimeoutMinutes` (default 20 min) disposes the child and releases the lease; HMR/dispose calls `disposeIsolatedDreams()` to cancel in-flight runs and release leases (no zombie leases); `isolatedArchiveChild` archives the child in the settle `finally` (**success and failure**, leaving a plaintext child-session copy).
- **Cost vs quality**: child tokens are still billed; the digest only contains recent user/assistant text + tool names (no tool results) and the prompt is capped by `isolatedMaxPromptChars`, so **consolidation quality is lower than the main-context path**; and it **cannot be aborted from the UI**. The main-context size gate does not apply to the isolated path; frequency/cooldown/peak/process-wide caps still do.
- **Fallback**: missing `subagents` service / `spawn` provider or `inheritsParentContext !== false` → one log then the 0.32 main-agent dream; a rejected start falls back too; the main-agent path remains (manual `/dream` always uses it).

---

## 18. 0.35 optional semantic retrieval (offline by default)

0.34's retrieval had only BM25 + character n-gram fuzzy, so paraphrases could still be missed. 0.35 adds an **optional** embedding semantic layer, with the default kept at **off**:

- **Why off by default**: embeddings require an external service (no local model is bundled), and enabling it means sending **memory bodies and user query text** to that service; off = zero network and zero privacy exposure, behaviour identical to 0.34.
- **Why a floor, not a rerank**: same idea as fuzzy — the semantic score only rescues recall when lexical matching is weak, so it cannot outweigh an exact keyword hit; the trade-off is that weak matches can slip in. The **0.25 noise floor** stops unrelated entries surfacing on tiny similarity; negative/zero similarity counts as 0.
- **Data flow**: `semantic.ts` owns all networking (`POST {baseUrl}/embeddings`, LRU 256); the write path embeds inline (bounded by `timeoutMs`); after plugin apply it backfills historical entries in the background (global store + each trusted workspace, ≤50 rows/level, silent failures retried next start). `embedding` is a nullable JSON `TEXT` column added lazily to all 7 tables and travels with the DB/backups.
- **Failure semantics**: timeout/network error/non-2xx/bad shape/missing `fetch` → null, caller silently falls back to pure lexical; a broken semantic layer only adds bounded latency (≤`timeoutMs`) and does not make injection/retrieval/writes fail.
- **Known boundaries**: no local model; vectors are model-specific (different model/dimensions → score 0, re-write or re-backfill); **since 0.37 these fields are editable on the settings page** (Retrieval & forgetting group; the 0.2.x save→apply path is still not live-verified); `weight: 0` only disables semantic scoring — set `enabled: false` to stay fully offline.

---

## 19. 0.36: global-memory visual editor + next-turn re-injection

User-scope global memory (soul/user/global rules) used to be maintainable only through the model tools or by editing SQLite directly. 0.36 adds a **user-explicit** visual editor in the settings page and makes its saves actually affect future sessions without adding automatic spend.

- **Why the settings page instead of a new tool**: editing user-level long-term memory is the user's own decision and should not consume model turns or drag the model into UI interaction; the settings page is an explicit user channel, close in authority to manual `/dream` (dream may still reorganize entries afterwards). **No new tool, no new config fields.**
- **Data path**: settings UI → plugin-private `GET/POST /meow-memory/global-memory` (same auth gate as the other plugin routes) → `global-edit.ts` pure data layer → global store. The list contains only soul/user/global rules (incl. archived/stale); writes validate content 1–4000, keywords ≤30 (empty derives from content tokens), importance 1–100; no hard delete (archive); concurrent edits to the same id are **last-write-wins**.
- **Why mark sessions instead of rewriting history**: already-sent injection messages are history; rewriting them would break session consistency and may double-count tokens. 0.36 reuses the existing post-compaction re-injection channel: after a successful save the host marks related sessions for `reinject` — window-index sid→workspace plus `sessionPersistence` sessions (**since 0.36.1 read via `headerOf`, covering both the header shape `{header:{id,cwd}}` and the flat `{id,cwd}` shape**; 0.36.0 read only the flat shape and missed cold sessions), requiring an existing **trusted** memory.db; at most **2000** sessions per save, already pending marks are not rewritten (idempotent). Those sessions re-inject the updated global memory on their **next user message** and clear the mark. **Zero immediate tokens**, no extra model request; sessions with no next message keep the old snapshot. Archive/restore trigger it too (the injected content changed).
- **Why only the global store**: workspace stores are per-cwd project context and should not be batch-rewritten by a cross-workspace editor; with an untrusted/foreign global store the editor shows a warning and refuses writes (it never opens a foreign store), consistent with the trust model.
- **Semantic interplay**: content/keywords changes clear that entry's embedding (no stale-vector recall); the next apply's background backfill or a later write rebuilds it; importance-only saves keep it. The editor itself makes no embedding requests.
- **Residual boundaries**: global scope only; effective on the session's next user message; marking is bounded (≤2000 sessions per save); no hard delete / bulk import / conflict merge; the routes are plugin-private (not a public API); last-write-wins; archived entries are not injected but remain in the store.

> **0.36.1 fix**: 0.36.0's "cold sessions are marked too" only held for flat `{id,cwd}` persisted sessions; DSH 0.2.1's header shape `{header:{id,cwd}}` was missed. 0.36.1 reads through `headerOf()` and adds a 2000-session marking cap, with regression tests covering header-shaped cold sessions.

---

## 20. 0.37: settings-page parity + stability wrap-up

The advanced knobs from 0.32–0.36 were profile-patch-only; the user explicitly asked to edit them in the settings page. 0.37 closes that gap and fixes four stability issues found by an independent re-audit.

- **Settings parity**: four new groups under "Meow memory" — Security & privacy (`security.*`, with a danger warning on `trustWorkspaceMemory`), Budget & caps (9 `budget.*`), Retrieval & forgetting (`retrieval.*` + nested `retrieval.semantic`), Isolated dream (`requireLiveAgent` + `isolated*`). **37 new UI keys** ×3 languages. Fields still use the patch as the assembly baseline; UI saves write the user layer.
- **Nested sub-object saves**: saving `retrieval.semantic.*` only merges that sub-object into the `retrieval` user layer — it does not wash the other base keys into the user layer (otherwise a single semantic toggle save would freeze the whole base retrieval into the user layer). "Restore default" writes the factory default back (badge shows default; nested fields likewise write default values into the user layer — pre-existing design, not a regression).
- **Effect semantics**: saves generally need a hot reload/restart (existing 0.1.x semantics); hot fields (injection/reflection/dream) auto-correct once the settings namespace is ready. The 0.2.x "save → apply" path still has no live click-through (rendering and save RPC shape are unit-tested).
- **Stability fixes**: (1) on isolated-dream success, child-written rows are adopted into the parent session in **both** the workspace DB and the **user-scope global DB** (0.36 adopted only the workspace DB, leaving global rows with orphan attribution but still globally effective); (2) the dream check gate only claims `last_check` on **existing + trusted** DBs (foreign/missing DBs get no diagnostic write); (3) `handleMemoryTurnFailure` trust-guards before opening the DB (an untrusted store is not opened/upgraded/rewritten; tests assert byte-identical); (4) the `workspaceRegistry.archiveSession()` promise rejection is caught (no unhandled rejection, the dream still finalizes).
- **Known minors**: `dream_meta.last_check` stores a number while the public `getDreamMeta()` only reads strings (diagnostics see undefined; gate behaviour is correct); nested-field "Restore default" writes the default into the user layer (badge is correct).

---

## 21. 0.37.1: settings save path (merge/validation/danger confirmation)

After 0.37 moved the advanced fields into the settings page, re-audit found three save-path problems; 0.37.1 fixes them:

- **Group merge**: the settings user layer is designed as "field-level overrides over the patch", but 0.37.0 replaced whole groups for `security`/`budget`/`retrieval` — saving one field silently reverted the patch's other keys in that group (most notably `budget.dreamMaxPerDayTotal` 2→12 = higher cost, dropped `retrieval.semantic.baseUrl/model`, reverted trust-related patch keys). 0.37.1 **shallow-merges** `security`/`budget`/`retrieval`/`dream`/`delegate` and **deep-merges `retrieval.semantic`** one level further; the patch remains the assembly baseline, and hand-edited patches are no longer lost by unrelated UI saves.
- **Validator + strict coercion**: `validateConfigUserLayer` now type-checks the new groups (incl. nested semantic/dream isolated); `resolveConfig` no longer trusts object fields directly and uses `asBool/asNum/asStr` — strings `"false"`/`"true"`/`"12"` always fall back to defaults and can neither enable a security switch nor set a numeric knob (a real boolean `true` still works). This is defence in depth: callers bypassing the validator (old host/direct apply) cannot poison security switches either. The validator's nested `retrieval.semantic` lookup was also fixed (it previously searched a top-level group, rejecting all semantic field saves).
- **Danger toggle confirmation**: `trustWorkspaceMemory` uses danger styling + `window.confirm` (localized warning: trusts all existing foreign stores, possibly tampered); cancel rolls the checkbox back and writes nothing. `allowHomeSwitch`/`debugLogs` got hints; `dream.isolated` discloses the tool-capable child, workspace/global writes, and no-UI-abort. Three new UI keys → 40 advanced keys total.
- **Residual boundaries**: native confirm has no undo/custom modal (P3); `allowHomeSwitch` is not confirmation-gated (P3); the 0.2.x settings save→apply path still has no live click-through (the page shows an explicit error on failure).

---

## 22. Known design debt (updated in 0.37.1)

| Issue | Impact | Why |
|---|---|---|
| **Project-level memory is still workspace-scoped** | `project` / `fact` / `lesson` / `topic` follow the cwd; a new workspace starts with fresh project memory (soul/user/global rules are cross-workspace since 0.33) | Sharing project memory needs a store-ownership model; left for later |
| **No semantic recall by default** | `retrieval.semantic` is off; without it only BM25 + fuzzy run, so paraphrases can still be missed | The semantic layer needs an external embedding service; off is the privacy/availability choice (opt-in) |
| **Semantic layer is a floor, not a rerank** | Above the 0.25 noise floor weak matches can enter; semantic ordering quality is not guaranteed | Same trade-off as fuzzy: avoid outweighing exact keyword hits; reranking needs a trusted cross-encoder |
| **Semantic vectors are model-bound** | Changing the endpoint model/dimensions makes old vectors score 0; stored vectors are not recomputed automatically | Vectors are model-specific; re-write entries or clear and re-backfill |
| **`dream_meta.last_check` reads as undefined in diagnostics** | The gate stores a number but the public `getDreamMeta()` only reads strings, so diagnostics can't read it (gate behaviour is correct) | The diagnostic API's historical type contract; changing it touches the meta-reading contract for little gain (recorded as a known minor) |
| **Embeddings send memory bodies** | With it enabled, memory bodies/titles/keywords and user query text go to the configured endpoint | That is required for semantic retrieval; default off + explicit docs let the user choose the provider |
| **Editor is last-write-wins** | Concurrent edits to the same id from multiple settings pages/tools overwrite each other; no conflict detection | Single-user personal plugin; versioning/optimistic locks cost more than they buy |
| **Editor has no hard delete** | Only archive/restore; archived entries stop being injected but still occupy the store | Consistent with the existing "the plugin never deletes memories for the user" principle; use `memory_forget mode=delete` (tool channel) for that |
| **Editor covers global scope only** | Project-level rules/fact/lesson/topic are not in the UI and still need `memory_*` tools | Cross-cwd workspace data is semantically complex; batch UI editing is risky — keep the tool channel |
| **Saves apply only on the next user message** | Sessions with no further user message keep the old snapshot | Not rewriting history and not firing an immediate model request is intentional; the next turn reuses the post-compaction re-injection channel |
| **At most 2000 sessions marked per save** | With very many sessions the marked set is bounded; the rest need another save/other sessions | Prevents unbounded scanning/writes per save; 2000 is far above a personal plugin's needs |
| **Semantic requests add latency** | A hanging endpoint adds up to `timeoutMs` (5s default) to each user message/search/write (no throw, lexical results still returned) | The synchronous wait lets the semantic score participate in this retrieval; lower `timeoutMs` or disable `enabled` to remove it |
| **Vectors inflate the DB** | Embeddings are JSON text in the DB/backups — ≈31 KiB/row at 1536 dims (1k ≈30 MB), plaintext derived data | Vector search needs them at rest; reduce enabled rows or disable semantic (no new vectors after off) |
| **Remote plain-http endpoints are rejected** | Only https or loopback http; a remote plain-http base sends nothing (lexical fallback) | Semantic requests carry memory bodies/queries/Bearer; rejecting cleartext is the safe default |
| **Dream does not consolidate the global store** | Global entries are maintained via tools/reflection, not dream rounds | Dream is per-window workspace semantics; global consolidation needs its own scheduler |
| **Migration archives workspace originals** | A lost global store does not re-inject them automatically (content still archived) | Auto-restoring would conflict with "user deleted the global store"; provide `memory_forget mode=restore` |
| **Isolated dream cannot be aborted from the UI** | Only timeout/completion/failure ends it; dispose/HMR cancels | The host's subagent activation has no UI abort entry (recorded as a 0.34 limitation) |
| **Isolated dream quality below the main path** | The digest has no tool results/plugin notices and the prompt is capped; some tasks get insufficient context | Directly conflicts with "zero main-context growth"; off by default, opt in per need |
| **Child tool visibility depends on the parent preset** | The child inherits the parent's agent preset; if that preset does not expose `memory_*`, the child cannot write memories (isolated consolidation is a no-op) | Host subagent inheritance semantics; recorded as residual risk in 0.34.1, unavailable → main-agent fallback |
| **Archiving the child leaves a plaintext copy** | `isolatedArchiveChild` archives the child after settle (success/failure), leaving a plaintext transcript on disk | Archiving is the host's `workspaceRegistry.archiveSession`; set it to `false` to skip |
| **Global backup depends on a dream firing** | With `backup.enabled`, the global-store backup happens at dream completion (both main and isolated paths); there is no scheduled backup | Backup reuses the dream-completion hook |
| **Scans without indexes (upstream)** | 4 full scans per message; fine at hundreds of entries, a cliff at thousands | T1 added indexes; large-scale behaviour still needs measuring |
| **#66 host-side tool lock** | After a manual dream the tool set may shrink until restart | Host issue; plugin can only avoid the automatic path |
| **#71 delegate model leak** | Only with `delegate.model` set | Host projection bug; empty default does not trigger |
| **Settings save path on 0.2.x** | May render but not reach apply (since 0.37 the four advanced groups are on the page, and 0.37.1 fixes merging/validation/danger confirmation, but only the save RPC shape is unit-tested — no live click-through; the page shows an explicit error on failure) | Settings service redesign, not in this pass; run the self-check after installing |
| **Danger toggle uses native confirm (no undo/custom modal)** | After a mistaken confirmation you can only toggle it off again; no custom modal/undo | P3: native confirm has zero dependencies and is stable across hosts; a custom modal needs UI-framework wiring for little gain |
| **`allowHomeSwitch` is not confirmation-gated** | It lets the model move the global directory, but has no confirm like `trustWorkspaceMemory` | P3: lower risk than trusting unknown stores and off by default; can be added later |
| **Nested "Restore default" writes defaults into the user layer** | The badge correctly shows default, but the user layer gains default values (pre-existing design) | Consistent with "restore = factory default"; clearing the user layer needs profile-level work |
| **Weak pt-br retrieval** | No Portuguese stemming/stopwords | Needs Portuguese NLP |
| **Dream history costs tokens** | Folding is visual only | No host "hidden message" semantics |
| **Plaintext PII** | Memory bodies may contain secrets | Encryption needs key management; `.gitignore` + environment boundary instead |

---

## Related docs

- [Configuration reference](configuration-reference.md)
- [Tool reference](tool-reference.md)
- [Troubleshooting](troubleshooting.md)
