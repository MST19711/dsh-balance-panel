# v0.3.1 — 认领插件自持的 OpenCode Go 兄弟路由

> 2026-09-10 · 向后兼容的小版本；`opencode-go` / `zhipu` / `deepseek` 三个后端行为不变。

## 问题

在 `dsh-opencode-go-auto` 插件新增的 `opencode-go-auto` 路由下，余额面板不显示。

## 根因

面板按「当前会话的 provider」挑选后端，每个后端用自己的 `matchesProvider(id, node)` 认领：

```js
async function resolveStatus(ctx, sessionId) {
  const stripped = stripTwinSuffix(current.provider)
  const node = listProviderNodes(ctx).find((entry) => entry.id === stripped) ?? null
  for (const backend of BACKENDS) {
    if (!backend.matchesProvider(stripped, node ?? {})) continue
    ...
```

而 `listProviderNodes()` 只扫描**已注册 settings 命名空间**里名为 `providers` 的字典
（`llm-pi-ai` 的 providers 就是这样被发现的）。

`opencode-go-auto` 是**插件自持路由**：它的配置在自己的命名空间 `dsh-opencode-go-auto:`
下，**不在** `llm-pi-ai.providers` 里。于是：

- `node` 为 `null`；
- `matchesProvider('opencode-go-auto', {})` 的 id 判断不命中，baseURL 兜底规则因为
  拿不到 `node.baseURL` 也无从生效；
- 没有任何后端认领 → `isSupported: false` → 面板隐藏。

也就是说：**baseURL 兜底规则本身是对的，只是它看不见插件自持路由。**

## 修复

`opencode-go` 后端新增按 id 的显式认领（约 3 行）：

```js
const OCGO_ROUTE_IDS = new Set(['opencode-go', 'opencode-go-auto'])

matchesProvider(id, node) {
  if (OCGO_ROUTE_IDS.has(id)) return true
  const baseURL = typeof node?.baseURL === 'string' ? node.baseURL : ''
  return baseURL.includes('opencode.ai/zen')
}
```

同时把凭据解析改成「路由声明的引用名优先 + 默认名兜底」，与 zhipu / deepseek 两个后端
的写法一致 —— 插件自持路由没有 settings 节点，拿不到 `apiKeyEnv`，需要兜底：

```js
const OCGO_CREDENTIAL_FALLBACKS = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']
const declared = typeof node?.apiKeyEnv === 'string' && node.apiKeyEnv.length > 0 ? [node.apiKeyEnv] : []
const { key, error } = await resolveCredential(ctx, [...declared, ...OCGO_CREDENTIAL_FALLBACKS])
```

语义正确性：`opencode-go-auto` 与 `opencode-go` 用**同一把 key、同一个订阅额度**，
上游 usage 接口也是同一个（`https://opencode.ai/zen/go/v1/usage`），所以复用
`opencode-go` 后端是正确语义，不是将就。

客户端零改动 —— `isSupported` / `backendId` / `panel` 全在宿主侧算好。

## 验证

```bash
node test-deepseek-backend.mjs     # 29 项断言（含 3 项新增），全过
```

新增用例（模拟"没有 settings 节点"的插件自持路由）：

- `opencode-go-auto(无 settings 节点)被认领` → `isSupported: true`
- `opencode-go-auto 归 opencode-go 后端` → `backendId: opencode-go`
- `opencode-go-auto 打同一 usage 接口` → `https://opencode.ai/zen/go/v1/usage`

回归：`opencode-go` 仍归本后端、`zai` 维持不认领。

## 安装

```bash
bash install.sh   # 或 dsh plugin --profile web add <tgz>
systemctl --user restart dsh-web.service   # 客户端/宿主都要重新载入
```

## 已知边界

- 认领是按**路由 id 白名单**做的。若把 `dsh-opencode-go-auto` 的 `routeId` 改成别的名字，
  需要把这个新 id 加进 `OCGO_ROUTE_IDS`（或让它的 baseURL 出现在某个
  `providers` 字典里）。
- 更根本地说：**任何"插件自持路由 + 自有设置命名空间"的 provider，都不会被
  `listProviderNodes()` 看见**。本包后续若再接入这类路由，同样需要在对应后端里显式认领。
