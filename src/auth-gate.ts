/**
 * 连接鉴权闸（#57）：给本插件经 webServer.register 直注册的路由补上官方鉴权。
 *
 * 背景：dsh 的鉴权由 dsh-client-connection 执行，但它只包 connection.register 的
 * 路由与 index fallback 外；webServer.register 的路由不经过任何闸——本插件的
 * /meow-memory/* 三条路由此前跨站可读可写（同机接了栅栏的插件为 401/403）。
 *
 * 修复与 dsh-meow-smooth 的 auth-gate 同源同语义（其 0.4.x 真机验证过的实现）：
 * - dsh ≥0.1.5：connection.requestRejection（Host fence 403 → 未认证 401 → 放行）。
 * - dsh ≤0.1.2：connection 服务存在但没有 requestRejection（0.1.5 才加入）。旧版
 *   官方 /api 的闸是纯 Host/Origin fence（isTrustedApiRequest：loopback/LAN IP
 *   字面量/声明 trustedHosts 之外 403；sec-fetch-site: cross-site 403；Origin 与
 *   Host 不同源 403）。这里逐语义复刻同一把 fence，trustedHosts 从 connection
 *   服务读取；回退后旧宿主的防护与官方 /api 恰好等价，绝不比官方更松。
 * - connection 服务整个缺失（异常装配）：保守拒绝（503）——鉴权能力不可用时
 *   静默放行等于退回"无鉴权"形态，宁可不可用。
 */

/** connection 服务最小面：0.1.5+ 的 requestRejection 与旧版的 trustedHosts。 */
export interface ConnectionAuthFace {
  requestRejection?: (req: unknown) => number | undefined
  /** 旧版（≤0.1.2）Host fence 的可信主机列表；缺省为空（等价官方默认）。 */
  trustedHosts?: readonly string[]
}

/** 从插件 ctx 取 connection 服务：先属性访问，回退 ctx.get——两版 cordis 兼容。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function connectionAuthOf(ctx: any): ConnectionAuthFace | undefined {
  let connection: ConnectionAuthFace | undefined
  try { connection = ctx.connection as ConnectionAuthFace | undefined } catch { connection = undefined }
  if ((connection === undefined || connection.requestRejection === undefined) && typeof ctx.get === 'function') {
    try { connection = ctx.get('connection') as ConnectionAuthFace | undefined } catch { connection = undefined }
  }
  return connection
}

// --- 旧版（≤0.1.2）Host fence：逐语义复刻 dsh-client-connection 的
// isTrustedApiRequest（api-request-trust.js），行为必须与官方 /api 一致。 ---

interface ParsedAuthority { hostname: string; host: string; port: string }

function fenceHeader(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null || typeof headers !== 'object') return undefined
  const h = headers as Record<string, unknown>
  // Fetch Headers 形态（官方 header() 同款兼容）：get() 优先。
  const getter = (h as { get?: unknown }).get
  if (typeof getter === 'function') {
    try { const v = (h as { get: (n: string) => unknown }).get(name); if (typeof v === 'string') return v } catch { /* 非标准 get，走索引 */ }
  }
  const value = h[name]
  if (typeof value === 'string') return value
  const lower = h[name.toLowerCase()]
  return typeof lower === 'string' ? lower : undefined
}

function parseAuthority(authority: string): ParsedAuthority | undefined {
  try {
    const url = new URL(`http://${authority}`)
    return { hostname: url.hostname, host: url.host, port: url.port }
  } catch { return undefined }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 官方语义：无显式端口的条目按"HTTPS 解析得到的默认端口"参与判断——
 *  `:80`/`:443` 仍算显式端口（两种 special scheme 默认端口不同）。 */
function canonicalAuthority(entry: string, entryUrl: ParsedAuthority): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl: ParsedAuthority, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    // 条目无显式端口（canonical == hostname）→ 只比主机名（任意端口）；
    // 带显式端口 → 比 host（主机名+端口）。
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** 旧版官方 /api 的完整 Host fence（逐语义复刻）。 */
function legacyHostFence(req: unknown, trustedHosts: readonly string[]): boolean {
  const host = fenceHeader((req as { headers?: unknown })?.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (fenceHeader((req as { headers?: unknown })?.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = fenceHeader((req as { headers?: unknown })?.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/**
 * 包一层鉴权闸。
 *
 * - connection.requestRejection 可用（0.1.5+）：返回数字（403/401）原样写回，
 *   语义与 connection.register 的包装层一致；undefined 放行。
 * - connection 存在但无 requestRejection（≤0.1.2）：回退旧版官方同款 Host
 *   fence，不过 → 403，过 → 放行。
 * - connection 整个缺失：保守拒绝（503）。
 *
 * 0.32：连接服务支持**按请求惰性读取**（传函数）。旧实现只在路由注册时取一次，
 * 冷启动竞态下 connection 尚未注册 → 三条路由被永久钉在 503 直到插件重载。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function authGate<R extends { writeHead: (...args: any[]) => void; end: (...args: any[]) => void }>(
  connectionOrGetter: ConnectionAuthFace | undefined | (() => ConnectionAuthFace | undefined),
  handler: (req: unknown, res: R) => void,
): (req: unknown, res: R) => void {
  return (req, res) => {
    const connection = typeof connectionOrGetter === 'function' ? connectionOrGetter() : connectionOrGetter
    const reject = connection?.requestRejection
    if (typeof reject === 'function') {
      const rejection = reject.call(connection, req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      handler(req, res)
      return
    }
    // 旧版宿主（≤0.1.2）：connection 存在但没有 requestRejection → 复刻旧版
    // 官方 /api 的 Host fence；trustedHosts 缺省为空（loopback 永远放行）。
    if (connection !== undefined) {
      if (!legacyHostFence(req, connection.trustedHosts ?? [])) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      handler(req, res)
      return
    }
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('meow-memory: authentication service unavailable')
  }
}
