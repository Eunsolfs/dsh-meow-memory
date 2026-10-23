/**
 * meow-memory v2 — 会话开头注入。
 *
 * 结构（用户拍板）：soul/user 全量 + 记忆导引（project/topic 标题列表，
 * 正文模型自取）+ 第一条用户消息关键词命中 fact/lesson 短条目自动注入。
 * 无每轮注入——模型自己用 memory_search 深挖。
 *
 * 去重：.dsh-meow/sessions/<sessionId>.json 记录本会话注入过的 memory id，
 * 已注入不重复。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Doc } from './bm25.js'
import { keywordHitScore, search, tokenize } from './bm25.js'
import { isGlobalProject, isGlobalScope, memoryDbPath, projectCovers, projectLabel, projectList, relativeTime, PROJECT_SUBCATEGORIES, type Level, type MemoryDb, type MemoryRow, type ProjectSubcategory } from './db.js'
import { fillTemplate, keyedValue } from './prompt-loader.js'

/** 信任门（v0.32，index.ts 从 db.storeTrustOf() 传入）：trusted === false = 记忆库不是本插件
 *  创建的（外来 memory.db），不注入库内内容；未传视为 trusted（旧调用方/测试行为不变）。 */
export interface InjectionTrust {
  trusted: boolean
}

export interface InjectOptions {
  /** 关键词命中条数上限（fact/lesson 短条目）。 */
  hitTopK: number
  /** 导引里 project/topic 标题超长截断长度。 */
  titleMax: number
  /** 信任门：false 时三条注入链路都不输出 soul/user/rules/project 等库内内容。 */
  trust?: InjectionTrust
  /** 首轮长期记忆快照字符上限（config budget.snapshotMaxChars，默认 6000；<=0 不截断）。 */
  snapshotMaxChars?: number
  /** 单条命中正文长度上限（config budget.hitMaxChars，默认 1500；超出补 …）。 */
  hitMaxChars?: number
  /** 压缩重注入整体字符上限（config budget.reinjectMaxChars，默认 8000；超预算整块丢弃）。 */
  reinjectMaxChars?: number
  /** 检索：遗忘半衰期（天，config retrieval.halfLifeDays，默认 30）。 */
  halfLifeDays?: number
  /** 检索：注入阈值（config retrieval.minScore，默认 0.35：低于它的命中不注入）。 */
  minScore?: number
  /** 检索：hit_count 加成（config retrieval.hitBoost，默认开）。 */
  hitBoost?: boolean
  /** 检索：importance 参与排名（config retrieval.importanceWeight，默认开）。 */
  importanceWeight?: boolean
  /** 命中记账回调（index.ts 传 (level,id)=>bumpHitCount(level,id)）：每条实际注入的命中调用一次。 */
  onHit?: (level: Level, id: string) => void
}

/** 预算契约默认值（与 src/defaults.ts 的 budget.* 一致；index.ts 显式传入时以传入为准）。 */
const BUDGET_DEFAULTS = { snapshotMaxChars: 6000, hitMaxChars: 1500, reinjectMaxChars: 8000 }
/** 检索契约默认值（与 src/defaults.ts 的 retrieval.* 一致）。 */
const RETRIEVAL_DEFAULTS = { halfLifeDays: 30, minScore: 0.35, hitBoost: true, importanceWeight: true }

const DEFAULT_OPTS: InjectOptions = { hitTopK: 2, titleMax: 40, ...BUDGET_DEFAULTS, ...RETRIEVAL_DEFAULTS }

