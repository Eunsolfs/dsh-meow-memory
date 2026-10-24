/**
 * meow-memory v2 — SQLite 数据层。
 *
 * 每 level 一表（用户拍板：各层数据结构需求不同）：
 *   soul / user — 无特化列，少而精；
 *   project     — project 名必填（多项目分存）+ subcategory 子类；
 *   fact        — 细碎原子事实，可选 project 归属；
 *   lesson      — corrected 标记 + 可选 project 归属；
 *   topic       — title 必填 + goal 目标句（切换判定参照系）。
 *
 * id = 时间前缀（base36 毫秒 + 随机后缀，36 字符）：id 排序即创建顺序。
 * updated_at = 记忆时间戳（最后更新时间：dream 封存或 memory_update 刷新；对外显示"记忆时间戳"）。
 * 驱动：node:sqlite（Node ≥22.5 内置，宿主 @deepseek-ai/dsh-storage-sqlite 同款）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dshHomeDir, activeHomeDir } from './home-dir.js'
import { fillTemplate, getPromptLang, keyedValue } from './prompt-loader.js'

export type Level = 'soul' | 'user' | 'project' | 'fact' | 'lesson' | 'topic' | 'rules'
export type Status = 'active' | 'archived' | 'stale'

export const LEVELS: readonly Level[] = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

/** project 子类（用户拍板）：目标概述/项目结构/技术决策/用户原话/部署与数据/进行中。 */
export const PROJECT_SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'] as const
export type ProjectSubcategory = (typeof PROJECT_SUBCATEGORIES)[number]

/** topic 之外的 level 不强制 title；project 需 project 名；lesson 用 corrected。 */
export const LEVEL_LABELS: Record<Level, string> = {
  soul: 'AI 自身',
  user: '用户基本信息与基础偏好',
  project: '项目',
  fact: '原子事实',
  lesson: '错误与教训',
  topic: '话题',
  rules: '设计原则与行为准则',
}

/** 框架词（labels.md）：注入块与 memory_project 正文里的短词随语言包走。 */
const lbl = (key: string, params?: Record<string, string>): string => fillTemplate(keyedValue('labels', key), params)

/** 相对时间显示（"记忆时间戳"人性化）。文案外置：labels.md 的 time.*。 */
export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return lbl('time.none')
  const diff = Date.now() - ms
  if (diff < 60_000) return lbl('time.justNow')
  if (diff < 3600_000) return lbl('time.minutes', { n: String(Math.floor(diff / 60_000)) })
  if (diff < 86_400_000) return lbl('time.hours', { n: String(Math.floor(diff / 3600_000)) })
  if (diff < 30 * 86_400_000) return lbl('time.days', { n: String(Math.floor(diff / 86_400_000)) })
  return new Date(ms).toISOString().slice(0, 10)
}

/** 全局标记的历史真值（zh 语言包的写法）。语言包切换后老库里存的仍是它，永远认。 */
export const GLOBAL_PROJECT_CANON = '全局'

/** 语言 → 全局标记的进程级缓存。此值走 projectCovers/projectList，命中链路每条
 *  用户消息都要按它过滤整库（几百条），逐条读文件解析会把热路径拖到 10ms 量级——
 *  这一个键按语言缓存（切语言即失效）。代价：改 labels.md 的 project.global 需要
 *  切一次语言或重启才生效；它是语义标记不是可随手改的文案，这个取舍是划算的。 */
let markerCache: { lang: string; marker: string } | null = null

/** 当前语言包的全局标记（labels.md 的 project.global；en = "global"）。
 *  这是模型按 prompt 写进 project 字段的字面值，所以必须随语言走——否则
 *  英文包里模型写的 "global" 会被当成一个叫 global 的项目：全局 rules 不再
 *  注入、项目列表里凭空多出一个项目。
 *  取不到（实例覆盖层的 labels.md 是老版本、缺键）时回退真值：全局判定是检索
 *  热路径的语义，不能因为一个文案文件过期就 throw 掉整条注入链路。 */
export function globalProjectMarker(): string {
  const lang = getPromptLang()
  if (markerCache !== null && markerCache.lang === lang) return markerCache.marker
  let marker: string
  try {
    marker = lbl('project.global')
  } catch {
    marker = GLOBAL_PROJECT_CANON
  }
  markerCache = { lang, marker }
  return marker
}

/** 全局标记的英文真值（en 语言包 labels.md 的 project.global 写法）。与中文真值一样
 *  永久认——中英混写的历史库里 "global" 曾按字面值落库，不认它就会退化成一条叫
 *  global 的假项目。2026-09-19 用户拍板：全局 / global / null 都要当全局。 */
export const GLOBAL_PROJECT_CANON_EN = 'global'

/** 是否全局标记（中文真值 + 英文真值 + 当前语言包写法：跨语言切换后新旧条目都要认）。
 *  容忍首尾空白与大小写：模型照 prompt 写字面值，英文里 "Global"/"global " 都会出现，
 *  漏认一次就是一条本该全局的记忆退化成一个假项目——宁可宽。 */
export function isGlobalProject(field: string | null): boolean {
  if (field === null) return false
  const trimmed = field.trim()
  if (trimmed === GLOBAL_PROJECT_CANON) return true
  if (trimmed.toLowerCase() === GLOBAL_PROJECT_CANON_EN) return true
  return trimmed.toLowerCase() === globalProjectMarker().toLowerCase()
}

/** 是否「全局适用」：未标记（null）、空串、任何全局标记（全局 / global / 当前语言写法）都算。
 *  首轮 rules 注入与关键词命中链路共用这一口径——2026-09-19 用户拍板「全局、global、null
 *  都注入」；修前 inject.ts 首轮过滤只认 project === null，于是按文档写"全局"的准则反而
 *  永不注入（口径 bug：父级库 15 条标"全局"的 rules 含 push 红线一直没进过首轮）。 */
export function isGlobalScope(field: string | null): boolean {
  if (field === null) return true
  const trimmed = field.trim()
  return trimmed === '' || isGlobalProject(trimmed)
}

/** project 字段 → 项目名列表（逗号分隔多值，兼容单值；全局标记/空 = 无具体项目）。 */
export function projectList(field: string | null): string[] {
  if (!field || isGlobalProject(field)) return []
  return field.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** project 字段是否覆盖某项目名（多值包含判断；null/全局标记 = 全局适用任何项目）。 */
export function projectCovers(field: string | null, name: string): boolean {
  if (field === null || isGlobalProject(field)) return true
  return projectList(field).includes(name)
}

/** project 字段的展示标签：全局标记=真全局（按当前语言显示）；null/''=未标记；多值 join '/'（如 dsh/femo）。 */
export function projectLabel(field: string | null): string {
  if (isGlobalProject(field)) return globalProjectMarker()
  if (field === null || field === '') return lbl('project.unlabeled')
  return projectList(field).join('/')
}

export interface MemoryRow {
  id: string
  level: Level
  title: string | null
  content: string
  importance: number // 数字即可不设上限（软引导 1-4；高 importance 豁免遗忘权重）
  keywords: string[] // JSON 数组，写入时 bigram 自动提取
  /** 触发关键词匹配模式（0.40）：any=任一命中；all=全部命中；min=至少 trigger_min 个命中。 */
  trigger_mode?: 'any' | 'all' | 'min'
  /** min 模式的最少命中关键词数（>=1）。 */
  trigger_min?: number
  /** 独立触发关键词（0.40，JSON 数组）：非空时注入只认这些词；空=不自动注入（严格模式下）。 */
  trigger_keywords?: string[]
  status: Status
  corrected: number // lesson 专用：来自用户纠正
  project: string | null // project 必填；fact/lesson 可选
  subcategory: ProjectSubcategory | null // project 专用
  goal: string | null // topic 专用：目标句
  source_session: string | null
  hit_count: number
  created_at: number
  updated_at: number // 记忆时间戳 = 最后更新时间（dream 封存或 memory_update 刷新）
  last_accessed_at: number | null
  /** 语义检索向量（0.35，可选）：JSON 数组缓存在 embedding 列；未回填/损坏 → null。 */
  embedding?: number[] | null
}

export interface MemoryPatch {
  content?: string
  title?: string | null
  importance?: number
  keywords?: string[]
  status?: Status
  trigger_mode?: 'any' | 'all' | 'min'
  trigger_min?: number
  trigger_keywords?: string[]
  corrected?: number
  project?: string | null
  subcategory?: ProjectSubcategory | null
  goal?: string | null
}

/** 时间前缀 id：base36(毫秒,9位) + '-' + 26 位随机 = 36 字符，id 排序 ≈ 创建顺序。 */
export function newId(now = Date.now()): string {
  const t = now.toString(36).padStart(9, '0')
  return t + '-' + randomUUID().replace(/-/g, '').slice(0, 26)
}

/** embedding 列 JSON 解析（安全）：非字符串 / 非法 JSON / 非数组 / 空数组 / 含非有限数
 *  → null（视作未回填）；绝不抛出（损坏的存量数据不能拖垮整条读链路）。 */
function parseEmbedding(raw: unknown): number[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const out: number[] = []
    for (const v of parsed) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
      out.push(v)
    }
    return out
  } catch {
    return null
  }
}

