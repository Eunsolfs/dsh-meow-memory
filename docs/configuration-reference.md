# Configuration reference (0.35 fork)

Every field is optional. Two ways to set them:

- **Config file** (profile patch / `cordis.patch.yml` under `config:`) — **the 0.32 `security` / `budget` / `retrieval` groups (including 0.35's `retrieval.semantic`) can only be set this way**;
- **DSH settings page**, the "Meow memory" tab — covers the fields that existed in 0.31 (master switch, directories, hits, reflection, dream, delegate, language). Per-field save; "Restore default" goes back to the plugin factory default, not the patch baseline.

All changes take effect after a **hot reload or restart of the meow-memory plugin** (config is parsed once at apply).

> 0.32 hardening: default automatic behaviour goes from unbounded to bounded. No feature is silently switched off. Since 0.33 storage is **two-layer: a user-scope global store + the workspace store** (automatic migration + fallback, no new config fields), and retrieval adds an **offline hybrid lexical floor** (no config toggle). 0.35 adds **optional semantic retrieval** (`retrieval.semantic`, off by default = zero network; enabling it requires your own OpenAI-compatible `/embeddings` endpoint). To cut cost, see [Turning automatic spend off](#turning-automatic-spend-off).

---

## Factory defaults (`src/defaults.ts`, single source)

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true
    projectDir: '.dsh-meow'      # memory directory, relative to the workspace
    promptLang: 'zh'             # ⚠️ set explicitly on first use
    hitTopK: 2
    titleMax: 40
    reflect: true
    reflectTurns: 7
    autoMigrate: false           # changed in 0.32: no automatic PROJECT.md import
    homeDir: ''                  # '' = platform user home; or a preset marker / absolute path
    disabledWorkspaces: []
    backup:
      enabled: false
    security:                    # new in 0.32
      trustWorkspaceMemory: false
      allowHomeSwitch: false
      autoGitignore: true
      debugLogs: false
    budget:                      # new in 0.32
      snapshotMaxChars: 6000
      hitMaxChars: 1500
      reinjectMaxChars: 8000
      dreamMaxContextTokens: 40000
      dreamMaxPerWindowPerDay: 1
      dreamMaxPerDayTotal: 12
      reflectMaxPerDay: 6
      reflectMaxPerDayTotal: 24
      reflectMinIntervalMinutes: 20
    retrieval:                   # new in 0.32
      halfLifeDays: 30
      minScore: 0.35
      hitBoost: true
      importanceWeight: true
      semantic:                  # new in 0.35: optional semantic retrieval (off = zero network)
        enabled: false
        baseUrl: ''
        model: ''
        apiKeyEnv: 'MEOW_MEMORY_EMBEDDING_KEY'
        timeoutMs: 5000
        weight: 0.8
    dream:
      enabled: true
      idleMinutes: 180
      suppressWindows:
        - { start: '09:00', end: '12:00' }
        - { start: '14:00', end: '18:00' }
      suppressLeadMinutes: 15
      checkMinutes: 15
      timeZone: 'Asia/Shanghai'
      rulesReviewDays: 2
      requireLiveAgent: true     # new in 0.32
      isolated: false            # new in 0.34: automatic dream in an isolated spawn child (off by default)
      isolatedProvider: 'spawn'
      isolatedTimeoutMinutes: 20
      isolatedMaxPromptChars: 20000
      isolatedArchiveChild: true
    delegate:
      model: ''
```

---

## Basics and directories

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch. `false` disables injection, reflection and all tools |
| `projectDir` | string | `.dsh-meow` | Memory directory, **relative to the workspace**: `<workspace>/<projectDir>/memory.db` |
| `homeDir` | string | `''` (= platform user home) | **Instance-level global directory**: `global/memory.db` (the user-scope global memory store), logs / window index / migrate state. Values below. **Prompt overrides are NOT here** (see the `promptLang` section below) |
| `disabledWorkspaces` | string[] | `[]` | Workspace deny-list, normalised exact match on cwd; disables read/consolidate/write (incl. manual `/dream`) |

**`homeDir` values**:

| Value | Location |
|---|---|
| `''` or absent | Platform user home (i.e. `~/.dsh-meow`) |
| `'default'` | Same as above (explicit marker) |
| `'dsh-storage'` | `<DSH home>/storages/meow-memory` |
| `'plugin-root'` | `<plugin root>/storage` |
| absolute path | Custom directory |

> The default global directory lives **outside `DSH_HOME`** (`~/.dsh-meow`). An isolated `DSH_HOME` still writes the real user directory; use `homeDir` or `MEOW_MEMORY_HOME` to isolate it.

---

## Layered storage (0.33, no new config fields)

| Layer | Path | Contents |
|---|---|---|
| User-scope global store | `<activeHomeDir>/global/memory.db` (default `~/.dsh-meow/global/memory.db`) | `soul` / `user` / global `rules` (shared across workspaces) |
| Workspace store | `<workspace>/<projectDir>/memory.db` | `project` / `fact` / `lesson` / `topic` / project `rules` |

- **Write routing**: `memory_remember` writes `soul`/`user` or global `rules` → global store; everything else → workspace store. Read tools (read/update/forget/search/list/find_similar) query both and dedupe by id (same id: **active wins over archived**); `memory_project` reads the workspace store only.
- **Automatic migration**: the first **trusted** session in each workspace copies existing soul/user/global rules with their original ids into the global store, then archives the workspace originals (recoverable). Idempotency flag in workspace `dream_meta` (`globalmigrated:v1:<dir>`); foreign workspaces are never migrated.
- **Fallback**: an absent/untrusted/unavailable global store falls back to 0.32 single-workspace behaviour; there is **no `trustWorkspaceMemory` config override for the global store** (a global dir copied/synced from another machine is foreign).
- **Note**: the global store moves with `homeDir` / `memory_home` (close the connection first on Windows); `backup.enabled` backs up both the workspace store and the global store (an empty/untrusted global store is skipped and no directory is created).

---

## Security gates (new in 0.32, reload required)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `security.trustWorkspaceMemory` | bool | `false` | Trust a **pre-existing** `memory.db` (including empty/schema-only ones; stores created by this plugin are unaffected). When `false`, the store is not opened (no upgrade/index/migration/read), its content is not injected, and **all memory tools (read and write), dream and reflection are refused**; a one-time notice is shown (`untrusted-store` prompt slot) |
| `security.allowHomeSwitch` | bool | `false` | Let the model **switch** the global directory via `memory_home`. When `false`, `memory_home` is query-only: it returns the current directory, the three presets and switch state; a `target` is refused |
| `security.autoGitignore` | bool | `true` | Write `.gitignore` (`*`, self-ignoring) when creating the memory directory; if a pre-existing one lacks a `*` line, **append one** (blocks `!*` re-inclusion) |
| `security.debugLogs` | bool | `false` | Master gate for `perf.log` + settings/configEditor diagnostic dumps (also `MEOW_MEMORY_DEBUG=1`). **Not "zero logs"**: `dream-debug.log` is still written by default (minimal info, 48h cleanup, 5MB rotation); `apply-error.log` / `settings-register-error.log` are error-only |

**Trust rules** (`src/db.ts`):

- **only when the `memory.db` file does not exist at all** → create schema + `.owner.json` marker → **trusted (created)**;
- store exists with a valid `.owner.json`: `schema=1`, `installId` equal to this machine's **random install id** (`$DSH_HOME/storages/meow-memory/install-id`), and `workspace` matching the current workspace → **trusted (marker)**; missing/mismatched `installId`, other-machine markers and markers moved to another path are untrusted; if the install id cannot be persisted, verification is **fail-closed**;
- **store exists (even schema-only / row-empty) without a valid marker** → `trustWorkspaceMemory` decides `config-trusted` / **foreign**; a foreign store is never opened by normal chat turns (read-only probe only): no upgrade, no index creation, no migration, no read;
- the marker always lives inside the memory directory, never in the workspace root.
- `workspace` paths are compared after **realpath normalisation** (opening the same store through a junction / mapped drive / subst alias is no longer misjudged as foreign; aliases that cannot be resolved still fail closed).
- Trust-gate coverage (0.32.1): HTTP data routes (`GET /meow-memory/dreamed-sessions`, `GET/POST /meow-memory/skip-dreams`; POST returns 403 for untrusted), session window-activity tracking, and startup window-index restore — none of them open/upgrade an untrusted store just for bookkeeping.

> Why untrusted by default: workspaces are often `git clone`d repositories. The old behaviour auto-injected `.dsh-meow/memory.db` / `PROJECT.md` shipped by the repo as "user long-term memory", a persistent prompt-injection channel (#64-1). Confirm the store is yours, then trust it or delete/rebuild it. Since 0.32, calls to an untrusted store are **refused** (not "return empty"), so the model cannot keep using untrusted data as if it were trusted context.
>
> **Upgrading from upstream 0.31**: the old `memory.db` has no `.owner.json` (**even an empty upstream DB counts as pre-existing**) so it is classified foreign/untrusted on first run (no injection; tool reads/writes and dream/reflection refused). To keep the old memories set `security.trustWorkspaceMemory: true` and reload, or delete/rename the old store and start fresh.

---

## Injection / consolidation budget (new in 0.32, reload required)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `budget.snapshotMaxChars` | number 500–60000 | `6000` | Character budget for the first-turn long-term snapshot; entries that do not fit are skipped (an ellipsis is appended) |
| `budget.hitMaxChars` | number 200–20000 | `1500` | Character cap per keyword-hit entry |
| `budget.reinjectMaxChars` | number 500–60000 | `8000` | Character cap for the post-compaction re-injection |
| `budget.dreamMaxContextTokens` | number 4000–400000 | `40000` | Estimated session context before **automatic** dream/reflection (**CJK-aware approximation**: Chinese ≈1.7 chars/token, other ≈4); above it the automatic run is **skipped** (manual `/dream` bypasses this gate). Later dream rounds **re-estimate** and finish early if the context has grown (entries stay unsealed and can be re-dreamed later) |
| `budget.dreamMaxPerWindowPerDay` | number 0–24 | `1` | Automatic dreams per window per day; `0` = never automatic |
| `budget.dreamMaxPerDayTotal` | number 0–200 | `12` | **Process-wide** automatic dream cap per day (rolling 24h; N windows no longer mean N× spend); `0` = automatic dream off. Counters live for the process lifetime and **reset on restart** |
| `budget.reflectMaxPerDay` | number 0–100 | `6` | Automatic reflections **per window (session)** per day; `0` = never automatic |
| `budget.reflectMaxPerDayTotal` | number 0–500 | `24` | **Process-wide** automatic reflection cap per day (rolling 24h, reset on restart); `0` = automatic reflection off |
| `budget.reflectMinIntervalMinutes` | number 0–1440 | `20` | Minimum interval between automatic reflections (minutes) |

> These are **character** caps, not token caps: zh ≈ chars/2.2, en ≈ chars/4. They bound one injection / one consolidation; daily totals are bounded by the frequency fields.
>
> The `memory_project` tool has its own output cap: `max(2000, budget.reinjectMaxChars)` (default **8000 chars**), truncated with `…`. It shares the paragraph builder with post-compaction re-injection, but this cap applies only to the tool output.
>
> The two `*MaxPerDayTotal` fields are **process-scoped** counters (rolling 24h): they only last for this process lifetime and **reset on restart/hot reload**. The per-window `dreamMaxPerWindowPerDay` / `reflectMaxPerDay` caps still apply independently. Manual `/dream` / `memory_dream` do not consume automatic quotas.

---

## Retrieval / forgetting (new in 0.32, reload required)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `retrieval.halfLifeDays` | number 1–3650 | `30` | Exponential half-life (days): `recency = 0.05 + 0.95·exp(-ln2·ageDays/halfLifeDays)`; `importance ≥ 3` keeps a 0.85 floor |
| `retrieval.minScore` | number 0–1 | `0.35` | Minimum score for a keyword hit to be injected |
| `retrieval.hitBoost` | bool | `true` | Hit-count reinforcement: `×(1 + 0.15·ln(1+hit_count))`, capped at 2.0 |
| `retrieval.importanceWeight` | bool | `true` | Importance participates in ranking: `×(0.85 + 0.05·importance)` (1→0.9, 4→1.05) |
| `retrieval.semantic.enabled` | bool | `false` | **0.35**: semantic retrieval master switch. Enabled only when `true` and `baseUrl`/`model` are non-empty; off (default) = **zero network requests**, behaviour identical to 0.34 |
| `retrieval.semantic.baseUrl` | string | `''` | OpenAI-compatible endpoint base (the request goes to `${baseUrl}/embeddings`, e.g. `http://127.0.0.1:11434/v1`) |
| `retrieval.semantic.model` | string | `''` | Embedding model name (served by the endpoint; no model is bundled) |
| `retrieval.semantic.apiKeyEnv` | string | `'MEOW_MEMORY_EMBEDDING_KEY'` | Env var holding the key. **If the default var is unset, requests are sent keyless** (local Ollama/LM Studio); only a *custom* var name that is missing counts as unconfigured (no request). When the key exists, `Authorization: Bearer $env` is sent |
| `retrieval.semantic.timeoutMs` | number 200–60000 | `5000` | Per-request embedding timeout (ms); timeout/failure silently falls back to pure lexical |
| `retrieval.semantic.weight` | number 0–1 | `0.8` | Semantic floor blend weight: `relevance = max(lexical, fuzzy, cos·weight·importanceWeight)`; `0` disables semantic scoring (requests may still happen — set `enabled: false` to stay offline) |

The per-message hit score is **not BM25**: keyword intersection × IDF × **query coverage** × exponential recency × importance weight × title boost. `memory_search` is BM25 (BM25 × recency).

> **0.33 hybrid lexical floor (fuzzy, no config toggle)**: character bigram Jaccard + 0.25×trigram Jaccard (NFKC, letters/digits only, CJK-safe without segmentation), noise floor 0.2. It is only a **floor** when BM25 is weak: `score = max(BM25, 0.55·fuzzy·recency·importance)` (per-message chain: `relevance = max(BM25 relevance, fuzzy)`); strong BM25 ordering is unchanged; `memory_search explain=true` may include `fuzzy`. Pure BM25 is a test/internal option (`SearchOptions.fuzzy = false`), not a user config field.

> Since 0.32 coverage is `matched query tokens / total query tokens`. The old denominator was the entry's keyword-token count, so writing more keywords (as the prompts demand) *lowered* the score — the exact opposite of the intent. Raise `minScore` (e.g. 0.5) for a quieter chain, lower it for higher recall.

> **0.35 optional semantic retrieval (`retrieval.semantic`, off by default)**: when enabled, cosine similarity between the query and entry embeddings is **also a floor**, with a **0.25 noise floor** (cos < 0.25 counts as 0, so unrelated entries cannot slip in on tiny similarity; negative/zero similarity counts as 0): `relevance = max(lexical, fuzzy, cos·weight·importanceWeight)`; `memory_search` multiplies by recency and `explain` gains `semantic`. **It is not a rerank** and may admit weak matches. Data flow: with it enabled, `memory_remember`/`memory_update` (content/keywords changes) embed inline after the write (bounded by `timeoutMs`, failures silent); after plugin apply it **backfills in the background** the global store (soul/user/rules) and every trusted workspace (project/fact/lesson/topic/rules), ≤50 rows per level, retrying next start on failure. Embeddings live in a nullable `embedding TEXT` (JSON) column added lazily to each table and therefore travel with the DB/backups. **Privacy**: with it enabled, **memory bodies/titles/keywords** and **user message/query text** are sent to your configured `/embeddings` endpoint; with it disabled nothing is sent. **Changing the embedding model invalidates stored vectors** (model-specific; different dimensions count as 0) — re-write entries or clear and re-backfill. An unreachable endpoint silently degrades to pure lexical and never blocks injection/retrieval/writes. The settings page does **not** expose these fields.

---

## Reflection

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reflect` | bool | `true` | Automatic reflection after a task |
| `reflectTurns` | number 1–50 | `7` | Consecutive tool steps needed to trigger at task end |
| `budget.reflectMaxPerDay` | number | `6` | See budget table; `0` = never automatic |
| `budget.reflectMaxPerDayTotal` | number | `24` | Process-wide automatic reflection cap/day (rolling 24h, reset on restart); see budget table |
| `budget.reflectMinIntervalMinutes` | number | `20` | See budget table |
| `budget.dreamMaxContextTokens` | number | `40000` | Reflection reuses this context-size gate |

---

## dream (idle consolidation)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `dream.enabled` | bool | `true` | Allow automatic consolidation |
| `dream.idleMinutes` | number ≥1 | `180` | Window idle time before it becomes dream-eligible |
| `dream.suppressWindows` | `{start,end}[]` | 09:00–12:00, 14:00–18:00 | Suppression windows (in `timeZone`) |
| `dream.suppressLeadMinutes` | number 0–120 | `15` | Extra suppression minutes before each window |
| `dream.checkMinutes` | number ≥1 | `15` | Check interval |
| `dream.timeZone` | string | `Asia/Shanghai` | Timezone for suppression windows |
| `dream.rulesReviewDays` | number ≥0 | `2` | Stable rules older than this skip dream round 1; `0` = no filter |
| `dream.requireLiveAgent` | bool | `true` | Automatic dream only runs for windows with a live agent; it **never** calls `agents.resume()` (#49). Manual `/dream` / `memory_dream` bypass this automatic gate (manual invocation already requires a live window) |
| `dream.isolated` | bool | `false` | **0.34**: automatic dream runs in an **isolated spawn child session** — no model-visible dream turn in the main session, **zero main-context growth** (child tokens are still billed). Off by default; manual `/dream` / `memory_dream` **always** use the main-agent path. The child inherits the parent's agent preset (`memory_*` visibility depends on that preset) |
| `dream.isolatedProvider` | string | `'spawn'` | Child provider; must have `inheritsParentContext === false` (spawn qualifies, fork does not). If the service/provider is unavailable **or the child start is rejected (sync/async — depth/capacity/auth)**, the plugin falls back to the main-agent dream (async rejection logs `isolated-dream rejection -> main-dream fallback`) |
| `dream.isolatedTimeoutMinutes` | number 1–120 | `20` | Isolated-dream timeout (minutes): on timeout the child is disposed, the lease released and the next sweep retries; consecutive failures seal at the existing 3-attempt limit |
| `dream.isolatedMaxPromptChars` | number 2000–60000 | `20000` | Character cap for the child's single prompt (digest + entry rows); overflow trims oldest entries/projects/digest head |
| `dream.isolatedArchiveChild` | bool | `true` | Archive the child **after it settles** (`workspaceRegistry.archiveSession`, best-effort; **both success and failure** — leaves a plaintext child-session copy) |

All conditions must hold for an automatic dream: `dream.enabled` → idle ≥ `idleMinutes` → not in a suppression window → a **live agent** exists → estimated context ≤ `budget.dreamMaxContextTokens` → today's count < `budget.dreamMaxPerWindowPerDay` → process-wide today's count < `budget.dreamMaxPerDayTotal`. Later rounds re-estimate the context and finish early if oversized (entries stay unsealed, can be re-dreamed later); round 1/2 entry lists are ordered by the newest **`updated_at`** (not `created_at`), so recently-touched old entries are not starved by the 60-row cap. Every skip reason is logged (`security.debugLogs` for detail).

**Isolated path (`dream.isolated: true`)**: the main-context `dreamMaxContextTokens` gate **does not apply** (the child prompt is independently capped by `isolatedMaxPromptChars`); frequency/cooldown/peak/process-wide caps still apply. The child is **empty-context** (does not inherit the main transcript) but **inherits the parent's agent preset**, so `memory_*` tool visibility depends on that preset's tool set; it receives the dream prompts + a digest of recent user/assistant text and tool names (no tool results/plugin notices) + entry lists; on success the child's written entries have their `source_session` adopted to the parent (`adoptSessionEntries`) before sealing, and partial results are kept; timeout/failure/abort falls back to the main-agent path. **Isolated dream cannot be aborted from the UI**; `delegate.model` is also used for the isolated child; `isolatedArchiveChild` archives the child after settle (**success and failure**; leaves a plaintext child-session copy).

> **0.34.1 compat fix**: 0.34.0 sent `maxDepth: 0` to spawn; DSH 0.2.1 reads `maxDepth` as the child's own allowed depth and rejected with `SubagentDepthError`, so isolated dream never ran. 0.34.1 sends **no `maxDepth`** (host default 1), and a rejected start falls back to the main-agent dream in the same sweep.

**Manual `/dream` / `memory_dream` bypass these cost gates** (manual = explicit intent; only the automatic path calls `evaluateAutoDreamGate`): they run up to 3 rounds over the **full session context** (atomic / topic / project summary), are never skipped for being oversized, and **always use the main agent** (the isolated mode applies to automatic dream only). If the context is large, run `/compact` first.

> The default suppression windows come from upstream and follow GLM/Zhipu peak-tariff hours, not DeepSeek's discount window. Adjust to your provider.

---

## Migration and backup

| Field | Type | Default | Meaning |
|---|---|---|---|
| `autoMigrate` | bool | **`false`** (since 0.32) | Automatically migrate a legacy `PROJECT.md` when the DB is first opened. Off = unknown `PROJECT.md` in a workspace is never imported without consent |
| `backup.enabled` | bool | `false` | At each dream's end, snapshot the **workspace store** and the **user-scope global store** into their own `memory.db.bak` (`VACUUM INTO`, mtime-based increment). Empty/untrusted/missing global stores are skipped (no directory is created for a backup). Consumed at registration — reload required |

---

## delegate (consolidation model override)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `delegate.model` | string | `''` (main model throughout) | Model for reflection/dream turns: `'provider/model'` selects provider+model, `'model'` changes only the model (provider inherited) |

> **#71 warning**: only triggered when `delegate.model` is set — after a reflection turn later requests may stay on the delegate model due to a host-side `request/header` projection bug. The default empty value does not trigger. Leave it empty to avoid.

---

## `promptLang`: prompt and retrieval language (important)

`promptLang` decides: (1) the language of injected/reflection/dream prompts; (2) the language of tool descriptions. It also shapes the language the model writes entries in — keywords are extracted in the entry's language, so **match the language you speak**.

**Set it explicitly on first use**: `'zh'` (default), `'en'`, `'pt-br'`. The value *is* the subdirectory name under `src/prompts/` and is matched **verbatim**: a name that does not exist (e.g. `pt`) raises nothing and silently falls back to the Chinese pack.

If unset: runs as `zh`, and the first real user message after the plugin activates gets a one-time "first setup" guide (the AI detects the user's language and sets it; at most once per session).

**Retrieval side**: BM25 tokenization is language-independent (CJK bigrams / other Unicode words); `en` adds English stopwords + Porter stemming. **`pt-br` has no Portuguese stemming/stopword normalisation** — Portuguese recall is weaker than English. Known limitation.

**Custom overrides**: drop same-named slot files under `$DSH_HOME/storages/meow-memory/prompts/<lang>/<slot>.md` (`$DSH_HOME` defaults to `~/.dsh`; partial overrides allowed). That path is **fixed**: it does not follow `homeDir` / `memory_home` / `MEOW_MEMORY_HOME`, and the old location (a `prompts/` folder inside the global directory) is no longer read — otherwise one directory switch could rewrite every injected instruction (#64-2).

---

## UI language

The plugin's UI copy (fold bars, bubbles, menus, settings page) follows DSH's Settings → General → Language: Chinese / English / Português (Brasil). Separate from `promptLang`; they do not interfere. On old hosts without a locale service it degrades to browser language + built-in dictionaries, ending at `zh`.

---

## Turning automatic spend off

```yaml
config:
  reflect: false                 # disable automatic reflection
  dream:
    enabled: false               # disable automatic dream (manual /dream & memory_dream still work)
  budget:
    dreamMaxPerWindowPerDay: 0   # or only zero the automatic dream frequency
    reflectMaxPerDay: 0          # or only zero the automatic reflection frequency
```

Per window: session row "…" menu → **Memory participation** → turn off auto-injection / auto-consolidation.  
To avoid the ≈6.7k-token static tax entirely, the plugin must be disabled.

---

## Related docs

- [Tool reference](tool-reference.md) — parameters and returns of the 10 tools
- [Design notes](design-notes.md) — why it is designed this way (cost and security trade-offs)
- [Troubleshooting](troubleshooting.md) — install failures, poor recall, how to read errors
