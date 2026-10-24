/**
 * global-edit.ts — 用户级（全局）记忆的可视化编辑 host 逻辑（0.36.0，纯数据层）。
 *
 * 背景：soul / user / 全局 rules 属于「用户级」记忆，存在全局库
 * `<activeHomeDir>/global/memory.db`（Phase 2 分层存储）。本模块只给设置页/可视化编辑器
 * 提供**纯函数**式的读写入口：不注册路由、不碰客户端、不发任何网络请求（embedding 由
 * 其它链路回填；本模块只在内容/关键词变化时把旧向量清空，避免用过期向量做语义召回）。
 *
 * 安全边界：全局库不可用/未受信（foreign）→ 列表返回 `{trusted:false, entries:[]}`、
 * 写入返回 `{ok:false, error:'global store unavailable or untrusted'}`。任何异常都被
 * 捕获成 `{ok:false}`，绝不向调用方抛出（编辑器保存失败只应回显，不应炸掉宿主）。
 *
 * 编辑范围：只允许 soul / user / rules 三层；rules 必须是全局作用域（project=全局标记），
 * 项目级 rules 留在工作区库、不在本编辑器范围内。
 */
import { tokenize } from './bm25.js'
import {
  GLOBAL_PROJECT_CANON,
  ensureGlobalStore,
  getGlobalDb,
  globalProjectMarker,
  isGlobalScope,
  type Level,
  type MemoryRow,
  type Status,
} from './db.js'
import { activeHomeDir } from './home-dir.js'

/** 可视化编辑器只编辑这三层（用户级记忆）。 */
export const GLOBAL_EDIT_LEVELS = ['soul', 'user', 'rules'] as const
export type GlobalEditLevel = (typeof GLOBAL_EDIT_LEVELS)[number]

/** 内容长度上限（与工具层记忆正文的引导长度一致；编辑器单条上限）。 */
const CONTENT_MAX = 4000
/** 关键词数量上限（与 memory_remember 的引导一致）。 */
const KEYWORDS_MAX = 30
/** 关键词为空时的自动派生上限（tokenize 前 10 个唯一词）。 */
const DERIVED_KEYWORDS_MAX = 10
/** importance 允许区间（正整数）。 */
const IMPORTANCE_MIN = 1
const IMPORTANCE_MAX = 100
/** 新建条目的默认 importance。 */
const DEFAULT_IMPORTANCE = 2
/** 编辑器写入的条目标记：来源会话固定为 ui（区别于对话/整理轮）。 */
const EDIT_SOURCE_SESSION = 'ui'

/** 编辑器列表的一条用户级记忆（纯数据，无 DB 依赖）。 */
export interface GlobalMemoryEntry {
  id: string
  level: GlobalEditLevel
  title: string | null
  content: string
  keywords: string[]
  importance: number
  status: Status
  trigger_mode: 'any' | 'all' | 'min'
  trigger_min: number
  trigger_keywords: string[]
  /** 作用域展示值：全局标记（当前语言包写法，如「全局」/「global」）。 */
  project: string
  updated_at: number
}

export interface ListGlobalMemoryResult {
  /** 全局库是否可信（false = foreign/不可用，entries 必为空）。 */
  trusted: boolean
  /** 当前全局目录（展示用；记忆库位于其下的 global/）。 */
  homePath: string
  entries: GlobalMemoryEntry[]
}

export interface SaveGlobalMemoryInput {
  action: 'create' | 'save' | 'archive' | 'restore'
  /** save/archive/restore 必填：全局库内的条目 id（支持唯一短 id 前缀）。 */
  id?: string
  /** create 必填；save 缺省沿用原值。只有 soul/user/rules。 */
  level?: string
  /** create 必填；save 缺省沿用原值。trim 后 1..4000 字符。 */
  content?: string
  /** 数组，或逗号/中文顿号分隔的字符串；为空时从内容 tokenize 派生。 */
  keywords?: string | string[]
  /** 整数 1..100；create 缺省 2，save 缺省沿用原值。 */
  importance?: number
  /** 可选直接指定状态（create/save）；archive/restore 由 action 决定。 */
  status?: string
  /** 触发关键词模式（0.40）：any/all/min；缺省 any。 */
  trigger_mode?: string
  /** min 模式最少命中数（1..30）。 */
  trigger_min?: number
  /** 独立触发关键词（0.40）：数组或逗号/顿号分隔；空/省略=不改（create 为空=不自动注入）。 */
  trigger_keywords?: string | string[]
}

