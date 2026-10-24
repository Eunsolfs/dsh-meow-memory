/**
 * meow-memory — 工作区（项目级）记忆可视化编辑的数据层（0.39）。
 *
 * 背景（用户反馈）：设置页原来的「全局记忆」编辑器只能改 user-scope 的
 * soul/user/全局 rules；项目级（project/fact/lesson/topic/项目 rules）没有可视化入口，
 * 只能靠模型调 memory_* 工具。本模块给设置页新增的「工作区记忆」卡片提供 CRUD：
 *  - 列表/新增/编辑/归档/恢复都在**指定工作区**的 memory.db 上做；
 *  - 只允许已知工作区（路由层负责白名单）+ 已存在且受信的记忆库（不新建陌生库）；
 *  - 内容/关键词变化时清掉旧 embedding（与工具写入同一语义）。
 *
 * 与 global-edit.ts 的差异：project 字段是用户可选的（项目级编辑的核心），
 * 支持 subcategory（project）与 goal（topic）。
 */

import { existsSync } from 'node:fs'
import { tokenize } from './bm25.js'
import { getDb, memoryDbPath, storeTrustOf, type Level, type MemoryRow } from './db.js'

/** 工作区编辑器允许的层级（soul/user 属于用户级全局库，仍由全局编辑器管）。 */
export const WORKSPACE_EDIT_LEVELS = ['project', 'fact', 'lesson', 'topic', 'rules'] as const
export type WorkspaceEditLevel = (typeof WORKSPACE_EDIT_LEVELS)[number]
const WORKSPACE_LEVEL_SET: ReadonlySet<string> = new Set(WORKSPACE_EDIT_LEVELS)

const PROJECT_SUBCATEGORY_SET: ReadonlySet<string> = new Set(['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'])
const MAX_CONTENT = 4000
const MAX_KEYWORDS = 30

export interface WorkspaceMemoryEntry {
  id: string
  level: Level
  title: string | null
  content: string
  keywords: string[]
  importance: number
  status: string
  trigger_mode: 'any' | 'all' | 'min'
  trigger_min: number
  trigger_keywords: string[]
  project: string
  subcategory: string | null
  goal: string | null
  updated_at: number
}

export interface ListWorkspaceMemoryResult {
  trusted: boolean
  entries: WorkspaceMemoryEntry[]
}

export interface SaveWorkspaceMemoryInput {
  action: 'create' | 'save' | 'archive' | 'restore'
  id?: string
  level?: string
  content?: string
  project?: string
  subcategory?: string
  goal?: string
  importance?: number
  keywords?: string | string[]
  status?: string
  trigger_mode?: string
  trigger_min?: number
  trigger_keywords?: string | string[]
}

export interface SaveWorkspaceMemoryResult {
  ok: boolean
  entry?: WorkspaceMemoryEntry
  error?: string
}

const UNTRUSTED_ERROR = 'workspace memory store unavailable or untrusted'

function entryOf(row: MemoryRow): WorkspaceMemoryEntry {
  return {
    id: row.id,
    level: row.level,
    title: row.title ?? null,
    content: row.content,
    keywords: row.keywords,
    importance: row.importance,
    status: row.status,
    trigger_mode: row.trigger_mode === 'all' || row.trigger_mode === 'min' ? row.trigger_mode : 'any',
    trigger_min: Math.max(1, Number(row.trigger_min ?? 1) || 1),
    trigger_keywords: Array.isArray(row.trigger_keywords) ? row.trigger_keywords : [],
    project: row.project ?? '',
    subcategory: row.subcategory ?? null,
    goal: row.goal ?? null,
    updated_at: row.updated_at,
  }
}

/** 记忆库存在且受信才返回 db；否则 null（绝不创建/升级陌生库）。 */
function trustedDb(workspace: string, dir: string): ReturnType<typeof getDb> | null {
  if (!existsSync(memoryDbPath(workspace, dir))) return null
  if (storeTrustOf(workspace, dir)?.trusted !== true) return null
  return getDb(workspace, dir)
}

