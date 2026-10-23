/**
 * meow-memory v2 — ReAct 任务结束后的自动反思。
 *
 * 触发：一次任务（单个 turn）内连续 react（工具）step ≥ reflectTurns（默认 7）
 * 后，在该轮结束时触发一次；单次简单工具调用不触发。顶层会话、本 turn 未反思过、
 * 最后工具非 memory_ 系列。
 * 反思消息（用户拍板 2026-08-19 终稿）：【一】新记忆（project 列表/纠正/偏好等）、
 * 【二】更新判断（过时/错误/完成/关键词不准反推）、【三】通用要求（subcategory/
 * 关键词 8-13/importance/收尾）。topic 归 dream 轮处理，反思不再涉及。
 *
 * 0.32 成本闸（审计 cost R1：反思是默认开启的「+1 轮全上下文请求」，原先只有
 * 每 turn 去重，没有频次/大小上限）：自动反思在既有判定之外还必须通过
 * ① 距本窗口上次反思 ≥ budget.reflectMinIntervalMinutes（默认 20 分钟）；
 * ② 本窗口今日反思次数 < budget.reflectMaxPerDay（默认 6，0=关闭）；
 * ③ 当前会话上下文估算 ≤ budget.dreamMaxContextTokens（默认 40000）。
 * 计数/时间戳落 workspace 库的 dream_meta（reflectstat:<sid>，跨进程/重启共享）；
 * 手动路径不存在（反思只能自动触发），跳过时只记一条 info 日志。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateContextTokens, DREAM_DEFAULT_MAX_CONTEXT_TOKENS, type DreamBudget } from './dream.js'
import { getDb } from './db.js'
import { keyedValue, resolveSlotText } from './prompt-loader.js'
import { PLUGIN_SOURCE, isMeowSource } from './source.js'

// ── 0.32 反思成本闸 ─────────────────────────────────────────────────────────

export const REFLECT_DEFAULT_MAX_PER_DAY = 6
export const REFLECT_DEFAULT_MIN_INTERVAL_MINUTES = 20
/** 进程级全局每日自动反思上限默认值（review Q3）。 */
export const REFLECT_DEFAULT_MAX_PER_DAY_TOTAL = 24

/** 进程级自动反思时间戳（滚动 24h；重启清零，文档已说明）。 */
let globalReflects: number[] = []

/** 测试用：清空进程级反思计数。 */
export function resetGlobalReflectCounter(): void {
  globalReflects = []
}

function globalReflectsInWindow(now: number): number {
  globalReflects = globalReflects.filter((t) => now - t < 24 * 3600_000)
  return globalReflects.length
}
/** 反思计数/时间戳的 dream_meta 键前缀（每 workspace 库、每 session 一条）。 */
const REFLECT_STAT_META_PREFIX = 'reflectstat:'

/** 反思成本闸消费的配置视图（Lead 传 resolved；缺省按 0.32 出厂默认）。 */
export interface ReflectBudgetConfig {
  reflect?: boolean
  budget?: DreamBudget
}

export type ReflectSkipReason = 'disabled' | 'min-interval' | 'daily-cap' | 'context-too-large'

export interface ReflectGateResult {
  allowed: boolean
  reason?: ReflectSkipReason
  /** 拒绝原因（一行，调用方 ctx.logger.info 一次即可；allowed 时无值）。 */
  message?: string
}

/** 反思计数（dream_meta reflectstat:<sid>）：lastAt + 当日计数（day=UTC 日期）。
 *  用 UTC 日界：可复现（测试可传 now），跨时区最多差几小时，值得换确定性。 */
export interface ReflectStat {
  lastAt: number
  day: string
  count: number
}

export function reflectDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function budgetNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** 读反思计数（缺失/损坏 → undefined，绝不抛：跑在 turn-stopping 事件链上）。 */
export function readReflectStat(db: ReturnType<typeof getDb>, sessionId: string): ReflectStat | undefined {
  let raw: string | undefined
  try {
    raw = db.getDreamMeta(REFLECT_STAT_META_PREFIX + sessionId)
  } catch {
    return undefined
  }
  if (raw === undefined) return undefined
  try {
    const v = JSON.parse(raw) as Partial<ReflectStat>
    if (typeof v.lastAt !== 'number' || !Number.isFinite(v.lastAt)) return undefined
    return {
      lastAt: v.lastAt,
      day: typeof v.day === 'string' ? v.day : '',
      count: typeof v.count === 'number' && Number.isFinite(v.count) && v.count >= 0 ? v.count : 0,
    }
  } catch {
    return undefined
  }
}

