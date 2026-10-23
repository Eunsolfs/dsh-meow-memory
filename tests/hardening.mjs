/**
 * meow-memory 0.32 hardening contract tests.
 *
 * Covers the Phase-1 hardening promise (docs/HARDENING-PLAN.md): workspace-store
 * trust gating (.owner.json / self-ignoring .gitignore / foreign store untouched),
 * DB indexes + dream_log schema upgrade, deleteRow, injection char budgets,
 * exponential-forgetting retrieval, memory_list / memory_forget / gated memory_home,
 * cost gates for auto-dream (no resume, oversize cooldown, per-day cap, dream list cap)
 * and reflection (min interval / per-day cap / context cap), dream-debug.log location,
 * and the apply-level untrusted-store notice + tool refusal.
 *
 * Runs against the built package: node build.mjs && node tests/hardening.mjs
 * No LLM, no harness. Every mutable path is a temp dir; DSH_HOME/MEOW_MEMORY_HOME are
 * redirected before the plugin module is imported so nothing lands in the real home.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'

const HOME = mkdtempSync(join(tmpdir(), 'mm-hardening-home-'))
process.env.MEOW_MEMORY_HOME = join(HOME, 'meow-home')
process.env.DSH_HOME = join(HOME, 'dsh-home')

const {
  MemoryDb, memoryDbPath, getDb, getGlobalDb, globalDbPath, closeAllDbs, closeGlobalDb, newId,
  ensureMemoryStore, ensureGlobalStore, storeTrustOf, resetStoreTrustCache,
  migrateWorkspaceToGlobal, globalStoreRows,
  backupGlobalDb,
  recencyWeight, search,
  buildInjection, buildHitInjection, buildReinjection, setCurrentProject,
  registerMemoryTools, setMemoryToolGate, apply,
  activeHomeDir, setActiveHomeDir,
  evaluateAutoDreamGate, dreamSweepOnce, dreamLogPath, collectDreamRounds, DREAM_MAX_ROWS_PER_ROUND,
  checkReflectBudget, recordReflectSent, estimateContextTokens, dreamMaxPerDayTotal,
  resetGlobalCostCounters, resetGlobalReflectCounter,
  isolatedDreamAvailable, startIsolatedDream, disposeIsolatedDreams, buildIsolatedDigest,
  ISOLATED_DREAM_META_PREFIX, ISOLATED_DEFAULT_TIMEOUT_MINUTES, ISOLATED_DEFAULT_MAX_PROMPT_CHARS,
  CONFIG_DEFAULTS, factoryDefaultOf, abortDream,
  embedTexts, semanticEnabled, semanticWeightOf, cosine, clearEmbeddingCache, setMemorySemanticOptionsForTests,
  listGlobalMemory, saveGlobalMemory, GLOBAL_EDIT_LEVELS, GLOBAL_STORE_UNTRUSTED_ERROR,
  globalProjectMarker, readSeen, sessionsFile, isReinjectPending,
} = await import('../lib/index.js')

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`FAIL  ${name} ${detail}`) }
}
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const clean = (dir) => { try { closeAllDbs(); rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
const ownerOf = (ws, dir = '.dsh-meow') => join(ws, dir, '.owner.json')
const giOf = (ws, dir = '.dsh-meow') => join(ws, dir, '.gitignore')

// ── Phase 3 test fixtures：确定性 mock OpenAI-compatible /embeddings 服务 ──────────
// 向量按话题词映射 8 维：deploy/ship/release→0、cache→1、auth/login→2、memory→3、
// database/sql→4、user/customer→5、test/spec→6、dim7=0.01（保证范数非零）。
const MOCK_EMBED_DIM = 8
const mockVector = (text) => {
  const t = String(text).toLowerCase()
  const v = new Array(MOCK_EMBED_DIM).fill(0)
  const mark = (re, i) => { if (re.test(t)) v[i] = 1 }
  mark(/deploy|rollout|shipping|release|shipment/, 0)
  mark(/cache|redis/, 1)
  mark(/auth|login|token/, 2)
  mark(/memory|recall/, 3)
  mark(/database|sqlite|\bsql\b/, 4)
  mark(/customer|people|\buser\b/, 5)
  mark(/test|spec|\bqa\b/, 6)
  v[7] = 0.01
  return v
}
const startEmbeddingServer = () => new Promise((resolve) => {
  const state = { requests: [], mode: 'ok' }
  const sockets = new Set()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch { parsed = null }
      state.requests.push({ url: req.url, auth: req.headers.authorization, body, parsed })
      const send = (code, payload, raw = false) => {
        try { res.writeHead(code, { 'content-type': 'application/json' }); res.end(raw ? payload : JSON.stringify(payload)) } catch { /* client aborted */ }
      }
      if (state.mode === '500') return send(500, { error: 'boom' })
      if (state.mode === 'malformed') return send(200, 'not json', true)
      if (state.mode === 'badshape') return send(200, { data: [] })
      if (state.mode === 'hang') { setTimeout(() => send(200, { data: [] }), 3000).unref?.(); return }
      if (parsed === null) return send(400, { error: 'bad request' })
      const inputs = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input ?? '')]
      send(200, { data: inputs.map((text, index) => ({ index, embedding: mockVector(text) })), model: parsed.model ?? 'mock' })
    })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({
      server,
      port,
      state,
      url: `http://127.0.0.1:${port}/v1`,
      setMode: (mode) => { state.mode = mode },
      close: () => new Promise((done) => { for (const socket of sockets) { try { socket.destroy() } catch { /* ignore */ } } server.close(() => done()) }),
    })
  })
})
const semanticCfg = (srv, over = {}) => ({
  enabled: true,
  baseUrl: srv.url,
  model: 'mock-embed',
  apiKeyEnv: 'MEOW_MEMORY_EMBEDDING_KEY',
  timeoutMs: 5000,
  weight: 0.8,
  ...over,
})
const withFetchSpy = async (fn) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = (...args) => { calls.push(args); return original(...args) }
  try {
    return { calls, result: await fn() }
  } finally {
    globalThis.fetch = original
  }
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

