/**
 * meow-memory v2 — 按窗口空闲整理（dream）。
 *
 * 用户拍板（2026-08-15 原始设计 + 2026-08-19 改版）：
 * - 每个 session 窗口由它自己的主 agent 整理：只发本窗口（source_session）建立的
 *   七层记忆（soul/user/project/fact/lesson/topic/rules），对着自己的完整对话上下文整理。
 * - 2026-08-19 改版（用户拍板）：① 不再按 project 逐轮——所有 project 混在同一轮，
 *   用【project：xxx】小标题分段，最后一段【project：无项目 - 全局信息，或缺少项目标签】；
 *   ② 分轮：第 1 轮=原子记忆（project/fact/lesson/rules/soul/user，不含 topic），
 *   第 2 轮=topic 记忆（空也发，回顾对话建新 topic）；2026-08-22 加第 3 轮=项目总结
 *   （本窗口涉及具体项目时追加：调 memory_project 复查并精简成新的项目长期记忆，
 *   被取代的旧条目归档）；轮数动态，消息显示"第 N/M 组"；③ 记忆范围=本窗口
 *   建立的 ∪ 本窗口提取过的（sessions/<id>.json 的 injected+searched）；④ 条目展示
 *   绝对时间戳（最后更新时间）；组内排序 project → level → 创建时间不变。
 * - T = dream 开始前窗口最后一轮正常对话时间（先记死）；收尾时该窗口所有条目
 *   updated_at = T（"记忆时间戳"=最后更新时间），windows 表 last_dream_time = T。
 * - 判定：窗口最后事件时间 > 24h 前 且 > 上次 dream 时间 → 需要 dream。
 * - 触发（用户拍板 2026-08-19）：窗口空闲 ≥ idleMinutes（默认 3 小时）即允许触发，
 *   替代原夜间窗口（00:00–07:00）；但当前时间处于峰时抑制时段（北京时间
 *   09:00–12:00、14:00–18:00，API 峰谷电价峰时，及各自开始前 15 分钟）时不触发，
 *   等峰时结束后的下一个检查周期自然触发。进行中的 dream 不打断，只挡新启动；
 *   手动 memory_dream 不受峰时抑制。
 * - 串行：同一时刻只有一个进行中的 dream 任务。
 * - 0.32 硬化（修 #49 + 成本审计 R1/R2）：自动 dream **只在窗口有 live agent 时**触发，
 *   绝不 resume 冷会话（旧 sessionController.resolveAgent / agents.resume 冷启动路径
 *   已整体删除；挂着的旧窗口最多丢一次自动整理，绝不 cold-cache 烧三轮上下文）。
 *   启动前另有三道成本闸（见「0.32 成本闸」）：会话上下文 token 估算 / 24h 窗口频次 /
 *   超限后 24h 冷却。手动 /dream、memory_dream 是显式意愿，不受这三道闸限制。
 *
 * 冲突处理：memory_search 返回 top-k 后按 updated_at 重排 + 顶部提示；
 * agent 据"记忆时间戳"判断新旧（工具层乐观锁留待迭代）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, projectList, storeTrustOf, type Level, type MemoryRow } from './db.js'
import { activeHomeDir } from './home-dir.js'
import { fillTemplate, keyedValue, resolveSlotText } from './prompt-loader.js'
import { readSeen, readWritten } from './inject.js'
import { workspaceOf } from './tools.js'
import { DEFAULT_RULES_REVIEW_DAYS } from './defaults.js'
import { PLUGIN_SOURCE } from './source.js'

// ── 执行体（steer，主窗口） ─────────────────────────────────────────────────
//
// dream 的组推进由主会话 turn-stopping 驱动：组消息 steer 进主会话（prompt、模型
// 回应、工具调用都落主 log，折叠 UI 负责视觉收纳）。独立 fork 子代理执行体已随
// v0.24 移除（猫猫拍板：反思/梦境永远在主窗口执行，不再提供独立执行选项）。
// 换模型需求由 agent/request waterfall 承接（index.ts：插件轮请求覆盖模型）。

/** dream 消息识别标记（turn-stopping 推进判定用）。 */
export const DREAM_MARKER = '[meow-memory-dream]'

/** 会话短 id：剥掉 "session-" 前缀再取前 8 位（日志/落库展示用，可辨识窗口）。 */
export function shortSessionId(sid: string): string {
  return (sid.startsWith('session-') ? sid.slice(8) : sid).slice(0, 8)
}

/** 同步文件日志：进程崩溃也不丢（崩溃点定位用）。
 *  0.32（成本/运维审计 R9/O3）：落点固定为全局目录 activeHomeDir()/dream-debug.log——
 *  绝不写进用户工作区（不能往别人的 repo 里拉日志）；全局目录热切换后下一笔即落新目录。
 *  日志失败静默（日志本身绝不阻塞 dream）。 */
function dreamLog(msg: string): void {
  try {
    appendFileSync(join(activeHomeDir(), 'dream-debug.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* 日志失败不阻塞 */
  }
}

/** 当前 dream-debug.log 落点（诊断/测试用；与 dreamLog 同口径，动态读全局目录）。 */
export function dreamLogPath(): string {
  return join(activeHomeDir(), 'dream-debug.log')
}

// ── 0.32 成本闸（修 #49；审计 cost R1/R2 / stability）─────────────────────────
//
// 审计结论（findings-risk §4）：dream 是「默认自动花 token」且无预算——一次 dream
// 最多 3 轮全上下文请求，冷启动 resume 的窗口更是 cold-cache 三轮。0.32 的闸全部
// 只挡**自动**触发（手动 /dream、memory_dream = 显式意愿，放行）：
// ① 无 live agent 不 dream，且绝不 resume（旧冷启动路径已删除）；
// ② 会话上下文估算超过 budget.dreamMaxContextTokens → 跳过，并把跳过原因落
//    dream_meta（dreamskip:<sid>，跨进程/重启有效），24h 冷却期内不再重试；
// ③ 同一窗口 24h 内自动 dream 次数 ≤ budget.dreamMaxPerWindowPerDay（默认 1，0=关闭），
//    计数同样落 dream_meta（dreamauto:<sid>）。

/** 预算字段（Lead 在 resolved.dream.budget 下传入；全部可选，缺省按 0.32 出厂默认）。
 *  只消费配置，不在这里定义配置——默认值来源仍是 defaults.ts / config schema。 */
export interface DreamBudget {
  dreamMaxContextTokens?: number
  dreamMaxPerWindowPerDay?: number
  /** 进程级全局每日自动 dream 上限（review Q3；N 个窗口不再 = N 倍）。 */
  dreamMaxPerDayTotal?: number
  reflectMaxPerDay?: number
  reflectMinIntervalMinutes?: number
  /** 进程级全局每日自动反思上限。 */
  reflectMaxPerDayTotal?: number
}

export const DREAM_DEFAULT_MAX_CONTEXT_TOKENS = 40_000
export const DREAM_DEFAULT_MAX_PER_WINDOW_PER_DAY = 1
/** 上下文超限后的冷却期：同一窗口 24h 内不反复估算/重试（#49）。 */
export const DREAM_CONTEXT_SKIP_COOLDOWN_MS = 24 * 3600_000
/** 自动 dream 频次统计窗口（每窗口每 24h）。 */
export const AUTO_DREAM_WINDOW_MS = 24 * 3600_000

const DREAM_SKIP_META_PREFIX = 'dreamskip:'
const DREAM_AUTO_META_PREFIX = 'dreamauto:'

/** 非负有限数才算有效预算值（配置缺省/被写成垃圾时回默认，绝不让 NaN 放行）。 */
function budgetNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** budget.dreamMaxContextTokens（默认 40000）。 */
export function dreamMaxContextTokens(cfg: DreamConfig | undefined): number {
  const v = budgetNumber(cfg?.budget?.dreamMaxContextTokens)
  return v !== undefined && v > 0 ? v : DREAM_DEFAULT_MAX_CONTEXT_TOKENS
}

/** budget.dreamMaxPerWindowPerDay（默认 1；0 = 关闭自动 dream）。 */
export function dreamMaxPerWindowPerDay(cfg: DreamConfig | undefined): number {
  return budgetNumber(cfg?.budget?.dreamMaxPerWindowPerDay) ?? DREAM_DEFAULT_MAX_PER_WINDOW_PER_DAY
}

/** 上下文估算的字符/token 比（审计口径：≈3.5 字符 = 1 token）。 */
export const CONTEXT_CHARS_PER_TOKEN = 3.5

/** 抽样上限：事件很多时只抽这么多条按比例放大（超大会话不 stringify 整个 log）。 */
const CONTEXT_SAMPLE_MAX_EVENTS = 1000

export interface ContextEstimate {
  /** 估算 token（字符数 / 3.5，向上取整）。 */
  tokens: number
  /** 估算字符数（抽样时已按事件数放大）。 */
  chars: number
  /** 是否走了抽样（事件数 > 上限）。 */
  sampled: boolean
  totalEvents: number
}

/**
 * 估算会话上下文 token 数（CJK 感知）：CJK 字符按 ≈1.7 字/token、其余按 ≈4 字/token。
 * 0.32 review：旧的 chars/3.5 对中文会话低估近 2 倍（40k 闸实际≈70–90k token），
 * 这里按字符类别分开算，宁可估高一点（成本闸是保护，不是精确计费）。
 * 只读宿主内存里**已有**的 session 事件（绝不读盘、绝不 resume）；事件数超过上限时
 * 等距抽样再按条数放大——数量级够用，且不会在 15min 扫描链上卡住主线程。
 * 单条事件不可序列化（循环引用等）时跳过该条，绝不让估算把扫描带崩。
 */
export function estimateContextTokens(events: readonly unknown[], maxEvents = CONTEXT_SAMPLE_MAX_EVENTS): ContextEstimate {
  const total = events.length
  if (total === 0) return { tokens: 0, chars: 0, sampled: false, totalEvents: 0 }
  const cap = Math.max(1, Math.floor(maxEvents))
  const count = Math.min(total, cap)
  let chars = 0
  let cjkChars = 0
  for (let i = 0; i < count; i++) {
    // 等距取样（含首尾）：count===1 时固定取第 0 条
    const idx = count === 1 ? 0 : Math.round((i * (total - 1)) / (count - 1))
    const data = (events[idx] as { data?: unknown } | null | undefined)?.data
    if (data === undefined) continue
    try {
      const text = JSON.stringify(data) ?? ''
      chars += text.length
      // CJK（含中文/日文假名/韩文）：1.7 字/token；其余（ASCII/标点）≈4 字/token。
      cjkChars += (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
    } catch {
      /* 不可序列化的事件：跳过 */
    }
  }
  const scale = count < total ? total / count : 1
  chars = Math.round(chars * scale)
  cjkChars = Math.round(cjkChars * scale)
  const nonCjk = Math.max(0, chars - cjkChars)
  const tokens = Math.ceil(cjkChars / 1.7 + nonCjk / 4)
  return { tokens, chars, sampled: count < total, totalEvents: total }
}

/** 读 agent.session 的事件（与 index.ts sessionEventsOf 同口径：ownEvents() 优先，
 *  旧宿主 events 属性兜底；任何异常都当空——估算跑在定时扫描链上，绝不能抛）。 */
function agentSessionEvents(agent: unknown): readonly unknown[] {
  const session = (agent as { session?: { events?: unknown; ownEvents?: unknown } } | undefined)?.session
  if (session === undefined || session === null) return []
  try {
    const own = session.ownEvents
    if (typeof own === 'function') {
      const evs = (own as () => unknown).call(session)
      return Array.isArray(evs) ? evs : []
    }
  } catch {
    return []
  }
  return Array.isArray(session.events) ? (session.events as readonly unknown[]) : []
}

interface AutoDreamSkipState {
  at: number
  kind: 'context-oversize'
  tokens: number
  limit: number
}

/** 读上下文超限的跳过记录（dream_meta dreamskip:<sid>；缺失/损坏 → undefined）。 */
export function readAutoDreamSkip(db: ReturnType<typeof getDb>, sessionId: string): AutoDreamSkipState | undefined {
  let raw: string | undefined
  try {
    raw = db.getDreamMeta(DREAM_SKIP_META_PREFIX + sessionId)
  } catch {
    return undefined
  }
  if (raw === undefined) return undefined
  try {
    const v = JSON.parse(raw) as Partial<AutoDreamSkipState>
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return undefined
    return {
      at: v.at,
      kind: 'context-oversize',
      tokens: typeof v.tokens === 'number' ? v.tokens : 0,
      limit: typeof v.limit === 'number' ? v.limit : 0,
    }
  } catch {
    return undefined
  }
}

/** 清掉上下文超限冷却（手动 dream 启动成功后调用：显式整理过一次，旧记录作废）。 */
export function clearAutoDreamSkip(db: ReturnType<typeof getDb>, sessionId: string): void {
  try {
    db.delDreamMeta(DREAM_SKIP_META_PREFIX + sessionId)
  } catch {
    /* 清理失败不阻塞 */
  }
}

/** 最近 24h 内该窗口的自动 dream 启动时间戳（旧记录顺手裁掉；跨进程/重启共享）。 */
export function autoDreamStartsInWindow(db: ReturnType<typeof getDb>, sessionId: string, now = Date.now()): number[] {
  let raw: string | undefined
  try {
    raw = db.getDreamMeta(DREAM_AUTO_META_PREFIX + sessionId)
  } catch {
    return []
  }
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as { starts?: unknown }
    if (!Array.isArray(parsed.starts)) return []
    return parsed.starts
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && now - t < AUTO_DREAM_WINDOW_MS)
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

/** 0.32 review Q3：进程级自动 dream 启动时间戳（滚动 24h；重启清零，文档已说明）。 */
let globalAutoDreamStarts: number[] = []

/** 进程级全局自动 dream 上限（默认 12/天；0 = 关闭自动 dream）。 */
export function dreamMaxPerDayTotal(cfg: DreamConfig | undefined): number {
  return budgetNumber(cfg?.budget?.dreamMaxPerDayTotal) ?? 12
}

function globalDreamStartsInWindow(now: number): number {
  globalAutoDreamStarts = globalAutoDreamStarts.filter((t) => now - t < 24 * 3600_000)
  return globalAutoDreamStarts.length
}

/** 测试/热重载用：清空进程级成本计数。 */
export function resetGlobalCostCounters(): void {
  globalAutoDreamStarts = []
}

/** 记一次自动 dream 启动（dream_meta dreamauto:<sid> → {starts: [...]}）。 */
export function recordAutoDreamStart(db: ReturnType<typeof getDb>, sessionId: string, now = Date.now()): void {
  globalAutoDreamStarts.push(now)
  const starts = [...autoDreamStartsInWindow(db, sessionId, now), now]
  try {
    db.setDreamMeta(DREAM_AUTO_META_PREFIX + sessionId, JSON.stringify({ starts }))
  } catch {
    /* 计数失败不阻塞：最坏退化成本轮不计数 */
  }
}

/** 自动 dream 跳过原因（进程内日志去重用）。 */
export type AutoDreamSkipReason = 'cooldown' | 'cap' | 'context-oversize'

export interface AutoDreamGate {
  allowed: boolean
  reason?: AutoDreamSkipReason
  /** 估算值/上限（跳过时写日志用）。 */
  tokens?: number
  limit?: number
}

/**
 * 自动 dream 成本闸（只挡自动触发；手动 /dream、memory_dream 不经过这里）：
 * ① 24h 上下文超限冷却（dream_meta dreamskip:<sid>）；
 * ② 频次上限：24h 内自动启动次数 ≥ budget.dreamMaxPerWindowPerDay（默认 1，0=关闭）；
 * ③ 本次会话上下文估算 > budget.dreamMaxContextTokens（默认 40000）→ 记 24h 冷却并拒绝。
 * 估算只读内存里已有的事件；没有任何 resume / 读盘动作。
 */
export function evaluateAutoDreamGate(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  agent: unknown,
  cfg: DreamConfig | undefined,
  now = Date.now(),
): AutoDreamGate {
  const skip = readAutoDreamSkip(db, sessionId)
  if (skip !== undefined && now - skip.at < DREAM_CONTEXT_SKIP_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown', tokens: skip.tokens, limit: skip.limit }
  }
  const maxPerDay = dreamMaxPerWindowPerDay(cfg)
  if (maxPerDay <= 0) return { allowed: false, reason: 'cap' }
  if (autoDreamStartsInWindow(db, sessionId, now).length >= maxPerDay) return { allowed: false, reason: 'cap' }
  const limit = dreamMaxContextTokens(cfg)
  const estimate = estimateContextTokens(agentSessionEvents(agent))
  if (estimate.tokens > limit) {
    try {
      db.setDreamMeta(
        DREAM_SKIP_META_PREFIX + sessionId,
        JSON.stringify({ at: now, kind: 'context-oversize', tokens: estimate.tokens, limit }),
      )
    } catch {
      /* 持久化失败不阻塞：至少本次不启动 */
    }
    return { allowed: false, reason: 'context-oversize', tokens: estimate.tokens, limit }
  }
  return { allowed: true, tokens: estimate.tokens, limit }
}

/** 闸跳过的日志去重（进程级）：同一窗口同一原因只记一次，15min/轮的扫描不刷屏。 */
const autoDreamGateLogged = new Set<string>()
const AUTO_DREAM_GATE_LOGGED_MAX = 1024

function logAutoDreamGate(sessionId: string, gate: AutoDreamGate): void {
  if (gate.allowed) return
  const key = `${sessionId}:${gate.reason ?? 'skip'}`
  if (autoDreamGateLogged.has(key)) return
  autoDreamGateLogged.add(key)
  while (autoDreamGateLogged.size > AUTO_DREAM_GATE_LOGGED_MAX) {
    const oldest = autoDreamGateLogged.keys().next().value
    if (oldest === undefined) break
    autoDreamGateLogged.delete(oldest)
  }
  const sid = shortSessionId(sessionId)
  if (gate.reason === 'context-oversize') {
    dreamLog(`auto-dream skip sid=${sid} reason=context-oversize tokens≈${gate.tokens}/${gate.limit} -> 24h cooldown (#49)`)
  } else if (gate.reason === 'cooldown') {
    dreamLog(`auto-dream skip sid=${sid} reason=context-oversize-cooldown tokens≈${gate.tokens}/${gate.limit} (#49)`)
  } else {
    dreamLog(`auto-dream skip sid=${sid} reason=day-cap (#49)`)
  }
}

/**
 * 取窗口的 live agent（修 #49）：只认进程内**已经活着**的 agent——宿主 AgentRegistry
 * （0.2.1 的 ctx.get('agents').get）优先，turn-stopping 注册的 liveAgents 兜底（老宿主
 * 或 registry 不可用）。绝不 resume、绝不新建会话；取不到返回 undefined。
 */
export function liveAgentOf(ctx: Context, sessionId: string): unknown {
  try {
    const agentsSvc = (ctx as { get?: (name: string) => unknown }).get?.('agents') as
      | { get?: (id: unknown) => unknown }
      | undefined
    if (agentsSvc !== undefined && typeof agentsSvc.get === 'function') {
      const agent = agentsSvc.get(sessionId)
      if (agent !== undefined && agent !== null) return agent
    }
  } catch {
    /* registry 读失败：退回 liveAgents 注册表 */
  }
  return liveAgents.get(sessionId)
}

/** 无 live agent 的跳过日志去重（每会话一次，避免每 15min 一条刷日志）。 */
const coldResumeSkipLogged = new Set<string>()

// ── 分组与快照 ──────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<Level, number> = { project: 0, topic: 1, fact: 2, lesson: 3, rules: 4, soul: 5, user: 6 }

export interface DreamGroup {
  name: string // project 名；'' = 无项目标签
  rows: MemoryRow[]
}

/** 一轮 = 一种记忆类型（原子 / topic / 项目总结）。 */
export interface DreamRound {
  kind: 'atomic' | 'topic' | 'project-summary'
  groups: DreamGroup[]
  /** 仅 project-summary 轮：本窗口涉及的项目名清单（AI 逐个调 memory_project 复查）。 */
  projects?: string[]
}

/** 绝对时间戳（UTC 分钟级，与封存时间戳一致）。 */
function formatTime(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ')
}

/** 按 project 分组（组内 project→level→创建时间；"全局"/未标记归无项目段放最后；多值（逗号分隔）归第一个项目段）。 */
function groupByProject(rows: MemoryRow[]): DreamGroup[] {
  const byProject = new Map<string, MemoryRow[]>()
  for (const r of rows) {
    const list = projectList(r.project)
    const key = list.length > 0 ? list[0] : ''
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key)!.push(r)
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => {
      const l = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
      if (l !== 0) return l
      return a.created_at - b.created_at
    })
  }
  return [...byProject.entries()]
    .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])))
    .map(([name, rows]) => ({ name, rows }))
}

