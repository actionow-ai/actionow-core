# 05 · 「模型供给与接入」绿地设计草稿 — 对抗性架构评审

评审对象：docs/plans/draft_2026-07-10_model-supply-greenfield.md（下称「设计」，节号 §n 指该文档）
评审输入：00-spec-source.txt（外部 spec）、01~04 前置调研、仓库代码（HEAD 0af6b941）。
立场：独立评审，挑毛病不背书。严重度定义：Blocker=不定不能进 plan；Major=进 plan 前应补或在 plan 中显式立项；Minor=开工前补一句话即可。

---

## A. 端到端完整性（接入→配置→探测→定价→路由→调用→计费→观测→下线）

**A1【Blocker】task 范式的对外创建入口无着落。**
依据：五实体（§2）废除了 resource 层，但现有唯一的泛任务创建面是资源寻址的 `POST /v1/run/:resourceId`（apps/api/src/execution/run.controller.ts:47）；§5 称「门面保持现有：OpenAI 兼容 /v1 + 入口翻译器」，而现有 /v1 门面里 video/music 根本没有端点（video 只能走 /v1/run）。§2.1 把 video.generation 挂上模型操作面后，这个操作用什么 URL、什么请求体创建（spec 3.4.1 的 /v1/videos/generations？保留 /v1/run 改为模型寻址？）通篇没有一节回答。API 面不定，plan 无法拆分。

**A2【Major】接入前探测（model-test）整体缺席。**
依据：现有 `POST /admin/models/test` 承担接入前 connectivity/functional 双腿验证（apps/api/src/admin/admin.controller.ts:1516、model-test.service.ts:36-49，chat 一行 ping / media 最小生成 submit→poll）。设计只有 mock 上游的一致性测试门（§5）与 offering 层被动健康态（§2.5），两者都不能替代「真上游、真凭证、不落行」的接入预测试。offering 化后探测对象应当是 offering（模型×渠道×凭证），设计无此位置。

**A3【Major】官方价目/规格库（model_spec + official_model_price，236 模型）在新架构无角色，canonical 契约与 price_card 的作者来源未定。**
依据：现状 sync-models 流程 = listModels 拉上游 → 匹配 official_model_price 定价 → 未匹配则 needs_pricing+disabled「永不 0 价计费」→ 从 model_spec 派生 capabilities 并冻结 param_profile（admin.service.ts:1610-1686、packages/db/src/repositories/model.ts:159-269、model.ts:72-74）。设计 §2.1 要求每个模型有 canonical 参数契约 + price_card，但没说这些从哪来（手写 236 份？从 model_spec/official 价目派生冻结？）；needs_pricing 防 0 价闸门、seed 流程（seed-catalog/seed-providers/seed-official-prices）在五实体下如何存续，只字未提。

**A4【Major】下线/弃用语义欠规定。**
依据：§2.1 只声明了 status 枚举 draft/active/deprecated，无任何语义：deprecated 是拒新请求、warning 头还是仅目录隐藏？有无 sunset 期？offering disable 时 in-flight task 是跑完还是取消？渠道退役/凭证吊销时 running 任务手里的凭证怎么处理？模型软删与 append-only ledger/usage_log/audit 的引用关系？整条「下线」链路在生命周期走查中是空白（对比：spec 也没写，这不是照单未收的问题，是双方都缺）。

**A5【Major】offering 的批量创建/自动发现流程缺席，硬绑定的运营成本没有着落。**
依据：§1.4「供给必须硬绑定」+ §2.5 UNIQUE(model, channel) 意味着每个可服务组合都要显式建 offering；现状靠 sync-models 自动建模型行并 `linkChannelModelsByNames` 自动 link（admin.service.ts:1610-1686）。设计没有等价的发现/批建/对账（上游下架模型后 offering 置灰？）流程。236 模型 × 多渠道，5 人团队手工建 offering 不现实。

**A6【Minor】新模型接入的管理面（谁在哪个 UI 完成五实体 CRUD）未提。**
依据：2026-07-07 审计定性「90% CRUD 缺口 = UI 可达性断链」（memory access-models-audit）；实体从 3 层升 5 层却不给管理 IA 设计，风险重演。可在 plan 阶段补，但必须有人认领。

---

## B. 与现有系统职责的对账（设计只字未提或含糊的在承担职责）