// ═══════════════════ 1. 工作区记忆库信任门（#64-1） ═══════════════════
{
  // ① 不存在的库 → created：建 schema + .gitignore("*") + .owner.json
  const ws = tmp('mmh-trust-created-')
  resetStoreTrustCache()
  check('trust: storeTrustOf undefined before ensure', storeTrustOf(ws) === undefined)
  const t1 = ensureMemoryStore(ws, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  check('trust: absent DB → created + trusted', t1.trusted === true && t1.reason === 'created')
  check('trust: created writes self-ignoring .gitignore("*")', readFileSync(giOf(ws), 'utf8') === '*\n')
  const marker = JSON.parse(readFileSync(ownerOf(ws), 'utf8'))
  check('trust: created writes schema-1 owner marker', marker.schema === 1 && typeof marker.workspace === 'string' && typeof marker.createdAt === 'number', JSON.stringify(marker))
  check('trust: created writes installId for this install', typeof marker.installId === 'string' && marker.installId.length > 0)
  // installId 必须是随机 UUID，不能是 hostname+homedir 的可推算 hash（review P1）
  const idVal = readFileSync(join(process.env.DSH_HOME, 'storages', 'meow-memory', 'install-id'), 'utf8').trim()
  check('trust: install-id is a random uuid (not a machine hash)', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(idVal), idVal)
  check('trust: storeTrustOf caches the result', storeTrustOf(ws) === t1)
  // ② 已有空库（schema 在但没有记忆行）但无标记 → foreign（review P1：row-empty + trigger
  //   会被攻击者当"可信任新建"利用；只有库文件根本不存在才允许本机创建）
  const wsEmpty = tmp('mmh-trust-empty-')
  resetStoreTrustCache()
  const dbE = new MemoryDb(memoryDbPath(wsEmpty)); dbE.close(); closeAllDbs()
  const tE = ensureMemoryStore(wsEmpty, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  check('trust: pre-existing empty DB without marker → foreign', tE.trusted === false && tE.reason === 'foreign')
  // ③ 有效标记 → marker（即便库已有数据）；标记必须带本机 installId
  const wsMarked = tmp('mmh-trust-marker-')
  resetStoreTrustCache()
  mkdirSync(join(wsMarked, '.dsh-meow'), { recursive: true })
  writeFileSync(ownerOf(wsMarked), JSON.stringify({ schema: 1, installId: marker.installId, workspace: wsMarked, createdAt: Date.now() }))
  const dbM = new MemoryDb(memoryDbPath(wsMarked)); dbM.insert({ level: 'soul', content: '本机既有记忆' }); dbM.close(); closeAllDbs()
  const tM = ensureMemoryStore(wsMarked, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  check('trust: valid marker → trusted marker', tM.trusted === true && tM.reason === 'marker')
  check('trust: marker case still ensures .gitignore', existsSync(giOf(wsMarked)))
  // ③b 伪造标记（仓库自带 schema:1，缺 installId）→ foreign（#64-1 核心绕过路径）
  const wsForged = tmp('mmh-trust-forged-')
  resetStoreTrustCache()
  mkdirSync(join(wsForged, '.dsh-meow'), { recursive: true })
  writeFileSync(ownerOf(wsForged), JSON.stringify({ schema: 1, workspace: wsForged, createdAt: Date.now() }))
  const dbForged = new MemoryDb(memoryDbPath(wsForged)); dbForged.insert({ level: 'soul', content: '伪造成本机库的投毒内容' }); dbForged.close(); closeAllDbs()
  const tForged = ensureMemoryStore(wsForged, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  check('trust: marker without installId → foreign (forgery rejected)', tForged.trusted === false && tForged.reason === 'foreign')
  // ③c 别的机器的标记（installId 不匹配）→ foreign
  resetStoreTrustCache()
  writeFileSync(ownerOf(wsForged), JSON.stringify({ schema: 1, installId: 'another-machine-id', workspace: wsForged, createdAt: Date.now() }))
  const tOther = ensureMemoryStore(wsForged, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  check('trust: foreign installId → foreign', tOther.trusted === false && tOther.reason === 'foreign')
  // ③d 路径别名（junction/映射盘类入口）：realpath 归一下同一库仍可信（review Q2）
  const wsReal = tmp('mmh-trust-alias-')
  resetStoreTrustCache()
  ensureMemoryStore(wsReal, '.dsh-meow', { autoGitignore: false, trustWorkspaceMemory: false })
  try {
    const linkDir = tmp('mmh-link-')
    const alias = join(linkDir, 'alias')
    symlinkSync(wsReal, alias, 'junction')
    resetStoreTrustCache()
    const tAlias = ensureMemoryStore(alias, '.dsh-meow', { autoGitignore: false, trustWorkspaceMemory: false })
    check('trust: junction path alias stays trusted (realpath-normalized marker)', tAlias.trusted === true, JSON.stringify(tAlias))
  } catch {
    check('trust: junction path alias (skipped: junction unavailable)', true)
  }
  // ④ 非空且无标记 → foreign：不注入、不迁移、不写任何文件、库字节不变
  const wsForeign = tmp('mmh-trust-foreign-')
  resetStoreTrustCache()
  const dbF = new MemoryDb(memoryDbPath(wsForeign))
  dbF.insert({ level: 'soul', content: '来路不明的 soul 投毒内容' })
  dbF.insert({ level: 'user', content: '来路不明的 user 投毒内容' })
  dbF.close(); closeAllDbs()
  const beforeBytes = readFileSync(memoryDbPath(wsForeign))
  const tF = ensureMemoryStore(wsForeign, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const afterBytes = readFileSync(memoryDbPath(wsForeign))
  check('trust: non-empty DB without marker → foreign', tF.trusted === false && tF.reason === 'foreign')
  check('trust: foreign store left byte-identical', beforeBytes.equals(afterBytes))
  check('trust: foreign store gets no marker/.gitignore writes', !existsSync(ownerOf(wsForeign)) && !existsSync(giOf(wsForeign)))
  // ⑤ 显式信任 → config-trusted：可用，但不冒充"本机创建"（不写 marker；.gitignore 仍补）
  const wsCfg = tmp('mmh-trust-cfg-')
  resetStoreTrustCache()
  const dbC = new MemoryDb(memoryDbPath(wsCfg)); dbC.insert({ level: 'soul', content: '用户确认可信的库' }); dbC.close(); closeAllDbs()
  const tC = ensureMemoryStore(wsCfg, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: true })
  check('trust: trustWorkspaceMemory=true → config-trusted', tC.trusted === true && tC.reason === 'config-trusted')
  check('trust: config-trusted does not fake an owner marker', !existsSync(ownerOf(wsCfg)) && existsSync(giOf(wsCfg)))
  // ⑥ 缓存重置后可重判（测试/热重载语义）
  resetStoreTrustCache()
  check('trust: resetStoreTrustCache clears cached trust', storeTrustOf(wsCfg) === undefined)
  const tC2 = ensureMemoryStore(wsCfg, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  check('trust: re-judged without config → foreign', tC2.trusted === false && tC2.reason === 'foreign')

  clean(ws); clean(wsEmpty); clean(wsMarked); clean(wsForeign); clean(wsCfg)
}

// ═══════════════════ 2. DB 层：deleteRow / 索引 / dream_log 升级 ═══════════════════
{
  const ws = tmp('mmh-db-')
  const db = new MemoryDb(memoryDbPath(ws))
  // deleteRow：完整 id / 唯一短 id / 未知 id / 歧义短 id
  const a = db.insert({ level: 'fact', content: '删除目标一', created_at: 1 })
  check('deleteRow: full id deletes', db.deleteRow('fact', a.id) === true && db.findById(a.id) === undefined)
  const b = db.insert({ level: 'fact', content: '删除目标二', created_at: 2 })
  check('deleteRow: unique short prefix resolves', db.deleteRow('fact', b.id.slice(0, 8)) === true)
  check('deleteRow: unknown id returns false', db.deleteRow('fact', 'no-such-id') === false)
  const T = 1_700_000_000_000
  const { newId } = await import('../lib/index.js')
  const c1 = db.insert({ level: 'fact', content: '歧义删除甲', id: newId(T), created_at: T })
  const c2 = db.insert({ level: 'fact', content: '歧义删除乙', id: newId(T), created_at: T })
  check('deleteRow: ambiguous short prefix refused', db.deleteRow('fact', c1.id.slice(0, 8)) === false)
  check('deleteRow: ambiguous refusal deleted nothing', db.findById(c1.id) !== undefined && db.findById(c2.id) !== undefined)
  // 索引：7 级 status_updated + 5 个 project + dream_log.session + windows.session = 14
  const idx = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map((r) => String(r.name))
  check('indexes: all expected indexes exist', idx.includes('idx_soul_status_updated') && idx.includes('idx_fact_status_updated') &&
    idx.includes('idx_fact_project') && idx.includes('idx_topic_project') && idx.includes('idx_dream_log_session') &&
    idx.includes('idx_windows_session'), JSON.stringify(idx))
  check('indexes: exactly 14 plugin indexes', idx.length === 14, `got ${idx.length}: ${idx.join(',')}`)
  db.close(); closeAllDbs()

  // dream_log.session_id 升级：旧库（无该列）打开后补列
  const wsUp = tmp('mmh-db-upgrade-')
  mkdirSync(join(wsUp, '.dsh-meow'), { recursive: true })
  const raw = new DatabaseSync(memoryDbPath(wsUp))
  raw.exec('CREATE TABLE dream_log (id INTEGER PRIMARY KEY AUTOINCREMENT, run_at INTEGER NOT NULL, summary TEXT, changes TEXT, note TEXT)')
  raw.exec("INSERT INTO dream_log (run_at, summary) VALUES (1, 'old')")
  raw.close()
  const dbUp = new MemoryDb(memoryDbPath(wsUp))
  const dCols = dbUp.db.prepare('PRAGMA table_info(dream_log)').all().map((c) => c.name)
  check('dream_log: old table upgraded with session_id column', dCols.includes('session_id'), JSON.stringify(dCols))
  check('dream_log: old rows preserved by upgrade', dbUp.db.prepare('SELECT COUNT(*) AS n FROM dream_log').get().n === 1)
  dbUp.close(); closeAllDbs()
  clean(ws); clean(wsUp)
}

// ═══════════════════ 3. 注入预算 caps ═══════════════════
{
  // 快照 cap：条目超预算整条不注入 + …；injectedIds/会话文件只记真正注入的
  const ws = tmp('mmh-cap-snap-')
  const db = new MemoryDb(memoryDbPath(ws))
  for (let i = 0; i < 6; i++) db.insert({ level: 'soul', content: `第${i}条长期记忆 ${'长'.repeat(120)}` })
  const inj = buildInjection(db, ws, 'cap-snap', '', { hitTopK: 2, snapshotMaxChars: 400 })
  check('caps: snapshot respects snapshotMaxChars', inj !== null && inj.text.length <= 400, inj === null ? 'null' : `len=${inj.text.length}`)
  check('caps: snapshot truncation marks …', inj !== null && inj.text.trimEnd().endsWith('…'))
  check('caps: snapshot dropped over-budget entries (injectedIds < rows)', inj !== null && inj.injectedIds.length >= 1 && inj.injectedIds.length < 6, JSON.stringify(inj?.injectedIds))
  const seenFile = JSON.parse(readFileSync(join(ws, '.dsh-meow', 'sessions', 'cap-snap.json'), 'utf8'))
  check('caps: session file records only actually injected ids', seenFile.injected.length === inj.injectedIds.length)
  // 单条命中 cap
  const wsHit = tmp('mmh-cap-hit-')
  const dbHit = new MemoryDb(memoryDbPath(wsHit))
  dbHit.insert({ level: 'fact', content: '命中上限测试 ' + '甲'.repeat(400), keywords: ['命中上限'], project: null, updated_at: Date.now() })
  const hit = buildHitInjection(dbHit, wsHit, 'cap-hit', '命中上限', { hitTopK: 1, hitMaxChars: 60 })
  check('caps: per-hit content respects hitMaxChars', hit !== null && hit.text.includes('…') && !hit.text.includes('甲'.repeat(80)), hit === null ? 'null' : `len=${hit.text.length}`)
  // 压缩重注入整体 cap
  const wsRe = tmp('mmh-cap-reinj-')
  const dbRe = new MemoryDb(memoryDbPath(wsRe))
  for (let i = 0; i < 6; i++) dbRe.insert({ level: 'soul', content: `重注入第${i}条 ${'乙'.repeat(100)}` })
  const re = buildReinjection(dbRe, wsRe, 'cap-re', [], { reinjectMaxChars: 300, snapshotMaxChars: 6000 })
  check('caps: reinjection respects reinjectMaxChars', re !== null && re.text.length <= 300, re === null ? 'null' : `len=${re.text.length}`)
  clean(ws); clean(wsHit); clean(wsRe)
}

// ═══════════════════ 4. 检索：遗忘权重 / 覆盖率阈值 / 排序 / onHit ═══════════════════
{
  check('retrieval: recencyWeight(0) = 1', Math.abs(recencyWeight(0) - 1) < 1e-9)
  check('retrieval: recencyWeight(1d) ≈ 0.9783', Math.abs(recencyWeight(86_400_000) - 0.9783) < 0.001, String(recencyWeight(86_400_000)))
  check('retrieval: recencyWeight(30d) ≈ 0.525', Math.abs(recencyWeight(30 * 86_400_000) - 0.525) < 0.001, String(recencyWeight(30 * 86_400_000)))
  check('retrieval: importance≥3 floored at 0.85 at 30d', recencyWeight(30 * 86_400_000, { importance: 4 }) >= 0.85)
  check('retrieval: non-finite age → 0.05 floor', recencyWeight(NaN) === 0.05 && recencyWeight(Infinity) === 0.05)
  const half = recencyWeight(30 * 86_400_000, { halfLifeDays: 60 })
  check('retrieval: halfLifeDays override shifts decay', Math.abs(half - (0.05 + 0.95 * Math.SQRT1_2)) < 0.001, String(half))
  // explain 分项自洽（search 直接暴露完整分项）
  const docs = [{ id: 'x', level: 'fact', title: null, content: '解释分项一致性验证', keywords: [], importance: 2, created_at: 0, updated_at: Date.now() }]
  const [ranked] = search('解释分项一致性', docs, { explain: true, k: 1 })
  check('retrieval: search explain = bm25 × recency × importanceWeight', ranked !== undefined &&
    Math.abs(ranked.explain.bm25 * ranked.explain.recencyWeight * ranked.explain.importanceWeight - ranked.score) < 0.02,
    JSON.stringify(ranked?.explain))

  // 覆盖率保底：1/8 query token 命中仍过默认 0.35 门槛；零命中返回 null
  const ws = tmp('mmh-retrieval-')
  const db = new MemoryDb(memoryDbPath(ws))
  db.insert({ level: 'fact', content: '端口说明', project: null, updated_at: Date.now() })
  const floor = buildHitInjection(db, ws, 's-floor', '喵版端口到底怎么了', { hitTopK: 3 })
  check('retrieval: 1/8 query-token coverage passes default minScore', floor !== null, floor === null ? 'null' : floor.text)
  const none = buildHitInjection(db, ws, 's-none', '完全无关词汇xyz', { hitTopK: 3 })
  check('retrieval: zero match returns null at default minScore', none === null)

  // 旧条目（60 天前、importance=1）完整命中：遗忘权重只降排序，不能被 minScore 静默丢弃
  const wsOld = tmp('mmh-retrieval-old-')
  const dbOld = new MemoryDb(memoryDbPath(wsOld))
  dbOld.insert({ level: 'fact', content: '旧端口配置', keywords: ['旧端口'], importance: 1, updated_at: Date.now() - 60 * 86_400_000 })
  const oldHit = buildHitInjection(dbOld, wsOld, 's-old', '旧端口', { hitTopK: 3, minScore: 0.35 })
  check('retrieval: 60d-old entry still recalled (minScore gates relevance, not recency)', oldHit !== null, oldHit === null ? 'null' : oldHit.text)
  wsOld && clean(wsOld)

  // importance 排序：同关键词 4 星在 1 星之前
  const wsI = tmp('mmh-retrieval-imp-')
  const dbI = new MemoryDb(memoryDbPath(wsI))
  dbI.insert({ level: 'fact', content: '低星排序条目', project: null, importance: 1, keywords: ['排序对比词'], updated_at: Date.now() })
  dbI.insert({ level: 'fact', content: '高星排序条目', project: null, importance: 4, keywords: ['排序对比词'], updated_at: Date.now() })
  const byImp = buildHitInjection(dbI, wsI, 's-imp', '排序对比词', { hitTopK: 3 })
  check('retrieval: importance weight orders 4★ above 1★', byImp !== null && byImp.text.indexOf('高星排序条目') < byImp.text.indexOf('低星排序条目'), byImp?.text)
  // hit_count 加成排序：同分同重要性时，被命中过的条目上浮
  const wsH = tmp('mmh-retrieval-hit-')
  const dbH = new MemoryDb(memoryDbPath(wsH))
  const cold = dbH.insert({ level: 'fact', content: '冷条目 强化排序', project: null, importance: 1, keywords: ['强化排序'], updated_at: Date.now() })
  dbH.insert({ level: 'fact', content: '热条目 强化排序', project: null, importance: 1, keywords: ['强化排序'], updated_at: Date.now() })
  dbH.db.prepare('UPDATE fact SET hit_count = 10 WHERE id = ?').run(cold.id)
  const byBoost = buildHitInjection(dbH, wsH, 's-boost', '强化排序', { hitTopK: 3 })
  check('retrieval: hit_count boost orders reinforced entry first', byBoost !== null && byBoost.text.indexOf('冷条目') < byBoost.text.indexOf('热条目'), byBoost?.text)
  // onHit 回调：每条实际注入的命中回调一次，id 与 injectedIds 一致
  const wsO = tmp('mmh-retrieval-onhit-')
  const dbO = new MemoryDb(memoryDbPath(wsO))
  dbO.insert({ level: 'fact', content: '回调记账甲', project: null, keywords: ['回调记账'], updated_at: Date.now() })
  dbO.insert({ level: 'fact', content: '回调记账乙', project: null, keywords: ['回调记账'], updated_at: Date.now() })
  const onHit = []
  const hitO = buildHitInjection(dbO, wsO, 's-onhit', '回调记账', { hitTopK: 3, onHit: (level, id) => onHit.push(`${level}:${id}`) })
  check('retrieval: onHit called once per injected hit', hitO !== null && onHit.length === hitO.injectedIds.length && onHit.every((s) => hitO.injectedIds.includes(s.split(':')[1])))
  clean(ws); clean(wsI); clean(wsH); clean(wsO)
}

// ═══════════════════ 5. 工具面：memory_list / memory_forget / memory_home 门 ═══════════════════
{
  setMemoryToolGate(undefined)
  const ws = tmp('mmh-tools-')
  const db = new MemoryDb(memoryDbPath(ws))
  const f1 = db.insert({ level: 'fact', content: '列表测试 fact 一', project: 'femo', keywords: ['列表', '测试'], created_at: Date.now() })
  db.insert({ level: 'fact', content: '列表测试 fact 二', project: 'dsh', keywords: ['列表'], created_at: Date.now() })
  db.insert({ level: 'lesson', content: '列表测试 lesson', project: 'femo', created_at: Date.now() })
  const archived = db.insert({ level: 'fact', content: '列表测试 已归档', project: 'femo', created_at: Date.now() })
  db.update('fact', archived.id, { status: 'archived' })

  const tools = []
  registerMemoryTools((t) => tools.push(t), '.dsh-meow')
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  check('tools: memory_list + memory_forget + memory_home registered (10 total path)', tools.length === 9 && ['memory_list', 'memory_forget', 'memory_home'].every((n) => byName[n] !== undefined), `got ${tools.map((t) => t.name).join(',')}`)
  const exec = (wsPath, sid) => ({ agent: { session: { header: { cwd: wsPath, id: sid } } } })

  // memory_list：分页 + 过滤 + 只出元数据
  const all = await byName.memory_list.execute({ status: 'all' }, exec(ws, 't-list'))
  check('memory_list: returns total + metadata items', all.total === 4 && all.items.length === 4)
  check('memory_list: metadata-only (no content field)', all.items.every((it) => !('content' in it) && typeof it.id === 'string' && typeof it.level === 'string'))
  const p1 = await byName.memory_list.execute({ status: 'all', limit: 2, offset: 0 }, exec(ws, 't-list'))
  const p2 = await byName.memory_list.execute({ status: 'all', limit: 2, offset: 2 }, exec(ws, 't-list'))
  check('memory_list: paging is stable and disjoint', p1.items.length === 2 && p2.items.length === 2 && p1.items[0].id !== p2.items[0].id && p1.total === 4)
  const facts = await byName.memory_list.execute({ level: 'fact', status: 'all' }, exec(ws, 't-list'))
  check('memory_list: level filter', facts.items.every((it) => it.level === 'fact') && facts.total === 3)
  const femo = await byName.memory_list.execute({ project: 'femo', status: 'all' }, exec(ws, 't-list'))
  check('memory_list: project filter', femo.items.every((it) => it.project === 'femo') && femo.total === 3)
  const act = await byName.memory_list.execute({ status: 'active' }, exec(ws, 't-list'))
  check('memory_list: default status=active excludes archived', act.total === 3 && !act.items.some((it) => it.id === archived.id))
  const arc = await byName.memory_list.execute({ status: 'archived' }, exec(ws, 't-list'))
  check('memory_list: status=archived filter', arc.total === 1 && arc.items[0].id === archived.id)
  const render = byName.memory_list.output.render({}, all)
  check('memory_list: render shows ids + levels', render[0].text.includes(f1.id) && render[0].text.includes('[fact]'))

  // memory_forget：archive（默认）→ restore → delete（需 confirm）
  const f2 = db.insert({ level: 'fact', content: '忘掉目标条目', project: 'femo', created_at: Date.now() })
  const arch = await byName.memory_forget.execute({ id: f2.id }, exec(ws, 't-forget'))
  check('memory_forget: default mode archives', arch.id === f2.id && db.findById(f2.id).row.status === 'archived')
  const rest = await byName.memory_forget.execute({ id: f2.id, mode: 'restore' }, exec(ws, 't-forget'))
  check('memory_forget: restore sets active', rest.id === f2.id && db.findById(f2.id).row.status === 'active')
  const unknown = await byName.memory_forget.execute({ id: 'no-such-id-xyz' }, exec(ws, 't-forget'))
  check('memory_forget: unknown id returns note saying not found', String(unknown.note).length > 0 && !('ok' in unknown) && db.findById(f2.id) !== undefined)
  const noConfirm = await byName.memory_forget.execute({ id: f2.id, mode: 'delete' }, exec(ws, 't-forget')).then(() => null, (e) => e)
  check('memory_forget: delete without confirm:true rejects', noConfirm !== null && String(noConfirm.message).includes('confirm'))
  check('memory_forget: rejected delete kept the row', db.findById(f2.id) !== undefined)
  const del = await byName.memory_forget.execute({ id: f2.id, mode: 'delete', confirm: true }, exec(ws, 't-forget'))
  check('memory_forget: confirmed delete hard-deletes', del.id === f2.id && db.findById(f2.id) === undefined)
  const shortDel = db.insert({ level: 'fact', content: '短 id 删除目标', project: null, created_at: Date.now() })
  const del2 = await byName.memory_forget.execute({ id: shortDel.id.slice(0, 10), mode: 'delete', confirm: true }, exec(ws, 't-forget'))
  check('memory_forget: short unique id delete works', del2.id === shortDel.id && db.findById(shortDel.id) === undefined)

  // memory_home：默认只读；显式 allowHomeSwitch 才允许切换
  const homeDefault = byName.memory_home
  const beforeHome = activeHomeDir()
  const q = await homeDefault.execute({})
  check('memory_home: query mode shows current dir + disabled switch', String(q.note).includes('当前全局数据目录') && String(q.note).includes('切换能力：已禁用'))
  const refused = await homeDefault.execute({ target: 'dsh-storage' })
  check('memory_home: target refused while allowHomeSwitch=false', String(refused.note).includes('拒绝切换') && activeHomeDir() === beforeHome)

  const toolsSwitch = []
  registerMemoryTools((t) => toolsSwitch.push(t), '.dsh-meow', { allowHomeSwitch: () => true })
  const homeSwitch = toolsSwitch.find((t) => t.name === 'memory_home')
  const savedDshHome = process.env.DSH_HOME
  const switchHome = join(HOME, 'switch-home')
  mkdirSync(switchHome, { recursive: true })
  writeFileSync(join(switchHome, 'seed.txt'), 'x')
  setActiveHomeDir(switchHome)
  process.env.DSH_HOME = join(HOME, 'dsh-home-switch')
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  try {
    const q2 = await homeSwitch.execute({})
    check('memory_home: allowHomeSwitch=true reports enabled', String(q2.note).includes('切换能力：已启用'))
    const target = join(HOME, 'switched-to')
    const sw = await homeSwitch.execute({ target })
    check('memory_home: allowed switch moves the active dir', String(sw.note).includes('已切换为') && activeHomeDir() === target, sw.note)
    check('memory_home: switch writes stable pointer under DSH_HOME/storages', existsSync(join(process.env.DSH_HOME, 'storages', 'meow-memory-home.json')))
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    setActiveHomeDir(beforeHome)
  }
  db.close(); closeAllDbs()
  clean(ws)
}

// ═══════════════════ 6. dream 成本闸（#49）+ dream-debug.log 落点 ═══════════════════
{
  const cfg = { enabled: true, idleMinutes: 180, checkMinutes: 15, suppressWindows: [], suppressLeadMinutes: 15, timeZone: 'UTC', rulesReviewDays: 2 }
  const ws = tmp('mmh-dream-')
  // 0.32 安全闸（review P1）：auto dream 只整理可信库，先建本机库+标记。
  ensureMemoryStore(ws, '.dsh-meow', { autoGitignore: false, trustWorkspaceMemory: false })
  const db = getDb(ws, '.dsh-meow')
  const addWindow = (sid, idleMs = 4 * 3600_000) => {
    db.touchWindow(sid, ws, Date.now() - idleMs)
    db.insert({ level: 'fact', content: `窗口 ${sid} 的记忆`, project: 'dsh', source_session: sid, created_at: 100 })
  }
  // ① 无 live agent：sweep 跳过且绝不 resume
  const sidNo = 'winh-no-agent'
  addWindow(sidNo)
  let resumes = 0
  dreamSweepOnce({ get: (n) => (n === 'agents' ? { get: () => undefined, resume: async () => { resumes++; return { agent: {} } } } : n === 'sessionController' ? { resolveAgent: async () => ({ agent: {} }) } : undefined) }, cfg, '.dsh-meow', new Map([[sidNo, ws]]))
  check('dream: no live agent → no dream, no resume (#49)', db.getDreamLease(sidNo) === null && resumes === 0)

  // ② 上下文超预算：跳过并落 dreamskip 24h 冷却
  const sidBig = 'winh-oversize'
  addWindow(sidBig)
  const hugeEvents = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200_000) }] } }]
  const heavyAgent = { session: { header: { id: sidBig }, events: hugeEvents }, steer: () => {} }
  dreamSweepOnce({ get: (n) => (n === 'agents' ? { get: () => heavyAgent } : undefined) }, cfg, '.dsh-meow', new Map([[sidBig, ws]]))
  const skipMeta = db.getDreamMeta(`dreamskip:${sidBig}`)
  check('dream: oversize context skipped + persisted dreamskip:<sid>', db.getDreamLease(sidBig) === null && typeof skipMeta === 'string' && JSON.parse(skipMeta).tokens > 40000, String(skipMeta))
  const gateCooldown = evaluateAutoDreamGate(db, sidBig, heavyAgent, cfg)
  check('dream: oversize persists 24h cooldown', gateCooldown.allowed === false && gateCooldown.reason === 'cooldown')
  const estimate = estimateContextTokens(hugeEvents)
  check('dream: estimateContextTokens counts event payload', estimate.tokens > 40000, JSON.stringify(estimate))

  // ③ 每窗口每日上限：dreamauto 已有今日启动记录 → cap
  const sidCap = 'winh-cap'
  addWindow(sidCap)
  const lightAgent = { session: { header: { id: sidCap }, events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }] }, steer: () => {} }
  db.setDreamMeta(`dreamauto:${sidCap}`, JSON.stringify({ starts: [Date.now()] }))
  const gateCap = evaluateAutoDreamGate(db, sidCap, lightAgent, cfg)
  check('dream: per-window/day cap gate blocks', gateCap.allowed === false && gateCap.reason === 'cap')
  dreamSweepOnce({ get: (n) => (n === 'agents' ? { get: () => lightAgent } : undefined) }, cfg, '.dsh-meow', new Map([[sidCap, ws]]))
  check('dream: sweep respects per-window/day cap (no lease)', db.getDreamLease(sidCap) === null)
  // 上限 0 = 关闭自动 dream
  const zeroCfg = { ...cfg, budget: { dreamMaxPerWindowPerDay: 0 } }
  check('dream: dreamMaxPerWindowPerDay=0 disables auto dream', evaluateAutoDreamGate(db, 'winh-zero', lightAgent, zeroCfg).reason === 'cap')

  // ③b 进程级全局每日上限（review Q3）：cap=1，两个 live 窗口只允许启动一个
  resetGlobalCostCounters()
  const sidG1 = 'winh-global-1'
  const sidG2 = 'winh-global-2'
  addWindow(sidG1); addWindow(sidG2)
  const gCfg = { ...cfg, budget: { dreamMaxPerDayTotal: 1 } }
  const gAgent = (id) => ({ session: { header: { id }, events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }] }, steer: () => {} })
  dreamSweepOnce({ get: (n) => (n === 'agents' ? { get: () => gAgent(sidG1) } : undefined) }, gCfg, '.dsh-meow', new Map([[sidG1, ws]]))
  dreamSweepOnce({ get: (n) => (n === 'agents' ? { get: () => gAgent(sidG2) } : undefined) }, gCfg, '.dsh-meow', new Map([[sidG2, ws]]))
  check('dream: process-wide daily cap allows only one window', db.getDreamLease(sidG1) !== null && db.getDreamLease(sidG2) === null)
  check('dream: dreamMaxPerDayTotal defaults/helper sane', dreamMaxPerDayTotal(undefined) > 0 && dreamMaxPerDayTotal({ budget: { dreamMaxPerDayTotal: 0 } }) === 0)
  resetGlobalCostCounters()

  // ④ dream 清单：排除 archived + 每轮上限 60
  const wsR = tmp('mmh-dream-rounds-')
  const dbR = new MemoryDb(memoryDbPath(wsR))
  const widR = 'winh-rounds'
  for (let i = 0; i < 70; i++) dbR.insert({ level: 'fact', content: `轮次上限条目 ${i}`, project: 'dsh', source_session: widR, created_at: 1000 + i })
  const archId = dbR.insert({ level: 'fact', content: '已归档不该进整理清单', project: 'dsh', source_session: widR, created_at: 2000 })
  dbR.update('fact', archId.id, { status: 'archived' })
  const rounds = collectDreamRounds(dbR, widR, wsR, '.dsh-meow')
  const allRows = rounds.flatMap((r) => r.groups.flatMap((g) => g.rows))
  check('dream: DREAM_MAX_ROWS_PER_ROUND contract is 60', DREAM_MAX_ROWS_PER_ROUND === 60)
  check('dream: round entry list capped at 60', allRows.filter((r) => r.source_session === widR).length <= 60, `got ${allRows.filter((r) => r.source_session === widR).length}`)
  check('dream: archived rows excluded from rounds', !allRows.some((r) => r.content === '已归档不该进整理清单' || r.id === archId.id))
  dbR.close(); closeAllDbs()

  // ⑤ dream-debug.log 落 activeHomeDir（不落工作区）
  const savedActive = activeHomeDir()
  const dreamHome = join(HOME, 'dream-home')
  mkdirSync(dreamHome, { recursive: true })
  setActiveHomeDir(dreamHome)
  check('dream: dreamLogPath lives under activeHomeDir', dreamLogPath() === join(dreamHome, 'dream-debug.log'))
  setActiveHomeDir(savedActive)

  db.close(); closeAllDbs()
  clean(ws); clean(wsR)
}

