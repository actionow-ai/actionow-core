# 绿地设计草稿 v2：模型供给与接入架构（评审已吸收，待立项）

状态：设计草稿 v2。v1 经独立对抗评审（报告 docs/research/research_2026-07-10_omni-gateway-gap.d/05-design-eval.md：4 Blocker / 14 Major / 14 Minor，裁决「骨架自洽无需返工」），本版吸收全部 Blocker 与 Major、逐条处置 Minor，并纳入用户 4 项产品裁决（产物双轨 / 纯服务端自动升格 / task 路由对齐钉选 / 对账降级）。
研究前置：issue TEA-1072（docs/research/research_2026-07-10_omni-gateway-model-onboarding-gap.html + 同名 .d/ 目录维度全文与外部 spec 原文）。
约束声明：绿地设计，不考虑迁移/兼容/改造难度；治理与计费闭环等达标资产保留。

## 0. 背景速览

现状三层 = resource（平台）→ upstream_channel（渠道）→ model + channel_model 软链接。研究实锤的结构病：三轨适配器并存、取数范式挂平台层、model_map 死列、link 软偏好、单渠道单 key、无并发闸门、hold TTL 15min 硬编码兼任 max_run_time、上游回调 envelope 契约断链（生产纯轮询）、媒体字节路径无 SSRF/全内存缓冲。

## 1. 四条硬原则

1. 卖与买分离：产品面（卖什么）与供给面（从哪买）只在「供给项 offering」相交。
2. 对外范式挂模型，取数方式挂供给项：调用方看到的生命周期形态由模型的操作面决定；上游怎么交货是供给项的私事，由执行规划器统一消化。
3. 一个适配器 SPI，两种作者方式：五切面+任务生命周期切面统一接口；DSL 或代码切面实现；一致性测试门准入。杀掉三轨并存。
4. 治理禁止旁路，供给必须硬绑定：路由只消费显式 enabled 的供给项；同步与异步走同一套路由语义（钉选/tag/容错/熔断，task 路径不再旁路——产品裁决：对齐）。

## 2. 实体模型（五个供给实体 + 价格卡 + 租户维度）

供给骨架五实体 = provider / channel / credential / model / offering；另有横切的 price_card（§2.7，被 model 与 offering 双引用）与租户维度（可见性/BYOK/key 白名单）。下文「五实体」均指供给骨架，价格卡与租户维度单列。

### 2.1 模型 model（产品面，一个逻辑模型全局一条）

- 身份：对外唯一名、显示名、图标、状态（draft/active/deprecated/disabled）
- 语义：模态 + 操作面（chat.completions / embeddings / rerank / moderations / images.generation / images.edit / video.generation / music.generation / tts / asr），每操作声明对外范式集（sync/stream/task）+ slow 升格标记
- 能力与约束：capabilities（vision/tools/json_mode…）、输入媒体约束（格式/尺寸/时长/大小）
- 契约：canonical 参数契约（见 §4；类型系统含 file/media 类型，承接现 io_schema 职责，playground/表单渲染由契约生成）
- 商务：售价卡 price_card 引用（§9.2）、倍率组
- 任务默认：max_run_time、产物保留期与 artifact_mode 默认（§9.4）、fallback 链、对外限额
- 可见性：visibility = public | granted；granted 时经 model_grant(model, tenant) 授权（承接现 model_grant 的 SQL 级 gate 职责）

### 2.2 厂商 provider（弱实体：品牌 + 默认值，不绑模态）

- slug、品牌、图标；默认方言（适配器 ref + 版本）；回调验签模板；默认容错模板、默认区域/合规域

### 2.3 渠道 channel（一个可调用的上游接入点）

- 归属厂商；方言 ref 可覆盖厂商默认（官方 vs 中转分叉点）
- base_url、代理、区域/合规域；鉴权方案（bearer / x-api-key / query / AK+SK / OAuth，决定凭证 schema）
- 归属维度：平台自营 或 租户自有（BYOK：租户自带凭证的私有渠道，承接现 resource.tenant_id 职责；租户私有渠道产生的供给项仅该租户可路由）
- route_group 归属、tags、状态

### 2.4 凭证 credential（渠道下挂 N 把 = key 池）