/** 文本上限保护：超长截断并补 …（max <=0 视为不截断）。 */
function capText(text: string, max: number | undefined): string {
  if (max === undefined || max <= 0 || text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

export function sessionsFile(workspace: string, sessionId: string, dir = '.dsh-meow'): string {
  // 会话 id 可能含 Windows 文件名非法字符（#56：飞书桥 lark-link:dm:…:0 的冒号）——
  // 读写全部 ENOENT。非安全字符做百分号编码：确定性（跨重启同 id 同文件）、无碰撞
  // （% 编码与原字符不重叠）、安全字符原样（既有会话文件不失效）。
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return join(workspace, dir, 'sessions', `${safe}.json`)
}

/** 会话记忆可见集：injected=注入过的，searched=search/find_similar 返回过的，
 *  accessed=memory_read 读过的（v0.17.0，dream 第一轮清单的"查阅"源）。
 *  前两者是"本会话上下文里已经出现过的记忆"，检索时应排除（省 token、扩大检索面）；
 *  accessed 只服务 dream 扫尾范围（读过的条目该被复查），不参与命中去重。 */
export interface SessionSeen {
  injected: string[]
  searched: string[]
  accessed: string[]
  /** 本会话写工具落库过的记忆 id（v0.23.0）：memory_remember（新建/合并）与
   *  memory_update（实际写入）成功后记录，子代理代写归父窗口文件（source_session 同源）。
   *  压缩重注入第三块数据源；releaseSeen 不清（同 projectsQueried，正是重注入数据源）。 */
  written: string[]
  /** 本会话 AI 调 memory_project 查阅过的项目名（v0.21.0，按查询顺序、去重、
   *  最多保留 MAX_REINJECT_PROJECTS 个最近项）：会话压缩后重注入项目全景的清单。
   *  '全局' 不记（全局 soul/user/rules 已在快照层，非项目）；多项目参数按逗号拆开记。 */
  projectsQueried: string[]
  /** 压缩成功落地后置 true（v0.21.0）：下一个含真实用户消息的 pre-step 注入
   *  压缩重注入块（长期记忆快照 + 项目全景），随后清回 false。 */
  reinjectPending: boolean
  /** 当前 project 锚定（最近一次带 project 参数的 memory 工具调用）：命中检索限定"全局+当前项目"。 */
  currentProject: string | null
}

/** projectsQueried 保留上限：压缩重注入的项目全景个数上限（防极端会话注入膨胀）。 */
export const MAX_REINJECT_PROJECTS = 8

/** written 保留上限：压缩重注入"本会话写过的记忆"条数上限（防极端会话注入膨胀）。 */
export const MAX_REINJECT_WRITTEN = 20

function readSeenFile(workspace: string, sessionId: string, dir: string): SessionSeen {
  try {
    const text = readFileSync(sessionsFile(workspace, sessionId, dir), 'utf8')
    const parsed = JSON.parse(text) as Record<string, unknown>
    return {
      injected: Array.isArray(parsed.injected) ? parsed.injected.filter((x): x is string => typeof x === 'string') : [],
      searched: Array.isArray(parsed.searched) ? parsed.searched.filter((x): x is string => typeof x === 'string') : [],
      accessed: Array.isArray(parsed.accessed) ? parsed.accessed.filter((x): x is string => typeof x === 'string') : [],
      written: Array.isArray(parsed.written) ? parsed.written.filter((x): x is string => typeof x === 'string') : [],
      projectsQueried: Array.isArray(parsed.projectsQueried) ? parsed.projectsQueried.filter((x): x is string => typeof x === 'string') : [],
      reinjectPending: parsed.reinjectPending === true,
      currentProject: typeof parsed.currentProject === 'string' && parsed.currentProject.length > 0 ? parsed.currentProject : null,
    }
  } catch {
    return { injected: [], searched: [], accessed: [], written: [], projectsQueried: [], reinjectPending: false, currentProject: null }
  }
}

/** 统一写 sessions/<id>.json（全部字段一次写全——新增字段只改这里，防散落漏写）。 */
function writeSeenFile(workspace: string, sessionId: string, seen: SessionSeen, dir: string): void {
  const file = sessionsFile(workspace, sessionId, dir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    injected: seen.injected,
    searched: seen.searched,
    accessed: seen.accessed,
    written: seen.written,
    projectsQueried: seen.projectsQueried,
    reinjectPending: seen.reinjectPending,
    currentProject: seen.currentProject,
  }), 'utf8')
}

/** 读本会话已注入 id 列表（文件不存在返回空数组）。 */
export function readInjected(workspace: string, sessionId: string, dir = '.dsh-meow'): string[] {
  return readSeenFile(workspace, sessionId, dir).injected
}

/** 追加写入已注入 id。 */
export function markInjected(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.injected)
  for (const id of ids) set.add(id)
  seen.injected = [...set]
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 本会话全部"已见" id（注入 + 检索 + 查阅），dream 第一轮清单范围 + 检索排除用。 */
export function readSeen(workspace: string, sessionId: string, dir = '.dsh-meow'): Set<string> {
  const s = readSeenFile(workspace, sessionId, dir)
  return new Set([...s.injected, ...s.searched, ...s.accessed])
}

/** 追加已检索返回的 id（memory_search / memory_find_similar 命中后调用）。 */
export function markSearched(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.searched)
  for (const id of ids) set.add(id)
  seen.searched = [...set]
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 追加 memory_read 读过的 id（v0.17.0）：dream 第一轮"查阅过"源。
 *  只由 memory_read 单条读取触发；memory_project 全景不标记（第三轮项目总结专门复查）。 */