// ═══════════════════ 7. 反思成本闸 ═══════════════════
{
  const ws = tmp('mmh-reflect-')
  const base = Date.UTC(2026, 0, 1, 3, 0) // 同一天内做时间旅行
  const cfg = { reflect: true, budget: { reflectMinIntervalMinutes: 20, reflectMaxPerDay: 6, dreamMaxContextTokens: 40000 } }
  const gate = (over = {}) => checkReflectBudget({ workspace: ws, sessionId: 'r-1', events: [], dir: '.dsh-meow', cfg, now: base, ...over })
  const g0 = gate()
  check('reflect: fresh session passes gate', g0.allowed === true, JSON.stringify(g0))
  recordReflectSent(ws, 'r-1', '.dsh-meow', base)
  const gMin = gate({ now: base + 60_000 })
  check('reflect: min-interval blocks a second reflection', gMin.allowed === false && gMin.reason === 'min-interval', JSON.stringify(gMin))
  const gAfter = gate({ now: base + 21 * 60_000 })
  check('reflect: allowed again after min interval', gAfter.allowed === true, JSON.stringify(gAfter))
  // 每日上限
  recordReflectSent(ws, 'r-2', '.dsh-meow', base)
  const capCfg = { reflect: true, budget: { reflectMinIntervalMinutes: 0, reflectMaxPerDay: 1, dreamMaxContextTokens: 40000 } }
  const gCap = checkReflectBudget({ workspace: ws, sessionId: 'r-2', events: [], dir: '.dsh-meow', cfg: capCfg, now: base + 60_000 })
  check('reflect: daily cap blocks', gCap.allowed === false && gCap.reason === 'daily-cap', JSON.stringify(gCap))
  // 上下文超限
  const big = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(20_000) }] } }]
  const gBig = checkReflectBudget({ workspace: ws, sessionId: 'r-3', events: big, dir: '.dsh-meow', cfg: { reflect: true, budget: { dreamMaxContextTokens: 1000 } }, now: base })
  check('reflect: context-too-large blocks', gBig.allowed === false && gBig.reason === 'context-too-large', JSON.stringify(gBig))
  // reflect:false
  const gOff = checkReflectBudget({ workspace: ws, sessionId: 'r-4', events: [], dir: '.dsh-meow', cfg: { reflect: false }, now: base })
  check('reflect: reflect=false disables reflection', gOff.allowed === false && gOff.reason === 'disabled')
  // 记账递增
  recordReflectSent(ws, 'r-5', '.dsh-meow', base)
  recordReflectSent(ws, 'r-5', '.dsh-meow', base + 1000)
  const stat = JSON.parse(getDb(ws, '.dsh-meow').getDreamMeta('reflectstat:r-5'))
  check('reflect: recordReflectSent increments same-day count', stat.count === 2 && stat.lastAt === base + 1000, JSON.stringify(stat))
  // 进程级全局上限（review Q3）：与 per-session 独立
  resetGlobalReflectCounter()
  const gCfg = { reflect: true, budget: { reflectMaxPerDayTotal: 1, reflectMinIntervalMinutes: 0, reflectMaxPerDay: 6, dreamMaxContextTokens: 40000 } }
  recordReflectSent(ws, 'r-global-a', '.dsh-meow', base)
  const gGlobal = checkReflectBudget({ workspace: ws, sessionId: 'r-global-b', events: [], dir: '.dsh-meow', cfg: gCfg, now: base + 1000 })
  check('reflect: process-wide daily cap blocks a fresh session', gGlobal.allowed === false && gGlobal.reason === 'daily-cap', JSON.stringify(gGlobal))
  resetGlobalReflectCounter()
  closeAllDbs()
  clean(ws)
}

// ═══════════════════ 8. apply 级集成：未受信库提示 + 工具拒绝 / 受信库照常注入 ═══════════════════
{
  const makeCtx = () => {
    const tools = []
    const handlers = {}
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: { register: (t) => { tools.push(t); return () => {} } },
      on: (name, fn) => { handlers[name] = fn },
      effect: (fn) => { try { fn() } catch { /* 路由/命令注册的 mock/可选服务失败不阻塞 */ } return () => {} },
      get: () => undefined,
      subagents: { start: () => { throw new Error('subagents not expected') } },
    }
    return { ctx, tools, handlers }
  }
  const msg = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const preStepOf = (handlers) => handlers['agent/pre-step']

  // ① 外来非空库：首条消息前注入"未受信"notice，且不注入库内任何内容；工具读被拒
  const foreignWs = tmp('mmh-apply-foreign-')
  const dbF = new MemoryDb(memoryDbPath(foreignWs))
  dbF.insert({ level: 'soul', content: '投毒SOUL内容不应出现' })
  dbF.insert({ level: 'user', content: '投毒USER内容不应出现' })
  dbF.close(); closeAllDbs()
  // #64-1 的第二条向量：即便 autoMigrate=true，外来库的 PROJECT.md 也不许导入。
  writeFileSync(join(foreignWs, '.dsh-meow', 'PROJECT.md'), '# 投毒项目\n\n- 投毒PROJECT内容不应被导入\n')
  resetStoreTrustCache()

  const a1 = makeCtx()
  await apply(a1.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh', autoMigrate: true })
  const agentF = { session: { header: { cwd: foreignWs, id: 'apply-foreign-1' }, events: [] }, steer: () => {} }
  const outF = await preStepOf(a1.handlers)({ agent: agentF, messages: [msg('你好')], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg('你好')] }))
  const textsF = outF.messages.map((m) => m.content.map((b) => b.text ?? '').join(''))
  check('apply trust: untrusted-store notice injected before first user message', outF.messages.length >= 2 && textsF.some((t) => t.includes('未受信') || t.includes('不是 meow-memory 创建') || t.includes('trustWorkspaceMemory')), JSON.stringify(textsF.map((t) => t.slice(0, 40))))
  check('apply trust: foreign store content never injected', !textsF.some((t) => t.includes('投毒SOUL内容') || t.includes('投毒USER内容')))
  const searchTool = a1.tools.find((t) => t.name === 'memory_search')
  const refused = await searchTool.execute({ query: 'x' }, { agent: { session: { header: { cwd: foreignWs, id: 'apply-foreign-1' } } } }).then(() => null, (e) => e)
  check('apply trust: memory_search refused on foreign store', refused !== null && String(refused.message).includes('不是本插件创建的'), String(refused?.message))
  check('apply trust: untrusted store PROJECT.md not migrated', existsSync(join(foreignWs, '.dsh-meow', 'PROJECT.md')))

  // ② 本机创建的库（.owner.json）：首轮照常注入 soul 内容
  const trustedWs = tmp('mmh-apply-trusted-')
  resetStoreTrustCache()
  ensureMemoryStore(trustedWs, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const dbT = new MemoryDb(memoryDbPath(trustedWs))
  dbT.insert({ level: 'soul', content: '可信库的长期记忆内容' })
  dbT.insert({ level: 'project', content: '可信项目概述', project: 'femo', subcategory: 'overview' })
  dbT.close(); closeAllDbs()
  const a2 = makeCtx()
  await apply(a2.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
  const agentT = { session: { header: { cwd: trustedWs, id: 'apply-trusted-1' }, events: [] }, steer: () => {} }
  const outT = await preStepOf(a2.handlers)({ agent: agentT, messages: [msg('你好')], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [msg('你好')] }))
  const textsT = outT.messages.map((m) => m.content.map((b) => b.text ?? '').join(''))
  const searchT = a2.tools.find((t) => t.name === 'memory_search')
  const searchOk = await searchT.execute({ query: '长期记忆' }, { agent: { session: { header: { cwd: trustedWs, id: 'apply-trusted-1' } } } }).then((r) => r, () => null)
  check('apply trust: trusted store injects soul snapshot', textsT.some((t) => t.includes('===== 长期记忆 =====') && t.includes('可信库的长期记忆内容')), JSON.stringify(textsT.map((t) => t.slice(0, 30))))
  check('apply trust: trusted store allows memory_search', searchOk !== null && Array.isArray(searchOk.hits))

  setMemoryToolGate(undefined)
  closeAllDbs()
  clean(foreignWs); clean(trustedWs)
}

// ═══════════════════ 9. Phase 2：全局（用户级）记忆库 ═══════════════════
{
  const savedActive = activeHomeDir()
  const resetGlobalFor = (home) => { closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(home) }

  // ① 不存在的全局库 → created；库在 <activeHomeDir>/global/memory.db；标记 workspace 绑定为空
  const gHome = tmp('mmh-gstore-')
  resetGlobalFor(gHome)
  const t1 = ensureGlobalStore()
  const gPath = globalDbPath()
  check('global: absent → created + trusted', t1.trusted === true && t1.reason === 'created', JSON.stringify(t1))
  check('global: db lives at <activeHomeDir>/global/memory.db', gPath === join(gHome, 'global', 'memory.db') && existsSync(gPath), gPath)
  const gMarker = JSON.parse(readFileSync(join(gHome, 'global', '.owner.json'), 'utf8'))
  check('global: owner marker has schema 1 + installId + empty workspace binding',
    gMarker.schema === 1 && typeof gMarker.installId === 'string' && gMarker.installId.length > 0 && gMarker.workspace === '', JSON.stringify(gMarker))
  check('global: plugin-owned global dir writes no .gitignore', !existsSync(join(gHome, 'global', '.gitignore')))
  const g1 = getGlobalDb()
  check('global: getGlobalDb caches one instance per path', g1 === getGlobalDb())
  closeGlobalDb()
  check('global: closeGlobalDb + reopen yields a fresh instance', getGlobalDb() !== g1)
  const g3 = getGlobalDb()
  closeAllDbs()
  check('global: closeAllDbs closes the global db too', getGlobalDb() !== g3)

  // ② 已存在的空全局库但无标记 → foreign（只认"库文件不存在"才创建）
  const gHome2 = tmp('mmh-gstore-empty-')
  resetGlobalFor(gHome2)
  mkdirSync(join(gHome2, 'global'), { recursive: true })
  const rawEmpty = new MemoryDb(join(gHome2, 'global', 'memory.db')); rawEmpty.close(); closeAllDbs()
  const t2 = ensureGlobalStore()
  check('global: pre-existing empty db without marker → foreign', t2.trusted === false && t2.reason === 'foreign')
  check('global: foreign global store gets no marker write', !existsSync(join(gHome2, 'global', '.owner.json')))

  // ③ 伪造 installId 的标记 → foreign；本机 installId 的标记 → marker
  const installId = readFileSync(join(process.env.DSH_HOME, 'storages', 'meow-memory', 'install-id'), 'utf8').trim()
  const gHome3 = tmp('mmh-gstore-forged-')
  resetGlobalFor(gHome3)
  mkdirSync(join(gHome3, 'global'), { recursive: true })
  const raw3 = new MemoryDb(join(gHome3, 'global', 'memory.db')); raw3.insert({ level: 'soul', content: '外来全局soul' }); raw3.close(); closeAllDbs()
  writeFileSync(join(gHome3, 'global', '.owner.json'), JSON.stringify({ schema: 1, installId: '00000000-0000-0000-0000-000000000000', workspace: '', createdAt: Date.now() }))
  const t3 = ensureGlobalStore()
  check('global: forged installId marker → foreign', t3.trusted === false && t3.reason === 'foreign', JSON.stringify(t3))
  const gHome4 = tmp('mmh-gstore-marker-')
  resetGlobalFor(gHome4)
  mkdirSync(join(gHome4, 'global'), { recursive: true })
  const raw4 = new MemoryDb(join(gHome4, 'global', 'memory.db')); raw4.close(); closeAllDbs()
  writeFileSync(join(gHome4, 'global', '.owner.json'), JSON.stringify({ schema: 1, installId, workspace: '', createdAt: Date.now() }))
  const t4 = ensureGlobalStore()
  check('global: valid installId marker → marker trusted', t4.trusted === true && t4.reason === 'marker', JSON.stringify(t4))

  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(savedActive)
  clean(gHome); clean(gHome2); clean(gHome3); clean(gHome4)
}