export interface SaveGlobalMemoryResult {
  ok: boolean
  entry?: GlobalMemoryEntry
  error?: string
}

/** 全局库不可用/未受信的固定错误文案（客户端按这个字符串识别信任闸）。 */
export const GLOBAL_STORE_UNTRUSTED_ERROR = 'global store unavailable or untrusted'

function isGlobalEditLevel(v: unknown): v is GlobalEditLevel {
  return typeof v === 'string' && (GLOBAL_EDIT_LEVELS as readonly string[]).includes(v)
}

function isStatus(v: unknown): v is Status {
  return v === 'active' || v === 'archived' || v === 'stale'
}

/** 全局标记（当前语言包写法；labels 读取异常时回退历史真值）。 */
function globalMarker(): string {
  try {
    return globalProjectMarker()
  } catch {
    return GLOBAL_PROJECT_CANON
  }
}

/** 关键词规整：数组或分隔字符串 → trim/去空/去重，保持首次出现顺序。 */
function normalizeKeywordList(raw: unknown): string[] {
  let parts: string[] = []
  if (Array.isArray(raw)) {
    parts = raw.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map((v) => String(v))
  } else if (typeof raw === 'string') {
    parts = raw.split(/[,，、\n]+/)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const kw = part.trim()
    if (kw.length === 0 || seen.has(kw)) continue
    seen.add(kw)
    out.push(kw)
  }
  return out
}

/** 从正文派生关键词（tokenize 前 10 个唯一词）；分词为空（如纯 emoji）时用正文前缀兜底，
 *  保证「关键词 1..30 条」的契约在任意 1..4000 字正文下都可满足。 */
function deriveKeywords(content: string): string[] {
  const derived: string[] = []
  const seen = new Set<string>()
  let tokens: string[] = []
  try {
    tokens = tokenize(content)
  } catch {
    tokens = []
  }
  for (const token of tokens) {
    const kw = token.trim()
    if (kw.length === 0 || seen.has(kw)) continue
    seen.add(kw)
    derived.push(kw)
    if (derived.length >= DERIVED_KEYWORDS_MAX) break
  }
  if (derived.length === 0) {
    const fallback = content.trim().slice(0, 20)
    if (fallback.length > 0) derived.push(fallback)
  }
  return derived
}

/** 校验 content：trim 后 1..4000 字符。 */
function normalizeContent(raw: unknown): { ok: true; content: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'content must be 1-4000 characters' }
  const content = raw.trim()
  if (content.length < 1 || content.length > CONTENT_MAX) return { ok: false, error: 'content must be 1-4000 characters' }
  return { ok: true, content }
}

/** 校验 importance：整数 1..100；缺省用 fallback。 */
function normalizeImportance(raw: unknown, fallback: number): { ok: true; importance: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, importance: fallback }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < IMPORTANCE_MIN || raw > IMPORTANCE_MAX) {
    return { ok: false, error: 'importance must be an integer between 1 and 100' }
  }
  return { ok: true, importance: raw }
}

/** 关键词规整 + 校验（1..30 条）：显式给的关键词优先，空则从正文派生。 */
function resolveKeywords(
  raw: unknown,
  content: string,
  fallback?: string[],
): { ok: true; keywords: string[] } | { ok: false; error: string } {
  const provided = normalizeKeywordList(raw)
  const keywords = provided.length > 0 ? provided : fallback !== undefined && fallback.length > 0 ? fallback : deriveKeywords(content)
  if (keywords.length < 1 || keywords.length > KEYWORDS_MAX) {
    return { ok: false, error: 'keywords must be 1-30 unique non-empty entries' }
  }
  return { ok: true, keywords }
}

