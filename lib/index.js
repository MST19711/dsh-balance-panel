/**
 * dsh-balance-panel — Host half (v0.3.0)
 *
 * 可扩展的余额/用量面板。核心抽象是「后端注册表」:每个后端认领一类 provider
 * 路由,并把它上游的用量/余额接口归一化成统一的 panel 描述(标题 + 行 + 徽章),
 * 客户端只做通用渲染,不知道任何具体供应商。
 *
 *   GET /dsh-balance-panel/usage?sessionId=<id>
 *     → { ok, at, isSupported, backendId, current:{provider, model}, panel, error }
 *
 * 当前 provider 解析顺序(与 host-apiproxy 的 selectionFor 对齐):
 *   1) 会话最近一次请求的 provider/model(agents → session.requestHeader().config)
 *   2) 全局默认(agentDefaultModel.currentSelection())
 * vision-router 的双生路由(<provider>-vision)先剥离 -vision 后缀再匹配后端。
 *
 * 内置后端:
 *   - opencode-go:OpenCode Go 订阅配额(GET opencode.ai/zen/go/v1/usage,
 *     社区事实标准接口;三窗口剩余百分比,订阅语义 → 行带进度条)。
 *     接口来源:cc-switch#6433、liangyuer/OpenCodeMonitor。
 *   - zhipu:智谱开放平台按量计费现金余额(GET open.bigmodel.cn
 *     /api/biz/account/query-customer-account-report,控制台内部接口;
 *     纯金额行 —— 按量计费没有配额窗口,不存在「剩余比例」语义,不带进度条)。
 *   - deepseek:DeepSeek 开放平台按量计费现金余额(GET api.deepseek.com
 *     /user/balance,官方公开接口;纯金额行,同 zhipu 语义)。
 *
 * key 只经 DSH credentials 服务解析,在服务端进程内使用,永不回传客户端、不写日志。
 *
 * License: MIT
 */

const ROUTE_PREFIX = '/dsh-balance-panel'

/** 本包版本。仅用于上游 User-Agent 标识(版本号同时出现在 package.json)。 */
const VERSION = '0.3.1'

/** 上游请求超时。 */
const FETCH_TIMEOUT_MS = 10_000

/** 同一行进度条 tone 的阈值(剩余百分比):≤10 红、≤30 橙。订阅配额语义专用。 */
function toneOfPct(remaining) {
  if (remaining <= 10) return 'danger'
  if (remaining <= 30) return 'warn'
  return 'ok'
}

/**
 * 各币种的低余额阈值(绝对金额):[危险线, 警戒线]。上游按账号归属地返回
 * CNY 或 USD,两者量级差一个汇率,不能共用一套阈值。
 */
const MONEY_TONE_THRESHOLDS = {
  CNY: [10, 50],
  USD: [2, 10],
}

/** 币种符号。未知币种退化为「代码 + 空格」前缀,不做汇率假设。 */
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] ?? (typeof code === 'string' && code.length > 0 ? code + ' ' : '')
}

/** 带入参校验的金额格式化。金额不是有限数 → 破折号;极小正值多给两位小数。 */
function formatAmount(value, code) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const digits = n > 0 && n < 0.01 ? 4 : 2
  return currencySymbol(code) + n.toFixed(digits)
}

/** 兼容旧调用点(智谱固定 CNY)的简写。 */
function fmtMoney(cny) {
  return formatAmount(cny, 'CNY')
}

/** 按币种取低余额阈值;未知币种按 CNY 阈值兜底,只影响圆点颜色不影响数值。 */
function toneOfBalance(available, code) {
  if (!Number.isFinite(available)) return 'ok'
  const [dangerLine, warnLine] = MONEY_TONE_THRESHOLDS[code] ?? MONEY_TONE_THRESHOLDS.CNY
  if (available < dangerLine) return 'danger'
  if (available < warnLine) return 'warn'
  return 'ok'
}