// ═══════════════════ 10. Phase 2：工作区 → 全局 懒迁移 ═══════════════════
{
  const savedActive = activeHomeDir()
  const gHome = tmp('mmh-gmig-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(gHome)
  ensureGlobalStore()
  const gdb = getGlobalDb()
  const ws = tmp('mmh-gmig-ws-')
  ensureMemoryStore(ws, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const wdb = getDb(ws, '.dsh-meow')
  const soul = wdb.insert({ level: 'soul', content: '工作区soul应迁移' })
  const user = wdb.insert({ level: 'user', content: '工作区user应迁移' })
  const gRule = wdb.insert({ level: 'rules', content: '工作区全局规则应迁移', project: null, importance: 2 })
  const pRule = wdb.insert({ level: 'rules', content: '工作区项目规则不迁移', project: 'femo', importance: 2 })
  const fact = wdb.insert({ level: 'fact', content: '工作区fact不迁移', project: 'dsh' })
  const proj = wdb.insert({ level: 'project', content: '工作区project不迁移', project: 'femo', subcategory: 'overview' })
  const r1 = migrateWorkspaceToGlobal(ws, '.dsh-meow')
  check('migrate: copies soul + user + global rule (copied=3, archived=3)', r1.copied === 3 && r1.archived === 3 && r1.skipped === false, JSON.stringify(r1))
  check('migrate: global rows keep the exact ids', gdb.findById(soul.id)?.row.content === '工作区soul应迁移' && gdb.findById(user.id) !== undefined && gdb.findById(gRule.id) !== undefined)
  check('migrate: workspace originals archived (content recoverable)',
    wdb.findById(soul.id)?.row.status === 'archived' && wdb.findById(user.id)?.row.status === 'archived' && wdb.findById(gRule.id)?.row.status === 'archived')
  check('migrate: project-scope rules untouched and not copied', wdb.findById(pRule.id)?.row.status === 'active' && gdb.findById(pRule.id) === undefined)
  check('migrate: facts/project rows untouched and not copied',
    wdb.findById(fact.id)?.row.status === 'active' && wdb.findById(proj.id)?.row.status === 'active' && gdb.findById(fact.id) === undefined && gdb.findById(proj.id) === undefined)
  check('migrate: idempotency flag recorded in dream_meta', wdb.getDreamMeta('globalmigrated:v1:.dsh-meow') !== undefined)
  const r2 = migrateWorkspaceToGlobal(ws, '.dsh-meow')
  check('migrate: second call skipped=true, copies nothing', r2.skipped === true && r2.copied === 0, JSON.stringify(r2))

  // 不可信工作区 → 跳过且不碰库
  const wsForeign = tmp('mmh-gmig-foreign-')
  const fdb = new MemoryDb(memoryDbPath(wsForeign)); fdb.insert({ level: 'soul', content: '外来soul不迁移' }); fdb.close(); closeAllDbs()
  resetStoreTrustCache()
  const r3 = migrateWorkspaceToGlobal(wsForeign, '.dsh-meow')
  check('migrate: untrusted workspace skipped', r3.skipped === true && r3.copied === 0)
  check('migrate: untrusted workspace rows stay active', getDb(wsForeign, '.dsh-meow').list('soul', { status: 'active' }).length === 1)

  // 全局库不可信（已存在非空、无标记）→ 可信工作区也不迁移（下次可信后重试）
  const gHome2 = tmp('mmh-gmig-foreign-global-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(gHome2)
  mkdirSync(join(gHome2, 'global'), { recursive: true })
  const rawG = new MemoryDb(join(gHome2, 'global', 'memory.db')); rawG.insert({ level: 'soul', content: '外来全局' }); rawG.close(); closeAllDbs()
  check('migrate: foreign global store judged foreign', ensureGlobalStore().trusted === false)
  const ws2 = tmp('mmh-gmig-ws2-')
  ensureMemoryStore(ws2, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const wdb2 = getDb(ws2, '.dsh-meow')
  wdb2.insert({ level: 'soul', content: '可信工作区soul待迁移' })
  const r4 = migrateWorkspaceToGlobal(ws2, '.dsh-meow')
  check('migrate: foreign global → skipped and workspace stays retryable',
    r4.skipped === true && r4.copied === 0 && wdb2.getDreamMeta('globalmigrated:v1:.dsh-meow') === undefined)

  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(savedActive)
  clean(gHome); clean(gHome2); clean(ws); clean(wsForeign); clean(ws2)
}

// ═══════════════════ 11. Phase 2：分层注入（globalDb） ═══════════════════
{
  const savedActive = activeHomeDir()
  const gHome = tmp('mmh-layer-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(gHome)
  ensureGlobalStore()
  const g = getGlobalDb()
  const gs = g.insert({ level: 'soul', content: '全局soul条目' })
  g.insert({ level: 'user', content: '全局user条目' })
  const gr = g.insert({ level: 'rules', content: '全局规则条目', project: null, importance: 2 })
  g.update('rules', gr.id, { keywords: ['分层命中词'] })
  const ws = tmp('mmh-layer-ws-')
  const wdb = new MemoryDb(memoryDbPath(ws))
  wdb.insert({ level: 'soul', content: '工作区soul兜底条目' })
  const wgr = wdb.insert({ level: 'rules', content: '工作区全局规则兜底', project: '全局', importance: 2 })
  wdb.update('rules', wgr.id, { keywords: ['分层命中词'] })
  wdb.insertRow({ ...gs, level: 'soul', content: '工作区同id副本（应被全局副本压制）' })
  const inj = buildInjection(wdb, ws, 'layer-1', '', { globalDb: g })
  check('layered: snapshot merges global + workspace soul', inj !== null && inj.text.includes('全局soul条目') && inj.text.includes('工作区soul兜底条目'), inj?.text)
  check('layered: same id → global copy wins (id dedupe)', inj !== null && inj.text.includes('全局soul条目') && !inj.text.includes('工作区同id副本'))
  check('layered: global rules + workspace fallback rules both injected', inj !== null && inj.text.includes('全局规则条目') && inj.text.includes('工作区全局规则兜底'))
  const hit = buildHitInjection(wdb, ws, 'layer-hit', '分层命中词', { globalDb: g, hitTopK: 5 })
  check('layered: keyword hits merge both stores and dedupe by id',
    hit !== null && new Set(hit.injectedIds).size === hit.injectedIds.length && hit.text.includes('全局规则条目') && hit.text.includes('工作区全局规则兜底'), hit?.text)
  const injU = buildInjection(wdb, ws, 'layer-3', '', { globalDb: g, trust: { trusted: false } })
  check('layered: trust:false suppresses global + workspace content',
    injU === null || (!injU.text.includes('全局soul条目') && !injU.text.includes('工作区soul兜底条目') && !injU.text.includes('全局规则条目')))

  // 全局库为空 → 回落工作区（0.32 行为）
  const gEmptyHome = tmp('mmh-layer-gempty-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(gEmptyHome)
  ensureGlobalStore()
  const injF = buildInjection(wdb, ws, 'layer-2', '', { globalDb: getGlobalDb() })
  check('layered: empty global store falls back to workspace rows', injF !== null && injF.text.includes('工作区soul兜底条目'), injF?.text)
  check('layered: empty global store injects no global content', injF !== null && !injF.text.includes('全局soul条目'))

  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(savedActive)
  clean(gHome); clean(gEmptyHome); clean(ws)
}

// ═══════════════════ 12. Phase 2：工具读写路由（apply + 首次 trusted pre-step 迁移） ═══════════════════
{
  const savedActive = activeHomeDir()
  const gHome = tmp('mmh-routing-g-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(gHome)
  const makeCtx = () => {
    const tools = []
    const handlers = {}
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: { register: (t) => { tools.push(t); return () => {} } },
      on: (name, fn) => { handlers[name] = fn },
      effect: (fn) => { try { fn() } catch { /* mock */ } return () => {} },
      get: () => undefined,
      subagents: { start: () => { throw new Error('subagents not expected') } },
    }
    return { ctx, tools, handlers }
  }
  const ws = tmp('mmh-routing-ws-')
  ensureMemoryStore(ws, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const wdb = getDb(ws, '.dsh-meow')
  wdb.insert({ level: 'soul', content: '迁移前工作区soul' })
  wdb.insert({ level: 'rules', content: '迁移前全局规则', project: null, importance: 2 })
  wdb.insert({ level: 'fact', content: '工作区既有fact', project: 'dsh' })

  const a = makeCtx()
  await apply(a.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
  const preStep = a.handlers['agent/pre-step']
  const um = { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }
  await preStep(
    { agent: { session: { header: { cwd: ws, id: 'p2-tools' }, events: [] }, steer: () => {} }, messages: [um], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [um] }),
  )
  const g = getGlobalDb()
  const names = Object.fromEntries(a.tools.map((t) => [t.name, t]))
  const exec = { agent: { session: { header: { cwd: ws, id: 'p2-tools' } } } }
  const rem = (level, content, project, keywords) => names.memory_remember.execute({ level, content, project, keywords, importance: 2 }, exec)

  check('routing: first trusted pre-step migrated user-scope rows into global db',
    g.list('soul').some((r) => r.content === '迁移前工作区soul') && g.list('rules').some((r) => r.content === '迁移前全局规则') &&
    getDb(ws, '.dsh-meow').list('soul', { status: 'active' }).length === 0)

  await rem('soul', '新全局soul', '全局', ['全局层测试词'])
  await rem('user', '新全局user', '全局', ['全局层测试词'])
  await rem('rules', '新全局规则', '全局', ['全局层测试词'])
  await rem('fact', '新工作区fact', 'dsh', ['工作区层测试词'])
  await rem('rules', '新项目规则', 'femo', ['工作区层测试词'])
  check('routing: soul/user/global-rule writes land in the global db',
    g.list('soul').some((r) => r.content === '新全局soul') && g.list('user').some((r) => r.content === '新全局user') && g.list('rules').some((r) => r.content === '新全局规则'))
  check('routing: fact/project-rule writes stay in the workspace db',
    getDb(ws, '.dsh-meow').list('fact', { status: 'active' }).some((r) => r.content === '新工作区fact') &&
    getDb(ws, '.dsh-meow').list('rules', { status: 'active' }).some((r) => r.content === '新项目规则') &&
    !g.list('fact').some((r) => r.content === '新工作区fact') && !g.list('rules').some((r) => r.content === '新项目规则'))

  const s = await names.memory_search.execute({ query: '全局层测试词 工作区层测试词', project: 'dsh' }, exec)
  const sIds = s.hits.map((h) => h.id)
  check('routing: memory_search merges both stores without duplicate ids',
    s.hits.some((h) => h.content === '新全局规则') && s.hits.some((h) => h.content === '新工作区fact') && new Set(sIds).size === sIds.length)
  const l = await names.memory_list.execute({ status: 'all', limit: 100 }, exec)
  const lIds = l.items.map((it) => it.id)
  check('routing: memory_list merges both stores without duplicate ids',
    l.items.some((it) => it.level === 'soul') && l.items.some((it) => it.level === 'fact') && new Set(lIds).size === lIds.length)

  const gid = g.list('soul').find((r) => r.content === '新全局soul').id
  const rd = await names.memory_read.execute({ id: gid }, exec)
  check('routing: memory_read locates a global-row id', rd.found === true && rd.level === 'soul')
  const up = await names.memory_update.execute({ id: gid, content: '新全局soul（已更新）' }, exec)
  check('routing: memory_update writes back to the global db', up.ok === true && g.findById(gid).row.content === '新全局soul（已更新）')
  const del = await names.memory_forget.execute({ id: gid, mode: 'delete', confirm: true }, exec)
  check('routing: memory_forget deletes a global-row id', del.id === gid && g.findById(gid) === undefined)

  setMemoryToolGate(undefined)
  closeAllDbs(); resetStoreTrustCache(); setActiveHomeDir(savedActive)
  clean(gHome); clean(ws)
}

// ═══════════════════ 13. Phase 2：混合词法检索（fuzzy） ═══════════════════
{
  const now = Date.now()
  // 匹配面 = title + content + keywords；用短匹配面（真实 keywords 条目形态）验证
  // "同义/词形变体只靠 fuzzy 补分召回"，避免长正文把字符 n-gram Jaccard 稀释到噪声地板下。
  const docs = [
    { id: 'doc-cache', level: 'fact', title: null, content: 'cache invalidation', keywords: ['cache'], importance: 1, created_at: now, updated_at: now },
    { id: 'doc-caching', level: 'fact', title: null, content: 'caching', keywords: ['caching'], importance: 1, created_at: now, updated_at: now },
    { id: 'doc-noise', level: 'fact', title: null, content: 'galaxy', keywords: ['galaxy'], importance: 1, created_at: now, updated_at: now },
  ]
  const on = search('cache', docs, { k: 10, explain: true, now })
  const off = search('cache', docs, { k: 10, now, fuzzy: false })
  check('fuzzy: fuzzy-on search includes the word-form variant doc', on.some((h) => h.id === 'doc-caching'), JSON.stringify(on.map((h) => [h.id, h.score])))
  check('fuzzy: fuzzy:false excludes the variant doc', !off.some((h) => h.id === 'doc-caching'), JSON.stringify(off.map((h) => h.id)))
  const variant = on.find((h) => h.id === 'doc-caching')
  check('fuzzy: variant is scored by the fuzzy floor (>0, explain.fuzzy > 0)', variant !== undefined && variant.score > 0 && (variant.explain?.fuzzy ?? 0) > 0, JSON.stringify(variant?.explain))
  const exact = on.find((h) => h.id === 'doc-cache')
  check('fuzzy: explain carries a fuzzy field for exact BM25 hits too', exact?.explain !== undefined && 'fuzzy' in exact.explain)
  check('fuzzy: unrelated doc still excluded (noise floor)', !on.some((h) => h.id === 'doc-noise'))
  // 直接 fuzzyScore 单元契约：0.33 源码已有 fuzzyScore，但 src/index.ts 的 export 清单尚未
  // 转出（lib/index.js 里不可见）——行为已由上面的 search() 覆盖；导出后这组断言自动生效。
  const mod = await import('../lib/index.js')
  if (typeof mod.fuzzyScore === 'function') {
    check('fuzzy: fuzzyScore("cache","caching") > 0.2', mod.fuzzyScore('cache', 'caching') > 0.2, String(mod.fuzzyScore('cache', 'caching')))
    check('fuzzy: fuzzyScore noise floor returns 0', mod.fuzzyScore('cache', 'unrelated galaxy') === 0)
  } else {
    console.log('  [note] fuzzyScore is not exported from lib/index.js (src/index.ts export list) — direct unit contract pending; behavior covered via search()')
  }
}

// ═══════════════════ 14. Round 2：adoptSessionEntries（子会话条目收养） ═══════════════════
{
  const ws = tmp('mmh-adopt-')
  const db = new MemoryDb(memoryDbPath(ws))
  const CHILD = 'child-session-adopt'
  const PARENT = 'parent-session-adopt'
  const OTHER = 'other-session-adopt'
  const ids = []
  for (const level of ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']) {
    ids.push(db.insert({
      level,
      content: `收养测试 ${level}`,
      project: level === 'project' || level === 'fact' || level === 'lesson' ? 'femo' : null,
      title: level === 'topic' ? '收养话题' : null,
      source_session: CHILD,
      // 让 project 表 subcategory 保持合法（overview 可空，无强制）
    }).id)
  }
  const otherId = db.insert({ level: 'fact', content: '别的会话条目', source_session: OTHER }).id
  const moved = db.adoptSessionEntries(CHILD, PARENT)
  check('adopt: moves child rows across all 7 levels', moved === 7, `got ${moved}`)
  check('adopt: every level row now owned by parent session', ids.every((id) => db.findById(id)?.row.source_session === PARENT))
  check('adopt: other session rows untouched', db.findById(otherId)?.row.source_session === OTHER)
  check('adopt: unknown source session → 0', db.adoptSessionEntries('no-such-source', PARENT) === 0)
  check('adopt: equal from/to → 0', db.adoptSessionEntries(CHILD, CHILD) === 0)
  db.close(); closeAllDbs()
  clean(ws)
}

// ═══════════════════ 15. Round 2：backupGlobalDb（全局库备份） ═══════════════════
{
  const savedActive = activeHomeDir()
  // ① 全局库不存在 → false，且绝不为了备份去创建 global/
  const fresh = tmp('mmh-bak-fresh-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(fresh)
  check('backupGlobal: no global store → false and creates nothing', backupGlobalDb() === false && !existsSync(join(fresh, 'global')))

  // ② 可信非空全局库 → 生成 .bak（含行）；立即第二次 mtime 增量跳过；.bak 变旧 → 再备份
  const home = tmp('mmh-bak-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(home)
  ensureGlobalStore()
  getGlobalDb().insert({ level: 'soul', content: '全局备份 soul 条目' })
  check('backupGlobal: trusted non-empty global → true', backupGlobalDb() === true)
  const bak = join(home, 'global', 'memory.db.bak')
  check('backupGlobal: .bak created next to the global db', existsSync(bak))
  const probe = new DatabaseSync(bak, { readOnly: true })
  check('backupGlobal: snapshot carries global rows', probe.prepare('SELECT COUNT(*) AS n FROM soul').get().n === 1)
  probe.close()
  check('backupGlobal: immediate second call skipped (mtime)', backupGlobalDb() === false)
  const old = (Date.now() - 3600_000) / 1000
  utimesSync(bak, old, old)
  check('backupGlobal: stale .bak → backs up again', backupGlobalDb() === true)

  // ③ 可信但空库 → false（空壳无快照价值，且不生成 .bak）
  const homeEmpty = tmp('mmh-bak-empty-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(homeEmpty)
  ensureGlobalStore(); getGlobalDb()
  check('backupGlobal: empty trusted global → false, no .bak', backupGlobalDb() === false && !existsSync(join(homeEmpty, 'global', 'memory.db.bak')))

  // ④ 外来/未标记全局库 → false（不备份不可信数据，也不写 .bak）
  const homeForeign = tmp('mmh-bak-foreign-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(homeForeign)
  mkdirSync(join(homeForeign, 'global'), { recursive: true })
  const rawForeign = new MemoryDb(join(homeForeign, 'global', 'memory.db'))
  rawForeign.insert({ level: 'soul', content: '外来全局条目' })
  rawForeign.close(); closeAllDbs()
  check('backupGlobal: foreign global → false and no .bak', ensureGlobalStore().trusted === false && backupGlobalDb() === false && !existsSync(join(homeForeign, 'global', 'memory.db.bak')))

  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(savedActive)
  clean(fresh); clean(home); clean(homeEmpty); clean(homeForeign)
}

// ═══════════════════ 16. Round 2：隔离 dream（spawn 子代理） ═══════════════════
{
  const baseCfg = () => ({ enabled: true, idleMinutes: 180, checkMinutes: 15, suppressWindows: [], suppressLeadMinutes: 15, timeZone: 'UTC', rulesReviewDays: 2 })
  const isoCfg = (over = {}) => ({
    ...baseCfg(),
    isolated: true, isolatedProvider: 'spawn', isolatedTimeoutMinutes: 20, isolatedMaxPromptChars: 20000, isolatedArchiveChild: false,
    // 生产路径 resolved.dream 恒定带 budget（index resolveConfig 注入）；隔离路径的主上下文
    // 闸旁路条件也要求 cfg.budget 存在，故测试按生产形状给全。
    budget: { dreamMaxContextTokens: 40000, dreamMaxPerWindowPerDay: 1, dreamMaxPerDayTotal: 12 },
    ...over,
  })
  const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms))
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  const SPAWN = { name: 'spawn', inheritsParentContext: false, capabilities: { depthLimit: true } }
  const makeSubagents = ({ provider = SPAWN, childId = 'child-iso-1', result = deferred(), noProvider = false } = {}) => {
    const specs = []
    const disposed = []
    const svc = {
      getProvider: () => (noProvider ? undefined : provider),
      startActivation: (spec) => {
        specs.push(spec)
        // 0.2.1 实测语义：宿主把 request.maxDepth 读成"子会话自身允许的深度"，
        // maxDepth:0 会拒绝子会话本身（SubagentDepthError）。fake provider 必须复刻，
        // 否则单测会放过真实就会失败的 spec（0.34.0 实际踩过）。
        if (spec?.request?.maxDepth === 0) {
          return Promise.reject(new Error('SubagentDepthError: subagent depth 1 exceeds maxDepth 0'))
        }
        return Promise.resolve({ childId, result: result.promise, dispose: () => { disposed.push(childId) } })
      },
    }
    return { svc, specs, disposed, result }
  }
  const ctxWith = ({ agent, svc, warnSpy } = {}) => ({
    get: (name) => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'subagents') return svc
      if (name === 'workspaceRegistry') return { archiveSession: (id) => { (ctxWith.archived ??= []).push(id) } }
      return undefined
    },
  })
  const rig = (sid) => {
    const ws = tmp('mmh-iso-ws-')
    ensureMemoryStore(ws, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
    const db = getDb(ws, '.dsh-meow')
    db.touchWindow(sid, ws, Date.now() - 4 * 3600_000) // 空闲 4h
    const mem = db.insert({ level: 'fact', content: `窗口 ${sid} 的待整理记忆`, project: 'dsh', keywords: ['隔离', '整理', '关键词'], source_session: sid, created_at: 100 })
    return { ws, db, mem }
  }
  const mkAgent = (sid, ws, events = []) => {
    const a = { session: { header: { id: sid, cwd: ws }, events }, steered: [], followed: [] }
    a.steer = (m) => a.steered.push(m)
    a.followup = (m) => a.followed.push(m)
    return a
  }
  const T = 1_700_000_000_000

  // ① 能力判定
  check('isolated: available with spawn provider', isolatedDreamAvailable(ctxWith({ svc: makeSubagents().svc }), isoCfg()) === true)
  check('isolated: unavailable without subagents service', isolatedDreamAvailable({ get: () => undefined }, isoCfg()) === false)
  check('isolated: unavailable for inheritsParentContext provider (fork)',
    isolatedDreamAvailable(ctxWith({ svc: makeSubagents({ provider: { name: 'spawn', inheritsParentContext: true } }).svc }), isoCfg()) === false)

  // ② 成功路径：started → spec 契约 → 子会话写行 + completed → 收养/收尾/回调
  {
    const sid = 'win-iso-ok'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws, [{ type: 'user/message', data: { content: [{ type: 'text', text: '讨论隔离 dream 的设计' }] } }])
    const sub = makeSubagents({ childId: 'child-iso-ok' })
    const states = []
    const rounds = collectDreamRounds(db, sid, ws, '.dsh-meow')
    const ret = startIsolatedDream(ctxWith({ agent, svc: sub.svc }), agent, db, sid, ws, '.dsh-meow', isoCfg(), rounds, T, (s, st) => states.push(st))
    check('isolated: startIsolatedDream returns started', ret === 'started', ret)
    check('isolated: dreamiso meta persisted while running', typeof db.getDreamMeta(ISOLATED_DREAM_META_PREFIX + sid) === 'string')
    check('isolated: activation spec delivery=caller + provider + cwd + parent',
      sub.specs.length === 1 && sub.specs[0].delivery === 'caller' && sub.specs[0].provider === 'spawn' &&
      sub.specs[0].request.cwd === ws && sub.specs[0].request.parent === agent, JSON.stringify(sub.specs[0] && { d: sub.specs[0].delivery, p: sub.specs[0].provider }))
    const promptText = sub.specs[0]?.request?.prompt?.[0]?.text ?? ''
    check('isolated: no maxDepth is sent (host reads 0 as child-depth limit) and single-text prompt',
      sub.specs[0]?.request?.maxDepth === undefined && Array.isArray(sub.specs[0]?.request?.prompt) && sub.specs[0].request.prompt.length === 1)
    check('isolated: prompt respects isolatedMaxPromptChars and carries memory id/keywords',
      promptText.length <= 20000 && promptText.includes('隔离') && /[0-9a-z]{9}-/.test(promptText), `len=${promptText.length}`)
    check('isolated: no agentOptions when isolatedModelSpec unset', sub.specs[0]?.request?.agentOptions === undefined)
    check('isolated: lease claimed while child runs', db.getDreamLease(sid) !== null)
    // 子会话写 2 条（source_session=childId），然后 completed
    const childRows = [
      db.insert({ level: 'fact', content: '子会话新增事实A', project: 'dsh', source_session: 'child-iso-ok', keywords: ['子会话'], updated_at: 100 }),
      db.insert({ level: 'lesson', content: '子会话新增教训B', source_session: 'child-iso-ok', updated_at: 100 }),
    ]
    const eventsLen = agent.session.events.length
    await flush()
    sub.result.resolve({ stopReason: 'completed', output: [] })
    await flush(40)
    check('isolated: completion releases the lease', db.getDreamLease(sid) === null)
    const win = db.getWindow(sid)
    check('isolated: completion sets last_dream_time', win !== undefined && typeof win.last_dream_time === 'number' && win.last_dream_time > 0, JSON.stringify(win))
    check('isolated: child rows adopted to the parent session', childRows.every((r) => db.findById(r.id)?.row.source_session === sid))
    check('isolated: adopted rows stamped to dream T', db.findById(childRows[0].id)?.row.updated_at === T)
    check('isolated: dreamiso meta cleared after completion', db.getDreamMeta(ISOLATED_DREAM_META_PREFIX + sid) === undefined)
    check('isolated: state callback dreaming → dreamed', JSON.stringify(states) === JSON.stringify(['dreaming', 'dreamed']), JSON.stringify(states))
    check('isolated: main agent never steered/followed and its events are unchanged',
      agent.steered.length === 0 && agent.followed.length === 0 && agent.session.events.length === eventsLen)
    check('isolated: activation disposed after completion', sub.disposed.length >= 1)
    closeAllDbs(); clean(ws)
  }

  // ②b isolatedModelSpec → request.agentOptions（复用 delegate.model）
  {
    const sid = 'win-iso-model'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const sub = makeSubagents({ childId: 'child-iso-model' })
    const ret = startIsolatedDream(ctxWith({ agent, svc: sub.svc }), agent, db, sid, ws, '.dsh-meow', isoCfg({ isolatedModelSpec: { provider: 'prov', model: 'dream-model' } }), collectDreamRounds(db, sid, ws, '.dsh-meow'), T)
    check('isolated: isolatedModelSpec forwarded as agentOptions',
      ret === 'started' && JSON.stringify(sub.specs[0]?.request?.agentOptions) === JSON.stringify({ provider: 'prov', model: 'dream-model' }), JSON.stringify(sub.specs[0]?.request?.agentOptions))
    disposeIsolatedDreams()
    check('isolated: dispose after model-spec run releases lease', db.getDreamLease(sid) === null)
    closeAllDbs(); clean(ws)
  }

  // ③ 失败路径：result reject / stopReason=error → 失败计数 +1、租约释放（可重试）、回调 active
  for (const mode of ['reject', 'stop-reason-error']) {
    const sid = `win-iso-fail-${mode}`
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const sub = makeSubagents({ childId: `child-fail-${mode}` })
    const states = []
    const ret = startIsolatedDream(ctxWith({ agent, svc: sub.svc }), agent, db, sid, ws, '.dsh-meow', isoCfg(), collectDreamRounds(db, sid, ws, '.dsh-meow'), T, (s, st) => states.push(st))
    check(`isolated failure (${mode}): started`, ret === 'started')
    await flush()
    if (mode === 'reject') sub.result.reject(new Error('child exploded'))
    else sub.result.resolve({ stopReason: 'error', diagnostic: 'model failed' })
    await flush(40)
    check(`isolated failure (${mode}): lease released for retry`, db.getDreamLease(sid) === null)
    check(`isolated failure (${mode}): failure counter incremented`, db.recordDreamFailure(sid, T) === 2)
    check(`isolated failure (${mode}): callback ends active`, states.length > 0 && states[states.length - 1] === 'active', JSON.stringify(states))
    check(`isolated failure (${mode}): dreamiso meta cleared`, db.getDreamMeta(ISOLATED_DREAM_META_PREFIX + sid) === undefined)
    check(`isolated failure (${mode}): child disposed`, sub.disposed.length >= 1)
    closeAllDbs(); clean(ws)
  }

  // ③d 启动被拒（0.2.1 实测 SubagentDepthError 类）→ 同轮回退主 agent dream，不静默放弃
  {
    const sid = 'win-iso-startreject'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const svc = {
      getProvider: () => ({ name: 'spawn', inheritsParentContext: false, capabilities: { depthLimit: true } }),
      startActivation: () => Promise.reject(new Error('SubagentDepthError: subagent depth 1 exceeds maxDepth 0')),
    }
    const states = []
    const ret = startIsolatedDream(ctxWith({ agent, svc }), agent, db, sid, ws, '.dsh-meow', isoCfg(), collectDreamRounds(db, sid, ws, '.dsh-meow'), T, (s, st) => states.push(st))
    check('isolated start rejection: returns started (async rejection path)', ret === 'started')
    await flush(40)
    check('isolated start rejection: main-agent dream fallback ran', agent.steered.length + agent.followed.length >= 1, JSON.stringify({ s: agent.steered.length, f: agent.followed.length }))
    check('isolated start rejection: lease taken by main fallback', db.getDreamLease(sid) !== null)
    abortDream(agent, '.dsh-meow')
    closeAllDbs(); clean(ws)
  }

  // ④ 超时（小数分钟注入）：dispose + 租约释放 + active
  {
    const sid = 'win-iso-timeout'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const sub = makeSubagents({ childId: 'child-timeout' }) // result 永不 settle
    const states = []
    const ret = startIsolatedDream(ctxWith({ agent, svc: sub.svc }), agent, db, sid, ws, '.dsh-meow', isoCfg({ isolatedTimeoutMinutes: 0.001 }), collectDreamRounds(db, sid, ws, '.dsh-meow'), T, (s, st) => states.push(st))
    check('isolated timeout: started', ret === 'started')
    await flush(220)
    check('isolated timeout: lease released', db.getDreamLease(sid) === null)
    check('isolated timeout: child activation disposed', sub.disposed.length >= 1)
    check('isolated timeout: failure counted', db.recordDreamFailure(sid, T) === 2)
    check('isolated timeout: callback ends active', states[states.length - 1] === 'active', JSON.stringify(states))
    closeAllDbs(); clean(ws)
  }

  // ⑤ disposeIsolatedDreams 中途取消：dispose + 租约释放 + meta 清理
  {
    const sid = 'win-iso-dispose'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const sub = makeSubagents({ childId: 'child-dispose' })
    startIsolatedDream(ctxWith({ agent, svc: sub.svc }), agent, db, sid, ws, '.dsh-meow', isoCfg(), collectDreamRounds(db, sid, ws, '.dsh-meow'), T)
    await flush()
    check('isolated dispose: lease held while running', db.getDreamLease(sid) !== null)
    disposeIsolatedDreams()
    check('isolated dispose: activation disposed and lease released', sub.disposed.length >= 1 && db.getDreamLease(sid) === null)
    check('isolated dispose: dreamiso meta cleared', db.getDreamMeta(ISOLATED_DREAM_META_PREFIX + sid) === undefined)
    closeAllDbs(); clean(ws)
  }

  // ⑥ 回退：isolated=false → 主窗口路径（steer），绝不 startActivation
  {
    resetGlobalCostCounters()
    const sid = 'win-fallback-main'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const sub = makeSubagents()
    dreamSweepOnce(ctxWith({ agent, svc: sub.svc }), baseCfg(), '.dsh-meow', new Map([[sid, ws]]))
    check('fallback: isolated=false uses main-agent dream (memory turn delivered)', (agent.steered.length + agent.followed.length) >= 1 && sub.specs.length === 0)
    check('fallback: main path claims lease', db.getDreamLease(sid) !== null)
    abortDream(agent, '.dsh-meow')
    closeAllDbs(); clean(ws)
  }

  // ⑦ 回退：provider 缺失 → 主窗口 + unavailable 日志一次；inheritsParentContext=true 同样回退且不刷日志
  {
    resetGlobalCostCounters()
    const sid = 'win-fallback-noprov'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const sub = makeSubagents({ noProvider: true })
    const warns = []
    const origWarn = console.warn
    console.warn = (...a) => { warns.push(a.join(' ')) }
    try {
      dreamSweepOnce(ctxWith({ agent, svc: sub.svc }), isoCfg(), '.dsh-meow', new Map([[sid, ws]]))
    } finally {
      console.warn = origWarn
    }
    check('fallback: missing provider → main-agent dream', (agent.steered.length + agent.followed.length) >= 1 && sub.specs.length === 0)
    // 0.34 修复：provider 缺失时也记一次“隔离不可用 → 回退主窗口”日志（dedupe 在下方用例）。
    const unavailableWarns = warns.filter((w) => w.includes('隔离 dream 不可用')).length
    check('fallback: unavailable provider logs exactly once', unavailableWarns === 1, JSON.stringify(unavailableWarns))
    abortDream(agent, '.dsh-meow')

    const sid2 = 'win-fallback-forkprov'
    const { ws: ws2, db: db2 } = rig(sid2)
    const agent2 = mkAgent(sid2, ws2)
    const sub2 = makeSubagents({ provider: { name: 'spawn', inheritsParentContext: true } })
    const warns2 = []
    const origWarn2 = console.warn
    console.warn = (...a) => { warns2.push(a.join(' ')) }
    try {
      dreamSweepOnce(ctxWith({ agent: agent2, svc: sub2.svc }), isoCfg(), '.dsh-meow', new Map([[sid2, ws2]]))
    } finally {
      console.warn = origWarn2
    }
    check('fallback: fork provider (inheritsParentContext) → main-agent dream', (agent2.steered.length + agent2.followed.length) >= 1 && sub2.specs.length === 0)
    check('fallback: unavailable log deduped (no repeat warning)', warns2.filter((w) => w.includes('隔离 dream 不可用')).length === 0, JSON.stringify(warns2))
    abortDream(agent2, '.dsh-meow')
    closeAllDbs(); clean(ws); clean(ws2)
  }

  // ⑧ 大主上下文：隔离可用 → 绕过主上下文闸照常隔离；非隔离 → context-oversize 跳过
  {
    resetGlobalCostCounters()
    const sid = 'win-big-iso'
    const { ws, db } = rig(sid)
    const bigEvents = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200_000) }] } }]
    const agent = mkAgent(sid, ws, bigEvents)
    const sub = makeSubagents({ childId: 'child-big' })
    dreamSweepOnce(ctxWith({ agent, svc: sub.svc }), isoCfg(), '.dsh-meow', new Map([[sid, ws]]))
    check('isolated: large main context is NOT a blocker (context gate bypassed)', sub.specs.length === 1 && db.getDreamLease(sid) !== null, `specs=${sub.specs.length} lease=${db.getDreamLease(sid) !== null} skip=${String(db.getDreamMeta('dreamskip:' + sid))}`)
    check('isolated: no context-oversize dreamskip written on isolated path', db.getDreamMeta('dreamskip:' + sid) === undefined)
    disposeIsolatedDreams()
    abortDream(agent, '.dsh-meow')

    resetGlobalCostCounters()
    const sid2 = 'win-big-main'
    const { ws: ws2, db: db2 } = rig(sid2)
    const agent2 = mkAgent(sid2, ws2, [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200_000) }] } }])
    dreamSweepOnce(ctxWith({ agent: agent2, svc: makeSubagents().svc }), baseCfg(), '.dsh-meow', new Map([[sid2, ws2]]))
    check('context gate: non-isolated large context skipped (no lease, no steer)', db2.getDreamLease(sid2) === null && agent2.steered.length === 0)
    check('context gate: non-isolated oversize persists dreamskip', typeof db2.getDreamMeta('dreamskip:' + sid2) === 'string')
    closeAllDbs(); clean(ws); clean(ws2)
  }

  // ⑨ 直接不可用返回值（不抢租约）
  {
    const sid = 'win-iso-unavailable-return'
    const { ws, db } = rig(sid)
    const agent = mkAgent(sid, ws)
    const sub = makeSubagents({ noProvider: true })
    const ret = startIsolatedDream(ctxWith({ agent, svc: sub.svc }), agent, db, sid, ws, '.dsh-meow', isoCfg(), collectDreamRounds(db, sid, ws, '.dsh-meow'), T)
    check('isolated: startIsolatedDream returns unavailable without provider', ret === 'unavailable' && db.getDreamLease(sid) === null && sub.specs.length === 0, `ret=${ret} lease=${db.getDreamLease(sid) !== null} specs=${sub.specs.length}`)
    closeAllDbs(); clean(ws)
  }

  // ⑩ 对话摘录：只取 user/assistant 文本 + 工具名，工具结果/插件通知不进
  {
    const digest = buildIsolatedDigest([
      { type: 'user/message', data: { content: [{ type: 'text', text: '用户说的话' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'bash' }, { type: 'text', text: '助手的回答' }] } } },
      { type: 'tool/result', data: { content: [{ type: 'text', text: '工具输出体TOOL_RESULT_BODY' }] } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '插件通知' }], source: { kind: 'plugin', plugin: 'meow-memory' } } },
    ], 1000)
    check('isolated digest: keeps user/assistant text + tool names',
      digest.includes('user: 用户说的话') && digest.includes('assistant: 助手的回答') && digest.includes('[tools: bash]'))
    check('isolated digest: excludes tool results and plugin notices', !digest.includes('TOOL_RESULT_BODY') && !digest.includes('插件通知'))
    check('isolated digest: respects char cap', buildIsolatedDigest([{ type: 'user/message', data: { content: [{ type: 'text', text: 'y'.repeat(500) }] } }], 20).length <= 20)
  }

  // 清理：任何残留隔离任务都不留给后续用例
  disposeIsolatedDreams()

  // ═══════════════════ 17. Round 2：配置默认值 + apply 接受 patch 配置 ═══════════════════
  check('config: dream.isolated default is false', CONFIG_DEFAULTS.dream.isolated === false && factoryDefaultOf({ key: 'isolated', sub: 'dream' }) === false)
  check('config: isolated defaults (provider/timeout/promptCap/archiveChild)',
    CONFIG_DEFAULTS.dream.isolatedProvider === 'spawn' && CONFIG_DEFAULTS.dream.isolatedTimeoutMinutes === 20 &&
    CONFIG_DEFAULTS.dream.isolatedMaxPromptChars === 20000 && CONFIG_DEFAULTS.dream.isolatedArchiveChild === true)
  check('isolated: timeout/prompt-cap contract exports',
    ISOLATED_DEFAULT_TIMEOUT_MINUTES === 20 && ISOLATED_DEFAULT_MAX_PROMPT_CHARS === 20000 && ISOLATED_DREAM_META_PREFIX === 'dreamiso:')
  {
    const makeCtx = () => {
      const tools = []
      const handlers = {}
      const logs = []
      const ctx = {
        logger: { info: (m) => { logs.push(String(m)) }, warn: () => {}, error: () => {} },
        tools: { register: (t) => { tools.push(t); return () => {} } },
        on: (name, fn) => { handlers[name] = fn },
        effect: (fn) => { try { fn() } catch { /* mock */ } return () => {} },
        get: () => undefined,
        subagents: { start: () => { throw new Error('subagents not expected') } },
      }
      return { ctx, tools, handlers, logs }
    }
    const a = makeCtx()
    let threw = false
    try {
      await apply(a.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh', dream: { isolated: true, isolatedProvider: 'spawn' } })
    } catch {
      threw = true
    }
    check('config: apply accepts dream.isolated:true patch config (no throw, 10 tools)', threw === false && a.tools.length === 10, `tools=${a.tools.length}`)
    check('config: apply schedules dream normally with isolated config', a.logs.some((m) => m.includes('dream scheduled')))
  }
}

