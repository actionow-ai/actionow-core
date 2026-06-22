# 多供给接入 · 插件化（Provider Plugins）— 设计文档

- 日期：2026-06-22（**rev 2** — 经 10 簇厂商 spec 研究 + 26-agent 对抗式核验 + 用户 4 项决策修订）
- 范围：把**任意异构上游**（chat / 图片 / 视频 / 音频 / 及预留的结构化模态）的「我们的请求 → 上游请求 → 发起 → 上游响应 → 我们的响应」做成**模板/插件驱动**的归一管线；并把"接入方式"从一个 3 值枚举改造成 **5 条正交轴**。
- 状态：设计修订锁定，待 review → 分期实现。
- 关联：[[media-relay-phase2]]（现有 async-media/媒体中转）、[[catalog-redesign]]（接入与供给 tab，本设计的承载 UI）、[[p1a-codex-oauth-validation-gate]]（codex 反代）。

> **rev 2 摘要**：原 spec 的引擎/沙箱/版本冻结骨架保留；本次根据厂商真实 spec 研究做四处结构性修订——① 分类从「3 类顶层枚举」改为「5 正交轴 + 3 类仅作 UI 预设」；② 结果契约从 media-only 泛化为 **tagged union 并在契约层统一 chat+media**；③ 新增**平台侧命名 signer 注册表**（吃下火山 V4 / 腾讯 TC3 / 可灵 JWT 等 body 依赖签名，且守住"密钥不进沙箱"）；④ 协议轴补 `ws-stream` / `webhook-only`，`mapPoll` 升为权威状态映射。CLI 反代本期仅 codex。

---

## 1. 背景与目标

LLM/chat 有较一致的请求/响应规范（OpenAI / Anthropic / Gemini 兼容）；但图片/视频/音频**没有**统一的任务请求/响应/详情标准，且鉴权方式（bearer / 自定义 header / AK-SK 签名 / per-request JWT / OAuth 订阅冒充）各家迥异。

用户诉求：用一套「我们设定的请求体 → 上游请求体 → 发起 → 上游响应 → 我们设定的响应」的归一管线吃下异构上游；不同 exec-mode 流程不同；官方模型由平台出模板、三方中转能快速接入；面向开发者、可高度自定义（请求映射、自定义 header 鉴权）但保持规范。参考 Dify 的**插件**设计。

### 1.1 现状测绘（5-agent 工作流，已验证）

- **① 我们的请求体 = 已有**：每资源用 `io_schema.inputs`（zod 校验、`resource_version` 冻结）。
- **②⑤ 映射层 = 主要是"每 provider 写代码 adapter"**（openai/codex/gemini/anthropic 硬编码）；唯一数据驱动的 `async-media` 也**只配 path/header/轮询预算，不配 payload 形状**。
- **⑥ "我们设定的响应" = 不存在（最大缺口）**：`output` 是 `z.unknown()`；`io_schema.outputs` 从不校验；媒体结果只是 `async-media.ts` 的硬编码字段白名单。
- **exec-mode**：`async-poll` 媒体扎实；`blocking` 媒体靠 `pollToTerminal` 内部轮询 shim；`async-callback` 非独立生命周期（与轮询竞争）；`stream` 仅文本。
- **其它缺口**：媒体**不写 usage_log/provider_cost**（毛利全盲）；无 base64/inline-bytes 落地；批量不持久化；file_object 写入逻辑 2 处重复；4 处硬编码字段表手工同步。

### 1.2 厂商 spec 研究结论（10 簇 / 26-agent，已对抗式核验）

驱动 rev 2 的关键事实：