function toEntry(row: MemoryRow, level: GlobalEditLevel): GlobalMemoryEntry {
  return {
    id: row.id,
    level,
    title: row.title ?? null,
    content: row.content,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    importance: Number(row.importance ?? DEFAULT_IMPORTANCE),
    status: row.status,
    trigger_mode: row.trigger_mode === 'all' || row.trigger_mode === 'min' ? row.trigger_mode : 'any',
    trigger_min: Math.max(1, Number(row.trigger_min ?? 1) || 1),
    trigger_keywords: Array.isArray(row.trigger_keywords) ? row.trigger_keywords : [],
    project: globalMarker(),
    updated_at: Number(row.updated_at ?? 0),
  }
}

/** 在全局库里按 id 找可编辑行（跨表唯一短 id 前缀语义）：返回唯一命中；歧义/未知 → null。 */
function findGlobalEditable(id: string): { row: MemoryRow; level: GlobalEditLevel } | null {
  if (typeof id !== 'string' || id.trim().length === 0) return null
  const matches = getGlobalDb().findByIdAll(id.trim()).filter((m) => isGlobalEditLevel(m.level))
  if (matches.length !== 1) {
    if (matches.length > 1) {
      console.warn(`[meow-memory] global-edit 拒绝歧义短 id："${id}" 命中 ${matches.length} 条（全局库），请用完整 id`)
    }
    return null
  }
  return { row: matches[0].row, level: matches[0].level as GlobalEditLevel }
}

/** 列表：全局库里的 soul / user / 全局规则（含 archived，编辑器需要展示与恢复）。
 *  分组顺序 soul → user → rules，组内按记忆时间戳新→旧。绝不抛出。 */
export function listGlobalMemory(): ListGlobalMemoryResult {
  const homePath = activeHomeDir()
  try {
    if (!ensureGlobalStore().trusted) return { trusted: false, homePath, entries: [] }
    const db = getGlobalDb()
    const entries: GlobalMemoryEntry[] = []
    for (const level of ['soul', 'user'] as const) {
      for (const row of db.list(level)) entries.push(toEntry(row, level))
    }
    for (const row of db.list('rules')) {
      if (!isGlobalScope(row.project)) continue // 全局库只展示全局作用域 rules
      entries.push(toEntry(row, 'rules'))
    }
    const order: Record<GlobalEditLevel, number> = { soul: 0, user: 1, rules: 2 }
    entries.sort((a, b) => order[a.level] - order[b.level] || b.updated_at - a.updated_at)
    return { trusted: true, homePath, entries }
  } catch (e) {
    console.warn(`[meow-memory] 读取全局记忆失败（按不可用处理）：${e instanceof Error ? e.message : String(e)}`)
    return { trusted: false, homePath, entries: [] }
  }
}

/** 可视化编辑器的写入口（create/save/archive/restore）。绝不抛出：
 *  失败返回 `{ok:false, error}`；成功返回更新后的条目。 */