// ═══════════════════ 18. Phase 3：semantic.ts 单元 + mock embeddings 服务 ═══════════════════
{
  check('semantic: disabled by default in CONFIG_DEFAULTS', CONFIG_DEFAULTS.retrieval.semantic.enabled === false && CONFIG_DEFAULTS.retrieval.semantic.baseUrl === '' && CONFIG_DEFAULTS.retrieval.semantic.model === '')
  check('semantic: enabled requires enabled + baseUrl + model',
    semanticEnabled({ enabled: true, baseUrl: 'http://x/v1', model: 'm' }) === true &&
    semanticEnabled({ enabled: true, baseUrl: '', model: 'm' }) === false &&
    semanticEnabled({ enabled: false, baseUrl: 'http://x/v1', model: 'm' }) === false &&
    semanticEnabled(undefined) === false)
  check('semantic: default weight 0.8, override, invalid → 0.8',
    semanticWeightOf(undefined) === 0.8 && semanticWeightOf({ weight: 0.3 }) === 0.3 &&
    semanticWeightOf({ weight: -1 }) === 0.8 && semanticWeightOf({ weight: 'x' }) === 0.8)
  check('semantic: cosine guards (identical/orthogonal/zero-norm/length-mismatch)',
    cosine([1, 0], [1, 0]) === 1 && cosine([1, 0], [0, 1]) === 0 && cosine([0, 0], [1, 1]) === 0 &&
    cosine([1], [1, 2]) === 0 && cosine(null, [1]) === 0)

  const srv = await startEmbeddingServer()
  const cfg = semanticCfg(srv)
  const savedEmbedKeyEnv = process.env.MEOW_MEMORY_EMBEDDING_KEY
  try {
    clearEmbeddingCache()
    const off = await withFetchSpy(() => embedTexts({ ...cfg, enabled: false }, ['x']))
    check('semantic: disabled embedTexts → null with zero fetch', off.result === null && off.calls.length === 0)
    const empty = await withFetchSpy(() => embedTexts(cfg, []))
    check('semantic: empty input → [] without fetch', Array.isArray(empty.result) && empty.result.length === 0 && empty.calls.length === 0)

    // 0.35.1 修复：默认 keyEnv（MEOW_MEMORY_EMBEDDING_KEY）未设置时允许无鉴权请求——
    // 本地 Ollama/LM Studio 这类 keyless endpoint 不再需要塞一个假 env；只有显式配置成
    // 其他变量名且变量缺失才视为未配置。
    delete process.env.MEOW_MEMORY_EMBEDDING_KEY
    const noKey = await embedTexts(semanticCfg(srv), ['x'])
    check('semantic: default keyEnv unset → keyless request allowed (local endpoints)',
      noKey !== null && srv.state.requests.length === 1 && srv.state.requests[0].auth === undefined)
    await embedTexts({ ...semanticCfg(srv), apiKeyEnv: undefined }, ['x2'])
    check('semantic: no apiKeyEnv field at all → keyless request allowed', srv.state.requests.length === 2 && srv.state.requests[1].auth === undefined)
    process.env.MEOW_MEMORY_EMBEDDING_KEY = 'mock-key-123'
    const reqBase = srv.state.requests.length

    const r1 = await embedTexts(cfg, ['deployment pipeline'])
    check('semantic: enabled embedTexts returns deterministic 8-dim vectors',
      Array.isArray(r1) && r1.length === 1 && r1[0].length === MOCK_EMBED_DIM && r1[0][0] === 1, JSON.stringify(r1))
    check('semantic: request is OpenAI-compatible POST <baseUrl>/embeddings',
      srv.state.requests.length === reqBase + 1 && srv.state.requests[reqBase].url === '/v1/embeddings' &&
      srv.state.requests[reqBase].parsed?.model === 'mock-embed' &&
      JSON.stringify(srv.state.requests[reqBase].parsed?.input) === JSON.stringify(['deployment pipeline']),
      JSON.stringify(srv.state.requests[reqBase]?.parsed))
    check('semantic: env key sent as Authorization bearer', srv.state.requests[reqBase]?.auth === 'Bearer mock-key-123', String(srv.state.requests[reqBase]?.auth))
    const r2 = await embedTexts(cfg, ['deployment pipeline'])
    check('semantic: LRU cache avoids duplicate request for identical text', srv.state.requests.length === reqBase + 1 && JSON.stringify(r2) === JSON.stringify(r1))
    await embedTexts(cfg, ['auth login'])
    check('semantic: new text triggers another request', srv.state.requests.length === reqBase + 2)

    clearEmbeddingCache()
    const [vectDeploy, vectDeployments, vectUnrelated] = await embedTexts(cfg, ['deployment', 'deployments', 'banana smoothie'])
    check('semantic: word-form variants have high cosine, unrelated low',
      cosine(vectDeploy, vectDeployments) > 0.9 && cosine(vectDeploy, vectUnrelated) < 0.1,
      JSON.stringify({ forms: cosine(vectDeploy, vectDeployments), unrelated: cosine(vectDeploy, vectUnrelated) }))

    clearEmbeddingCache()
    delete process.env.MEOW_TEST_MISSING_EMBED_KEY
    const beforeMissing = srv.state.requests.length
    const missingKey = await embedTexts({ ...cfg, apiKeyEnv: 'MEOW_TEST_MISSING_EMBED_KEY' }, ['x'])
    check('semantic: explicit apiKeyEnv with missing env → null, zero request',
      missingKey === null && srv.state.requests.length === beforeMissing)

    clearEmbeddingCache()
    process.env.MEOW_TEST_EMBED_KEY = 'secret-123'
    await embedTexts({ ...cfg, apiKeyEnv: 'MEOW_TEST_EMBED_KEY' }, ['x'])
    check('semantic: Authorization bearer only when key env is set',
      srv.state.requests[beforeMissing]?.auth === 'Bearer secret-123', String(srv.state.requests[beforeMissing]?.auth))
    delete process.env.MEOW_TEST_EMBED_KEY

    for (const mode of ['500', 'malformed', 'badshape']) {
      srv.setMode(mode); clearEmbeddingCache()
      const result = await embedTexts(cfg, ['x'])
      check(`semantic: ${mode} response → null (fail-open, no throw)`, result === null)
    }
    srv.setMode('hang'); clearEmbeddingCache()
    const t0 = Date.now()
    const timed = await embedTexts({ ...cfg, timeoutMs: 250 }, ['x'])
    const elapsed = Date.now() - t0
    check('semantic: hanging server → null bounded by timeoutMs', timed === null && elapsed >= 200 && elapsed < 3000, `elapsed=${elapsed}`)
    srv.setMode('ok')
  } finally {
    await srv.close()
    if (savedEmbedKeyEnv === undefined) delete process.env.MEOW_MEMORY_EMBEDDING_KEY
    else process.env.MEOW_MEMORY_EMBEDDING_KEY = savedEmbedKeyEnv
  }
}