- **"官方 vs 三方中转"在线缆层是同一协议**——一个 OpenAI adapter 覆写 `base_url + key` 就能直接打三方中转；区别只在**信任**（模型名重映射、cost/usage 不可靠、静默降级）。
- **CLI 反代在线缆层不是新协议**——Claude Code = Anthropic Messages、Copilot = OpenAI chat；其特征是 **auth 取值**（OAuth 订阅 + 冒充 header 包）+ 独立凭证生命周期；只有 codex（Responses 方言 + 冒充 + curl 旁路 + stream-only）真正不可约。
- **签名鉴权是 body 依赖的**：火山 SignerV4 / 腾讯 TC3-HMAC（两者 canonicalization 不同、不能共用 signer）/ 可灵每请求 HS256 JWT（exp=now+1800）/ 智谱 JWT / 百度·Copilot token-exchange——签名输入正是 `mapRequest` 刚产出的 `method+path+query+headers+body`。**原 spec 的「平台按声明枚举套 auth」吃不下这些。**
- **实时音频是 ws-duplex**：火山 TTS/ASR（二进制帧）、OpenAI Realtime、Deepgram、ElevenLabs——50ms 纯函数沙箱撑不住长连接双工 socket。
- **结构化非资产结果**：embeddings/rerank/moderation/OCR 返回向量/排序/裁决/layout——`assets[]` 会全部静默丢弃。
- **CLONE 是 ROI**：3 个 OFFICIAL adapter + 配置预设 ≈ 20 个模板（OpenAI-compat LLM 长尾 + 全部中转簇塌缩为纯配置）。

**目标**：补齐 ⑥（统一结果契约，契约层即统一 chat+media）+ ②⑤（异构映射变插件 + 命名 signer）+ exec-mode 修正（+ws-stream/webhook）+ persistence/metering 归一 + 版本冻结，并提供运营编辑/测试插件的 UI。

---

## 2. 分类模型（D9 — 5 正交轴；3-type 仅作 UI 预设）

**裁决**：用户的 3 类（① 官方标准 API ② CLI 反代 ③ 三方中转）作为**顶层枚举是错的**——它把信任/保真度（①vs③）和 auth（②）压成一个枚举，且会逼迫复制 OpenAI adapter（违背引擎 per-channel 选 adapter 的现有设计）。**底层按 5 条正交轴建模；3 类保留为运营 UI 上的友好分组与 seed 预设**。

把"一个 channel / 插件"建模为五维空间里的一个点：

| 轴                      | 取值                                                                                                                                                            | 在代码里控制什么                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **A 模态 / 结果形状**   | chat · image · video · audio ·（预留：embedding · rerank · moderation · structured-doc/OCR · 3d/multi-asset · realtime-duplex）                                 | 结果契约（§4.1）；今天 `io_schema.outputs=z.unknown()` 是最大缺口                             |
| **B 执行模式**          | blocking · stream(文本 delta) · async-poll ·（新增：webhook-only · ws-stream · batch 修饰符）                                                                   | `EXEC_MODES` 枚举 + job-runner 生命周期                                                       |
| **C 线缆方言 × 保真度** | openai-chat · openai-responses · anthropic · gemini · vertex-predict · dashscope · tencent-action · bespoke-task **× {faithful｜nominal}**                      | 选哪个 mapper / clone 哪个内建插件；**「官方 vs 三方中转」真正住这**                          |
| **D Auth 家族**         | bearer · custom-header(`x-api-key`/`xi-api-key`/`Token`) · query-key · hmac-signed(TC3/Volc-V4/SigV4) · oauth(静态) · **oauth-subscription+impersonation(CLI)** | §4.5 signer 注册表；**CLI 反代 = 此轴一个取值**                                               |
| **E 信任 / 路由策略**   | first-party-trusted ｜ relay-untrusted（静默降级 / 模型重映射 / 无 cost 字段）                                                                                  | `routing.ts` failover、cooldown、capability 降级、usage-log 门控；**三方中转 = 此轴一个取值** |

**3 类 → 轴 的映射**（也是 UI 预设的定义）：

