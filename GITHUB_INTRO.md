# Balance Panel — DSH 的可扩展余额/用量面板

> 发布名称(产品名):**Balance Panel**(中文:「余额面板」)
> npm 包名 / GitHub 仓库名:**`dsh-balance-panel`**(v0.1.0 时期为 `dsh-opencode-go-usage` / Go Meter)
>
> 命名理由:v0.2.0 起从「OpenCode Go 专用仪表」泛化为**多后端可扩展**的余额/用量面板,
> 产品名不再绑定单一供应商;`Panel` 表达"一张右缘卡片,内容跟随当前 provider"的形态,
> 仓库名保留 `dsh-` 前缀便于被搜到。v0.1.0(Go Meter)的历史见
> [RELEASE_NOTES-v0.1.0.md](RELEASE_NOTES-v0.1.0.md)。

## GitHub About(一句话,二选一)

- EN:`Extensible balance/usage panel for the DSH Web UI — one floating card that auto-selects a backend by the current provider (OpenCode Go quota windows with bars; Zhipu and DeepSeek pay-as-you-go cash balance as money-only rows).`
- 中:`DSH Web 界面右缘的可扩展余额/用量面板:按当前会话 provider 自动切换数据源 —— OpenCode Go 订阅配额(进度条),以及智谱开放平台、DeepSeek 开放平台的按量计费现金余额(纯金额行)。`

## 话题标签(Topics)

`dsh-plugin` `opencode` `opencode-go` `zhipu` `glm` `bigmodel` `deepseek` `balance` `quota` `devtools` `web-ui`

## README 简介段落(可置于 README 开头)

**Balance Panel** 是一个为 DeepSeek Harness(DSH)Web 界面打造的余额/用量面板:
当当前会话的模型命中某个已接入后端时,界面右缘浮出一张常驻小窗,内容**按当前
provider 自动选择**,同一时刻只显示一张:

- **OpenCode Go**(订阅配额):5h 滚动 / 本周 / 本月三行「剩余百分比 + 重置倒计时 + 进度条」,
  剩余 ≤30% 转橙、≤10% 转红;
- **智谱开放平台**(按量计费现金余额):纯金额行 —— 可用余额(加粗)/ 累计充值 / 累计消费
  (赠送、冻结仅在非零时出现)。按量计费没有配额窗口,不存在「剩余比例」语义,
  因此**刻意没有进度条**;徽章圆点按绝对余额提醒(<¥10 红、<¥50 橙);
- **DeepSeek 开放平台**(按量计费现金余额,v0.3.0 起):走官方公开接口
  `GET api.deepseek.com/user/balance`,纯金额行 —— 可用余额 / 其中充值 / 其中赠送;
  账户欠费(`is_available: false`)时显式给出「已欠费停用」行;徽章圆点阈值按币种
  (CNY <¥10 红、<¥50 橙;USD <$2 红、<$10 橙)。

架构上,host 半区是一个**后端注册表**:每个后端声明自己认领哪些 provider 路由
(`matchesProvider`)并把上游接口归一化成统一的 panel 描述(`resolvePanel`),
客户端是纯通用渲染器 —— **接入一个新供应商 = 添加一个后端对象,客户端零改动**。
所有上游调用由服务端代理,API key 经 DSH 凭据服务解析,永不进入浏览器、不写日志;
各后端独立缓存(OpenCode Go 15s / 智谱与 DeepSeek 各 5min),失败保留旧数据并标记「数据过期」。

## 生命周期与配套项目

- v0.1.0(Go Meter)= OpenCode Go 专用额度小窗,已被本版本取代并包含其全部能力;
- 智谱侧的 **provider 适配层**(DSH 原生使用按量计费 API 的路由/模型/视觉/effort 配置)
  独立维护于 [MST19711/dsh-glm-provider](https://github.com/MST19711/dsh-glm-provider);
  本面板的 `zhipu` 后端自动认领该适配层定义的 provider 路由。

## Release 标题建议

- `v0.2.0 — Balance Panel: generalize Go Meter into an extensible balance/usage panel`
- `v0.2.1 — fix zhipu rechargeAmount field mapping`
- `v0.2.2 — drop 今日消费 row (upstream 口径不可信)`
- `v0.3.0 — add DeepSeek open-platform balance backend (official /user/balance endpoint)`
- 中文:v0.2.0 — 余额面板:Go Meter 泛化为多后端可扩展余额面板
- 中文:v0.3.0 — 新增 DeepSeek 开放平台余额后端(官方 /user/balance 接口)

## 发布物料清单

| 物料 | 文件 |
| --- | --- |
| 代码(双半区) | `lib/index.js`(后端注册表)+ `lib/client.js`(通用渲染器) |
| 安装脚本 | `install.sh`(`npm pack` + `dsh plugin add`) |
| 测试夹具 | `test-deepseek-backend.mjs`(离线驱动 host handler;`--live` 打真实上游) |
| 文档 | `README.md` / `RELEASE_NOTES-v0.1.0.md` / `RELEASE_NOTES-v0.2.0.md` / `RELEASE_NOTES-v0.3.0.md` / `LICENSE.md` |
| 此介绍 | `GITHUB_INTRO.md` |