/**
 * 反思成本闸（自动反思的唯一入口；调用点：index.ts turn-stopping，在既有
 * 「连续工具 step ≥ reflectTurns / 最后工具非 memory_* / 本 turn 未反思」判定之后）。
 * ① 距上次反思 < budget.reflectMinIntervalMinutes → 跳过；
 * ② 今日（UTC）计数 ≥ budget.reflectMaxPerDay → 跳过；
 * ③ 会话上下文估算 > budget.dreamMaxContextTokens → 跳过。
 * 只读不写：计数由 recordReflectSent 在真正送出后记账（发送失败不占额度）。
 */
export function checkReflectBudget(input: {
  workspace: string
  sessionId: string
  events: readonly unknown[]
  dir?: string
  cfg?: ReflectBudgetConfig
  now?: number
}): ReflectGateResult {
  const now = input.now ?? Date.now()
  const cfg = input.cfg
  if (cfg?.reflect === false) {
    return { allowed: false, reason: 'disabled', message: 'reflect skipped: reflect=false（反思已在配置中关闭）' }
  }
  const dir = input.dir ?? '.dsh-meow'
  let stat: ReflectStat | undefined
  try {
    stat = readReflectStat(getDb(input.workspace, dir), input.sessionId)
  } catch {
    stat = undefined // 库不可用：不因为统计失败挡反思（fail-open，与注入链同风格）
  }
  const minIntervalMinutes = budgetNumber(cfg?.budget?.reflectMinIntervalMinutes) ?? REFLECT_DEFAULT_MIN_INTERVAL_MINUTES
  if (stat !== undefined && now - stat.lastAt < minIntervalMinutes * 60_000) {
    const elapsedMin = Math.max(0, Math.floor((now - stat.lastAt) / 60_000))
    return {
      allowed: false,
      reason: 'min-interval',
      message: `reflect skipped: 距上次反思 ${elapsedMin}min < budget.reflectMinIntervalMinutes=${minIntervalMinutes}`,
    }
  }
  const maxPerDay = budgetNumber(cfg?.budget?.reflectMaxPerDay) ?? REFLECT_DEFAULT_MAX_PER_DAY
  const today = reflectDayKey(now)
  const todayCount = stat !== undefined && stat.day === today ? stat.count : 0
  if (maxPerDay <= 0 || todayCount >= maxPerDay) {
    return {
      allowed: false,
      reason: 'daily-cap',
      message: `reflect skipped: 今日反思 ${todayCount}/${maxPerDay} 次（budget.reflectMaxPerDay）`,
    }
  }
  const limit = budgetNumber(cfg?.budget?.dreamMaxContextTokens)
  const maxTokens = limit !== undefined && limit > 0 ? limit : DREAM_DEFAULT_MAX_CONTEXT_TOKENS
  // 0.32 review Q3：进程级全局上限（N 个会话不再 = N 倍自动反思）。
  const maxTotal = budgetNumber(cfg?.budget?.reflectMaxPerDayTotal) ?? REFLECT_DEFAULT_MAX_PER_DAY_TOTAL
  if (maxTotal <= 0 || globalReflectsInWindow(now) >= maxTotal) {
    return {
      allowed: false,
      reason: 'daily-cap',
      message: `reflect skipped: 进程级今日自动反思已达上限 budget.reflectMaxPerDayTotal=${maxTotal}`,
    }
  }
  const estimate = estimateContextTokens(input.events)
  if (estimate.tokens > maxTokens) {
    return {
      allowed: false,
      reason: 'context-too-large',
      message: `reflect skipped: 会话上下文估算 ≈${estimate.tokens} tokens > budget.dreamMaxContextTokens=${maxTokens}`,
    }
  }
  return { allowed: true }
}

/**
 * 记一次已送出的反思（时间戳 + 当日计数，落 dream_meta reflectstat:<sid>）。
 * 调用点：index.ts turn-stopping 在 sendMemoryTurn 成功之后；发送失败不要调用
 *（否则失败会白占频次额度）。异常吞掉：统计失败绝不阻塞反思链路。
 */