export function saveGlobalMemory(input: SaveGlobalMemoryInput): SaveGlobalMemoryResult {
  try {
    if (input === null || typeof input !== 'object') return { ok: false, error: 'invalid input' }
    const action = input.action
    if (action !== 'create' && action !== 'save' && action !== 'archive' && action !== 'restore') {
      return { ok: false, error: 'invalid action' }
    }
    if (!ensureGlobalStore().trusted) return { ok: false, error: GLOBAL_STORE_UNTRUSTED_ERROR }
    const db = getGlobalDb()

    // ── create：新建一条用户级记忆 ───────────────────────────────────────────
    if (action === 'create') {
      if (!isGlobalEditLevel(input.level)) {
        return { ok: false, error: 'level must be one of soul, user, rules' }
      }
      const level = input.level
      const contentRes = normalizeContent(input.content)
      if (!contentRes.ok) return { ok: false, error: contentRes.error }
      const importanceRes = normalizeImportance(input.importance, DEFAULT_IMPORTANCE)
      if (!importanceRes.ok) return { ok: false, error: importanceRes.error }
      const keywordsRes = resolveKeywords(input.keywords, contentRes.content)
      if (!keywordsRes.ok) return { ok: false, error: keywordsRes.error }
      const status = input.status === undefined || input.status === null ? 'active' : input.status
      if (!isStatus(status)) return { ok: false, error: 'invalid status' }
      const triggerMode = input.trigger_mode === 'all' || input.trigger_mode === 'min' || input.trigger_mode === 'any' ? input.trigger_mode : 'any'
      const triggerMin = Number.isInteger(input.trigger_min) ? Math.max(1, Math.min(30, input.trigger_min as number)) : 1
      const row = db.insert({
        level: level as Level,
        content: contentRes.content,
        keywords: keywordsRes.keywords,
        importance: importanceRes.importance,
        project: globalMarker(), // rules 落全局作用域；soul/user 表无 project 列（忽略）
        source_session: EDIT_SOURCE_SESSION,
        status,
        trigger_mode: triggerMode,
        trigger_min: triggerMin,
        trigger_keywords: normalizeKeywordList(input.trigger_keywords),
      })
      return { ok: true, entry: toEntry(row, level) }
    }

    // ── save / archive / restore：定位全局库里的可编辑行 ─────────────────────
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (id.length === 0) return { ok: false, error: 'id is required for save, archive and restore' }
    const found = findGlobalEditable(id)
    if (found === null) return { ok: false, error: 'memory not found in global store' }
    const { row, level } = found
    // rules 只允许全局作用域（项目级 rules 属于工作区库，不归本编辑器管）。
    if (level === 'rules' && !isGlobalScope(row.project)) return { ok: false, error: 'memory is not global-scoped' }

    if (action === 'archive' || action === 'restore') {
      const status: Status = action === 'archive' ? 'archived' : 'active'
      if (!db.update(level, row.id, { status })) return { ok: false, error: 'memory not found in global store' }
      const updated = findGlobalEditable(row.id)
      return updated === null ? { ok: false, error: 'memory not found in global store' } : { ok: true, entry: toEntry(updated.row, updated.level) }
    }

    // ── save：改 content / keywords / importance；project 保持全局标记 ────────
    const content = input.content === undefined ? row.content : input.content
    let normalizedContent = row.content
    if (input.content !== undefined) {
      const contentRes = normalizeContent(content)
      if (!contentRes.ok) return { ok: false, error: contentRes.error }
      normalizedContent = contentRes.content
    }
    const importanceRes = normalizeImportance(input.importance, Number(row.importance ?? DEFAULT_IMPORTANCE))
    if (!importanceRes.ok) return { ok: false, error: importanceRes.error }
    // 省略 keywords = 保留原值；显式给空（""/[]）= 按契约从正文 tokenize 派生。
    const keywordsRes = resolveKeywords(
      input.keywords,
      normalizedContent,
      input.keywords === undefined ? row.keywords : undefined,
    )
    if (!keywordsRes.ok) return { ok: false, error: keywordsRes.error }
    const status = input.status === undefined || input.status === null ? row.status : input.status
    if (!isStatus(status)) return { ok: false, error: 'invalid status' }

    const contentChanged = normalizedContent !== row.content
    const keywordsChanged = JSON.stringify(keywordsRes.keywords) !== JSON.stringify(row.keywords)
    const triggerMode = input.trigger_mode === 'all' || input.trigger_mode === 'min' || input.trigger_mode === 'any'
      ? input.trigger_mode
      : (row.trigger_mode === 'all' || row.trigger_mode === 'min' ? row.trigger_mode : 'any')
    const triggerMin = Number.isInteger(input.trigger_min)
      ? Math.max(1, Math.min(30, input.trigger_min as number))
      : Math.max(1, Number(row.trigger_min ?? 1) || 1)
    if (
      !db.update(level, row.id, {
        content: normalizedContent,
        keywords: keywordsRes.keywords,
        importance: importanceRes.importance,
        status,
        trigger_mode: triggerMode,
        trigger_min: triggerMin,
        ...(input.trigger_keywords !== undefined ? { trigger_keywords: normalizeKeywordList(input.trigger_keywords) } : {}),
      })
    ) {
      return { ok: false, error: 'memory not found in global store' }
    }
    // 正文/关键词变了 → 旧向量作废（语义检索不能拿过期 embedding 召回）；只清向量，不动时间戳。
    if (contentChanged || keywordsChanged) db.setEmbedding(level, row.id, null)
    const updated = findGlobalEditable(row.id)
    return updated === null ? { ok: false, error: 'memory not found in global store' } : { ok: true, entry: toEntry(updated.row, updated.level) }
  } catch (e) {
    console.warn(`[meow-memory] 全局记忆保存失败：${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, error: `save failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