/** 单轮清单条目上限（0.32 成本审计：只归档不删除，长期窗口的清单会无限膨胀，
 *  每轮 prompt 越滚越大）。取 created_at 最新的 N 条，跨 level 统一排序后截断。 */
export const DREAM_MAX_ROWS_PER_ROUND = 60

/** 取最新 N 条（created_at 降序；db.list 已按 level 分组返回，跨 level 必须自己排序）。 */
function newestRows(rows: MemoryRow[], max = DREAM_MAX_ROWS_PER_ROUND): MemoryRow[] {
  if (rows.length <= max) return rows
  // review：按"最后更新时间"取最新，而不是创建时间——长期窗口里刚被改过的旧条目
  // 优先进入整理，避免只整理新条目、旧条目永远轮不到。
  return [...rows].sort((a, b) => b.updated_at - a.updated_at).slice(0, max)
}

/** dream 记忆范围（用户拍板 2026-08-19，v0.17.0 扩展）：本窗口建立的 ∪ 本窗口
 *  提取过的（sessions/<id>.json：注入 injected + 检索 searched + 查阅 accessed）。
 *  分轮：第 1 轮=原子记忆（project/fact/lesson/rules/soul/user，不含 topic），空则跳过；
 *  第 2 轮=topic 记忆**默认触发**（用户拍板 2026-08-19：空也发——AI 回顾对话历史，
 *  可能有新 topic 要创建）；第 3 轮=项目总结（用户拍板 2026-08-22，本窗口涉及具体项目
 *  时追加——调 memory_project 复查并精简成新的项目长期记忆，被取代的旧条目归档）。
 *  rules 防 churn（测评 2026-08-25）：updated_at 距今超 rulesReviewDays 天的稳定
 *  准则不进第 1 轮清单（0=不过滤）——每轮重审是低价值劳动且易诱发无意义 update；
 *  全局高 importance rules 每会话首轮都在注入，真矛盾会被当场 update、updated_at
 *  刷新后自动回到审查队列。
 *  0.32 清单卫生（成本审计 §3.3/§5.2）：
 *  ① status='archived' 的条目不再进任何一轮（旧行为会永远重喂已归档行）；
 *  ② 每轮最多 DREAM_MAX_ROWS_PER_ROUND（60）条 created_at 最新条目，prompt 有上界。 */
export function collectDreamRounds(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  workspace: string,
  dir = '.dsh-meow',
  rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS,
): DreamRound[] {
  // 清单范围 = 本窗口建立（source_session）∪ 注入/检索/查阅（seen）∪ 写过（written，
  // v0.23.0——经 memory_project 全景看到条目后 update 它，不落任何旧痕迹（全景刻意不标记），
  // written 补上这个漏记口子：凡本窗口写工具落库过的条目必进复查清单）。
  const seen = new Set([...readSeen(workspace, sessionId, dir), ...readWritten(workspace, sessionId, dir)])
  const atomic: MemoryRow[] = []
  const topic: MemoryRow[] = []
  for (const level of ['project', 'fact', 'lesson', 'rules', 'soul', 'user'] as const) {
    for (const r of db.list(level)) {
      if (!(r.source_session === sessionId || seen.has(r.id))) continue
      if (r.status === 'archived') continue // 0.32：已归档 = 不在整理范围（不再重喂旧行为）
      if (level === 'rules' && rulesReviewDays > 0 && Date.now() - r.updated_at > rulesReviewDays * 86_400_000) continue
      atomic.push(r)
    }
  }
  for (const r of db.list('topic')) {
    if (r.status === 'archived') continue
    if (r.source_session === sessionId || seen.has(r.id)) topic.push(r)
  }
  const atomicRows = newestRows(atomic)
  const topicRows = newestRows(topic)
  const rounds: DreamRound[] = []
  if (atomicRows.length > 0) rounds.push({ kind: 'atomic', groups: groupByProject(atomicRows) })
  rounds.push({ kind: 'topic', groups: groupByProject(topicRows) }) // topic 轮默认触发（空轮也让 AI 回顾建新 topic）
  // 第 3 轮=项目总结：项目集合=候选条目 project 并集（projectList 自动排除 全局/未标记；
  // db.list 不筛状态，前序轮归档不会让轮数中途变化）。没碰过任何项目就不发这一轮。
  // 项目集合取自截断后的候选（与 prompt 里的条目清单口径一致）。
  const projects = new Set<string>()
  for (const r of [...atomicRows, ...topicRows]) for (const p of projectList(r.project)) projects.add(p)
  if (projects.size > 0) rounds.push({ kind: 'project-summary', groups: [], projects: [...projects].sort() })
  return rounds
}

/** 单条目展示行（原文视图）：元数据头 + 完整 id + 绝对时间戳 + 关键词行。
 *  关键词标签文案由调用方传入（labels.md：dream.row.keywordsLabel / dream.row.none）。 */
function formatRow(r: MemoryRow, kwLabel: string, noneLabel: string): string {
  const head = r.content.replace(/\s+/g, ' ').trim()
  const meta = [r.level]
  if (r.level === 'project' && r.subcategory) meta.push(r.subcategory)
  if (r.title) meta.push(`《${r.title}》`)
  if (r.status !== 'active') meta.push(r.status)
  meta.push(`${r.id} ${formatTime(r.updated_at)}`) // 完整 id + 绝对时间戳（最后更新时间）
  // 关键词行：AI 要核查/重写关键词（判断 6），必须先把现有关键词给它看。
  const kw = (r.keywords ?? []).filter((k) => typeof k === 'string' && k.length > 0)
  const kwLine = kw.length > 0 ? kw.join(', ') : noneLabel
  return `- [${meta.join(' ')}] ${head}\n  ${kwLabel} ${kwLine}`
}

/** 第 2 轮（topic）与第 1/3 轮的指导文案已外置（v0.19.0）：prompts/zh/dream-topic.md /
 *  dream-atomic.md / dream-project-summary.md，改文件下一次 dream 即生效。 */

