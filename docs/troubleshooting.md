# Troubleshooting (0.36 fork)

Start here when installation fails, recall is poor, or behaviour is unexpected.

---

## Installation

### Where do I install this fork from?

**It is not published to the npm registry.** Two supported routes:

1. **Local directory / tarball**: in this repository run `npm install && npm run build`, then GUI **Plugins → Add plugin** with the repository's absolute path, or with the absolute path of the `.tgz` produced by `npm pack`;
2. **Manual profile install**: copy/junction the package into `~/.dsh/profiles/<profile>/node_modules/meow-memory` and add it to `dsh.profile.bundles`.

> `npm install meow-memory` installs **upstream 0.31.1**, not this fork.

### Why not `dsh plugin add github:...`?

A `github:` / git dependency installs **devDependencies and runs `prepare` (esbuild build)**. That needs GitHub reachability, pnpm build-script approval (`allowBuilds` — pnpm ≥10 blocks it by default) and resolvable `@deepseek-ai/dsh-*` devDeps. Any failure rolls the profile back. Use the prebuilt tarball/local directory instead.

### First `dsh plugin add` fails mentioning `allowBuilds`

pnpm ≥10 blocks install-time build scripts. Add the printed keys to the profile's `pnpm-workspace.yaml` and retry. Only github/git or raw-source installs need a build; a prebuilt tarball does not.

### Node version

`node:sqlite` is a runtime dependency: **Node ≥22.13 by default**; 22.5–22.12 needs `--experimental-sqlite`. No native modules.

### Peer dependency `@deepseek-ai/schemastery`

It is declared as a **peerDependency** and kept external at build time so the config schema uses the same constructor as the running host. Profile-bundle installs resolve it from the host; no action needed. If the settings page and the plugin disagree on schema behaviour, prefer the dsh plugin channel.

### Does uninstalling delete my memories?

**No.** Uninstalling only removes the code. Clean up manually if desired:

```
<workspace>/.dsh-meow/                       # workspace memory.db, sessions/, .owner.json, .gitignore
~/.dsh-meow/                              # or your homeDir: global/memory.db (user-scope global store), logs, window-index
$DSH_HOME/storages/meow-memory*           # install-id, prompt overrides, memory_home switch pointer
```

### After upgrading from upstream 0.31 my memories don't work / the store is "not trusted"

The old `memory.db` has no `.owner.json` marker, so this fork classifies it as **foreign/untrusted** on first run (**even an empty upstream DB counts as pre-existing**): the store is not opened (no upgrade/index/migration/read), its content is not injected, memory tool reads/writes plus dream/reflection are refused, and the one-time untrusted-store notice appears. To keep the old memories:

- set `security.trustWorkspaceMemory: true` in the profile config and reload the plugin (only after confirming the store is yours); or
- delete/rename the old store and start fresh (back it up first — deletion is irreversible).

> **0.33 upgrade note**: once the workspace store is trusted, the first session **migrates existing soul/user/global rules into the user-scope global store** (workspace originals are archived, recoverable). If the global store itself is absent/untrusted, the plugin automatically falls back to 0.32 single-workspace behaviour (no error); there is no `trustWorkspaceMemory` override for the global store, and a global dir copied from another machine is foreign.

---

## Cost and automatic behaviour

### Why is it spending tokens when I never asked it to remember anything?

By default the plugin automatically: attaches the static manual + tool descriptions to **every request** (≈6.7k tokens measured, Chinese pack; ≈6.3k English), injects a snapshot on the first turn, and runs automatic dream/reflection (full-context requests) when conditions hold. That is the inherent cost of automatic memory and does not depend on you calling tools.

