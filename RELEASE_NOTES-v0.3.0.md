# v0.3.0 — 新增 DeepSeek 开放平台余额后端

> 发布日期:2026-09-10 · 上一版本:[v0.2.2](RELEASE_NOTES-v0.2.0.md)(zhipu 字段映射修正)

非破坏性更新:后端注册表、`/usage` 响应结构、客户端渲染器、既有 4 项配置均无变化,
升版只需替换安装包(客户端与 host 可混跑,但建议同版本)。

## 新能力

- **新增 `deepseek` 后端(DeepSeek 开放平台按量计费现金余额)**:
  - 接口:`GET https://api.deepseek.com/user/balance`(官方**公开**接口,标准 `Bearer` 鉴权,
    与 chat/completions 同一把 key;不需要控制台私有接口);
  - 认领:id `deepseek-official`(内置 `llm-deepseek` 插件独占的路由)或 id `deepseek`,
    或 baseURL 含 `api.deepseek.com` 的自定义路由;
  - 凭据:路由声明的 `apiKeyEnv`(内置插件默认 `DEEPSEEK_API_KEY`)→ 兜底同名;
  - 展示:纯金额行 —— 「可用余额」(加粗)+「其中充值 / 其中赠送」(非零才出现);
    与 zhipu 后端一致,**刻意无进度条**:按量计费没有配额窗口;
  - `is_available: false`(欠费停用)时追加「账户状态: 已欠费停用」行并强制红色圆点 ——
    否则余额 0 看不出原因;
  - 徽章:`DS 余额 ¥xx.xx`;圆点阈值**按币种**:CNY <¥10 红 / <¥50 橙,USD <$2 红 / <$10 橙;
  - 5 分钟上游缓存。

## 修复 / 加固

- **baseURL 路径不再被拼进余额接口**:余额接口挂在 API 根上,而路由 baseURL 常带路径
  (`/v1`、自建网关的 `/proxy/...`)。新逻辑只取 baseURL 的 origin 再拼 `/user/balance`,
  非绝对 URL 时回退官方域名。
- 币种感知的金额格式化:原 `fmtMoney` 硬编码 `¥`,现按上游 `currency` 取符号
  (CNY `¥` / USD `$` / 未知币种退化为「代码 + 空格」,不做汇率假设)。
- 新增 `VERSION` 常量承载上游 `User-Agent`,不再散落硬编码版本号。

## 兼容性

- `zhipu` / `opencode-go` 后端行为不变(阈值语义等价改写:`toneOfMoney(v)` → `toneOfBalance(v, 'CNY')`;
  被替换的空壳 `toneOfMoney` 已删除,非导出函数,不影响外部)。
- `zai` 路由维持 v0.2.x 行为(仍不被 zhipu 后端认领)。

## 测试

新增离线夹具 `test-deepseek-backend.mjs`(不需要重启 DSH 即可验证):

- 直接 import host 半,用假 `ctx`(credentials / settings / agents / webServer)驱动其 HTTP handler,
  断言「认领 → 解析 key → 打上游 → 归一化 panel」整条链路;
- 31 项断言全通过,覆盖:正常/充裕/低额(CNY 与 USD)/欠费/自建 baseURL 带路径/401/
  响应缺字段/凭据缺失,以及 3 个回归用例(zhipu、opencode-go、zai 路由不被抢走);
- `--live` 模式用真实 `DEEPSEEK_API_KEY` 打真实上游:HTTP 200,
  实测面板 `{"title":"DeepSeek","rows":[{"label":"可用余额","value":"¥24.43"},{"label":"其中充值","value":"¥24.43"}],"chip":{"text":"DS 余额 ¥24.43","tone":"warn"}}`;
  并断言响应体不回显凭据。

## 本机安装记录

- 路由来源:`~/.dsh/settings.yaml` 的 `agent-default-model` 指向 `deepseek-official` / `deepseek-flash`
  (内置 `llm-deepseek` 插件,**不在** `llm-pi-ai.providers` 字典里);`DEEPSEEK_BASE_URL` 未设置
  → 走官方 `https://api.deepseek.com`,余额接口直连可达(实测 0.15s)。
- 该路由此前 `isSupported: false`(无后端认领),故本机默认模型下余额面板一直不显示;
  本版本起默认模型即为 `deepseek-official`,面板开箱即显示。
