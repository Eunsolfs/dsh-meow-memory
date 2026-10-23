/**
 * meow-memory — UI copy, English pack (the key-set source of truth).
 *
 * Every user-visible string of the client half lives here; `zh.ts` and
 * `pt-br.ts` must carry exactly the same keys (tests/client-i18n.mjs enforces
 * it by compiling all three packs). Keys are flat and namespaced by area:
 *   fold.*      reflection/dream turn bars
 *   inject.*    long-term-memory / keyword-hit collapse bars
 *   notice.*    delegate marker bubbles
 *   menu.*      session "…" menu items
 *   settings.*  the meow-memory settings tab
 *   datetime.*  our own clock label
 *
 * `{name}` placeholders are substituted by `t()`; keep them intact when
 * translating.
 *
 * Scope note: this dictionary is the plugin's UI/UX text. The text injected
 * into the model (injection guide, reflect/dream prompts, tool descriptions)
 * is a separate, model-facing layer — see src/prompts/<lang>/ and promptLang.
 */
import type { UiKey } from './keys.js'

export const en: Record<UiKey, string> = {
  // ── reflection / dream turn bars ──────────────────────────────────────────
  'fold.title.reflect': 'Memory reflection',
  'fold.title.dream': 'Memory dream task',
  'fold.status.running': '{title} in progress…',
  'fold.hint.running': ' (your message joins this turn)',
  'fold.status.interrupted': '{title} interrupted',
  'fold.status.remembered': '{title} · {n} memories added',
  'fold.status.updated': '{title} · {n} updated',
  'fold.status.nothing': '{title} · nothing to save',

  // ── memory injection bars ─────────────────────────────────────────────────
  'inject.bar': 'Memory injected',
  'inject.kind.first': ' (long-term)',
  'inject.kind.hit': ' (keyword hits)',
  'inject.expand': 'Click to expand',
  'inject.collapse': 'Click to collapse',
  'inject.copy': 'Copy',
  'inject.copied': 'Copied',
  'inject.result': '[Result]',

  // ── delegate marker bubbles ───────────────────────────────────────────────
  'notice.reflect.running': '▸ Memory reflection task in progress…',
  'notice.reflect.done': '▸ Memory reflection task completed.',
  'notice.dream.running': '▸ Memory dream task in progress…',
  'notice.dream.done': '▸ Memory dream task completed.',
  'notice.dream.interrupted': '▸ Memory dream task interrupted; retrying automatically later.',

  // ── session menu ──────────────────────────────────────────────────────────
  'part.menu': 'Memory participation',
  'part.state.active': 'All on',
  'part.state.writeonly': 'No auto-injection',
  'part.state.readonly': 'No auto-consolidation',
  'part.state.exited': 'Tools only',
  'part.panel.inject': 'Auto injection (first-turn, per-turn, post-compaction)',
  'part.panel.consolidate': 'Auto consolidation (reflect + dream)',
  'part.panel.on': 'On',
  'part.panel.off': 'Off',

  // ── settings tab ──────────────────────────────────────────────────────────
  'settings.title': 'Meow memory',
  'settings.summary':
    'Every setting of the cross-session memory plugin. Changes are stored in DSH settings (per field; "Restore default" goes back to the plugin factory default and ignores the patch assembly baseline); they take effect after a hot reload or restart of the meow-memory plugin.',
  'settings.loading': 'Loading meow-memory configuration…',
  'settings.unavailable': 'This connection does not support settings writes (only loopback connections can edit).',
  'settings.readonly': 'This connection is read-only (settings writes are limited to loopback connections).',
  'settings.saved': 'Saved ✓ takes effect after a hot reload or restart of the meow-memory plugin',
  'settings.badge.override': 'Overridden',
  'settings.badge.default': 'Default',
  'settings.reset': 'Restore default',
  'settings.saveFailed': 'Save failed: {error}',
  'settings.saveNotApplied': 'Save did not take effect: the server rejected the write (it may have failed validation). Showing the current server value again.',
  'settings.resetFailed': 'Restore default failed: {error}',
  'settings.resetNotApplied': 'Restore default did not take effect; please try again.',
  'settings.suppress.format': 'A window must look like "HH:MM-HH:MM"; got "{value}"',
  'settings.suppress.atLeastOne': 'At least one window is required',
  'settings.group.base': 'Basics',
  'settings.group.inject': 'Injection and hits',
  'settings.group.reflect': 'Reflection',
  'settings.group.delegate': 'Consolidation task model',
  'settings.group.dream': 'Idle consolidation (dream)',
  'settings.group.language': 'Language',
  'settings.group.storage': 'Directories & migration',
  'settings.field.enabled.label': 'Master switch',
  'settings.field.enabled.hint': 'When off, injection, reflection and the memory tools are all disabled',
  'settings.field.projectDir.label': 'Memory directory',
  'settings.field.projectDir.hint': 'Data directory, relative to the workspace',
  'settings.field.homeDir.label': 'Global data directory',
  'settings.field.homeDir.hint': 'Where instance-level data (logs, window index) lives. On change, contents of the old directory are migrated automatically (same-disk move / cross-disk copy); after a cross-disk copy the old directory is kept — delete it manually once verified. If multiple dsh instances share one directory, update them together.',
  'settings.field.homeDir.preset.default': 'System user home (default)',
  'settings.field.homeDir.preset.dshStorage': 'DSH home storage',
  'settings.field.homeDir.preset.pluginRoot': 'Plugin folder',
  'settings.field.homeDir.preset.custom': 'Custom path',
  'settings.mirrorReadonly': 'Non-local connection: dsh serves this settings page as a read-only mirror and no change will be saved. Open dsh via 127.0.0.1 on the host machine to edit settings.',
  'settings.field.autoMigrate.label': 'Auto-migrate old database',
  'settings.field.autoMigrate.hint': 'Migrate PROJECT.md automatically the first time a v1 database is opened',
  'settings.field.hitTopK.label': 'Max hits per message',
  'settings.field.hitTopK.hint': 'Upper bound on keyword-hit entries injected per message (fact/lesson/rules/topic)',
  'settings.field.titleMax.label': 'Guide title truncation length',
  'settings.field.titleMax.hint': 'Truncation length (characters) of the project list in the memory guide',
  'settings.field.reflect.label': 'Automatic reflection',
  'settings.field.reflect.hint': 'Review memory automatically after a task ends',
  'settings.field.reflectTurns.label': 'Reflection trigger turns',
  'settings.field.reflectTurns.hint': 'Consecutive tool steps inside one task needed to trigger at the end',
  'settings.field.delegateModel.label': 'Reflection/dream model override',
  'settings.field.delegateModel.hint':
    "Empty = the main model throughout. When set, reflection and dream turns run on that model and switch back to the main model at the end of the turn (the rest of the conversation is unaffected); 'provider/model' selects the route, 'model' only changes the model name",
  'settings.field.delegateModel.placeholder': 'e.g. zai-coding-cn/glm-5.3-flash',
  'settings.field.dreamEnabled.label': 'Idle consolidation switch',
  'settings.field.dream.idleMinutes.label': 'Idle minutes',
  'settings.field.dream.idleMinutes.hint': 'A window idle for this many minutes allows a dream',
  'settings.field.dream.suppressWindows.label': 'Peak-hour suppression windows',
  'settings.field.dream.suppressWindows.hint': 'Comma-separated "HH:MM-HH:MM"; no dream is triggered inside these windows',
  'settings.field.dream.suppressLeadMinutes.label': 'Extra suppression before peak (minutes)',
  'settings.field.dream.checkMinutes.label': 'Check interval (minutes)',
  'settings.field.dream.timeZone.label': 'Timezone for suppression windows',
  'settings.field.dream.timeZone.hint': 'Peak windows are computed in this fixed timezone (independent of the system clock)',
  'settings.field.dream.rulesReviewDays.label': 'Rules anti-churn days',
  'settings.field.dream.rulesReviewDays.hint': 'Stable rules whose updated_at is older than this many days skip dream round 1; 0 = no filter',
  'settings.field.promptLang.label': 'Prompt and retrieval language',
  'settings.field.promptLang.hint':
    "Empty = zh by default (sessions that never configured it get a one-time first-run guide); 'en' = built-in English pack. The UI language is unrelated — that follows the DSH language setting. The language must match the one you speak, or keyword hit rates drop",
  'settings.field.promptLang.placeholder': 'zh / en',

  // ── user-scope global memory editor (0.36) ────────────────────────────────
  'settings.global.title': 'Global memory (user scope)',
  'settings.global.hint': 'soul / user / global rules here are injected into sessions in every workspace; after saving, related sessions re-inject the updated content on their next turn (history is not rewritten).',
  'settings.global.loading': 'Loading…',
  'settings.global.empty': 'No global memory entries yet.',
  'settings.global.untrusted': 'Global memory store is unavailable or untrusted (not created by this plugin): check global-directory permissions, or delete/rename the global DB and reload.',
  'settings.global.add': 'Add global memory',
  'settings.global.content': 'Content',
  'settings.global.keywords': 'Keywords (comma separated)',
  'settings.global.importance': 'Importance (1-100)',
  'settings.global.level': 'Level',
  'settings.global.levelSoul': 'soul (about the AI)',
  'settings.global.levelUser': 'user (user info/preferences)',
  'settings.global.levelRules': 'rules (global rules)',
  'settings.global.save': 'Save',
  'settings.global.cancel': 'Cancel',
  'settings.global.archive': 'Archive',
  'settings.global.restore': 'Restore',
  'settings.global.saved': 'Saved',
  'settings.global.saveFailed': 'Save failed: {error}',
  'settings.global.reinjectNote': 'Related sessions will re-inject the updated global memory on their next turn.',
  'settings.global.reinjectCount': 'Marked {count} sessions for re-injection on their next turn.',
  'settings.global.refresh': 'Refresh',

  // ── advanced settings groups (0.37: previously patch-only fields) ─────────
  'settings.group.security': 'Security & privacy',
  'settings.group.budget': 'Budgets & caps',
  'settings.group.retrieval': 'Retrieval & forgetting',
  'settings.group.dreamIsolated': 'Isolated dream (optional)',
  'settings.field.security.trustWorkspaceMemory.label': 'Trust workspace memory store',
  'settings.field.security.trustWorkspaceMemory.hint': 'Danger: allow reading/writing a memory.db not created by this plugin; only for upgrades/foreign dirs you trust',
  'settings.field.security.allowHomeSwitch.label': 'Allow automatic global-directory switching',
  'settings.field.security.autoGitignore.label': 'Auto-write .gitignore (ignore memory DB)',
  'settings.field.security.debugLogs.label': 'Debug logs',
  'settings.field.budget.snapshotMaxChars.label': 'First snapshot cap (chars)',
  'settings.field.budget.hitMaxChars.label': 'Per-hit injection cap (chars)',
  'settings.field.budget.reinjectMaxChars.label': 'Compaction re-injection cap (chars)',
  'settings.field.budget.dreamMaxContextTokens.label': 'Dream context cap (tokens)',
  'settings.field.budget.dreamMaxPerWindowPerDay.label': 'Auto dreams per window per day',
  'settings.field.budget.dreamMaxPerDayTotal.label': 'Global auto dreams per day',
  'settings.field.budget.reflectMaxPerDay.label': 'Reflections per window per day',
  'settings.field.budget.reflectMinIntervalMinutes.label': 'Min reflection interval (minutes)',
  'settings.field.budget.reflectMaxPerDayTotal.label': 'Global reflections per day',
  'settings.field.retrieval.halfLifeDays.label': 'Forgetting half-life (days)',
  'settings.field.retrieval.halfLifeDays.hint': 'Exponential decay; injection/search hits refresh the age (review)',
  'settings.field.retrieval.minScore.label': 'Minimum relevance score (0-1)',
  'settings.field.retrieval.hitBoost.label': 'Hit-count weighting',
  'settings.field.retrieval.importanceWeight.label': 'Importance weighting',
  'settings.field.semantic.enabled.label': 'Enable semantic retrieval (optional)',
  'settings.field.semantic.enabled.hint': 'Offline by default; needs an OpenAI-compatible /embeddings endpoint over https or loopback http; when on, memory and query text are sent there',
  'settings.field.semantic.baseUrl.label': 'Embedding endpoint baseUrl',
  'settings.field.semantic.model.label': 'Embedding model',
  'settings.field.semantic.apiKeyEnv.label': 'API key env var name',
  'settings.field.semantic.timeoutMs.label': 'Request timeout (ms)',
  'settings.field.semantic.weight.label': 'Semantic weight (0-1)',
  'settings.field.dream.requireLiveAgent.label': 'Auto dream only for live windows',
  'settings.field.dream.isolated.label': 'Isolated dream (spawn child session)',
  'settings.field.dream.isolated.hint': 'Off by default; child consolidates with empty context, main session grows 0; failures fall back to the main agent; manual /dream unaffected',
  'settings.field.dream.isolatedProvider.label': 'Child provider',
  'settings.field.dream.isolatedTimeoutMinutes.label': 'Isolated dream timeout (minutes)',
  'settings.field.dream.isolatedMaxPromptChars.label': 'Isolated dream prompt cap (chars)',
  'settings.field.dream.isolatedArchiveChild.label': 'Archive isolated child session',

  // ── date and time ─────────────────────────────────────────────────────────
  'datetime.ymd': '{m}/{d}',
  'datetime.ymdFull': '{y}/{m}/{d}',
}
