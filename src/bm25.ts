/**
 * meow-memory v2 — 检索层。
 *
 * 分词（类别路由 v0.20.0，语言无关）：CJK（汉字+假名）连续段相邻 bigram + Unicode
 * 字母/数字（\p{L}\p{N}）整词；NFKC 归一化；标点/符号/emoji 丢弃。
 * en 语言包贡献（PR #6）：en 模式下对产出 tokens 追加英语归一化（停用词过滤 +
 * Porter 词干还原，见下方 EN 段）；其他语言维持基线（stemming 扩展点见 prompts/README.md）。
 * 打分：标准 BM25 × 指数遗忘权重（半衰期可配，默认 30 天；importance≥3 只有 0.85 下限，
 *       不再整体豁免）；可选 importance 参与排名（importanceWeight）与 hit_count 加成（hitBoost）。
 *       混合词法补分（Phase 2）：字符 bigram/trigram Jaccard 相似度只作 BM25 弱命中时的兜底floor
 *       （effective = max(bm25Score, 0.55·fuzzy·recency·importance)），BM25 命中强时不改排序。
 * 偏离信号：turn 文本向量 vs 各 topic 质心（title+goal+content+keywords 词频
 *       向量）的余弦相似度；top1 相似度过低 → "疑似新话题"提示。topic 数 < 3
 *       （冷启动）不提示。信号只提醒不拍板，归属判定由模型用目标句测试完成。
 */

import { getPromptLang } from './prompt-loader.js'

export interface Doc {
  id: string
  level: string
  title: string | null
  content: string
  keywords: string[]
  importance: number
  /** 历史命中/查阅次数（bumpHitCount 累计）——hitBoost 用；旧生产者/测试构造的 Doc 可缺省。 */
  hit_count?: number
  created_at: number
  /** 记忆时间戳 = 最后更新时间（艾宾浩斯按它算年龄）。 */
  updated_at: number
}

// CJK 类：汉字（\p{Script=Han} 覆盖基本区+Ext A~I）+ 假名 + 日文词内符号（々 叠字 / ー
// 长音符——script=Common，但必须随 CJK run，"人々/タワー"才能整体成词）
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u
// 字母/数字类：é ü ñ、西里尔、希腊、谚文、全角英数（NFKC 后）……一切语言的字母数字
const WORD = /[\p{L}\p{N}]/u

type CharClass = 'cjk' | 'word' | 'skip'

/** 单字符分类：CJK → bigram 路径；字母/数字 → 整词路径；其余（标点/符号/emoji）→ 丢弃。 */
function classify(cp: string): CharClass {
  if (CJK.test(cp)) return 'cjk'
  if (WORD.test(cp)) return 'word'
  return 'skip'
}

/** 切词（类别路由，v0.20.0，语言无关——promptLang 不再影响分词；唯一例外：en 语言包
 *  贡献的英语归一化（停用词+Porter）在产出后追加，见 normalizeEn）：
 * - CJK 类（汉字+假名）：连续段相邻 bigram——中文稳定零依赖，日文 n-gram 基线；
 *   run<2 单字不成词丢弃防噪音；汉字-假名交界不断 run，"行く/食べる"自然成词；
 * - 字母/数字类（\p{L}\p{N}）：连续段整词 + 小写化（café/привет/한국어/全角英数…）；
 * - 其余（标点/空白/符号/emoji）：跳过——信息量为零，不污染 IDF。
 * 文本先 NFKC 归一化（全角ＢＭ２５→bm25、半角片假名→全角）；Array.from 按 code point
 * 迭代，emoji/Ext B 汉字等 surrogate pair 不切半。其他语言的词形归一化/stemming 仍是
 * 语言包贡献者的扩展点（见 prompts/README.md）；打分本体（BM25/艾宾浩斯/余弦）语言无关。 */
export function tokenize(text: string): string[] {
  // 主语言码（'en-US' → 'en'）：只用于 en 归一化钩子，分词主干仍语言无关
  const lang = getPromptLang().toLowerCase().split(/[-_]/)[0]
  const cps = Array.from(text.normalize('NFKC'))
  const out: string[] = []
  let i = 0
  while (i < cps.length) {
    const cls = classify(cps[i])
    if (cls === 'skip') {
      i++
      continue
    }
    let j = i + 1
    while (j < cps.length && classify(cps[j]) === cls) j++
    const run = cps.slice(i, j)
    if (cls === 'cjk') {
      // 连续 CJK → 相邻 bigram（单字不成词，避免噪音）
      if (run.length >= 2) {
        for (let k = 0; k + 1 < run.length; k++) out.push(run[k] + run[k + 1])
      }
    } else {
      out.push(run.join('').toLowerCase())
    }
    i = j
  }
  return lang === 'en' ? normalizeEn(out) : out
}