export function markAccessed(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const set = new Set(seen.accessed)
  for (const id of ids) set.add(id)
  seen.accessed = [...set]
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 追加本会话写工具落库过的 id（v0.23.0）：memory_remember（新建/合并）与
 *  memory_update（实际写入）成功后调用。重复写入移到末尾（最近优先），
 *  超过 MAX_REINJECT_WRITTEN 淘汰最旧的。 */
export function markWritten(workspace: string, sessionId: string, ids: string[], dir = '.dsh-meow'): void {
  if (ids.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const ordered = seen.written.filter((id) => !ids.includes(id))
  ordered.push(...ids)
  seen.written = ordered.slice(-MAX_REINJECT_WRITTEN)
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 读本会话写过的记忆 id 清单（压缩重注入第三块 + dream 第一轮清单用）。 */
export function readWritten(workspace: string, sessionId: string, dir = '.dsh-meow'): string[] {
  return readSeenFile(workspace, sessionId, dir).written
}

/** 记录 memory_project 查阅过的项目（v0.21.0）：压缩重注入清单。
 *  全局标记（isGlobalProject，语言感知）/空串跳过；多项目参数按逗号拆开逐个记；
 *  重复查询移到末尾（最近优先）；超过 MAX_REINJECT_PROJECTS 淘汰最旧的。 */
export function markProjectQueried(workspace: string, sessionId: string, project: string, dir = '.dsh-meow'): void {
  const names = project.split(',').map((p) => p.trim()).filter((p) => p.length > 0 && !isGlobalProject(p))
  if (names.length === 0) return
  const seen = readSeenFile(workspace, sessionId, dir)
  const ordered = seen.projectsQueried.filter((p) => !names.includes(p))
  ordered.push(...names)
  seen.projectsQueried = ordered.slice(-MAX_REINJECT_PROJECTS)
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 读本会话查阅过的项目清单（压缩重注入用；文件不存在返回空数组）。 */
export function readProjectQueried(workspace: string, sessionId: string, dir = '.dsh-meow'): string[] {
  return readSeenFile(workspace, sessionId, dir).projectsQueried
}

/** 压缩成功落地后置位（compaction/end 无 error 时调用）：下一个含真实用户消息的
 *  pre-step 注入压缩重注入块。 */
export function markReinjectPending(workspace: string, sessionId: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  if (seen.reinjectPending) return
  seen.reinjectPending = true
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 清除重注入待办（重注入块注入完成后调用；幂等）。 */
export function clearReinjectPending(workspace: string, sessionId: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  if (!seen.reinjectPending) return
  seen.reinjectPending = false
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 读重注入待办标记。 */
export function isReinjectPending(workspace: string, sessionId: string, dir = '.dsh-meow'): boolean {
  return readSeenFile(workspace, sessionId, dir).reinjectPending
}

/** 释放本会话已见记录（收到会话压缩信号后调用）：清空 injected/searched，
 *  允许之前注入/检索过的记忆被再次命中提取——压缩后它们的内容已不在上下文里。
 *  accessed 不清（用户拍板 2026-08-25）：它只服务 dream 扫尾范围、没有去重功能，
 *  清掉纯丢信息——长窗口压缩前读过的条目恰恰最该被 dream 复查。
 *  当前 project 锚定保留（与可见性无关）；projectsQueried/written/reinjectPending 保留
 *  （它们正是压缩重注入的数据源，见 buildReinjection）。 */
export function releaseSeen(workspace: string, sessionId: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  seen.injected = []
  seen.searched = []
  writeSeenFile(workspace, sessionId, seen, dir)
}

/** 读当前 project 锚定（最近一次带 project 参数的 memory 工具调用）；未锚定返回 null。 */
export function getCurrentProject(workspace: string, sessionId: string, dir = '.dsh-meow'): string | null {
  return readSeenFile(workspace, sessionId, dir).currentProject
}

/** 锚定当前 project：memory 工具调用带 project 参数时更新会话状态（命中检索用它，免扫历史）。 */
export function setCurrentProject(workspace: string, sessionId: string, project: string, dir = '.dsh-meow'): void {
  const seen = readSeenFile(workspace, sessionId, dir)
  seen.currentProject = project
  writeSeenFile(workspace, sessionId, seen, dir)
}

function toDocs(rows: MemoryRow[]): Doc[] {
  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    title: r.title,
    content: r.content,
    keywords: r.keywords,
    importance: r.importance,
    hit_count: r.hit_count,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
}

function shortTitle(row: MemoryRow, max: number): string {
  const t = row.title?.trim()
  if (t) return t.length > max ? t.slice(0, max) + '…' : t
  const c = row.content.replace(/\s+/g, ' ').trim()
  return c.length > max ? c.slice(0, max) + '…' : c
}
/* v8 ignore next -- 保留工具函数（历史/调试用），当前导引不再截断标题 */
void shortTitle

/**
 * 构造长期记忆快照正文（buildInjection / buildReinjection 共用）：
 *   顶格「===== 长期记忆 =====」→ 【关于你】(soul) / 【关于user】/ 【设计原则】/ 【记忆导引】(两行)。
 * 不含结束标记与「本轮用户prompt：」尾巴（两链路各自拼装），也不做已见记账（调用方负责）。
 * v0.32 加固：
 * - trust.trusted === false（外来/未信任记忆库）→ 只输出静态「记忆导引」提示，soul/user/rules/
 *   项目清单等库内内容一律不读不注入（未信任提示由 index.ts 另行注入）；
 * - capChars > 0 → 按字符预算组装（budget.snapshotMaxChars），装不下的条目直接不注入，
 *   末尾补 …；injectedIds 只含真正写进正文的条目（超预算的不会被误记已见）。
 * @returns null = 只有标题头，无任何可注入内容。
 */
function buildInjectionBody(
  db: MemoryDb,
  o: InjectOptions,
  capChars: number,
): { body: string; injectedIds: string[] } | null {
  // 框架词外置（v0.19.0）：labels.md 的 inject.* 键；记忆条目正文本身是数据不是文案，不外置。
  const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
  const trusted = o.trust?.trusted !== false
  const soul = trusted ? db.list('soul', { status: 'active' }) : []
  const user = trusted ? db.list('user', { status: 'active' }) : []

  const lines: string[] = [lbl('inject.title'), '']
  const injected: string[] = []
  let used = lines.join('\n').length
  let truncated = false
  let hasContent = false
  /** 按字符预算判断一行是否还装得下（used 是 join 长度近似值，偏保守）。 */
  const fits = (line: string): boolean => capChars <= 0 || used + 1 + line.length <= capChars
  const push = (line: string): void => {
    lines.push(line)
    used += 1 + line.length
  }
  const pushBlock = (block: string[]): boolean => {
    if (block.length === 0 || truncated) return false
    if (!fits(block[0])) {
      truncated = true
      return false
    }
    for (const line of block) {
      if (!fits(line)) {
        truncated = true
        break
      }
      push(line)
    }
    return true
  }

  const pushEntries = (label: string, rows: MemoryRow[]) => {
    if (rows.length === 0 || truncated) return
    const head = lbl('inject.sectionFormat', { label })
    // 段标题 + 首条都装不下 → 整段放弃（不留空标题）。
    if (!fits(head) || !fits(`- ${rows[0].content}`)) {
      truncated = true
      return
    }
    push(head)
    for (const r of rows) {
      const line = `- ${r.content}`
      if (!fits(line)) {
        truncated = true
        break
      }
      push(line)
      injected.push(r.id) // 正文已注入 → 记入已见（命中链路不再重复注入）
      hasContent = true
    }
    if (!truncated) push('')
  }

  pushEntries(lbl('inject.aboutYou'), soul)
  pushEntries(lbl('inject.aboutUser'), user)

  // 设计原则（rules）：注入「全局适用（未标记 null / 空串 / 全局标记「全局」「global」）
  // 且 importance≥2」的——少而精的命令式准则。
  // 2026-09-19 口径修复（用户拍板）：此前只认 project === null，而文档（tools.md /
  // system-guide.md / dream-atomic.md）教模型写"全局"——按文档写的准则反而永不注入。
  // 未信任库不读 rules（含全局规则）：rules 是命令式文本，注入优先级等同用户指令，风险最高。
  const globalRules = trusted ? db.list('rules', { status: 'active' }).filter((r) => isGlobalScope(r.project) && r.importance >= 2) : []
  pushEntries(lbl('inject.rules'), globalRules)

  // 记忆导引：说明 + 项目列表（正文/标题一律自取，不列）。
  // titleMax 落地（2026-09-10）：schema/设置页一直承诺「导引里项目名的截断长度」，
  // 此前是死配置（shortTitle 被 void）。这里按承诺截断项目名——只影响导引一行展示，
  // 记忆条目正文/标题依旧不截断（v0.19.0 拍板不变）。
  const projectNames = trusted ? db.listProjectNames() : []
  // 导引的提示行是静态文案（不是库内容），未信任库也保留（告诉模型记忆工具怎么用）；
  // 项目清单来自库内数据，未信任时不列出（项目全景链路也被 trust 门挡掉）。
  if (!trusted || projectNames.length > 0) {
    const block: string[] = [
      lbl('inject.sectionFormat', { label: lbl('inject.guide') }),
      lbl('inject.guideSearchLine'),
      lbl('inject.guideProjectLine'),
    ]
    if (projectNames.length > 0) {
      const max = o.titleMax
      const shown = projectNames.map((n) => (n.length > max ? n.slice(0, max) + '…' : n))
      block.push(lbl('inject.guideProjects', { list: shown.join(' / ') }))
    }
    if (pushBlock(block)) {
      hasContent = true
      if (!truncated) push('')
    }
  }

  if (truncated && fits('…')) push('…')
  if (!hasContent) return null // 只有标题头 / 预算连第一行内容都放不下，无任何可注入内容
  return { body: lines.join('\n').trimEnd(), injectedIds: injected }
}

/**
 * 构造首轮长期记忆注入块（用户拍板格式，PR #10 起为独立 plugin snapshot 正文）：
 *   顶格「===== 长期记忆 =====」→ 【关于你】(soul) / 【关于user】/ 【设计原则】/ 【记忆导引】(两行)。
 *   不再拼接结束标记与「本轮用户prompt：」尾巴——正文作为独立消息插在真实用户消息前，
 *   用户 prompt 保持原样（防会话标题污染；旧格式历史会话由前端折叠兼容）。
 * 首轮只注入长期记忆，不做关键词命中（命中链路从第二轮起，见 buildHitInjection）；
 * 正文注入的 id 记入已见（命中链路不再重复注入它们）。
 * v0.32：opts.trust.trusted === false 时只回记忆导引提示（库内内容不注入）；
 * 快照正文按 opts.snapshotMaxChars（契约默认 6000）截断预算，超预算条目会被丢弃并补 …。
 * @returns { text, injectedIds }；无任何可注入内容返回 null。
 */
export function buildInjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  _firstUserText: string = '',
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const built = buildInjectionBody(db, o, o.snapshotMaxChars ?? BUDGET_DEFAULTS.snapshotMaxChars)
  if (built === null) return null
  const text = built.body
  if (built.injectedIds.length > 0) markInjected(workspace, sessionId, built.injectedIds, dir)
  return { text, injectedIds: built.injectedIds }
}

/** 框架词（labels.md）：项目全景段落里的短词随语言包走（PR #6 外置，zh 值逐字不变）。 */
const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
/** 子标签 → 注入段落标题（文案外置：labels.md 的 project.section.*）。 */
const sectionTitle = (sub: ProjectSubcategory): string => lbl(`project.section.${sub}`)

/** 组内排序：记忆时间戳（updated_at）旧→新，相同按创建时间；null 视为最旧。 */
function sortByUpdatedAt(list: MemoryRow[]): MemoryRow[] {
  return [...list].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0) || a.created_at - b.created_at)
}

/** 项目全景条目行（原文视图）：归属 + 完整 id + 绝对/相对时间戳，第二行完整内容。
 *  归属显示：'全局'=真全局；null=未标记（可能是数据 bug）；多值 join '/'。 */
function fmtProjectRow(r: MemoryRow): string {
  const abs = new Date(r.updated_at).toISOString().slice(0, 16).replace('T', ' ')
  return `[${projectLabel(r.project)} : ${r.level}] [${r.id}] ${abs} [${relativeTime(r.updated_at)}]\n${r.content}`
}

/**
 * 构造项目全景注入段落（memory_project 工具与压缩重注入共用，v0.21.0 从 tools.ts 迁入）：
 * 【项目：X】+ 项目设计原则(rules，放最前——规则优先于事实) + 各子标签分组
 * （组内按记忆时间戳旧→新；todo 含已完成最近 5 条）+ 检索说明尾注。
 * 非 todo 子标签只取 active；条目正文本身是数据，不做文案外置。
 * @returns null = 项目无任何可注入段落（active 条目与已完成 todo 皆空）。
 */
/** 内部构造：段落文本 + 段内出现过的全部条目 id（压缩重注入第三块按此去重，防同块重复展示）。
 *  trust.trusted === false（外来/未信任记忆库）→ 直接返回 null（不输出任何库内条目行）。 */
function buildProjectSection(db: MemoryDb, workspace: string, project: string, dir: string, trust?: InjectionTrust): { text: string; ids: string[] } | null {
  if (trust?.trusted === false) return null
  // 项目视图按名单语义匹配（#61）：project 字段写多项目名（'dsh,femo'）的条目，
  // 在任一名单项目的视图都该可见——SQL 精确等值会把两边都漏掉。全局标记/未标记
  // projectList 为空、不命中任何具体项目名，保持「全局内容走快照层」的原语义。
  const rows = db.list('project').filter((r) => projectList(r.project).includes(project))
  const ids: string[] = []
  const render = (list: MemoryRow[]): string => {
    for (const r of list) ids.push(r.id)
    return list.map(fmtProjectRow).join('\n')
  }
  const active = rows.filter((r) => r.status === 'active')
  // todo 已完成：stale 且 updated_at 非空，按 updated_at 取最近 5 条（展示仍按旧→新）。
  const done = sortByUpdatedAt(
    rows
      .filter((r) => r.subcategory === 'todo' && r.status === 'stale' && r.updated_at !== null)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 5),
  )
  const bySub = new Map<ProjectSubcategory, MemoryRow[]>()
  for (const r of active) {
    const sub = r.subcategory ?? 'overview' // 早期无子类条目归概述组
    const list = bySub.get(sub) ?? []
    list.push(r)
    bySub.set(sub, list)
  }
  const sections: string[] = []
  // 项目设计原则（rules，project 特定）：放最前——规则优先于事实。
  const projectRules = sortByUpdatedAt(
    db.list('rules').filter((r) => projectList(r.project).includes(project) && r.status === 'active'),
  )
  if (projectRules.length > 0) {
    sections.push(`${lbl('inject.rules')}\n${render(projectRules)}`)
  }
  for (const sub of PROJECT_SUBCATEGORIES) {
    if (sub === 'todo') {
      const todos = sortByUpdatedAt(bySub.get('todo') ?? [])
      if (todos.length === 0 && done.length === 0) continue
      const lines = [sectionTitle('todo')]
      if (done.length > 0) {
        lines.push(lbl('project.todoDone'))
        for (const r of done) {
          ids.push(r.id)
          lines.push(fmtProjectRow(r))
        }
      }
      if (todos.length > 0) {
        lines.push(lbl('project.todoOpen'))
        for (const r of todos) {
          ids.push(r.id)
          lines.push(fmtProjectRow(r))
        }
      }
      sections.push(lines.join('\n'))
    } else {
      const list = sortByUpdatedAt(bySub.get(sub) ?? [])
      if (list.length === 0) continue
      sections.push(`${sectionTitle(sub)}\n${render(list)}`)
    }
  }
  if (sections.length === 0) return null
  const dbPath = memoryDbPath(workspace, dir)
  const text = [
    lbl('project.header', { name: project }),
    '',
    sections.join('\n\n'),
    '',
    '——',
    '说明：此处只提供 active 的记忆。',
    `如果你想看非 active 条目（archived=删除 / stale=完结），或某条记忆的具体时间戳（记忆时间戳=该窗口 dream 封存时刻）、记忆来源（source_session）、重要性、关键词等元数据，可以直接去搜记忆库 SQLite：${dbPath}`,
    '（库内结构：七层表 soul/user/project/fact/lesson/topic/rules，字段含 id/title/content/importance/keywords/status/corrected/project/subcategory/goal/source_session/created_at/updated_at（记忆时间戳=最后更新时间）/last_accessed_at；另有 dream_log 整理留痕表、windows 窗口时间表；也可按 id 用 memory_read 看单条完整元数据）',
    `如果你想了解未被记录的更多细节，可以直接去搜会话历史目录（dsh 的 session 日志，位置由 DSH_HOME 决定，默认 ~/.dsh/sessions，喵版为 dsh-home/sessions），按会话 id 查原始记录。`,
  ].join('\n')
  return { text, ids }
}

/** 段落文本视图（memory_project 工具用）：只要文本。
 *  trust.trusted === false（未信任库）→ null（调用方应改抛"记忆库未受信任"提示）。 */
export function buildProjectSectionText(
  db: MemoryDb,
  workspace: string,
  project: string,
  dir = '.dsh-meow',
  opts: { trust?: InjectionTrust } = {},
): string | null {
  return buildProjectSection(db, workspace, project, dir, opts.trust)?.text ?? null
}

/**
 * 压缩重注入第三块（v0.23.0）：本会话写过的记忆原文回放。
 * 数据源 = sessions/<id>.json 的 written（memory_remember/memory_update 落库痕迹，
 * 子代理代写归父窗口）∪ db 层 source_session=本会话 的新建条目（双保险，覆盖插件
 * 热更新前旧代码写入的条目）。按当前库最新数据解析原文（不缓存旧文本）；只回放
 * status=active（archived/stale 内容已失效，回放会误导）；排除快照正文与项目全景
 * 已展示的 id（防同块重复）；超出 MAX_REINJECT_WRITTEN 保留最近写入的。
 * @returns null = 本会话没有可回放的写入条目。
 */
function buildWrittenSection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  dir: string,
  exclude: ReadonlySet<string>,
): { text: string; ids: string[] } | null {
  const ordered: string[] = [...readWritten(workspace, sessionId, dir)]
  for (const { id } of db.idsBySession(sessionId)) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  const rows: MemoryRow[] = []
  for (const id of ordered) {
    if (exclude.has(id)) continue
    const found = db.findById(id)
    if (!found || found.row.status !== 'active') continue
    rows.push(found.row)
  }
  const kept = rows.slice(-MAX_REINJECT_WRITTEN)
  if (kept.length === 0) return null
  return {
    text: [
      lbl('inject.sectionFormat', { label: lbl('inject.writtenSection') }),
      lbl('inject.writtenIntro'),
      ...kept.map(fmtProjectRow),
    ].join('\n'),
    ids: kept.map((r) => r.id),
  }
}

/**
 * 构造压缩重注入块（v0.21.0 三块制，v0.23.0 增第三块）：
 * ① 长期记忆快照正文（与首轮 buildInjection 同款）；
 * ② 【会话已压缩】说明 + 本会话此前查阅过的项目全景（按当前库最新数据重新构造，
 *    空项目跳过；项目全景条目按现行原则不标记已见）；
 * ③ 【本会话写过的记忆】+ 本会话写工具落库过的条目原文（见 buildWrittenSection）。
 * 不拼尾注（PR #10 起）：正文作为独立 plugin snapshot 消息插在真实用户消息前，
 * 用户 prompt 保持原样。
 * 快照条目 id 与回放的 written id 重新记入 injected——压缩后内容重新进入上下文，
 * 去重语义随之恢复（合并更新过的他窗条目不再被关键词命中重复注入）。
 * v0.32 加固：
 * - trust.trusted === false → 只保留静态记忆导引快照，项目全景/写入回放一律不输出；
 * - 整体字符预算 opts.reinjectMaxChars（契约默认 8000）：超预算时按 快照 > 写入回放 >
 *   项目全景 的优先级整块保留，装不下的块整块丢弃（不是切半行），末尾补 …。
 * @returns null = 无任何可注入内容（库无快照正文、项目全空且无写入条目）；调用方仍应
 *          清除 reinjectPending，避免每个用户消息轮空转重查。
 */
export function buildReinjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  projects: readonly string[],
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  const trusted = o.trust?.trusted !== false
  const capChars = o.reinjectMaxChars ?? BUDGET_DEFAULTS.reinjectMaxChars
  const snapshot = buildInjectionBody(db, o, o.snapshotMaxChars ?? BUDGET_DEFAULTS.snapshotMaxChars)
  const projectTexts: string[] = []
  const projectIds = new Set<string>()
  if (trusted) {
    for (const project of projects) {
      const built = buildProjectSection(db, workspace, project, dir, o.trust)
      if (built !== null) {
        projectTexts.push(built.text)
        for (const id of built.ids) projectIds.add(id)
      }
    }
  }
  // 第三块：本会话写过的记忆（排除快照与项目全景已展示的 id，防同块重复）。
  // 未信任库不回放（内容仍来自库内行，可能被外来行污染）。
  const written = trusted
    ? buildWrittenSection(db, workspace, sessionId, dir, new Set([...(snapshot?.injectedIds ?? []), ...projectIds]))
    : null
  if (snapshot === null && projectTexts.length === 0 && written === null) return null

  /** 按原格式组装三块（withProjects/withWritten 用于预算裁剪时整块取舍）。 */
  const assemble = (withProjects: boolean, withWritten: boolean): { text: string; ids: string[] } => {
    const lines: string[] = []
    if (snapshot !== null) {
      lines.push(snapshot.body)
      lines.push('')
    }
    const includeProjects = withProjects && projectTexts.length > 0
    const includeWritten = withWritten && written !== null
    if (includeProjects || includeWritten) {
      lines.push(lbl('inject.sectionFormat', { label: lbl('inject.reinjectSection') }))
      lines.push(lbl('inject.reinjectIntro'))
      lines.push('')
      if (includeProjects) {
        lines.push(projectTexts.join('\n\n'))
        lines.push('')
      }
    }
    if (includeWritten) {
      lines.push(written?.text ?? '')
      lines.push('')
    }
    return {
      text: lines.join('\n').trimEnd(),
      ids: [...(snapshot?.injectedIds ?? []), ...(includeWritten ? (written?.ids ?? []) : [])],
    }
  }
  // 预算内优先级：快照（长期记忆）> 写入回放（本会话刚写的）> 项目全景（体积最大、可再查）。
  const candidates: Array<[boolean, boolean]> = [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ]
  let picked: [boolean, boolean] = [false, false]
  for (const c of candidates) {
    picked = c
    if (capChars <= 0 || assemble(c[0], c[1]).text.length <= capChars) break
  }
  const result = assemble(picked[0], picked[1])
  // 兜底：极端配置（如 snapshotMaxChars > reinjectMaxChars）下再截断一次。
  const text = capText(result.text, capChars)
  if (result.ids.length > 0) markInjected(workspace, sessionId, result.ids, dir)
  return { text, injectedIds: result.ids }
}