/** embedding 列 JSON 序列化（安全）：null/undefined/空数组/含非有限数 → null（不写垃圾）。 */
function serializeEmbedding(vec: number[] | null | undefined): string | null {
  if (!Array.isArray(vec) || vec.length === 0) return null
  for (const v of vec) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
  }
  return JSON.stringify(vec)
}

const COMMON_COLS = `
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  trigger_mode TEXT NOT NULL DEFAULT 'any',
  trigger_min INTEGER NOT NULL DEFAULT 1,
  trigger_keywords TEXT NOT NULL DEFAULT '[]',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  embedding TEXT
`

/** level → 建表语句（差异列按层特化）。表名来自 LEVELS 枚举，不拼外部输入。 */
const SCHEMAS: Record<Level, string> = {
  soul: `CREATE TABLE IF NOT EXISTS soul (${COMMON_COLS})`,
  user: `CREATE TABLE IF NOT EXISTS user (${COMMON_COLS})`,
  project: `CREATE TABLE IF NOT EXISTS project (${COMMON_COLS},
    project TEXT NOT NULL,
    subcategory TEXT)`,
  fact: `CREATE TABLE IF NOT EXISTS fact (${COMMON_COLS},
    project TEXT)`,
  lesson: `CREATE TABLE IF NOT EXISTS lesson (${COMMON_COLS},
    corrected INTEGER NOT NULL DEFAULT 0,
    project TEXT)`,
  topic: `CREATE TABLE IF NOT EXISTS topic (${COMMON_COLS},
    goal TEXT,
    project TEXT)`,
  rules: `CREATE TABLE IF NOT EXISTS rules (${COMMON_COLS},
    project TEXT)`, // project 可空：null=全局准则（高 importance 全量注入），非空=项目特定（memory_project 注入）
}

/** 记忆库路径：workspace 是项目根（cwd），目录名单独传（防双拼）。 */
export function memoryDbPath(workspace: string, dir = '.dsh-meow'): string {
  return join(workspace, dir, 'memory.db')
}

// ── 工作区库归属标记 / 信任判定（#64-1 工作区记忆库投毒） ──────────────────────
// 记忆库默认落在 `<工作区>/<projectDir>/memory.db`，而工作区常是 clone 来的仓库：
// 仓库作者只要带上一个 memory.db，受害者开第一个会话就会把作者写的 soul/user/rules
// 零交互注入首轮快照（持久 prompt injection）。加固：本插件自建的库在旁边落
// `.owner.json` 归属标记；没有标记的非空库默认**不信任**（不注入、不迁移），
// 除非用户显式配置 trustWorkspaceMemory。同时落一个 `*` 自忽略的 .gitignore，
// 让目录里的任何文件（含 memory.db 与标记本身）都不可能被 git 提交。

/** 库归属标记文件名（与 memory.db 同目录，绝不在工作区根）。 */
export const OWNER_MARKER_FILE = '.owner.json'
/** 自忽略 .gitignore 文件名（内容 `*`）。 */
export const STORE_GITIGNORE_FILE = '.gitignore'
/** 标记 schema 版本（当前唯一版本）。 */
const OWNER_SCHEMA = 1

/** 工作区记忆库信任状态（HARDENING-PLAN §3）：inject/index 据此决定是否注入。 */
export interface StoreTrust {
  trusted: boolean
  reason: 'created' | 'marker' | 'config-trusted' | 'foreign'
}

/** ensureMemoryStore 的配置入参（由 index.ts 从 security.* 透传，本模块不读 config）。 */
export interface EnsureStoreOptions {
  /** 缺失时写自忽略 .gitignore（默认 true）。 */
  autoGitignore: boolean
  /** 用户显式信任一个非本插件创建的库（默认 false）。 */
  trustWorkspaceMemory: boolean
}

/** installId 的固定落点：$DSH_HOME/storages/meow-memory/install-id。
 *  **不用** activeHomeDir()：工作区库随工作区走，而全局目录会被设置页/memory_home
 *  热切换——installId 若跟着全局目录走，切一次目录所有既有工作区库就会认不出自己
 *  的标记、全部退化成 foreign（静默丢记忆）。storages/ 是宿主稳定位置（home 指针
 *  同在此处），不随 meow 全局目录搬移。 */
function installIdPath(): string {
  return join(dshHomeDir(), 'storages', 'meow-memory', 'install-id')
}

let installIdState: { id: string; persisted: boolean } | null = null

/** 本机安装 id：**随机**生成并持久化（全局稳定位置），进程内缓存。随机性是信任标记
 *  的根基——确定性 id（如 hostname+homedir 的 hash）可被定向攻击者推算出来伪造标记，
 *  0.32 review 已把它改回随机。落盘失败时本次仍用随机 id，但 persisted=false → 标记
 *  校验 fail-closed（重启后既有库判 foreign，由用户显式 trustWorkspaceMemory 恢复）。 */
function installId(): { id: string; persisted: boolean } {
  if (installIdState !== null) return installIdState
  try {
    const existing = readFileSync(installIdPath(), 'utf8').trim()
    if (existing.length > 0) {
      installIdState = { id: existing, persisted: true }
      return installIdState
    }
  } catch {
    /* 尚未生成过：走生成分支 */
  }
  const id = randomUUID()
  let persisted = false
  try {
    const p = installIdPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, id + '\n', { encoding: 'utf8', mode: 0o600 })
    persisted = true
  } catch {
    /* 全局目录不可写：随机 id 仅本进程有效，标记校验 fail-closed */
  }
  installIdState = { id, persisted }
  return installIdState
}

interface OwnerMarker {
  schema: number
  installId?: string
  workspace?: string
  createdAt?: number
}

/** 读 `.owner.json`；缺失/损坏/schema 不是 1 → null（按「无标记」处理）。绝不抛出。 */
function readOwnerMarker(projectDir: string): OwnerMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, OWNER_MARKER_FILE), 'utf8')) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.schema !== OWNER_SCHEMA) return null
    return {
      schema: OWNER_SCHEMA,
      installId: typeof parsed.installId === 'string' ? parsed.installId : undefined,
      workspace: typeof parsed.workspace === 'string' ? parsed.workspace : undefined,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
    }
  } catch {
    return null
  }
}

/** 工作区路径归一（review Q2）：先 realpath（解 junction/映射盘/subst 别名），再统一
 *  斜杠/大小写——否则同一目录换个入口就把本机合法标记判成 foreign（静默锁死）。 */