| UI 预设  | 拆解                                               | 代表                                                            |
| -------- | -------------------------------------------------- | --------------------------------------------------------------- |
| 官方标准 | C:faithful + E:first-party + D:bearer/header/query | OpenAI, Anthropic, Gemini, DeepSeek, 火山 Ark/Doubao            |
| CLI 反代 | **D:oauth-subscription+impersonation**             | codex（本期）；Claude Code/Gemini CLI/Copilot/Qwen Code（后续） |
| 三方中转 | **E:untrusted + C:nominal**，其余继承 openai-chat  | OpenRouter, one-api, new-api, LiteLLM                           |

---

## 3. 锁定的决策

| #      | 决策                     | 选择                                                                                                                                                                                                                                                             |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | 映射方式                 | **模板/插件驱动**（配置为主 + 代码兜底真异类）。官方=平台内置插件；OpenAI-compat 长尾 + 三方中转=克隆内建插件 + 配置；真不可约（codex 冒充、ws-duplex、签名厂商、bespoke envelope）=代码兜底。                                                                   |
| D2     | 映射表达                 | **受限 JS 沙箱 handler**（`mapRequest`/`mapResponse`/`mapPoll`/`mapCallback`）。                                                                                                                                                                                 |
| D3     | 形态                     | 参考 **Dify 插件**：`manifest（声明式 + 凭证表单 schema）+ handler（沙箱 JS）`。                                                                                                                                                                                 |
| D4     | 深度                     | **轻量 in-platform**：DB 存 manifest+handler；内置种子 + 运营 UI 建/克隆；可版本化。不做打包文件/marketplace/独立进程。                                                                                                                                          |
| D5     | 安全边界                 | 沙箱 = **QuickJS-WASM**（硬隔离、确定性、限时限内存、无 I/O）。**密钥永不进沙箱**。                                                                                                                                                                              |
| D6     | 结果契约                 | **tagged union 且契约层统一 chat+media**：`MediaResult` ｜ `StructuredResult` ｜ `StreamResult`，一处拥有 → persistence + metering + 投影。                                                                                                                      |
| **D7** | **鉴权（rev 2 新增）**   | **平台侧命名 signer 注册表**：`bearer`/`query-key`/`custom-header`/`token`/`volcSignV4`/`tencentTC3`/`klingJwt`/`zhipuJwt`/`oauthSubscription` 等按名引用的策略，在**沙箱外、`mapRequest` 之后**消费 `{method,path,query,headers,body}` 运行。密钥只在此处出现。 |
| **D8** | **协议轴（rev 2 新增）** | `manifest.protocol ∈ {sync, async-poll, webhook-only, ws-stream}`；`ws-stream` 走代码侧双工路径**不进 QuickJS**。`mapPoll` 为**权威**状态映射，废弃"声明式状态枚举"作主路径。                                                                                    |
| **D9** | **分类（rev 2 新增）**   | **5 正交轴内核（§2）+ 3-type 仅作 UI 预设/seed 分组**。                                                                                                                                                                                                          |

---

## 4. 架构

### 4.1 统一结果契约（D6，契约层统一 chat+media）

```ts
// 顶层 tagged union；引擎对返回值按 kind 校验（替代 z.unknown()）
PluginResult =
  | { kind: 'media';  assets: Asset[]; usage: Usage; raw?: unknown }
  | { kind: 'struct'; data: unknown;   usage: Usage; raw?: unknown }   // 预留：embedding/rerank/moderation/OCR
  | { kind: 'stream'; /* 由 stream/ws-stream 路径产出，引擎侧聚合 */ }

Asset = {
  role: 'primary' | 'thumbnail' | 'cover' | 'aux';   // 多资产判别（Suno 2 歌+封面、3D 多格式）
  modality: 'image' | 'video' | 'audio' | 'model3d';
  format?: string;                                    // glb/fbx/usdz/mp4/png…
  url?: string; b64?: string;                         // 二选一；大 b64 见 §6 风险（沙箱外落地）
  mime: string;
  width?: number; height?: number; duration?: number; size?: number; etag?: string;
}
Usage = Record<string, number>;                       // images / duration_seconds / characters / tokens …
```