/** 构造一轮 dream 指令消息（各轮共用头部：封存时间戳 + 时间戳规则）。 */
export function buildDreamMessage(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  T: number,
  rounds: DreamRound[],
  idx: number,
): ReturnType<typeof createUserMessage> {
  const round = rounds[idx]
  const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
  const lines: string[] = [
    `${DREAM_MARKER} ${lbl('dream.title')}`,
    '',
    ...resolveSlotText('dream-header', {
      timestamp: formatTime(T),
      idx: String(idx + 1),
      total: String(rounds.length),
      roundKind: lbl(`dream.round.${round.kind}`),
    }).split('\n'),
    '',
  ]
  if (round.kind === 'project-summary') {
    // 项目总结轮：不带条目列表——AI 自己逐个调 memory_project 看当前项目描述（用户拍板 2026-08-22）。
    lines.push(...resolveSlotText('dream-project-summary', { projects: (round.projects ?? []).join('、') }).split('\n'))
  } else {
    const kwLabel = lbl('dream.row.keywordsLabel')
    const noneLabel = lbl('dream.row.none')
    const groupsText = round.groups
      .map((g) => {
        const name = g.name === '' ? lbl('dream.groupUnlabeled') : g.name
        return `${lbl('dream.groupHeader', { name })}\n${g.rows.map((r) => formatRow(r, kwLabel, noneLabel)).join('\n')}`
      })
      .join('\n\n')
    // 列表块：有组 = 空行+组文本（组间空行）；空轮（topic 默认触发）= 换行+提示（对应指导 2）。
    const listBlock = round.groups.length === 0 ? `\n${lbl('dream.topic.empty')}` : `\n\n${groupsText}`
    lines.push(...resolveSlotText(round.kind === 'topic' ? 'dream-topic' : 'dream-atomic', { list: listBlock }).split('\n'))
  }
  return createUserMessage({ content: [{ type: 'text', text: lines.join('\n') }], source: PLUGIN_SOURCE })
}

// ── dream 任务状态（串行：同一时刻一个） ───────────────────────────────────

/** dream 租约：进行中任务的权威状态（落库，替换旧的模块级 currentDream + dream_pending 布尔）。
 *  owner/progress_at 组合成「租约」——progress_at 超时 = 主人已死，可补收尾；
 *  group_idx / T 落库后，推进/收尾不再依赖任何模块内存，跨实例、热重载、中止都安全。 */
interface DreamLease {
  owner: string
  started_at: number
  progress_at: number
  group_idx: number
  T: number
}

/** 租约超时：心跳按「组」刷新，LEASE 必须 > 单组最长处理时间。 */
const DREAM_LEASE_MS = 30 * 60_000
export { DREAM_LEASE_MS }

/** dream 连续失败上限（issue #36）：失败（turn error / 零进展中断）只释放重试，
 *  连续达上限才封存止损并 warn——既不让一次故障静默吞掉整窗记忆（旧 bug），
 *  也不让持续性故障变成无限重试烧 token。计数落 dream_meta（跨实例/重启共享），
 *  整理范围 T 变化自动重计，dream 收尾（finishDream）清零。 */
export const DREAM_MAX_ATTEMPTS = 3

const liveAgents = new Map<string, unknown>() // sessionId -> 顶层 agent（live 引用）

export function registerLiveAgent(agent: { session?: { header?: { id?: string; parentSession?: unknown } } }): void {
  const id = agent.session?.header?.id
  if (typeof id === 'string' && id.length > 0) liveAgents.set(id, agent)
}

/** 生成本次 dream 的 owner token（pid + 随机后缀，仅诊断用；推进/收尾不校验 owner）。 */
function newDreamOwner(): string {
  return `${process.pid}:${Math.random().toString(36).slice(2, 10)}`
}

/** 自动 dream 重复触发冷却期：dream 收尾后 6h 内，即使 last_event_time 被意外事件
 *  刷新（打点/压缩重注入/未来未知 bug），也绝不重复自动 dream。2026-09-05 猫猫拍板
 *  （原话大意：dream 轮之后标记失败、后面重复 dream 是最大烧钱风险，50 元 token 血训）
 *  ——他的方案是"检查会话最后一轮是否 memory 插件触发"，等价防御用 db 现成字段
 *  （last_dream_time）实现，免读会话文件。代价：用户真实活动后的自动 dream 最多
 *  推迟到收尾+6h（保守取舍）。手动触发不经此判定；error 重试不受影响
 *  （releaseDream 不写 last_dream_time）。 */
export const DREAM_RETRIGGER_COOLDOWN_MS = 6 * 3600_000

/** 扫描判定：窗口需要 dream 吗？ */
export function windowNeedsDream(w: { last_event_time: number; last_dream_time: number | null }, now = Date.now()): boolean {
  if (now - w.last_event_time > 24 * 3600_000) return false // 超过 24h 的旧窗口不碰
  const lastDream = w.last_dream_time ?? 0
  if (lastDream >= w.last_event_time) return false // 已 dream 过（收尾后无新活动）
  if (lastDream > 0 && now - lastDream < DREAM_RETRIGGER_COOLDOWN_MS) return false // 冷却期内不重复
  return true
}

/** dream 状态信号回调：'dreaming' = dream 开始（租约抢占成功），'dreamed' = 整理完成/收尾，
 *  'active' = 失败释放/重试间隙（去月亮；SSE 广播本就支持，issue #36 起恢复路径也会发）。 */
export type DreamStateCallback = (sessionId: string, state: 'dreaming' | 'dreamed' | 'active') => void

/**
 * 启动一个窗口的 dream（第 0 组）。agent 必须是该窗口的 live 顶层 agent。
 * 返回 false 表示无法启动（已有任务在跑 / 别处（含其他进程）正在 dream / 无记忆可整理）。
 * 防重复：DB 原子抢占 dream 租约（跨进程/重启一致）——抢占失败即不 start；
 * 抢占成功后即使本进程崩溃/被重载，下个检查周期也会按过期租约补收尾而不是重复 start。
 * 执行体：steer 主会话（组消息落主 log，turn-stopping 驱动推进）。
 */
/**
 * steer 兜底（2026-09-10）。dsh 0.1.5 起 agent 的 inbox 从内存对象（0.1.1 的
 * Inbox 在 agent 构造函数里构造，永不抛）改成 session projection：读不到
 * state 时 ReactLoopInbox.current() **直接抛错**（"cannot read inbox state:
 * its projection registration is not active"）。对进程内挂着、但投影未激活的
 * 会话（实测=headless/未被 GUI 进入的窗口）steer 就会抛；而 dream 的调用点跑在
 * setInterval 定时器里，未捕获异常即**整个 dsh 进程退出**——插件绝不能把宿主带崩。
 * 语义：steer 失败 = 这一组没送达，返回 false 交给调用方按"未启动"降级。
 * 该兜底对旧版本零影响（旧版永不抛，行为逐字节不变），因此不需要按版本号分支。
 */
function safeSteer(agent: unknown, msg: unknown, workspace: string, dir: string, tag: string): boolean {
  const steer = (agent as { steer?: (m: unknown) => void } | undefined)?.steer
  if (typeof steer !== 'function') return false
  try {
    steer.call(agent, msg)
    return true
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    dreamLog(`${tag} steer-failed err=${text}`)
    console.warn(`[meow-memory] ${tag}: agent.steer failed, dream skipped (${text})`)
    return false
  }
}

/**
 * 把 memory 任务消息送入「独立新轮」（2026-09-10 用户拍板）。
 *
 * 根因：steer() = inbox "next-step"——在 turn-stopping 里 steer 会让 turn 不结束
 * （agent-loop 的 turn 循环只在 nextStep 为空时收尾），memory 任务变成正常轮的
 * 延续 step。0.1.5 的 turn-process 折叠以「turn 最终答案」为界，memory 一延续，
 * AI 真正的工作汇报就被降级成中间步骤折叠进过程视图，且 memory 的行被过程视图
 * 收编、插件横条无从挂载。
 * followup() = inbox "next-turn"：turn 正常收尾（AI 汇报 = 本 turn 最终答案，
 * 保持展开可见），memory 以全新 turn 落盘。
 * 使用范围：reflect（单轮任务）与 dream 的第 0 组。dream 的后续组走 steer 连在
 * dream 自己的 turn 里（多组不分轮，一个 dream 任务一个 turn 一根横条）。
 * 兼容：followup 0.1.2 起即存在（agent.d.ts 三方法同款）；能力探测，缺失时回退
 * steer——旧宿主行为逐字节不变（继续走共享轮 + 旧折叠形状）。
 */
export function sendMemoryTurn(agent: unknown, msg: unknown, workspace: string, dir: string, tag: string): boolean {
  const followup = (agent as { followup?: (m: unknown) => void } | undefined)?.followup
  if (typeof followup !== 'function') return safeSteer(agent, msg, workspace, dir, tag)
  try {
    followup.call(agent, msg)
    return true
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    dreamLog(`${tag} followup-failed err=${text}`)
    console.warn(`[meow-memory] ${tag}: agent.followup failed, memory task skipped (${text})`)
    return false
  }
}

// ── dream 租约轮内心跳（2026-09-10）────────────────────────────────────────
// 心跳原本只在轮边界刷（advanceDreamLease 的 CAS 推进），LEASE=30min 必须 > 单组
// 最长处理时间；单组一旦超 30min（LLM 停顿/重试），扫描线程按过期租约判死收尾 →
// 剩余组永不 steered，但 UI 已广播 dreamed，且新租约可被立刻抢占并发双跑。
// 修法：dream 进行中每 60s touch 一次租约（只刷 progress_at，不动 group_idx）。
// 自愈：touchDreamLease 只 touch 活跃租约，收尾/释放/中止后 changes=0 自动停表；
// 进程死亡心跳随之消失，租约照常 30min 过期被 recoverInterruptedDream 接管——
// 死亡判定语义完全不变。HEARTBEAT_MAX_MS 封顶：极端挂死的组最多续 6h，之后放过期。
const DREAM_HEARTBEAT_MS = 60_000
const HEARTBEAT_MAX_MS = 6 * 3600_000
const dreamHeartbeats = new Map<string, { timer: ReturnType<typeof setInterval>; startedAt: number }>()

function armDreamHeartbeat(sessionId: string, workspace: string, dir: string): void {
  if (dreamHeartbeats.has(sessionId)) return // 一次 dream 只挂一个心跳（advanceDream 重入幂等）
  const startedAt = Date.now()
  const timer = setInterval(() => {
    const hb = dreamHeartbeats.get(sessionId)
    if (hb === undefined) return
    try {
      if (Date.now() - hb.startedAt > HEARTBEAT_MAX_MS || !getDb(workspace, dir).touchDreamLease(sessionId)) {
        stopDreamHeartbeat(sessionId) // 到封顶 或 租约已不在（收尾/释放/被别实例接管）→ 停表
      }
    } catch {
      stopDreamHeartbeat(sessionId) // 库已关（热重载 dispose）/瞬时锁错误：心跳退役，绝不带崩宿主
    }
  }, DREAM_HEARTBEAT_MS)
  // #60：心跳只为续租，不拖住宿主进程生命周期——未 unref 的定时器会让桌面端
  // graceful teardown 失败、进程退不出去。
  if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  dreamHeartbeats.set(sessionId, { timer, startedAt })
}

function stopDreamHeartbeat(sessionId: string): void {
  const hb = dreamHeartbeats.get(sessionId)
  if (hb === undefined) return
  dreamHeartbeats.delete(sessionId)
  clearInterval(hb.timer)
}

/** 停掉全部心跳（插件 dispose 调用；热重载不残留定时器）。 */
export function disposeDreamHeartbeats(): void {
  for (const sid of [...dreamHeartbeats.keys()]) stopDreamHeartbeat(sid)
}

export function startWindowDream(ctx: Context, agent: { session?: { header?: { id?: string } } }, workspace: string, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS): boolean {
  const sessionId = agent.session?.header?.id
  if (!sessionId) return false
  const db = getDb(workspace, dir)
  const rounds = collectDreamRounds(db, sessionId, workspace, dir, rulesReviewDays)
  if (rounds.length === 0) {
    // 无本窗口记忆（建立的 ∪ 提取过的都无）：也推进 last_dream_time（= 本窗口无可整理），避免 need=true 恒成立、每轮空扫到 24h
    db.finishDream(sessionId, Date.now())
    dreamLog(`dream skip-empty sid=${shortSessionId(sessionId)}`)
    onDreamState?.(sessionId, 'dreamed')
    return false
  }
  const win = db.getWindow(sessionId)
  // claimDream 的 INSERT OR IGNORE 会给新窗口行造出 last_event_time=0 哨兵，这里兜底 0
  const T = win && win.last_event_time > 0 ? win.last_event_time : Date.now()
  if (!db.claimDream(sessionId, newDreamOwner(), T, DREAM_LEASE_MS)) return false // 别处活跃租约未过期
  // 轮次计划快照（#69）：group_idx 是纯位置下标，advance 每轮重算 collectDreamRounds
  // 会让「整理中新建的记忆」改变 rounds 长度/顺序——索引漂移 = 重复 topic、跳过 atomic。
  // 快照后每条目标条目恰好被访问一次；整理中新建的记忆留给下一次 dream。
  db.setDreamMeta(`dreamplan:${sessionId}`, JSON.stringify(rounds))
  onDreamState?.(sessionId, 'dreaming')
  const msg = buildDreamMessage(db, sessionId, T, rounds, 0)
  if (!sendMemoryTurn(agent, msg, workspace, dir, `dream start sid=${shortSessionId(sessionId)}`)) {
    // 没送达：释放租约让下个周期自然重试，不把窗口卡在"进行中"。
    db.releaseDream(sessionId)
    return false
  }
  armDreamHeartbeat(sessionId, workspace, dir) // 轮内心跳：单组 >30min 不再被判死收尾
  // 0.32：显式/自动启动成功过一次 → 作废上下文超限冷却；跨窗口的旧记录不再挡后续自动整理。
  clearAutoDreamSkip(db, sessionId)
  dreamLog(`dream start pid=${process.pid} session=${shortSessionId(sessionId)} rounds=${rounds.length} T=${T}`)
  return true
}

