# Tool reference (0.32 fork)

meow-memory registers **10** memory tools. Three bands: **read** (search / read / find_similar / project / list), **write** (remember / update / forget / dream), **directory** (home).

> Tool descriptions and returned copy follow the `promptLang` language pack. Parameter schemas do not change with language.

---

## At a glance

| Tool | Band | Purpose |
|---|---|---|
| `memory_remember` | write | Write one memory: content / project / keywords / importance required |
| `memory_search` | read | BM25 × recency search (with optional `explain`) |
| `memory_project` | read | Fetch a project's whole-project injection paragraph |
| `memory_find_similar` | read | Duplicate & conflict detection |
| `memory_read` | read | Read one entry's complete metadata by id |
| `memory_update` | write | Fix status / importance / goal / keywords / content |
| `memory_list` | read | **new in 0.32**: list entry metadata (no text) to take stock and find ids |
| `memory_forget` | write | **new in 0.32**: archive / restore / hard-delete one entry by id |
| `memory_dream` | write | Manually trigger this window's consolidation (same as `/dream`) |
| `memory_home` | directory | Inspect the global data directory; **query-only by default since 0.32** |

There is also the `/dream` command: type it in the composer to consolidate this window right away, immune to peak-hour suppression.

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

**Dedupe reality**: only **same level**, bigram **Jaccard ≥ 0.8** (near-identical wording) merges. Paraphrases and cross-level duplicates do **not** merge. Merging overwrites keywords with the new list and takes `max(importance)`.

---

## `memory_search` — search

**BM25 × recency weight** (the per-message keyword hit uses a different scorer, below). Default `k=10`: the first 5 by relevance (seen entries not excluded), then 5 more from the remaining ranking skipping seen entries, re-sorted old → new by memory timestamp.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | — | Required |
| `level` | string | — | Level filter, comma-separated |
| `project` | string | — | Project filter, comma-separated (OR) |
| `status` | string | — | Status filter, comma-separated (OR): `active` / `archived` / `stale` / `all` |
| `days` | integer 1–3650 | — | Only entries created within the last N days |
| `k` | integer 1–50 | `10` | Max hits |
| `content_max` | integer 0–5000 | `300` | Truncation per hit; `0` = full text |
| `explain` | boolean | `false` | Attach a score breakdown per hit (bm25 raw / importance / recencyWeight / status); does not change the order |

**Returns**: `note` + `hits[]` (project, full id, relative time, keywords, truncated content). Use `memory_project` for the project panorama, and `memory_list` for a metadata-only inventory.

---

## `memory_project` — project panorama

Fetches a project's complete injection paragraph. `project` is **required**.

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

Ranks by bigram cosine similarity; entries already seen in this session are excluded.

---

## `memory_read` — read one

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Full id or first 12 characters |

Returns the complete metadata (keywords / status / importance / goal / timestamps).

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

A low-token inventory view: **metadata only, no body text** (the key difference from `memory_search` / `memory_read`). Use it to answer "what do I actually have stored" and to find ids to clean up.

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

Switching moves (same disk) or copies (cross disk); the old directory is **never deleted automatically**; an existing target is used without overwriting. The result is persisted in `<DSH_HOME>/storages/meow-memory-home.json`.

---

## Automatic injection vs. manual tools

- **Injection** (first-turn snapshot, per-message hits, post-compaction re-injection) is bounded by `budget.*` and **skips untrusted stores**;
- **Manual tools** (search / project / read / list, etc.) return on demand and are not subject to the injection budget, but on an untrusted store they are **refused** (explicit error, not empty results); dream and reflection are refused too.
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