// ── 英语归一化（en 分支） ────────────────────────────────────────────────────
//
// 检索命中要求 query 与记忆条目走同一套分词，所以归一化只做在 tokenize 里，
// 写入侧与检索侧天然一致（关键词原文照旧原样存库，只有匹配时才归一）。
//
// 两步，都是英语特有、中文不需要的：
// 1. 停用词过滤：英语功能词（the/of/is…）在每条记忆里都出现，BM25 的 idf 已经压得很低，
//    但会把噪音词条带进命中链路的匹配/覆盖率统计，且撇号切分
//    （"user's" → user + s）会漏出 s/t/ll 这类碎片，一并在此丢弃。
// 2. Porter 词干还原：英语有屈折变化，caches/caching/cached 必须归到同一词干，
//    否则用户 prompt 写复数、记忆条目写单数就永远命中不了（中文无屈折，故 zh 分支不做）。
//    含数字的 token（2024 / v0 / sha256）跳过——词干规则只对纯字母词有意义。

/** 英语停用词（含撇号切分碎片 s/t/d/ll/ve/re/m）。功能词不承载检索意义。 */
const EN_STOPWORDS = new Set<string>([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'cannot', 'could', 'd', 'did', 'do', 'does', 'doing', 'don', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just', 'll', 'm', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  're', 's', 'same', 'she', 'should', 'so', 'some', 'such', 't', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 've', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
])

/** 停用词丢弃 + 词干还原（纯字母词才还原；数字/混合 token 原样保留）。 */
function normalizeEn(tokens: string[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    if (EN_STOPWORDS.has(t)) continue
    out.push(/^[a-z]+$/.test(t) ? stemEn(t) : t)
  }
  return out
}

// Porter stemmer（Porter 1980 原始算法，零依赖移植）。词干只用于匹配，不入库、不展示，
// 所以"cach"这类非词形态无所谓——两侧同函数即可命中。
const PORTER_STEP2: Record<string, string> = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble',
  alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate',
  ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al',
  iviti: 'ive', biliti: 'ble', logi: 'log',
}
const PORTER_STEP3: Record<string, string> = {
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '',
}