- 媒体 handler 的 `mapResponse` 返回 `kind:'media'`；**chat/结构化变体本期只定义契约、不实现引擎路径**（预留空间，避免冻结快照后回填）。
- **一个 `plugin-result` 模块**拥有它，下游全部消费：persistence（R2/file_object，支持 url+b64+批量、记 etag/尺寸/时长）、metering（写 usage_log + 按单位 provider_cost）、投影（画廊 / OpenAI-images 方言）。一次修掉 4 处硬编码字段表 + 2 处重复写入 + 媒体毛利全盲 + base64/批量缺失。

### 4.2 Provider 插件（D1/D3/D4）= manifest + handler

**DB 实体**（新表 `provider_plugin`，软删除 + 版本化）：

- **manifest（jsonb，声明式）**：
  - 身份：`id`、`label`、`axes`（§2 的 A/B/C/D/E 取值快照）、`protocol`（D8）。
  - **凭证/配置表单 schema**（字段定义 → UI 自动渲染；≈ Dify `credentials_for_provider`）：`endpoint`/`region`/`api_key`/`ak`/`sk`/`model`…**强制 per-channel base_url**（DashScope/火山/智谱/Gemini 的 region base_url 与 key 不可互换）。
  - **参数 schema**（模型/尺寸/时长等）。
  - **`authStrategy`（D7）**：按名引用 signer 注册表中的策略 + 其所需凭证字段映射（如 `volcSignV4` 需 `{ak,sk,region,service}`）。
  - 协议细节（也可在 handler 表达）：poll handle 位置、回调签名校验方案等。
- **handler（text/jsonb，沙箱 JS 入口）**：
  - `mapRequest(ctx) -> { method, pathSuffix, query, headers, body }`
  - `mapResponse(resp, ctx) -> PluginResult`
  - `mapPoll(statusResp, ctx) -> { state:'running'|'succeeded'|'failed', result?, next? }`（`next` 支持 MiniMax 式多步检索 task→file_id→retrieve）
  - `mapCallback(payload, ctx) -> { state, result? }`
  - `validateCredentials?(ctx)`
  - **ctx** = `{ inputs(已校验), model, params, config }` —— **无密钥**。纯函数、返回纯 JSON。
- **内置库**：见附录 A。
- **自定义**：运营 UI 建/克隆（OpenAI-compat 长尾 + 三方中转 → 克隆 + 改 endpoint/key/model-map/capability-flags，零新代码）。

### 4.3 通用插件运行器（D2/D5/D7）

```
validate(inputs vs io_schema)
 → mapRequest(ctx)                         [QuickJS 沙箱]
 → 平台按 manifest.authStrategy 选 signer，消费 {method,path,query,headers,body}
   套 auth / 算签名 / 注 header / 刷 OAuth                       [沙箱外，注入密钥]   ← D7
 → 发起(http + 代理)
 → sync:          mapResponse
   async-poll:    setUpstreamHandle → 轮询(每次按需重签, §4.5) → mapPoll → mapResponse
   webhook-only:  setUpstreamHandle → 入站回调(校验签名) → mapCallback → mapResponse
   ws-stream:     代码侧双工中继(不进 QuickJS)                                    ← D8
 → PluginResult 校验 → persist/meter/settle（§4.1 模块）
```

代码 adapter 仅保留真异类（codex-oauth 冒充、ws-duplex、bespoke envelope）作兜底，逐步可迁。

### 4.4 沙箱（D5）

- **QuickJS-WASM**（如 `quickjs-emscripten`）：WASM 边界硬隔离、无原生扩展、确定性；限时（如 50ms）、限内存、无 I/O/网络/计时器。
- 所有**纯映射**插件（含内置）走同一沙箱 → 单一代码路径 + 最安全。`ws-stream` 不走沙箱。
- 错误（抛异常/超时/返回不符契约）→ `mapping_error`，任务失败并释放 hold。

### 4.5 鉴权 / signer 注册表（D7，rev 2 核心修订）