- 结构化密钥（按鉴权方案定 schema）；上游申明配额镜像（RPM/TPM/并发任务数）
- 状态与冷却：429/401 触发冷却与池内轮转。429 归因规则：429 计入凭证冷却，不计入供给项熔断错误样本（熔断只吃 5xx/超时/协议错）；池内全部冷却 → 该供给项判「暂不可用」参与过滤但不开熔断（key 病与渠道病分开表达）。

### 2.5 供给项 offering（渠道×模型一等实体；UNIQUE(model, channel)）

- enabled：硬绑定；生命周期 = draft → probing → enabled → disabled（禁用不收新请求，in-flight 任务跑完）
- upstream_model_name；fetch_profile（§3）+ per-offering 超时预算（与模型 max_run_time 冲突时取 min）
- 参数声明（§4，缺省 = supports 全域）
- 成本价卡；并发上限；权重/tier；健康态与熔断态 key 在此（默认沿用现 breaker 参数 60s 窗/50%/20 样本；半开试探请求走池内轮转正常取 key，不绕过冷却）

### 2.6 API key 与端用户维度

- api_key 的白名单从 resource 维度改为 model 维度（scopes: models[]，guard 强制；member 自助面可配置，承接现 resourceAllowlist 职责）；缺省语义 null=全放行（与现 resourceAllowlist null 语义一致，批次1 定死）
- IR 携带 subject/end_user 归因维度；**幂等键作用域 = (tenant, key)，放弃现 per-subject 分窗**——体指纹兜底下同键不同体返回 409（非静默回放），属行为收窄，SDK/skill 口径需同步声明
- 审计（@Audit）覆盖五实体全部管理写操作与治理决策；动态配置（SettingsResolver）承载升格阈值、探测频率、对账阈值等运行参数

### 2.7 价格卡 price_card（第六张表，被 model 售价与 offering 成本双引用）

- schema 见 §9.2；model 引用一张作售价卡、offering 引用一张作成本卡；版本化、历史保留，计费事件打快照（卡 id+版本）。在实体清单显式列出，防批次1 建模遗漏。

软删与唯一约束（批次1 落地约束）：UNIQUE(model, channel)（offering）与模型对外唯一名均用部分唯一索引（`WHERE deleted_at IS NULL`，沿用 mig 0052 范式），软删行不占唯一槽；计费事件与审计对软删实体的外键引用保持完整（append-only 不级联删）。

## 3. 范式与取数解耦

fetch_profile 四模式，统一执行规划器消化：

| 模式            | 上游形态                           | 引擎策略                                                                                                                                                                          |
| --------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| direct          | 一次 HTTP 拿结果（含阻塞式代轮询） | 慢操作对外仍 task；worker 长连接执行；**至多一次语义**：无上游任务句柄，崩溃接管后直接置 failed 且不扣费（该场景上游成本平台吸收），禁止盲目重提防双扣；direct 占独立长阻塞并发池 |
| stream          | SSE/分块                           | sync+stream；保留 pre-commit（先拉通首帧才回 200）                                                                                                                                |
| submit_poll     | 建任务+轮询                        | 自适应退避+抖动；poll 预算 = min(模型 max_run_time, offering 预算)；poll 单次失败重试不一错即败；**可租约接管**                                                                   |
| submit_callback | 建任务+回调                        | 验签→去重→乱序容忍→反查确认；强制兜底轮询双保险；**可租约接管**                                                                                                                   |

规划器规则：对外范式查模型；执行策略查供给项。**自动升格为纯服务端行为（产品裁决）**：slow 标记或注册表阈值命中 → images/tts 等同步端点自动改回 202+Task，无客户端 opt-in；升格不改变幂等键作用域与 hold 时机（创建时预扣），SDK 以 submit-and-wait helper 消化 200/202 双形态。路由排序在同模型多供给项间对可恢复 fetch 模式（submit_poll/submit_callback）给予优先权重。

## 4. 参数契约与参数感知路由

canonical 契约唯一挂模型。参数带**计价标记**：billing_relevant（参与售价 tier 的参数，如分辨率/时长档）与普通参数两级。

供给项五种声明（缺省 = supports 全域，声明成本靠探测验证与发现流程摊平）：supports / domain（值域收窄）/ map（值与名映射、类型翻译）/ fixed（上游钉死，诚实声明实际值）/ unsupported。运营者强制改参（现 param_override 的 set/clamp/delete）由 map/fixed 的运营者变体承接，语义并入同一张声明表。

路由规则：