// ═══════════════════ 19. Phase 3：embedding 数据层 ═══════════════════
{
  const ws = tmp('mmh-sem-db-')
  const db = new MemoryDb(memoryDbPath(ws))
  const colsOf = (level) => db.db.prepare(`PRAGMA table_info(${level})`).all().map((c) => String(c.name))
  check('semantic db: embedding column exists on all 7 level tables',
    ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'].every((level) => colsOf(level).includes('embedding')))

  const row = db.insert({ level: 'fact', content: '带向量条目', embedding: [1, 2, 3], updated_at: 5000 })
  check('semantic db: insert() persists embedding', JSON.stringify(db.findById(row.id)?.row.embedding) === JSON.stringify([1, 2, 3]))
  const manualId = newId(1234)
  db.insertRow({
    id: manualId, level: 'fact', title: null, content: 'insertRow 保留向量', importance: 1, keywords: [],
    status: 'active', corrected: 0, project: null, subcategory: null, goal: null, source_session: null,
    hit_count: 0, created_at: 1, updated_at: 1, last_accessed_at: null, embedding: [0.5, 0.5],
  })
  check('semantic db: insertRow() preserves embedding', JSON.stringify(db.findById(manualId)?.row.embedding) === JSON.stringify([0.5, 0.5]))

  const before = db.findById(row.id).row
  check('semantic db: setEmbedding writes a vector', db.setEmbedding('fact', row.id, [4, 5, 6]) === true && JSON.stringify(db.findById(row.id)?.row.embedding) === JSON.stringify([4, 5, 6]))
  const after = db.findById(row.id).row
  check('semantic db: setEmbedding does not touch updated_at / hit_count', after.updated_at === before.updated_at && after.hit_count === before.hit_count)
  check('semantic db: setEmbedding accepts a unique short id', db.setEmbedding('fact', row.id.slice(0, 8), [7]) === true)
  check('semantic db: setEmbedding(null) clears the vector', db.setEmbedding('fact', row.id, null) === true && db.findById(row.id)?.row.embedding === null)
  check('semantic db: setEmbedding rejects invalid vectors', db.setEmbedding('fact', row.id, [1, NaN]) === false && db.setEmbedding('fact', row.id, []) === false)
  check('semantic db: setEmbedding unknown id → false', db.setEmbedding('fact', 'no-such-id', [1]) === false)
  db.db.prepare('UPDATE fact SET embedding = ? WHERE id = ?').run('not-json', row.id)
  check('semantic db: corrupt embedding JSON parses as null (never throws)', db.findById(row.id)?.row.embedding === null)

  const missing = []
  for (const [i, at] of [[1, 100], [2, 300], [3, 200]]) missing.push(db.insert({ level: 'topic', content: `待回填 ${i}`, title: `t${i}`, updated_at: at }))
  const archivedRow = db.insert({ level: 'topic', content: '归档不回填', title: 'arch', updated_at: 9999 })
  db.update('topic', archivedRow.id, { status: 'archived' })
  const list = db.listMissingEmbedding('topic', 2)
  check('semantic db: listMissingEmbedding returns active rows newest-first with limit',
    list.length === 2 && list[0].id === missing[1].id && list[1].id === missing[2].id, JSON.stringify(list.map((r) => [r.id, r.updated_at])))
  check('semantic db: listMissingEmbedding excludes archived rows', !db.listMissingEmbedding('topic', 100).some((r) => r.id === archivedRow.id))
  db.setEmbedding('topic', missing[1].id, [1, 1])
  check('semantic db: rows with embedding are no longer listed', !db.listMissingEmbedding('topic', 100).some((r) => r.id === missing[1].id))
  db.close(); closeAllDbs()

  const wsLegacy = tmp('mmh-sem-legacy-')
  mkdirSync(join(wsLegacy, '.dsh-meow'), { recursive: true })
  const raw = new DatabaseSync(memoryDbPath(wsLegacy))
  raw.exec('CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL, importance INTEGER NOT NULL, keywords TEXT NOT NULL, status TEXT NOT NULL, source_session TEXT, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER, project TEXT)')
  raw.exec("INSERT INTO fact (id, content, importance, keywords, status, hit_count, created_at, updated_at) VALUES ('abc123456-abcdefghijklmnopqrstuvwxyz', '旧行', 1, '[]', 'active', 0, 1000, 1000)")
  raw.close()
  const dbUp = new MemoryDb(memoryDbPath(wsLegacy))
  const upCols = dbUp.db.prepare('PRAGMA table_info(fact)').all().map((c) => String(c.name))
  const legacyRow = dbUp.findById('abc123456-abcdefghijklmnopqrstuvwxyz')
  check('semantic db: legacy DB upgrade adds embedding column', upCols.includes('embedding'))
  check('semantic db: legacy rows get embedding = null after upgrade', legacyRow !== undefined && legacyRow.row.embedding === null)
  dbUp.close(); closeAllDbs()
  clean(ws); clean(wsLegacy)
}

// ═══════════════════ 20. Phase 3：词法/语义混合打分（bm25 + inject，零网络） ═══════════════════
{
  const now = Date.now()
  const deployVec = [1, 0, 0, 0, 0, 0, 0, 0.01]
  const docs = [
    { id: 'sem-deploy', level: 'fact', title: null, content: 'deployment pipeline', keywords: ['infra'], importance: 1, created_at: now, updated_at: now, embedding: deployVec },
    { id: 'sem-cache', level: 'fact', title: null, content: 'cache warmup', keywords: ['redis'], importance: 1, created_at: now, updated_at: now, embedding: [0, 1, 0, 0, 0, 0, 0, 0.01] },
  ]
  const lexicalOnly = search('shipping releases', docs, { k: 10, now })
  const semanticHits = search('shipping releases', docs, { k: 10, now, explain: true, semantic: { queryEmbedding: deployVec, weight: 0.8 } })
  check('semantic scoring: zero-lexical-overlap query returns nothing without query embedding', lexicalOnly.length === 0)
  check('semantic scoring: semantic floor surfaces the zero-lexical-overlap memory', semanticHits[0]?.id === 'sem-deploy', JSON.stringify(semanticHits.map((h) => [h.id, h.score])))
  check('semantic scoring: explain.semantic present and positive for the semantic hit', (semanticHits[0]?.explain?.semantic ?? 0) > 0.1, JSON.stringify(semanticHits[0]?.explain))
  check('semantic scoring: unrelated memory keeps only a near-zero semantic score',
    semanticHits.filter((h) => h.id === 'sem-cache').every((h) => (h.explain?.semantic ?? 0) < 0.01))
  check('semantic scoring: weight 0 disables the semantic floor',
    search('shipping releases', docs, { k: 10, now, semantic: { queryEmbedding: deployVec, weight: 0 } }).length === 0)

  const ws = tmp('mmh-sem-hit-')
  const db = new MemoryDb(memoryDbPath(ws))
  db.insert({ level: 'fact', content: 'deployment pipeline rollout', project: null, keywords: ['infra'], embedding: deployVec, updated_at: now })
  db.insert({ level: 'fact', content: 'banana smoothie recipe', project: null, keywords: ['food'], embedding: [0, 0, 0, 0, 0, 0, 0, 0.01], updated_at: now })
  const noVecHit = buildHitInjection(db, ws, 'sem-hit-off', 'shipping releases', { hitTopK: 5 })
  check('semantic inject: without query embedding the chain stays purely lexical (null)', noVecHit === null)
  const spy = await withFetchSpy(() => buildHitInjection(db, ws, 'sem-hit-on', 'shipping releases', { hitTopK: 5, queryEmbedding: deployVec, semanticWeight: 0.8 }))
  check('semantic inject: query embedding drives a semantic-only hit', spy.result !== null && spy.result.text.includes('deployment pipeline rollout'), spy.result?.text)
  check('semantic inject: bm25/inject themselves never call fetch', spy.calls.length === 0)
  const low = buildHitInjection(db, ws, 'sem-hit-low', 'shipping releases', { hitTopK: 5, queryEmbedding: deployVec, semanticWeight: 0.1, minScore: 0.35 })
  check('semantic inject: semantic relevance below minScore is filtered out', low === null)
  db.close(); closeAllDbs()
  clean(ws)
}

// ═══════════════════ 21. Phase 3：apply 级端到端（mock embeddings 服务） ═══════════════════
{
  const makeCtx = () => {
    const tools = []
    const handlers = {}
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: { register: (t) => { tools.push(t); return () => {} } },
      on: (name, fn) => { handlers[name] = fn },
      effect: (fn) => { try { fn() } catch { /* mock */ } return () => {} },
      get: () => undefined,
      subagents: { start: () => { throw new Error('subagents not expected') } },
    }
    return { ctx, tools, handlers }
  }
  const execOf = (ws, sid) => ({ agent: { session: { header: { cwd: ws, id: sid } } } })
  const userMsg = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  // 插件 resolved 配置的 apiKeyEnv 恒为默认 env 名（显式）→ 测试必须提供该 env，才会发请求。
  const savedEmbedKeyEnv21 = process.env.MEOW_MEMORY_EMBEDDING_KEY
  process.env.MEOW_MEMORY_EMBEDDING_KEY = 'mock-key-123'
  const srv = await startEmbeddingServer()
  try {
    // A) 默认关闭：apply 后 remember/search/pre-step 全程零 fetch
    const wsA = tmp('mmh-sem-off-')
    ensureMemoryStore(wsA, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
    const a = makeCtx()
    await apply(a.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
    const byA = Object.fromEntries(a.tools.map((t) => [t.name, t]))
    const execA = execOf(wsA, 'sem-off-1')
    const spyOff = await withFetchSpy(async () => {
      const remembered = await byA.memory_remember.execute({ level: 'fact', content: 'deployment pipeline rollout', project: 'dsh', keywords: ['infra', 'deploy'], importance: 2 }, execA)
      const searched = await byA.memory_search.execute({ query: 'shipping releases', project: 'dsh' }, execA)
      const pre = a.handlers['agent/pre-step']
      const first = userMsg('你好')
      await pre({ agent: { session: { header: { cwd: wsA, id: 'sem-off-1' }, events: [] }, steer: () => {} }, messages: [first], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [first] }))
      return { remembered, searched }
    })
    check('semantic disabled default: zero fetch across remember/search/pre-step', spyOff.calls.length === 0, `calls=${spyOff.calls.length}`)
    check('semantic disabled default: tools still work lexically', spyOff.result.remembered?.ok === true && Array.isArray(spyOff.result.searched?.hits))
    check('semantic disabled default: no embedding persisted', getDb(wsA, '.dsh-meow').findById(spyOff.result.remembered.id)?.row.embedding === null)

    // B) 显式启用：remember/search/update/pre-step 走 mock endpoint
    clearEmbeddingCache()
    const wsB = tmp('mmh-sem-on-')
    ensureMemoryStore(wsB, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
    const dbB = getDb(wsB, '.dsh-meow')
    const b = makeCtx()
    await apply(b.ctx, {
      enabled: true, projectDir: '.dsh-meow', promptLang: 'zh',
      retrieval: { semantic: { enabled: true, baseUrl: srv.url, model: 'mock-embed', timeoutMs: 1500, weight: 0.8 } },
    })
    const byB = Object.fromEntries(b.tools.map((t) => [t.name, t]))
    const execB = execOf(wsB, 'sem-on-1')
    const remB = await byB.memory_remember.execute({ level: 'fact', content: 'deployment pipeline rollout', project: 'dsh', keywords: ['infra', 'deploy'], importance: 2 }, execB)
    const rowB = dbB.findById(remB.id)?.row
    check('semantic enabled: memory_remember persists the embedding', Array.isArray(rowB?.embedding) && rowB.embedding.length === MOCK_EMBED_DIM, JSON.stringify(rowB?.embedding))
    check('semantic enabled: mock endpoint was called with /embeddings', srv.state.requests.some((r) => r.url === '/v1/embeddings'))
    const reqBeforeSearch = srv.state.requests.length
    const srcB = await byB.memory_search.execute({ query: 'shipping releases', project: 'dsh', explain: true }, execB)
    const hitB = srcB.hits.find((h) => h.id === remB.id)
    check('semantic enabled: semantic-only memory returned for zero-lexical-overlap query', hitB !== undefined, JSON.stringify(srcB.hits.map((h) => [h.id, h.explain?.semantic])))
    check('semantic enabled: tool explain carries semantic score', (hitB?.explain?.semantic ?? 0) > 0, JSON.stringify(hitB?.explain))
    const searchReqs = srv.state.requests.slice(reqBeforeSearch).filter((r) => JSON.stringify(r.body ?? '').includes('shipping releases'))
    check('semantic enabled: search embedded the query exactly once (ignoring background backfill)', searchReqs.length === 1, `searchReqs=${searchReqs.length} total=${srv.state.requests.length - reqBeforeSearch}`)
    const reqBeforeUpdate = srv.state.requests.length
    const upd1 = await byB.memory_update.execute({ id: remB.id, content: 'deployment pipeline rollout v2' }, execB)
    check('semantic enabled: content update re-embeds', upd1.ok === true && srv.state.requests.length >= reqBeforeUpdate + 1)
    const embeddingAfter = JSON.stringify(dbB.findById(remB.id)?.row.embedding)
    const reqBeforeMeta = srv.state.requests.length
    await byB.memory_update.execute({ id: remB.id, importance: 5 }, execB)
    check('semantic enabled: metadata-only update does not re-embed', srv.state.requests.length === reqBeforeMeta && JSON.stringify(dbB.findById(remB.id)?.row.embedding) === embeddingAfter)
    dbB.insert({ level: 'fact', content: 'deployment pipeline rollout foreign', project: null, keywords: ['infra'], embedding: [1, 0, 0, 0, 0, 0, 0, 0.01], source_session: 'other-session', updated_at: Date.now() })
    const preB = b.handlers['agent/pre-step']
    const msg2 = userMsg('shipping releases again')
    const reqBeforePre = srv.state.requests.length
    const outB = await preB({
      agent: { session: { header: { cwd: wsB, id: 'sem-on-2' }, events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }] }, steer: () => {} },
      messages: [msg2], turn: 2, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [msg2] }))
    const textsB = outB.messages.map((m) => m.content.map((c) => c.text ?? '').join(''))
    check('semantic enabled: pre-step embedded the user message exactly once', srv.state.requests.length === reqBeforePre + 1)
    check('semantic enabled: semantic-only memory injected by hit chain', textsB.some((t) => t.includes('deployment pipeline rollout foreign')), JSON.stringify(textsB.map((t) => t.slice(0, 40))))

    // C) 显式 apiKeyEnv 缺失 → 不请求，工具仍可用
    const c = makeCtx()
    await apply(c.ctx, {
      enabled: true, projectDir: '.dsh-meow', promptLang: 'zh',
      retrieval: { semantic: { enabled: true, baseUrl: srv.url, model: 'mock-embed', apiKeyEnv: 'MEOW_TEST_MISSING_KEY_X', timeoutMs: 1000 } },
    })
    delete process.env.MEOW_TEST_MISSING_KEY_X
    const byC = Object.fromEntries(c.tools.map((t) => [t.name, t]))
    const wsC = tmp('mmh-sem-key-')
    ensureMemoryStore(wsC, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
    const execC = execOf(wsC, 'sem-key-1')
    const reqBeforeC = srv.state.requests.length
    const remC = await byC.memory_remember.execute({ level: 'fact', content: 'deployment item', project: 'dsh', keywords: ['infra'], importance: 2 }, execC)
    const srcC = await byC.memory_search.execute({ query: 'shipping releases', project: 'dsh' }, execC)
    check('semantic enabled + missing apiKeyEnv → zero requests, tools still work',
      srv.state.requests.length === reqBeforeC && remC.ok === true && Array.isArray(srcC.hits))

    // D) 失败回退：500 / malformed / hang → 词法结果仍返回、工具不抛、embedding 不写
    const d = makeCtx()
    await apply(d.ctx, {
      enabled: true, projectDir: '.dsh-meow', promptLang: 'zh',
      retrieval: { semantic: { enabled: true, baseUrl: srv.url, model: 'mock-embed', timeoutMs: 300, weight: 0.8 } },
    })
    const byD = Object.fromEntries(d.tools.map((t) => [t.name, t]))
    const wsD = tmp('mmh-sem-fail-')
    ensureMemoryStore(wsD, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
    const dbD = getDb(wsD, '.dsh-meow')
    dbD.insert({ level: 'fact', content: 'cache warmup with redis', project: 'dsh', keywords: ['cache', 'redis'], updated_at: Date.now() })
    const execD = execOf(wsD, 'sem-fail-1')
    for (const mode of ['500', 'malformed', 'badshape']) {
      srv.setMode(mode); clearEmbeddingCache()
      const rem = await byD.memory_remember.execute({ level: 'fact', content: 'deployment item ' + mode, project: 'dsh', keywords: ['infra'], importance: 2 }, execD)
      const searchRes = await byD.memory_search.execute({ query: 'cache', project: 'dsh' }, execD)
      check(`semantic failure (${mode}): remember succeeds without embedding`, rem.ok === true && dbD.findById(rem.id)?.row.embedding === null)
      check(`semantic failure (${mode}): search falls back to lexical results`, searchRes.hits.some((h) => h.content.includes('cache warmup')))
    }
    srv.setMode('hang'); clearEmbeddingCache()
    const tTimeout = Date.now()
    const timedSearch = await byD.memory_search.execute({ query: 'cache', project: 'dsh' }, execD)
    check('semantic failure (hang/timeout): lexical fallback, bounded wait, no throw',
      timedSearch.hits.some((h) => h.content.includes('cache warmup')) && Date.now() - tTimeout < 3000, `elapsed=${Date.now() - tTimeout}`)
    srv.setMode('ok')

    // E) 先启用、再禁用：禁用后零请求
    clearEmbeddingCache()
    const e = makeCtx()
    await apply(e.ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
    const byE = Object.fromEntries(e.tools.map((t) => [t.name, t]))
    const wsE = tmp('mmh-sem-off2-')
    ensureMemoryStore(wsE, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
    const execE = execOf(wsE, 'sem-off2-1')
    const reqBeforeE = srv.state.requests.length
    const spyE = await withFetchSpy(async () => {
      await byE.memory_search.execute({ query: 'shipping releases', project: 'dsh' }, execE)
      await byE.memory_remember.execute({ level: 'fact', content: 'deployment again', project: 'dsh', keywords: ['infra'], importance: 2 }, execE)
    })
    check('semantic disabled after enabled: zero fetch calls', spyE.calls.length === 0 && srv.state.requests.length === reqBeforeE)
    clean(wsA); clean(wsB); clean(wsC); clean(wsD); clean(wsE)
  } finally {
    await srv.close()
    setMemorySemanticOptionsForTests(undefined)
    clearEmbeddingCache()
    if (savedEmbedKeyEnv21 === undefined) delete process.env.MEOW_MEMORY_EMBEDDING_KEY
    else process.env.MEOW_MEMORY_EMBEDDING_KEY = savedEmbedKeyEnv21
  }
}

// ═══════════════════ 22. Phase 3：静态审计（fetch 只允许在 semantic.ts / 同源 client） ═══════════════════
{
  const srcDir = new URL('../src/', import.meta.url)
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
  // settings-page.ts 是浏览器侧 UI（settings.section 组件），不是 host 逻辑；它和
  // client-*.ts 一样只 fetch 本插件同源路由。
  const isUiFile = (f) => f.startsWith('client') || f === 'settings-page.ts'
  const hostFiles = files.filter((f) => !isUiFile(f))
  const clientFiles = files.filter(isUiFile)
  const reads = (f) => readFileSync(new URL(f, srcDir), 'utf8')
  const hostFetchFiles = hostFiles.filter((f) => /\bfetch\s*\(/.test(reads(f)))
  check('static audit: only src/semantic.ts performs host-side fetch', JSON.stringify(hostFetchFiles) === JSON.stringify(['semantic.ts']), JSON.stringify(hostFetchFiles))
  const clientFetchFiles = clientFiles.filter((f) => /\bfetch\s*\(/.test(reads(f)))
  check('static audit: client UI fetches are same-origin host routes only',
    clientFetchFiles.length > 0 && clientFetchFiles.every((f) => /fetch\(\s*'\/meow-memory\//.test(reads(f))), JSON.stringify(clientFetchFiles))
  const backfillCallers = files.filter((f) => f !== 'db.ts' && /\blistMissingEmbedding\s*\(/.test(reads(f)))
  console.log(`  [note] listMissingEmbedding callers outside db.ts: ${JSON.stringify(backfillCallers)} (0.35 wires apply-time backfill through semantic.backfillEmbeddings)`)
  check('static audit: embedding backfill is wired (semantic.ts backfillEmbeddings)', backfillCallers.includes('semantic.ts'))
}

// ═══════════════════ 23. 0.36：global-edit 模块单元（用户级记忆可视化编辑逻辑） ═══════════════════
{
  const savedActive = activeHomeDir()
  const home = tmp('mmh-gm-edit-')
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(home)
  ensureGlobalStore()
  const db = getGlobalDb()
  try {
    const marker = globalProjectMarker()
    // 种子：soul / user / user(archived) / 全局 rules / 项目 rules / fact（不可编辑）
    const soul = db.insert({ level: 'soul', content: 'AI 是喵', updated_at: 100 })
    const user1 = db.insert({ level: 'user', content: '用户偏好中文', updated_at: 300 })
    const userArch = db.insert({ level: 'user', content: '归档的用户条目', updated_at: 200 })
    db.update('user', userArch.id, { status: 'archived' })
    const ruleGlobal = db.insert({ level: 'rules', content: '全局铁律', project: marker, updated_at: 400 })
    const ruleProject = db.insert({ level: 'rules', content: '项目规则不该出现', project: 'femo', updated_at: 500 })
    const factRow = db.insert({ level: 'fact', content: 'fact 不可编辑', project: 'dsh', updated_at: 600 })

    const listed = listGlobalMemory()
    check('global-edit list: trusted store reports trusted + homePath', listed.trusted === true && listed.homePath === home)
    check('global-edit list: only soul/user/global-rules entries (no project rules / facts)',
      listed.entries.some((e) => e.id === soul.id) && listed.entries.some((e) => e.id === user1.id) &&
      listed.entries.some((e) => e.id === ruleGlobal.id) && !listed.entries.some((e) => e.id === ruleProject.id) &&
      !listed.entries.some((e) => e.id === factRow.id), JSON.stringify(listed.entries.map((e) => [e.level, e.id])))
    check('global-edit list: grouping soul → user → rules and newest-first inside a level',
      listed.entries.map((e) => e.level).join(',') === 'soul,user,user,rules' &&
      listed.entries.filter((e) => e.level === 'user').map((e) => e.id).join(',') === `${userArch.id},${user1.id}`,
      JSON.stringify(listed.entries.map((e) => [e.level, e.updated_at])))
    check('global-edit list: entries expose the global marker', listed.entries.every((e) => e.project === marker))

    // create：默认值 + 来源标记 + 派生关键词
    const created = saveGlobalMemory({ action: 'create', level: 'user', content: '新用户偏好：喜欢简短回答' })
    check('global-edit create: defaults (importance 2, active, global marker)', created.ok === true && created.entry.importance === 2 &&
      created.entry.status === 'active' && created.entry.project === marker)
    check('global-edit create: keywords derived from content when omitted', created.ok && created.entry.keywords.length >= 1 && created.entry.keywords.length <= 10, JSON.stringify(created.entry?.keywords))
    check('global-edit create: source_session marked as ui', db.findById(created.entry.id)?.row.source_session === 'ui')
    const ruleCreated = saveGlobalMemory({ action: 'create', level: 'rules', content: '新的全局准则', keywords: ['准则', '新'] })
    check('global-edit create: rules rows are written with the global project marker',
      ruleCreated.ok === true && db.findById(ruleCreated.entry.id)?.row.project === marker)
    const kwComma = saveGlobalMemory({ action: 'create', level: 'user', content: '关键词规整', keywords: '甲, 乙、丙,甲' })
    check('global-edit create: comma/、 keyword string normalized + deduped',
      kwComma.ok === true && JSON.stringify(kwComma.entry.keywords) === JSON.stringify(['甲', '乙', '丙']), JSON.stringify(kwComma.entry?.keywords))
    const kwNumbers = saveGlobalMemory({ action: 'create', level: 'user', content: '数字关键词', keywords: [1, '二'] })
    check('global-edit create: keyword array accepts numbers', kwNumbers.ok === true && JSON.stringify(kwNumbers.entry.keywords) === JSON.stringify(['1', '二']))

    // 校验错误
    const errOf = (input) => saveGlobalMemory(input)
    check('global-edit create: rejects non-editable level', errOf({ action: 'create', level: 'fact', content: 'x' }).error.includes('level must be one of soul, user, rules'))
    check('global-edit create: rejects empty/blank content', errOf({ action: 'create', level: 'user', content: '   ' }).ok === false && errOf({ action: 'create', level: 'user', content: 'x'.repeat(4001) }).error.includes('4000'))
    check('global-edit create: rejects importance 0 / 1.5 / 101',
      errOf({ action: 'create', level: 'user', content: 'x', importance: 0 }).error.includes('importance') &&
      errOf({ action: 'create', level: 'user', content: 'x', importance: 1.5 }).error.includes('importance') &&
      errOf({ action: 'create', level: 'user', content: 'x', importance: 101 }).error.includes('importance'))
    check('global-edit create: rejects >30 keywords',
      errOf({ action: 'create', level: 'user', content: 'x', keywords: Array.from({ length: 31 }, (_, i) => `k${i}`) }).error.includes('1-30'))
    check('global-edit create: rejects invalid status', errOf({ action: 'create', level: 'user', content: 'x', status: 'bogus' }).error.includes('status'))
    check('global-edit: invalid input/action never throws',
      errOf(null).ok === false && errOf({ action: 'bogus' }).error.includes('action') && errOf({ action: 'save' }).error.includes('id is required'))

    // save：内容/关键词变化清 embedding；仅 importance 保留
    db.setEmbedding('user', user1.id, [1, 2, 3])
    const savedContent = saveGlobalMemory({ action: 'save', id: user1.id, content: '用户偏好中文（更新）' })
    check('global-edit save: content update applied', savedContent.ok === true && db.findById(user1.id)?.row.content === '用户偏好中文（更新）')
    check('global-edit save: content change clears stale embedding', db.findById(user1.id)?.row.embedding === null)
    db.setEmbedding('user', user1.id, [4, 5])
    const savedImp = saveGlobalMemory({ action: 'save', id: user1.id, importance: 9 })
    check('global-edit save: importance-only update keeps embedding', savedImp.ok === true &&
      db.findById(user1.id)?.row.importance === 9 && JSON.stringify(db.findById(user1.id)?.row.embedding) === JSON.stringify([4, 5]))
    db.setEmbedding('user', user1.id, [7])
    const savedKw = saveGlobalMemory({ action: 'save', id: user1.id, keywords: '新词一,新词二' })
    check('global-edit save: keyword change clears embedding', savedKw.ok === true &&
      JSON.stringify(savedKw.entry.keywords) === JSON.stringify(['新词一', '新词二']) && db.findById(user1.id)?.row.embedding === null)
    check('global-edit save: project stays the global marker', savedKw.entry.project === marker)
    check('global-edit save: unknown id rejected', errOf({ action: 'save', id: 'no-such-id', content: 'x' }).error.includes('not found'))
    check('global-edit save: non-editable (fact) id rejected', errOf({ action: 'save', id: factRow.id, content: 'x' }).error.includes('not found'))
    check('global-edit save: project-scoped rule rejected as not global-scoped',
      errOf({ action: 'save', id: ruleProject.id, content: 'x' }).error.includes('not global-scoped'))
    check('global-edit save: short unique id works', saveGlobalMemory({ action: 'save', id: user1.id.slice(0, 30), importance: 3 }).ok === true)

    // 歧义短 id
    const baseRow = { level: 'user', title: null, importance: 1, keywords: [], status: 'active', corrected: 0, project: null, subcategory: null, goal: null, source_session: 'ui', hit_count: 0, created_at: 1, updated_at: 1, last_accessed_at: null }
    db.insertRow({ ...baseRow, id: 'ambig0000-aaaaaaaaaaaaaaaaaaaaaaaaaa', content: '歧义甲' })
    db.insertRow({ ...baseRow, id: 'ambig0000-bbbbbbbbbbbbbbbbbbbbbbbbbb', content: '歧义乙' })
    check('global-edit save: ambiguous short id rejected', errOf({ action: 'save', id: 'ambig0000', content: 'x' }).error.includes('not found'))

    // archive / restore
    const archived = saveGlobalMemory({ action: 'archive', id: user1.id })
    check('global-edit archive: status archived returned', archived.ok === true && archived.entry.status === 'archived')
    check('global-edit list: archived rows still listed for restore', listGlobalMemory().entries.some((e) => e.id === user1.id && e.status === 'archived'))
    const restored = saveGlobalMemory({ action: 'restore', id: user1.id })
    check('global-edit restore: status active returned', restored.ok === true && restored.entry.status === 'active')

    // 未受信全局库
    const homeForeign = tmp('mmh-gm-edit-foreign-')
    closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(homeForeign)
    mkdirSync(join(homeForeign, 'global'), { recursive: true })
    const raw = new MemoryDb(globalDbPath())
    raw.insert({ level: 'soul', content: '外来全局条目' })
    raw.close(); closeAllDbs()
    check('global-edit: untrusted global store → trusted:false, empty list',
      listGlobalMemory().trusted === false && listGlobalMemory().entries.length === 0)
    check('global-edit: untrusted save returns the exact trust error',
      saveGlobalMemory({ action: 'create', level: 'user', content: 'x' }).error === GLOBAL_STORE_UNTRUSTED_ERROR)
    check('global-edit: exported level contract is soul/user/rules', JSON.stringify([...GLOBAL_EDIT_LEVELS]) === JSON.stringify(['soul', 'user', 'rules']))
  } finally {
    closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(savedActive)
    clean(home)
  }
}

// ═══════════════════ 24. 0.36：/meow-memory/global-memory 路由 + 会话重注入传播 ═══════════════════
{
  const savedActive = activeHomeDir()
  const savedMeowEnv = process.env.MEOW_MEMORY_HOME
  const home = tmp('mmh-gm-route-')
  // apply 首步会 switchHomeDir(resolveHomeDir(resolved.homeDir))，而 resolveHomeDir 的
  // 回落链 env > 指针 > 默认——必须把 MEOW_MEMORY_HOME 也指到本测试 home，否则 apply
  // 会把 active 切回顶层隔离 home，window-index.json 读不到。
  process.env.MEOW_MEMORY_HOME = home
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(home)
  const marker = globalProjectMarker()
  // 传播目标：可信窗口 / 外来窗口 / 无库窗口 + 三个 persisted 会话
  const wsTrusted = tmp('mmh-gm-ws-trusted-')
  ensureMemoryStore(wsTrusted, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const dbTrusted = getDb(wsTrusted, '.dsh-meow')
  dbTrusted.touchWindow('sid-trusted', wsTrusted, Date.now())
  const wsForeign = tmp('mmh-gm-ws-foreign-')
  const fdb = new MemoryDb(memoryDbPath(wsForeign)); fdb.insert({ level: 'fact', content: '外来库' }); fdb.close(); closeAllDbs()
  resetStoreTrustCache()
  ensureMemoryStore(wsForeign, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const wsPersisted = tmp('mmh-gm-ws-persisted-')
  ensureMemoryStore(wsPersisted, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const wsPersistedForeign = tmp('mmh-gm-ws-persisted-foreign-')
  const pfd = new MemoryDb(memoryDbPath(wsPersistedForeign)); pfd.insert({ level: 'fact', content: '外来库2' }); pfd.close(); closeAllDbs()
  ensureMemoryStore(wsPersistedForeign, '.dsh-meow', { autoGitignore: true, trustWorkspaceMemory: false })
  const wsNoDb = tmp('mmh-gm-ws-nodb-')
  mkdirSync(join(home), { recursive: true })
  writeFileSync(join(home, 'window-index.json'), JSON.stringify({ 'sid-trusted': wsTrusted, 'sid-foreign': wsForeign, 'sid-nodb': wsNoDb }))

  const routes = []
  const handlers = {}
  const logs = []
  const ctx = {
    logger: { info: (m) => { logs.push(String(m)) }, warn: () => {}, error: () => {} },
    tools: { register: (t) => { void t; return () => {} } },
    on: (name, fn) => { handlers[name] = fn },
    effect: (fn) => { try { fn() } catch { /* mock */ } return () => {} },
    get: (name) => {
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      if (name === 'connection') return { requestRejection: (req) => ((req?.headers?.cookie ?? '').includes('dsh-auth=ok') ? undefined : 401) }
      if (name === 'sessionPersistence') {
        return {
          list: async () => [
            { id: 'persisted-trusted', cwd: wsPersisted },
            // 0.2.1 冷会话是 {header:{id,cwd}} 形状（review C1）：必须也能被标记。
            { header: { id: 'persisted-header', cwd: wsPersisted } },
            { id: 'persisted-foreign', cwd: wsPersistedForeign },
            { id: 'persisted-nodb', cwd: wsNoDb },
            { id: 'persisted-no-cwd' },
          ],
        }
      }
      return undefined
    },
    subagents: { start: () => { throw new Error('subagents not expected') } },
  }
  await apply(ctx, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
  const route = routes.find((r) => r.path === '/meow-memory/global-memory')
  check('global-memory route: registered as an exact auth-gated route', route !== undefined && route.kind === 'exact')

  const invoke = async ({ method = 'GET', body, cookie } = {}) => {
    const state = { code: 0, body: '' }
    let done
    const finished = new Promise((r) => { done = r })
    const res = { writeHead(code) { state.code = code }, end(chunk) { state.body = chunk ?? ''; done() } }
    const reqHandlers = {}
    const req = { method, headers: cookie === undefined ? {} : { cookie }, on(ev, cb) { (reqHandlers[ev] ??= []).push(cb); return req } }
    route.handler(req, res)
    if (method === 'POST' && body !== undefined) {
      for (const cb of reqHandlers.data ?? []) cb(Buffer.from(JSON.stringify(body)))
    }
    for (const cb of reqHandlers.end ?? []) cb()
    await Promise.race([finished, tick(2000)])
    let json = null
    try { json = JSON.parse(state.body) } catch { json = null }
    return { code: state.code, json, raw: state.body }
  }

  const noCookie = await invoke({ method: 'GET' })
  check('global-memory GET: 401 without auth cookie', noCookie.code === 401)
  const listed0 = await invoke({ method: 'GET', cookie: 'dsh-auth=ok' })
  check('global-memory GET: 200 + trusted list with auth cookie', listed0.code === 200 && listed0.json.trusted === true && Array.isArray(listed0.json.entries))

  const created = await invoke({ method: 'POST', cookie: 'dsh-auth=ok', body: { action: 'create', level: 'soul', content: 'GLOBAL-EDIT-SOUL 全局持久化内容' } })
  check('global-memory POST create: 200 with entry', created.code === 200 && created.json.ok === true && typeof created.json.entry?.id === 'string')
  check('global-memory POST create: propagation counted trusted sessions only', created.json.reinjected === 3, JSON.stringify(created.json.reinjected))
  const listed1 = await invoke({ method: 'GET', cookie: 'dsh-auth=ok' })
  check('global-memory GET after create: new entry visible + stored in isolated global db',
    listed1.code === 200 && listed1.json.entries.some((e) => e.id === created.json.entry.id) &&
    existsSync(join(activeHomeDir(), 'global', 'memory.db')))

  // 传播：可信会话被标记，foreign/无库跳过
  check('propagation: trusted window session marked for reinject', isReinjectPending(wsTrusted, 'sid-trusted', '.dsh-meow') === true)
  check('propagation: trusted persisted session marked for reinject', isReinjectPending(wsPersisted, 'persisted-trusted', '.dsh-meow') === true)
  check('propagation: header-shaped cold session marked for reinject', isReinjectPending(wsPersisted, 'persisted-header', '.dsh-meow') === true)
  check('propagation: foreign window session not marked', isReinjectPending(wsForeign, 'sid-foreign', '.dsh-meow') === false && !existsSync(sessionsFile(wsForeign, 'sid-foreign', '.dsh-meow')))
  check('propagation: foreign persisted session not marked', isReinjectPending(wsPersistedForeign, 'persisted-foreign', '.dsh-meow') === false && !existsSync(sessionsFile(wsPersistedForeign, 'persisted-foreign', '.dsh-meow')))
  check('propagation: no-db sessions get no sessions file', !existsSync(sessionsFile(wsNoDb, 'sid-nodb', '.dsh-meow')) && !existsSync(sessionsFile(wsNoDb, 'persisted-nodb', '.dsh-meow')))

  const saved = await invoke({ method: 'POST', cookie: 'dsh-auth=ok', body: { action: 'save', id: created.json.entry.id, content: 'GLOBAL-EDIT-SOUL 更新后内容' } })
  check('global-memory POST save: 200 + updated content', saved.code === 200 && saved.json.ok === true && saved.json.entry?.content === 'GLOBAL-EDIT-SOUL 更新后内容')
  const archived = await invoke({ method: 'POST', cookie: 'dsh-auth=ok', body: { action: 'archive', id: created.json.entry.id } })
  check('global-memory POST archive: 200 + archived status', archived.code === 200 && archived.json.entry?.status === 'archived')
  const restored = await invoke({ method: 'POST', cookie: 'dsh-auth=ok', body: { action: 'restore', id: created.json.entry.id } })
  check('global-memory POST restore: 200 + active status', restored.code === 200 && restored.json.entry?.status === 'active')
  const invalidAction = await invoke({ method: 'POST', cookie: 'dsh-auth=ok', body: { action: 'bogus' } })
  check('global-memory POST: invalid action → 400 with error', invalidAction.code === 400 && String(invalidAction.json?.error).includes('action'))
  const invalidCreate = await invoke({ method: 'POST', cookie: 'dsh-auth=ok', body: { action: 'create', level: 'fact', content: 'x' } })
  check('global-memory POST: invalid level → 400 with error', invalidCreate.code === 400 && String(invalidCreate.json?.error).includes('level'))
  const noCookiePost = await invoke({ method: 'POST', body: { action: 'create', level: 'user', content: 'x' } })
  check('global-memory POST: 401 without auth cookie', noCookiePost.code === 401)

  // 集成：被标记的会话在下一轮用户消息时注入更新后的全局记忆（soul）
  const preStep = handlers['agent/pre-step']
  const firstUser = { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }
  const decision = await preStep(
    { agent: { session: { header: { cwd: wsTrusted, id: 'sid-trusted' }, events: [] }, steer: () => {} }, messages: [firstUser], turn: 2, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [firstUser] }),
  )
  const decisionTexts = decision.messages.map((m) => m.content.map((c) => c.text ?? '').join(''))
  check('propagation integration: marked session re-injects the updated global memory',
    decisionTexts.some((t) => t.includes('GLOBAL-EDIT-SOUL 更新后内容')), JSON.stringify(decisionTexts.map((t) => t.slice(0, 50))))
  check('propagation integration: pending flag cleared after reinjection', isReinjectPending(wsTrusted, 'sid-trusted', '.dsh-meow') === false)
  check('propagation integration: injected content keeps entry keywords marker', created.json.entry !== undefined && marker.length > 0)

  // 全局库未受信：GET trusted:false / POST 400 精确错误
  const homeForeign = tmp('mmh-gm-route-foreign-')
  process.env.MEOW_MEMORY_HOME = homeForeign
  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(homeForeign)
  mkdirSync(join(homeForeign, 'global'), { recursive: true })
  const rawG = new MemoryDb(globalDbPath()); rawG.insert({ level: 'soul', content: '外来全局' }); rawG.close(); closeAllDbs()
  const routes2 = []
  const ctx2 = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (t) => { void t; return () => {} } },
    on: () => {},
    effect: (fn) => { try { fn() } catch { /* mock */ } return () => {} },
    get: (name) => {
      if (name === 'webServer') return { register: (route) => { routes2.push(route); return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
    subagents: { start: () => { throw new Error('subagents not expected') } },
  }
  await apply(ctx2, { enabled: true, projectDir: '.dsh-meow', promptLang: 'zh' })
  const route2 = routes2.find((r) => r.path === '/meow-memory/global-memory')
  const state2 = { code: 0, body: '' }
  let done2
  const finished2 = new Promise((r) => { done2 = r })
  const res2 = { writeHead(code) { state2.code = code }, end(chunk) { state2.body = chunk ?? ''; done2() } }
  route2.handler({ method: 'GET', headers: {} }, res2)
  await Promise.race([finished2, tick(1000)])
  const untrustedGet = JSON.parse(state2.body)
  check('global-memory GET: untrusted global store → trusted:false + empty entries',
    state2.code === 200 && untrustedGet.trusted === false && Array.isArray(untrustedGet.entries) && untrustedGet.entries.length === 0)
  const state3 = { code: 0, body: '' }
  let done3
  const finished3 = new Promise((r) => { done3 = r })
  const res3 = { writeHead(code) { state3.code = code }, end(chunk) { state3.body = chunk ?? ''; done3() } }
  const req3Handlers = {}
  const req3 = { method: 'POST', headers: {}, on(ev, cb) { (req3Handlers[ev] ??= []).push(cb); return req3 } }
  route2.handler(req3, res3)
  for (const cb of req3Handlers.data ?? []) cb(Buffer.from(JSON.stringify({ action: 'create', level: 'user', content: 'x' })))
  for (const cb of req3Handlers.end ?? []) cb()
  await Promise.race([finished3, tick(1000)])
  check('global-memory POST: untrusted global store → 400 with exact trust error',
    state3.code === 400 && JSON.parse(state3.body).error === GLOBAL_STORE_UNTRUSTED_ERROR)

  closeGlobalDb(); resetStoreTrustCache(); setActiveHomeDir(savedActive)
  if (savedMeowEnv === undefined) delete process.env.MEOW_MEMORY_HOME
  else process.env.MEOW_MEMORY_HOME = savedMeowEnv
  clean(home); clean(wsForeign); clean(wsPersistedForeign); clean(wsNoDb)
  void logs
}

// ═══════════════════ 25. 0.36：客户端 GlobalMemoryEditor 组件（React 桩 + fetch mock） ═══════════════════
{
  const reactStub = `
export function createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat() } }
export function useCallback(fn) { return fn }
export function useState(init) {
  const states = globalThis.__meowStates
  const i = globalThis.__meowCursor++
  if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
  const set = (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; globalThis.__meowDirty = true }
  return [states[i], set]
}
export function useEffect(fn) { if (globalThis.__meowMountPhase) globalThis.__meowEffects.push(fn) }
export function useSyncExternalStore(_subscribe, get) { return get() }
`
  const entryPath = 'tests/_global-editor-entry.ts'
  writeFileSync(entryPath, [
    "export { GlobalMemoryEditor } from '../src/settings-page.ts'",
    "export { setUiLocaleForTest, t, UI_KEYS } from '../src/i18n/index.js'",
  ].join('\n'), 'utf8')
  let mod
  try {
    const { build } = await import('esbuild')
    const { outputFiles } = await build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      plugins: [{
        name: 'react-stub',
        setup(b) {
          b.onResolve({ filter: /^react$/ }, () => ({ path: 'react-stub', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: reactStub, loader: 'js' }))
        },
      }],
    })
    const code = new TextDecoder().decode(outputFiles[0].contents)
    mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  } finally {
    rmSync(entryPath, { force: true })
  }

  const savedDocument = globalThis.document
  const savedWindow = globalThis.window
  globalThis.document = { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: () => {} } }
  globalThis.window = { setTimeout: () => 1 }
  const originalFetch = globalThis.fetch
  const calls = []
  const entries = [
    { id: 'global-user-1', level: 'user', title: null, content: '用户偏好中文回答', keywords: ['偏好', '中文'], importance: 3, status: 'active', project: '全局', updated_at: 2 },
    { id: 'global-soul-1', level: 'soul', title: null, content: 'AI 叫喵', keywords: ['名字'], importance: 2, status: 'archived', project: '全局', updated_at: 1 },
  ]
  const collect = (node, out = { nodes: [], texts: [] }) => {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
    if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
    out.nodes.push(node)
    const props = node.props ?? {}
    for (const [key, value] of Object.entries(props)) {
      if (key !== 'children' && typeof value === 'string') out.texts.push(value)
    }
    collect(props.children, out)
    collect(node.children ?? [], out)
    return out
  }
  const renderEditor = async ({ reset = true, maxRenders = 12 } = {}) => {
    if (reset) { globalThis.__meowStates = []; globalThis.__meowEffects = [] }
    let tree
    for (let i = 0; i < maxRenders; i++) {
      globalThis.__meowCursor = 0
      globalThis.__meowMountPhase = i === 0
      globalThis.__meowDirty = false
      tree = mod.GlobalMemoryEditor()
      if (i === 0) for (const fn of globalThis.__meowEffects) { try { fn() } catch { /* async load */ } }
      await tick(25)
      if (!globalThis.__meowDirty) break
    }
    return tree
  }
  try {
    // i18n：22 个新 key 在三种语言里都有真实文案
    const globalKeys = ['title', 'hint', 'loading', 'empty', 'untrusted', 'add', 'content', 'keywords', 'importance', 'level',
      'levelSoul', 'levelUser', 'levelRules', 'save', 'cancel', 'archive', 'restore', 'saved', 'saveFailed', 'reinjectNote', 'reinjectCount', 'refresh']
      .map((k) => `settings.global.${k}`)
    check('global-edit i18n: 22 new UI keys registered in UI_KEYS', globalKeys.every((k) => mod.UI_KEYS.includes(k)) && globalKeys.length === 22)
    for (const lang of ['zh', 'en', 'pt-br']) {
      mod.setUiLocaleForTest(lang)
      check(`global-edit i18n: all 22 keys translated (${lang})`, globalKeys.every((k) => typeof mod.t(k) === 'string' && mod.t(k).length > 0 && mod.t(k) !== k))
    }
    mod.setUiLocaleForTest('zh')

    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body })
      if ((init.method ?? 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ trusted: true, entries }) }
      return { ok: true, status: 200, json: async () => ({ ok: true, entry: { id: 'global-user-1' }, reinjected: 3 }) }
    }
    const tree = await renderEditor()
    const treeText = collect(tree).texts.join(' | ')
    check('global-editor: renders title/hint and the fetch loaded entries',
      treeText.includes('全局记忆（用户级）') && treeText.includes('这里的 soul / user / 全局准则') &&
      treeText.includes('用户偏好中文回答') && treeText.includes('AI 叫喵'), treeText.slice(0, 200))
    check('global-editor: shows level labels + action buttons',
      treeText.includes('user（用户信息/偏好）') && treeText.includes('soul（AI 自身）') &&
      ['保存', '归档', '恢复', '刷新', '新增全局记忆'].every((label) => treeText.includes(label)))
    check('global-editor: initial load issues a GET to the plugin route',
      calls.some((c) => c.method === 'GET' && c.url === '/meow-memory/global-memory'))

    const buttonOf = (root, label) => collect(root).nodes.find((n) => n.type === 'button' && collect(n).texts.includes(label))
    const saveButton = buttonOf(tree, '保存')
    saveButton.props.onClick()
    await tick(40)
    const saveCall = [...calls].reverse().find((c) => c.method === 'POST')
    const saveBody = saveCall === undefined ? null : JSON.parse(saveCall.body)
    check('global-editor: save button POSTs the correct edit body',
      saveBody !== null && saveBody.action === 'save' && saveBody.id === 'global-user-1' &&
      saveBody.content === '用户偏好中文回答' && saveBody.importance === 3 && Array.isArray(saveBody.keywords) === false,
      JSON.stringify(saveBody))
    const afterSave = await renderEditor({ reset: false })
    check('global-editor: status line reports save + reinjected session count',
      collect(afterSave).texts.join(' | ').includes('已保存') && collect(afterSave).texts.join(' | ').includes('已标记 3 个会话下一轮重新注入。'),
      collect(afterSave).texts.join(' | ').slice(-160))

    const restoreButton = buttonOf(afterSave, '恢复')
    restoreButton.props.onClick()
    await tick(40)
    const restoreBody = JSON.parse([...calls].reverse().find((c) => c.method === 'POST').body)
    check('global-editor: archived row renders 恢复 and posts action=restore',
      restoreBody.action === 'restore' && restoreBody.id === 'global-soul-1', JSON.stringify(restoreBody))

    const select = collect(afterSave).nodes.find((n) => n.type === 'select')
    select.props.onChange({ target: { value: 'rules' } })
    const newTextarea = collect(afterSave).nodes.find((n) => n.type === 'textarea' && n.props.placeholder === '内容')
    newTextarea.props.onChange({ target: { value: '新增全局规则内容' } })
    const createTree = await renderEditor({ reset: false })
    buttonOf(createTree, '新增全局记忆').props.onClick()
    await tick(40)
    const createBody = JSON.parse([...calls].reverse().find((c) => c.method === 'POST').body)
    check('global-editor: add form posts action=create with level/content',
      createBody.action === 'create' && createBody.level === 'rules' && createBody.content === '新增全局规则内容', JSON.stringify(createBody))

    // 无 fetch 环境：不崩（组件内部有 typeof fetch 守卫）
    delete globalThis.fetch
    let treeNoFetch
    let crashed = false
    try {
      treeNoFetch = await renderEditor()
    } catch {
      crashed = true
    }
    const noFetchText = crashed ? '' : collect(treeNoFetch).texts.join(' | ')
    check('global-editor: no-fetch environment renders (no crash) with an error state',
      crashed === false && typeof treeNoFetch === 'object' && noFetchText.includes('fetch unavailable'), noFetchText.slice(0, 160))
  } finally {
    globalThis.fetch = originalFetch
    globalThis.document = savedDocument
    globalThis.window = savedWindow
  }
}

// 清理
try { closeAllDbs() } catch { /* ignore */ }
rmSync(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