**问题**：原 spec 流水线 `mapRequest → 平台套声明式 auth → 发送` 对 bearer/query-key 成立，但签名鉴权的**输入就是 mapRequest 刚产出的 body+path、且算法逐厂不同**，固定枚举吃不下。

**方案**：平台提供**代码侧、按名引用的 signer 策略注册表**，在沙箱**外**、`mapRequest` **之后**运行，消费 `{method,path,query,headers,body}` + 解析出的凭证，产出最终待发请求：

- `bearer` / `custom-header` / `query-key` / `token`（Vidu 字面 `Authorization: Token {key}`，非 Bearer）/ `none`
- `volcSignV4`（火山 SignerV4；签名绑确切 URL/path）
- `tencentTC3`（腾讯 TC3-HMAC-SHA256；与火山 canonicalization 不同，独立实现）
- `klingJwt`（每请求 HS256 JWT，exp=now+1800，缓存+buffer 重生）/ `zhipuJwt`
- `baiduOAuthQuery` / `copilotExchange`（token-exchange）
- `oauthSubscription`（CLI 反代：OAuth 刷新 + 冒充 header 包；本期仅 codex 走代码 adapter）

**硬约束**：

- 密钥（含 ak/sk、JWT secret、OAuth token）**只在 signer 内出现**，永不进沙箱、永不进 handler ctx——与代码库 `resolveSecretRef` 从不向 adapter 暴露密钥的现有姿态一致。
- **poll/result-query 调用必须按需重签**（火山签名绑 URL/path）；signer 不可假设"提交时的签名能复用"。

### 4.6 exec-mode 统一（D8）

- 协议由 **manifest.protocol** 声明（`sync`/`async-poll`/`webhook-only`/`ws-stream`）。
- **`webhook-only` 修成真模式**：消除当前 poll+callback 竞争；轮询作为可选兜底（Suno 三阶段 callback、fal `webhookUrl`、Runway `replyUrl`）。入站回调须校验来源签名。
- **`ws-stream`**：实时音频（火山二进制 WS、OpenAI Realtime、Deepgram、ElevenLabs）走代码侧持久 socket 中继，不进 QuickJS。**本期仅定义协议位，不实现**（见 §6 范围）。
- **blocking 媒体**：把 `pollToTerminal` 内部轮询升级为一等"`sync`-仿真"协议（平台内部跑完 poll 再内联返回，受渠道 poll 预算约束），不再是 misconfig 分支的 shim。
- `mapPoll` 为**权威**状态映射（腾讯 1/2/4/5 无 3、Vidu 7 态、xAI `expired≠failed`、Veo `done`-布尔无枚举、MiniMax 三步检索——声明式枚举表达不了，只有 handler JS 能）。
- stream（文本 delta）不变。

### 4.7 版本冻结（D6/D7）

`resource_version` 冻结 `io_schema` 的同时，**冻结所用插件的 manifest + handler 快照 + signer 策略版本（+ 版本号）**。上游响应形状变了、运营改了插件、或 signer 实现升级，**旧任务仍按冻结快照执行**。

### 4.8 运营编辑/测试 UX（承载于「接入与供给」tab）

- **插件列表**（内置 + 自定义，按 §2 的 3-type 预设分组）；建/克隆/版本。
- **编辑器**：manifest 表单 + handler 代码编辑 + `authStrategy` 选择。
- **测试面板**：贴样例 inputs → 预览生成的上游请求（含签名后的最终 header，密钥脱敏）；贴样例上游响应 → 预览 `PluginResult` + 契约校验。
- **渠道配置**：渠道选插件 → 按 manifest 凭证表单 schema **自动渲染**填 endpoint/key/region/参数（与凭证页打通），并标注**信任姿态（E 轴）**（中转标 untrusted → 关 capability、门控 usage-log）。

---

## 5. 数据模型改动