**B1【Blocker】多租户供给/可见性维度整体缺席。**
依据：现有三处租户维度设计全无对应物——①租户私有平台：resource.tenant_id nullable（packages/db/src/schema/catalog.ts:24-29）；②模型可见性：model.visibility public|tenant + model_grant，SQL 级 gate（packages/db/src/repositories/model.ts:297-327）；③key 级供给白名单：api_key.resourceAllowlist 在数据面强制（apps/api/src/auth/api-key.guard.ts:118）、在 /v1/resources 发现面过滤（apps/api/src/execution/resources.service.ts:47-71）、member/tenant-admin 面可设置（apps/api/src/member/member.service.ts:174）。§2.1 model 无 visibility 字段；resource 消失后 allowlist 挂什么（模型名？offering？）未定。这与 §1.4「治理禁止旁路」直接冲突：产品面实体不承载租户治理维度，治理就旁路了。

**B2【Major】subject/end_user 归因不在新 IR 里。**
依据：§5 GatewayRequest 只有 tenant/key；现状 run body 带 end_user、幂等唯一约束含 subject_id（packages/db/src/schema/execution.ts:132-155）、usage_log/file_object 带 subject 维度、/member 自助面依赖 subject 归因。§9 说保留幂等 claimIdempotency 与审计——IR 不带 subject 则这两项「保留」在字段层面不成立。

**B3【Major】「异步任务不吃钉选/容错」的已知治理缺口被「保留现有语义」原样保留。**
依据：worker 异步 job 路由取全部 active 渠道、route_group/tag 窄化不进 job 快照（apps/worker/src/loaders.ts:43，产品文档同口径）；JobRunner 不消费 faultPolicy、failover 映射无 priority（04-routing-billing.md 事实 1）。§2.5 写「route_group/tags/租户与 key 钉选保留现有语义」——现有语义恰含此旁路。设计需显式声明：task 路径同样过组窄化+参数感知路由+per-offering 容错，且这由统一 planner（§3）保证；现在只是暗示。

**B4【Major】产物 URL 策略与两天前刚上线的产品决策相反，未声明翻案。**
依据：§6.5「产物一律签名 URL + 保留期，到期置 expired」；而 v0.0.7 刚刻意上线稳定公开 public_url（packages/engine/src/media-result.ts:146-155 稳定不过期 URL；memory upstream-gap-fixes-2026-07-06「稳定 public_url」），huimengi 资产画廊等接入方依赖。绿地允许改，但这是产品级 breaking 决策，必须显式裁决并给接入方口径，不能藏在任务中心一节里。

**B5【Major】io_schema/表单式资源/playground 的落点未定。**
依据：io_schema 承担 /v1/run strict 校验、/v1/resources 发现、web playground 表单渲染（02-registry.md 事实 10）；§8 只解决 Dify 的输入 schema（canonical 契约承载），泛媒体「表单式调用+发现面」在五实体下挂哪、canonical 契约能否表达 file/file_list 字段（§2.1 只写了参数名/类型/值域/默认值），未说。

**B6【Minor】操作面枚举漏 rerank/moderations。**
依据：§2.1 列表「chat.completions / embeddings / images.generation / video.generation / tts / asr …」；现有 /v1/rerank、/v1/moderations 在跑（04 调研）。省略号不构成契约。

**B7【Minor】/v1/jobs/:id/stream SSE 进度流未提。**
依据：现有 SSE 进度（DB reconcile + 2.5s backstop + 心跳，job-stream.service.ts:14-19）是已交付面；§6 只写 webhook 与 progress 字段。

**B8【Minor】运营者侧渠道级参数强制（param_override set/clamp/delete，mig 0062）无对应物。**
依据：§4 五声明是「上游能力的诚实申报」，fixed=上游钉死；「运营者主动在某 offering 强制某参数值」是另一职责，现有 apply-override.ts:14-19 承担，设计中消失。

**B9【Minor】下游 webhook secret 归属未规定。**
依据：现状按 SECRET\_<url> locator 解析、解析不到不签名照发（apps/worker/src/processors/webhook-outbox.processor.ts:14-21）；§6.6 定义了签名格式却没定义 secret 的注册/轮换归属（租户级配置？）。