function normalizeStorePath(p: string): string {
  let real = p
  try {
    real = realpathSync.native(p)
  } catch {
    /* 路径不存在/无权限：用原样字符串比较 */
  }
  return real.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 标记是否可信：schema=1 **且 installId 等于本机随机安装 id**；install-id 未落盘
 *  （persisted=false）时无法跨进程校验 → fail-closed。另校验 workspace 归属：把别的
 *  路径的标记连库一起搬过来（或仓库自带他机标记）都会被拒；路径经 realpath 归一，
 *  同一目录的 junction/映射盘入口不会误锁。 */
function markerTrusts(marker: OwnerMarker, workspace: string): boolean {
  if (typeof marker.installId !== 'string' || marker.installId.length === 0) return false
  const me = installId()
  if (!me.persisted || marker.installId !== me.id) return false
  if (typeof marker.workspace === 'string' && marker.workspace.length > 0) {
    if (normalizeStorePath(marker.workspace) !== normalizeStorePath(workspace)) return false
  }
  return true
}

/** 落归属标记（尽力而为）：失败返回 false，由调用方按 best-known 状态处理，绝不抛出。 */
function writeOwnerMarker(projectDir: string, workspace: string): boolean {
  try {
    const me = installId()
    mkdirSync(projectDir, { recursive: true })
    const payload = { schema: OWNER_SCHEMA, installId: me.id, workspace: normalizeStorePath(workspace), createdAt: Date.now() }
    writeFileSync(join(projectDir, OWNER_MARKER_FILE), JSON.stringify(payload, null, 1) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

/** 自忽略 .gitignore：缺失时写 `*\n`；已存在但内容不含 `*` 行时追加一行 `*`
 *  （只改我们自己的记忆目录；防止用户/仓库预置的 `!*` 之类让 memory.db 被提交）。
 *  写失败不阻断（隐私兜底是加分项）。 */
function writeStoreGitignore(projectDir: string, enabled: boolean): void {
  if (!enabled) return
  try {
    mkdirSync(projectDir, { recursive: true })
    const p = join(projectDir, STORE_GITIGNORE_FILE)
    if (!existsSync(p)) {
      writeFileSync(p, '*\n', 'utf8')
      return
    }
    const cur = readFileSync(p, 'utf8')
    if (!cur.split(/\r?\n/).some((line) => line.trim() === '*')) {
      writeFileSync(p, `${cur}${cur.endsWith('\n') || cur.length === 0 ? '' : '\n'}*\n`, 'utf8')
    }
  } catch {
    /* 失败不影响信任判定 */
  }
}

/** 只读探针：库「不存在 / 空 / 有记忆行 / 读不了」。用 readOnly 连接，绝不在陌生库里
 *  跑迁移或写任何数据；level 表都没有行（含全新空 schema）算空。 */
function probeMemoryStore(dbPath: string): 'absent' | 'empty' | 'nonempty' | 'unreadable' {
  if (!existsSync(dbPath)) return 'absent'
  let probe: DatabaseSync | null = null
  try {
    probe = new DatabaseSync(dbPath, { readOnly: true })
    probe.exec('PRAGMA busy_timeout = 2000')
    const tables = new Set(
      (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) =>
        String(r.name),
      ),
    )
    for (const level of LEVELS) {
      if (!tables.has(level)) continue
      const row = probe.prepare(`SELECT COUNT(*) AS n FROM ${level}`).get() as { n: number }
      if (Number(row.n) > 0) return 'nonempty'
    }
    return 'empty'
  } catch {
    return 'unreadable'
  } finally {
    try {
      probe?.close()
    } catch {
      /* already closed */
    }
  }
}

/** 统一信任判定（工作区库 / 全局库共用，0.33.0 抽公共逻辑，不重复三份规则）：
 *   - 有效标记 → trusted:'marker'；
 *   - 库文件**不存在** → open() 建 schema+索引 + 落标记 → 'created'
 *     （已存在的空库也可能是预置 schema+trigger，0.32 review 实证，故只认「不存在」）；
 *   - 已存在但无有效标记 → 'foreign'，或工作区库在用户显式信任时 'config-trusted'。
 *  open() 失败按 foreign fail-closed；本函数绝不抛出。 */
function judgeStoreTrust(
  storeDir: string,
  dbPath: string,
  opts: {
    /** 标记绑定的工作区路径；'' = 无工作区绑定的全局库。 */
    workspace: string
    /** 工作区库专属：config 显式信任非本插件创建的库。全局库恒 false。 */
    trustWorkspaceMemory: boolean
    /** 写自忽略 .gitignore（全局库在自己 home 里，不需要）。 */
    autoGitignore: boolean
    /** 建库动作（schema+索引；可能抛）。 */
    open: () => unknown
    /** 日志里的库类型名。 */
    label: string
    /** foreign 时追加的提示（工作区库指向 config 开关）。 */
    foreignHint: string
  },
): StoreTrust {
  const marker = readOwnerMarker(storeDir)
  if (marker !== null && markerTrusts(marker, opts.workspace)) {
    writeStoreGitignore(storeDir, opts.autoGitignore)
    return { trusted: true, reason: 'marker' }
  }
  const state = probeMemoryStore(dbPath)
  if (state === 'absent') {
    try {
      opts.open()
    } catch (e) {
      console.warn(`[meow-memory] ${opts.label}创建失败（按不可信处理）：${e instanceof Error ? e.message : String(e)}`)
      return { trusted: false, reason: 'foreign' }
    }
    writeStoreGitignore(storeDir, opts.autoGitignore)
    writeOwnerMarker(storeDir, opts.workspace) // 失败也仍是本进程刚建的空库
    return { trusted: true, reason: 'created' }
  }
  if (!opts.trustWorkspaceMemory) {
    console.warn(`[meow-memory] 检测到非本插件创建的${opts.label}（${dbPath}）：默认不注入、不迁移${opts.foreignHint}`)
    return { trusted: false, reason: 'foreign' }
  }
  // 用户显式信任：照常使用；不写标记（库不是我们建的，写标记会混淆归属）。
  writeStoreGitignore(storeDir, opts.autoGitignore)
  return { trusted: true, reason: 'config-trusted' }
}

/** 工作区级信任缓存：键 = 精确 (workspace, dir)，进程生命周期内有效。
 *  ensureMemoryStore 是同步函数（Node 单线程），两个并发 pre-step 实际串行执行，
 *  第一个返回前已写入缓存，第二个直接命中——无需额外 in-flight 锁。 */
const storeTrustCache = new Map<string, StoreTrust>()

function storeKey(workspace: string, dir: string): string {
  return `${workspace}\u0000${dir}`
}

export class MemoryDb {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    // 多实例共享同一 memory.db 是设计内场景（dream.ts 跨实例注释、claimCheckGate）。
    // node:sqlite 默认 busy_timeout=0：写锁冲突 0ms 直接抛 "database is locked"（2026-09-10
    // 实测探针）。WAL 下自旋等待 5s，绝大多数瞬时争用直接消失；超时仍抛由上层兜底。
    this.db.exec('PRAGMA busy_timeout = 5000')
    for (const level of LEVELS) this.db.exec(SCHEMAS[level])
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at INTEGER NOT NULL,
      session_id TEXT,
      summary TEXT,
      changes TEXT,
      note TEXT
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS windows (
      session_id TEXT PRIMARY KEY,
      workspace TEXT,
      last_event_time INTEGER,
      last_dream_time INTEGER,
      dream_owner TEXT,
      dream_started_at INTEGER,
      dream_progress_at INTEGER,
      dream_group_idx INTEGER,
      dream_T INTEGER
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_meta (
      key TEXT PRIMARY KEY,
      value INTEGER
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS dream_skip (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      skip_dream INTEGER NOT NULL DEFAULT 1,
      skip_inject INTEGER NOT NULL DEFAULT 0,
      skip_write INTEGER NOT NULL DEFAULT 0
    )`)
    this.upgrade()
    this.createIndexes()
  }

  /** 幂等升级：缺列补列；旧 UUID id 按 created_at 重排为时间前缀 id；
   *  v0.7.0：dream_at 列并入 updated_at（记忆时间戳=最后更新时间）后删除。 */
  private upgrade(): void {
    for (const level of LEVELS) {
      const cols = new Set(
        (this.db.prepare(`PRAGMA table_info(${level})`).all() as Array<{ name: string }>).map((c) => c.name),
      )
      if (cols.has('dream_at')) {
        // 旧库：记忆时间戳数据合并进 updated_at（取两者较新值），再删 dream_at 列。
        this.db.exec(`UPDATE ${level} SET updated_at = MAX(COALESCE(updated_at, 0), COALESCE(dream_at, 0)) WHERE dream_at IS NOT NULL`)
        this.db.exec(`ALTER TABLE ${level} DROP COLUMN dream_at`)
      }
      if (level === 'project' && !cols.has('subcategory')) {
        this.db.exec('ALTER TABLE project ADD COLUMN subcategory TEXT')
      }
      if (level === 'topic' && !cols.has('project')) {
        this.db.exec('ALTER TABLE topic ADD COLUMN project TEXT')
      }
      // 0.35：语义检索向量列（可空）。老库就地补列，存量行保持 NULL（= 待回填）。
      if (!cols.has('embedding')) {
        this.db.exec(`ALTER TABLE ${level} ADD COLUMN embedding TEXT`)
      }
      // 0.40：条目级触发关键词模式（any/all/min）+ 最少命中数。老库补列，存量行 any/1。
      if (!cols.has('trigger_mode')) {
        this.db.exec(`ALTER TABLE ${level} ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'any'`)
      }
      if (!cols.has('trigger_min')) {
        this.db.exec(`ALTER TABLE ${level} ADD COLUMN trigger_min INTEGER NOT NULL DEFAULT 1`)
      }
      if (!cols.has('trigger_keywords')) {
        this.db.exec(`ALTER TABLE ${level} ADD COLUMN trigger_keywords TEXT NOT NULL DEFAULT '[]'`)
      }
      // 旧 UUID（不以 9 位时间前缀开头）→ 按 created_at 重写 id
      const legacy = this.db.prepare(`SELECT id FROM ${level}`).all() as Array<{ id: string }>
      for (const { id } of legacy) {
        if (/^[0-9a-z]{9}-/.test(id)) continue
        const created = (this.db.prepare(`SELECT created_at FROM ${level} WHERE id = ?`).get(id) as { created_at: number }).created_at
        this.db.prepare(`UPDATE ${level} SET id = ? WHERE id = ?`).run(newId(created), id)
      }
    }
    // windows 表：v0.10.0 起用租约（dream_owner/progress_at/...）替代 dream_pending 布尔。
    // 老库补列；老「dream_pending=1」迁移为「过期租约」——下个检查周期按租约过期补收尾。
    const wCols = new Set(
      (this.db.prepare('PRAGMA table_info(windows)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    for (const [col, ddl] of [
      ['dream_owner', 'TEXT'],
      ['dream_started_at', 'INTEGER'],
      ['dream_progress_at', 'INTEGER'],
      ['dream_group_idx', 'INTEGER'],
      ['dream_T', 'INTEGER'],
    ] as const) {
      if (!wCols.has(col)) this.db.exec(`ALTER TABLE windows ADD COLUMN ${col} ${ddl}`)
    }
    if (wCols.has('dream_pending')) {
      this.db.exec(`UPDATE windows SET dream_owner = 'legacy-pending', dream_started_at = 0, dream_progress_at = 0, dream_group_idx = 0, dream_T = last_event_time WHERE dream_pending = 1 AND dream_owner IS NULL`)
    }
    // dream_skip 表：v0.30.0 起升级为「记忆参与门控」（issue #38）——原有「跳过 dream」
    // 语义显式化为 skip_dream 列，新增 skip_inject / skip_write。老库补列：存量行的
    // 语义就是「跳过 dream」（旧行仅在该语义下产生），skip_dream 补默认 1 正确。
    const sCols = new Set(
      (this.db.prepare('PRAGMA table_info(dream_skip)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    for (const [col, ddl] of [
      ['skip_dream', 'INTEGER NOT NULL DEFAULT 1'],
      ['skip_inject', 'INTEGER NOT NULL DEFAULT 0'],
      ['skip_write', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!sCols.has(col)) this.db.exec(`ALTER TABLE dream_skip ADD COLUMN ${col} ${ddl}`)
    }
    // dream_log 表：v0.32.0 起记 session_id（按会话查整理历史 / 索引）。
    // 老库补列（可空列，ALTER 兼容）；新库 DDL 已含该列。
    const dCols = new Set(
      (this.db.prepare('PRAGMA table_info(dream_log)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    if (!dCols.has('session_id')) this.db.exec('ALTER TABLE dream_log ADD COLUMN session_id TEXT')
  }

  /** 建索引（#设计质量：无索引 → 每轮命中多次全表扫描）：status+updated_at 复用于
   *  active 列表与时间戳排序；project 用于项目全貌/过滤；dream_log/windows 按会话查。
   *  全部 IF NOT EXISTS，老库打开即自动补齐；列不存在的情况由 upgrade() 先补列，
   *  故此处建索引时列一定在（LEVELS 由本模块枚举，不拼外部输入）。 */
  private createIndexes(): void {
    const projectLevels = new Set<Level>(['project', 'fact', 'lesson', 'topic', 'rules'])
    for (const level of LEVELS) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${level}_status_updated ON ${level} (status, updated_at)`)
      if (projectLevels.has(level)) this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${level}_project ON ${level} (project)`)
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_dream_log_session ON dream_log (session_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_windows_session ON windows (session_id)')
  }

  /** 新库（memories 全空）判定：迁移只在库刚创建时执行一次。 */
  isFresh(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM soul').get() as { n: number }
    return row.n === 0
  }

  /** VACUUM INTO 一致性快照到目标路径（#37 可选备份；目标已存在会抛，调用方先轮转）。
   *  WAL 下安全：快照含 WAL 内容，读连接一致性由 SQLite 保证。 */
  vacuumInto(target: string): void {
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  }

  insert(row: { level: Level; content: string } & Partial<MemoryRow>): MemoryRow {
    const now = Date.now()
    const full: MemoryRow = {
      id: row.id ?? newId(now),
      level: row.level,
      title: row.title ?? null,
      content: row.content,
      importance: row.importance ?? 1,
      keywords: row.keywords ?? [],
      status: row.status ?? 'active',
      trigger_mode: row.trigger_mode ?? 'any',
      trigger_min: row.trigger_min ?? 1,
      trigger_keywords: row.trigger_keywords ?? [],
      corrected: row.corrected ?? 0,
      project: row.project ?? null,
      subcategory: row.subcategory ?? null,
      goal: row.goal ?? null,
      source_session: row.source_session ?? null,
      hit_count: row.hit_count ?? 0,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
      last_accessed_at: row.last_accessed_at ?? null,
      embedding: row.embedding ?? null,
    }
    this.writeInsert(full)
    return full
  }

  /** 迁移专用（Phase 2）：按调用方给的 id / 时间戳 / 全部字段**原样**落库——
   *  不补默认值、不改时间戳（工作区库 → 全局库必须保 id 才能去重 + 归档原行）。
   *  id 已存在会抛（SQLite 主键冲突），由调用方 try/catch 决定跳过。 */
  insertRow(row: MemoryRow & { level: Level }): MemoryRow {
    this.writeInsert(row)
    return row
  }

  /** insert()/insertRow() 共用的一条 INSERT（差异列按 level 特化；表名来自 LEVELS）。
   *  0.35 起带 embedding 列：调用方给的向量原样序列化，非法/缺省写 NULL。 */
  private writeInsert(full: MemoryRow): void {
    this.db
      .prepare(
        `INSERT INTO ${full.level} (id, title, content, importance, keywords, status, trigger_mode, trigger_min, trigger_keywords, source_session, hit_count, created_at, updated_at, last_accessed_at, embedding
          ${full.level === 'project' ? ', project, subcategory' : ''}
          ${full.level === 'fact' || full.level === 'lesson' || full.level === 'rules' ? ', project' : ''}
          ${full.level === 'lesson' ? ', corrected' : ''}
          ${full.level === 'topic' ? ', goal, project' : ''}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          ${full.level === 'project' ? ', ?, ?' : ''}
          ${full.level === 'fact' || full.level === 'lesson' || full.level === 'rules' ? ', ?' : ''}
          ${full.level === 'lesson' ? ', ?' : ''}
          ${full.level === 'topic' ? ', ?, ?' : ''}
        )`,
      )
      .run(
        full.id,
        full.title,
        full.content,
        full.importance,
        JSON.stringify(full.keywords),
        full.status,
        full.trigger_mode ?? 'any',
        full.trigger_min ?? 1,
        JSON.stringify(full.trigger_keywords ?? []),
        full.source_session,
        full.hit_count,
        full.created_at,
        full.updated_at,
        full.last_accessed_at,
        serializeEmbedding(full.embedding),
        ...(full.level === 'project' ? [full.project ?? '', full.subcategory] : []),
        ...(full.level === 'fact' || full.level === 'lesson' || full.level === 'rules' ? [full.project] : []),
        ...(full.level === 'lesson' ? [full.corrected] : []),
        ...(full.level === 'topic' ? [full.goal, full.project] : []),
      )
  }

  /** 跨表定位（UUID 全局唯一，扫描全部表）。id 支持 8 位前缀匹配
   *  （快照/检索结果给的是截断 id；前缀碰撞时取第一个）。 */
  findById(id: string): { row: MemoryRow; level: Level } | undefined {
    const prefix = id.length < 36
    for (const level of LEVELS) {
      const sql = prefix ? `SELECT * FROM ${level} WHERE id LIKE ?` : `SELECT * FROM ${level} WHERE id = ?`
      const r = this.db.prepare(sql).get(prefix ? `${id}%` : id) as Record<string, unknown> | undefined
      if (r) return { row: this.fromRow(level, r), level }
    }
    return undefined
  }

  /** 短 id 全量解析（#62）：返回全部前缀命中（跨表）。findById 首条语义只配只读展示；
   *  写路径必须走这里做歧义拒绝——findById 首条 + 拿解析出的全 id 去 update，会绕过
   *  update 内部的 LIKE 歧义守卫，静默改错条目。 */
  findByIdAll(id: string): Array<{ row: MemoryRow; level: Level }> {
    const prefix = id.length < 36
    const out: Array<{ row: MemoryRow; level: Level }> = []
    for (const level of LEVELS) {
      const sql = prefix ? `SELECT * FROM ${level} WHERE id LIKE ?` : `SELECT * FROM ${level} WHERE id = ?`
      const rows = this.db.prepare(sql).all(prefix ? `${id}%` : id) as Record<string, unknown>[]
      for (const r of rows) out.push({ row: this.fromRow(level, r), level })
    }
    return out
  }

  update(level: Level, id: string, patch: MemoryPatch): boolean {
    const sets: string[] = []
    const args: unknown[] = []
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`)
      args.push(val)
    }
    if (patch.content !== undefined) push('content', patch.content)
    if (patch.title !== undefined) push('title', patch.title)
    if (patch.importance !== undefined) push('importance', patch.importance)
    if (patch.keywords !== undefined) push('keywords', JSON.stringify(patch.keywords))
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.trigger_mode !== undefined) push('trigger_mode', patch.trigger_mode)
    if (patch.trigger_min !== undefined) push('trigger_min', patch.trigger_min)
    if (patch.trigger_keywords !== undefined) push('trigger_keywords', JSON.stringify(patch.trigger_keywords))
    if (patch.corrected !== undefined && level === 'lesson') push('corrected', patch.corrected)
    if (patch.project !== undefined && (level === 'project' || level === 'fact' || level === 'lesson' || level === 'rules')) {
      push('project', patch.project)
    }
    if (patch.subcategory !== undefined && level === 'project') push('subcategory', patch.subcategory)
    if (patch.goal !== undefined && level === 'topic') push('goal', patch.goal)
    if (patch.project !== undefined && level === 'topic') push('project', patch.project)
    if (sets.length === 0) return false
    push('updated_at', Date.now()) // 记忆时间戳 = 最后更新时间（任何 update 都刷新）
    // 短 id = 模型截断输出（findById/update 共享的前缀匹配语义）。前缀 LIKE 可能命中
    // 多行——歧义更新会静默改掉一批无关注记（#23 复盘顺带加固）：先解析，唯一命中
    // 升级为全 id 精确更新（语义不变，不再走 LIKE），多行命中拒绝（warn 留痕），
    // 零命中与旧行为一致返回 false。
    let targetId = id
    if (id.length < 36) {
      const matches = this.db.prepare(`SELECT id FROM ${level} WHERE id LIKE ?`).all(`${id}%`) as Array<{ id: string }>
      if (matches.length > 1) {
        console.warn(`[meow-memory] update 拒绝歧义短 id：${level} 前缀 "${id}" 命中 ${matches.length} 行，请用完整 id`)
        return false
      }
      if (matches.length === 0) return false
      targetId = matches[0].id
    }
    const res = this.db.prepare(`UPDATE ${level} SET ${sets.join(', ')} WHERE id = ?`).run(...args, targetId)
    return res.changes > 0
  }

  /** 硬删除一行（memory_forget 的 delete 档）：返回是否真的删掉。
   *  短 id 走与 update 相同的「前缀唯一才解析」口径：歧义/未知一律 false，绝不抛出。 */
  deleteRow(level: Level, id: string): boolean {
    if (!(LEVELS as readonly string[]).includes(level)) return false
    if (typeof id !== 'string' || id.length === 0) return false
    let targetId = id
    if (id.length < 36) {
      let matches: Array<{ id: string }>
      try {
        matches = this.db.prepare(`SELECT id FROM ${level} WHERE id LIKE ?`).all(`${id}%`) as Array<{ id: string }>
      } catch {
        return false
      }
      if (matches.length !== 1) {
        if (matches.length > 1) console.warn(`[meow-memory] delete 拒绝歧义短 id：${level} 前缀 "${id}" 命中 ${matches.length} 行，请用完整 id`)
        return false
      }
      targetId = matches[0].id
    }
    try {
      return this.db.prepare(`DELETE FROM ${level} WHERE id = ?`).run(targetId).changes > 0
    } catch {
      return false
    }
  }

  /** 写入/清除单条 embedding（0.35 语义检索数据层）：只改 embedding 列——**不刷新**
   *  updated_at / hit_count（后台回填不得污染"记忆时间戳"与命中统计）。
   *  传 null = 清除；空数组/含非有限数的非法向量 → false（不写、不清）。
   *  短 id 走 update 同款「前缀唯一才解析」口径：歧义/未知 → false，绝不抛出。 */
  setEmbedding(level: Level, id: string, vec: number[] | null): boolean {
    if (!(LEVELS as readonly string[]).includes(level)) return false
    if (typeof id !== 'string' || id.length === 0) return false
    const value = vec === null ? null : serializeEmbedding(vec)
    if (vec !== null && value === null) return false
    let targetId = id
    if (id.length < 36) {
      let matches: Array<{ id: string }>
      try {
        matches = this.db.prepare(`SELECT id FROM ${level} WHERE id LIKE ?`).all(`${id}%`) as Array<{ id: string }>
      } catch {
        return false
      }
      if (matches.length !== 1) {
        if (matches.length > 1) {
          console.warn(`[meow-memory] setEmbedding 拒绝歧义短 id：${level} 前缀 "${id}" 命中 ${matches.length} 行，请用完整 id`)
        }
        return false
      }
      targetId = matches[0].id
    }
    try {
      return this.db.prepare(`UPDATE ${level} SET embedding = ? WHERE id = ?`).run(value, targetId).changes > 0
    } catch {
      return false
    }
  }

  list(level: Level, opts: { status?: Status; project?: string } = {}): MemoryRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.status) {
      where.push('status = ?')
      args.push(opts.status)
    }
    if (opts.project !== undefined && (level === 'project' || level === 'fact' || level === 'lesson' || level === 'rules')) {
      where.push('project = ?')
      args.push(opts.project)
    }
    const sql = `SELECT * FROM ${level}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[]
    return rows.map((r) => this.fromRow(level, r))
  }

  /** 待回填 embedding 的条目（0.35 语义检索后台回填用）：status='active' 且 embedding
   *  为 NULL（兼容历史空串），按记忆时间戳从新到旧；limit 夹在 1..1000，避免一次全库。 */
  listMissingEmbedding(level: Level, limit = 200): MemoryRow[] {
    if (!(LEVELS as readonly string[]).includes(level)) return []
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM ${level} WHERE status = 'active' AND (embedding IS NULL OR embedding = '') ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(n) as Record<string, unknown>[]
      return rows.map((r) => this.fromRow(level, r))
    } catch {
      return []
    }
  }

  /** 全部 active 条目（dream / 注入用），按 level 分组。 */
  allActive(): Record<Level, MemoryRow[]> {
    const out = {} as Record<Level, MemoryRow[]>
    for (const level of LEVELS) out[level] = this.list(level, { status: 'active' })
    return out
  }

  /** 可检索条目：active 全部；project.subcategory='todo' 的 stale 视为 done 参与检索。
   *  （用户拍板：todo 过时=finish 可检索，其他类别过时不检索。） */
  listSearchable(level: Level): MemoryRow[] {
    const active = this.list(level, { status: 'active' })
    if (level !== 'project') return active
    const todoDone = (
      this.db.prepare(`SELECT * FROM project WHERE status = 'stale' AND subcategory = 'todo'`).all() as Record<string, unknown>[]
    ).map((r) => this.fromRow('project', r))
    return [...active, ...todoDone]
  }

  bumpHit(level: Level, id: string): void {
    this.db.prepare(`UPDATE ${level} SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?`).run(
      Date.now(),
      id,
    )
  }

  count(level: Level): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${level}`).get() as { n: number }
    return row.n
  }

  /** 全部出现过（含已过时）的项目名：project/fact/lesson/topic/rules 五表的 project 列并集
   *  （多值逗号分隔展开；全局标记不是项目，projectList 已排除）。供记忆导引列出"用户的所有 project"。 */
  listProjectNames(): string[] {
    const names = new Set<string>()
    for (const level of ['project', 'fact', 'lesson', 'topic', 'rules'] as const) {
      const rows = this.db.prepare(`SELECT project FROM ${level} WHERE project IS NOT NULL AND project != ''`).all() as Array<{ project: string }>
      for (const r of rows) for (const n of projectList(r.project)) names.add(n)
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  logDream(summary: string, changes: unknown, note = '', sessionId: string | null = null): void {
    this.db
      .prepare('INSERT INTO dream_log (run_at, session_id, summary, changes, note) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), sessionId, summary, JSON.stringify(changes), note)
  }

  recentDream(hours: number): boolean {
    const row = this.db
      .prepare('SELECT run_at FROM dream_log ORDER BY run_at DESC LIMIT 1')
      .get() as { run_at: number } | undefined
    if (!row) return false
    return Date.now() - row.run_at < hours * 3600_000
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  /** 子 agent / dream 用的只读快照：把一组行转成纯数据（无 db 依赖）。 */
  snapshot(level: Level, opts: { status?: Status } = {}): MemoryRow[] {
    return this.list(level, opts)
  }

  // ── windows 窗口表（dream 判定：跨重启持久化） ───────────────────────────

  touchWindow(sessionId: string, workspace: string, eventTime: number): void {
    this.db
      .prepare(`INSERT INTO windows (session_id, workspace, last_event_time, last_dream_time) VALUES (?, ?, ?, NULL)
        ON CONFLICT(session_id) DO UPDATE SET workspace = excluded.workspace, last_event_time = MAX(last_event_time, excluded.last_event_time)`)
      .run(sessionId, workspace, eventTime)
  }

  setWindowDream(sessionId: string, time: number): void {
    this.db.prepare(`UPDATE windows SET last_dream_time = ? WHERE session_id = ?`).run(time, sessionId)
  }

  /** 原子抢占 dream 租约（跨进程/实例防重复 start）：返回 true 表示抢占成功（可 start）。
   *  条件：无租约（owner IS NULL）或租约已过期（progress_at 超 leaseMs）。owner 只用于抢占判断 + 诊断；
   *  推进/收尾按「sessionId + 租约未过期」判定，不校验 owner。 */
  claimDream(sessionId: string, owner: string, T: number, leaseMs: number): boolean {
    this.db
      .prepare(`INSERT OR IGNORE INTO windows (session_id, workspace, last_event_time, last_dream_time) VALUES (?, NULL, 0, NULL)`)
      .run(sessionId)
    const now = Date.now()
    return (
      this.db
        .prepare(
          `UPDATE windows SET dream_owner = ?, dream_started_at = ?, dream_progress_at = ?, dream_group_idx = 0, dream_T = ?
           WHERE session_id = ? AND (dream_owner IS NULL OR dream_progress_at IS NULL OR dream_progress_at <= ?)`,
        )
        .run(owner, now, now, T, sessionId, now - leaseMs).changes === 1
    )
  }

  /** dream 收尾：清租约 + 记 last_dream_time（dream 完成时刻）。 */
  finishDream(sessionId: string, time: number): void {
    this.db
      .prepare(`UPDATE windows SET dream_owner = NULL, dream_started_at = NULL, dream_progress_at = NULL, dream_group_idx = NULL, dream_T = NULL, last_dream_time = ? WHERE session_id = ?`)
      .run(time, sessionId)
    // dream 收尾（完成/中止/封存）= 本轮尝试周期结束：失败计数清零（issue #36）。
    this.clearDreamFailure(sessionId)
    this.delDreamMeta(`dreamplan:${sessionId}`) // 轮次计划快照（#69）随收尾清理
  }

  /** dream 失败释放：只清租约，**不动 last_dream_time**——窗口保持「待整理」状态，
   *  下个检查周期 windowNeedsDream 仍成立即自动重试。
   *  与 finishDream 的语义区分：finish=完成/用户中止（封存，last_dream_time=收尾时刻）；
   *  release=执行失败（网络/服务瞬态故障，非用户意愿，2026-09-05 教训：把失败窗口
   *  按 aborted 封存会让一次断网整夜吞掉所有窗口的 dream 且永不重试）。 */
  releaseDream(sessionId: string): void {
    this.db
      .prepare(`UPDATE windows SET dream_owner = NULL, dream_started_at = NULL, dream_progress_at = NULL, dream_group_idx = NULL, dream_T = NULL WHERE session_id = ?`)
      .run(sessionId)
    this.delDreamMeta(`dreamplan:${sessionId}`) // 失败释放：本轮计划作废，下轮重排（#69）
  }

  // ── dream 失败计数（issue #36）──────────────────────────────────────────────
  // 存 dream_meta（KV，跨实例/重启共享）：`dreamfail_c:<sid>` = 连续失败次数、
  // `dreamfail_t:<sid>` = 计数对应的整理范围 T。T 变了（窗口有新活动 → 新一轮整理
  // 范围不同）自动从 1 重计；dream 收尾（finishDream）清零。与 releaseDream 的
  // 「失败不封存、可重试」语义配套：失败只释放，连续达上限（DREAM_MAX_ATTEMPTS，
  // dream.ts）才封存止损——既不让一次故障静默吞掉整窗记忆，也不让持续性故障
  // 变成无限重试烧 token。

  /** 记一次 dream 失败，返回当前连续失败次数（同 T 累加，T 变化重计）。 */
  recordDreamFailure(sessionId: string, T: number): number {
    const prevT = this.db.prepare(`SELECT value FROM dream_meta WHERE key = ?`).get(`dreamfail_t:${sessionId}`) as { value: number | null } | undefined
    const prevC = this.db.prepare(`SELECT value FROM dream_meta WHERE key = ?`).get(`dreamfail_c:${sessionId}`) as { value: number | null } | undefined
    const count = prevT !== undefined && prevT.value === T && prevC !== undefined && typeof prevC.value === 'number' && prevC.value >= 1
      ? prevC.value + 1
      : 1
    this.db
      .prepare(`INSERT INTO dream_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`dreamfail_t:${sessionId}`, T)
    this.db
      .prepare(`INSERT INTO dream_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`dreamfail_c:${sessionId}`, count)
    return count
  }

  /** 清 dream 失败计数（finishDream 收尾时自动调用；一般无需手动调）。 */
  clearDreamFailure(sessionId: string): void {
    this.db.prepare(`DELETE FROM dream_meta WHERE key = ?`).run(`dreamfail_t:${sessionId}`)
    this.db.prepare(`DELETE FROM dream_meta WHERE key = ?`).run(`dreamfail_c:${sessionId}`)
  }

  /** dream_meta 通用读写（KV，跨实例/重启共享）。当前用于轮次计划快照
   *  `dreamplan:<sid>`（#69）。 */
  setDreamMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO dream_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  }

  getDreamMeta(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM dream_meta WHERE key = ?`).get(key) as { value: unknown } | undefined
    return typeof r?.value === 'string' ? r.value : undefined
  }

  delDreamMeta(key: string): void {
    this.db.prepare(`DELETE FROM dream_meta WHERE key = ?`).run(key)
  }

  /** 是否有进行中/未收尾的 dream（租约存在，无论是否过期）。 */
  isDreamPending(sessionId: string): boolean {
    const row = this.db.prepare(`SELECT dream_owner FROM windows WHERE session_id = ?`).get(sessionId) as
      | { dream_owner: string | null }
      | undefined
    return row?.dream_owner != null
  }

  /** 读窗口当前 dream 租约；无租约返回 null。 */
  getDreamLease(sessionId: string): { owner: string; started_at: number; progress_at: number; group_idx: number; T: number } | null {
    const row = this.db
      .prepare(`SELECT dream_owner, dream_started_at, dream_progress_at, dream_group_idx, dream_T FROM windows WHERE session_id = ?`)
      .get(sessionId) as
      | { dream_owner: string | null; dream_started_at: number | null; dream_progress_at: number | null; dream_group_idx: number | null; dream_T: number | null }
      | undefined
    if (!row || row.dream_owner == null) return null
    return {
      owner: row.dream_owner,
      started_at: row.dream_started_at ?? 0,
      progress_at: row.dream_progress_at ?? 0,
      group_idx: row.dream_group_idx ?? 0,
      T: row.dream_T ?? 0,
    }
  }

  /** CAS 推进租约：group_idx +1 并刷新心跳。多实例同收 turn-stopping 时只有一个成功。 */
  advanceDreamLease(sessionId: string, fromIdx: number, leaseMs: number): boolean {
    const now = Date.now()
    return (
      this.db
        .prepare(
          `UPDATE windows SET dream_group_idx = dream_group_idx + 1, dream_progress_at = ?
           WHERE session_id = ? AND dream_group_idx = ? AND dream_owner IS NOT NULL AND dream_progress_at > ?`,
        )
        .run(now, sessionId, fromIdx, now - leaseMs).changes === 1
    )
  }

  /** 轮内租约心跳：只刷新 progress_at，不动 group_idx（推进仍归 advanceDreamLease 的 CAS）。
   *  安全性：只 touch 梦的活跃租约——finalize/release/abort 清租约后 changes=0，
   *  调用方据此自动停表，僵尸 dream 永远不会被心跳续命。 */
  touchDreamLease(sessionId: string): boolean {
    return this.db
      .prepare(`UPDATE windows SET dream_progress_at = ? WHERE session_id = ? AND dream_owner IS NOT NULL`)
      .run(Date.now(), sessionId).changes === 1
  }

  // ── dream_skip 门控表（v0.16.0 跳过 dream → v0.30.0 升级为「记忆参与」三档门控，#38）──
  // 一行 = 一个窗口的门控状态：skip_dream（跳过整理：自动 dream + 自动反思）、
  // skip_inject（停止读入：首轮快照/命中/重注入/search/read 等读入口）、skip_write
  // （停止写入：普通轮的 remember/update；整理轮写入跟随整理档）。三档全 false 删行。

  /** 读某窗口的门控状态（无行 = 三档全开）。 */
  getMemoryScope(sessionId: string): { dream: boolean; inject: boolean; write: boolean } {
    const row = this.db
      .prepare(`SELECT skip_dream, skip_inject, skip_write FROM dream_skip WHERE session_id = ?`)
      .get(sessionId) as { skip_dream: number; skip_inject: number; skip_write: number } | undefined
    if (row === undefined) return { dream: false, inject: false, write: false }
    return { dream: row.skip_dream === 1, inject: row.skip_inject === 1, write: row.skip_write === 1 }
  }

  /** 设置某窗口某档的开关；三档全 false 时删行（表只存有门槛的窗口）。
   *  新行显式插 0（DDL 的 DEFAULT 1 只服务于老行迁移——老行语义就是 dream 跳过）。 */
  setMemoryScopeField(sessionId: string, field: 'dream' | 'inject' | 'write', value: boolean): void {
    const col = field === 'dream' ? 'skip_dream' : field === 'inject' ? 'skip_inject' : 'skip_write'
    this.db
      .prepare(`INSERT INTO dream_skip (session_id, created_at, skip_dream, skip_inject, skip_write) VALUES (?, ?, 0, 0, 0) ON CONFLICT(session_id) DO NOTHING`)
      .run(sessionId, Date.now())
    this.db.prepare(`UPDATE dream_skip SET ${col} = ? WHERE session_id = ?`).run(value ? 1 : 0, sessionId)
    const scope = this.getMemoryScope(sessionId)
    if (!scope.dream && !scope.inject && !scope.write) {
      this.db.prepare(`DELETE FROM dream_skip WHERE session_id = ?`).run(sessionId)
    }
  }

  /** 全部门控状态（client 全量对账用）。 */
  listMemoryScopes(): Array<{ session_id: string; dream: boolean; inject: boolean; write: boolean }> {
    const rows = this.db
      .prepare(`SELECT session_id, skip_dream, skip_inject, skip_write FROM dream_skip
        WHERE skip_dream = 1 OR skip_inject = 1 OR skip_write = 1`)
      .all() as Array<{ session_id: string; skip_dream: number; skip_inject: number; skip_write: number }>
    return rows.map((r) => ({ session_id: r.session_id, dream: r.skip_dream === 1, inject: r.skip_inject === 1, write: r.skip_write === 1 }))
  }

  /** 设置/清除某会话的跳过标记（v0.30.0 起委派门控表 dream 档；旧调用点/测试兼容）。 */
  setDreamSkip(sessionId: string, skip: boolean): void {
    this.setMemoryScopeField(sessionId, 'dream', skip)
  }

  /** 该会话是否被跳过自动 dream（只挡定时器自动触发；手动触发不受限）。 */
  isDreamSkipped(sessionId: string): boolean {
    return this.getMemoryScope(sessionId).dream
  }

  /** 全部被跳过的会话 id（client 全量对账用，v0.30.0 起为 dream 档子集）。 */
  listDreamSkips(): string[] {
    return this.listMemoryScopes().filter((s) => s.dream).map((s) => s.session_id)
  }

  // ── 全局检查门（dream 定时器防叠加） ─────────────────────────────────────
  // 根因：插件热重载/多实例并存时，dispose 未必清理旧 setInterval → 多个定时器
  // 叠加 → 检查频率远高于 checkMinutes，同一窗口被反复 start。检查动作本身
  // 必须幂等：DB 原子抢占"检查窗口"（minIntervalMs 内只有一个实例通过），
  // 与 startWindowDream 的 claimDream（start 幂等）+ recoverInterruptedDream
  // （中断自愈）组成三层防重复闭环。

  /** 原子抢占一次检查窗口：minIntervalMs 内只有一个调用方返回 true。 */
  claimCheckGate(minIntervalMs: number): boolean {
    this.db.prepare(`INSERT OR IGNORE INTO dream_meta (key, value) VALUES ('last_check', 0)`).run()
    const now = Date.now()
    return (
      this.db
        .prepare(`UPDATE dream_meta SET value = ? WHERE key = 'last_check' AND value <= ?`)
        .run(now, now - minIntervalMs).changes === 1
    )
  }

  getWindow(sessionId: string): { session_id: string; workspace: string; last_event_time: number; last_dream_time: number | null } | undefined {
    return this.db.prepare(`SELECT * FROM windows WHERE session_id = ?`).get(sessionId) as
      | { session_id: string; workspace: string; last_event_time: number; last_dream_time: number | null }
      | undefined
  }

  listWindows(): Array<{ session_id: string; workspace: string; last_event_time: number; last_dream_time: number | null }> {
    return this.db.prepare(`SELECT * FROM windows ORDER BY last_event_time DESC`).all() as Array<{
      session_id: string
      workspace: string
      last_event_time: number
      last_dream_time: number | null
    }>
  }

  /** 本窗口建立的全部条目 id（dream 收尾：updated_at 批量写入用）。 */
  idsBySession(sessionId: string): Array<{ level: Level; id: string }> {
    const out: Array<{ level: Level; id: string }> = []
    for (const level of LEVELS) {
      const rows = this.db.prepare(`SELECT id FROM ${level} WHERE source_session = ?`).all(sessionId) as Array<{ id: string }>
      for (const r of rows) out.push({ level, id: r.id })
    }
    return out
  }

  /** 收养子会话建立的条目（Phase 2 Round 2 隔离子 agent dream）：把 fromSessionId 的
   *  source_session 改成 toSessionId（父窗口），让 dream 收尾的 idsBySession/stampDream
   *  能归属到父窗口。逐表 best-effort：单表失败只 warn、绝不抛出；未知会话自然返回 0。 */
  adoptSessionEntries(fromSessionId: string, toSessionId: string): number {
    if (typeof fromSessionId !== 'string' || typeof toSessionId !== 'string') return 0
    if (fromSessionId.length === 0 || toSessionId.length === 0 || fromSessionId === toSessionId) return 0
    let total = 0
    for (const level of LEVELS) {
      try {
        total += this.db.prepare(`UPDATE ${level} SET source_session = ? WHERE source_session = ?`).run(toSessionId, fromSessionId).changes
      } catch (e) {
        console.warn(`[meow-memory] adoptSessionEntries ${level} 失败（已跳过该表）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return total
  }

  /** 批量写记忆时间戳（dream 收尾：本窗口条目 updated_at = 窗口最后对话时间 T；
   *   MAX 防止覆盖 T 之后的 memory_update 刷新）。 */
  stampDream(sessionId: string, time: number): number {
    let n = 0
    for (const { level, id } of this.idsBySession(sessionId)) {
      n += this.db.prepare(`UPDATE ${level} SET updated_at = MAX(updated_at, ?) WHERE id = ?`).run(time, id).changes
    }
    return n
  }

  private fromRow(level: Level, r: Record<string, unknown>): MemoryRow {
    let keywords: string[] = []
    try {
      keywords = JSON.parse(String(r.keywords ?? '[]'))
    } catch {
      keywords = []
    }
    return {
      id: String(r.id),
      level,
      title: r.title == null ? null : String(r.title),
      content: String(r.content),
      importance: Number(r.importance ?? 1),
      keywords,
      status: String(r.status) as Status,
      trigger_mode: (String(r.trigger_mode ?? 'any') === 'all' || String(r.trigger_mode ?? 'any') === 'min' ? String(r.trigger_mode) : 'any') as 'any' | 'all' | 'min',
      trigger_min: Math.max(1, Number(r.trigger_min ?? 1) || 1),
      trigger_keywords: (() => {
        try {
          const parsed = JSON.parse(String(r.trigger_keywords ?? '[]'))
          return Array.isArray(parsed) ? parsed.map((k) => String(k)) : []
        } catch {
          return []
        }
      })(),
      corrected: Number(r.corrected ?? 0),
      project: r.project == null ? null : String(r.project),
      subcategory: r.subcategory == null ? null : (String(r.subcategory) as ProjectSubcategory),
      goal: r.goal == null ? null : String(r.goal),
      source_session: r.source_session == null ? null : String(r.source_session),
      hit_count: Number(r.hit_count ?? 0),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
      last_accessed_at: r.last_accessed_at == null ? null : Number(r.last_accessed_at),
      embedding: parseEmbedding(r.embedding),
    }
  }
}

// ── 按工作区缓存（插件无全局 cwd；DB 按会话 cwd 懒打开） ─────────────────────

const dbCache = new Map<string, MemoryDb>()

/** 取工作区 DB（缓存复用）。workspace = 项目根（cwd）。 */
export function getDb(workspace: string, dir = '.dsh-meow'): MemoryDb {
  const key = `${workspace}\u0000${dir}`
  let db = dbCache.get(key)
  if (!db) {
    db = new MemoryDb(memoryDbPath(workspace, dir))
    dbCache.set(key, db)
  }
  return db
}

export function closeAllDbs(): void {
  for (const db of dbCache.values()) db.close()
  dbCache.clear()
  closeGlobalDb() // 全局库同生命周期（Phase 2）
}

// ── 工作区库信任入口（HARDENING-PLAN §3 contract；index/inject 消费） ────────

/** 首次打开/创建某工作区记忆库：建目录、落 `.gitignore` 与 `.owner.json`，返回信任状态。
 *  每个精确 (workspace, dir) 只做一次（进程级缓存；Config 变更按设计需重载插件才生效）。
 *  契约：
 *   - 标记有效 → trusted:'marker'；
 *   - memory.db 不存在 / 可读但空 → 建 schema+索引+标记 → trusted:'created'；
 *   - 已有数据但无有效标记 → trusted:trustWorkspaceMemory ? 'config-trusted' : 'foreign'；
 *     不信任时**不注入、不迁移、不写任何文件**（投毒库连碰都不碰）；
 *   - 任何写标记/gitignore 失败都不抛出：能建出库就是 created，其余按 foreign fail-closed。 */
export function ensureMemoryStore(
  workspace: string,
  dir: string,
  opts: EnsureStoreOptions = { autoGitignore: true, trustWorkspaceMemory: false },
): StoreTrust {
  const key = storeKey(workspace, dir)
  const cached = storeTrustCache.get(key)
  if (cached !== undefined) return cached

  const projectDir = join(workspace, dir)
  const trust = judgeStoreTrust(projectDir, memoryDbPath(workspace, dir), {
    workspace,
    trustWorkspaceMemory: opts.trustWorkspaceMemory,
    autoGitignore: opts.autoGitignore,
    open: () => getDb(workspace, dir),
    label: '记忆库',
    foreignHint: '；如确认可信请在配置中开启 security.trustWorkspaceMemory',
  })
  storeTrustCache.set(key, trust)
  return trust
}

/** 取某工作区的信任状态（ensureMemoryStore 跑过之前返回 undefined）。
 *  注入链路据此决定是否注入；未跑过 = 调用方尚未完成首次信任判定。 */
export function storeTrustOf(workspace: string, dir = '.dsh-meow'): StoreTrust | undefined {
  return storeTrustCache.get(storeKey(workspace, dir))
}

/** 清空进程级信任缓存（测试/热重载显式重置用；正常 dispose 不需要）。 */
export function resetStoreTrustCache(): void {
  storeTrustCache.clear()
  globalStoreTrust = null // 全局库信任同源重置（路径 key，homeDir 切换自然重判）
}

// ── 全局（用户级）记忆库：<activeHomeDir>/global/memory.db（Phase 2 Round 1） ────
// soul / user / 全局 rules 是「用户级」而非「工作区级」：放全局目录后，换工作区不再
// 从零开始。标记与工作区库同源（installId + schema 1），但 workspace 绑定为空串——
// 全局目录本身会随 homeDir 整体搬移，标记不能绑死路径（否则切一次目录就自锁）。
// 信任判定复用 judgeStoreTrust；已存在的无标记库一律 foreign，没有 config 显式信任
// 档（这是插件自己的目录，不存在「用户带了可信的旧库」的场景）。

/** 全局记忆库路径：<当前全局目录>/global/memory.db。 */
export function globalDbPath(): string {
  return join(activeHomeDir(), 'global', 'memory.db')
}

let globalDbCache: { path: string; db: MemoryDb } | null = null
let globalStoreTrust: { path: string; trust: StoreTrust } | null = null

/** 全局库实例（按路径缓存；homeDir 切换后自动关旧开新）。调用方应先 ensureGlobalStore()
 *  判过信任——本函数只负责连接，不做信任判定。 */
export function getGlobalDb(): MemoryDb {
  const path = globalDbPath()
  if (globalDbCache !== null && globalDbCache.path === path) return globalDbCache.db
  if (globalDbCache !== null) globalDbCache.db.close()
  globalDbCache = { path, db: new MemoryDb(path) }
  return globalDbCache.db
}

/** 关闭全局库连接（homeDir 切换搬目录前必须调，Windows 上打开的文件会阻塞 rename）。
 *  幂等；下次 getGlobalDb() 自动重开。 */
export function closeGlobalDb(): void {
  if (globalDbCache === null) return
  globalDbCache.db.close()
  globalDbCache = null
}

/** 首次打开/创建全局库：目录 + memory.db（schema/索引由 MemoryDb 建）+ `.owner.json`
 *  标记（{schema:1, installId, workspace:'', createdAt}）。信任状态按路径缓存（homeDir
 *  切换后重判）。绝不抛出：建库失败 → foreign。 */
export function ensureGlobalStore(): StoreTrust {
  const path = globalDbPath()
  if (globalStoreTrust !== null && globalStoreTrust.path === path) return globalStoreTrust.trust
  const trust = judgeStoreTrust(dirname(path), path, {
    workspace: '', // 无工作区绑定：全局目录会随 homeDir 搬移
    trustWorkspaceMemory: false, // 全局库没有 config 信任档
    autoGitignore: false, // 在插件自己的全局目录里，不会进任何仓库
    open: () => getGlobalDb(),
    label: '全局记忆库',
    foreignHint: '；请删除或改名该目录后由插件重建',
  })
  globalStoreTrust = { path, trust }
  return trust
}

/** 记忆库备份（issue #37 增量②）：memory.db → memory.db.bak 单文件轮转。
 *  mtime 判增量（bak 不旧于数据即跳过）——WAL 模式下写入落在 -wal 文件、主库
 *  mtime 可能不动，所以取 db 与 -wal 的较新者。VACUUM INTO 不能覆盖已存在文件 →
 *  先写 .tmp 再 rename 原子替换。失败返回 false（备份是兜底措施，绝不影响主流程）。 */
export function backupMemoryDb(workspace: string, dir = '.dsh-meow'): boolean {
  try {
    const dbPath = memoryDbPath(workspace, dir)
    if (!existsSync(dbPath)) return false
    const bakPath = `${dbPath}.bak`
    let dataMtime = statSync(dbPath).mtimeMs
    const walPath = `${dbPath}-wal`
    if (existsSync(walPath)) dataMtime = Math.max(dataMtime, statSync(walPath).mtimeMs)
    if (existsSync(bakPath) && statSync(bakPath).mtimeMs >= dataMtime) return false
    const tmp = `${bakPath}.tmp`
    getDb(workspace, dir).vacuumInto(tmp)
    renameSync(tmp, bakPath)
    return true
  } catch {
    return false
  }
}

/** 全局库备份（Phase 2 Round 2）：<全局目录>/global/memory.db → 同目录 memory.db.bak，
 *  一代轮转。语义与 backupMemoryDb 一致：mtime 增量（bak 不旧于数据即跳过；WAL 下取
 *  db 与 -wal 的较新者）、VACUUM INTO 先写 .tmp 再 rename 原子替换、失败返回 false。
 *  全局库不可用/不可信（未创建 / foreign）→ false；库文件缺失或没有任何记忆行也 no-op。
 *  纯兜底：绝不抛出、绝不影响主流程。 */
export function backupGlobalDb(): boolean {
  try {
    const dbPath = globalDbPath()
    // 源库不存在：纯 no-op，绝不为了备份去创建/profile 全局库。
    if (!existsSync(dbPath)) return false
    if (!ensureGlobalStore().trusted) return false
    const bakPath = `${dbPath}.bak`
    let dataMtime = statSync(dbPath).mtimeMs
    const walPath = `${dbPath}-wal`
    if (existsSync(walPath)) dataMtime = Math.max(dataMtime, statSync(walPath).mtimeMs)
    if (existsSync(bakPath) && statSync(bakPath).mtimeMs >= dataMtime) return false
    const db = getGlobalDb()
    // 空库（只有 schema、没有任何层行）不备份：首次开库的空壳没有快照价值。
    let hasRows = false
    for (const level of LEVELS) {
      if (db.count(level) > 0) {
        hasRows = true
        break
      }
    }
    if (!hasRows) return false
    const tmp = `${bakPath}.tmp`
    db.vacuumInto(tmp)
    renameSync(tmp, bakPath)
    return true
  } catch {
    return false
  }
}

/** dream 子 agent 的 DB 定位通道：子 agent 会话可能无 cwd，dream 运行时临时挂载。 */
let dreamWorkspace: string | null = null
export function setDreamWorkspace(ws: string | null): void {
  dreamWorkspace = ws
}
export function getDreamWorkspace(): string | null {
  return dreamWorkspace
}