1. 显式参数参与候选过滤（存在性 + 值域）。
2. **billing_relevant 参数强制参与过滤，且按解析后的生效值（显式或默认）判定**：offering 的 domain 必须包含生效值、fixed 必须等于生效值，否则过滤——杜绝「按 720p 收费、按 1080p 付成本」的毛利倒挂（Blocker C2 修复）。售价按 canonical 生效值计 tier，成本按 offering 实际值计，双向可见。
3. 非计价参数：默认值不参与过滤，选定供给项后按其映射解析（fixed 值对文档/预估可见）。
4. 全军覆没 → 400 unsupported_parameter，指明哪个参数排除了哪些供给项；strict 默认，lenient 显式开启且丢弃必回显 warnings[]；废除静默 dropUnsupported。
5. failover/降级链每一跳重过参数校验与映射。

### 4.1 参数解析流水线（三层映射语义归属，IR 字段形状的真相源）

三处"映射"各管一层，顺序与归属定死，批次0 冻结 IR 时以此为准：

1. **canonical 归一（门面 parse 阶段，产出 GatewayRequest.params）**：方言门面把入参归一到 canonical 参数（名/类型/值域），default 尚不解析——params 里区分"显式提供"与"缺省"（缺省参数携带 canonical 默认值但打 is_default 标记，供 §4 规则 3 判定是否参与过滤）。
2. **offering 声明层（路由阶段，规划器执行，不进适配器）**：候选过滤（§4 规则 1/2）后，对选定 offering 应用其参数声明得到 EffectiveParams —— 值域裁剪（domain）、值/名/类型翻译（map）、钉死（fixed）、运营者强制（map/fixed 的运营者变体）。**冲突优先级：运营者变体 > 上游申报 domain/map > canonical 默认**（运营者可收紧不可放宽上游能力）。约束「运营者变体 ⊆ 上游 domain」为配置期不变量：在 offering enable / golden probe 阶段校验（运营者钉的值必须落在上游 domain 内），拒绝配出上游会拒绝的值——不在运行期静默兜底。EffectiveParams 同时携带 canonical 生效值（计价用）与 upstream 实际值（回传用）两份。
3. **方言映射层（适配器切面①请求映射）**：只做 IR→上游 wire 的结构搬运（字段位置 query/json/form、方法路径），**不再做值域缩放或语义映射**——那些已在第 2 层固化进 EffectiveParams。切面①消费 EffectiveParams.upstream，是纯搬运。

字段回流（§4 规则 2「成本按 offering 实际值、双向可见」的载体）：GatewayResponse.usage 携带 `billing_dims`（计价维度 = canonical 生效值，喂价格卡 tier 与快照）；relay_trace/task_events 记 EffectiveParams 全量（canonical + upstream 双值）供审计与对账。规划器是 offering 声明的唯一执行者，适配器永不读 offering 声明——切面保持无状态纯搬运，是"一个 SPI"能成立的前提。

## 5. 对外 API 面（Blocker A1 修复）

- 同步/流式：POST /v1/chat/completions、/v1/embeddings、/v1/rerank、/v1/moderations、/v1/images/generations|edits、/v1/audio/speech、/v1/audio/transcriptions——OpenAI 兼容基座，模型寻址；慢模型按 §3 自动升格 202。
- 任务范式（模型寻址，废除 /v1/run/:resourceId）：资源风格创建 POST /v1/videos/generations、/v1/audio/music（+ images 升格）；等价语法糖 POST /v1/tasks（body 带 type）；通用查询 GET /v1/tasks/:id、列表 GET /v1/tasks?status=&type=（游标分页）、取消 POST /v1/tasks/:id/cancel、SSE 进度 GET /v1/tasks/:id/stream（承接现 /v1/jobs SSE，含终态兜底轮询）。
- 发现面：GET /v1/models 返回调用方（key 白名单 ∩ 租户可见性）可用模型及其操作面/范式/契约摘要——member 自助面与 key 白名单配置依赖它（替代现 /v1/resources）。
- 幂等：创建类 POST 收 Idempotency-Key，**键值映射带请求体指纹：同键同体回放首次结果，同键不同体 409 conflict**（修现状静默回放洞）。
- 方言门面：anthropic/gemini 入口翻译器保留；透传门面仍为独立产品决策（非目标）。

## 6. 适配器 SPI