/** settings.describe() 里找 llm providers 字典。 */
function listProviderNodes(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.describe !== 'function') return []
  let descriptors = []
  try {
    descriptors = settings.describe()
  } catch (error) {
    ctx.logger?.warn?.('dsh-balance-panel: settings.describe failed: %s', error?.message ?? error)
    return []
  }
  const entries = []
  for (const descriptor of descriptors) {
    const providers = descriptor?.value?.providers
    if (providers === null || typeof providers !== 'object') continue
    for (const [id, node] of Object.entries(providers)) {
      if (node === null || typeof node !== 'object') continue
      const baseURL = typeof node.baseURL === 'string'
        ? node.baseURL
        : typeof node.api?.baseURL === 'string' ? node.api.baseURL : ''
      entries.push({ id, node, baseURL })
    }
  }
  return entries
}

/** 解析凭据:先试路由自己声明的 apiKeyEnv,再按后端的候选名兜底。 */
async function resolveCredential(ctx, names) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') {
    return { key: null, error: { code: 'CREDENTIAL_MISSING', message: '凭据服务不可用' } }
  }
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) continue
    try {
      const resolved = await credentials.resolve(name)
      if (typeof resolved?.value === 'string' && resolved.value.length > 0) return { key: resolved.value }
    } catch (error) {
      ctx.logger?.warn?.('dsh-balance-panel: credentials.resolve(%s) failed: %s', name, error?.message ?? error)
    }
  }
  return { key: null, error: { code: 'CREDENTIAL_MISSING', message: `凭据未配置(${names.filter(Boolean).join(' → ')})` } }
}

/** TTL 缓存:成功结果才缓存,失败下次重试;in-flight 单飞。 */
class TTLCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs
    this.#reset()
  }
  #reset() {
    this.promise = null
    this.value = null
    this.at = 0
  }
  async get(run) {
    const now = Date.now()
    if (this.value !== null && now - this.at < this.ttlMs) return this.value
    if (this.promise === null) {
      this.promise = run().then((value) => {
        this.value = value
        this.at = Date.now()
        return value
      }).finally(() => {
        this.promise = null
      })
    }
    return this.promise
  }
}

/* ══════════════════════════════════════════════════════════════
 * 后端 1:OpenCode Go(订阅配额,行带进度条)
 * ══════════════════════════════════════════════════════════════ */

const OCGO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/**
 * 与 `opencode-go` 共用同一订阅池的兄弟路由 id。
 *
 * 为什么需要按 id 认领而不是靠 baseURL：`listProviderNodes()` 只扫描**已注册
 * settings 命名空间**里名为 `providers` 的字典。像 `dsh-opencode-go-auto`
 * 这类**插件自持路由**把配置放在自己的命名空间下（`dsh-opencode-go-auto:`），
 * 在 `llm-pi-ai.providers` 里没有节点 → `node` 为 null → baseURL 规则无从生效。
 * 它们与 `opencode-go` 用同一把 key、同一个订阅额度，因此按 id 显式认领。
 */
const OCGO_ROUTE_IDS = new Set(['opencode-go', 'opencode-go-auto'])

/** 凭据候选：路由自己声明的优先，其次本后端的默认引用名。 */
const OCGO_CREDENTIAL_FALLBACKS = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']

