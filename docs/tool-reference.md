# Tool reference (0.33 fork)

meow-memory registers **10** memory tools. Three bands: **read** (search / read / find_similar / project / list), **write** (remember / update / forget / dream), **directory** (home).

> Tool descriptions and returned copy follow the `promptLang` language pack. Parameter schemas do not change with language.
>
> Since 0.33 storage is **two-layer** (user-scope global store + workspace store); write routing, read merging and migration are in [Layered storage and tool routing](#layered-storage-and-tool-routing-033).

---

## At a glance

| Tool | Band | Purpose |
|---|---|---|
| `memory_remember` | write | Write one memory: content / project / keywords / importance required; soul/user/global rules → global store, everything else → workspace store |
| `memory_search` | read | Hybrid lexical search (BM25 × recency + character n-gram floor; optional `explain` incl. `fuzzy`); queries both stores |
| `memory_project` | read | Fetch a project's whole-project injection paragraph (**workspace store only**) |
| `memory_find_similar` | read | Duplicate & conflict detection; queries both stores |
| `memory_read` | read | Read one entry's complete metadata by id; queries both stores |
| `memory_update` | write | Fix status / importance / goal / keywords / content (writes back to the owning store) |
| `memory_list` | read | **new in 0.32**: metadata inventory (no text), merged across both stores and deduped by id |
| `memory_forget` | write | **new in 0.32**: archive / restore / hard-delete by id; queries both stores |
| `memory_dream` | write | Manually trigger this window's consolidation (same as `/dream`; workspace store only) |
| `memory_home` | directory | Inspect the global data directory; **query-only by default since 0.32** (0.33 switches move the global store too) |

There is also the `/dream` command: type it in the composer to consolidate this window right away, immune to peak-hour suppression.

---

## Layered storage and tool routing (0.33)

```
<activeHomeDir>/global/memory.db        ← user-scope: soul / user / rules(global)
<workspace>/<projectDir>/memory.db      ← workspace-scope: project / fact / lesson / topic / rules(project)
```

| Operation | Behaviour |
|---|---|
| Write (`memory_remember`) | `level=soul` / `user`, or `level=rules` with a global project → **global store**; everything else → **workspace store**. Dedupe/merge happens only inside the target store |
| Read / update / forget / search / list / find_similar | **Query both stores**, dedupe by id; same id → **active wins over archived**. `update` / `forget` write back to the store that owns the entry |
| Project panorama | `memory_project` reads the **workspace store only** |
| Migration | The first **trusted** session in each workspace copies existing soul/user/global rules by original id into the global store, then archives the workspace originals (recoverable); the idempotency flag `globalmigrated:v1:<dir>` lives in the workspace `dream_meta` |
| Fallback | An absent/untrusted/unavailable global store falls back to 0.32 single-store behaviour; there is **no `trustWorkspaceMemory` config override** for the global store |
| Backup | `backup.enabled` backs up **only the workspace store**, not the global store |

> If the global store is lost after migration: the workspace originals stay archived and are **not re-injected automatically**; restore them per id with `memory_forget` (`mode:'restore'`), or restore a backup of the global directory.

---

## `memory_remember` — write

`content` / `project` / `keywords` / `importance` are required; missing ones produce explicit errors. There is **no automatic keyword extraction** fallback.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `content` | string | — | Required. Memory body |
| `project` | string | — | Required. Project name; global marker for global info; comma-separated for multiple projects |
| `keywords` | string[] | — | Required. 8–13 search keywords (hits match keywords, not full text) |
| `importance` | integer | `1` | Required. Participates in ranking |
| `level` | enum | `fact` | `soul` / `user` / `project` / `fact` / `lesson` / `topic` / `rules` |
| `subcategory` | enum | — | `level=project` only: `overview` / `structure` / `decisions` / `quotes` / `ops` / `todo` |
| `goal` | string | — | Goal sentence (`topic`) |
| `corrected` | boolean | `false` | Whether this is a correction-type memory |

**Returns**: `ok` / `id` / `level` / `merged` / `keywords` / `project`.

**Write target (0.33)**: `level=soul` / `user`, or `level=rules` with a global project → **user-scope global store**; everything else → **workspace store**. Dedupe/merge happens only inside the target store.

**Dedupe reality**: only **same level**, bigram **Jaccard ≥ 0.8** (near-identical wording) merges. Paraphrases and cross-level duplicates do **not** merge. Merging overwrites keywords with the new list and takes `max(importance)`.

---

## `memory_search` — search

**BM25 × recency weight + the 0.33 hybrid lexical floor** (the per-message keyword hit uses a different scorer, below). Default `k=10`: the first 5 by relevance (seen entries not excluded), then 5 more from the remaining ranking skipping seen entries, re-sorted old → new by memory timestamp. **Queries both stores**, deduped by id.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | — | Required |
| `level` | string | — | Level filter, comma-separated |
| `project` | string | — | Project filter, comma-separated (OR) |
| `status` | string | — | Status filter, comma-separated (OR): `active` / `archived` / `stale` / `all` |
| `days` | integer 1–3650 | — | Only entries created within the last N days |
| `k` | integer 1–50 | `10` | Max hits |
| `content_max` | integer 0–5000 | `300` | Truncation per hit; `0` = full text |
| `explain` | boolean | `false` | Attach a score breakdown per hit (bm25 raw / importance / recencyWeight / status; since 0.33 optionally `fuzzy`, plus `importanceWeight` / `hitBoost` when enabled); does not change the order |

**Returns**: `note` + `hits[]` (project, full id, relative time, keywords, truncated content). Use `memory_project` for the project panorama, and `memory_list` for a metadata-only inventory.

> **0.33 hybrid lexical floor**: character bigram Jaccard + 0.25×trigram Jaccard (noise floor 0.2), used only as a floor when BM25 is weak (`score = max(BM25, 0.55·fuzzy·recency·importance)`); strong BM25 ordering is unchanged. **Not semantic/embedding retrieval** — paraphrases may still be missed. No config toggle (pure BM25 is a test/internal option).

---

## `memory_project` — project panorama

Fetches a project's complete injection paragraph. `project` is **required**. **Workspace store only** (user-scope global entries are not part of a project panorama).

- non-`todo` subcategories: all `active` entries (the automatic-injection path is budget-bound; this tool returns per call, but the whole output has its own cap — see below);
- `todo`: active entries under "To do list:" plus the 5 most recently completed (`stale`) under "Done:";
- entries inside a group run old → new by memory timestamp.

**Output cap**: the whole text is limited to `max(2000, budget.reinjectMaxChars)` chars (default **8000**), truncated with `…` (it shares the paragraph builder with post-compaction re-injection, but this cap applies only to the tool output).

**Side effect**: a non-global, single-project call **anchors the session's current project** and records it for post-compaction re-injection. If the workspace store is **untrusted**, the call is **refused** with an untrusted-store error.

---

## `memory_find_similar` — duplicates

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — | Required. Base memory id |
| `k` | integer 1–20 | `5` | Number of similar entries |
| `content_max` | integer 0–5000 | `200` | Truncation per entry |

Ranks by bigram cosine similarity; entries already seen in this session are excluded. **Queries both stores** (deduped by id).

---

## `memory_read` — read one

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Full id or first 12 characters |

Returns the complete metadata (keywords / status / importance / goal / timestamps). **Queries both stores**; the owning store is used for a later update/forget.

---

## `memory_update` — correct

| Parameter | Type | Meaning |
|---|---|---|
| `id` | string | Required |
| `content` | string | Rewrite the body |
| `status` | enum | `active` / `archived` / `stale` (`stale` = finished, `archived` = void/superseded) |
| `importance` | integer | Weight |
| `goal` | string | Goal sentence |
| `project` | string | Project; empty string clears it |
| `keywords` | string[] | Fix keywords (absent/empty = no change) |

> Ambiguous short ids on the write path now error out and list candidates instead of silently editing the wrong entry. `updated_at` is refreshed on update or dream stamping; the displayed timestamp is always `updated_at`.

---

## `memory_list` — list entries (new in 0.32)

A low-token inventory view: **metadata only, no body text** (the key difference from `memory_search` / `memory_read`). **Merged across both stores and deduped by id** (same id: active wins). Use it to answer "what do I actually have stored" and to find ids to clean up.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `level` | string | `all` | Levels, comma-separated: `soul`/`user`/`project`/`fact`/`lesson`/`topic`/`rules`; `all` = every level |
| `project` | string | — | Project names, comma-separated (OR); global/unmarked entries are included |
| `status` | enum | `active` | `active` / `stale` / `archived` / `all` |
| `limit` | integer 1–100 | `20` | Max entries |
| `offset` | integer ≥0 | `0` | Paging offset |

**Returns**: `{ note, total, items[] }`; `item = { id, level, title, keywords, importance, status, project, updated_at }`.

> `title` is a display title truncated from the content, not a separate field. Use `memory_read` for the full text.

---

## `memory_forget` — archive / restore / delete (new in 0.32)

Handles **one** entry by id. Archiving is the default and is recoverable; hard deletion needs explicit confirmation.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — | Required. Full id or first 12 characters |
| `mode` | enum | `archive` | `archive` (recoverable) / `restore` (back to `active`) / `delete` (permanent) |
| `confirm` | boolean | — | Must be `true` for `mode=delete`, otherwise refused; ignored for other modes |

**Returns**: `{ note, id }`.

**Side effects**:

- `archive`: `status=archived`; no longer injected/hit; still on disk and restorable;
- `restore`: `archived` → `active`;
- `delete`: physically removed — **irreversible** (no recycle bin; a `backup.enabled` `.bak` is your only fallback).

> For bulk cleanup, get ids with `memory_list` and call `memory_forget` repeatedly. There is deliberately no "delete by filter" to prevent a model from wiping the store in one call.

---

## `memory_dream` — manual consolidation

No parameters (scope is this window). Same semantics as `/dream`: **manual = explicit intent, so it bypasses the automatic cost gates** — no peak-hour, daily-frequency or context-size gate applies (manual invocation already requires a live window), and it runs up to 3 rounds over the **full session context** (atomic / topic / project summary). If the context is large, run `/compact` first.

---

## `memory_home` — global data directory (query-only by default in 0.32)

| Parameter | Type | Meaning |
|---|---|---|
| `target` | string | Omit to inspect the current directory, the three presets and switch state; pass a preset marker or absolute path to switch |

**Default (`security.allowHomeSwitch: false`)**: query-only. Passing `target` is **refused** with an explanation ("moving the directory changes where instance data lives; the model should not be able to move it") and how to enable it. That is the #64-2 fix.

With `security.allowHomeSwitch: true`:

| Marker | Location |
|---|---|
| `default` | Platform user home |
| `dsh-storage` | `<DSH home>/storages/meow-memory` |
| `plugin-root` | `<plugin root>/storage` |

Switching moves (same disk) or copies (cross disk); the old directory is **never deleted automatically**; an existing target is used without overwriting. Since 0.33 the global data directory also contains the **user-scope global memory store** (`global/memory.db`), so a switch moves it too; the global DB connection is closed first (on Windows an open SQLite file blocks the rename). The result is persisted in `<DSH_HOME>/storages/meow-memory-home.json`.

---

## Automatic injection vs. manual tools

- **Injection** (first-turn snapshot, per-message hits, post-compaction re-injection) is bounded by `budget.*` and **skips untrusted stores**; since 0.33 the first-turn snapshot's soul/user/global rules come from the global store (workspace store as fallback), while project panorama/re-injection stay workspace-only;
- **Manual tools** (search / project / read / list, etc.) return on demand and are not subject to the injection budget, but on an untrusted store they are **refused** (explicit error, not empty results); dream and reflection are refused too. Read tools query both stores (except `memory_project`).
- `memory_list` is the only low-cost "whole store without bodies" view; `memory_forget` is the only delete/archive entry point (equivalent to `memory_update status=archived` for archiving).

---

## Levels and subcategories

`soul` (the AI) / `user` / `project` (with `subcategory`) / `fact` / `lesson` / `topic` (with `goal`) / `rules`.  
`project` subcategories: `overview` / `structure` / `decisions` / `quotes` / `ops` / `todo`.

**Global marker**: the `project.global` value of the current `labels.md` (`"全局"` in zh, `global` in en/pt-br). It follows `promptLang`.

---

## Related docs

- [Configuration reference](configuration-reference.md) — every field (including security gates and budgets)
- [Design notes](design-notes.md) — why it is designed this way
- [Troubleshooting](troubleshooting.md) — install failures, poor recall, how to read errors
