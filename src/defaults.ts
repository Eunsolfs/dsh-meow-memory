/**
 * meow-memory — 出厂默认值的单一来源（纯数据模块，host 与 client 共用）。
 *
 * 两个消费者：
 *  ①host：config 解析兜底 + 设置页 base（预填层）的默认部分（index.ts）；
 *  ②client：设置页「恢复默认」按钮的写入目标 + 「已覆盖」徽章的判定基准（settings-page.ts）。
 *
 * 为什么要共用：设置页原来的「恢复默认」只做"删掉 user 层字段、显示回落 base"，
 * 而 base = 出厂默认 + patch 基线（cordis.patch.yml），于是 patch 里手编的非默认值
 * 会被当成"默认"还给用户——2026-09-10 猫猫实证踩到（3080 patch 写死的
 * zai-coding-cn/glm-5.3-flash 成了「反思/梦境换模型」的恢复默认结果）。
 * 现在语义统一为：**恢复默认 = 回到插件出厂默认**。
 *
 * 约束：本文件不得 import 任何 host 依赖（node/DB/prompts/React）——它会被打进
 * client bundle。
 */

/** rulesReviewDays 的单一默认来源：zod schema / resolveConfig 兜底 / 各运行时函数默认参数
 *  统一引用此处（dream.ts re-export）——改默认值只动这一行。 */
export const DEFAULT_RULES_REVIEW_DAYS = 2

/** 出厂默认值（设置页 base 的默认层）。promptLang 刻意缺席=未设置语义（默认 zh+首用引导）。 */
export const CONFIG_DEFAULTS = {
  enabled: true,
  projectDir: '.dsh-meow',
  hitTopK: 2,
  titleMax: 40,
  reflect: true,
  reflectTurns: 7,
  /** 0.32 起默认关：工作区里来路不明的 PROJECT.md 不得零交互导入（安全审计 #64-1）。 */
  autoMigrate: false,
  /** 全局目录选择：''=默认（平台用户主目录）；预设标记或绝对路径见 home-dir.ts。
   *  恢复默认写入 ''（而非删字段）=回落平台默认目录。 */
  homeDir: '',
  /** 安全闸（0.32）：工作区已有、但非本插件创建的 memory.db 默认不信任（不注入其
   *  soul/user/全局 rules）；memory_home 默认只读查询，不许模型搬目录。 */
  security: {
    trustWorkspaceMemory: false,
    allowHomeSwitch: false,
    autoGitignore: true,
    debugLogs: false,
  },
  /** 注入/整理预算（0.32）：把「默认自动花 token」限制在可解释的上限里。 */
  budget: {
    snapshotMaxChars: 6000,
    hitMaxChars: 1500,
    reinjectMaxChars: 8000,
    dreamMaxContextTokens: 40000,
    dreamMaxPerWindowPerDay: 1,
    /** 0.32 review Q3：进程级全局每日上限（N 个窗口不再 = N 倍自动花费）。 */
    dreamMaxPerDayTotal: 12,
    reflectMaxPerDay: 6,
    reflectMinIntervalMinutes: 20,
    reflectMaxPerDayTotal: 24,
  },
  /** 检索/遗忘参数（0.32）：真指数半衰 + 命中反馈 + 查询覆盖率 + 最低分门槛。 */
  retrieval: {
    halfLifeDays: 30,
    minScore: 0.35,
    hitBoost: true,
    importanceWeight: true,
    /** 0.35 可选语义检索：默认关闭（零联网）；显式配置 OpenAI-compatible
     *  `/embeddings` 端点后才启用（key 走 env）。失败/超时回退纯词法。 */
    semantic: {
      enabled: false,
      baseUrl: '',
      model: '',
      apiKeyEnv: 'MEOW_MEMORY_EMBEDDING_KEY',
      timeoutMs: 5000,
      weight: 0.8,
    },
  },
  dream: {
    enabled: true,
    idleMinutes: 180,
    suppressWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    suppressLeadMinutes: 15,
    checkMinutes: 15,
    timeZone: 'Asia/Shanghai',
    rulesReviewDays: DEFAULT_RULES_REVIEW_DAYS,
    /** Phase 2：自动 dream 改在隔离 spawn 子会话执行（主会话上下文 0 增长）；默认关。
     *  手动 /dream 与 memory_dream 始终走主 agent（用户可看可中止）。 */
    isolated: false,
    isolatedProvider: 'spawn',
    isolatedTimeoutMinutes: 20,
    isolatedMaxPromptChars: 20000,
    isolatedArchiveChild: true,
  },
  delegate: { model: '' },
  /** 记忆库自动备份（#37 增量②，默认关）：开启后每次 dream 收尾把 memory.db
   *  快照轮转到 memory.db.bak（VACUUM INTO 一致性备份）。 */
  backup: { enabled: false },
  /** 工作区停用名单（#28）：列出的工作区（cwd 归一匹配）完全停用记忆——读/整理/写
   *  全部拒绝（含手动 /dream）。用于一次性任务的工作区，避免污染记忆库。 */
  disabledWorkspaces: [],
}

/** 字段形状（settings-page 的 FieldSpec 子集：sub 缺省=顶层标量，给定=dream/delegate 子键）。 */
export interface DefaultFieldSpec {
  key: string
  sub?: string
}

/**
 * 读某字段的出厂默认值：不在默认表里的字段（如 promptLang）返回 undefined
 * ——调用方据此区分"有出厂默认"与"语义=未设置"两条分支。
 */
export function factoryDefaultOf(spec: DefaultFieldSpec): unknown {
  const scope: unknown = spec.sub === undefined
    ? CONFIG_DEFAULTS as unknown
    : (CONFIG_DEFAULTS as unknown as Record<string, unknown>)[spec.sub]
  if (scope === undefined || scope === null || typeof scope !== 'object') return undefined
  return (scope as Record<string, unknown>)[spec.key]
}
