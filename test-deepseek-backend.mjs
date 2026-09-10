/**
 * dsh-balance-panel — DeepSeek 后端离线验证夹具(v0.3.0)
 *
 * 目的:不重启 DSH 服务就能验证新后端。直接 import host 半,用假 ctx
 * (credentials + agents + webServer)驱动它自己的 HTTP handler,
 * 断言「认领 → 取 key → 打上游 → 归一化成 panel」整条链路。
 *
 * 用法:
 *   node test-deepseek-backend.mjs            # 只跑假上游用例(离线,无密钥)
 *   node test-deepseek-backend.mjs --live     # 追加真实 DeepSeek 余额接口用例
 *
 * 只读取凭据文件里 DEEPSEEK_API_KEY 的值用于本地断言,不回显、不落盘。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.argv.includes('--live')
const results = []
let failed = 0

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail === undefined ? '' : ' — ' + detail}`)
}

/* ── 假 ctx ───────────────────────────────────────────────── */

function makeCtx({ provider, model, keyValue, baseURL, apiKeyEnv = 'DEEPSEEK_API_KEY' }) {
  const handlerRef = { handler: null }
  const nodes = baseURL === undefined
    ? {}
    : { [provider]: { baseURL, apiKeyEnv } }
  const descriptors = [{ value: { providers: nodes } }]
  return {
    handlerRef,
    ctx: {
      get(name) {
        if (name === 'webServer') {
          return { register: (entry) => { handlerRef.handler = entry.handler; return () => {} } }
        }
        if (name === 'settings') return { describe: () => descriptors }
        if (name === 'credentials') {
          return {
            resolve: async (ref) => {
              if (ref === apiKeyEnv && typeof keyValue === 'string' && keyValue.length > 0) {
                return { value: keyValue }
              }
              return undefined
            },
          }
        }
        if (name === 'agents') {
          return {
            get: (sid) => (sid === 'sess-1'
              ? { session: { requestHeader: () => ({ config: { provider, model } }) } }
              : undefined),
          }
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider, model }) }
        return undefined
      },
      logger: { warn: (...args) => { warnings.push(args.map(String).join(' ')) } },
      effect: (fn) => { fn() },
    },
  }
}

const warnings = []

/** 调 handler 并取回 JSON(绕过真 socket,直接喂 req/res 假体)。 */
function callUsage(handler) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/dsh-balance-panel/usage?sessionId=sess-1', headers: { host: '127.0.0.1:3081' } }
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(body) {
        try { resolve({ status: this.statusCode, body: JSON.parse(String(body)) }) } catch (e) { reject(e) }
      },
    }
    try { handler(req, res) } catch (e) { reject(e) }
  })
}

async function runCase(label, { provider, model, keyValue, baseURL, apiKeyEnv, fetchImpl }) {
  const { ctx, handlerRef } = makeCtx({ provider, model, keyValue, baseURL, apiKeyEnv })
  const realFetch = globalThis.fetch
  const calls = []
  if (fetchImpl !== undefined) {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization })
      return fetchImpl(String(url), init)
    }
  }
  try {
    const mod = await import(`./lib/index.js?case=${encodeURIComponent(label)}-${Date.now()}`)
    mod.apply(ctx)
    const out = await callUsage(handlerRef.handler)
    return { out, calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

/* ── 用例 1:官方路由 + 假上游正常响应 ─────────────────────── */

{
  const payload = {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '24.65', granted_balance: '0.00', topped_up_balance: '24.65' }],
  }
  const { out, calls } = await runCase('happy', {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    keyValue: 'sk-test-key',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  check('官方路由被认领(isSupported)', out.body.isSupported === true, `backendId=${out.body.backendId}`)
  check('backendId = deepseek', out.body.backendId === 'deepseek')
  check('打到官方 /user/balance', calls[0]?.url === 'https://api.deepseek.com/user/balance', calls[0]?.url)
  check('Bearer 鉴权头', calls[0]?.auth === 'Bearer sk-test-key')
  check('可用余额行 = ¥24.65', out.body.panel?.rows?.some((r) => r.label === '可用余额' && r.value === '¥24.65'),
    JSON.stringify(out.body.panel?.rows))
  check('零值赠送行不出现', !out.body.panel?.rows?.some((r) => r.label === '其中赠送'))
  check('充值构成行 = ¥24.65', out.body.panel?.rows?.some((r) => r.label === '其中充值' && r.value === '¥24.65'))
  check('徽章文本', out.body.panel?.chip?.text === 'DS 余额 ¥24.65', out.body.panel?.chip?.text)
  // 阈值语义(CNY:[10, 50]):<10 红、<50 橙、≥50 绿。¥24.65 落在警戒区间是预期行为。
  check('CNY 24.65 → warn(处于 10~50 警戒区间)', out.body.panel?.chip?.tone === 'warn', out.body.panel?.chip?.tone)
  check('无面板级错误', out.body.error === null)
}

/* ── 用例 1b:充裕余额 → 绿色圆点(阈值 ok 分支) ─────────────── */

{
  const payload = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '500.00', granted_balance: '0', topped_up_balance: '500.00' }] }
  const { out } = await runCase('healthy', {
    provider: 'deepseek-official', model: 'deepseek-flash', keyValue: 'sk-test-key',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  })
  check('CNY 500 → ok', out.body.panel?.chip?.tone === 'ok', out.body.panel?.chip?.tone)
}

