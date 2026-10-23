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

Full-text matching is noisy. Hits therefore match entry keywords. **There is no vector/semantic retrieval.**

0.32 per-message score (`keywordHitScore`):

```
keyword intersection × IDF × query coverage × exponential recency × importance weight × title boost
```

- **Query coverage** = matched query tokens / total query tokens. The old denominator was the entry's keyword-token count, so following the prompt's "8–13 keywords" instruction *lowered* the score — a self-defeating design fixed in 0.32.
- **Exponential recency** = `0.05 + 0.95·exp(-ln2·ageDays/halfLifeDays)`, default half-life 30 days; `importance ≥ 3` only keeps a 0.85 floor. This is **not an Ebbinghaus review curve**: there is no review count or scheduling, and dream rewrites `updated_at`, so consolidation itself pollutes the decay input.
- **Hit reinforcement** = `×(1 + 0.15·ln(1+hit_count))`, cap 2.0 — `hit_count` was write-only upstream and now participates in ranking.
- **Importance weight** = `×(0.85 + 0.05·importance)`.
- **`retrieval.minScore`** (default 0.35) filters out weak hits.

`memory_search` is a separate **BM25** scorer (`ln(1+(N−df+.5)/(df+.5))`, k1=1.5, b=0.75, length normalisation + recency). The docs no longer conflate the two.

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
| Estimated context ≤ `budget.dreamMaxContextTokens` | 40000 | prevents oversized dream / bill blow-up |
| Per window per day ≤ `budget.dreamMaxPerWindowPerDay` | 1 | unbounded frequency |
| Exclude `archived`; cap each round's list at 60 | fixed | archived rows were re-fed forever and prompts grew monotonically |
| Skip reason logged | — | explainability |

Manual `/dream` / `memory_dream` bypass all of these automatic gates (manual = explicit intent; only the automatic path calls `evaluateAutoDreamGate`): peak/frequency/live-agent/context gates do not apply, and they run up to 3 rounds over the **full session context** (atomic / topic / project summary). If the context is large, run `/compact` first.

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

Also: creating the memory directory writes a self-ignoring `.gitignore` (`*`; if a pre-existing one lacks a `*` line, one is appended to block `!*` re-inclusion) so `git add .` cannot commit plaintext memories. `security.debugLogs` gates `perf.log` and settings/configEditor dumps; `dream-debug.log` is still written by default with minimal info (session ids/counts/skip reasons, no memory text; 48h cleanup, 5MB rotation), and error logs are error-only. Uninstall leaves data on purpose (the plugin must not delete memories for the user). The store is **not encrypted** — plaintext SQLite; disk/backups/sync remain the trust boundary.

---

## 16. Known design debt (not fixed in 0.32)

| Issue | Impact | Why |
|---|---|---|
| **Per-workspace DB** | "Global" is global only within one cwd; subdirectory/symlink opens create new stores | Data-model change, too risky for this hardening pass |
| **Keyword recall ceiling** | No semantic retrieval; badly keyworded entries are silently unreachable | Needs embeddings/indexing, out of scope |
| **Scans without indexes (upstream)** | 4 full scans per message; fine at hundreds of entries, a cliff at thousands | T1 added indexes; large-scale behaviour still needs measuring |
| **#66 host-side tool lock** | After a manual dream the tool set may shrink until restart | Host issue; plugin can only avoid the automatic path |
| **#71 delegate model leak** | Only with `delegate.model` set | Host projection bug; empty default does not trigger |
| **Settings save path on 0.2.x** | May render but not reach apply | Settings service redesign, not in this pass |
| **Weak pt-br retrieval** | No Portuguese stemming/stopwords | Needs Portuguese NLP |
| **Dream history costs tokens** | Folding is visual only | No host "hidden message" semantics |
| **Plaintext PII** | Memory bodies may contain secrets | Encryption needs key management; `.gitignore` + environment boundary instead |

---

## Related docs

- [Configuration reference](configuration-reference.md)
- [Tool reference](tool-reference.md)
- [Troubleshooting](troubleshooting.md)