export function recordReflectSent(workspace: string, sessionId: string, dir = '.dsh-meow', now = Date.now()): void {
  globalReflects.push(now)
  try {
    const db = getDb(workspace, dir)
    const prev = readReflectStat(db, sessionId)
    const day = reflectDayKey(now)
    const count = prev !== undefined && prev.day === day ? prev.count + 1 : 1
    db.setDreamMeta(REFLECT_STAT_META_PREFIX + sessionId, JSON.stringify({ lastAt: now, day, count }))
  } catch {
    /* 统计失败不阻塞 */
  }
}

/** 反思消息识别标记（防同 turn 重复反思）。 */
export const REFLECT_MARKER = '[meow-memory-reflect]'

export function scanTurn(events: readonly unknown[]): {
  sawToolCall: boolean
  lastToolName?: string
  sawReflect: boolean
  turnText: string
} {
  let startIdx = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string }
    if (e?.type === 'turn/start') {
      startIdx = i
      break
    }
  }
  let sawToolCall = false
  let lastToolName: string | undefined
  let sawReflect = false
  const texts: string[] = []
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as {
      type?: string
      data?: {
        source?: { kind?: string; plugin?: string }
        content?: Array<{ type?: string; text?: string }>
        message?: { content?: Array<{ type?: string; name?: string; text?: string }> }
      }
    }
    if (e?.type === 'user/message') {
      const src = e.data?.source as { kind?: string; plugin?: string } | undefined
      const msgText = (e.data?.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text ?? '')
        .join(' ')
      if (isMeowSource(src) && msgText.includes(REFLECT_MARKER)) {
        sawReflect = true
      } else {
        for (const b of e.data?.content ?? []) if (b.type === 'text' && b.text) texts.push(b.text)
      }
    } else if (e?.type === 'assistant/message') {
      for (const block of e.data?.message?.content ?? []) {
        if (block.type === 'tool-call') {
          sawToolCall = true
          lastToolName = block.name
        } else if (block.type === 'text' && block.text) {
          texts.push(block.text)
        }
      }
    }
  }
  return { sawToolCall, lastToolName, sawReflect, turnText: texts.join('\n').slice(-2000) }
}

/**
 * 统计当前 turn（最后一个 turn/start 之后）内「连续非 memory_ 工具 step」的最大段长。
 * 每个 tool-call 计 1 step（同一 assistant/message 内的并行调用逐个计数）；
 * memory_ 工具调用中断连续段（已主动记忆，不再反思）。用户拍板：一次任务
 * 连续 react ≥7 个工具 step 才在任务结束时触发反思。
 */
export function consecutiveToolSteps(events: readonly unknown[]): number {
  let startIdx = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if ((events[i] as { type?: string }).type === 'turn/start') {
      startIdx = i
      break
    }
  }
  let best = 0
  let cur = 0
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i] as {
      type?: string
      data?: { message?: { content?: Array<{ type?: string; name?: string }> } }
    }
    if (e?.type !== 'assistant/message') continue
    for (const b of e.data?.message?.content ?? []) {
      if (b.type !== 'tool-call' || typeof b.name !== 'string') continue
      if (b.name.startsWith('memory_')) cur = 0
      else {
        cur++
        if (cur > best) best = cur
      }
    }
  }
  return best
}

export function buildReflectMessage(workspace: string, turnText: string, dir = '.dsh-meow'): ReturnType<typeof createUserMessage> {
  const db = getDb(workspace, dir)
  // 文案外置（v0.19.0）：prompts/zh/reflect.md，{projectList} 占位符填充；改文件下一次反思即生效。
  const prompt = resolveSlotText('reflect', { projectList: projectNamesText(db.listProjectNames()) })
  const text = `${REFLECT_MARKER} ${prompt}`
  return createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE })
}

/** project 清单展示（原 buildBasePrompt 逻辑：空清单显示占位说明）。 */
function projectNamesText(projectNames: string[]): string {
  return projectNames.length > 0 ? projectNames.join(' / ') : keyedValue('labels', 'reflect.noProjects')
}

export { PLUGIN_SOURCE }
