/**
 * meow-memory — 可选语义检索层（Phase 3 / 0.35）。
 *
 * 设计原则（审计口径：默认零外发、依赖可审计）：
 * - **默认离线**：`semanticEnabled(cfg)` 要求 `enabled === true` 且 `baseUrl`/`model` 都非空；
 *   未配置时本模块不产生任何网络请求，检索链路走既有 BM25 + 字符 n-gram（行为与 0.34 完全一致）。
 * - **网络只在本模块**：bm25/inject/tools 只消费 `embedTexts()` 的向量与 `cosine()`，
 *   不 import fetch、不感知 endpoint——"默认不发请求"可以由"本文件未被调用"直接审计。
 * - **OpenAI-compatible**：`POST ${baseUrl}/embeddings`，body `{model, input: string[]}`；
 *   `Authorization: Bearer <key>` 仅当对应环境变量存在。2xx 且 `data[].embedding` 全部是
 *   同维非空有限数字数组才算成功；未启用/未配置/超时/网络错误/非 2xx/形状不对一律返回 null
 *   （**绝不 throw**：语义层失败只退回词法检索，不阻塞注入/检索主链）。
 * - 小 LRU 缓存（256 条，键 `${baseUrl}|${model}|${text}`）：同一条消息/同一条记忆不重复 embed。
 */

/** 结构化配置（不 import config：index.ts 把 resolved 的 semantic 段传进来即可）。 */
export interface SemanticConfigLike {
  /** 总开关：仅 true 时才可能发请求。 */
  enabled?: boolean
  /** OpenAI-compatible base URL（如 http://127.0.0.1:11434/v1）；请求路径固定加 /embeddings。 */
  baseUrl?: string
  /** embedding 模型名。 */
  model?: string
  /** API key 所在环境变量名；缺省 `MEOW_MEMORY_EMBEDDING_KEY`。显式配置了变量名但变量为空 → 视为未配置。 */
  apiKeyEnv?: string
  /** 请求超时（毫秒），默认 5000。 */
  timeoutMs?: number
  /** 语义分混合权重（0..1，默认 0.8；由 bm25 读取，本模块只透传类型）。 */
  weight?: number
}

/** 默认 API key 环境变量名。 */
export const DEFAULT_EMBEDDING_KEY_ENV = 'MEOW_MEMORY_EMBEDDING_KEY'
/** 默认请求超时（毫秒）。 */
export const DEFAULT_SEMANTIC_TIMEOUT_MS = 5000
/** 默认语义分混合权重。 */
export const DEFAULT_SEMANTIC_WEIGHT = 0.8
/** 语义相似度噪声地板（0.35）：低于该值的余弦相似度按 0 处理——避免无关条目靠
 *  偶发的小正相似度混进检索结果（与 fuzzy 的 0.2 地板同思路）。 */
export const SEMANTIC_MIN_SIMILARITY = 0.25
/** embedding LRU 容量。 */
const EMBEDDING_CACHE_MAX = 256

/** key = `${baseUrl}|${model}|${text}` → 向量（LRU：命中移到队尾，超限淘汰最旧）。 */
const embeddingCache = new Map<string, number[]>()