- 新表 `provider_plugin`：`id, label, axes jsonb, protocol, manifest jsonb, handler text, auth_strategy text, version int, builtin bool, status, created/updated/deleted_at`。
- `upstream_channel`：加 `plugin_id`（+ `plugin_version`）+ `trust`（E 轴：trusted｜untrusted）+ `model_map jsonb`；凭证/配置按 manifest 表单存入既有 `config`/`credentialRef`。
- `resource_version`：快照增加 `plugin_snapshot`（manifest+handler+signer 版本）。
- `file_object`：补 `etag`/`width`/`height`/`duration`。
- 契约：新增 `pluginResultSchema`（§4.1 union）；`provider_plugin` 的 view/request schemas；`EXEC_MODES` 加 `webhook-only`/`ws-stream`（`batch` 做修饰符）；openapi/SDK 重生。
- 现有 4 处硬编码字段表 + 2 处重复 file_object 写入 → 收敛进 §4.1 模块删除。

---

## 6. 分期交付（含本期范围裁决）

- **P1 — 统一结果契约（union）+ persistence/metering 归一**（不上插件引擎）：定义 `PluginResult` union（含 chat/struct 预留位）；现有 async-media 走新模块；R2 支持 url+b64+批量、记 etag/尺寸；媒体写 usage_log + 按单位 provider_cost（修毛利全盲）；删 2 处重复写入 + 4 处硬编码表。**立即修掉今天的真缺口 + 锁定可扩展契约。**
- **P2 — 插件引擎 + signer 注册表 + clone 模板层**：`provider_plugin` 表 + manifest + QuickJS 沙箱运行器 + 通用插件适配器；**§4.5 命名 signer 注册表**；内置插件库（附录 A 的 OFFICIAL）；**OpenAI-compat 长尾 + 三方中转簇走 clone（零新代码）**；`channel.pluginId`/`trust`/`model_map` 接线；`resource_version` 冻结快照；`webhook-only` 真模式 + blocking 媒体一等化。CLI 反代**仅 codex**（代码兜底，已验证）。
- **P3 — 运营编辑/测试 UI + manifest 驱动表单**：插件列表/编辑器/测试面板；渠道配置 manifest 自动渲染 + 信任姿态（接入「接入与供给」tab）。

**本期明确 DEFER（仅在 §4.1 预留契约空间，不实现引擎路径）**：① 结构化非资产模态（embedding/rerank/moderation/OCR）② `ws-stream` 实时音频（唯一需持久 socket 中继基建，工作量与纯映射插件不在一个量级）③ batch ④ codex 以外的 CLI 反代（每个需独立 OAuth 刷新+冒充包，Claude Code/Gemini CLI 有 ToS 封禁风险）。各自后续单独 spec→plan→实现。

---

## 7. 风险

- **沙箱安全**：运营自写 JS = 不可信代码。QuickJS-WASM 硬隔离 + 限时/限内存 + 无 I/O + **密钥不进沙箱**。
- **签名鉴权（rev 2 重点）**：body 依赖签名必须走 §4.5 沙箱外 signer；poll 重签 + signer 版本进冻结快照是**硬约束**，漏掉会破坏旧冻结任务。火山/腾讯/可灵 signer 各自独立、不可共用。
- **handler 表达力 vs 调试**：测试面板（§4.8）是必需配套。
- **大文件 / b64**：Nano Banana/Imagen/gpt-image-1 base64 默认且可达数 MB。§4.1 的 `b64` 仅留小型内联结果；大 b64 在沙箱外 persistence 层流式落库，handler 返回引用（与 §6 DEFER 的 ws-stream 共用"大 bytes 不过沙箱"原则）。
- **三方中转信任（E 轴）**：默认 untrusted——关 capability 推断、模型名按 `model_map` 重映射、cost/usage 字段不可信时门控毛利统计。
- **代码 adapter 迁移**：codex-oauth 等先保留兜底，不强迁；通用运行器与代码 adapter 并存。
- **metering 维度（已定）**：媒体 per-unit provider_cost 存渠道 config（µUSD/unit，如 `costPerUnit:{images,duration_seconds,characters}`），customer 价仍走 pricebook。