**B10【Minor】动态配置与 @Audit 覆盖面未列新实体清单。**
依据：§9 说保留 SettingsResolver 与 audit append-only；五实体 CRUD 的审计点与新增 settings key（如 lenient 开关、升格阈值）需在 plan 列清单。

---

## C. 自洽性（决策互相打架处）

**C1【Major】并发闸门的表达力：offering 闸 × 凭证镜像的交集表达不了「同 key 同模型」的上游真实限制；Dify 单凭证下 L3 语义退化未声明。**
依据：spec 4.3.1 的任务闸是「模型 × 上游 Key」；设计拆为 offering.concurrency（模型×渠道，跨凭证，§2.5）+ credential 配额镜像（凭证级，跨模型，§2.4）。渠道挂 3 把 key、4 个模型时，(key,model) 粒度的并发限制两个闸都表达不了，两闸的合成规则（同时取？获取顺序？谁先拒绝）未写。§8 Dify 一 app 一渠道一凭证下，§7 L3「触顶先池内换 key 再拒绝」恒退化为直接拒绝——结论可接受但应显式声明。

**C2【Blocker】「默认值不参与路由过滤」× fixed 声明 × 计费 tier 三条规则互相打穿计费正确性。**
依据：§4 规则 3（默认值不过滤）+ 规则 5（售价 tier 按 canonical 值、成本按映射后实际值）+ fixed 定义（§4 表）。推演一：请求未带 resolution（canonical 默认 720p），fixed:1080p 的 offering 不被过滤且中选，实际值 1080p → 售价按 720p tier、成本按 1080p → 毛利静默倒挂。推演二：显式 resolution=720p 的请求，fixed:1080p 的 offering 是否被过滤？规则 1 只定义了 unsupported 与 domain 的过滤，fixed 根本不在过滤语义里 → 可能出现「客户付 1080p 价拿 720p 货」或反向。必须补：fixed 对显式参数按 domain={fixed 值} 参与过滤；默认值命中 fixed 偏离时售价 tier 取谁（canonical 还是实际值）的明确规则。

**C3【Blocker】direct（阻塞式）取数 × 租约恢复互斥；防重提原则对 direct 失效。**
依据：§3 direct=「worker 挂长连接执行，超时预算=max_run_time」（可达 30min+）；§6.2 租约过期由其他 worker「接管，继续轮询」——direct 模式没有 provider_task_id，无物可轮询、无物可查询；§6.4「上游提交结果未知时先查询后重提」对 direct 同样无从查询。接管者只剩两条路：重提（双重生成、双重成本，违背 §6.4）或放弃（任务失败但上游可能已在扣费出货）。租约恢复必须显式声明「仅对 submit_poll/submit_callback 生效，direct 供给项 worker 崩溃即 fail」，且 direct 长阻塞对 worker 并发模型的占用（现状 BullMQ 默认并发 1，apps/worker/src/start.ts:87-91）需要执行模型设计。§3「同一模型经异构渠道对调用方语义完全一致」在崩溃恢复维度不成立。

**C4【Minor】pre-commit 流式 × 四层闸门的获取/释放顺序未定。**
依据：§7 四层顺序声明为静态列表；pre-commit（§3 stream 行）failover 换 offering/凭证时，已获取的 L3 配额与 L4 信号量是否释放、重试跳是否重新过 L2/L3、sync/stream 是否受 offering.concurrency 约束（§2.5 称其为「任务闸门依据」），均未规定。

**C5【Major】「对外范式挂模型」×「超阈值自动升格」自相矛盾，且升格瞬间幂等/计费/SDK 形态三线切换无规则。**
依据：§3 规划器「images/tts 默认 sync，slow 标记或超阈值自动升格 task」——slow 挂模型尚符合原则 2，「超阈值」（按请求参数）使同一模型同一操作的响应形态 200/202 由请求内容决定，而设计删掉了 spec 3.3.2 的 gw.async 客户端显式开关 → 客户端无法预知形态，SDK 必须双形态防御。升格还切换幂等存储（sync claim 回放 vs job 回放）与 hold 路径（inline settle vs max_run TTL），一致性规则一条都没写。

**C6【Minor】429 的归因二义：凭证冷却（§2.4）与 offering 熔断（§2.5）都消费 429，一次 429 是否双记、全池冷却时 offering 健康态如何表达（key 病 vs 渠道病），未规定。**

---

## D. 欠规定（不够细到能开工）

