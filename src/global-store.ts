/**
 * global-store.ts — 全局（用户级）记忆库与工作区库的懒迁移（Phase 2 Round 1，0.33.0）。
 *
 * 分层存储模型（PHASE2-PLAN §1）：
 *   <activeHomeDir>/global/memory.db  ← 用户级：soul / user / rules(全局)
 *   <workspace>/<projectDir>/memory.db ← 工作区级：project / fact / lesson / topic / rules(项目)
 *
 * 迁移按工作区懒执行、幂等、只对**可信**工作区库生效：把 soul / user / 全局 rules
 * 按原 id 复制进全局库（insertRow，保 id/时间戳，全局已有同 id 则 global wins），
 * 然后把工作区里的对应行归档（status='archived'），避免注入/dream 双计。完成状态
 * 记在工作区库 dream_meta（`globalmigrated:v1:<projectDir>`）——键随工作区库走，
 * 不同工作区各自迁移一次。
 *
 * 安全边界：迁移只搬运「工作区里已有的用户级记忆」，绝不跨信任边界读取 foreign 库
 * （storeTrustOf 非 trusted 直接跳过）；任何异常都只 console.warn，绝不向调用方抛。
 */
import {
  ensureGlobalStore,
  getDb,
  getGlobalDb,
  isGlobalScope,
  storeTrustOf,
  type Level,
  type MemoryRow,
} from './db.js'

/** 迁移完成标记的版本段 + 前缀（最终键 = `globalmigrated:v1:<projectDir>`）。 */
const MIGRATION_FLAG = 'globalmigrated:v1'
/** 迁移搬运的层级（用户级记忆）。rules 只搬全局作用域的行。 */
const COPY_LEVELS: readonly Level[] = ['soul', 'user', 'rules']

export interface MigrationResult {
  /** 新复制进全局库的行数。 */
  copied: number
  /** 工作区里被归档的行数（去重，防注入/dream 双计）。 */
  archived: number
  /** true = 本次没有执行（工作区不可信 / 全局库不可信 / 已迁移过）。 */
  skipped: boolean
}

export function migrateWorkspaceToGlobal(workspace: string, dir: string): MigrationResult {
  const result: MigrationResult = { copied: 0, archived: 0, skipped: true }
  try {
    // ① 只迁移本插件自己创建/用户显式信任的工作区库；foreign 库一律不碰。
    if (storeTrustOf(workspace, dir)?.trusted !== true) return result
    // ② 全局库必须可信（不存在则本次创建；已存在但无标记 → foreign → 不迁移）。
    if (!ensureGlobalStore().trusted) return result

    const wsDb = getDb(workspace, dir)
    const flag = `${MIGRATION_FLAG}:${dir}`
    if (wsDb.getDreamMeta(flag) !== undefined) return result // 幂等：本工作区已迁移过

    const globalDb = getGlobalDb()
    result.skipped = false

    // 全局库已有 id（global wins）：预取一次，避免逐行跨表查询。
    const globalIds = new Map<Level, Set<string>>()
    for (const level of COPY_LEVELS) globalIds.set(level, new Set(globalDb.list(level).map((r) => r.id)))

    /** 已复制/已在全局库里的工作区行；随后统一归档。 */
    const seen: Array<{ level: Level; id: string }> = []
    let errors = 0
    for (const level of COPY_LEVELS) {
      const ids = globalIds.get(level)!
      for (const row of wsDb.list(level)) {
        // rules：只搬全局作用域的行（null / 空串 / 全局标记）；项目 rules 留在工作区。
        if (level === 'rules' && !isGlobalScope(row.project)) continue
        if (ids.has(row.id)) continue // 全局已有同 id：global wins，不再覆盖
        try {
          globalDb.insertRow({ ...row, level, id: row.id })
          ids.add(row.id)
          seen.push({ level, id: row.id })
          result.copied++
        } catch (e) {
          // 单行失败（id 冲突/库锁）：保留工作区原行，下次会话重试（不置完成标记）。
          errors++
          console.warn(
            `[meow-memory] 全局记忆迁移跳过 ${level}/${row.id}：${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
    }

    for (const { level, id } of seen) {
      try {
        if (wsDb.update(level, id, { status: 'archived' })) result.archived++
      } catch (e) {
        errors++
        console.warn(`[meow-memory] 全局记忆迁移归档失败 ${level}/${id}：${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 零错误才置位；有错误留待下次重试（已复制行的 id 去重使重试安全）。
    if (errors === 0) wsDb.setDreamMeta(flag, new Date().toISOString())
    return result
  } catch (e) {
    console.warn(`[meow-memory] 全局记忆迁移失败（已跳过，不影响本次会话）：${e instanceof Error ? e.message : String(e)}`)
    return result
  }
}

/** 全局库的 active 用户级记忆（注入/检索用）。全局库不可用或不可信 → 三个空数组，
 *  调用方据此回落到工作区库（0.32 兼容行为）。rules 只取全局作用域（防御性兜底）。 */
export function globalStoreRows(): { soul: MemoryRow[]; user: MemoryRow[]; rules: MemoryRow[] } {
  try {
    if (!ensureGlobalStore().trusted) return { soul: [], user: [], rules: [] }
    const db = getGlobalDb()
    return {
      soul: db.list('soul', { status: 'active' }),
      user: db.list('user', { status: 'active' }),
      rules: db.list('rules', { status: 'active' }).filter((r) => isGlobalScope(r.project)),
    }
  } catch (e) {
    console.warn(`[meow-memory] 读取全局记忆失败（本次按空处理）：${e instanceof Error ? e.message : String(e)}`)
    return { soul: [], user: [], rules: [] }
  }
}