/** 清空 embedding 缓存（测试隔离/手动回收用；生产主链无需调用）。 */
export function clearEmbeddingCache(): void {
  embeddingCache.clear()
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 语义检索是否启用：`enabled === true` 且 baseUrl/model 非空；未配置/缺字段 = 关闭（零网络）。 */
export function semanticEnabled(cfg: SemanticConfigLike | undefined | null): boolean {
  return cfg != null && cfg.enabled === true && nonEmptyString(cfg.baseUrl) && nonEmptyString(cfg.model)
}

/** 语义混合权重：缺省/非法 → 0.8（0 表示关闭语义补分）。 */
export function semanticWeightOf(cfg: SemanticConfigLike | undefined | null): number {
  return cfg != null && validWeight(cfg.weight) ? cfg.weight : DEFAULT_SEMANTIC_WEIGHT
}

function cacheKey(baseUrl: string, model: string, text: string): string {
  return `${baseUrl}|${model}|${text}`
}

function cacheGet(key: string): number[] | null {
  const hit = embeddingCache.get(key)
  if (hit === undefined) return null
  embeddingCache.delete(key) // LRU：命中移到队尾
  embeddingCache.set(key, hit)
  return hit
}

function cacheSet(key: string, vector: number[]): void {
  embeddingCache.set(key, vector)
  while (embeddingCache.size > EMBEDDING_CACHE_MAX) {
    const oldest = embeddingCache.keys().next().value
    if (oldest === undefined) break
    embeddingCache.delete(oldest)
  }
}

/**
 * 余弦相似度（语义检索用）：长度不一致、含非有限值、任一侧零范数 → 0（不抛错）。
 * 返回值 clamp 到 [-1, 1]（浮点误差可能略超出）。
 */
export function cosine(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na <= 0 || nb <= 0) return 0
  const sim = dot / Math.sqrt(na * nb)
  return Number.isFinite(sim) ? Math.max(-1, Math.min(1, sim)) : 0
}

/** 校验并规整 embedding 数组：数量正确、每行非空且同维、全部有限数；否则 null。 */
function validateVectors(rows: unknown, expected: number): number[][] | null {
  if (!Array.isArray(rows) || rows.length !== expected) return null
  const out: number[][] = []
  let dim = -1
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) return null
    if (dim === -1) dim = row.length
    else if (row.length !== dim) return null
    for (const n of row) if (typeof n !== 'number' || !Number.isFinite(n)) return null
    out.push(row as number[])
  }
  return out
}

/**
 * 单次 /embeddings 请求（内部）。任何失败返回 null（网络/超时/非 2xx/坏形状/缺 key）。
 * OpenAI-compatible 响应形状：`{ data: [{ embedding: number[], index?: number }, …] }`；
 * index 存在时按 index 归位（部分 provider 乱序），否则按返回顺序。
 */