export function listWorkspaceMemory(workspace: string, dir = '.dsh-meow'): ListWorkspaceMemoryResult {
  try {
    const db = trustedDb(workspace, dir)
    if (db === null) return { trusted: false, entries: [] }
    const entries: WorkspaceMemoryEntry[] = []
    for (const level of WORKSPACE_EDIT_LEVELS) {
      for (const row of db.list(level)) entries.push(entryOf(row))
    }
    // project 层按 subcategory，其他层按 level 分组；组内最近更新优先。
    const levelOrder = new Map<string, number>(WORKSPACE_EDIT_LEVELS.map((l, i) => [l, i]))
    entries.sort((a, b) => (levelOrder.get(a.level) ?? 99) - (levelOrder.get(b.level) ?? 99) || b.updated_at - a.updated_at)
    return { trusted: true, entries }
  } catch {
    return { trusted: false, entries: [] }
  }
}

/** 独立触发词：只做拆分/去重，不从内容派生（空=不自动注入）。 */
function splitKeywordList(raw: string | string[] | undefined): string[] {
  let list: string[]
  if (Array.isArray(raw)) list = raw.map((k) => String(k).trim())
  else if (typeof raw === 'string') list = raw.split(/[,，、\n]/).map((k) => k.trim())
  else list = []
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of list) {
    if (k.length === 0 || seen.has(k)) continue
    seen.add(k)
    out.push(k)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

/** 关键词：数组或逗号/顿号/换行分隔字符串；为空时从内容分词派生（与工具一致的兜底）。 */
function normalizeKeywords(raw: string | string[] | undefined, content: string): string[] {
  let list: string[]
  if (Array.isArray(raw)) list = raw.map((k) => String(k).trim())
  else if (typeof raw === 'string') list = raw.split(/[,，、\n]/).map((k) => k.trim())
  else list = []
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of list) {
    if (k.length === 0 || seen.has(k)) continue
    seen.add(k)
    out.push(k)
    if (out.length >= MAX_KEYWORDS) break
  }
  if (out.length > 0) return out
  const derived: string[] = []
  for (const token of tokenize(content)) {
    if (token.length < 2 || seen.has(token)) continue
    seen.add(token)
    derived.push(token)
    if (derived.length >= 10) break
  }
  return derived.length > 0 ? derived : [content.slice(0, 20)]
}

function parseImportance(value: unknown, fallback: number): number | { error: string } {
  if (value === undefined) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 100) return { error: 'importance must be an integer between 1 and 100' }
  return n
}