**D1【Major】price_card 结构未定义。**
依据：§2.1/§2.5 只有名词（版本化、快照、倍率组、成本价卡同单位体系）。与现有七法 PriceSpec（unit/matrix/fixed/formula/passthrough/model_token/credits，packages/contracts/src/pricing.ts:3-11）的关系、tier 维度声明方式、与 route_group ratio(bps)/markup/modifiers 的叠加顺序、货币与 µUSD 的换算归属——全部缺失。计费是「保留资产」的最大接缝，schema 不定 plan 无法列迁移面。

**D2【Major】参数差异声明的缺省姿态未定。**
依据：§4 五声明齐备，但 offering 未声明某参数时按 supports 还是 unsupported？前者让过滤形同虚设，后者让声明成本随模型×渠道数爆炸。声明的作者来源（从 model_spec.parameterRules 派生？手写？）与校验工具未提。C2 的规则补丁也依赖这里先定缺省语义。

**D3【Major】DSL 能力边界不闭合。**
依据：§5 列了六项能力与「约 80%」的估计，但没有：DSL→代码切面的升级判据、同一 provider 能否按切面混用 DSL+代码（spec 5.4 允许，设计未置可否）、DSL 版本升级对存量 offering 的灰度/回滚、热加载在多副本下的一致性语义。

**D4【Minor】一致性测试门的用例来源未定：签名字节比对的官方向量从哪来（volc/tencent 有公开样例，可灵类没有）、「任务状态映射全覆盖」以上游文档还是实测为准、门在 CI 的强制点（合入 vs 发布）。**

**D5【Minor】task_events 无 schema：seq/from/to/payload 裁剪策略未给；上游 raw 全落库会重演 relay_trace unbounded 教训（04 调研事实 7），需 retention 声明。**

**D6【Minor】offering 熔断具体判据未写：默认沿用现 breaker 参数（window 60s/minVolume 20/50%）即可，但半开试探与凭证池轮转的相互作用需一句话。**

**D7【Minor】max_run_time（挂模型，§2.1）与 per-offering 超时预算（§2.5 fetch_profile）冲突时取谁（min？）未写。**

**D8【Minor】幂等键无请求体指纹的既有洞（同键不同 body 静默回放，03 调研事实 9；spec 3.2 要求 409）被 §9「保留 claimIdempotency」原样继承，未声明是否修。**

---

## E. 过度设计怀疑（为不存在的需求付复杂度）

**E1【Major】「按日与上游账单对账（偏差告警）」（§7）对业务现实不成立。**
依据：供给主力含中转渠道（无账单 API，人工充值卡密制），官方厂商账单口径/延迟/币种各异；这条在 5 人团队落地必然退化为人肉流程。已有逐行 provider_cost 毛利记录（packages/db/src/schema/usage.ts），建议降级为「可选的人工对账报表」而非架构承诺。

**E2【Minor】下游 webhook 7 档退避至 24h + evt 幂等 + 投递记录明细：租户=自家内部产品，现有 5 档封顶足够；可裁但非错。**

**E3【Minor】任务中心「全强度」租约多副本接管：单区域、事实单 worker 的现实下，租约值得做（部署重启杀视频任务是真痛点），但承诺范围应随 C3 显式收窄到 submit_poll/submit_callback，而非全称。**

**E4【Minor】per-offering 全参数差异矩阵（与 D2 同根）：租户少、渠道少的内部中台，可用「只声明差异、缺省 supports + 计费按实际值兜底」大幅降低运营成本——但前提是 C2 的规则先定。**

---

## 总体裁决

**需补 X 处再进 plan（X = 4 Blocker + 至少 A2/A3/B3/B4/C1/C5/D1/D2 八个 Major 的裁决）。**

理由：骨架本身（五实体、范式/取数解耦、单 SPI+DSL、任务中心全事件流）方向自洽且显著优于现状三轨并存，不构成结构性返工；但四个 Blocker 各自卡死 plan 的一个必要输入——A1 卡 API 面拆分、B1 卡实体 schema 定稿、C2 卡计费正确性规则、C3 卡任务中心与取数模式的执行模型。Major 中 A3（价目/契约作者来源）与 D1（price_card schema）建议与 Blocker 同批补齐，否则 plan 的计费与目录两章仍写不出验收标准。