/** 关键词命中查询（首轮与每条消息链路共用）：active 的 fact/lesson/rules/topic，
 *  范围=全局 或 当前 project 锚定；排除本会话已见（injected+searched）；
 *  不检索本 session 建立的记忆（它们就在上下文里，AI 最清楚，无需命中）。
 *  命中打分基于条目关键词（keywords，+title）而非全文——全文匹配噪音大
 *  （常见 bigram 如"的时"每条消息都有，长条目一碰词就整条注入）。 */
function hitQuery(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  userText: string,
  o: InjectOptions,
  dir: string,
): Array<{ id: string; level: string; content: string; updated_at: number | null }> {
  // 未信任记忆库：命中链路整条短路（返回 [] → buildHitInjection 返回 null），不读库内匹配面。
  if (o.trust?.trusted === false) return []
  const seenState = readSeenFile(workspace, sessionId, dir)
  const currentProject = seenState.currentProject
  const hitRows = [
    ...db.list('fact', { status: 'active' }),
    ...db.list('lesson', { status: 'active' }),
    ...db.list('rules', { status: 'active' }),
    ...db.list('topic', { status: 'active' }),
  ].filter((r) =>
    (isGlobalScope(r.project) || (currentProject !== null && projectCovers(r.project, currentProject)))
    && r.source_session !== sessionId // 本 session 建立的记忆在上下文里，不命中
    && !seenState.injected.includes(r.id), // 已注入先排除再截断（#67）：先 hitTopK 后过滤，
  ) // top-K 被旧命中占满时本轮会颗粒无收，注入数恒低于上限
  if (hitRows.length === 0) return []
  const query = userText.slice(0, 500)
  const docs = toDocs(hitRows).map((d) => ({
    ...d,
    // 匹配面 = 条目关键词（LLM 提取或自动 bigram；无关键词的旧条目回退内容前 100 字）。
    content: d.keywords.length > 0 ? d.keywords.join(' ') : d.content.slice(0, 100),
  }))
  // 命中专用打分：查询覆盖率 × 遗忘权重 × importance × title 加成 × hit_count 加成（v0.32），
  // 检索参数全部由 index.ts 从 config 传入（不在此 import 配置）。minScore 过滤低质量命中。
  const hits = keywordHitScore(query, docs, {
    k: o.hitTopK,
    halfLifeDays: o.halfLifeDays,
    minScore: o.minScore,
    hitBoost: o.hitBoost,
    importanceWeight: o.importanceWeight,
  })
  const byId = new Map(hitRows.map((r) => [r.id, r]))
  // 展示/注入用原文 content（docs 的 content 只是 keywords 匹配面，不能当正文）。
  // 已注入的进入本函数前就排掉了（#67），这里不再二次过滤。
  return hits
    .map((h) => {
      const row = byId.get(h.id)
      return { id: h.id, level: h.level, content: row?.content ?? h.content, project: row?.project ?? null, updated_at: row?.updated_at ?? null }
    })
}

