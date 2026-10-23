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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = mkdtempSync(join(tmpdir(), 'mm-hardening-home-'))
process.env.MEOW_MEMORY_HOME = join(HOME, 'meow-home')
process.env.DSH_HOME = join(HOME, 'dsh-home')

const {
  MemoryDb, memoryDbPath, getDb, closeAllDbs,
  ensureMemoryStore, storeTrustOf, resetStoreTrustCache,
  recencyWeight, search,
  buildInjection, buildHitInjection, buildReinjection, setCurrentProject,
  registerMemoryTools, setMemoryToolGate, apply,
  activeHomeDir, setActiveHomeDir,
  evaluateAutoDreamGate, dreamSweepOnce, dreamLogPath, collectDreamRounds, DREAM_MAX_ROWS_PER_ROUND,
  checkReflectBudget, recordReflectSent, estimateContextTokens, dreamMaxPerDayTotal,
  resetGlobalCostCounters, resetGlobalReflectCounter,
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

// 清理
try { closeAllDbs() } catch { /* ignore */ }
rmSync(HOME, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
