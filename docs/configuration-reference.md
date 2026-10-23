# Configuration reference (0.32 fork)

Every field is optional. Two ways to set them:

- **Config file** (profile patch / `cordis.patch.yml` under `config:`) — **the 0.32 `security` / `budget` / `retrieval` groups can only be set this way**;
- **DSH settings page**, the "Meow memory" tab — covers the fields that existed in 0.31 (master switch, directories, hits, reflection, dream, delegate, language). Per-field save; "Restore default" goes back to the plugin factory default, not the patch baseline.

All changes take effect after a **hot reload or restart of the meow-memory plugin** (config is parsed once at apply).

> 0.32 hardening: default automatic behaviour goes from unbounded to bounded. No feature is silently switched off. To cut cost, see [Turning automatic spend off](#turning-automatic-spend-off).

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
      reflectMaxPerDay: 6
      reflectMinIntervalMinutes: 20
    retrieval:                   # new in 0.32
      halfLifeDays: 30
      minScore: 0.35
      hitBoost: true
      importanceWeight: true
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
    delegate:
      model: ''
```

---

## Basics and directories

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch. `false` disables injection, reflection and all tools |
| `projectDir` | string | `.dsh-meow` | Memory directory, **relative to the workspace**: `<workspace>/<projectDir>/memory.db` |
| `homeDir` | string | `''` (= platform user home) | **Instance-level global directory**: logs / window index / migrate state. Values below. **Prompt overrides are NOT here** (see the `promptLang` section below) |
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
| `budget.dreamMaxContextTokens` | number 4000–400000 | `40000` | Estimated session context before **automatic** dream/reflection (**CJK-aware approximation**: Chinese ≈1.7 chars/token, other ≈4); above it the automatic run is **skipped** (manual `/dream` bypasses this gate) |
| `budget.dreamMaxPerWindowPerDay` | number 0–24 | `1` | Automatic dreams per window per day; `0` = never automatic |
| `budget.reflectMaxPerDay` | number 0–100 | `6` | Automatic reflections **per window (session)** per day; `0` = never automatic |
| `budget.reflectMinIntervalMinutes` | number 0–1440 | `20` | Minimum interval between automatic reflections (minutes) |

> These are **character** caps, not token caps: zh ≈ chars/2.2, en ≈ chars/4. They bound one injection / one consolidation; daily totals are bounded by the frequency fields.
>
> The `memory_project` tool has its own output cap: `max(2000, budget.reinjectMaxChars)` (default **8000 chars**), truncated with `…`. It shares the paragraph builder with post-compaction re-injection, but this cap applies only to the tool output.

---

## Retrieval / forgetting (new in 0.32, reload required)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `retrieval.halfLifeDays` | number 1–3650 | `30` | Exponential half-life (days): `recency = 0.05 + 0.95·exp(-ln2·ageDays/halfLifeDays)`; `importance ≥ 3` keeps a 0.85 floor |
| `retrieval.minScore` | number 0–1 | `0.35` | Minimum score for a keyword hit to be injected |
| `retrieval.hitBoost` | bool | `true` | Hit-count reinforcement: `×(1 + 0.15·ln(1+hit_count))`, capped at 2.0 |
| `retrieval.importanceWeight` | bool | `true` | Importance participates in ranking: `×(0.85 + 0.05·importance)` (1→0.9, 4→1.05) |

The per-message hit score is **not BM25**: keyword intersection × IDF × **query coverage** × exponential recency × importance weight × title boost. `memory_search` is BM25 (BM25 × recency).

> Since 0.32 coverage is `matched query tokens / total query tokens`. The old denominator was the entry's keyword-token count, so writing more keywords (as the prompts demand) *lowered* the score — the exact opposite of the intent. Raise `minScore` (e.g. 0.5) for a quieter chain, lower it for higher recall.

---

## Reflection

| Field | Type | Default | Meaning |
|---|---|---|---|
| `reflect` | bool | `true` | Automatic reflection after a task |
| `reflectTurns` | number 1–50 | `7` | Consecutive tool steps needed to trigger at task end |
| `budget.reflectMaxPerDay` | number | `6` | See budget table; `0` = never automatic |
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

All conditions must hold for an automatic dream: `dream.enabled` → idle ≥ `idleMinutes` → not in a suppression window → a **live agent** exists → estimated context ≤ `budget.dreamMaxContextTokens` → today's count < `budget.dreamMaxPerWindowPerDay`. Every skip reason is logged (`security.debugLogs` for detail).

**Manual `/dream` / `memory_dream` bypass these cost gates** (manual = explicit intent; only the automatic path calls `evaluateAutoDreamGate`): they run up to 3 rounds over the **full session context** (atomic / topic / project summary) and are never skipped for being oversized. If the context is large, run `/compact` first.

> The default suppression windows come from upstream and follow GLM/Zhipu peak-tariff hours, not DeepSeek's discount window. Adjust to your provider.

---

## Migration and backup

| Field | Type | Default | Meaning |
|---|---|---|---|
| `autoMigrate` | bool | **`false`** (since 0.32) | Automatically migrate a legacy `PROJECT.md` when the DB is first opened. Off = unknown `PROJECT.md` in a workspace is never imported without consent |
| `backup.enabled` | bool | `false` | At each dream's end, snapshot `memory.db` into `memory.db.bak` (`VACUUM INTO`, mtime-based increment). Consumed at registration — reload required |

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