const opencodeGoBackend = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  cache: new TTLCache(15_000),

  matchesProvider(id, node) {
    // 兄弟路由（含插件自持的自动路由）：同一订阅池，直接认领。
    if (OCGO_ROUTE_IDS.has(id)) return true
    const baseURL = typeof node?.baseURL === 'string' ? node.baseURL : ''
    return baseURL.includes('opencode.ai/zen')
  },

  async resolvePanel(ctx, providerId, node) {
    const declared = typeof node?.apiKeyEnv === 'string' && node.apiKeyEnv.length > 0 ? [node.apiKeyEnv] : []
    const { key, error } = await resolveCredential(ctx, [...declared, ...OCGO_CREDENTIAL_FALLBACKS])
    if (key === null) return { ok: false, error }

    let response = null
    try {
      response = await fetch(OCGO_USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'x-api-key': key,
          'User-Agent': 'dsh-balance-panel/' + VERSION,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (fetchError) {
      ctx.logger?.warn?.('dsh-balance-panel: opencode-go fetch failed: %s', fetchError?.message ?? fetchError)
      return { ok: false, error: { code: 'FETCH_FAILED', message: '无法连接 OpenCode Go 用量接口' } }
    }

    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok) {
      const type = body?.error?.type ?? null
      const code = type === 'AuthError' ? 'HTTP_401' : type === 'EntitlementError' ? 'ENTITLEMENT' : 'UPSTREAM_ERROR'
      return {
        ok: false,
        error: { code, message: `${type ?? ('HTTP ' + response.status)}${typeof body?.error?.message === 'string' ? ': ' + body.error.message : ''}` },
      }
    }
    if (body === null || typeof body?.usage !== 'object') {
      return { ok: false, error: { code: 'BAD_RESPONSE', message: '上游响应缺少 usage 字段' } }
    }

    const countdown = (iso) => {
      if (typeof iso !== 'string' || iso.length === 0) return ''
      const ms = new Date(iso).getTime() - Date.now()
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const s = Math.floor(ms / 1000)
      const d = Math.floor(s / 86400)
      const h = Math.floor((s % 86400) / 3600)
      const m = Math.floor((s % 3600) / 60)
      if (d > 0) return d + 'd ' + h + 'h'
      if (h > 0) return h + 'h ' + m + 'm'
      if (m > 0) return m + 'm'
      return '即将重置'
    }
    const windowRow = (label, entry) => {
      if (entry === null || typeof entry !== 'object' || entry.status !== 'ok' || typeof entry.percent !== 'number') return null
      const remaining = Math.max(0, 100 - entry.percent)
      const cd = countdown(entry.resetsAt)
      return {
        label,
        value: '剩 ' + remaining + '%' + (cd ? ' · ' + cd : ''),
        bar: { fill: remaining, tone: toneOfPct(remaining) },
      }
    }

    const rows = []
    for (const [label, key] of [['5h 滚动', 'rolling'], ['本周', 'weekly'], ['本月', 'monthly']]) {
      const row = windowRow(label, body.usage[key])
      if (row !== null) rows.push(row)
    }
    if (rows.length === 0) return { ok: false, error: { code: 'BAD_RESPONSE', message: '上游用量数据无法解析' } }

    const monthly = body.usage.monthly
    const weekly = body.usage.weekly
    const badgeRemaining = monthly !== null && typeof monthly === 'object' && monthly.status === 'ok' && typeof monthly.percent === 'number'
      ? Math.max(0, 100 - monthly.percent)
      : weekly !== null && typeof weekly === 'object' && weekly.status === 'ok' && typeof weekly.percent === 'number'
        ? Math.max(0, 100 - weekly.percent)
        : null

    return {
      ok: true,
      panel: {
        title: 'OpenCode Go',
        rows,
        chip: { text: 'Go 剩 ' + (badgeRemaining === null ? '?' : badgeRemaining + '%'), tone: badgeRemaining === null ? 'ok' : toneOfPct(badgeRemaining) },
        foot: 'Go 订阅',
      },
    }
  },
}

/* ══════════════════════════════════════════════════════════════
 * 后端 2:智谱开放平台(按量计费现金余额,纯金额行)
 * ══════════════════════════════════════════════════════════════ */

const ZHIPU_BALANCE_URL = 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report'
const ZHIPU_CREDENTIAL_FALLBACKS = ['ZAI_CODING_CN_API_KEY', 'ZAI_CN_API_KEY', 'ZHIPU_API_KEY']