/**
 * 推进：本窗口有进行中 dream → 下一组或收尾。
 * 状态完全从 DB 租约读：跨实例、热重载残留、中止都不影响推进正确性。
 * 推进按「sessionId + 租约未过期」判定，不校验 owner（owner 只用于抢占判断 + 诊断）。
 * 执行体：steer 主会话（由 turn-stopping 驱动进入，组消息落主 log）。
 * 后续组用 steer（next-step）连在 dream 自己的 turn 里（2026-09-10 用户拍板：
 * 多组不分轮——只有第 0 组经 sendMemoryTurn 另起 turn，整个 dream 任务一个
 * turn、一根折叠横条）；steer 失败同旧行为：租约 30min 过期自愈兜底。
 */
export function advanceDream(
  agent: unknown,
  dir = '.dsh-meow',
  onDreamState?: DreamStateCallback,
  rulesReviewDays: number = DEFAULT_RULES_REVIEW_DAYS,
  budget?: DreamBudget,
): void {
  const sessionId = (agent as { session?: { header?: { id?: string } } })?.session?.header?.id
  const ws = (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
  if (typeof sessionId !== 'string' || typeof ws !== 'string' || ws.length === 0) return
  const db = getDb(ws, dir)
  const lease = db.getDreamLease(sessionId)
  if (lease === null) return // 无进行中 dream（已收尾/未开始）：不动

  if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
    // 租约过期 = 主人已死：补收尾（不再推进），防止窗口永久 need=true 反复 start
    recoverInterruptedDream(db, sessionId, ws, dir)
    dreamLog(`advanceDream expired-recover sid=${shortSessionId(sessionId)}`)
    // 零进展释放（issue #36）≠ 整理完成：去月亮（active）而非加月亮（dreamed）；
    // 封存路径 last_dream_time 已置上，照旧 dreamed。
    const wAfter = db.getWindow(sessionId)
    onDreamState?.(sessionId, wAfter !== undefined && wAfter.last_dream_time !== null ? 'dreamed' : 'active')
    return
  }

  // 轮次计划 = start 时快照（#69）：不重算。快照缺失（升级瞬间旧 dream 在途 / meta
  // 丢失）回退重算，行为同旧版；正常路径下快照随 start 写入、随 finish/release 清理。
  const storedPlan = db.getDreamMeta(`dreamplan:${sessionId}`)
  const rounds: DreamRound[] = storedPlan !== undefined
    ? JSON.parse(storedPlan) as DreamRound[]
    : collectDreamRounds(db, sessionId, ws, dir, rulesReviewDays)
  const nextIdx = lease.group_idx + 1
  if (nextIdx < rounds.length) {
    // 0.32 review Q4：后续轮开跑前复查上下文大小（整理本身会变长）；超限提前收尾，
    // 不再把剩下的轮次继续喂进去（entry 未封存，下次有活动可重新整理）。
    const maxTokens = budgetNumber(budget?.dreamMaxContextTokens) ?? DREAM_DEFAULT_MAX_CONTEXT_TOKENS
    if (estimateContextTokens(agentSessionEvents(agent)).tokens > maxTokens) {
      try {
        db.finishDream(sessionId, Date.now())
      } catch {
        /* 收尾失败：租约过期自愈兜底 */
      }
      dreamLog(`dream early-finish context-oversize session=${shortSessionId(sessionId)} next=${nextIdx}/${rounds.length}`)
      onDreamState?.(sessionId, 'active')
      return
    }
    // CAS 推进：多实例同收 turn-stopping 时只有一个成功，其余跳过
    if (db.advanceDreamLease(sessionId, lease.group_idx, DREAM_LEASE_MS)) {
      armDreamHeartbeat(sessionId, ws, dir) // 热重载后新模块实例没有旧心跳：推进时补挂（幂等）
      const msg = buildDreamMessage(db, sessionId, lease.T, rounds, nextIdx)
      const tag = `dream group ${nextIdx + 1}/${rounds.length}`
      // 后续组用 steer（非 followup）：连在 dream 自己的 turn 里，多组不分轮
      if (safeSteer(agent, msg, ws, dir, tag)) dreamLog(`${tag} steered`)
    }
    return
  }
  // 最后一轮完成 → 收尾
  finalizeDream(db, sessionId, ws, dir, lease.T, 'done', rounds.length, onDreamState)
}

/** 收尾：封存全部条目（updated_at=T）+ 清租约 + 记 last_dream_time。失败不阻塞（日志兜底）。 */
function finalizeDream(db: ReturnType<typeof getDb>, sessionId: string, workspace: string, dir: string, T: number, reason: 'done' | 'aborted', groupsCount: number, onDreamState?: DreamStateCallback): void {
  stopDreamHeartbeat(sessionId) // 租约即清，心跳立刻退役（不等下一个 60s tick 自愈）
  try {
    const stamped = db.stampDream(sessionId, T)
    db.finishDream(sessionId, Date.now())
    db.logDream(
      `window dream ${reason}: ${shortSessionId(sessionId)} groups=${groupsCount} stamped=${stamped} T=${new Date(T).toISOString()}`,
      { before: undefined, after: undefined },
    )
    dreamLog(`dream ${reason} session=${shortSessionId(sessionId)} groups=${groupsCount} stamped=${stamped}`)
    onDreamState?.(sessionId, 'dreamed')
  } catch (e) {
    dreamLog(`dream ${reason} finish error: ${String(e)}`)
  }
}

/** dream 轮被用户停止（aborted/interrupted）：立即收尾，不再推进下一组。
 *  与旧 currentDream 不同——这里没有会卡死的内存态，收尾后 DB 租约即清。 */
export function abortDream(agent: unknown, dir = '.dsh-meow', onDreamState?: DreamStateCallback): void {
  const sessionId = (agent as { session?: { header?: { id?: string } } })?.session?.header?.id
  const ws = (agent as { session?: { header?: { cwd?: string } } })?.session?.header?.cwd
  if (typeof sessionId !== 'string' || typeof ws !== 'string' || ws.length === 0) return
  const db = getDb(ws, dir)
  const lease = db.getDreamLease(sessionId)
  if (lease === null) return // 没有进行中 dream
  finalizeDream(db, sessionId, ws, dir, lease.T, 'aborted', lease.group_idx + 1, onDreamState)
}

// ── 工具：memory_dream（手动触发本窗口 dream） ─────────────────────────────

export function dreamTool(ctx: Context, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays: number | (() => number) = DEFAULT_RULES_REVIEW_DAYS, workspaceDisabled?: (ws: string) => boolean): ToolDefinition {
  return {
    name: 'memory_dream',
    description: keyedValue('tools', 'memory_dream.description'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; note?: unknown }
        return [{ type: 'text' as const, text: v.ok ? `🧠 dream 已安排。${String(v.note ?? '')}` : `dream 未启动：${String(v.note ?? '')}` }]
      },
    },
    async execute(_args: unknown, exec: ToolRunContext) {
      const workspace = workspaceOf(exec)
      if (!workspace) throw new Error('memory_dream: 无法确定工作区（会话无 cwd）')
      if (!exec.agent) throw new Error('memory_dream: 无法确定当前 agent')
      if (isSubagentAgent(exec.agent)) {
        // 子代理没有独立记忆窗口：写记忆归属父窗口，dream 也归父窗口（2026-09-05
        // 猫猫拍板"主窗口主 session 负责 dream"）。子代理（历史 delegate fork 的
        // 或用户手动 fork 的）误调本工具（fork 播种父会话 turn，工具 schema 可见）在此拦下，不进
        // windows 表不留 dream 痕迹。/dream 命令同款守卫见 dreamCommandDefinition。
        return { ok: false, note: '当前是子代理会话，没有独立的记忆窗口；记忆整理归父窗口负责，无需（也不能）在此触发 dream。' }
      }
      // rulesReviewDays 双模式（issue #26 活配置）：数字（兼容旧调用/测试）或 getter
      //（注册期传入活读取 thunk，每次手动触发现读现用）。
      // 工作区停用（#28 硬开关）：手动触发也不放行（写了也进不去，白烧 token）。
      if (workspaceDisabled?.(workspace) === true) return { ok: false, note: '该工作区已停用记忆（disabledWorkspaces 名单）：dream 不可用。' }
      // 0.32（修 #49）：手动 dream 也要求一个活着的窗口 agent（本工具的手动入口天然满足；
      // 拿不到会话 id 说明宿主给的 agent 句柄不完整，明确拒绝，别伪装成"没有记忆"）。
      const sessionId = exec.agent.session?.header?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, note: '无法确定本窗口的会话 id（live agent 句柄不完整）：dream 需要一个活着的窗口。' }
      }
      // 0.32 安全闸（review P1）：dream 会读条目/项目名并喂给模型——未受信工作区库一律不整理。
      // 手动入口在本会话 pre-step 后触发（trust 已判定）；undefined 只可能是宿主/测试的
      // 非标准装配，按放行处理（真实会话不存在这条路径）；显式 foreign 必须拒绝。
      const trustManual = storeTrustOf(workspace, dir)
      if (trustManual !== undefined && !trustManual.trusted) {
        return { ok: false, note: '该工作区的记忆库未受信任（非本插件创建且未显式信任）：dream 已拒绝，避免把它库里的内容洗进模型。确认安全后设 security.trustWorkspaceMemory: true 并重载插件。' }
      }
      const rrd = typeof rulesReviewDays === 'function' ? rulesReviewDays() : rulesReviewDays
      const ok = startWindowDream(ctx, exec.agent, workspace, dir, onDreamState, rrd)
      if (ok) return { ok, note: '整理任务已在后台启动，会话流中的任务气泡会显示进度与完成状态。' }
      const lease = getDb(workspace, dir).getDreamLease(sessionId)
      return {
        ok,
        note: lease !== null
          ? '本窗口已有 dream 任务在进行中（或待补收尾）。'
          : '本窗口没有需要整理的记忆。',
      }
    },
    presentCall(): { card: 'generic'; title: string; kind: 'edit' } {
      // 0.2.1 的 ToolCallKind 没有 'write'（0.31.1 遗留编译不过），改用 'edit'。
      return { card: 'generic', title: 'memory_dream: 整理本窗口记忆', kind: 'edit' }
    },
  }
}

// ── 用户命令 /dream（dsh 命令平面） ─────────────────────────────────────────

/** dsh 命令平面（宿主 @deepseek-ai/dsh-commands）的最小结构视图：只声明本插件
 *  用到的成员，不 import 该包（保持零运行时依赖；实际类型由宿主运行时满足）。 */
interface DreamCommandAgent {
  session?: { header?: { id?: string; cwd?: string; origin?: unknown } }
}

export interface DreamCommandDefinition {
  readonly name: 'dream'
  readonly description: string
  readonly handler: (invocation: { agent?: DreamCommandAgent }) =>
    | { kind: 'success'; text?: string }
    | { kind: 'error'; text: string }
    | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
}

/**
 * /dream 用户命令定义（手动唤起本窗口 dream）：与 memory_dream 工具同语义——直接
 * startWindowDream，不吃峰时抑制、不吃空闲检查。结果映射：启动成功 → success；
 * 子代理会话 / 无 cwd / 无会话 id / 租约占用 / 无可整理记忆 → error（UI 按
 * command-error 明确提示未启动原因，不会把 /dream 发给模型）。
 * 注册由 index.ts 负责（ctx.get('commands') 可选服务 + 就绪重试 + ctx.effect 清理）。
 */