六切面：①请求映射（IR→方言，消费 EffectiveParams.upstream 做 wire 结构搬运；不读 offering 声明、不做值映射，§4.1 第 3 层）②媒体注入（URL/base64/官方文件接口/直传桶，由方言声明）③凭证注入（最后一步，注入后请求冻结）④传输（HTTP/SSE、代理、四超时）⑤响应归一（流转码有界缓冲、usage 提取、per-provider 错误码表→统一 taxonomy，含 200 带业务错误翻译）⑥任务生命周期（submit/query/cancel/parseCallback/verifyCallback；envelope 契约显式类型化，修复回调断链）。

作者方式与边界：DSL（YAML：鉴权模板/wire 字段位置映射/状态映射/轮询回调声明/usage 提取/discovery 端点声明；版本化）覆盖简单 REST 厂商——注意值域缩放与语义映射归 §4.1 第 2 层（offering 声明 + 规划器），DSL 只描述切面①的 wire 结构搬运，不重复承担值映射；**DSL 表达不了的四类立即升代码切面**：签名算法、私有分帧、多步交互、WS 协议。签名器为全通道共享切面。QuickJS 第三轨废除。热更新一致性：注册表按「方言 ref+版本」引用，多副本以版本引用保证一致，灰度按供给项逐个切版本。

一致性测试门（mock 上游，合入 CI 强制）：凭证注入与签名字节比对（官方公开向量优先，无公开向量的厂商以实测录制快照为准）、参数映射快照与值域边界、媒体三种引用形态、流式乱序/半帧/中断容错、任务状态映射全覆盖（未知状态告警不崩溃）、错误码表完整性与 retryable/failover 标志、三级超时行为。

IR（批次0 首日冻结对象，只增不改）：GatewayRequest（tenant/key/subject、operation、model、canonical params[含 is_default 标记]、media refs、options、幂等键+体指纹）、**EffectiveParams（规划器产出，携 canonical 生效值 + upstream 实际值双份；切面①的真实入参）**、GatewayResponse（含 usage.billing_dims）、StreamFrame、TaskUpdate。

## 7. 任务中心

1. Task 实体 + task_events append-only（schema：id/task_id/seq/from_status/to_status/payload(裁剪至 4KB，上游 raw 超限截断)/created_at；retention 与 relay_trace 同策略配置，不默认永久）。对外六态 + 内部子状态 + progress。
2. 租约恢复：**范围收窄至可恢复 fetch 模式（submit_poll/submit_callback）**；owner_node + lease_until 周期续租，过期接管继续轮询。direct 按 §3 至多一次。
3. max_run_time 挂模型；hold TTL = max_run + 缓冲，与 15 分钟默认解耦。
4. 提交防重：先落库再调上游；提交超时先查询后重提，仍不确定宁可失败不盲目重提。
5. 转存先于 succeeded；require_persist=true 失败即 fail 不扣费；转存重试失败降级交付上游 URL + warnings + 告警。
6. 下游 webhook：事件信封（evt_id + 事件类型 + 完整 Task 体）、HMAC 带时间戳签名；**webhook secret 为租户级配置**（请求级 URL 可覆盖，secret 不随请求传）；退避档位可配置，内部租户默认 5 档至 1h，外部场景可扩至 24h；投递记录落库，接收方按 evt_id 幂等。
7. cancel：上游支持则转发；不支持则本地标记、晚到结果丢弃；已产生费用照常计量。
8. 并发闸门：**合成规则 effective = min(offering.concurrency, credential 配额镜像的并发数)，信号量按 (offering, credential) 双维持有**；有界等待队列超时 → failed(rate_limited)。单凭证渠道（如 Dify）池退化为 1，语义自然成立。闸门顺序（额度预检前置，hold 写账推迟到取信号量前，避免 429 风暴抖动账本）：租户/key 限流 → 额度预检（只读，不写账）→ 模型全局闸 → 凭证配额镜像选 key → 取 (offering,credential) 信号量 → **hold 预扣（账本写，此时已确定要发上游）** →（流式 pre-commit 首帧或任务 submit）→ 失败即释放信号量并回滚 hold。

## 8. 路由与容错细则

- 候选 = enabled 供给项 ∩ 可见性（§2.1/2.3 租户维度）∩ 参数感知过滤（§4）∩ 熔断闭合 ∩ 凭证池非全冷却 ∩ route-tag/钉选；排序 = tier 降序 + 权重随机 + 可恢复 fetch 加权。
- **task 路径与同步完全对齐（产品裁决）**：吃 route_group/tag/租户与 key 钉选/faultPolicy/breaker，废除现状异步旁路。
- 重试与 failover：retryable/failover 标志驱动；流式已发帧禁整流重试（pre-commit 保留）；降级链每跳重过参数校验。