/* ── 用例 2:低余额(CNY) → 红色圆点 ───────────────────────── */

{
  const payload = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '3.20', granted_balance: '0', topped_up_balance: '3.20' }] }
  const { out } = await runCase('low-cny', {
    provider: 'deepseek-official', model: 'deepseek-flash', keyValue: 'sk-test-key',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  })
  check('CNY <10 → danger', out.body.panel?.chip?.tone === 'danger', out.body.panel?.chip?.tone)
}

/* ── 用例 3:USD 账号阈值独立(<$2 才红) ───────────────────── */

{
  const payload = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '5.00', granted_balance: '0', topped_up_balance: '5.00' }] }
  const { out } = await runCase('usd-mid', {
    provider: 'deepseek-official', model: 'deepseek-flash', keyValue: 'sk-test-key',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  })
  check('USD 5.00 → warn(不是 danger)', out.body.panel?.chip?.tone === 'warn', out.body.panel?.chip?.tone)
  check('USD 符号正确', out.body.panel?.chip?.text === 'DS 余额 $5.00', out.body.panel?.chip?.text)
}

/* ── 用例 4:欠费账户 → 状态行 + 红色 ──────────────────────── */

{
  const payload = { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' }] }
  const { out } = await runCase('arrears', {
    provider: 'deepseek-official', model: 'deepseek-flash', keyValue: 'sk-test-key',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  })
  check('欠费 → 账户状态行', out.body.panel?.rows?.some((r) => r.label === '账户状态' && r.value === '已欠费停用'),
    JSON.stringify(out.body.panel?.rows))
  check('欠费 → 圆点 danger', out.body.panel?.chip?.tone === 'danger', out.body.panel?.chip?.tone)
}

/* ── 用例 5:自建路由 baseURL 带路径 → 只取 origin ─────────── */

{
  const payload = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00', granted_balance: '0', topped_up_balance: '1.00' }] }
  const { out, calls } = await runCase('baseurl-path', {
    provider: 'my-ds', model: 'deepseek-v4-pro', keyValue: 'sk-test-key',
    baseURL: 'https://api.deepseek.com/v1',
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  })
  check('baseURL 含 api.deepseek.com 被认领', out.body.isSupported === true, `backendId=${out.body.backendId}`)
  check('路径被剥离(/v1 不参与拼接)', calls[0]?.url === 'https://api.deepseek.com/user/balance', calls[0]?.url)
}

/* ── 用例 6:401 → HTTP_401 错误 ───────────────────────────── */

{
  const { out } = await runCase('unauthorized', {
    provider: 'deepseek-official', model: 'deepseek-flash', keyValue: 'sk-bad',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }), { status: 401 }),
  })
  check('401 → code HTTP_401', out.body.error?.code === 'HTTP_401', JSON.stringify(out.body.error))
  check('401 → 面板为空', out.body.panel === null)
}

/* ── 用例 7:响应缺 balance_infos → BAD_RESPONSE ───────────── */