---

## 8. 测试

- 契约：`PluginResult` union 校验（media/struct/stream + url/b64/批量/role/format/缺字段）；持久化 url+base64+批量 → file_object（etag/尺寸）。
- 沙箱：handler 限时/限内存/无 I/O/确定性；恶意 handler 被隔离；超时/异常 → mapping_error。
- **signer（rev 2）**：volcSignV4/tencentTC3/klingJwt 签名正确性（对官方样例向量）；poll 重签；密钥不进沙箱/不进 handler ctx 的断言；signer 版本冻结后旧任务仍正确。
- 引擎：协议（sync/poll/webhook-only）端到端；webhook 真模式不再与轮询竞争；版本冻结（改插件后旧任务仍按快照）；clone 插件（覆写 base_url/model-map）打三方中转。
- metering：媒体 usage_log + per-unit provider_cost 进 admin 毛利 rollup。
- UI：测试面板（样例响应→预览契约 + 脱敏签名 header）；manifest 驱动凭证表单渲染；信任姿态门控。

---

## 附录 A — Seed 模板目录（按 3-type UI 预设分组）

**Fit 图例**：`OFFICIAL` = 手写参考 adapter（代码）· `CLONE` = 仅配置复用 OFFICIAL（**零新代码**）· `CODE` = 沙箱/声明层表达不了，需手写 adapter。`(补)` = 用户未提及但应纳入。

### 官方标准 · LLM 参考（OFFICIAL，已有）

`openai-chat`（bearer，所有 CLONE 基座）· `anthropic-messages`（x-api-key+version）· `gemini-generatecontent`（query-key）· `openai-responses`（**CODE**，typed Items，与 Chat 不兼容）

### 官方标准 · OpenAI-兼容 LLM（CLONE，零代码）

`deepseek` · `xai-grok-chat` · `mistral` · `qwen-dashscope-compat`⚠region · `moonshot-kimi` · `minimax-chat` · **`bytedance-doubao-ark`(补，最刺眼的遗漏)** · **`iflytek-spark`(补)** · **`01ai-yi`(补)**
双 auth（默认发 bearer 预设 + CODE 兜底）：`zhipu-glm`(CLONE bearer + CODE jwt) · `baidu-ernie-qianfan`(CLONE v2 + CODE ak/sk) · `tencent-hunyuan-chat`(CLONE compat + CODE tc3)

### 官方标准 · 图像

OpenAI 系：`openai-images`（**OFFICIAL/新**，edits=multipart+b64 默认）· `xai-grok-image`(CLONE) · `bytedance-ark-seedream`(CLONE，唯一干净 clone 的 CN 图像)
Google 系：`gemini-nano-banana`(**CODE**，b64 inline) · `google-imagen-vertex`(**CODE**，gcp-oauth+predict envelope)
CN 异步/签名：`volcengine-visual-seedream`(CODE,ak/sk) · `tencent-hunyuan-image`(CODE,tc3,状态1/2/4/5) · `alibaba-wanxiang-t2i`(CODE,DashScope) · `alibaba-zimage`(CODE,陷阱:同 auth/base 但 sync 不同 path) · **`kuaishou-kling-image`(补,jwt)** · **`baidu-wenxin-yige`(补,ak/sk)** · **`zhipu-cogview`(补)**

### 官方标准 · 视频（全异步，无一匹配 LLM 标准 → 多 CODE）

`volcengine-seedance` · `kling-video`(jwt 30min) · `vidu`(`Token` scheme) · `alibaba-happyhorse`（用户的"happyhourse"，确认真模型）· `alibaba-wan-video` · `minimax-hailuo-video`(三步检索) · `runway`(`X-Runway-Version` 必填) · `google-veo`(LRO done flag) · `xai-grok-video`(expired≠failed) · **`luma-dream-machine`(补)** · **`tencent-hunyuan-video`(补)**

### 官方标准 · 音频