async function requestEmbeddings(cfg: SemanticConfigLike, texts: string[]): Promise<number[][] | null> {
  const baseUrl = nonEmptyString(cfg.baseUrl) ? cfg.baseUrl : ''
  const model = nonEmptyString(cfg.model) ? cfg.model : ''
  if (baseUrl === '' || model === '') return null
  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`
  // key：默认 keyEnv（MEOW_MEMORY_EMBEDDING_KEY）缺失时允许无鉴权——本地
  // Ollama/LM Studio 等常见形态；只有**显式配置成其他变量名**且变量为空才视为
  // 未配置（防止用户以为配了 key 实际没配还偷偷无鉴权请求）。
  const explicitKeyEnv = nonEmptyString(cfg.apiKeyEnv) && cfg.apiKeyEnv !== DEFAULT_EMBEDDING_KEY_ENV
  const keyEnv = nonEmptyString(cfg.apiKeyEnv) ? cfg.apiKeyEnv : DEFAULT_EMBEDDING_KEY_ENV
  const apiKey = process.env[keyEnv as string]
  if (explicitKeyEnv && !nonEmptyString(apiKey)) return null
  if (typeof fetch !== 'function') return null // 极旧运行时：语义层自动关闭
  const timeoutMs =
    typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
      ? cfg.timeoutMs
      : DEFAULT_SEMANTIC_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      /* abort 失败不影响返回 null 的语义 */
    }
  }, timeoutMs)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
    if (nonEmptyString(apiKey)) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json: unknown = await res.json()
    const data = (json as { data?: unknown } | null)?.data
    if (!Array.isArray(data) || data.length !== texts.length) return null
    const ordered: unknown[] = new Array(texts.length)
    for (let i = 0; i < data.length; i++) {
      const entry = data[i] as { embedding?: unknown; index?: unknown } | null
      const embedding = entry?.embedding
      const idx =
        typeof entry?.index === 'number' && Number.isInteger(entry.index) && entry.index >= 0 && entry.index < texts.length
          ? entry.index
          : i
      if (ordered[idx] !== undefined) return null // 重复 index：形状不可信
      ordered[idx] = embedding
    }
    return validateVectors(ordered, texts.length)
  } catch {
    return null // 网络错误/超时 abort/JSON 解析失败……一律 fail-open
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量 embedding（OpenAI-compatible，带 LRU 缓存）。
 * - 未启用/未配置 → null（零网络）；texts 为空 → []（不发请求）。
 * - 已缓存的文本不重复请求，只把 miss 的文本合成一次请求。
 * - 任何失败返回 null（绝不 throw）：调用方直接退回词法检索。
 * @returns 与 texts 等长、同维的有限数字向量数组；失败 null。
 */
export async function embedTexts(
  cfg: SemanticConfigLike | undefined | null,
  texts: string[],
): Promise<number[][] | null> {
  if (!semanticEnabled(cfg)) return null
  if (!Array.isArray(texts) || texts.length === 0) return []
  const config = cfg as SemanticConfigLike
  const baseUrl = (config.baseUrl as string).replace(/\/+$/, '')
  const model = config.model as string
  const out: Array<number[] | undefined> = new Array(texts.length)
  const missing: string[] = []
  const positions = new Map<string, number[]>()
  for (let i = 0; i < texts.length; i++) {
    const text = typeof texts[i] === 'string' ? texts[i] : ''
    const key = cacheKey(baseUrl, model, text)
    const hit = cacheGet(key)
    if (hit !== null) {
      out[i] = hit
      continue
    }
    const existing = positions.get(text)
    if (existing === undefined) {
      positions.set(text, [i])
      missing.push(text)
    } else {
      existing.push(i)
    }
  }
  if (missing.length > 0) {
    const vectors = await requestEmbeddings(config, missing)
    if (vectors === null) return null
    for (let j = 0; j < missing.length; j++) {
      const vector = vectors[j]
      cacheSet(cacheKey(baseUrl, model, missing[j]), vector)
      for (const idx of positions.get(missing[j]) ?? []) out[idx] = vector
    }
  }
  // 所有位置要么命中缓存、要么刚刚填充；防御性校验（不应触发）。
  const result: number[][] = []
  for (const vector of out) {
    if (vector === undefined) return null
    result.push(vector)
  }
  return result
}

/**
 * 可选回填（0.35）：把已有条目里缺 embedding 的补上（启用语义后老记忆也能被语义召回）。
 * - 只处理 `listMissingEmbedding` 给出的 active + NULL 行；每层上限 `limitPerLevel`；
 * - 批量 embed 失败（null）就跳过该层，绝不影响主链；
 * - 与 semantic.ts 其余网络调用一样：未启用时零请求。
 * 返回实际写入条目的数量。host 在 apply 后 fire-and-forget 调用。
 */
export async function backfillEmbeddings(
  db: Pick<import('./db.js').MemoryDb, 'listMissingEmbedding' | 'setEmbedding'>,
  cfg: SemanticConfigLike | undefined | null,
  levels: ReadonlyArray<import('./db.js').Level>,
  limitPerLevel = 50,
): Promise<number> {
  if (!semanticEnabled(cfg)) return 0
  const config = cfg as SemanticConfigLike
  let filled = 0
  for (const level of levels) {
    let rows: Array<{ id: string; title?: string | null; content: string; keywords?: string[] }>
    try {
      rows = db.listMissingEmbedding(level, limitPerLevel)
    } catch {
      continue
    }
    if (rows.length === 0) continue
    const texts = rows.map((r) => [r.title ?? '', r.content, ...(r.keywords ?? [])].join(' ').trim())
    const vectors = await embedTexts(config, texts)
    if (vectors === null) continue
    for (let i = 0; i < rows.length; i++) {
      const vector = vectors[i]
      if (!Array.isArray(vector) || vector.length === 0) continue
      try {
        if (db.setEmbedding(level, rows[i].id, vector)) filled++
      } catch {
        /* 单条回填失败忽略 */
      }
    }
  }
  return filled
}
