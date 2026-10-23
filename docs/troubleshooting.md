# Troubleshooting (0.32 fork)

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
<workspace>/.dsh-meow/
~/.dsh-meow/                    # or your configured homeDir
~/.dsh/storages/meow-memory-home.json
```

### After upgrading from upstream 0.31 my memories don't work / the store is "not trusted"

The old `memory.db` has no `.owner.json` marker, so this fork classifies it as **foreign/untrusted** on first run (**even an empty upstream DB counts as pre-existing**): the store is not opened (no upgrade/index/migration/read), its content is not injected, memory tool reads/writes plus dream/reflection are refused, and the one-time untrusted-store notice appears. To keep the old memories:

- set `security.trustWorkspaceMemory: true` in the profile config and reload the plugin (only after confirming the store is yours); or
- delete/rename the old store and start fresh (back it up first — deletion is irreversible).

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
| Window marked skipped | Restore from the session row "…" menu |
| Too old / archived | No live agent and >24h old, or archived sessions, are skipped |
| Last message older than last dream | Only windows whose last message is newer than the last dream are consolidated |

Reflection additionally has `budget.reflectMinIntervalMinutes` (default 20) and `budget.reflectMaxPerDay` (default 6). With `security.debugLogs: true` the skip reason is logged.

### How do I consolidate right now?

Type `/dream` in the composer (same as the `memory_dream` tool; **not** subject to peak suppression or the daily cap).

---

## Retrieval and hits

### Why no keyword hit on the first message?

**The first turn does not run keyword hits** (they start from the second message); it injects the long-term snapshot only. See [design notes](design-notes.md).

### Low recall / misses

Most likely causes:

1. **`promptLang` not set explicitly** — it shapes the entry language and keywords are extracted per entry language. The value is matched verbatim against a subdirectory name; a typo silently falls back to Chinese.
2. **Hits match keywords, not full text** — fix keywords with `memory_update`, or find the entry with `memory_list` and rewrite it. Since 0.32 `minScore` (default 0.35) filters weak hits; raise it for a quieter chain, lower for more recall.
3. **`hit_count` feedback needs time** — since 0.32 hit counts participate in ranking, but they cannot make an entry precise on their own.
4. **`pt-br` has no Portuguese stemming/stopwords**, so Portuguese recall is weaker than English (known limitation).

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

### Is my old `PROJECT.md` migrated automatically?

**Not since 0.32** (`autoMigrate` defaults to `false`). Enable it explicitly and only for a workspace you trust.

### Why can't `memory_home` switch directories anymore?

Since 0.32 it is query-only by default (`security.allowHomeSwitch: false`): the tool is model-callable and the directory is also the prompt-override root, so the model must not be able to move it (#64-2). Enable it explicitly in the config if you need switching.

### Where does the data live?

- Workspace: `<workspace>/<projectDir>/memory.db` (`projectDir` default `.dsh-meow`)
- Session bookkeeping: `<workspace>/.dsh-meow/sessions/<id>.json`
- Trust marker: `<workspace>/.dsh-meow/.owner.json`
- Instance-level global directory (logs / window index / migrate state): default `~/.dsh-meow` (**outside `DSH_HOME`**), or `homeDir` / `MEOW_MEMORY_HOME`
- Prompt instance overrides: `$DSH_HOME/storages/meow-memory/prompts/<lang>/<slot>.md` (fixed; does not follow `homeDir`/`memory_home` switches)

---

## Compatibility (0.2.1-rc.2)

### Which DSH versions are supported?

This fork was **verified on DSH Desktop 0.2.1-rc.2** (Electron 44.7.0 / Node 24.21.0, Windows 11): isolated load succeeded, the 3 routes returned 200/401 under auth, the settings namespace appeared, no apply error. **0.1.x was not tested**; the "supports dsh 0.1.5" claim is gone.

### Settings page saves but nothing changes

On 0.2.x the settings service was redesigned and the plugin takes a degraded path. The page renders, but "edit → save → reload → applied" was not verified by this fork; worst case it displays values without reaching apply. Run the [README self-check list](../README.en.md#self-check-after-install); otherwise edit the profile patch config directly.

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