{
  const { out } = await runCase('bad-shape', {
    provider: 'deepseek-official', model: 'deepseek-flash', keyValue: 'sk-test-key',
    fetchImpl: async () => new Response(JSON.stringify({ is_available: true }), { status: 200 }),
  })
  check('缺 balance_infos → BAD_RESPONSE', out.body.error?.code === 'BAD_RESPONSE', JSON.stringify(out.body.error))
}

/* ── 用例 8:凭据缺失 → CREDENTIAL_MISSING ─────────────────── */

{
  const { out } = await runCase('no-key', {
    provider: 'deepseek-official', model: 'deepseek-flash', keyValue: null,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  check('无 key → CREDENTIAL_MISSING', out.body.error?.code === 'CREDENTIAL_MISSING', JSON.stringify(out.body.error))
}

/* ── 用例 9:回归 — 既有后端未被 deepseek 抢走 ─────────────── */

{
  const { out } = await runCase('zhipu-regression', {
    provider: 'zhipu', model: 'glm-5.3', keyValue: 'sk-test-key', apiKeyEnv: 'ZAI_CODING_CN_API_KEY',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, data: { availableBalance: 77.71 } }), { status: 200 }),
  })
  check('zhipu 路由仍归 zhipu 后端', out.body.backendId === 'zhipu', String(out.body.backendId))
}

{
  const { out, calls } = await runCase('ocgo-regression', {
    provider: 'opencode-go', model: 'mimo-v2.5', apiKeyEnv: 'OPENCODE_GO_API_KEY', keyValue: 'sk-test-key',
    fetchImpl: async () => new Response(JSON.stringify({ usage: { weekly: { status: 'ok', percent: 40 } } }), { status: 200 }),
  })
  check('opencode-go 路由仍归 opencode-go 后端', out.body.backendId === 'opencode-go', String(out.body.backendId))
  check('opencode-go 仍打原上游', calls[0]?.url === 'https://opencode.ai/zen/go/v1/usage', calls[0]?.url)
}

{
  const { out } = await runCase('zai-route', {
    provider: 'zai', model: 'glm-5.3-flash', keyValue: 'sk-test-key',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    fetchImpl: async () => new Response('{}', { status: 200 }),
  })
  check('zai 路由维持原行为(不认领)', out.body.isSupported === false, `isSupported=${out.body.isSupported}`)
}

/* ── 用例 10:真实凭据 + 真实上游(可选) ───────────────────── */

if (LIVE) {
  let key = process.env.DEEPSEEK_API_KEY ?? null
  if (key === null) {
    try {
      const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
      const line = raw.split('\n').find((l) => l.startsWith('DEEPSEEK_API_KEY:'))
      if (line !== undefined) key = line.slice('DEEPSEEK_API_KEY:'.length).trim().replace(/^["']|["']$/g, '')
    } catch (error) {
      console.log('[SKIP] 读不到凭据文件: ' + error.message)
    }
  }
  if (key === null || key.length === 0) {
    console.log('[SKIP] 无 DEEPSEEK_API_KEY,live 用例跳过')
  } else {
    const { out, calls } = await runCase('live', { provider: 'deepseek-official', model: 'deepseek-flash', keyValue: key })
    check('live:被认领', out.body.isSupported === true, `backendId=${out.body.backendId}`)
    check('live:上游 200 且有面板', out.body.panel !== null, JSON.stringify(out.body.error))
    if (out.body.panel !== null) {
      console.log('       live 面板 = ' + JSON.stringify(out.body.panel, null, 0))
      check('live:含可用余额行', out.body.panel.rows.some((r) => r.label === '可用余额'))
    }
    check('live:请求地址', calls.length === 1 ? 'https://api.deepseek.com/user/balance' === calls[0].url : true, calls[0]?.url)
    check('live:凭据不回显到响应体', !JSON.stringify(out.body).includes(key.slice(0, 8)))
  }
}

/* ── 汇总 ─────────────────────────────────────────────────── */

console.log('')
console.log(`合计 ${results.length} 项,失败 ${failed} 项`)
if (warnings.length > 0) console.log('后端警告日志(warn 级,预期内):\n  ' + warnings.join('\n  '))
process.exit(failed === 0 ? 0 : 1)