请求/响应：`openai-tts`(**OFFICIAL/新**) · `openai-whisper-stt`(CODE,结构化文本) · `elevenlabs-tts-http`(CODE,xi-api-key) · `minimax-tts`(CODE,Token+GroupId)
**ws-duplex（本期 DEFER，仅占位）**：`volcengine-tts-ws` · `volcengine-asr-ws` · `openai-realtime` · `elevenlabs-tts-ws` · **`deepgram-listen-ws`(补)**
voice-clone（有状态，upload+poll，本期 DEFER）：`volcengine-voice-clone` · `elevenlabs-voice-clone` · `minimax-voice-clone`

### CLI 反代（订阅 OAuth 冒充，不可约 CODE）

**本期：`codex-oauth`（已发，canonical）**
后续：`claude-code-oauth`⚠ToS · `gemini-cli-oauth`⚠ToS · `github-copilot-oauth`(token-exchange) · **`qwen-code-oauth`(补)**

> ToS 旗标：claude-code / gemini-cli 默认禁用/仅咨询——两家正主动封禁中继。

### 三方中转（CLONE 带注意事项，E 轴 untrusted）

`openrouter`(`:nitro`/`:floor`+provider 路由) · `one-api`(`KEY-CHANNEL_ID` 后缀) · `new-api`(转换有损) · `one-hub` · **`litellm`(补)**

### 缺口模态（本期 DEFER，驱动契约预留）

`openai-embeddings` · `cohere-rerank` · `openai-moderation` · `mistral-ocr` · `baidu-ocr` · `tripo3d`/`meshy-3d`(多格式) · `suno-music`(三阶段 callback,2 歌) · `openai-batch`(文件 JSONL) · `anthropic-batch`(内联 requests[]，第二套不兼容 batch 标准)

---

## 附录 B — 低置信 / 待核验事实（实现前请复核）

| 声明                                                                     | 状态                           | 复核建议                             |
| ------------------------------------------------------------------------ | ------------------------------ | ------------------------------------ |
| 百度 OCR token 走 `?access_token=` query + form-urlencoded               | **未核验**（文档站本轮被封锁） | 用激活的服务实测                     |
| 火山旧 Visual/CV(Seedream ak/sk) submit/query 字段名                     | medium                         | 拉具体 Visual 文档页核对             |
| 火山 OCR action endpoint/字段                                            | medium                         | 同上                                 |
| Suno 经第三方网关（无官方 API），字段各家不同                            | medium                         | 锁定网关后核字段                     |
| Wan/DashScope 下载结果 URL 勿带 Authorization 头（签名 OSS 否则 403）    | 未核验                         | 实测签名 URL 行为                    |
| Cursor / sub2api endpoint/header/auth                                    | low                            | 无权威源，park，勿据此实现           |
| Anthropic `messages[]` 角色：`system` 也被接受（但 system 仍走顶层字段） | 已核验更正                     | adapter 别硬拒非 user/assistant 角色 |
| 厂商型号 ID 与定价（date-stamped / preview 漂移）                        | 短存活期                       | seed 预设里的型号/价做成可更新配置   |

---

## 附录 C — 代码锚点（给实现者）

- `packages/adapters/src/types.ts:31-56`（adapter 契约——加 result-shape + auth-strategy）
- `packages/contracts/src/adapter.ts`（`EXEC_MODES`——加 `webhook-only`/`ws-stream`，`batch` 做修饰符）
- `packages/contracts/src/io-schema.ts` + `data-plane.ts:59`（`z.unknown()` 输出缺口——A 轴/§4.1）
- `packages/adapters/src/async-media.ts:44-105`（payload/output 硬编码——方言+结果轴变数据驱动）
- `packages/engine/src/execution-service.ts:440,640,790-806` / `job-runner.ts:354-357`（per-channel 选 adapter；单 `ctx.apiKey` 槽——D7 signer 注册表落点）
- `packages/engine/src/media-persistence.ts`（url+b64+批量+etag/尺寸——§4.1 模块）