export function dreamCommandDefinition(ctx: Context, dir = '.dsh-meow', onDreamState?: DreamStateCallback, rulesReviewDays: number | (() => number) = DEFAULT_RULES_REVIEW_DAYS, workspaceDisabled?: (ws: string) => boolean): DreamCommandDefinition {
  return {
    name: 'dream',
    description: '手动唤起一次记忆整理（dream）：逐轮回顾本窗口建立/提取过的跨会话记忆并封存。与 memory_dream 工具相同，手动触发不受峰时抑制。',
    handler(invocation) {
      const agent = invocation?.agent
      if (!agent) return { kind: 'error', text: '/dream 无法确定当前窗口的会话。' }
      const header = agent.session?.header
      if (header?.origin === 'subagent') {
        return { kind: 'error', text: '/dream 只能在主会话使用：子代理没有独立的记忆窗口。' }
      }
      const workspace = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null
      if (workspace === null) {
        return { kind: 'error', text: '/dream 无法确定当前窗口的工作区（会话无 cwd）。' }
      }
      if (typeof header?.id !== 'string' || header.id.length === 0) {
        return { kind: 'error', text: '/dream 无法确定当前窗口的会话 id。' }
      }
      // rulesReviewDays 双模式（issue #26 活配置）：每次手动触发现读现用。
      if (workspaceDisabled?.(workspace) === true) {
        return { kind: 'error', text: '该工作区已停用记忆（disabledWorkspaces 名单）：/dream 不可用。' }
      }
      // 0.32 安全闸（review P1）：未受信库不整理（内容会进模型轮）。undefined = 本会话
      // pre-step 尚未判定（测试/非标准装配）放行；显式 foreign 拒绝。
      const trustCmd = storeTrustOf(workspace, dir)
      if (trustCmd !== undefined && !trustCmd.trusted) {
        return { kind: 'error', text: '该工作区的记忆库未受信任（非本插件创建且未显式信任）：/dream 已拒绝。确认安全后设 security.trustWorkspaceMemory: true 并重载插件。' }
      }
      const rrd = typeof rulesReviewDays === 'function' ? rulesReviewDays() : rulesReviewDays
      const ok = startWindowDream(ctx, agent, workspace, dir, onDreamState, rrd)
      if (ok) return { kind: 'success', text: '🧠 dream 已触发：整理任务已在后台运行，会话流中的任务气泡会显示进度与完成状态。' }
      const lease = getDb(workspace, dir).getDreamLease(header.id)
      return lease !== null
        ? { kind: 'error', text: '本窗口已有 dream 任务在进行中（或待补收尾），未重复启动。' }
        : { kind: 'error', text: '本窗口没有需要整理的记忆（本窗口建立/提取过的记忆为空）。' }
    },
  }
}

/** 补收尾被打断的 dream（start 过但没 done：进程重启/热重载/跨进程打断）。
 *  有进展（group_idx>0，前序组成果已落库）：照旧视为已完成——封存该窗口条目 +
 *  清 pending + 记 last_dream_time——不再重复 start。
 *  零进展（group_idx=0，一组都没推进——#36 的装配失败轮即此）：封存会让整窗记忆
 *  静默消失且永不重试。改为记失败计数后释放（下个检查周期自动重试；重试对新写入
 *  条目幂等——dedup 合并兜底）；连续失败达 DREAM_MAX_ATTEMPTS 才封存止损（warn
 *  留痕，不再无声）。
 *  @returns 封存（stamped）的条目数（释放路径返回 0；调用方如需区分「封存」与
 *  「释放」，看 windows.last_dream_time 是否被置上）。 */
export function recoverInterruptedDream(db: ReturnType<typeof getDb>, sessionId: string, workspace: string, dir = '.dsh-meow'): number {
  const lease = db.getDreamLease(sessionId)
  const w = db.getWindow(sessionId)
  const T = lease ? lease.T : w && w.last_event_time > 0 ? w.last_event_time : Date.now()
  const progressed = lease !== null && lease.group_idx > 0
  if (!progressed) {
    const fails = db.recordDreamFailure(sessionId, T)
    if (fails < DREAM_MAX_ATTEMPTS) {
      db.releaseDream(sessionId)
      dreamLog(`dream recovered zero-progress session=${shortSessionId(sessionId)} fails=${fails}/${DREAM_MAX_ATTEMPTS} -> released (retry next sweep)`)
      return 0
    }
    dreamLog(`dream recovered zero-progress session=${shortSessionId(sessionId)} fails=${fails} -> sealed (cap reached)`)
    console.warn(`[meow-memory] dream 连续失败 ${fails} 次后中断（窗口 ${shortSessionId(sessionId)}），按封存收尾不再自动重试；该窗口正常对话产生新活动后可重新自动整理，或手动 /dream`)
  }
  const stamped = db.stampDream(sessionId, T)
  db.finishDream(sessionId, Date.now())
  db.logDream(
    `window dream recovered (interrupted): ${shortSessionId(sessionId)} stamped=${stamped} T=${new Date(T).toISOString()}`,
    { before: undefined, after: undefined },
  )
  dreamLog(`dream recovered session=${shortSessionId(sessionId)} stamped=${stamped}`)
  return stamped
}

/** dream 轮以 turn/end error 收尾的即时处理（issue #36 建议二；session/event 订阅侧调用）。
 *  宿主只在「某个 step 成功完成后」才发 agent/turn-stopping（dsh-agent-loop turn 循环
 *  内唯一发射点，发射时本轮 turn/end 还没落日志），首个 step 之前的失败（空 options
 *  装配抛错、pre-step reject 等）永远走不到 turn-stopping——旧 turn-stopping error
 *  分支对这类失败是死代码，租约只能等 6h 心跳封顶后被盖章。turn/end 事件在宿主
 *  catch/finally 里必然落盘，是可靠的失败信号。
 *  语义：有租约 = 失败计数 +1 后释放（下个检查周期自动重试）；连续达 DREAM_MAX_ATTEMPTS
 *  封存止损（warn）。无租约（reflect 轮失败等）不动。
 *  @returns 'released'（已释放待重试）/ 'sealed'（达上限封存）/ 'none'（无租约，非 dream）。 */
export function handleMemoryTurnFailure(db: ReturnType<typeof getDb>, sessionId: string, workspace: string, dir = '.dsh-meow'): 'released' | 'sealed' | 'none' {
  stopDreamHeartbeat(sessionId) // 无害：无心跳时空操作；有则立刻退役（release 后 touch 必 changes=0）
  const lease = db.getDreamLease(sessionId)
  if (lease === null) return 'none'
  const fails = db.recordDreamFailure(sessionId, lease.T)
  if (fails >= DREAM_MAX_ATTEMPTS) {
    const stamped = db.stampDream(sessionId, lease.T)
    db.finishDream(sessionId, Date.now())
    dreamLog(`dream turn-failed cap sid=${shortSessionId(sessionId)} fails=${fails} -> sealed (stamped=${stamped})`)
    console.warn(`[meow-memory] dream 轮连续失败 ${fails} 次（窗口 ${shortSessionId(sessionId)}），已封存不再自动重试；详见 dream-debug.log`)
    return 'sealed'
  }
  db.releaseDream(sessionId)
  dreamLog(`dream turn-failed sid=${shortSessionId(sessionId)} fails=${fails}/${DREAM_MAX_ATTEMPTS} -> released (retry next sweep)`)
  return 'released'
}

// ── Phase 2 Round 2：隔离 dream（spawn 子代理，主会话模型上下文零增长）──────────
//
// 设计见 research/fork-phase2-dream-spike.md §7：自动 dream 交给 ctx.get('subagents')
// 的 spawn provider 在**空上下文**子会话里执行——子会话自己调 memory_* 工具写库，
// 父会话只有一条 log-only subagent/catalog 事实（模型不可见），因此 dream 不再把
// 3 轮全上下文 + 8–15k 输入/输出留在主会话里。任何能力缺失/失败都退回现有主窗口
// dream（startWindowDream），绝不阻塞窗口整理。
//
// 约定（宿主 @deepseek-ai/dsh-subagent Contract，结构视图，不 import 该包）：
// - startActivation({provider,label,delivery,signal,request}) → {childId,result,dispose}
// - delivery:'caller' = 不向父会话发完成通知；result settle 后自行收集
// - provider.inheritsParentContext 必须为 false（spawn 空上下文；fork 会播种父对话）
// - 子会话继承父 preset 与 cwd，memory_* 工具（host 级注册）可用；子代理链路已被
//   pre-step/turn-stopping/memory_dream 守卫跳过，不会递归 dream。

/** 宿主 subagent provider 的结构视图（只声明本插件用到的成员）。 */
export interface SubagentProviderLike {
  readonly name?: string
  readonly inheritsParentContext?: boolean
  readonly capabilities?: { readonly depthLimit?: boolean; readonly agentOptions?: boolean }
}

export interface SubagentResultLike {
  readonly stopReason?: string
  readonly output?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>
  readonly diagnostic?: string
}

export interface SubagentActivationLike {
  readonly childId?: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void> | void
}

export interface SubagentActivationSpecLike {
  readonly provider: string
  readonly label: string
  readonly delivery: 'parent' | 'caller'
  readonly signal: AbortSignal
  readonly request: {
    readonly cwd?: string
    readonly parent: unknown
    readonly prompt: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
    readonly agentOptions?: { readonly provider?: string; readonly model?: string }
    readonly outputSchema?: unknown
    readonly maxDepth?: number
  }
}

export interface SubagentsLike {
  getProvider?: (name: string) => SubagentProviderLike | undefined
  startActivation?: (spec: SubagentActivationSpecLike) => Promise<SubagentActivationLike>
}

/** dreamiso:<sid> 的 meta 键前缀（跨进程/重启可见的“隔离任务在途”标记，诊断用）。 */
export const ISOLATED_DREAM_META_PREFIX = 'dreamiso:'
export const ISOLATED_DEFAULT_TIMEOUT_MINUTES = 20
export const ISOLATED_DEFAULT_MAX_PROMPT_CHARS = 20_000
/** 对话摘录最多回看的事件条数（近期优先；不读 tool/result，成本有界）。 */
const ISOLATED_DIGEST_MAX_EVENTS = 200

interface IsolatedDreamRun {
  readonly activation: SubagentActivationLike
  readonly childId: string | undefined
  readonly db: ReturnType<typeof getDb>
  readonly sessionId: string
  readonly controller: AbortController
}

/** 进程内在途隔离 dream（disposeIsolatedDreams / 防重入用）。 */
const isolatedDreams = new Map<string, IsolatedDreamRun>()

interface PendingIsolatedStart {
  readonly controller: AbortController
  readonly db: ReturnType<typeof getDb>
  readonly sessionId: string
}

/** 已抢租约、activation 尚未发布的启动（dispose/HMR 时也要释放，避免僵尸租约）。 */
const pendingIsolatedStarts = new Map<string, PendingIsolatedStart>()

/** 隔离能力缺失的日志去重（每进程一次，避免 15min/轮刷屏）。 */
let isolatedUnavailableLogged = false

/** 从插件 ctx 解析 subagents 服务（ctx.get 缺失/抛错一律 undefined → 主窗口 dream 兜底）。 */
function subagentsOf(ctx: Context): SubagentsLike | undefined {
  try {
    return (ctx as { get?: (name: string) => unknown }).get?.('subagents') as SubagentsLike | undefined
  } catch {
    return undefined
  }
}

/** 隔离 dream 是否可用：服务 + provider + 必须是“空上下文”provider（spawn，非 fork）。 */
export function isolatedDreamAvailable(ctx: Context, cfg: DreamConfig | undefined): boolean {
  const svc = subagentsOf(ctx)
  if (svc === undefined || typeof svc.startActivation !== 'function' || typeof svc.getProvider !== 'function') return false
  const provider = svc.getProvider(cfg?.isolatedProvider ?? 'spawn')
  return provider !== undefined && provider.inheritsParentContext === false
}

/** budget.isolatedTimeoutMinutes（默认 20 分钟；非法回默认）。 */
export function isolatedDreamTimeoutMinutes(cfg: DreamConfig | undefined): number {
  const v = budgetNumber(cfg?.isolatedTimeoutMinutes)
  return v !== undefined && v > 0 ? v : ISOLATED_DEFAULT_TIMEOUT_MINUTES
}

/** budget.isolatedMaxPromptChars（默认 20000 字符；非法回默认）。 */
export function isolatedDreamMaxPromptChars(cfg: DreamConfig | undefined): number {
  const v = budgetNumber(cfg?.isolatedMaxPromptChars)
  return v !== undefined && v >= 2000 ? v : ISOLATED_DEFAULT_MAX_PROMPT_CHARS
}

/**
 * 生成父会话最近对话摘录（隔离 dream 的上下文替代品）：
 * 只取 user/assistant 的**文本**与 assistant 调用过的**工具名**，绝不带 tool/result 内容；
 * 从最新事件向前累积到 maxChars，按时间正序输出。插件自身指令消息（source.kind=plugin）
 * 跳过，避免把历史 dream/reflect 标记回灌。
 */