/**
 * 每条用户消息的关键词命中注入（独立于首轮注入的链路）：
 * 检索 active 的 fact/lesson/rules/topic（全局+当前锚定项目），top-K 命中注入，
 * 命中 id 记入本会话已见（之后不再命中；压缩释放 seen 后恢复）。
 * 格式：顶格「可能相关的记忆，仅供参考：」→ 条目（- [id] 换行接内容、
 * 条目间空行）。返回文本作为独立 plugin snapshot 消息的正文。
 * v0.32 加固：trust.trusted === false → 直接返回 null（不注入库内条目）；
 * 单条正文按 opts.hitMaxChars（契约默认 1500）截断补 …；每条实际注入的命中调用
 * opts.onHit(level,id) 供 index.ts 记账 bumpHitCount（hitBoost 的反馈来源）。
 * @returns 命中注入块；无命中返回 null。
 */
export function buildHitInjection(
  db: MemoryDb,
  workspace: string,
  sessionId: string,
  userText: string,
  opts: Partial<InjectOptions> = {},
  dir = '.dsh-meow',
): { text: string; injectedIds: string[] } | null {
  const o = { ...DEFAULT_OPTS, ...opts }
  if (o.trust?.trusted === false) return null
  const fresh = hitQuery(db, workspace, sessionId, userText, o, dir)
  if (fresh.length === 0) return null
  const hitMaxChars = o.hitMaxChars ?? BUDGET_DEFAULTS.hitMaxChars
  const lines = [keyedValue('labels', 'inject.hitHeader')]
  for (const h of fresh) {
    // 原文视图：归属 + 完整 id + 绝对/相对时间戳（记忆时间戳=updated_at 最后更新时间；无时间戳不显示），第二行完整内容。
    const proj = projectLabel(h.project)
    const time = h.updated_at
      ? ` ${new Date(h.updated_at).toISOString().slice(0, 16).replace('T', ' ')} [${relativeTime(h.updated_at)}]`
      : ''
    lines.push(`[${proj} : ${h.level}] [${h.id}]${time}`)
    lines.push(capText(h.content, hitMaxChars)) // 单条命中正文上限（budget.hitMaxChars）
    lines.push('')
  }
  const text = lines.join('\n').trimEnd()
  const ids = fresh.map((h) => h.id)
  markInjected(workspace, sessionId, ids, dir)
  // 命中记账：每条实际注入的命中回调一次（index.ts 传 (level,id)=>bumpHitCount(level,id)）。
  // 回调异常不阻塞注入（fail-open，记账失败只影响下一次 hitBoost）。
  if (o.onHit !== undefined) {
    for (const h of fresh) {
      try {
        o.onHit(h.level as Level, h.id)
      } catch { /* 记账失败不阻塞注入 */ }
    }
  }
  return { text, injectedIds: ids }
}

// 导出 tokenize 供索引/测试复用
export { tokenize }
