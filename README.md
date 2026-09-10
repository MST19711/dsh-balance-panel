# Balance Panel — DSH 的可扩展余额/用量面板

> 产品名 **Balance Panel(余额面板)**;npm 包名 / 仓库名 `@deepseek-ai/dsh-balance-panel`。
> 本项目由 [Go Meter(v0.1.0,OpenCode Go 专用额度小窗)](RELEASE_NOTES-v0.1.0.md)泛化而来:
> v0.2.0 起是**多后端可扩展**的余额面板,OpenCode Go 只是内置后端之一。

当当前会话使用的模型命中某个已接入后端时,在 DSH Web 界面**右侧边缘**显示一张常驻小窗;
切换到未接入的 provider 时自动隐藏。**面板内容按当前 provider 自动选择,同一时刻只显示一张。**

## 内置后端

| 后端 | 认领的 provider 路由 | 语义 | 展示 |
|---|---|---|---|
| `opencode-go` | id `opencode-go`,或 baseURL 指向 `opencode.ai/zen` 的自定义路由 | 订阅配额(有窗口、有重置) | 5h 滚动 / 本周 / 本月三行「剩余百分比 + 重置倒计时 + 进度条」;剩 ≤30% 橙、≤10% 红 |
| `zhipu` | id `zhipu`,或 baseURL 指向 `bigmodel.cn` 的路由(含被改到按量计费端点的 `zai-coding-cn` —— 同一现金池) | 按量计费现金余额(**无配额窗口,不存在「剩余比例」语义**) | 纯金额行:可用余额(加粗)/ 累计充值 / 累计消费;赠送、冻结仅在非零时出现;徽章圆点按绝对余额提醒(<¥10 红、<¥50 橙) |
| `deepseek` | id `deepseek-official`(内置 `llm-deepseek` 插件独占的路由)或 id `deepseek`,或 baseURL 指向 `api.deepseek.com` 的自定义路由 | 按量计费现金余额(同 zhipu 语义) | 纯金额行:可用余额(加粗)/ 其中充值、其中赠送(非零才出现);`is_available: false` 时追加「账户状态: 已欠费停用」行;徽章圆点按币种阈值提醒 — CNY <¥10 红 / <¥50 橙,USD <$2 红 / <$10 橙 |

## 扩展一个新供应商

在 `lib/index.js` 的 `BACKENDS` 数组里加一个后端对象即可,客户端零改动:

```js
{
  id: 'my-provider',
  displayName: 'My Provider',
  cache: new TTLCache(60_000),                       // 上游结果缓存
  matchesProvider(id, node) { ... },                 // settings providers 字典里认领路由
  async resolvePanel(ctx, providerId, node) {        // 拉上游 → 归一化
    return {
      ok: true,
      panel: {
        title: 'My Provider',
        rows: [ { label: '剩余', value: '…', bar: { fill: 42, tone: 'warn' } } ], // bar 可选
        chip: { text: '…', tone: 'ok' },             // 折叠徽章文案与圆点
        foot: '…',
      },
    };
  },
}
```

行结构 `{ label, value, strong?, bar?: { fill, tone } }`:`bar` 可选 —— 配额语义才带进度条,
现金/余额类语义不要编造比例。

## 数据通路与安全

- 后端各自代理调用上游官方/控制台接口,API key 只经 DSH `credentials` 服务在服务端进程内解析,
  **key 永不进入浏览器、不写日志**;
- 各后端独立缓存(OpenCode Go 15s,智谱 / DeepSeek 各 5min),失败不缓存、下次轮询重试;
- 路由有同源/loopback 防护,跨站读取返回 403。

## 验证

```bash
node test-deepseek-backend.mjs          # 离线:假 ctx + 假上游,31 项断言(先跑这个)
node test-deepseek-backend.mjs --live   # 追加:真实 DEEPSEEK_API_KEY 打真实上游
```

夹具直接 import `lib/index.js` 并用假 `ctx`(credentials / settings / agents / webServer)
驱动它自己的 HTTP handler,**不需要重启 DSH** 就能验证「认领 → 解析 key → 打上游 →
归一化 panel」整条链路;含 zhipu / opencode-go / zai 路由不被抢走的回归用例。
`--live` 会读取 `~/.dsh/.credentials.yaml` 里的 key(只用于本地断言,不回显)。

## 界面

- 小窗:右上角卡片(标题 + 当前模型名 + 行 + 「更新于 HH:MM:SS · <后端注脚>」)+「刷新 / — 折叠」
- 折叠态:圆点徽章(文案来自 `panel.chip`),点击展开
- 设置:「设置 → 余额面板」:启用开关、刷新间隔(15/30/60/120s)、默认折叠
- v0.1.0 的本地配置自动迁移到新存储键(`dsh-balance-panel:config`)

## 安装

```bash
bash install.sh          # npm pack + dsh plugin add(默认 web profile)
```

从 v0.1.0 升级:先 `pnpm --dir ~/.dsh/profiles/web remove @deepseek-ai/dsh-opencode-go-usage`,
再运行上面的安装脚本,并把 profile `dsh.profile.bundles` 里的旧包名替换为
`@deepseek-ai/dsh-balance-panel`。重启 DSH 后生效。