export function buildIsolatedDigest(events: readonly unknown[], maxChars = 12_000): string {
  const budget = Math.max(0, Math.floor(maxChars))
  if (budget === 0 || events.length === 0) return ''
  const lines: string[] = []
  let used = 0
  const first = Math.max(0, events.length - ISOLATED_DIGEST_MAX_EVENTS)
  for (let i = events.length - 1; i >= first && used < budget; i--) {
    const e = events[i] as {
      type?: string
      data?: {
        source?: { kind?: string; plugin?: string }
        content?: Array<{ type?: string; text?: string }>
        message?: { content?: Array<{ type?: string; name?: string; text?: string }> }
      }
    }
    let line: string | undefined
    if (e?.type === 'user/message') {
      if (e.data?.source?.kind === 'plugin') continue
      const text = (e.data?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => (b.text ?? '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0)
        .join(' ')
      if (text.length === 0) continue
      line = `user: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`
    } else if (e?.type === 'assistant/message') {
      const texts: string[] = []
      const tools: string[] = []
      for (const b of e.data?.message?.content ?? []) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
          texts.push(b.text.replace(/\s+/g, ' ').trim())
        } else if (b.type === 'tool-call' && typeof b.name === 'string' && b.name.length > 0) {
          tools.push(b.name)
        }
      }
      const text = texts.join(' ')
      if (text.length === 0 && tools.length === 0) continue
      line = `assistant: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}${tools.length > 0 ? `${text.length > 0 ? ' ' : ''}[tools: ${tools.join(', ')}]` : ''}`.trim()
    } else {
      continue // tool/result、turn/step 等一律不进摘录（工具结果可能很大，且含原始输出）
    }
    if (used + line.length + 1 > budget) {
      const room = budget - used - 1
      if (room > 40) lines.unshift(`${line.slice(0, room)}…`)
      break
    }
    lines.unshift(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/**
 * 构造隔离 dream 的**单条**子代理 prompt：拼接既有 prompt 槽（dream-header /
 * dream-atomic / dream-topic / dream-project-summary）+ 对话摘录 + 截断后的条目清单。
 * 不新增 prompt 文件；超 budget.isolatedMaxPromptChars 时按「最旧条目 → 项目 →
 * 摘录头部 → 硬截断」顺序丢弃，保证 token 有上界。
 */
export function buildIsolatedDreamPrompt(
  db: ReturnType<typeof getDb>,
  rounds: DreamRound[],
  T: number,
  digest: string,
  maxChars = ISOLATED_DEFAULT_MAX_PROMPT_CHARS,
): { text: string; truncated: boolean } {
  // db 保留形参：与 buildDreamMessage/startWindowDream 同签名，便于测试与后续按库裁剪。
  void db
  const cap = Math.max(2000, Math.floor(maxChars))
  const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)
  const kwLabel = lbl('dream.row.keywordsLabel')
  const noneLabel = lbl('dream.row.none')
  const atomic = rounds.find((r) => r.kind === 'atomic')
  const topic = rounds.find((r) => r.kind === 'topic')
  const project = rounds.find((r) => r.kind === 'project-summary')
  let atomicRows: MemoryRow[] = atomic === undefined ? [] : atomic.groups.flatMap((g) => g.rows)
  let topicRows: MemoryRow[] = topic === undefined ? [] : topic.groups.flatMap((g) => g.rows)
  let projects: string[] = project?.projects === undefined ? [] : [...project.projects]
  let digestText = digest
  let truncated = false

  const groupsText = (rows: MemoryRow[]): string =>
    groupByProject(rows)
      .map((g) => {
        const name = g.name === '' ? lbl('dream.groupUnlabeled') : g.name
        return `${lbl('dream.groupHeader', { name })}\n${g.rows.map((r) => formatRow(r, kwLabel, noneLabel)).join('\n')}`
      })
      .join('\n\n')

  const assemble = (): string => {
    const parts: string[] = [`${DREAM_MARKER} ${lbl('dream.title')}`, '']
    parts.push(...resolveSlotText('dream-header', {
      timestamp: formatTime(T),
      idx: '1',
      total: '3',
      roundKind: lbl('dream.round.atomic'),
    }).split('\n'))
    if (atomicRows.length > 0) {
      parts.push('', ...resolveSlotText('dream-atomic', { list: `\n\n${groupsText(atomicRows)}` }).split('\n'))
    }
    parts.push('', ...resolveSlotText('dream-topic', {
      list: topicRows.length === 0 ? `\n${lbl('dream.topic.empty')}` : `\n\n${groupsText(topicRows)}`,
    }).split('\n'))
    if (projects.length > 0) {
      parts.push('', ...resolveSlotText('dream-project-summary', { projects: projects.join('、') }).split('\n'))
    }
    if (digestText.length > 0) parts.push('', '---', digestText)
    return parts.join('\n')
  }

  /** 丢弃清单里最旧的一条（atomic/topic 合并按 updated_at 升序）。 */
  const dropOldestRow = (): boolean => {
    const candidates: Array<{ kind: 'atomic' | 'topic'; index: number; at: number }> = []
    atomicRows.forEach((r, index) => candidates.push({ kind: 'atomic', index, at: r.updated_at }))
    topicRows.forEach((r, index) => candidates.push({ kind: 'topic', index, at: r.updated_at }))
    if (candidates.length === 0) return false
    candidates.sort((a, b) => a.at - b.at)
    const victim = candidates[0]
    if (victim.kind === 'atomic') atomicRows = atomicRows.filter((_, i) => i !== victim.index)
    else topicRows = topicRows.filter((_, i) => i !== victim.index)
    return true
  }

  let text = assemble()
  while (text.length > cap) {
    truncated = true
    if (dropOldestRow()) {
      text = assemble()
      continue
    }
    if (projects.length > 0) {
      projects = projects.slice(0, -1)
      text = assemble()
      continue
    }
    if (digestText.length > 0) {
      const keep = Math.max(0, digestText.length - (text.length - cap) - 1)
      digestText = keep > 0 ? digestText.slice(digestText.length - keep) : ''
      text = assemble()
      if (text.length <= cap) break
      if (digestText.length === 0) { text = text.slice(0, cap); break }
      continue
    }
    text = text.slice(0, cap)
    break
  }
  return { text, truncated }
}

/** 隔离 dream 的失败路径：沿用主路径的失败计数/释放/封存语义（DREAM_MAX_ATTEMPTS）。 */
function recordIsolatedFailure(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  T: number,
  reason: string,
  onDreamState?: DreamStateCallback,
): void {
  stopDreamHeartbeat(sessionId)
  const fails = db.recordDreamFailure(sessionId, T)
  if (fails >= DREAM_MAX_ATTEMPTS) {
    const stamped = db.stampDream(sessionId, T)
    db.finishDream(sessionId, Date.now())
    db.logDream(
      `isolated dream failed (${reason}): ${shortSessionId(sessionId)} fails=${fails} sealed stamped=${stamped}`,
      { before: undefined, after: undefined },
    )
    dreamLog(`isolated-dream sealed session=${shortSessionId(sessionId)} reason=${reason} fails=${fails}/${DREAM_MAX_ATTEMPTS} stamped=${stamped}`)
    console.warn(`[meow-memory] 隔离 dream 连续失败 ${fails} 次（窗口 ${shortSessionId(sessionId)}），按封存止损；该窗口可手动 /dream`)
    onDreamState?.(sessionId, 'dreamed')
    return
  }
  db.releaseDream(sessionId)
  db.logDream(
    `isolated dream failed (${reason}): ${shortSessionId(sessionId)} fails=${fails} released`,
    { before: undefined, after: undefined },
  )
  dreamLog(`isolated-dream released session=${shortSessionId(sessionId)} reason=${reason} fails=${fails}/${DREAM_MAX_ATTEMPTS} (retry next sweep)`)
  onDreamState?.(sessionId, 'active')
}

/** 子代理 activation 已发布后的异步执行体：收集结果 → 收养条目 → 收尾/失败。 */
async function runIsolatedDream(
  ctx: Context,
  db: ReturnType<typeof getDb>,
  sessionId: string,
  workspace: string,
  dir: string,
  cfg: DreamConfig,
  activation: SubagentActivationLike,
  controller: AbortController,
  T: number,
  timeoutMinutes: number,
  promptChars: number,
  promptTruncated: boolean,
  onDreamState?: DreamStateCallback,
): Promise<void> {
  const sid = shortSessionId(sessionId)
  const childId = typeof activation.childId === 'string' && activation.childId.length > 0 ? activation.childId : undefined
  const entry: IsolatedDreamRun = {
    activation,
    childId,
    db,
    sessionId,
    controller,
  }
  isolatedDreams.set(sessionId, entry)
  try {
    db.setDreamMeta(ISOLATED_DREAM_META_PREFIX + sessionId, JSON.stringify({ at: Date.now(), T, childId: childId ?? null }))
  } catch {
    /* meta 失败不阻塞 */
  }
  armDreamHeartbeat(sessionId, workspace, dir)
  onDreamState?.(sessionId, 'dreaming')
  dreamLog(`isolated-dream start sid=${sid} child=${childId === undefined ? '?' : shortSessionId(childId)} chars=${promptChars}${promptTruncated ? ' truncated' : ''}`)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    // 允许小数分钟（测试可注入极短超时；生产 schema 最小 1 分钟）。
    timer = setTimeout(() => resolve('timeout'), Math.max(1, Math.round(Math.max(0, timeoutMinutes) * 60_000)))
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
  })
  type RaceOutcome = { kind: 'result'; result: SubagentResultLike } | { kind: 'error'; error: unknown } | 'timeout'
  let outcome: RaceOutcome
  try {
    const resultPromise = activation?.result
    if (resultPromise === undefined || resultPromise === null || typeof (resultPromise as { then?: unknown }).then !== 'function') {
      outcome = { kind: 'error', error: new Error('activation.result is missing') }
    } else {
      const settlement = resultPromise
        .then((result): RaceOutcome => ({ kind: 'result', result }))
        .catch((error: unknown): RaceOutcome => ({ kind: 'error', error }))
      outcome = await Promise.race([settlement, timeout])
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  try {
    // 插件 dispose/HMR 已接管（release 视同完成）：本回调查账即可，不再二次改库。
    if (isolatedDreams.get(sessionId) !== entry) return
    // 收养放在结果判定之前：子代理可能已经写了一半记忆（max-tokens/error 也保留成果），
    // 收归父窗口后下一轮 dream/封存都能看到，绝不把半成品挂在子会话名下变孤儿。
    let adopted = 0
    if (childId !== undefined) {
      try {
        adopted = db.adoptSessionEntries(childId, sessionId)
      } catch (e) {
        dreamLog(`isolated-dream adopt-failed child=${shortSessionId(childId)} err=${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (outcome !== 'timeout' && outcome.kind === 'result' && outcome.result?.stopReason === 'completed') {
      finalizeDream(db, sessionId, workspace, dir, T, 'done', 1, onDreamState)
      clearAutoDreamSkip(db, sessionId)
      dreamLog(`isolated-dream done sid=${sid} child=${childId === undefined ? '?' : shortSessionId(childId)} adopted=${adopted}${promptTruncated ? ' truncated' : ''}`)
      return
    }
    const reason = outcome === 'timeout'
      ? 'timeout'
      : outcome.kind === 'error'
        ? `error: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
        : String(outcome.result?.stopReason ?? 'unknown')
    if (outcome === 'timeout') {
      try {
        entry.controller.abort()
        await activation.dispose()
      } catch {
        /* 超时取消失败：失败计数已足够 */
      }
    }
    dreamLog(`isolated-dream failed sid=${sid} reason=${reason} adopted=${adopted}`)
    recordIsolatedFailure(db, sessionId, T, reason, onDreamState)
  } finally {
    if (isolatedDreams.get(sessionId) === entry) isolatedDreams.delete(sessionId)
    try {
      db.delDreamMeta(ISOLATED_DREAM_META_PREFIX + sessionId)
    } catch {
      /* 清理失败不阻塞 */
    }
    try {
      await activation.dispose()
    } catch {
      /* dispose 失败不阻塞收尾 */
    }
    if (cfg.isolatedArchiveChild !== false && childId !== undefined) {
      try {
        const registry = (ctx as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
          | { archiveSession?: (id: string) => unknown }
          | undefined
        registry?.archiveSession?.(childId)
      } catch {
        /* 归档失败不阻塞 */
      }
    }
  }
}

/**
 * 启动隔离 dream（同步返回，子代理异步执行）：
 * 1) 成本闸已在 dreamSweepOnce 过完；这里先原子抢租约（跨实例串行）
 * 2) startActivation(provider, delivery:'caller') 起空上下文子代理；发布后记 meta/心跳/广播
 * 3) 结果 settle：completed → 收养子会话条目 + finalizeDream；其余/超时 → 失败计数 + 释放
 * @returns 'started' 已接管；'unavailable' 能力缺失（调用方退回主窗口 dream）；
 *          'rejected' 租约被占/启动瞬态失败（下个 sweep 重试，不要同轮双跑主路径）。
 */
export function startIsolatedDream(
  ctx: Context,
  agent: unknown,
  db: ReturnType<typeof getDb>,
  sessionId: string,
  workspace: string,
  dir: string,
  cfg: DreamConfig,
  rounds: DreamRound[],
  T: number,
  onDreamState?: DreamStateCallback,
): 'started' | 'unavailable' | 'rejected' {
  const sid = shortSessionId(sessionId)
  const svc = subagentsOf(ctx)
  const providerName = cfg.isolatedProvider ?? 'spawn'
  const provider = svc?.getProvider?.(providerName)
  if (svc === undefined || typeof svc.startActivation !== 'function' || provider === undefined || provider.inheritsParentContext !== false) {
    return 'unavailable'
  }
  if (isolatedDreams.has(sessionId)) return 'rejected' // 本进程已有隔离任务在途
  const promptCap = isolatedDreamMaxPromptChars(cfg)
  let prompt: { text: string; truncated: boolean }
  try {
    const digest = buildIsolatedDigest(agentSessionEvents(agent), Math.max(2000, Math.floor(promptCap * 0.45)))
    prompt = buildIsolatedDreamPrompt(db, rounds, T, digest, promptCap)
  } catch (e) {
    // prompt 槽缺失/文案层异常：不抢租约、不阻塞扫描（主窗口路径同样会缺文案，直接下轮）
    dreamLog(`isolated-dream prompt-failed sid=${sid} err=${e instanceof Error ? e.message : String(e)}`)
    return 'rejected'
  }
  if (!db.claimDream(sessionId, newDreamOwner(), T, DREAM_LEASE_MS)) return 'rejected'
  try {
    db.setDreamMeta(ISOLATED_DREAM_META_PREFIX + sessionId, JSON.stringify({ at: Date.now(), T, provider: providerName, childId: null }))
  } catch {
    /* meta 失败不阻塞（dreamiso 只是诊断标记） */
  }
  const controller = new AbortController()
  const timeoutMinutes = isolatedDreamTimeoutMinutes(cfg)
  const pending: PendingIsolatedStart = { controller, db, sessionId }
  pendingIsolatedStarts.set(sessionId, pending)
  let startPromise: Promise<SubagentActivationLike>
  try {
    startPromise = svc.startActivation({
      provider: providerName,
      label: `memory-dream ${sid}`,
      delivery: 'caller',
      signal: controller.signal,
      request: {
        cwd: workspace,
        parent: agent,
        prompt: [{ type: 'text', text: prompt.text }],
        ...(cfg.isolatedModelSpec !== undefined ? { agentOptions: cfg.isolatedModelSpec } : {}),
        ...(provider.capabilities?.depthLimit === true ? { maxDepth: 0 } : {}),
      },
    })
    if (startPromise === undefined || startPromise === null || typeof (startPromise as { then?: unknown }).then !== 'function') {
      throw new Error('startActivation did not return a promise')
    }
  } catch (e) {
    if (pendingIsolatedStarts.get(sessionId) === pending) pendingIsolatedStarts.delete(sessionId)
    try {
      db.delDreamMeta(ISOLATED_DREAM_META_PREFIX + sessionId)
      db.releaseDream(sessionId)
    } catch {
      /* 释放失败：租约 30min 过期自愈 */
    }
    dreamLog(`isolated-dream start-failed sid=${sid} provider=${providerName} err=${e instanceof Error ? e.message : String(e)}`)
    onDreamState?.(sessionId, 'active')
    return 'rejected'
  }
  void Promise.resolve(startPromise).then(
    (activation) => {
      if (pendingIsolatedStarts.get(sessionId) !== pending) {
        // 启动期间插件已 dispose：取消这个迟到的子代理，不再改库（租约已被 dispose 释放）。
        pendingIsolatedStarts.delete(sessionId)
        try {
          void Promise.resolve(activation.dispose()).catch(() => {})
        } catch {
          /* ignore */
        }
        return
      }
      pendingIsolatedStarts.delete(sessionId)
      void runIsolatedDream(ctx, db, sessionId, workspace, dir, cfg, activation, controller, T, timeoutMinutes, prompt.text.length, prompt.truncated, onDreamState)
        .catch((error: unknown) => {
          // 兜底：隔离执行体自身异常也不能留僵尸租约/心跳（30min 自愈之前就清掉）。
          try {
            db.delDreamMeta(ISOLATED_DREAM_META_PREFIX + sessionId)
            db.releaseDream(sessionId)
          } catch {
            /* 租约自愈兜底 */
          }
          stopDreamHeartbeat(sessionId)
          dreamLog(`isolated-dream crashed sid=${sid} err=${error instanceof Error ? error.message : String(error)}`)
          onDreamState?.(sessionId, 'active')
        })
    },
    (error: unknown) => {
      // 启动瞬态失败（容量/鉴权/provider 拒绝）：不记失败次数，释放租约等下一轮。
      if (pendingIsolatedStarts.get(sessionId) === pending) pendingIsolatedStarts.delete(sessionId)
      try {
        db.delDreamMeta(ISOLATED_DREAM_META_PREFIX + sessionId)
        db.releaseDream(sessionId)
      } catch {
        /* 释放失败：租约自愈 */
      }
      dreamLog(`isolated-dream start-rejected sid=${sid} provider=${providerName} err=${error instanceof Error ? error.message : String(error)}`)
      onDreamState?.(sessionId, 'active')
    },
  )
  return 'started'
}

/**
 * 插件 dispose/HMR 清理：取消所有在途隔离 dream、释放租约、清 meta、停心跳（绝不留
 * 30min 僵尸租约堵住后续自动整理）。子代理 settle 回调会检测到自己已被接管并跳过改库。
 */
export function disposeIsolatedDreams(): void {
  const runs = [...isolatedDreams.values()]
  isolatedDreams.clear()
  const pendings = [...pendingIsolatedStarts.values()]
  pendingIsolatedStarts.clear()
  for (const pending of pendings) {
    try {
      pending.controller.abort()
    } catch {
      /* ignore */
    }
    try {
      pending.db.delDreamMeta(ISOLATED_DREAM_META_PREFIX + pending.sessionId)
      pending.db.releaseDream(pending.sessionId)
    } catch {
      /* 库已关/热重载：租约过期自愈 */
    }
    stopDreamHeartbeat(pending.sessionId)
  }
  for (const run of runs) {
    stopDreamHeartbeat(run.sessionId)
    try {
      run.controller.abort()
    } catch {
      /* ignore */
    }
    try {
      run.db.delDreamMeta(ISOLATED_DREAM_META_PREFIX + run.sessionId)
      run.db.releaseDream(run.sessionId)
    } catch {
      /* 库已关/热重载：租约过期自愈 */
    }
    try {
      void Promise.resolve(run.activation.dispose()).catch(() => {})
    } catch {
      /* dispose 失败不阻塞 dispose 链 */
    }
  }
}

// ── 定时器 ──────────────────────────────────────────────────────────────────

export interface DreamConfig {
  enabled: boolean
  /** 窗口空闲多少分钟后允许 dream（用户拍板 2026-08-19：3 小时 = 180 分钟）。 */
  idleMinutes: number
  checkMinutes: number
  /** 抑制时段（目标时区，"HH:MM-HH:MM"）：这些时段内不触发 dream。
   *  默认=API 峰谷电价峰时（09:00–12:00、14:00–18:00）。 */
  suppressWindows: Array<{ start: string; end: string }>
  /** 每个抑制时段开始前追加的不触发分钟数（峰时前 15 分钟也不触发）。 */
  suppressLeadMinutes: number
  /** 抑制时段按此时区计算（默认 Asia/Shanghai——用户系统是美区时间，系统时区会算错）。 */
  timeZone: string
  /** rules 防 churn：updated_at 距今超该天数的稳定准则不进 dream 第 1 轮清单（0=不过滤，默认 2）。 */
  rulesReviewDays: number
  /** 0.32（修 #49）：自动 dream 只接受 live agent（默认 true）。设为 false 也**不会**
   *  恢复冷启动 resume——冷恢复路径已整体删除；该字段保留为显式部署意图 + 诊断日志。
   *  手动 /dream、memory_dream 始终要求 live agent（调用即意味着窗口活着）。 */
  requireLiveAgent?: boolean
  /** 0.32 成本预算（Lead 从 resolved.budget 传入；缺省按 0.32 出厂默认）。 */
  budget?: DreamBudget
  /** Phase 2 Round 2：自动 dream 交给 spawn 子代理在空上下文里执行（主会话模型可见
   *  上下文零增长）。默认 false；服务/provider 不可用或被拒时自动退回主窗口 dream。
   *  手动 /dream、memory_dream 始终走主窗口路径（用户可看进度/可中止）。 */
  isolated?: boolean
  /** 隔离执行使用的 subagent provider 名（默认 'spawn'；需 inheritsParentContext===false）。 */
  isolatedProvider?: string
  /** 子代理超时分钟数（默认 20；超时 dispose 并按失败计数处理）。 */
  isolatedTimeoutMinutes?: number
  /** 单条子代理 prompt 字符上限（默认 20000；超限按最旧条目→项目→摘录顺序截断）。 */
  isolatedMaxPromptChars?: number
  /** 子代理 settle 后归档其会话（默认 true；origin=subagent 会话本就不进图形侧栏）。 */
  isolatedArchiveChild?: boolean
  /** 隔离 dream 子代理的 agentOptions（Lead 从 delegate.model 传入；缺省继承父 route）。 */
  isolatedModelSpec?: { provider?: string; model?: string }
}

/** rulesReviewDays 的单一默认来源（已抽到 defaults.ts，与 client 设置页「恢复默认」共用）：
 *  zod schema / resolveConfig 兜底 / 各运行时函数默认参数统一引用此处。 */
export { DEFAULT_RULES_REVIEW_DAYS }

/** 取指定时区的当前小时（Intl 支持；无效时区回退系统时区）。 */
export function hourInTimeZone(timeZone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).formatToParts(date)
    const h = parts.find((p) => p.type === 'hour')?.value
    if (h !== undefined) return parseInt(h, 10) % 24
  } catch {
    /* 无效时区 */
  }
  return date.getHours()
}

/** 取指定时区的当前分钟（0-1439，日内的分钟数；无效时区回退系统时区）。
 *  峰时抑制按分钟粒度判断（含 lead 前推，小时粒度不够）。 */
export function minutesInTimeZone(timeZone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(date)
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? 'NaN', 10)
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? 'NaN', 10)
    if (!Number.isNaN(h) && !Number.isNaN(m)) return (h % 24) * 60 + m
  } catch {
    /* 无效时区 */
  }
  const d = new Date(date)
  return d.getHours() * 60 + d.getMinutes()
}

/** 解析 "HH:MM" → 日内分钟数；非法返回 null。 */
function parseMinute(hhmm: string): number | null {
  const mm = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!mm) return null
  const h = parseInt(mm[1], 10)
  const m = parseInt(mm[2], 10)
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/** 当前时刻是否处于 dream 抑制时段（用户拍板 2026-08-19）：
 *  suppressWindows 内（默认北京时间 09:00–12:00、14:00–18:00，API 峰谷电价峰时），
 *  以及每个峰时开始前 suppressLeadMinutes 分钟（默认 15）——此时不触发 dream，
 *  等峰时结束后的下一个检查周期自然触发。支持跨午夜时段（start > end）。 */
export function isDreamSuppressed(cfg: DreamConfig, date = new Date()): boolean {
  const m = minutesInTimeZone(cfg.timeZone, date)
  const lead = Math.max(0, Math.floor(cfg.suppressLeadMinutes))
  for (const w of cfg.suppressWindows) {
    const start = parseMinute(w.start)
    const end = parseMinute(w.end)
    if (start === null || end === null || start === end) continue // 非法/空时段跳过
    const from = (start - lead + 1440) % 1440
    if (from === end) return true // lead 覆盖整天
    if (from < end) {
      if (m >= from && m < end) return true
    } else if (m >= from || m < end) {
      return true // 前推或时段跨午夜
    }
  }
  return false
}

/** 子代理会话判定（与 index.ts 注入链路同口径）：origin === 'subagent' 为 dsh 权威标记；
 *  delegationDepth > 0 作双保险。不能只看 parentSession——GUI fork/续写的主会话也有
 *  parentSession（2026-08-17 真机踩坑 fca10feb 误判）。 */
export function isSubagentAgent(agent: unknown): boolean {
  const header = (agent as { session?: { header?: { origin?: unknown; delegationDepth?: unknown } } })
    ?.session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/** 已判定不参与自动 dream 的窗口（进程级缓存）：origin/depth 判定为子代理会话。
 *  dream 只归主窗口——子代理会话（历史 delegate fork 的、或用户手动 fork 的）虽然会
 *  进 windows 表/windowIndex（它们也产生事件），但不是 dream 目标，否则 dream 子代理
 *  →再进表→再被 dream→depth 无限套娃（2026-09-05 真机实证
 *  8fbc5d59→2f47c15b→63dad87b，猫猫拍板：主窗口主 session 负责 dream）。
 *  手动 /dream 与 memory_dream 不经此过滤（手动=明确意愿）。
 *  0.32（#49）起自动路径不再 resume，缓存只为省掉子代理窗口的重复判定。 */
const autoDreamSkipWindows = new Set<string>()

/**
 * @deprecated 0.32（修 #49）：自动 dream 不再冷启动 resume。保留导出名只为兼容旧调用方
 *  （index.ts 仍重导出）；语义改为「live agent 存在时的自动复查」——进程内取不到该窗口
 *  的 live agent 就记一次日志跳过，**绝不** resolveAgent / agents.resume、绝不新建会话。
 *  旧 resume 机器（会话日志路由恢复 / sessionController.resolveAgent / not-found 退避 /
 *  在途去重）已整体删除：自动 dream 只服务用户正在用、至少进程内活着的窗口。
 *  与 dreamSweepOnce 共用同一套成本闸（上下文估算 / 24h 频次 / 超限冷却）。
 */
export async function resumeAndDream(ctx: Context, sessionId: string, workspace: string, dir: string, onDreamState: DreamStateCallback | undefined, cfg: DreamConfig): Promise<void> {
  const sid = shortSessionId(sessionId)
  const agent = liveAgentOf(ctx, sessionId)
  if (agent === undefined || agent === null) {
    // 每会话只记一次：15min/轮扫描不刷屏
    if (!coldResumeSkipLogged.has(sessionId)) {
      coldResumeSkipLogged.add(sessionId)
      dreamLog(`check cold-resume-disabled sid=${sid} -> skip (no agents.resume, #49)`)
    }
    return
  }
  if (isSubagentAgent(agent)) {
    autoDreamSkipWindows.add(sessionId)
    dreamLog(`check skip-subagent sid=${sid}`)
    return // 子代理会话不是 dream 目标（dream 只归主窗口）
  }
  const db = getDb(workspace, dir)
  const w = db.getWindow(sessionId)
  if (!w || !windowNeedsDream(w)) return // 复查期间超 24h / 已 dream 过
  if (Date.now() - w.last_event_time < cfg.idleMinutes * 60_000) return // 复查期间窗口被碰，空闲不足
  if (db.getDreamLease(sessionId) !== null) return // 复查期间别处已启动 dream
  const gate = evaluateAutoDreamGate(db, sessionId, agent, cfg)
  if (!gate.allowed) {
    logAutoDreamGate(sessionId, gate)
    return
  }
  if (startWindowDream(ctx, agent as { session?: { header?: { id?: string } } }, workspace, dir, onDreamState, cfg.rulesReviewDays)) {
    recordAutoDreamStart(db, sessionId)
  }
}

/** dream 自动扫描单轮（scheduleDream 定时驱动；导出供测试直调）。
 *  峰时抑制/全局检查门在 scheduleDream 里，这里只做窗口遍历与启动。
 *  0.32（#49）：窗口必须有 live agent（绝不 resume 冷会话），且过成本闸才会 start。
 *  每轮最多 start 一个窗口（start 成功即返回，剩余下周期继续——清积压限速）。 */
export function dreamSweepOnce(ctx: Context, cfg: DreamConfig, dir: string, windowIndex: Map<string, string>, onDreamState?: DreamStateCallback, workspaceDisabled?: (ws: string) => boolean): void {
  // 已归档会话集合（registry 全局归档；服务不可用时跳过检查）
  const archived = new Set<string>()
  try {
    const reg = (ctx as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
      | { archivedSessionIds?: readonly string[] }
      | undefined
    for (const id of reg?.archivedSessionIds ?? []) archived.add(id)
  } catch {
    /* workspaceRegistry 不可用：不做归档过滤 */
  }
  for (const [sessionId, workspace] of windowIndex) {
    if (archived.has(sessionId)) continue // 已归档 = 当不存在
    if (workspaceDisabled?.(workspace) === true) continue // 工作区停用（#28）：连库都不开
    if (autoDreamSkipWindows.has(sessionId)) continue // 子代理/不可恢复窗口：进程级缓存命中，连 agent 都不取
    // 0.32 安全闸（review R4/P1）：信任判定必须先于 getDb——陌生库连打开/schema 升级/
    // 索引写入都不允许；本进程还没判定过的工作区也跳过（宁可漏整理，不碰陌生库）。
    const trustPre = storeTrustOf(workspace, dir)
    if (trustPre?.trusted !== true) {
      dreamLog(`check skip-untrusted sid=${shortSessionId(sessionId)} reason=${trustPre?.reason ?? 'unknown'}`)
      continue
    }
    const db = getDb(workspace, dir)
    // 用户跳过（v0.16.0 侧边栏菜单 toggle）：本窗口不自动 dream。
    // 只挡自动触发——/dream 命令与 memory_dream 工具（手动=明确意愿）不受限；
    // 租约过期补收尾也不受影响（清理语义，防僵尸租约堵死后续手动触发）。
    if (db.isDreamSkipped(sessionId)) continue
    const w = db.getWindow(sessionId)
    if (!w || !windowNeedsDream(w)) continue
    const lease = db.getDreamLease(sessionId)
    dreamLog(`check sid=${shortSessionId(sessionId)} active=${lease !== null} idle=${Math.round((Date.now() - w.last_event_time) / 1000)}s`)
    // 进行中 dream：只在租约过期（主人已死）时补收尾；活跃则跳过（别处正在 dream）
    if (lease !== null) {
      if (Date.now() - lease.progress_at > DREAM_LEASE_MS) {
        recoverInterruptedDream(db, sessionId, workspace, dir)
        // 零进展释放（issue #36）≠ 整理完成：去月亮（active）；封存路径照旧 dreamed。
        const wAfter = db.getWindow(sessionId)
        onDreamState?.(sessionId, wAfter !== undefined && wAfter.last_dream_time !== null ? 'dreamed' : 'active')
      }
      continue
    }
    // 窗口级 idle（用户拍板：session 最近 idleMinutes 无动作才 dream）：
    // 用 db 持久化的 last_event_time 判定——不受模块实例/热重载影响。
    // （空闲判定完全按窗口自身 last_event_time，与全局/其他窗口活动无关，
    //   避免活跃窗口拖累已空闲窗口导致 dream 永不触发。）
    if (Date.now() - w.last_event_time < cfg.idleMinutes * 60_000) continue
    // 0.32（修 #49）：自动 dream 只认进程内 live agent，**绝不** resume 冷会话。
    // 取不到 = 用户没开着这个窗口（或进程重启后尚未回来）：跳过，等窗口真的活着再说；
    // 每会话只记一次日志（15min/轮扫描不刷屏）。
    const agent = liveAgentOf(ctx, sessionId)
    if (agent === undefined || agent === null) {
      if (!coldResumeSkipLogged.has(sessionId)) {
        coldResumeSkipLogged.add(sessionId)
        // requireLiveAgent 默认 true；就算配成 false 也不会恢复冷启动 resume（#49 不变量），
        // 只在日志里区分是"配置要求 live"还是"冷恢复已删除"。
        const why = cfg.requireLiveAgent === false ? 'no cold resume' : 'requireLiveAgent'
        dreamLog(`check agent-missing sid=${shortSessionId(sessionId)} -> skip (${why}, #49)`)
      }
      continue
    }
    if (isSubagentAgent(agent)) {
      // 子代理会话窗口：不 dream（否则 dream 子代理→再进表→再被 dream 无限递归）。
      // 记入缓存后后续周期在循环顶部直接跳过，不再打 check 日志。
      autoDreamSkipWindows.add(sessionId)
      dreamLog(`check skip-subagent sid=${shortSessionId(sessionId)}`)
      continue
    }
    // 0.32 成本闸（只挡自动触发；手动 /dream、memory_dream 不过这里）：
    // 24h 频次上限 + 上下文超限 24h 冷却 + 本次会话上下文 token 估算。
    // Phase 2：隔离 dream 的 child prompt 有独立上限、不回放主上下文，主上下文大小闸
    // 对隔离路径不适用（否则大会话永远轮不到隔离整理）；频次/冷却/峰值闸仍然生效。
    const isoRequested = cfg.isolated === true
    const isoReady = isoRequested && isolatedDreamAvailable(ctx, cfg)
    if (isoRequested && !isoReady && !isolatedUnavailableLogged) {
      isolatedUnavailableLogged = true
      dreamLog('isolated-dream unavailable (subagents/spawn provider) -> fallback main-agent dream')
      console.warn('[meow-memory] 隔离 dream 不可用（subagents 服务/spawn provider 缺失或非空上下文）：退回主窗口 dream')
    }
    const gateCfg = isoReady
      ? { ...cfg, budget: { ...(cfg.budget ?? {}), dreamMaxContextTokens: Number.MAX_SAFE_INTEGER } }
      : cfg
    const gate = evaluateAutoDreamGate(db, sessionId, agent, gateCfg)
    if (!gate.allowed) {
      logAutoDreamGate(sessionId, gate)
      continue
    }
    // 0.32 review Q3：进程级全局每日上限（N 个窗口不再等于 N 倍自动花费）。
    const maxTotal = dreamMaxPerDayTotal(cfg)
    if (maxTotal <= 0 || globalDreamStartsInWindow(Date.now()) >= maxTotal) {
      dreamLog(`check global-daily-cap sid=${shortSessionId(sessionId)} cap=${maxTotal}`)
      continue
    }
    // Phase 2 Round 2：隔离 dream（spawn 子代理，主会话模型可见上下文零增长）。
    // 能力缺失 → 记一次日志后回退主窗口 dream；租约被占/启动瞬态失败 → 下轮重试，不双跑。
    if (isoReady) {
      const T = w.last_event_time > 0 ? w.last_event_time : Date.now()
      const rounds = collectDreamRounds(db, sessionId, workspace, dir, cfg.rulesReviewDays)
      const isolated = startIsolatedDream(ctx, agent, db, sessionId, workspace, dir, cfg, rounds, T, onDreamState)
      if (isolated === 'started') {
        recordAutoDreamStart(db, sessionId) // 自动频次计数（手动 dream 不占额度）
        return // 一轮一个窗口
      }
      if (isolated === 'rejected') continue
      if (!isolatedUnavailableLogged) {
        isolatedUnavailableLogged = true
        dreamLog('isolated-dream unavailable (subagents/spawn provider) -> fallback main-agent dream')
        console.warn('[meow-memory] 隔离 dream 不可用（subagents 服务/spawn provider 缺失或非空上下文）：退回主窗口 dream')
      }
    }
    const started = startWindowDream(ctx, agent as never, workspace, dir, onDreamState, cfg.rulesReviewDays)
    if (started) {
      recordAutoDreamStart(db, sessionId) // 自动频次计数（手动 dream 不占额度）
      return // 一轮一个窗口
    }
  }
}

/** dream 检查单 tick（scheduleDream 的定时体；导出供测试直调）。
 *  cfg 支持对象或 getter（活配置，issue #26）：getter 每 tick 现读，enabled=false
 *  时在任何 DB 操作（含 60s 检查门的 SQLite 往返）之前短路。
 *  定时器里的未捕获异常会终止整个 dsh 进程（插件不得杀宿主，2026-09-10 实测
 *  过一次：0.1.5 的 steer 抛错把进程带崩）。整体兜一层：单次检查失败只记日志，
 *  下个周期照常重试。各窗口/各步骤自身仍各自降级，这里只作最后一道保险。 */
export function dreamSweepTick(ctx: Context, cfg: DreamConfig | (() => DreamConfig | undefined), dir: string, windowIndex: Map<string, string>, onDreamState?: DreamStateCallback, workspaceDisabled?: (ws: string) => boolean): void {
  try {
    const c = typeof cfg === 'function' ? cfg() : cfg
    if (c === undefined || !c.enabled) return
    // 峰时抑制（用户拍板 2026-08-19）：北京时间 09:00–12:00 / 14:00–18:00
    // （API 峰谷电价峰时）及各自开始前 15 分钟不触发；峰时结束后本周期直接
    // return，等下一个检查周期自然触发。进行中的 dream 不打断。
    if (isDreamSuppressed(c)) return
    // 全局检查门（防多实例/多定时器叠加）：60 秒内只有一个实例真正执行检查。
    // 根因：热重载/多 fiber 并存时 dispose 未必清理旧 setInterval → 检查频率
    // 远高于 checkMinutes → 同一窗口被反复 start。用共享库的原子抢占做节流，
    // 与 claimDream（start 幂等）+ recoverInterruptedDream（中断自愈）闭环。
    // 工作区按字典序取首个：windowIndex 是插入序 Map，两实例插入序不同时会各自
    // 抢不同库的门 → 门失效（2026-09-10 复核）；排序后只要有公共工作区，必然
    // 选中同一块库的同一条门记录。零交集的多实例本来无共享状态，无需共门。
    const gateWorkspaces = [...new Set(windowIndex.values())].sort()
    if (gateWorkspaces.length === 0 || !getDb(gateWorkspaces[0], dir).claimCheckGate(60_000)) return
    dreamSweepOnce(ctx, c, dir, windowIndex, onDreamState, workspaceDisabled)
  } catch (error: unknown) {
    console.warn(`[meow-memory] dream sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 后台定时检查（自调度 setTimeout + dispose 清理；cordis 无内置定时器）。
 *  判定纯时间化（用户拍板）：窗口最后发言在 24h 内 且 最后动作不是 dream
 *  （last_dream_time < last_event_time）；不依赖 live agent 存在性。
 *  已归档的会话（workspaceRegistry.archivedSessionIds）视为不存在，不 dream（用户拍板）。
 *  执行时只取进程内 live agent（ctx.agents.get → liveAgents 兜底），取不到即跳过；
 *  0.32（#49）起绝不 resume 冷会话。
 *  自调度（issue #26）：checkMinutes 是活值——每 tick 现读现排下一轮（setInterval 的
 *  周期在启动时定型，改配置永远不生效）；cfg 支持对象（兼容旧调用/测试）或 getter
 *  （活配置）。enabled 状态转换打一行日志（静默跳过与没跑在日志里同形，去观测盲点）。 */
export function scheduleDream(ctx: Context, cfg: DreamConfig | (() => DreamConfig | undefined), dir = '.dsh-meow', windowIndex: Map<string, string>, onDreamState?: DreamStateCallback, workspaceDisabled?: (ws: string) => boolean): () => void {
  const read = typeof cfg === 'function' ? cfg : (): DreamConfig => cfg
  const checkMinutesOf = (c: DreamConfig | undefined): number =>
    typeof c?.checkMinutes === 'number' && Number.isFinite(c.checkMinutes) && c.checkMinutes >= 1 ? c.checkMinutes : 15
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let lastEnabled: boolean | undefined
  const arm = (minutes: number): void => {
    if (stopped) return
    timer = setTimeout(tick, minutes * 60_000)
    // #60：自调度链同样不阻宿主退出（dispose 仍 clearTimeout，停止语义不变）。
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  const tick = (): void => {
    let c: DreamConfig | undefined
    try {
      c = read()
      if (c !== undefined && c.enabled !== lastEnabled) {
        lastEnabled = c.enabled
        ctx.logger.info(`meow-memory: dream 调度器${c.enabled ? '启用' : '停用'}（配置热生效，issue #26）`)
      }
      dreamSweepTick(ctx, c, dir, windowIndex, onDreamState, workspaceDisabled)
    } finally {
      arm(checkMinutesOf(c)) // read 抛错时 c=undefined → 按 15min 兜底重排，循环不断
    }
  }
  let initial: DreamConfig | undefined
  try {
    initial = read()
  } catch {
    /* 首读失败：按默认周期起跑，tick 内再试 */
  }
  arm(checkMinutesOf(initial))
  return (): void => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 会话活跃度跟踪（模块级，单进程足够）。 */
let lastActivityAt = Date.now()
export function noteActivity(): void {
  lastActivityAt = Date.now()
}
export function lastActivity(): number {
  return lastActivityAt
}