const CONS = '[^aeiou]'
const VOW = '[aeiouy]'
const CONS_SEQ = `${CONS}[^aeiouy]*`
const VOW_SEQ = `${VOW}[aeiou]*`
const MGR0 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}`)
const MEQ1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}(${VOW_SEQ})?$`)
const MGR1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}${VOW_SEQ}${CONS_SEQ}`)
const HAS_VOWEL = new RegExp(`^(${CONS_SEQ})?${VOW}`)

/** Porter 词干还原（小写纯字母词；长度 ≤2 原样返回）。 */
export function stemEn(word: string): string {
  let w = word
  if (w.length <= 2) return w

  // Step 1a — 复数
  if (/(ss|i)es$/.test(w)) w = w.replace(/(ss|i)es$/, '$1')
  else if (/([^s])s$/.test(w)) w = w.replace(/([^s])s$/, '$1')

  // Step 1b — 过去式/进行时
  if (/eed$/.test(w)) {
    const stem = w.slice(0, -3)
    if (MGR0.test(stem)) w = w.slice(0, -1)
  } else if (/(ed|ing)$/.test(w)) {
    const stem = w.replace(/(ed|ing)$/, '')
    if (HAS_VOWEL.test(stem)) {
      w = stem
      if (/(at|bl|iz)$/.test(w)) w += 'e'
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1) // 双写辅音还原
      else if (new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(w)) w += 'e' // *o 条件
    }
  }

  // Step 1c — y → i
  if (/y$/.test(w)) {
    const stem = w.slice(0, -1)
    if (HAS_VOWEL.test(stem)) w = `${stem}i`
  }

  // Step 2 / 3 — 派生后缀归并
  for (const [suffix, repl] of Object.entries(PORTER_STEP2)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length)
      if (MGR0.test(stem)) w = stem + repl
      break
    }
  }
  for (const [suffix, repl] of Object.entries(PORTER_STEP3)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length)
      if (MGR0.test(stem)) w = stem + repl
      break
    }
  }

  // Step 4 — 剥离剩余派生后缀（m>1）
  const step4 = /(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/
  if (step4.test(w)) {
    const stem = w.replace(step4, '')
    if (MGR1.test(stem)) w = stem
  } else if (/(s|t)(ion)$/.test(w)) {
    const stem = w.replace(/(s|t)(ion)$/, '$1')
    if (MGR1.test(stem)) w = stem
  }

  // Step 5 — 收尾 e / 双写 l
  if (/e$/.test(w)) {
    const stem = w.slice(0, -1)
    if (MGR1.test(stem) || (MEQ1.test(stem) && !new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(stem))) w = stem
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1)

  return w
}

function docText(d: Doc): string {
  return [d.title ?? '', d.content, ...d.keywords].join(' ')
}

/**
 * 指数遗忘权重（艾宾浩斯曲线）：0.05 + 0.95·e^(−ln2·ageDays/halfLifeDays)。
 * - age=0 → 1，越旧越接近下限 0.05；半衰期默认 30 天（v0.32 起由 retrieval.halfLifeDays 传入）；
 * - importance ≥ 3 的条目只保留 0.85 下限（旧实现整体豁免衰减——那样"重要性高=永远新鲜"，
 *   审计判定过度；现在仍会衰减，只是压不过 0.85）；
 * - 非有限/负年龄按最旧处理（缺 updated_at 的旧数据不会虚高）；一参旧调用依旧有效。
 */
export function recencyWeight(ageMs: number, opts: { halfLifeDays?: number; importance?: number } = {}): number {
  const halfLifeDays =
    typeof opts.halfLifeDays === 'number' && Number.isFinite(opts.halfLifeDays) && opts.halfLifeDays > 0
      ? opts.halfLifeDays
      : 30
  const ageDays = Number.isFinite(ageMs) ? Math.max(0, ageMs) / 86_400_000 : Infinity
  const w = 0.05 + 0.95 * Math.exp((-Math.LN2 * ageDays) / halfLifeDays)
  return opts.importance !== undefined && opts.importance >= 3 ? Math.max(0.85, w) : w
}

/** hit_count 加成：min(2, 1 + 0.15·ln(1+hit_count))；无 hit_count/非正值视为 ×1（仅 hitBoost 开时用）。 */
function hitBoostWeight(hitCount: number | undefined): number {
  if (hitCount === undefined || !Number.isFinite(hitCount) || hitCount <= 0) return 1
  return Math.min(2, 1 + 0.15 * Math.log(1 + hitCount))
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000
const EMPTY_SET: ReadonlySet<string> = new Set<string>()

// ── 混合词法补分（Phase 2） ───────────────────────────────────────────────────
//
// 目标：BM25 是"整词/整 bigram 精确匹配"，同义变体、词形变化、CJK 词边界差异都会漏召回。
// 这里加一层纯字符级的相似度兜底（零依赖、离线、确定性）：
// - 字符 bigram Jaccard：CJK 无需分词，英文天然处理词形（cache/caching 共享 ca/ac/ch/he）；
// - 小权重 trigram Jaccard 加成：给更长连续片段加分（压低"只偶然共享 1 个 bigram"的噪声）。
// 它只当 floor 用：BM25 已经命中强时 max() 不会改变排序；BM25 为 0/很弱时才有机会上榜。
// 噪声地板：随机文本也会共享 1–2 个字符 bigram，相似度低于 FUZZY_MIN_SIMILARITY 视为不相关（返回 0），
// 否则 memory_search 会给不相关条目极低分而污染尾部结果。
const FUZZY_CHAR = /[\p{L}\p{N}]/u
/** 低于该字符 n-gram 相似度视为噪声（不当命中）。 */
const FUZZY_MIN_SIMILARITY = 0.2

/** 字符 n-gram 集合：NFKC + 小写，只保留字母/数字（标点/空白/emoji 不参与，CJK 安全）。 */
function charNgrams(text: string, n: number): Set<string> {
  const chars: string[] = []
  for (const ch of text.normalize('NFKC').toLowerCase()) if (FUZZY_CHAR.test(ch)) chars.push(ch)
  const out = new Set<string>()
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(''))
  return out
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const g of small) if (big.has(g)) inter++
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

/** 内部：query 的字符 2/3-gram 集合与匹配面的相似度（含噪声地板）。 */
function fuzzySimilarity(q2: ReadonlySet<string>, q3: ReadonlySet<string>, surface: string): number {
  if (q2.size === 0 || surface.length === 0) return 0
  const s2 = charNgrams(surface, 2)
  if (s2.size === 0) return 0
  const j2 = jaccard(q2, s2)
  const j3 = jaccard(q3, charNgrams(surface, 3))
  const sim = Math.min(1, j2 + 0.25 * j3) // 小权重 trigram 加成，上限 1
  return sim >= FUZZY_MIN_SIMILARITY ? sim : 0
}

/**
 * 离线"混合词法"相似度（Phase 2）：query 与匹配面的字符 bigram Jaccard + 0.25×trigram Jaccard。
 * 纯字符级（NFKC/小写/只留字母数字），CJK 无需分词、零依赖、确定性。
 * 无字符重叠、或相似度低于噪声地板（0.2）时返回 0——随机文本的偶发 bigram 共享不算命中。
 * 在 search/keywordHitScore 里只作为 BM25 的兜底 floor，不参与 BM25 数学、不改强命中排序。
 */
export function fuzzyScore(query: string, surface: string): number {
  if (query.length === 0 || surface.length === 0) return 0
  return fuzzySimilarity(charNgrams(query, 2), charNgrams(query, 3), surface)
}

export interface RankedHit {
  id: string
  level: string
  title: string | null
  content: string
  importance: number
  updated_at: number
  score: number
  /** 分项得分（#51/Phase 2，explain=true 时才有）：bm25=关键词原始分（未乘任何系数）、importance=条目重要度、
   *  recencyWeight=该条目的指数遗忘权重（importance≥3 时有 0.85 下限）、
   *  importanceWeight=importance 乘数（importanceWeight 开启时才有）、
   *  hitBoost=hit_count 乘数（hitBoost 开启且该条有 hit_count 时才有）、
   *  fuzzy=混合词法补分（0.55×字符 n-gram 相似度×recencyWeight×importanceWeight；fuzzy 开启时才有，
   *  score = max(bm25×recencyWeight×importanceWeight×hitBoost, fuzzy)）、
   *  score=最终分。状态过滤（active/stale）是检索前的二值过滤、不进打分，工具层在 explain 里补 status 字段。 */
  explain?: { bm25: number; importance: number; recencyWeight: number; importanceWeight?: number; hitBoost?: number; fuzzy?: number; score: number }
}

export interface SearchOptions {
  k?: number
  /** 相对当前时间；null 表示不衰减（测试/手动检索可关）。 */
  now?: number | null
  /** 附带每条命中的分项得分（#51 可解释检索）：只加字段，不改排序。 */
  explain?: boolean
  /** 指数遗忘半衰期（天）；默认 30。 */
  halfLifeDays?: number
  /** 最终分阈值：低于它的命中不返回。search 只在显式传入时过滤（keywordHitScore 由调用方传契约默认 0.35）。 */
  minScore?: number
  /** hit_count 加成：默认开（传 false 关闭，兼容旧行为）。 */
  hitBoost?: boolean
  /** importance 参与最终分：默认开（传 false 关闭，回退到 importance 不进排名）。 */
  importanceWeight?: boolean
  /** 混合词法补分（字符 n-gram 兜底 floor）：默认开（传 false 关闭，回到纯 BM25/0.32 行为）。 */
  fuzzy?: boolean
}

/**
 * BM25 × 遗忘权重检索（教科书 BM25 数学不变：recency/importance/hit_count 只乘最终分）。
 * - 遗忘权重按条目自己的 importance 计算（importance≥3 有 0.85 下限，不再整体豁免）；
 * - importanceWeight 默认开：最终分 × (0.85 + 0.05·importance)；
 * - hitBoost 默认开：最终分 × min(2, 1 + 0.15·ln(1+hit_count))（Doc.hit_count 缺省视为 ×1）；
 * - fuzzy 默认开：混合词法补分只当 floor——effective = max(BM25 最终分, 0.55·fuzzy·recency·importance)，
 *   BM25 强命中时排序完全不变；BM25 为 0 但字符 n-gram 相似度足够时（同义变体/词形/CJK 词边界差异）
 *   才补召回。fuzzy 相似度低于噪声地板返回 0，所以零匹配 query 仍然什么都不返回。
 * - minScore 只在显式传入时过滤（search 默认保留全部命中）。
 * 返回按最终分降序。
 */
export function search(query: string, docs: Doc[], opts: SearchOptions = {}): RankedHit[] {
  const k = opts.k ?? 5
  const now = opts.now === undefined ? Date.now() : opts.now
  const useImportance = opts.importanceWeight !== false
  const useHitBoost = opts.hitBoost !== false
  const useFuzzy = opts.fuzzy !== false
  const q = tokenize(query)
  if (q.length === 0 || docs.length === 0) return []
  // query 的字符 n-gram 集合只算一次；每条的匹配面也复用同一份文本。
  const q2: ReadonlySet<string> = useFuzzy ? charNgrams(query, 2) : EMPTY_SET
  const q3: ReadonlySet<string> = useFuzzy ? charNgrams(query, 3) : EMPTY_SET

  const n = docs.length
  const docTexts = docs.map((d) => docText(d))
  const docToks = docTexts.map((t) => tokenize(t))
  const avgdl = docToks.reduce((s, t) => s + t.length, 0) / n || 1

  const df = new Map<string, number>()
  const tf: Array<Map<string, number>> = []
  for (const toks of docToks) {
    const m = new Map<string, number>()
    const seen = new Set<string>()
    for (const t of toks) {
      m.set(t, (m.get(t) ?? 0) + 1)
      if (!seen.has(t)) {
        seen.add(t)
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    }
    tf.push(m)
  }

  const k1 = 1.5
  const b = 0.75
  const raw: number[] = docs.map((_, di) => {
    let s = 0
    const len = docToks[di].length
    for (const term of q) {
      const f = tf[di].get(term)
      if (!f) continue
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgdl)))
    }
    return s
  })

  const hits: RankedHit[] = []
  for (let di = 0; di < docs.length; di++) {
    // 遗忘权重按条目自己的 importance 计算（importance≥3 只保 0.85 下限，不再整体豁免）；
    // now=null 是手动检索/测试的"关闭衰减"开关。
    const w = now === null
      ? 1
      : recencyWeight(now - docs[di].updated_at, { halfLifeDays: opts.halfLifeDays, importance: docs[di].importance })
    const impW = useImportance ? 0.85 + 0.05 * docs[di].importance : 1
    const hitW = useHitBoost ? hitBoostWeight(docs[di].hit_count) : 1
    const bm25Score = raw[di] * w * impW * hitW
    // 混合词法补分只当 floor（不含 hitBoost/title 加成，BM25 强时 max() 不改变排序）。
    // 相似度 ≤1，所以 BM25 分已 ≥ 补分上限（0.55·w·impW）时跳过计算（热路径优化，语义不变）。
    const fuzzyCap = 0.55 * w * impW
    const fuzzyPart = useFuzzy && bm25Score < fuzzyCap ? fuzzyCap * fuzzySimilarity(q2, q3, docTexts[di]) : 0
    const score = Math.max(bm25Score, fuzzyPart)
    if (score <= 0) continue // 零匹配（BM25=0 且 fuzzy 低于噪声地板）→ 不返回
    if (opts.minScore !== undefined && score < opts.minScore) continue
    hits.push({
      id: docs[di].id,
      level: docs[di].level,
      title: docs[di].title,
      content: docs[di].content,
      importance: docs[di].importance,
      updated_at: docs[di].updated_at,
      score,
      ...(opts.explain === true
        ? {
            explain: {
              bm25: round3(raw[di]),
              importance: docs[di].importance,
              recencyWeight: round3(w),
              ...(useImportance ? { importanceWeight: round3(impW) } : {}),
              ...(useHitBoost ? { hitBoost: round3(hitW) } : {}),
              ...(useFuzzy ? { fuzzy: round3(fuzzyPart) } : {}),
              score: round3(score),
            },
          }
        : {}),
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}

/**
 * 关键词命中打分（每消息命中链路专用，v0.32 契约）：
 *   score = 本轮归一化原始分 × 查询覆盖率 × 遗忘权重 × importance 权重 × title 加成 × hit_count 加成
 * - 匹配面 = 调用方准备的 docs.content（记忆 keywords 串，或旧条目回退的内容片段）+ title；
 *   query = 用户消息全文 bigram；
 * - 原始分 = Σ(命中的 query 词条 × query 词频 × idf)——稀有词命中含金量高；再除以本轮最高
 *   原始分（0..1），让 minScore 成为跨库/跨查询可比的阈值（排序不变）；
 * - 查询覆盖率 = 命中 query 去重词条数 / query 去重词条数——**不再除以记忆匹配面词数**：
 *   8–13 个关键词的条目不再因词多被稀释（与提示词写作规范一致，审计 §2.2 的 P0）；
 *   计分用 `0.6 + 0.4×覆盖率`（命中 ≥1 个 query 词即保底 0.6）：短中文消息常只命中
 *   1/4 词条，线性覆盖率会把 0.35 门槛变成"短消息永不注入"——保底项保住召回，
 *   覆盖率仍在排序里奖励多词命中；
 * - 遗忘权重 = 指数半衰期（默认 30 天，importance≥3 有 0.85 下限）；
 * - importance 权重（importanceWeight 默认开）= 0.85 + 0.05×importance（3 星 ×1.0，4 星 ×1.05）；
 * - hit_count 加成（hitBoost 默认开）= min(2, 1 + 0.15·ln(1+hit_count))；
 * - title 被命中 ×1.2；minScore（调用方契约默认 0.35）过滤低质量命中，不传不过滤；
 * - 混合词法补分（fuzzy 默认开）：relevance = max(上面的 BM25 相关度, 0.55×字符 n-gram 相似度×importance权重)，
 *   最终分 = relevance × 遗忘权重。它只救 BM25 漏掉的同义变体/词形/CJK 词边界差异，
 *   相似度低于噪声地板时贡献 0（零匹配 query 不会因为偶发字符而命中）。
 */
export function keywordHitScore(query: string, docs: Doc[], opts: SearchOptions = {}): RankedHit[] {
  const k = opts.k ?? 2
  const now = opts.now === undefined ? Date.now() : opts.now
  const useImportance = opts.importanceWeight !== false
  const useHitBoost = opts.hitBoost !== false
  const useFuzzy = opts.fuzzy !== false
  const q = tokenize(query)
  if (q.length === 0 || docs.length === 0) return []
  const qTf = new Map<string, number>()
  for (const t of q) qTf.set(t, (qTf.get(t) ?? 0) + 1)
  const q2: ReadonlySet<string> = useFuzzy ? charNgrams(query, 2) : EMPTY_SET
  const q3: ReadonlySet<string> = useFuzzy ? charNgrams(query, 3) : EMPTY_SET

  const n = docs.length
  // 匹配面 = 调用方给的 content（keywords 串/内容片段）+ title；BM25 分词与 fuzzy 补分共用同一份文本。
  const surfaces = docs.map((d) => [d.content, d.title ?? ''].join(' '))
  const docToks = surfaces.map((s) => tokenize(s))
  const df = new Map<string, number>()
  const tf: Array<Map<string, number>> = []
  for (const toks of docToks) {
    const m = new Map<string, number>()
    const seen = new Set<string>()
    for (const t of toks) {
      m.set(t, (m.get(t) ?? 0) + 1)
      if (!seen.has(t)) {
        seen.add(t)
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    }
    tf.push(m)
  }
  const idf = (t: string): number =>
    Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))

  const raw: number[] = docs.map((_, di) => {
    let s = 0
    for (const [t, f] of qTf) {
      if (tf[di].has(t)) s += idf(t) * f
    }
    return s
  })
  const maxRaw = Math.max(...raw)
  // 查询覆盖率的分子/分母都用 query 去重词条（与记忆匹配面长度无关）。
  const queryTokens = qTf.size
  const out: RankedHit[] = []
  for (let di = 0; di < docs.length; di++) {
    let overlap = 0
    for (const t of qTf.keys()) if (tf[di].has(t)) overlap++
    const coverage = queryTokens > 0 ? overlap / queryTokens : 0
    const w = now === null
      ? 1
      : recencyWeight(now - docs[di].updated_at, { halfLifeDays: opts.halfLifeDays, importance: docs[di].importance })
    const impW = useImportance ? 0.85 + 0.05 * docs[di].importance : 1
    const hitW = useHitBoost ? hitBoostWeight(docs[di].hit_count) : 1
    const titleHit = tokenize(docs[di].title ?? '').some((t) => qTf.has(t))
    // 相关性分（不含遗忘权重）：minScore 只过滤"相关度不够"，不因条目旧而拒召回。
    // 0.32 review：若门槛乘上遗忘权重，importance≤2 的条目约 45 天后即使完整命中也会
    // 被静默丢弃（"自动召回截断"）；旧条目该降的是排序，不是能否被想起。
    const bm25Relevance = (maxRaw > 0 ? raw[di] / maxRaw : 0) * (0.6 + 0.4 * coverage) * impW * (titleHit ? 1.2 : 1) * hitW
    // 混合词法补分（Phase 2）：BM25 相关度弱/为 0 时的兜底（同样不含遗忘权重，minScore 语义不变）。
    // 相似度 ≤1，所以 BM25 相关度已 ≥ 补分上限时跳过计算（语义不变）。
    const fuzzyCap = 0.55 * impW
    const fuzzyRelevance = useFuzzy && bm25Relevance < fuzzyCap ? fuzzyCap * fuzzySimilarity(q2, q3, surfaces[di]) : 0
    const relevance = Math.max(bm25Relevance, fuzzyRelevance)
    if (relevance <= 0) continue // 零匹配（BM25=0 且 fuzzy 低于噪声地板）→ 不注入
    if (opts.minScore !== undefined && relevance < opts.minScore) continue
    const score = relevance * w
    out.push({
      id: docs[di].id,
      level: docs[di].level,
      title: docs[di].title,
      content: docs[di].content,
      importance: docs[di].importance,
      updated_at: docs[di].updated_at,
      score,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, k)
}

// ── topic 偏离信号 & find_similar ─────────────────────────────────────────

function tfVector(toks: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  if (na === 0 || nb === 0) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = big.get(k)
    if (w) dot += v * w
  }
  return dot / Math.sqrt(na * nb)
}

export interface SimilarHit {
  id: string
  level: string
  title: string | null
  content: string
  similarity: number
}

/**
 * find_similar：按条目 id 找内容相似的条目（bigram 词频向量余弦）。
 * 实时计算：全库 ~百条、每条几百字，<5ms——数据量小，不做预处理；
 * 等条目上千后再考虑"写入时增量更新向量缓存"（也是写入同步，不做定时任务，
 * 定时任务会有数据一致性窗口）。
 */
export function findSimilar(target: string, docs: Doc[], k = 5): SimilarHit[] {
  const targetVec = tfVector(tokenize(target))
  if (targetVec.size === 0) return []
  const scored: SimilarHit[] = []
  for (const d of docs) {
    const v = tfVector(tokenize(docText(d)))
    const s = cosine(targetVec, v)
    if (s <= 0) continue
    scored.push({
      id: d.id,
      level: d.level,
      title: d.title,
      content: d.content,
      similarity: Math.round(s * 1000) / 1000,
    })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, k)
}

export interface DriftSignal {
  /** 最相关 topic（若有）。 */
  topTopic: Doc | null
  /** 与 topTopic 的余弦相似度。 */
  topScore: number
  /** 是否提示"疑似新话题"。 */
  suggestsNew: boolean
  /** 冷启动（topic 太少）时信号不可靠。 */
  coldStart: boolean
}

const DRIFT_THRESHOLD = 0.3

/** turn 文本 vs 各 active topic 质心。只提醒不拍板。 */
export function topicDrift(turnText: string, topics: Doc[]): DriftSignal {
  if (topics.length === 0) return { topTopic: null, topScore: 0, suggestsNew: false, coldStart: true }
  const coldStart = topics.length < 3
  const q = tfVector(tokenize(turnText))
  if (q.size === 0) return { topTopic: null, topScore: 0, suggestsNew: false, coldStart }
  let best: Doc | null = null
  let bestScore = 0
  for (const t of topics) {
    const v = tfVector(tokenize(docText(t)))
    const s = cosine(q, v)
    if (s > bestScore) {
      bestScore = s
      best = t
    }
  }
  return {
    topTopic: best,
    topScore: bestScore,
    suggestsNew: !coldStart && bestScore < DRIFT_THRESHOLD,
    coldStart,
  }
}