const zhipuBackend = {
  id: 'zhipu',
  displayName: '智谱开放平台',
  cache: new TTLCache(5 * 60_000),

  // 认领:路由 id 为 zhipu,或 baseURL 指向 bigmodel.cn(含被改按量计费端点的
  // zai-coding-cn 这类路由 —— 同一账号现金池)。
  matchesProvider(id, node) {
    if (id === 'zhipu') return true
    const baseURL = typeof node?.baseURL === 'string' ? node.baseURL : ''
    return id !== 'zai' && baseURL.includes('bigmodel.cn')
  },

  async resolvePanel(ctx, providerId, node) {
    const declared = typeof node?.apiKeyEnv === 'string' && node.apiKeyEnv.length > 0 ? [node.apiKeyEnv] : []
    const { key, error } = await resolveCredential(ctx, [...declared, ...ZHIPU_CREDENTIAL_FALLBACKS])
    if (key === null) return { ok: false, error }

    let response = null
    try {
      response = await fetch(ZHIPU_BALANCE_URL, {
        method: 'GET',
        // 智谱控制台内部接口:Authorization 直接带 key(不加 Bearer)。
        headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (fetchError) {
      ctx.logger?.warn?.('dsh-balance-panel: zhipu fetch failed: %s', fetchError?.message ?? fetchError)
      return { ok: false, error: { code: 'FETCH_FAILED', message: '无法连接智谱余额接口' } }
    }

    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok || (body !== null && body.success === false)) {
      return { ok: false, error: { code: 'UPSTREAM_ERROR', message: String(body?.msg ?? ('HTTP ' + response.status)) } }
    }
    const data = body !== null && typeof body.data === 'object' ? body.data : null
    if (data === null) return { ok: false, error: { code: 'BAD_RESPONSE', message: '响应缺少 data 字段' } }

    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    const available = num(data.availableBalance) ?? num(data.balance)
    if (available === null) return { ok: false, error: { code: 'BAD_RESPONSE', message: '响应缺少余额字段' } }

    const rows = [{ label: '可用余额', value: fmtMoney(available), strong: true }]
    if (num(data.rechargeAmount) !== null) rows.push({ label: '累计充值', value: fmtMoney(data.rechargeAmount) })
    if (num(data.totalSpendAmount) !== null) rows.push({ label: '累计消费', value: fmtMoney(data.totalSpendAmount) })
    if (num(data.giveAmount) > 0) rows.push({ label: '赠送金额', value: fmtMoney(data.giveAmount) })
    if (num(data.frozenBalance) !== 0 && num(data.frozenBalance) !== null) rows.push({ label: '冻结余额', value: fmtMoney(data.frozenBalance) })
    // 不展示「今日消费」:上游 todaySpendAmount 口径与实际消耗不符(实测恒为
    // null/0),展示出来只会误导。

    return {
      ok: true,
      panel: {
        title: '智谱开放平台',
        rows,
        // 徽章圆点 = 绝对余额低额提醒(<¥10 红、<¥50 橙),不是消耗比例。
        chip: { text: 'GLM 余额 ' + fmtMoney(available), tone: toneOfBalance(available, 'CNY') },
        foot: '按量计费',
      },
    }
  },
}

/* ══════════════════════════════════════════════════════════════
 * 后端 3:DeepSeek 开放平台(按量计费现金余额,纯金额行)
 * ══════════════════════════════════════════════════════════════ */

/** 官方公开余额接口,挂在 API 根(不是 /v1)上。 */
const DEEPSEEK_BALANCE_PATH = '/user/balance'
const DEEPSEEK_PUBLIC_ORIGIN = 'https://api.deepseek.com'
const DEEPSEEK_CREDENTIAL_FALLBACKS = ['DEEPSEEK_API_KEY']

/**
 * 由路由 baseURL 推导余额接口地址。
 *
 * 只取 origin 再拼 /user/balance:baseURL 常带路径(如 https://api.deepseek.com/v1、
 * 或自建网关的 /proxy/deepseek),那段路径是给 chat/completions 用的,余额接口不在其下,
 * 带着它拼会得到 /proxy/deepseek/user/balance 这类不存在的地址。
 * 非绝对 URL(本地相对路由等)无法推导 → 回退官方域名。
 */
function deepseekBalanceUrl(baseURL) {
  if (typeof baseURL === 'string' && baseURL.length > 0) {
    try {
      const origin = new URL(baseURL).origin
      if (typeof origin === 'string' && origin.startsWith('http')) return origin + DEEPSEEK_BALANCE_PATH
    } catch { /* 非绝对 URL:回退官方域名 */ }
  }
  return DEEPSEEK_PUBLIC_ORIGIN + DEEPSEEK_BALANCE_PATH
}

const deepseekBackend = {
  id: 'deepseek',
  displayName: 'DeepSeek 开放平台',
  cache: new TTLCache(5 * 60_000),

  // 认领:内置路由 id(plugins/llm-deepseek 独占的 deepseek-official),
  // 或 baseURL 指向 api.deepseek.com 的自建路由(同一账号现金池)。
  matchesProvider(id, node) {
    if (id === 'deepseek' || id === 'deepseek-official') return true
    const baseURL = typeof node?.baseURL === 'string' ? node.baseURL : ''
    return baseURL.includes('api.deepseek.com')
  },

  async resolvePanel(ctx, providerId, node) {
    const declared = typeof node?.apiKeyEnv === 'string' && node.apiKeyEnv.length > 0 ? [node.apiKeyEnv] : []
    const { key, error } = await resolveCredential(ctx, [...declared, ...DEEPSEEK_CREDENTIAL_FALLBACKS])
    if (key === null) return { ok: false, error }

    let response = null
    try {
      response = await fetch(deepseekBalanceUrl(node?.baseURL), {
        method: 'GET',
        // 官方接口:标准 Bearer 鉴权(与 chat/completions 同一种)。
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'dsh-balance-panel/' + VERSION, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (fetchError) {
      ctx.logger?.warn?.('dsh-balance-panel: deepseek fetch failed: %s', fetchError?.message ?? fetchError)
      return { ok: false, error: { code: 'FETCH_FAILED', message: '无法连接 DeepSeek 余额接口' } }
    }

    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok) {
      const upstream = typeof body?.error?.message === 'string' ? body.error.message : null
      const code = response.status === 401 || response.status === 403 ? 'HTTP_401' : 'UPSTREAM_ERROR'
      return { ok: false, error: { code, message: upstream ?? ('HTTP ' + response.status) } }
    }
    if (body === null || typeof body !== 'object') {
      return { ok: false, error: { code: 'BAD_RESPONSE', message: '上游响应不是 JSON 对象' } }
    }

    // 官方在正常响应里也会给 status:"200",不以它判定成败;以数组结构判定。
    const infos = Array.isArray(body.balance_infos)
      ? body.balance_infos.filter((info) => info !== null && typeof info === 'object')
      : []
    if (infos.length === 0) {
      return { ok: false, error: { code: 'BAD_RESPONSE', message: '响应缺少 balance_infos 字段' } }
    }

    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
    const rows = []
    let primary = null
    for (const info of infos) {
      const code = typeof info.currency === 'string' && info.currency.length > 0 ? info.currency : 'CNY'
      const available = num(info.total_balance)
      if (available === null) continue
      // 首个币种进徽章:官方接口对单币种账号只回一条。
      if (primary === null) primary = { available, code }
      rows.push({
        label: infos.length > 1 ? '可用余额 ' + code : '可用余额',
        value: formatAmount(available, code),
        strong: rows.length === 0,
      })
      // 赠送/充值构成按官方语义拆开;与智谱后端一致,零值行不展示。
      const granted = num(info.granted_balance)
      if (granted !== null && granted > 0) rows.push({ label: '其中赠送', value: formatAmount(granted, code) })
      const toppedUp = num(info.topped_up_balance)
      if (toppedUp !== null && toppedUp > 0) rows.push({ label: '其中充值', value: formatAmount(toppedUp, code) })
    }
    if (primary === null) return { ok: false, error: { code: 'BAD_RESPONSE', message: '响应缺少 total_balance 字段' } }

    // is_available=false 表示账户已欠费/不可用,必须显式说明,否则「余额 0」看不出原因。
    // 只在异常时加行:正常账号不需要一行无信息量的「状态:正常」。
    if (body.is_available === false) rows.push({ label: '账户状态', value: '已欠费停用', strong: true })

    return {
      ok: true,
      panel: {
        title: 'DeepSeek',
        rows,
        chip: {
          text: 'DS 余额 ' + formatAmount(primary.available, primary.code),
          tone: body.is_available === false ? 'danger' : toneOfBalance(primary.available, primary.code),
        },
        foot: '按量计费',
      },
    }
  },
}

/** 后端注册表:顺序即优先级。新增供应商 = 在这里加一个后端对象。 */
const BACKENDS = [opencodeGoBackend, zhipuBackend, deepseekBackend]

/* ══════════════════════════════════════════════════════════════
 * 当前 provider 解析 + 路由
 * ══════════════════════════════════════════════════════════════ */

/** vision-router 双生路由 <provider>-vision → 源路由。 */
function stripTwinSuffix(providerId) {
  return typeof providerId === 'string' && providerId.endsWith('-vision')
    ? providerId.slice(0, -'-vision'.length)
    : providerId
}

function resolveCurrentProvider(ctx, sessionId) {
  if (sessionId) {
    try {
      const agent = ctx.get('agents')?.get(String(sessionId))
      const cfg = agent?.session?.requestHeader?.()?.config
      if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
        return { provider: cfg.provider, model: cfg.model }
      }
    } catch { /* 回落全局默认 */ }
  }
  try {
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (sel && typeof sel.provider === 'string') {
      return { provider: sel.provider, model: typeof sel.model === 'string' ? sel.model : null }
    }
  } catch { /* ignore */ }
  return null
}

async function resolveStatus(ctx, sessionId) {
  const current = resolveCurrentProvider(ctx, sessionId)
  if (current === null) return { ok: true, isSupported: false, current: null }

  const stripped = stripTwinSuffix(current.provider)
  const node = listProviderNodes(ctx).find((entry) => entry.id === stripped) ?? null

  for (const backend of BACKENDS) {
    if (!backend.matchesProvider(stripped, node ?? {})) continue
    let result = null
    try {
      result = await backend.cache.get(() => backend.resolvePanel(ctx, stripped, node))
    } catch (error) {
      ctx.logger?.warn?.('dsh-balance-panel: %s resolve failed: %s', backend.id, error?.message ?? error)
      result = { ok: false, error: { code: 'INTERNAL', message: '后端查询内部错误' } }
    }
    return {
      ok: true,
      at: Date.now(),
      isSupported: true,
      backendId: backend.id,
      current: { provider: current.provider, model: current.model },
      panel: result.ok === true ? result.panel : null,
      error: result.ok === true ? null : (result.error ?? { code: 'UNKNOWN', message: '未知错误' }),
    }
  }

  return { ok: true, at: Date.now(), isSupported: false, current: { provider: current.provider, model: current.model } }
}

function respondJson(res, status, value) {
  const data = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(data.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(data)
}

/** 同源/本机防护:余额数据只放行 loopback 同源读取。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function isTrusted(req) {
  const host = req.headers.host
  if (!host) return false
  if (!isLoopbackHostname(host.split(':')[0])) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === host } catch { return false }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const disposer = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler(req, res) {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname)
      if (req.method !== 'GET' || pathname !== `${ROUTE_PREFIX}/usage`) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      if (!isTrusted(req)) {
        respondJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'forbidden' } })
        return
      }
      const sessionId = new URL(req.url ?? '/', 'http://local').searchParams.get('sessionId')
      resolveStatus(ctx, sessionId).then((value) => {
        respondJson(res, 200, value)
      }, (error) => {
        ctx.logger?.warn?.('dsh-balance-panel: status resolve failed: %s', error?.message ?? error)
        respondJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: '余额面板内部错误' } })
      })
    },
  })

  ctx.effect(() => () => disposer?.())
}

export const inject = ['webServer']

export default { apply, inject }