export function saveWorkspaceMemory(
  workspace: string,
  dir: string,
  input: SaveWorkspaceMemoryInput,
): SaveWorkspaceMemoryResult {
  try {
    const action = input?.action
    if (action !== 'create' && action !== 'save' && action !== 'archive' && action !== 'restore') {
      return { ok: false, error: 'invalid action' }
    }
    const db = trustedDb(workspace, dir)
    if (db === null) return { ok: false, error: UNTRUSTED_ERROR }

    // archive / restore：只改状态
    if (action === 'archive' || action === 'restore') {
      const id = typeof input.id === 'string' ? input.id : ''
      const found = id.length > 0 ? db.findByIdAll(id).find((h) => WORKSPACE_LEVEL_SET.has(h.level)) : undefined
      if (found === undefined) return { ok: false, error: 'memory not found in workspace store' }
      db.update(found.level, found.row.id, { status: action === 'archive' ? 'archived' : 'active' })
      const after = db.findById(found.row.id)?.row
      return after === undefined ? { ok: false, error: 'save failed' } : { ok: true, entry: entryOf(after) }
    }

    const level = input.level
    // create 才需要 level（save 以库内条目的层级为准，忽略客户端传值）。
    if (action === 'create' && (typeof level !== 'string' || !WORKSPACE_LEVEL_SET.has(level))) {
      return { ok: false, error: `level must be one of ${WORKSPACE_EDIT_LEVELS.join(', ')}` }
    }
    const project = typeof input.project === 'string' ? input.project.trim() : ''
    const content = typeof input.content === 'string' ? input.content.trim() : ''

    if (action === 'save') {
      if (typeof input.id !== 'string' || input.id.trim().length === 0) return { ok: false, error: 'id is required for save' }
      const found = db.findByIdAll(input.id).find((h) => WORKSPACE_LEVEL_SET.has(h.level))
      if (found === undefined) return { ok: false, error: 'memory not found in workspace store' }
      if (content.length > MAX_CONTENT) return { ok: false, error: `content must be 1-${MAX_CONTENT} characters` }
      const importance = parseImportance(input.importance, found.row.importance)
      if (typeof importance !== 'number') return { ok: false, error: importance.error }
      const changedContent = content.length > 0 && content !== found.row.content
      const keywords = normalizeKeywords(input.keywords, content.length > 0 ? content : found.row.content)
      const patch: Partial<MemoryRow> = {
        keywords,
        importance,
        project: project.length > 0 ? project : found.row.project,
        subcategory: input.subcategory !== undefined ? (input.subcategory as MemoryRow['subcategory']) : found.row.subcategory,
        goal: input.goal !== undefined ? input.goal : found.row.goal,
        ...(content.length > 0 ? { content } : {}),
      }
      if (input.status === 'active' || input.status === 'archived' || input.status === 'stale') patch.status = input.status
      patch.trigger_mode = input.trigger_mode === 'all' || input.trigger_mode === 'min' || input.trigger_mode === 'any'
        ? input.trigger_mode
        : (found.row.trigger_mode ?? 'any')
      patch.trigger_min = Number.isInteger(input.trigger_min)
        ? Math.max(1, Math.min(30, input.trigger_min as number))
        : (found.row.trigger_min ?? 1)
      if (input.trigger_keywords !== undefined) patch.trigger_keywords = splitKeywordList(input.trigger_keywords)
      db.update(found.level, found.row.id, patch)
      if (changedContent || input.keywords !== undefined) {
        try { db.setEmbedding(found.level, found.row.id, null) } catch { /* 清向量失败不阻塞 */ }
      }
      const after = db.findById(found.row.id)?.row
      return after === undefined ? { ok: false, error: 'save failed' } : { ok: true, entry: entryOf(after) }
    }

    // create
    if (content.length === 0 || content.length > MAX_CONTENT) return { ok: false, error: `content must be 1-${MAX_CONTENT} characters` }
    if (project.length === 0) return { ok: false, error: 'project is required' }
    const importance = parseImportance(input.importance, 2)
    if (typeof importance !== 'number') return { ok: false, error: importance.error }
    const subcategory = typeof input.subcategory === 'string' && PROJECT_SUBCATEGORY_SET.has(input.subcategory)
      ? (input.subcategory as MemoryRow['subcategory'])
      : null
    const row = db.insert({
      level: level as Level,
      content,
      project,
      subcategory: level === 'project' ? (subcategory ?? undefined) : undefined,
      goal: level === 'topic' && typeof input.goal === 'string' ? input.goal : undefined,
      importance,
      keywords: normalizeKeywords(input.keywords, content),
      trigger_keywords: splitKeywordList(input.trigger_keywords),
      source_session: 'ui',
      trigger_mode: input.trigger_mode === 'all' || input.trigger_mode === 'min' || input.trigger_mode === 'any' ? input.trigger_mode : 'any',
      trigger_min: Number.isInteger(input.trigger_min) ? Math.max(1, Math.min(30, input.trigger_min as number)) : 1,
    })
    return { ok: true, entry: entryOf(row) }
  } catch (e) {
    return { ok: false, error: `save failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