## 9. 治理挂点

### 9.1 限流四层

租户/key（RPM+TPM）→ 模型全局闸 → 凭证配额镜像（触顶先池内换 key）→ 供给项并发闸门（§7.8）。

### 9.2 计费与价格卡

- price_card schema：{ 计价法（沿用七法）、单位、tier 维度 = billing_relevant 参数组合、单价、币种、版本、生效时间 }；价格历史保留，计费事件打价格快照（卡 id+版本）。
- 叠加顺序固定：供给项成本卡（成本侧）‖ 模型售价卡 → 倍率组 → 租户折扣（售价侧），两侧独立可对账。
- 保留 hold/settle + 封顶；补 estimated 标志；流式 hold 按模型契约估算（废固定 32k 预扣）。
- **对账降级（产品裁决）**：官方渠道（有账单口径）按日自动对账、偏差超阈值告警；中转渠道平台出 usage 侧月度报表人工核对。

### 9.3 错误与可观测

统一信封补 failover、request_id；429 带 Retry-After；TTFT 指标；trace 以 task_id 贯穿多段；relay_trace 与 task_events 设 retention。

### 9.4 媒体与文件

- **产物双轨（产品裁决）**：artifact_mode = signed（默认：签名 URL + 保留期，到期 expired）| public（稳定公开 URL，画廊/资产库场景，可豁免清理但保留 checksum 与生命周期记录）；配置在模型任务默认与租户策略，请求级可覆盖（受租户策略允许约束）。
- 字节路径：产物取回接 SSRF 防护（infra/ssrf.ts）、流式管道传输禁全量进内存、按体积分级超时。
- 文件输入：MIME 白名单 + 媒体探测，探测结果与模型输入约束联动校验/转码。

## 10. 目录与接入运营

- 官方价目层保留：model_spec/official_model_price 作为「目录参考层」，售价卡默认由官方价目生成；needs_pricing 闸保留（匹配不上 → disabled，永不 0 价上架）。canonical 契约作者 = 目录 spec 冻结 + 管理员校订；seed 只负责目录与方言包，不再制造供给实体。
- 发现与批建（Major A5）：渠道创建后走「发现模型」（方言 discovery 端点或目录勾选）→ 批量生成 offering（draft）→ **批量 golden probe（真上游小样探测：chat ping / 图像小样 / task submit-poll 短样，承接现 model-test 并转正为 offering 级准入门）** → 通过才可 enable。conformance suite（mock，管方言准入）与 golden probe（真上游，管供给项准入）双门职责分开。
- 下线语义（Major A4）：model deprecated → 响应头预告 + 目录标记，预告期后 disabled（404 model_not_found）；offering disable → 不收新请求，in-flight 跑完；凭证吊销即时生效；实体软删，计费事件与审计引用保留完整性。
- 管理面：五供给实体 + price_card CRUD + 接入向导（建厂商→建渠道录凭证→发现勾选→批探测→定价 enable→进路由组灰度）全部 UI 可达（修现状 90% CRUD 断链）。

## 11. Dify 决策（用户拍板）

Dify 专用子系统全移除（packages/dify、dify_binding、dify-workflow adapter、BYO 导入、dify-registration）。Dify 按普通厂商方言接入（DSL 级）；app 级 key 不可入池 → 一个 Dify app = 一条渠道（+模型+供给项）；chatflow → chat.completions；任意 workflow 输入由 canonical 参数契约承载。

## 12. 保留资产清单

参数契约两级思想（升级为 §4）、µUSD 七法与 hold/settle、pre-commit 流式、熔断器（key 迁供给项）、route_group/tags/钉选、relay_trace（加 retention）、R2 存储、幂等 claimIdempotency（**补体指纹与 409**）、治理管道全门面必经、audit append-only、动态配置。

## 13. 非目标与开放问题

- 透传门面（验签-重签 + usage 旁路）：独立产品决策，不在本设计。
- Realtime：预留 paradigm 枚举位，不设计实现。
- 语义缓存、成本智能路由：不做。
- 失败任务但上游已扣费的成本口径：direct 崩溃场景已定平台吸收（§3）；其余厂商侧「排队后失败仍扣费」待商务裁决。
- 多区域/多活任务中心：单区域假设。