Full list and caps: [README cost section](../README.en.md#read-this-first-it-spends-tokens-automatically). To turn the automatic parts off:

```yaml
config:
  reflect: false
  dream:
    enabled: false
```

Or per window: session row "…" menu → **Memory participation** → turn off auto-injection / auto-consolidation.

### Why didn't dream run / reflection fire?

0.32's automatic consolidation is bounded by default; all conditions must hold:

| Possible reason | Detail |
|---|---|
| Window not idle long enough | Idle ≥ `dream.idleMinutes` (default 180 min) |
| In a suppression window | Default Beijing 09:00–12:00, 14:00–18:00 plus 15 min before each |
| **No live agent** | Since 0.32 automatic dream never `agents.resume()`s a bare agent (#49) |
| Context too large | Estimated context > `budget.dreamMaxContextTokens` (default 40000) |
| Already dreamt today | `budget.dreamMaxPerWindowPerDay` default 1 |
| **Process-wide quota used up** | `budget.dreamMaxPerDayTotal` default 12/day (process-scoped rolling 24h, reset on restart); `0` = automatic dream off |
| Context grew mid-dream | Later rounds re-estimate and finish early above `dreamMaxContextTokens` (entries stay unsealed; can be re-dreamed later) |
| Isolated dream unavailable | `dream.isolated: true` but the host `subagents` service / `spawn` provider (needs `inheritsParentContext=false`) is missing → one log then fallback to the main-agent dream |
| Isolated dream failed/timed out | The child is disposed, the lease released and the next sweep retries; 3 consecutive failures seal the window (manual `/dream` still works) |
| Window marked skipped | Restore from the session row "…" menu |
| Too old / archived | No live agent and >24h old, or archived sessions, are skipped |
| Last message older than last dream | Only windows whose last message is newer than the last dream are consolidated |

Reflection additionally has `budget.reflectMinIntervalMinutes` (default 20), `budget.reflectMaxPerDay` (default 6/window/day) and the process-wide `budget.reflectMaxPerDayTotal` (default 24/day, reset on restart). With `security.debugLogs: true` the skip reason is logged.

### How do I consolidate right now?

Type `/dream` in the composer (same as the `memory_dream` tool; **not** subject to peak suppression or the daily cap). Manual always uses the main-agent path (the isolated mode applies to automatic dream only).

### With `dream.isolated` enabled, why is there no dream turn in the main session?

That is 0.34's isolated dream (off by default): automatic dream runs in a **spawned empty-context child session**, so the main session gets no model-visible dream turn (only log-only catalog facts) → **zero main-context growth**; child tokens are still billed and child-written entries are adopted into the parent then sealed. Trade-offs: the child only receives the dream prompts + a recent-conversation digest + entry lists (no tool results/plugin notices), so **consolidation quality is lower than the main-context path**; **isolated dream cannot be aborted from the UI** (it ends on completion/timeout/failure). The child inherits the parent's agent preset, so `memory_*` visibility depends on it; `isolatedArchiveChild` archives the child after settle (success or failure, leaving a plaintext copy). If `subagents`/`spawn` is unavailable the plugin falls back to the main-agent dream.

### `dream.isolated` is on but nothing gets consolidated

**0.34.0 has a maxDepth compat bug**: it sent `maxDepth: 0` to spawn; DSH 0.2.1 reads `maxDepth` as the child's own allowed depth and rejected the start (`SubagentDepthError: subagent depth 1 exceeds maxDepth 0`), so isolated dream never ran — upgrade to **0.34.1** (no `maxDepth` is sent). If the child start is still rejected (depth/capacity/auth), 0.34.1 falls back to the main-agent dream in the same sweep (log `isolated-dream rejection -> main-dream fallback`); if nothing consolidates at all, enable `security.debugLogs` and inspect `isolated-dream` log lines.

---

## Retrieval and hits

### Why no keyword hit on the first message?

**The first turn does not run keyword hits** (they start from the second message); it injects the long-term snapshot only. See [design notes](design-notes.md).

### Low recall / misses

Most likely causes:

1. **`promptLang` not set explicitly** — it shapes the entry language and keywords are extracted per entry language. The value is matched verbatim against a subdirectory name; a typo silently falls back to Chinese.
2. **Hits match keywords, not full text** — fix keywords with `memory_update`, or find the entry with `memory_list` and rewrite it. Since 0.32 `minScore` (default 0.35) filters weak hits; raise it for a quieter chain, lower for more recall. 0.33's fuzzy floor rescues lexical variants/inflections/word boundaries (not paraphrases); 0.35's optional semantic layer (off by default) covers some paraphrases but is only a floor, not a quality guarantee (see below).
3. **`hit_count` feedback needs time** — since 0.32 hit counts participate in ranking, but they cannot make an entry precise on their own.
4. **`pt-br` has no Portuguese stemming/stopwords**, so Portuguese recall is weaker than English (known limitation).

### How do I enable semantic retrieval (0.35)? Why is it not helping / what data is sent?

0.35 adds optional `retrieval.semantic`, **off by default = zero network**. To enable: `enabled: true` + non-empty `baseUrl` + `model`. Key points:

- **Transport requirement (0.35.1)**: only `https://` or **loopback** `http://` (`localhost`/`127.x`/`[::1]`, e.g. local Ollama `http://127.0.0.1:11434/v1`). A remote plain-`http://` base is **rejected and falls back to lexical** (zero requests, so memory bodies/queries/Bearer key never cross the network in cleartext).
- **No local model**: the plugin bundles no embedding model; bring your own endpoint. If the default env var `MEOW_MEMORY_EMBEDDING_KEY` is unset, requests are **keyless** (local servers); only a *custom* `apiKeyEnv` whose variable is missing counts as unconfigured (no request).
- **Privacy**: when enabled, **memory bodies/titles/keywords** (writes + backfill) and **user message/query text** go to the configured endpoint; off sends nothing.
- **Effect**: cosine is only a **floor** (0.25 noise floor, below counts as 0; negative/zero as 0), no rerank, weak matches may enter; `memory_search explain=true` shows a `semantic` component.
- **Latency**: a hanging endpoint adds up to `timeoutMs` (5s default) to each user message/`memory_search`/write; no throw, lexical results still returned; connection-refused fails fast.
- **Old entries**: after enabling, plugin apply backfills in the background (global store + trusted workspaces; on cold start trust is judged read-only first, ≤50 rows/level; retried next start). The first enable sends historical data to the endpoint.
- **Size**: vectors are JSON text in the DB/backups — ≈31 KiB/row at 1536 dims (1k entries ≈30 MB), plaintext derived data.
- **Failures**: timeout (5s default)/network error/non-2xx silently fall back to pure lexical; they only add bounded latency (≤`timeoutMs`) and never make injection/retrieval/writes fail.
- **Changing models**: stored vectors are model-specific; a new model/dimensions invalidates old vectors (score 0) — re-write or clear and re-backfill.
- **Not exposed on the settings page**: `retrieval.semantic` is profile-patch only; reload/restart the plugin after editing.
- **Forgetting**: since 0.35.1 recall refreshes the decay curve (`last_accessed_at`), so recently recalled memories decay more slowly.

### Hits are metadata, not answers

`memory_search` returns a metadata view (project, id, time, keywords, truncated content). Use `memory_read` for the full text, `memory_project` for the project panorama, and `memory_list` for a whole-store metadata inventory.

### Casual chat hits an unrelated project

Unanchored sessions only hit global entries. A `project` argument on `memory_remember/search/update/project` anchors the session's current project.

### What goes in the global marker?

Information that applies everywhere uses the **global marker** (`project.global` in the current language pack: `全局` in zh, `global` in en/pt-br). Applies to several projects: comma-separated, e.g. `"dsh, femo"`.

---

## Security and trust

### Will my memories end up in git?

By default no: when creating the memory directory the plugin writes `.gitignore` with `*` (self-ignoring), and **appends a `*` line if a pre-existing `.gitignore` lacks one** (blocks `!*` re-inclusion), so `git add .` will not commit `memory.db`. It is **not encrypted** though — do not put secrets in memories; `.gitignore` does not protect backups or sync folders.

### Why does the plugin say my store is not trusted?

If the workspace already contains a `.dsh-meow/memory.db` that this plugin did not create (a valid `.owner.json` is what proves ownership), 0.32 treats it as **untrusted — even when it is empty/schema-only**: the store is not opened (no upgrade/index/migration/read), its content is not injected, and **every memory tool (read and write), dream and reflection is refused** with an untrusted-store error. That blocks #64-1 (a cloned repo planting poisoned memories) and the "pre-seeded empty DB + triggers" path.

A valid marker requires: `schema=1`, `installId` equal to this machine's random install id, and `workspace` matching the current path. If the store is yours: set `security.trustWorkspaceMemory: true` and reload, or delete/rename the file and rebuild.

> **0.33 global store**: `<homeDir>/global/memory.db` has the same trust gate (`.owner.json`, `workspace: ''`). A foreign global store does not error; the plugin **falls back to 0.32 single-workspace behaviour** (soul/user/global rules go to the workspace store). It has no `trustWorkspaceMemory` override.

### How do I edit global memory directly (0.36)? Why didn't a save apply immediately?

Settings → "Meow memory" → bottom card "Global memory (user-scope)" (0.36): lists the user-scope global store's `soul` / `user` / global `rules` (incl. archived, restorable); inline edit content / keywords / importance, create, archive/restore. **Global scope only**; project-level rules and fact/lesson/topic still use `memory_*` tools.

- **A save does not change the current session immediately**: the host only marks **related sessions** for reinject — window index + `sessionPersistence` sessions (**since 0.36.1 both the header shape `{header:{id,cwd}}` and the flat `{id,cwd}` shape are read**, so cold/unopened sessions also refresh on their next message; 0.36.0 read only the flat shape and missed them), requiring a trusted memory.db; at most 2000 sessions per save, already pending not rewritten. They re-inject the updated global memory on their **next user message** (no history rewrite, no immediate model call). The UI shows "saved · N sessions marked for re-injection next turn"; sessions with no next message keep their old snapshot.
- **Untrusted global store**: the editor shows a warning and refuses writes (error `global store unavailable or untrusted`); it never opens a foreign store.
- **No hard delete**: archive instead; archived entries are not injected but remain in the store and are restorable. Content/keyword changes clear that entry's embedding (rebuilt by a later backfill/write).
- **Limits**: still effective only on the next user message; marking is bounded (≤2000 sessions per save); last-write-wins, no bulk import/conflict merge; the routes are plugin-private (not a public API); dream/reflection can still reorganize entries afterwards.
- **Config fields are still not exposed on the settings page**: `security` / `budget` / `retrieval` remain profile-patch only (the editor edits data, not config).

### Is my old `PROJECT.md` migrated automatically?

**Not since 0.32** (`autoMigrate` defaults to `false`). Enable it explicitly and only for a workspace you trust.

### Why can't `memory_home` switch directories anymore?

Since 0.32 it is query-only by default (`security.allowHomeSwitch: false`): the tool is model-callable and the directory is also the prompt-override root, so the model must not be able to move it (#64-2). Enable it explicitly in the config if you need switching.

### Where does the data live (two layers)? Will a new workspace remember me?

Since 0.33 storage is two-layer:

- **User-scope global store**: `<homeDir>/global/memory.db` (default `~/.dsh-meow/global/memory.db`), holding `soul` / `user` / global `rules` — **shared across workspaces**; these survive switching workspaces.
- **Workspace store**: `<workspace>/<projectDir>/memory.db` (`projectDir` default `.dsh-meow`), holding `project` / `fact` / `lesson` / `topic` / project rules — a new workspace starts with fresh project memory.
- Session bookkeeping: `<workspace>/.dsh-meow/sessions/<id>.json`
- Trust markers: `.owner.json` in each store directory (global store uses `workspace: ''`).
- Instance-level global directory (global store, logs / window index / migrate state): default `~/.dsh-meow` (**outside `DSH_HOME`**), or `homeDir` / `MEOW_MEMORY_HOME`; `homeDir`/`memory_home` switches move the global store too.
- Prompt instance overrides: `$DSH_HOME/storages/meow-memory/prompts/<lang>/<slot>.md` (fixed; does not follow `homeDir`/`memory_home` switches).

> On first upgrade to 0.33, the first trusted session per workspace **migrates old workspace soul/user/global rules into the global store and archives the workspace originals** (recoverable); since 0.34 `backup.enabled` backs up both the workspace store and the global store (an empty/untrusted global store is skipped and no directory is created). Backups are each store's `memory.db.bak`. **0.35 semantic**: when enabled, each table lazily gains a nullable `embedding TEXT` (JSON vector) column and vectors travel with the DB/backups; when disabled no column is added and no vectors are written. Vector size: ≈31 KiB/row at 1536 dims (1k entries ≈30 MB), plaintext derived data.

---

## Compatibility (0.2.1-rc.2)

### Which DSH versions are supported?

This fork was **verified on DSH Desktop 0.2.1-rc.2** (Electron 44.7.0 / Node 24.21.0, Windows 11): isolated load succeeded, the 4 routes returned 200/401 under auth, the settings namespace appeared, no apply error; the 0.34 live load with `dream.isolated: true` only verified loading (the 0.34.0 child-start bug was found later by re-audit and fixed in 0.34.1); 0.35 additionally ran live loads with default and semantic-enabled configs (both loaded cleanly, no apply error, **zero embedding requests at boot when disabled**, no real-home writes); 0.35.1 is audit remediation (transport policy/cold-start backfill/review refresh); 0.36's editor routes were exercised with a live-boot 401/200 round-trip (mock webServer/auth + isolated instance). **0.1.x was not tested**; the "supports dsh 0.1.5" claim is gone.

### Settings page saves but nothing changes

On 0.2.x the settings service was redesigned and the plugin takes a degraded path. The page renders, but "edit → save → reload → applied" was not verified by this fork; worst case it displays values without reaching apply. Run the [README self-check list](../README.en.md#self-check-after-install); otherwise edit the profile patch config directly. **0.35's `retrieval.semantic` does not appear on the settings page** — profile patch only; **since 0.36 the bottom of the settings page also has the "Global memory (user-scope)" editor (data editing, not config)**.

### Tool set shrinks after dream / model changes

- **#66 (unfixed)**: after a dream the session tool set can lock to 9 memory tools and requires a **dsh restart**. The plugin sets no tool filter, indicating host background-turn policy; 0.32's automatic dream uses the live-agent path, but manual dream can still trigger it.
- **#71 (unfixed)**: only when `delegate.model` is set; the default empty value does not trigger.
- On either signal, restart dsh; if it persists, open an issue with `security.debugLogs: true` logs.

### Client UI (fold bars, moon icons) disappeared

They depend on 0.2.x `ChatSnapshot` internals and DOM observation; a host patch can silently disable them. Cosmetic only — memory data and tools are unaffected.

---

## Extending and languages

### Why are the UI language and the prompt language different?

UI copy follows DSH's Settings → General → Language (UI layer); model prompts follow `promptLang` (prompt layer). They do not interfere.

### Adding a UI language / a prompt language

UI: add a dictionary file + one `SUPPORTED_UI_LOCALES` entry — see [`src/i18n/README.md`](../src/i18n/README.md).  
Prompts: add `src/prompts/<lang>/` and make `node scripts/check-lang.mjs <lang>` green — see [`src/prompts/README.md`](../src/prompts/README.md). Instance overrides go under `$DSH_HOME/storages/meow-memory/prompts/<lang>/<slot>.md` (fixed path; does not follow `homeDir`/`memory_home` switches).

---

## Related docs

- [Tool reference](tool-reference.md)
- [Configuration reference](configuration-reference.md)
- [Design notes](design-notes.md)
