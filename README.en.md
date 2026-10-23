# meow-memory 🐱📝 · hardened fork

| [中文](README.md) | [English](README.en.md) | [Português (BR)](README.pt-br.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: | :---: |

> **What this is**: a personal hardening fork of `Phant0Meow/dsh-meow-memory` **v0.31.1** (this repository, version **0.36.0**, branch `hardening`).
> Upstream is MIT-licensed: <https://github.com/Phant0Meow/dsh-meow-memory>. This fork is **not affiliated with upstream**, does not publish on upstream's behalf, and does not represent upstream's views. All changes and remaining issues are in [CHANGELOG.md](CHANGELOG.md).

Cross-session memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): seven-layer SQLite memory, first-turn snapshot injection, per-message keyword hits, and automatic consolidation **with budget caps**.

Version **0.36.0** ｜ Changelog: [CHANGELOG.md](CHANGELOG.md) ｜ Verified host: **DSH Desktop 0.2.1-rc.2** (see [Compatibility](#compatibility))

**Honesty note**: this README only claims behaviour that exists in the code. 0.32 removed several inflated upstream claims ("automatic dedupe/merge", "Ebbinghaus forgetting curve", per-message "BM25", "supports dsh 0.1.5") and states the real boundary at each point.

---

## Read this first: it spends tokens automatically

This is the plugin's most under-estimated cost. **With default settings it issues LLM requests without an explicit user command**; 0.32 put a cap on every kind, but did not switch any of them off (upstream default behaviour kept, only unbounded → bounded).

| Spend | When | 0.35 cap |
|---|---|---|
| **Static tax**: memory manual + every tool description/schema in the system prompt | **Every** model request, even a session that never uses memory | ≈**6.7k tokens/request** (measured, Chinese pack; ≈6.3k English; varies with language pack and tool-description length). Cannot be disabled per request; to avoid it entirely set `enabled: false` (or remove the plugin) |
| **First-turn snapshot**: soul / user / global rules / memory guide | Once, before the first real user message of each session | `budget.snapshotMaxChars` default **6000 chars** (≈2.7k tokens zh) |
| **Per-message keyword hits** | From the second message on, when keywords match | `hitTopK` default 2 × `budget.hitMaxChars` default **1500 chars/entry** (≈1.4k tokens/message worst case) |
| **Post-compaction re-injection** | The turn after a session compaction | `budget.reinjectMaxChars` default **8000 chars** (≈3.6k tokens) |
| **Automatic dream (main-agent path, default)** | Window idle ≥ `dream.idleMinutes` (default 180), off-peak, **window has a live agent**, estimated context ≤ `budget.dreamMaxContextTokens` (default 40000) | Up to **3 full-context rounds** (later rounds re-estimate and finish early if oversized); `budget.dreamMaxPerWindowPerDay` default **1 per window/day**, plus a **process-wide** `budget.dreamMaxPerDayTotal` default **12/day** (counters roll 24h per process lifetime, reset on restart). A 30k-token session costs ≈90k input tokens per dream; the session history permanently gains ≈8–15k durable tokens |
| **Automatic dream (isolated child path, `dream.isolated: true`)** | Same gates (frequency/cooldown/peak/global cap still apply), plus host `subagents` service and `spawn` provider required | **Zero main-session model-visible context growth** (the child prompt has its own cap `dream.isolatedMaxPromptChars`, default 20000 chars); child tokens are still billed; the main-context `dreamMaxContextTokens` gate **does not apply** to the isolated path |
| **Reflection** | After a task with ≥ `reflectTurns` (default 7) consecutive tool steps | **1 full-context request**; `budget.reflectMaxPerDay` default 6/day/window (session), `budget.reflectMinIntervalMinutes` default 20, plus a **process-wide** `budget.reflectMaxPerDayTotal` default **24/day** (rolling 24h, reset on restart); skipped when context exceeds `dreamMaxContextTokens` |
| **Optional semantic retrieval (`retrieval.semantic.enabled: true`, off by default)** | Every user-message query, every `memory_search`, every write (`memory_remember`/`memory_update`), and a background backfill right after plugin apply | **Not token spend but network requests to your configured `/embeddings` endpoint**: with it enabled, one query embedding per user message (the 256-entry LRU only helps identical text), one per write, and startup backfill in batches of ≤50 rows/level; **off (default) = zero network requests**. With a hanging endpoint each message/search/write can add up to `timeoutMs` (default 5s) latency (no throw, lexical results still returned; connection-refused fails fast). **DB size**: embeddings are JSON text in the DB and backups — ≈31 KiB/row at 1536 dims (1k entries ≈30 MB). Data sent/privacy below |

**How to stop the automatic spend** (manual tools keep working):

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    reflect: false            # no automatic reflection
    dream:
      enabled: false          # no automatic dream (/dream and memory_dream still work)
```

Or per window: session row "…" menu → **Memory participation** → turn off "auto-injection" / "auto-consolidation". To avoid the ≈6.7k static tax entirely, disable the plugin.

> **Manual `/dream` / `memory_dream` do not go through the automatic cost gates** (explicit intent): no peak-hour / daily-frequency / context-size gate applies (manual invocation already requires a live window), and they run up to **3 rounds** over the **full session context** (atomic / topic / project summary). If the context is large, run `/compact` first — that is the only way to materially reduce a manual dream's cost.

> These are **caps**, not promises. Actual spend depends on entry counts, content length and session length; the worst case per day is still bounded in orders of magnitude (≤1 dream + ≤6 reflection full-context turns). The "estimated tokens" used by the context gates are **approximate**: CJK ≈1.7 chars/token, non-CJK ≈4 chars/token (deliberately over-estimated), not exact billing.

> **The 0.33 layered store adds no per-message tokens**: it is just one more local SQLite database (the user-scope global store); injections stay bounded by `budget.*`. Fuzzy scoring is pure CPU (no tokens); dream/reflection frequency and context caps are unchanged.

> **The 0.36 global-memory editor makes no immediate model calls**: saving in the settings page only writes the local SQLite DB and marks **related sessions** for reinject; those sessions re-inject the updated global memory on their **next user message** through the post-compaction re-injection channel (bounded by `budget.reinjectMaxChars`). It does not rewrite history and makes no extra model request; sessions with no further user message keep their old snapshot.

> **0.35 optional semantic retrieval (`retrieval.semantic.enabled: true`, off by default); 0.35.1 tightens transport**: by default it is **fully offline with zero network requests** (no endpoint configured = not enabled; behaviour identical to 0.34). **Transport requirement**: only `https://` or **loopback** `http://` (`localhost`, `127.x`, `[::1]`) — a remote plain-`http://` baseUrl is **rejected** and falls back to lexical (no request sent, so memory bodies/queries/Bearer key never cross the network in cleartext). When enabled it sends **memory bodies/titles/keywords** and **user message/query text** to your configured OpenAI-compatible `/embeddings` endpoint (key via env var, default name `MEOW_MEMORY_EMBEDDING_KEY`; if that default var is unset requests are sent **keyless**, for local Ollama/LM Studio; only a *custom* `apiKeyEnv` whose variable is missing is treated as unconfigured — no request). Semantic similarity is only a **cosine floor** (noise floor 0.25, below that counts as 0; negative/zero similarity counts as 0), never a rerank; failure/timeout (5s default)/non-2xx/bad shape silently fall back to pure lexical; **a hanging endpoint adds up to `timeoutMs` latency** (no throw, results still returned; connection-refused fails fast). When enabled, plugin apply **backfills historical entries in the background** (global store + each trusted workspace; on cold start trust is judged read-only first, ≤50 rows/level, failures silent and **retried on next start**; the first enable sends historical data to the endpoint). **No local model is bundled**; vectors are stored as JSON text in the DB/backups (≈31 KiB/row at 1536 dims, 1k entries ≈30 MB, plaintext derived data); changing the embedding model invalidates stored vectors (re-write or re-backfill). See [configuration reference](docs/configuration-reference.md).

> **0.34 isolated dream (`dream.isolated: true`, off by default; usable on 0.2.1 since 0.34.1)**: automatic dream runs in a **spawned empty-context child session**, so the main session gets no model-visible dream turn (only log-only catalog facts) → **zero main-context growth**; the child still spends tokens. The child receives the dream prompt slots + a digest of recent user/assistant text and tool names + entry lists (no tool results/plugin notices), so **consolidation quality is lower than the main-context path** (known trade-off). The child **inherits the parent's agent preset**, so `memory_*` tool visibility depends on that preset's tool set (residual risk; otherwise it falls back to the main-agent dream). Manual `/dream` / `memory_dream` always use the main agent (visible/abortable); **isolated dream cannot be aborted from the UI**. If subagents/spawn is unavailable the plugin falls back to the main-agent dream; **a rejected child start (sync or async — depth/capacity/auth) also falls back to the main-agent dream in the same sweep** (log `isolated-dream rejection -> main-dream fallback`). The 0.34.0 build sent `maxDepth: 0` to spawn, which 0.2.1 interpreted as the child's own depth limit and rejected (`SubagentDepthError`), so no automatic consolidation ran; 0.34.1 sends **no `maxDepth`** (host default 1).

---

## Where memory lives: two-layer storage (0.33)

0.33 turns "global" from "global within one workspace" into real **user-scope** layered storage:

```
<activeHomeDir>/global/memory.db        ← user-scope (across workspaces)
  soul / user / rules(global)
<workspace>/<projectDir>/memory.db      ← workspace-scope (one per cwd)
  project / fact / lesson / topic / rules(project)
```

- **User-scope global store**: under the global data directory (`activeHomeDir()/global/memory.db`; default `~/.dsh-meow/global/memory.db`, change with `homeDir` / `MEOW_MEMORY_HOME`). `homeDir` / `memory_home` switches move it along.
- **Workspace store**: still one per cwd, holding `project` / `fact` / `lesson` / `topic` / project-level `rules`.
- **Write routing**: `memory_remember` writes `soul` / `user`, or `rules` whose project is the global marker → **global store**; everything else → **workspace store**. `memory_read` / `memory_update` / `memory_forget` / `memory_search` / `memory_list` / `memory_find_similar` **query both stores and dedupe by id**; on an id collision **active wins over archived** (a migrated workspace archive copy cannot shadow the global original). `memory_project` stays workspace-only.
- **Automatic one-time migration**: the first trusted session in each workspace copies existing soul / user / global rules **with their original ids** into the global store, then **archives** those workspace rows (recoverable; avoids injection/dream double-counting). The idempotency flag lives in the workspace DB `dream_meta` (`globalmigrated:v1:<dir>`); only trusted workspaces are migrated, foreign stores are never touched.
- **Fallback**: if the global store is absent / untrusted / unavailable, the plugin automatically falls back to 0.32 single-workspace behaviour (soul/user/global rules read/written from the workspace DB), no error.
- **If the global store is deleted after migration**: the workspace originals stay archived and are **not re-injected automatically**. Recovery: restore/back up the global directory, or `memory_forget` with `mode:'restore'` per id.
- **Backup**: `backup.enabled` (off by default) backs up **both the workspace store and the global store** at dream completion (each `memory.db.bak`, VACUUM INTO + one-generation rotation + mtime increment; empty/untrusted global stores are skipped and no directory is created).
- **dream/reflection still consolidate the workspace DB only**: global entries are maintained via tools/reflection (the post-task reflection turn can write global entries), not by dream's three rounds — known limitation.
- **UI editing (0.36)**: DSH **Settings → "Meow memory" bottom** adds a "Global memory (user-scope)" card that lists / inline-edits / creates / archives / restores `soul` / `user` / global `rules` in the user-scope global store (project-scoped rules and fact/lesson/topic are not included — they stay per workspace and are managed via `memory_*` tools). Saving goes through the plugin-private `GET/POST /meow-memory/global-memory` routes (same auth gate); if the global store is untrusted the editor shows a warning and refuses writes; there is **no hard delete** (archive instead).

---

## Security model

### Where the data lives

| Data | Location |
|---|---|
| User-scope global memory store (plaintext SQLite) | `<activeHomeDir>/global/memory.db`: default `~/.dsh-meow/global/memory.db` (**outside `DSH_HOME`**; change with `homeDir` / `MEOW_MEMORY_HOME`) |
| Workspace memory store (plaintext SQLite) | `<workspace>/<projectDir>/memory.db`, `projectDir` defaults to `.dsh-meow` |
| Session bookkeeping (seen / queried) | `<workspace>/.dsh-meow/sessions/<id>.json` |
| Workspace store trust marker | `<workspace>/.dsh-meow/.owner.json` |
| Global store trust marker | `<activeHomeDir>/global/.owner.json` (installId marker, `workspace: ''`) |
| Self-ignoring `.gitignore` | `<workspace>/.dsh-meow/.gitignore` (content `*` — the directory ignores itself, so `git add .` never commits memories) |
| Instance-level global directory (logs / window index / migrate state) | default `~/.dsh-meow` (**outside `DSH_HOME`**); change with `homeDir` or `MEOW_MEMORY_HOME` |
| Prompt-copy instance overrides | `$DSH_HOME/storages/meow-memory/prompts/<lang>/<slot>.md` (fixed path; `$DSH_HOME` defaults to `~/.dsh`; **does not follow `homeDir`/`memory_home` switches**) |

The `.gitignore` is written automatically (`security.autoGitignore: true`): `*` if the directory has none, and **a `*` line is appended if a pre-existing `.gitignore` lacks one** (prevents `!*`-style re-inclusion from committing `memory.db`). The store is **not encrypted** though: memory bodies are plaintext and may contain private data. Do not store secrets in memories; `.gitignore` only stops git, not backups, sync folders or other local processes.

### Non-empty stores not created by this plugin are untrusted (#64-1 fix)

Workspaces are often `git clone`d repositories — someone can drop a `.dsh-meow/memory.db` or `PROJECT.md` into a repo and have the AI inject attacker-written soul/user/global rules as if they were the user's long-term memory.

0.32 rules:

- the plugin trusts only stores **it created**, or those carrying a valid `.owner.json` marker. The marker must satisfy all of: `schema=1`; `installId` equal to this machine's **random install id** (persisted at `$DSH_HOME/storages/meow-memory/install-id`, not a machine fingerprint); and a recorded `workspace` matching the current workspace. Forged markers, other-machine markers and markers moved to another workspace path are rejected; if the install id cannot be persisted, marker verification is **fail-closed**;
- `workspace` paths are compared after **realpath normalisation**: opening the same store through a junction / mapped drive / subst alias is no longer misjudged as foreign (fixes the "lockout after entering via another path" bug); aliases that realpath cannot resolve still fail closed (best-effort);
- **only when the `memory.db` file does not exist at all** is it created and trusted. **Any pre-existing `memory.db` — even a schema-only / row-empty one — is untrusted by default** (closes the "pre-seeded empty DB + SQLite triggers" poisoning path);
- an untrusted store is **never opened by normal chat turns**: no schema upgrade, no index creation, no migration, no read — only one read-only trust probe touches the file. Its content is not injected, and **all memory tools (read and write), dream and reflection are refused**; a one-time notice explains how to trust it (`security.trustWorkspaceMemory: true`);
- until you explicitly trust it or delete/rename it. Only enable trust for a store you know is yours;
- `autoMigrate` **now defaults to `false`**: a workspace's `PROJECT.md` is no longer imported automatically.
- **The global store is trust-gated too**: `<activeHomeDir>/global/.owner.json` (installId marker, `workspace: ''` — no workspace binding); absent → created and trusted, pre-existing without a valid marker → **foreign**. A foreign global store automatically falls back to 0.32 single-workspace behaviour (no global reads/writes); there is **no `trustWorkspaceMemory`-style config override for the global store**; a global directory copied/synced from another machine is judged foreign.

### `memory_home` is query-only by default (#64-2 fix)

`memory_home` is a tool the model can call directly. Upstream let it move the whole global directory (where logs / window index / migrate state live) — a filesystem side effect the model should not have.

Since 0.32:

- `security.allowHomeSwitch: false` by default; `memory_home` can **only query**, and switch requests are explicitly refused;
- set `security.allowHomeSwitch: true` only if you want the model to be able to switch directories;
- the prompt-override directory resolves from the fixed `$DSH_HOME/storages/meow-memory/prompts/`, **not** from `homeDir` / `memory_home` / `MEOW_MEMORY_HOME`, and the old location is no longer read (no fallback) — so switching directories can never change injected instructions.

### Network and auth

- The plugin makes **no outbound network requests** (no telemetry, no egress). Dream/reflection model requests go through the host's existing agent turns, not the plugin itself.
- The 4 client-side local routes (`/meow-memory/dreamed-sessions`, `/meow-memory/dream-events`, `/meow-memory/skip-dreams`, `/meow-memory/global-memory`) go through the host `connection.requestRejection` auth gate since 0.31.1: cross-site requests get 401/403; 503 when the auth service is missing.
- **Data routes also go through the trust gate (0.32.1; new 0.36 route included)**: `GET /meow-memory/dreamed-sessions` and `GET/POST /meow-memory/skip-dreams` do not open untrusted / not-yet-judged workspace stores; POST returns **403** for an untrusted workspace (no memory content exposed; auth unchanged). `GET/POST /meow-memory/global-memory` only reads/writes the user-scope global store and **never touches workspace stores**; with an untrusted global store the list is empty and writes return the fixed error `global store unavailable or untrusted` (the foreign store is not opened).
- The trust gate also covers **window activity tracking and startup window-index restore**: they never open/upgrade an untrusted store just to record window bookkeeping; only the read-only trust probe and the injection chain's own judgment touch it.
- `security.debugLogs` defaults to `false`: `perf.log` and settings/configEditor diagnostic dumps are not written by default (enable `security.debugLogs: true` or `MEOW_MEMORY_DEBUG=1` when troubleshooting). `dream-debug.log` **is still written by default**, but only minimal info (session ids / counts / skip reasons, no memory text), with 48h cleanup and 5MB rotation at startup; `apply-error.log` / `settings-register-error.log` are error-only. **Do not read this as "zero logs by default".**

### Uninstalling leaves data behind (clean up manually)

Uninstalling does not delete memories. When you no longer need them:

```
<workspace>/.dsh-meow/                       # memory.db, memory.db.bak, sessions/, .owner.json, .gitignore
~/.dsh-meow/                              # or your homeDir: global/memory.db, global/memory.db.bak, logs, window-index, migrate-state
$DSH_HOME/storages/meow-memory*           # install-id, prompt overrides, switch pointer (meow-memory-home.json)
```

---

## Features

- **Seven memory layers**: `soul` (the AI itself) / `user` / `project` (with `subcategory`) / `fact` / `lesson` / `topic` (with a goal sentence) / `rules`. One SQLite table per layer, time-prefixed ids.
- **Two-layer storage (0.33)**: `soul` / `user` / global `rules` live in the **user-scope global store**, shared across workspaces; `project` / `fact` / `lesson` / `topic` / project rules stay in the workspace store. See [Where memory lives](#where-memory-lives-two-layer-storage-033).
- **Global-memory visual editor (0.36)**: the DSH settings page ("Meow memory" tab, bottom) adds a **"Global memory (user-scope)"** card that lists / inline-edits **content, keywords, importance**, **creates** (soul/user/rules), and **archives/restores**; it only covers soul/user/global rules in the user-scope global store. After a save the host marks related sessions for reinject; those sessions re-inject the updated global memory on their **next user message** (no history rewrite, no immediate model call). Validation: content trim 1–4000 chars, keywords 1–30, importance integer 1–100; **no hard delete** (archive instead); last-write-wins. See [configuration reference "UI editing"](docs/configuration-reference.md#ui-editing-global-memory-036).
- **First-turn injection (long-term block)**: soul / user / global rules / memory guide are injected before the first user message as an independent plugin snapshot **without rewriting the user prompt**; soul / user / global rules come from the user-scope global store with the workspace store as fallback; **no keyword hits on turn 1** (hits start from message 2).
- **Per-message keyword hits + hybrid lexical floor + optional semantic floor (0.35)**: from the second user message, fact/lesson/rules/topic are matched by entry **keywords** (not full text), scoped to global + the current project anchor, injecting up to `hitTopK`. 0.33 adds an offline lexical complement — character bigram Jaccard + 0.25×trigram Jaccard (CJK-safe, NFKC) — used as a **floor** when BM25 is weak: `score = max(BM25, 0.55·fuzzy·recency·importance)`, noise floor 0.2. 0.35 can opt into `retrieval.semantic` (off by default): with it enabled, cosine similarity between the query and entry embeddings is **also a floor** (`relevance = max(lexical, fuzzy, cos·weight·importance)`, cos < 0.25 counts as 0), covering some paraphrases; **it is not a rerank and does not guarantee semantic quality** (see limitations below).
- **Current-project anchor**: passing a project parameter anchors the session's current project; unanchored sessions hit global entries only.
- **Cache-friendly**: the static `meow-memory:guide` system-prompt section is registered once with constant text and cannot break the provider's prefix cache.
- **Post-compaction re-injection**: after compaction the next turn re-injects the long-term snapshot, project panoramas queried this session, and entries written this session (bounded by `reinjectMaxChars`).
- **Dedupe reality**: only **same-level**, bigram Jaccard ≥ 0.8 (near-identical wording) entries merge automatically. **Paraphrases do not merge**, cross-level contradictions are not detected — use `memory_find_similar` + `memory_update`/`memory_forget`.
- **Per-window dream**: when a window is idle ≥ `idleMinutes` (default 3 h), off-peak and has a live agent, its main agent consolidates in three rounds (atomic / topic / project summary). Since 0.32 automatic dream **no longer `agents.resume()`s a bare agent** (#49 fix), has context-size and frequency caps, excludes archived rows, and caps entry lists. 0.34 can opt into `dream.isolated: true`: automatic dream runs in a **spawned empty-context child session** (zero main-context growth, child tokens still billed), with fallback to the main agent on failure/timeout; manual `/dream` always uses the main agent. `/dream` or `memory_dream` consolidates on demand.
- **Reflection**: after ≥ `reflectTurns` consecutive tool steps in one task the model is asked whether anything is worth remembering; a `memory_*` last tool suppresses it. 0.32 adds per-day and minimum-interval caps.
- **Client UI**: injected text folds into a slim bar, reflection/dream turns fold into a card, session list shows dream icons. This depends on 0.2.x host internals and is best-effort — a host patch can silently disable it (cosmetic only).
- **Zero runtime dependencies**: `node:sqlite` + self-contained esbuild bundle, no native modules.

### What it cannot do (do not misunderstand)

- **Semantic retrieval is off by default**: without `retrieval.semantic` there is no semantic recall (BM25 + 0.33 fuzzy only). When enabled it is an **experimental floor** (only cosine ≥0.25 participates, no rerank, weak matches can slip in), depends on an **external embeddings endpoint** (no local model bundled), silently degrades to lexical on failure/timeout; **only https or loopback http is allowed** (remote plain http is rejected); a hanging endpoint adds **up to `timeoutMs` (5s default) latency**; vectors are JSON text in the DB/backups (≈31 KiB/row at 1536 dims, 1k ≈30 MB, plaintext derived data); **not exposed on the settings page** (config file only); changing the embedding model invalidates stored vectors (re-write/re-backfill).
- **Project-level memory is still workspace-scoped**: `project` / `fact` / `lesson` / `topic` / project rules follow the cwd (a new workspace starts with fresh project memory). Only `soul` / `user` / global rules are shared across workspaces (0.33 user-scope global store).
- **Global store does not participate in dream**: dream's three rounds still consolidate the workspace DB only; global entries are maintained via tools/reflection.
- **UI editor limits (0.36)**: it edits **global-scope** soul/user/global rules only; project-scoped rules, fact/lesson/topic are not included (use `memory_*` tools); **no hard delete / bulk import / conflict merge**; a save takes effect on the session's **next user message** (sessions with no next turn keep their old snapshot); concurrent edits to the same id are **last-write-wins**; archived entries are no longer injected but remain in the store (restorable); dream/reflection can still reorganize entries afterwards.
- **Isolated dream trade-offs**: with `dream.isolated: true` the main context stays flat, but the child only gets the dream prompt + a recent-conversation digest + entry lists (no tool results), so **consolidation quality is lower than the main-context path**; **isolated dream cannot be aborted from the UI**; the child **inherits the parent's agent preset**, so `memory_*` tool visibility depends on that preset (residual risk); `isolatedArchiveChild` archives the child after it settles (**both success and failure**, leaving a plaintext child-session copy); if subagents/spawn is unavailable or the start is rejected, it falls back to the main-agent dream.
- **Dream still keeps its instructions/responses/tool calls in the main session history (main-agent path)**: folding is visual only, tokens persist; the isolated path leaves only log-only catalog facts, no model-visible dream turn.
- **Migration archives workspace copies**: after upgrading to 0.33 the original workspace soul/user/global-rule rows become archived (content retained); if the global store is lost they are not re-injected automatically — restore the global directory or `memory_forget mode=restore` per id.
- **Forgetting is an exponential half-life**: `retrieval.halfLifeDays` default 30 days, age = `now − max(updated_at, last_accessed_at)`, with an importance≥3 floor of 0.85. **Since 0.35.1 "review" refreshes the curve**: injection hits and `memory_search` hits update `last_accessed_at`, so recently recalled memories decay more slowly (spaced-repetition-style); `updated_at` is still refreshed by dream sealing/update. There is still no review-count model or scheduling — not a full Ebbinghaus implementation.
- **Dream still keeps its instructions/responses/tool calls in the main session history**: folding is visual only, tokens persist.
- **`memory_home` switching is off by default**; when enabled it is still a model-callable tool — evaluate the risk yourself.

---

## Install

**This fork is not published to the npm registry.** Three routes; `npm install meow-memory` installs **upstream 0.31.1**, not this repository.

### Route A: local directory / tarball (recommended, no GitHub required)

1. Build once in the repository (this repo does not commit `lib/`):

   ```sh
   npm install
   npm run build        # → lib/index.js, lib/client.js, lib/prompts/
   ```

2. Either:
   - **local directory**: GUI **Plugins → Add plugin**, enter the **absolute path** of this repository (the plugin manager accepts absolute local paths);
   - **tarball**: `npm pack` produces `meow-memory-0.36.0.tgz`; enter the absolute path of that `.tgz`.
3. Restart `dsh web` (or hot-reload the plugin). New sessions load it automatically.

> Local `file:`/`link:` installs do not run `prepare`, so **build first**; a tarball already contains `lib/`.

### Route B: manual profile install (any DSH install)

1. Copy (or symlink/junction) the package into the profile's `node_modules/meow-memory`:

   ```sh
   mkdir -p ~/.dsh/profiles/<profile>/node_modules
   ln -s /absolute/path/to/meow-memory ~/.dsh/profiles/<profile>/node_modules/meow-memory
   ```

   Windows: `New-Item -ItemType Junction ...` (NTFS junction, no admin needed).

2. Add `meow-memory` to the profile `package.json`'s `dsh.profile.bundles`.
3. Restart `dsh web`.

### Route C: `github:` one-liner (**not recommended**)

```sh
dsh plugin --profile <profile> add github:<your-fork-url>
```

⚠️ A `github:` / git dependency installs **devDependencies and runs `prepare` (esbuild build)**. It needs GitHub reachability, pnpm build-script approval (≥10 blocks it, add `allowBuilds`), and resolvable `@deepseek-ai/dsh-*` devDeps. Any failure rolls back. Use route A unless you are specifically validating the build chain.

### ⚠️ Upgrading from upstream 0.31: the old store is untrusted by default

A `memory.db` created by upstream 0.31 has no `.owner.json` marker, so on first run this fork classifies it as **foreign / untrusted**: its content is not injected, memory tools (read/write), dream and reflection are refused, and a one-time "workspace memory store not trusted" notice appears. **Even an empty upstream DB counts as pre-existing and is untrusted by default.**

To keep the old memories, do one of:

- explicitly set `security.trustWorkspaceMemory: true` in the profile config and reload the plugin (only after confirming the store is yours);
- or delete/rename the old `memory.db` and start fresh (back it up first — deletion is irreversible).

### Remove

```sh
dsh plugin --profile <profile> remove meow-memory
```

**Memory data is not deleted**; see the [security model](#security-model) for cleanup paths.

---

## Compatibility

The environment this fork was actually verified on (not a "backward compatible with everything" claim):

| Item | Value |
|---|---|
| Host | **DSH Desktop 0.2.1-rc.2** (Windows 11) |
| Runtime | Electron 44.7.0 / Node **24.21.0**, `node:sqlite` available |
| Verified | Isolated instance loads; 4 `/meow-memory/*` routes (dreamed-sessions / dream-events / skip-dreams / global-memory) return 200 with auth / 401 without; settings namespace appears; no apply error. The 0.34 live load with `dream.isolated: true` only verified loading; the 0.34.0 child-start bug (`maxDepth: 0`) was found by re-audit and fixed in 0.34.1. 0.35 additionally ran live loads with default and semantic-enabled configs: both loaded cleanly with no apply error, **zero embedding requests at boot when disabled**, no real-home writes. 0.35.1 is audit remediation (transport policy/cold-start backfill/review refresh), covered by unit tests. 0.36's editor routes were exercised with a live-boot 401/200 round-trip (mock webServer/auth + isolated instance) and covered by unit tests for editor/route/propagation/component. **Real model / child-session dream and a real embedding endpoint were not exercised in the isolated instance** (no credentials; the semantic layer is covered by unit tests with a mock embeddings server) |
| Not verified | **0.1.x hosts** (this fork has not tested them; the "supports dsh 0.1.5" claim is removed); other 0.2.x patch releases |

Known compatibility risks (upstream findings, unchanged by this fork):

- **Settings save path**: after the 0.2.x settings service redesign the plugin takes a degraded path. The page renders, but "edit → save → reload → applied" was not verified in this fork; worst case values display but do not reach apply. Run the [self-check](#self-check-after-install) after installing.
- **Client UI** (fold bars / moon icons / menu panel) depends on 0.2.x `ChatSnapshot` internals and DOM observation; a host patch may silently disable it (cosmetic only).
- `node:sqlite` requires **Node ≥ 22.13** (22.5–22.12 needs `--experimental-sqlite`).

---

## Configuration

All fields are optional. **The new 0.32 `security` / `budget` / `retrieval` groups are config-file only** (profile patch or `cordis.patch.yml`); the settings page still covers the 0.31 fields, and **since 0.36 it additionally provides the "Global memory (user-scope)" visual editor (data editing, not config)**, but it does not expose `security` / `budget` / `retrieval` config fields.

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true
    projectDir: '.dsh-meow'
    promptLang: 'zh'          # set explicitly on first use
    hitTopK: 2
    autoMigrate: false        # changed in 0.32: no automatic PROJECT.md import
    security:
      trustWorkspaceMemory: false   # trust a pre-existing memory.db (including empty/schema-only)
      allowHomeSwitch: false        # allow memory_home to switch the global directory (query-only by default)
      autoGitignore: true           # write/complete .dsh-meow/.gitignore (self-ignoring)
      debugLogs: false              # perf/settings diagnostics off (dream-debug still writes minimal lines)
    budget:
      snapshotMaxChars: 6000        # first-turn snapshot cap (chars)
      hitMaxChars: 1500             # per keyword-hit entry cap (chars)
      reinjectMaxChars: 8000        # post-compaction re-injection cap (chars)
      dreamMaxContextTokens: 40000  # skip automatic dream/reflection above this context estimate
      dreamMaxPerWindowPerDay: 1    # automatic dream frequency cap (per window/day)
      dreamMaxPerDayTotal: 12       # process-wide automatic dream cap/day (rolling 24h; resets on restart; 0 = off)
      reflectMaxPerDay: 6           # daily reflection cap (per window)
      reflectMaxPerDayTotal: 24     # process-wide automatic reflection cap/day (rolling 24h; resets on restart)
      reflectMinIntervalMinutes: 20 # minimum interval between reflections
    retrieval:
      halfLifeDays: 30              # exponential half-life (days)
      minScore: 0.35                # keyword-hit injection threshold
      hitBoost: true                # hit-count reinforcement
      importanceWeight: true        # importance participates in ranking
      semantic:                     # 0.35 optional semantic retrieval (off = zero network)
        enabled: false              # only an explicit true requests the endpoint
        baseUrl: ''                 # OpenAI-compatible base; only https or loopback http (e.g. http://127.0.0.1:11434/v1)
        model: ''                   # embedding model name
        apiKeyEnv: 'MEOW_MEMORY_EMBEDDING_KEY' # env var holding the key; default var unset = keyless requests
        timeoutMs: 5000             # per-request timeout (ms; failure silently falls back to lexical)
        weight: 0.8                 # semantic floor blend weight (0..1; 0 = semantic scoring off)
    dream:
      enabled: true
      idleMinutes: 180
      isolated: false             # 0.34: automatic dream in an isolated spawn child (off by default)
      isolatedProvider: 'spawn'   # child provider (needs inheritsParentContext=false)
      isolatedTimeoutMinutes: 20  # timeout → dispose child, release lease, retry
      isolatedMaxPromptChars: 20000 # child single-prompt char cap
      isolatedArchiveChild: true  # archive the child after it settles (success and failure; best-effort)
```

**Every field, type, default and effect is in [docs/configuration-reference.md](docs/configuration-reference.md)** (including `titleMax` / `homeDir` / `disabledWorkspaces` / `backup` / `delegate`).

> ⚠️ **Set `promptLang` explicitly on first use.** It decides the language of injected/reflection/dream prompts and tool descriptions, and shapes the language the model writes entries in — keywords are extracted per entry language. Built in: `zh` / `en` / `pt-br`. The value *is* the subdirectory name and is matched **verbatim**: a nonexistent value (e.g. `pt`) raises nothing and silently falls back to Chinese.

### UI language

The plugin's UI copy follows DSH's Settings → General → Language (中文 / English / Português (Brasil)) — a separate layer from `promptLang`.

---

## How it works

```
First user message (turn 1)      Every message from turn 2             idle ≥3h + off-peak + live agent
┌────────────────────┐          ┌────────────────────┐               ┌──────────────────────┐
│ ===== long-term =====│          │ possibly relevant,   │               │ per-window dream:     │
│ [about you] (soul)   │          │ for reference only:  │               │ three rounds (incl.   │
│ [about user]         │          │ keyword hits         │               │ project summary)      │
│ [principles] (rules) │          │ top-K + minScore     │               │ context/frequency caps│
│ [memory guide]       │          │ (global + project)   │               └──────────────────────┘
└────────────────────┘          └────────────────────┘                consolidation turns stay
independent snapshot            seen ids recorded per session          in main-session history
↓ pristine user prompt          sessions/<id>.json                     (UI folding ≠ no tokens)
once per session,               compaction → release seen + re-inject
no hits on turn 1
```

> Since 0.33 the first-turn snapshot's soul / user / global rules come from the user-scope global store (`<activeHomeDir>/global/memory.db`) with the workspace store as fallback; project panorama and re-injection stay workspace-only.

### Tools (10 in 0.36)

| Tool | Band | Purpose |
|---|---|---|
| `memory_remember` | write | Write a memory (content/project/keywords/importance required; **soul/user/global rules go to the user-scope global store, everything else to the workspace store**; near-identical duplicates merge) |
| `memory_search` | read | Hybrid search (BM25 + character n-gram floor + optional semantic floor) × exponential recency, with `explain` (optional `fuzzy` / `semantic`) and level/project/status/days filters; queries both stores; with semantic enabled the query sends one embedding request |
| `memory_project` | read | Fetch a project's complete injection paragraph (`project` required); **workspace store only** |
| `memory_find_similar` | read | Duplicate & conflict detection; queries both stores |
| `memory_read` | read | Read one entry's complete metadata by id; queries both stores |
| `memory_update` | write | Fix status / importance / goal / keywords / content; writes to whichever store owns the entry |
| `memory_list` | read | **new in 0.32**: list ids/titles/keywords/status/timestamps, no bodies; merges both stores and dedupes by id |
| `memory_forget` | write | **new in 0.32**: archive/restore/delete by id. Archives by default; `mode:'delete'` hard-deletes and requires `confirm:true`; queries both stores |
| `memory_dream` | write | Manually trigger this window's consolidation (same as `/dream`; workspace DB only; **always the main-agent path** — 0.34's isolated mode applies to automatic dream only) |
| `memory_home` | directory | Inspect the global data directory; **query-only by default since 0.32**, requires `security.allowHomeSwitch: true` to switch (0.33 switches move the global store too, closing the connection first) |

**Parameters, returns and side effects: [docs/tool-reference.md](docs/tool-reference.md)**.

> **0.36 UI editor vs `memory_*`**: both can change global memory, but the UI editor only touches the user-scope global store (soul/user/global rules) and is a user-explicit channel; other levels/workspace memory stay with the tools. Editor saves take effect in related sessions on the **next turn**.

---

## Development and testing

```sh
npm install
npm run build          # esbuild bundle → lib/index.js / lib/client.js (self-contained)
npm run test           # build + language-pack check + full assertions (host + client suites)
node scripts/check-lang.mjs en       # check one prompt language pack
```

Test assertions: `npm test` **1285 all green** (host 925 + client 360), 0 failed; plus 29 in `node smoke.mjs`; `scripts/check-lang.mjs` validates the en/pt-br packs (11 slots aligned).

The `@deepseek-ai/*` packages live in the dsh-meow pnpm workspace, not in this package's `node_modules`. On Windows, `npm run link-workspace` creates junction mirrors so esbuild can resolve them (build-time only).

### Self-check after install

1. One normal conversation turn: does the first turn show a long-term-memory fold bar? (No → the plugin is not running.)
2. Change a setting → save → hot-reload the plugin → did the value apply? (Checks the 0.2.x settings drift.)
3. After `/dream`, keep chatting: is the tool count normal? (Guards #66.)
4. After a reflection turn, check the model selector: still the main model? (#71 can trigger only with `delegate.model` set.)
5. Open a session in a cloned, untrusted repository: no long-term memory you did not write should appear (untrusted store + no auto-migration);
6. Open a session in a different workspace: `soul` / `user` / global rules should still be there (user-scope global store), while `project` / `fact` are the new workspace's (verifies the two layers);
7. With `dream.isolated: true`: after an automatic dream there should be no dream turn in the main session (only log-only catalog facts) and the child session should be archived (after settle, success or failure); a manual `/dream` should still produce a main-agent dream turn. If the child start is rejected, the main-agent dream should continue (log `isolated-dream rejection -> main-dream fallback`; the 0.34.0 `maxDepth` bug is fixed in 0.34.1).
8. With `retrieval.semantic.enabled: true`: with `security.debugLogs` you should see backfill logs (historical entries fill in after the first apply); `memory_search` with `explain:true` should include a `semantic` component; point the endpoint at a bad URL and it should silently fall back to lexical without blocking injection/tools (and with semantic disabled, confirm zero embedding requests in logs/network).
9. Open Settings → "Meow memory" → bottom "Global memory (user-scope)": it should list the global store's soul/user/global rules; edit one content and save → the UI should report "saved · N sessions marked for re-injection next turn"; after the next user message in a related session, the injected content should update (history unchanged); with an untrusted global store the editor should show a warning and refuse saves.

---

## Documentation

| To learn about | Read |
| --- | --- |
| Parameters, returns and side effects of the 10 tools | [docs/tool-reference.md](docs/tool-reference.md) |
| Every configuration field, type and default | [docs/configuration-reference.md](docs/configuration-reference.md) |
| Why it is designed this way (cost and trade-offs) | [docs/design-notes.md](docs/design-notes.md) |
| Install failures, poor recall, how to read errors | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Version history and known unfixed issues | [CHANGELOG.md](CHANGELOG.md) |
| Adding a UI language | [src/i18n/README.md](src/i18n/README.md) |
| Adding a prompt language pack | [src/prompts/README.md](src/prompts/README.md) |

## Acknowledgments

Most of the code comes from upstream and these contributors (original attribution kept):

- **[daveycodez](https://github.com/daveycodez)** — English language pack & tokenizer ([PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6), shipped in v0.22.0)
- **[chenmzh](https://github.com/chenmzh)** — isolated memory injections into independent plugin snapshot messages, fixing session title pollution ([PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10))
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — dual-version Session events compatibility for dsh 0.1.2-alpha.4 ([PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11))
- **[coutogilson](https://github.com/coutogilson)** — Brazilian Portuguese prompt pack and the UI copy layer

0.32 hardening changes (trust gates, budget caps, dream/reflection frequency, retrieval formula, management tools, documentation rewrite) are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). Upstream copyright belongs to the author of `Phant0Meow/dsh-meow-memory`; this fork keeps the original LICENSE and attribution.
