# 03 · actionow-core「异步任务中心与媒体文件管线」现状(Research findings)

仓库:/Users/alienworm/actionow-core(commit 0af6b941,branch feat/ops-tab-layout-quickwins)
对照:/tmp/omni-spec.txt §3.4/§3.5/§4.3/§4.4。只报事实,不含方案。

---

## 任务生命周期现状(从提交到交付逐步)

### 1. 提交(创建)

- 端点:`POST /v1/run/:resourceId`(apps/api/src/execution/run.controller.ts:47)。任务按「资源 id」寻址,不是按 type/model。
- 请求体 = `runBodySchema`(packages/contracts/src/data-plane.ts:23):`inputs / exec_mode / callback_url / idempotency_key / end_user / estimated_usage / require_persist`。无顶层 `type`/`model`/`webhook` 对象;上游模型经 `inputs.model` 透传(packages/adapters/src/async-media.ts:242),下游 webhook 即 `callback_url` 字符串。
- exec_mode 枚举:`blocking | stream | async-poll | async-callback`(packages/contracts/src/adapter.ts:6)。`async-poll` 与 `async-callback` 在引擎里行为相同(都入队+轮询;回调是叠加的旁路)。
- 同步前缀(所有模式共享,packages/engine/src/execution-service.ts:1204-1244 `validateAndHold`):幂等 claim → `validateInputs`(io_schema)→ `computeHold`(pre=quote;post=estimated_usage 定价并以 `minimumHold` 为地板,execution-service.ts:1247-1269)→ `holdCredits` 原子预扣(失败→402 `insufficient_credits`,**不建 job**)→ `createJob(status='queued', holdExpiresAt=now+15min)`(DEFAULT_HOLD_TTL_MS=15\*60_000,execution-service.ts:347;RunService 未注入覆盖值)。
- 余额不足在创建时同步拒绝——满足 spec「禁止先受理后静默失败」。
- 响应:async 分支 `202 {job_id, status:'queued'}`(run.controller.ts:72-75);blocking 分支 200 带 output/usage/cost;SSE 分支按 Accept: text/event-stream 走 `runStream`。
- 入队失败(Redis 挂)→ 立即 `failJob` 释放 hold + 抛 retryable 错误,不留 15 分钟悬挂(execution-service.ts:1180-1195)。

### 2. 队列与执行(worker)

- BullMQ 队列 `job-exec`,入队 opts:`attempts:3, backoff exponential 2s, removeOnComplete:true, removeOnFail:1000`,BullMQ jobId=DB job uuid(队列级去重)(apps/api/src/common/bullmq-queue.ts:15-20,44)。
- Worker 未显式配 concurrency / stalledInterval(apps/worker/src/start.ts:87-91)→ BullMQ 默认(concurrency 1,stalledInterval 30s,maxStalledCount 1)。
- `JobRunner.process`(packages/engine/src/job-runner.ts:195-219):`transitionJob(['queued']→'running')` 守卫,重复投递/重放发现非 queued → **no-op 返回**;然后 `submit`(带 breaker 弹性2.0 预过滤 + `routeWithFailover` 跨渠道故障转移,job-runner.ts:238-300)→ `setUpstreamHandle` 记录上游 task_id → `pollToTerminal`。
- 队列 attempts 耗尽 → Worker 'failed' 事件调 `failExhausted`:立即终态 failed+释放 hold,不等 reaper(apps/worker/src/start.ts:96-103;job-runner.ts:229-235)。

### 3. 上游取结果:轮询 + 回调双路

- **轮询**:固定间隔 bounded loop——默认 `maxPolls:30 × pollIntervalMs:1000`(≈30s);渠道 `config.maxPolls/pollIntervalMs` 可按渠道调大(长视频)(job-runner.ts:135-136,317-323)。无自适应间隔、无指数放宽、无抖动、无「轮询计入上游限流预算」。budget 耗尽 → fail `upstream_timeout`(retryable:true)(job-runner.ts:353-358)。
- 轮询单次 HTTP 非 2xx 即返回 `{status:'failed'}` → 任务立刻失败(一次瞬时 5xx 就打死,无 poll 级重试)(packages/adapters/src/async-media.ts:297-299)。
- **回调**:`POST /v1/callbacks/:provider`(apps/api/src/callbacks/callbacks.controller.ts:26),不走 ApiKeyGuard;鉴权 = 渠道 secret 对**原始字节** HMAC-SHA256(`signPayload(secret, rawBody)`,不含时间戳拼接),签名/时间戳 header 名由渠道 config 定制(默认 x-actionow-signature / x-actionow-timestamp);时间戳 header **存在时**才校验 ±5min 窗口(callbacks.service.ts:148-174)。correlate:用 adapters 的 `parseCallback` 提取 upstreamJobId → `getJobByUpstreamHandle`(callbacks.service.ts:82-89)。
- 无「反查上游确认」;无按(task_id+状态+载荷哈希)的去重表——去重完全靠 settle 的状态迁移守卫;**无乱序容忍**:`handleCallback` 里非 `succeeded` 一律 `fail`(job-runner.ts:494-497),中间态回调(如 running/processing)会把任务打成 failed。
- ⚠️ 形状断链:`asyncMediaAdapter.parseCallback` 只认内部 envelope(需 rawBody/headers/secret 字段,async-media.ts:326-337),而 CallbacksService 只传 parsedBody(纯 JSON)→ 真实 async-media 供应商的 `{task_id, data:{...}}` 回调体在这条路径永远解析失败(→401)。当前唯一可用形状是 mock 的 `{upstreamJobId, status}`(async-media-mock.ts:110-114),e2e 也仅用该形状(apps/api/test/stream-callbacks.e2e.test.ts:467)。生产 async-media 事实上只靠轮询。
- 双路收敛:settle/fail 都过 `transitionJob` 守卫 + `ledger_settle_per_job` 部分唯一索引 backstop,poll/callback 竞态收敛为恰一条 ledger(packages/db/src/repositories/settle.ts:36-58;schema/execution.ts:113-115)。

### 4. 产物转存(转存先于成功)

- settle 前先转存:`persistMediaResult` 在 settle 写库**之前**执行(job-runner.ts:374-412)。
- `require_persist=false`(默认):best-effort——转存失败**静默**沿用上游临时 URL 照常 settle 扣费,无 warnings 字段、无告警(media-result.ts:167-176)。
- `require_persist=true`:转存不了(无 assets / fetch/put 错 / storage 未配置)→ `PersistRequiredError` → `failJob` 释放 hold、不扣费(job-runner.ts:388-412;media-result.ts:11-17)——即「失败即 fail 不扣费」(mig 0066,job.require_persist 列,schema/execution.ts:59)。
- 转存实现:`fetchBytesWithTimeout`(30s AbortSignal,**整文件读入内存** Uint8Array,无重试/无断点续传/无分片)→ presigned PUT 到 S3 兼容桶(packages/infra/src/media-bytes.ts:23-45)。b64 资产解码上传后从结果里删除。
- 产物 URL 形态:`{STORAGE_PUBLIC_BASE_URL}/{tenantId}/{jobId}[-{i}].{ext}` **稳定公开 URL(非签名、不过期)**(media-result.ts:146-155);每个对象写一条 `file_object`(含 width/height/duration,worker: job-exec.processor.ts:96-114;回调路径与媒体方言各有同构副本)。签名 GET 由 `GET /v1/files/:id/url` 按需铸造,TTL 3600s;presigned PUT TTL 900s(packages/infra/src/storage.ts:20-22)。无 sha256、无 CDN 预热。
- settle 单事务:job 迁移(queued|running→succeeded,写 output/usage/cost)+ 释放 hold + 扣费 + settle ledger 行 + **事务性 webhook_outbox 插入**(settle.ts:50-107)。settle 后补一条 usage_log(媒体毛利可见,job-runner.ts:444-456)。

### 5. 下游 webhook(callback_url)

- 表 `webhook_outbox`:status pending|sent|dead + attempts + next_attempt_at(schema/execution.ts:195-216)。worker 每 10s 扫一遍 due 行(start.ts:18,106)。
- payload 极简:成功=`{job_id}`;失败=`{job_id, error}`(job-runner.ts:435-437,474-476);reaper 取消=`{job_id, status:'canceled', error}`(engine/reaper.ts:43-50)。**无事件类型、无 evt\_ id、无完整任务对象、成功 payload 连 status 都没有**。
- 签名:`X-Actionow-Signature: <hex(HMAC-SHA256(secret, body))>`,无时间戳参与签名 → 无重放防护(engine/webhook.ts:14-23);secret 按「webhook url」为 key 经 SECRET\_<url> 解析,解析不到就**不签名照发**(webhook-outbox.processor.ts:14,21)。
- 重试:maxAttempts 5,指数退避 base 1s cap 1h → 实际 1s/2s/4s/8s 后 dead(engine/webhook.ts:45-47,119-127);spec 要求 5s→24h 七档。dead 行留库(webhook_outbox 即投递记录,但无 per-attempt 响应快照)。
- SSRF:投递前 `assertEgressAllowed`(私网/loopback/link-local/CGNAT/元数据 IP 拒,DNS 解析全地址检查;NXDOMAIN 放行走正常失败重试)→ 命中直接 dead-letter(webhook.ts:100-109;infra/ssrf.ts:60-104);`WEBHOOK_ALLOW_PRIVATE_TARGETS` 环境变量 opt-in(infra/config.ts:172)。`callback_url` 在 ingress 只做 http(s) 格式校验(contracts/data-plane.ts:26-32)。

### 6. 查询 / 列表 / 取消 / SSE 进度

- `GET /v1/jobs/:id`、`GET /v1/jobs?cursor&limit`(keyset,**无 status/type 过滤**)、`POST /v1/jobs/:id/cancel`、`GET /v1/jobs/:id/stream`(apps/api/src/jobs/jobs.controller.ts:24-68)。jobs controller 只挂 ApiKeyGuard,无 GovernanceGuard → 轮询端点无专门限流。
- JobView 字段:job_id/status/resource_id/exec_mode/inputs/output/usage/cost/error/created_at/updated_at(jobs.service.ts:18-30)。无 progress、无 provider.task_id 暴露(列 upstream_job_handle 存在但不出视图)、无 started_at/finished_at/expires_at。
- 取消:`failJob(queued|running→canceled)` 原子释放 hold,幂等(已终态 no-op 返回当前视图)(jobs.service.ts:74-91)。**不转发上游取消**(ProviderAdapter 无 cancel 方法,adapters/src/types.ts:43-44);晚到的 poll/callback 结果被迁移守卫丢弃。「已产生的上游费用照常计量」= 无:hold 全额释放,0 计费。无 canceling 中间态。
- SSE 进度:worker 端 `JobRunner.emitProgress` fire-and-forget → Redis pub/sub `job:progress:{jobId}`(engine/job-progress.ts:25;worker/runtime.ts:97-102)。milestones:`running/submitted`、`running/polling(poll idx,≥2s 节流)`、`succeeded`、`failed`(job-runner.ts:213,335-348)。事件 shape 有 `progress?: 0..1` 字段但**从未被填充**(PollResult 无 progress 字段,contracts/adapter.ts:110-117)——即无上游进度百分比映射,只有阶段/轮询次数。
- SSE 与轮询一致性:API 端从不直接信 pub/sub——每个 wire 事件都触发一次 DB 重读 reconcile,另有 2.5s DB-poll backstop 保证终态必达、15s 心跳、单流硬上限 10min(job-stream.service.ts:14-19,110-143)。frames:snapshot/progress/done/error;progress 帧就是 JobView(无百分比)。
- admin 面可复用同一 SSE 流(subject 无关的 `resolveAdminContext`,jobs.service.ts:67-71)。

### 7. 幂等与防重提交

- 下游幂等:`idempotency_key` 表,`INSERT … ON CONFLICT DO NOTHING`,唯一约束 `(tenant_id,key)`(subject NULL)/`(tenant_id,subject_id,key)`(db/repositories/idempotency.ts:25-72;schema/execution.ts:132-155)。claim 失败 → 回放原 job(succeeded→200 原结果,否则 202 queued)(execution-service.ts:365-406)。stream 模式重复 key → `invalid_input`(不能重放活流,execution-service.ts:424-437);chat 阻塞路径进行中重复 → 429 retryable(execution-service.ts:579-585)。claim 与 createJob 用同一预生成 jobId,claim 行永远指向真实 job(e2e 竞态修复来源)。
- 上游提交防重:submit 超时结果未知时**不会盲目重提**——BullMQ 重投后 job 已是 running,`process` 守卫 no-op;但也**没有**「先查询后重提」或 client_token 机制,结局是挂到 hold-reaper 取消(≤15min)。调用方可自带 `inputs.idempotency_key` 由 adapter 透传给上游 body(async-media.ts:256-257),与顶层 `idempotency_key` 是两个字段、不自动贯通。

### 8. 崩溃恢复与超时(谁强制 max_run_time)

- **无租约**(无 owner_node/lease_until 等价物)。worker 崩溃 → BullMQ stalled 检测(默认 30s)重投 → `process` 重入发现 running → **no-op(不重新 submit、不续 poll)** → 任务悬挂直至 hold-reaper。
- hold-reaper:每 30s 扫 `hold_expires_at < now AND status IN (queued,running)`(部分索引 job_due_idx,schema/execution.ts:74-76)→ `failJob(→canceled)` 释放 hold + 可选取消 webhook(engine/reaper.ts:30-56;start.ts:20,109)。
- 运行超时事实上由两把钳子决定:①poll budget(worker 进程内,默认 ~30s,渠道可调)②hold TTL 15min(创建时定死;若渠道 poll budget 配得比 15min 长,reaper 会在轮询进行中把 job 取消,后到的 settle 被守卫吞掉)。无按模型注册表声明的 max_run_time。

### 9. 文件输入

- 上传 = 三步 presign 流:`POST /v1/files/presign-upload`(filename/content_type/size)→ 客户端 PUT(presigned,TTL 900s)→ `POST /v1/files/:id/confirm`(服务端 HEAD 落 size/contentType/etag,pending→ready)(files.controller.ts:62-80;files.service.ts:103-172)。
- 限制:声明 size ≤ `STORAGE_MAX_UPLOAD_BYTES`(默认 100 MiB,infra/config.ts:70)+ 每租户总量 quota(presign 时按声明值闸,confirm 时不复核,files.service.ts:120-128)。**无分片上传、无 MIME 白名单、无安全扫描、无 ffprobe 探测(file_object 的 width/height/duration 只在产物持久化路径填充)、无 sha256 校验、无 rejected 状态**(status 仅 pending|ready,schema/storage.ts:43-44,55)。
- 模型引用方式:io_schema 的 `file`/`file_list` 字段值 = `file_id`(裸 uuid,**非 gwfile:// scheme**);run 时 `resolveFileInputs` 把 file_id 换成 presigned GET URL 再交 adapter(files.service.ts:263-305;run.service.ts:254)。交付形式只有「临时签名 URL」一种——无 base64/官方 file 接口/直传指定桶的按适配器声明选择;无输入约束校验/自动转码。跨 subject 引用被拒(§4b)。
- 例外:STT `POST /v1/audio/transcriptions` 是 multipart 直传(multer,25 MiB 硬限,transcriptions.controller.ts:75)。
- SSRF 覆盖面:infra/ssrf.ts 只被 webhook 投递使用;**媒体产物下载 `fetchBytesWithTimeout`(上游给的 URL)不过 SSRF 检查**(worker/runtime.ts:116;备忘录中 media-fetch-SSRF 属已知推迟项);上游 endpoint 有意不设限(operator 配置)。
- 下载:`GET /v1/files/:id/url` 返回 JSON `{url(3600s), expires_in, public_url(永久)}`(非 302);`DELETE /v1/files/:id` 软删 tombstone + best-effort 桶删除,**无「被 running 任务引用 → 409」检查**(files.service.ts:186-201)。

### 10. 过期与清理(哪个 reaper 管什么)

- `hold-reaper`(30s):悬挂 hold 的 queued/running job → canceled。
- `file-lifecycle-reaper`(1h):**opt-in** 文件 TTL——租户 `account.config.file_ttl_days` 覆盖 → 平台 `FILE_RETENTION_DAYS` → 都没有则永久保留;软删+桶删,批 500/租户上限 5000/轮(file-lifecycle-reaper.processor.ts:32-77)。输入文件与产物同一张 file_object 表、同一 TTL,无「输入 7 天/产物 90 天」区分,无 legal hold。
- `relay-trace-reaper`(1h):relay_trace 调试表按 RELAY_TRACE_RETENTION_DAYS 清。
- **job 行本身无保留期/清理/expired 态**;queues.ts:6 里声明了 `poll-upstream` 队列名但没有任何 processor/生产者(死名)。

---

## 与 spec 3.4/3.5/4.3/4.4 的逐项对照表

| Spec 条目                                                                                              | 现状                                                                                                                                                                                                                       | 证据                                                                     |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **3.4.1** 资源风格创建端点(/v1/videos/generations、/v1/audio/music、images async)                      | **部分** — 仅 `/v1/images/generations` 与 `/v1/audio/speech`,且是**同步**方言(in-process 驱动 async 任务到终态再返回);无 videos/music 端点;无 `gw.async` 开关                                                              | media-dialect.service.ts:66-73,158-194                                   |
| **3.4.1** `POST /v1/tasks`(body 带 type)泛化创建                                                       | **无** — 等价物是 `POST /v1/run/:resourceId`(资源寻址)                                                                                                                                                                     | run.controller.ts:47                                                     |
| **3.4.1** 202 + Task 对象;配额/余额不足创建时同步拒绝                                                  | **部分** — 202 有但 body 仅 `{job_id,status}`;402 同步拒绝完全满足                                                                                                                                                         | run.controller.ts:72-75;execution-service.ts:1227-1236                   |
| **3.4.2** Task 对象(progress/output.artifacts/error/usage/webhook.status/provider/三时间戳/expires_at) | **部分** — JobView 有 status/inputs/output/usage/cost/error/created/updated;无 progress、无 artifacts 结构(output 为自由 JSON,P1 后是 MediaResult 形)、无 webhook 投递状态、无 provider 块、无 started/finished/expires_at | jobs.service.ts:18-30,105-119                                            |
| **3.4.3** 六态状态机 pending/running/succeeded/failed/canceled/expired                                 | **部分** — 五态 queued/running/succeeded/failed/canceled(DB CHECK);无 expired                                                                                                                                              | schema/execution.ts:35,77-80                                             |
| **3.4.3** 内部子状态 upstream_submitted→generating→transferring                                        | **无**(转存期间对外确实仍是 running——顺序等价但无显式子状态)                                                                                                                                                               | job-runner.ts:374-423                                                    |
| **3.4.3** 终态禁止再迁移                                                                               | **有** — transitionJob from-guard(`WHERE status IN (queued,running)`)                                                                                                                                                      | db/repositories/job.ts:55-68                                             |
| **3.4.3** 每次迁移写 task_events 事件流                                                                | **无** — 无 task_events 等价表;job 迁移不写 audit_log                                                                                                                                                                      | schema/execution.ts 全文;job.ts:55-68                                    |
| **3.4.4** GET /v1/tasks/{id};轮询限流                                                                  | **部分** — GET /v1/jobs/:id 有;该端点无专门限流(仅 ApiKeyGuard)                                                                                                                                                            | jobs.controller.ts:14,36-41                                              |
| **3.4.4** 列表 status/type 过滤 + 游标分页                                                             | **部分** — 游标分页有,无 status/type 过滤                                                                                                                                                                                  | jobs.controller.ts:24-33                                                 |
| **3.4.4** cancel:canceling 中间态/上游转发/晚到丢弃/费用照常计量                                       | **部分** — 本地立即 canceled(无 canceling);不转发上游(adapter 无 cancel);晚到丢弃有(守卫);费用照常计量无(hold 全释放 0 计费)                                                                                               | jobs.service.ts:74-91;adapters/types.ts:43-44                            |
| **3.4.5** Webhook 事件类型 task.running/progress/succeeded/failed/canceled                             | **无** — 仅 settle/fail/reap 三种极简 payload,无 type/evt_id/完整 Task                                                                                                                                                     | job-runner.ts:435-437,474-476;reaper.ts:43-50                            |
| **3.4.5** 签名 `t=…,v1=hex(HMAC(secret, t+"."+body))`                                                  | **部分** — `X-Actionow-Signature: hex(HMAC(secret, body))`,无时间戳 → 无重放窗口                                                                                                                                           | engine/webhook.ts:14-23,150                                              |
| **3.4.5** 重试 5s/30s/2m/10m/1h/6h/24h 后放弃并告警                                                    | **部分** — 5 次:1s/2s/4s/8s(cap 1h),dead 后无告警                                                                                                                                                                          | webhook.ts:45-47,119-127                                                 |
| **3.4.5** 按 evt\_ 幂等消费;succeeded 必在转存后发                                                     | **部分** — 无 evt_id(接收方只能按 job_id 幂等);「转存后才发」满足(outbox 与 settle 同事务,settle 前已转存)                                                                                                                 | settle.ts:97-103;job-runner.ts:379-438                                   |
| **3.5** POST /v1/files multipart ≤512MB                                                                | **部分** — presign PUT 流(非 multipart),默认上限 100MiB                                                                                                                                                                    | files.service.ts:103-148;config.ts:70                                    |
| **3.5** 分片上传 /v1/uploads(part/complete/sha256)                                                     | **无**                                                                                                                                                                                                                     | files.controller.ts 全文                                                 |
| **3.5** GET /v1/files/{id}/content → 302 限时签名                                                      | **部分** — GET /v1/files/:id/url 返回 JSON(url 3600s + 永久 public_url),非 302                                                                                                                                             | files.service.ts:175-184                                                 |
| **3.5** DELETE 被 running 任务引用 → 409                                                               | **部分** — 软删无引用检查                                                                                                                                                                                                  | files.service.ts:186-201                                                 |
| **3.5** File 对象:processing/ready/rejected + reject_reason + checksum + media 探测                    | **部分** — pending/ready 两态;无 rejected/checksum;media 维度列存在但输入路径不填                                                                                                                                          | schema/storage.ts:39-55                                                  |
| **3.5** gwfile://<id> 统一引用;按 Provider 变形(URL/base64/file 接口/直传桶)                           | **部分** — 裸 file_id 经 io_schema file 字段引用,统一解析为 presigned URL(仅此一种形式)                                                                                                                                    | files.service.ts:263-305                                                 |
| **3.5** MIME 白名单+安全扫描(必须)、ffprobe(应当)、自动转码                                            | **无**                                                                                                                                                                                                                     | files.service.ts:103-172                                                 |
| **3.5** 输入文件默认保留 7 天                                                                          | **无** — 默认永久,opt-in TTL                                                                                                                                                                                               | file-lifecycle-reaper.processor.ts:16-31                                 |
| **4.3.1** TaskStore:先写 tasks+task_events 再副作用                                                    | **部分** — job 迁移+ledger+outbox 单事务(强);无事件流表                                                                                                                                                                    | settle.ts:50-107                                                         |
| **4.3.1** Scheduler:模型×Key 并发闸 + 租户公平 + 有界队列 + max_queue_time                             | **无** — 单 BullMQ 队列,worker 默认并发 1,无出队闸门;API 入口有 GovernanceGuard(rpm/concurrency/额度)但属请求层非任务调度层                                                                                                | start.ts:87-91;auth/governance.guard.ts                                  |
| **4.3.1** UpstreamPoller:自适应 5s→60s+抖动+计入上游预算                                               | **部分** — 固定间隔 bounded loop(默认 1s×30 次,渠道可调),无自适应/抖动/预算                                                                                                                                                | job-runner.ts:317-351                                                    |
| **4.3.1** CallbackReceiver:逐厂商验签/payload 哈希去重/乱序容忍/反查确认                               | **部分** — HMAC 验签有(header 名渠道可配);去重靠 settle 守卫(无载荷哈希);**乱序容忍无**(非 succeeded 回调直接 fail);反查确认无;且真实 async-media 回调体形状解析断链(仅 mock 形状可用)                                     | callbacks.service.ts:74-104;job-runner.ts:486-513;async-media.ts:326-337 |
| **4.3.1** Notifier + webhook_deliveries                                                                | **有/部分** — outbox+dispatcher 有;投递记录=outbox 行(attempts/status),无 per-attempt 明细                                                                                                                                 | webhook.ts:93-131                                                        |
| **4.3.1** Reaper:max_run_time(注册表按模型,默认 30min)→failed;产物到期→expired                         | **部分** — poll budget 超时→failed(upstream_timeout);hold-reaper 15min→canceled;无按模型 max_run_time,无产物 expired                                                                                                       | job-runner.ts:353-358;reaper.ts:30-56                                    |
| **4.3.2** 崩溃恢复租约(owner_node+lease_until,多副本接管续轮询)                                        | **无** — BullMQ stalled 重投但 process 对 running job no-op,不接管续跑;最终 hold-reaper 取消                                                                                                                               | job-runner.ts:207-209;reaper.ts                                          |
| **4.3.2** 提交幂等(先落库记 submit_attempt;client_token;先查询后重提;禁止盲目重提)                     | **部分** — 先落库有(queued 快照);无 submit_attempt 记录;不会盲目重提(守卫 no-op)但也无查询后重提/client_token 自动机制                                                                                                     | execution-service.ts:1238-1244;job-runner.ts:207-217                     |
| **4.3.2** 转存先于成功;重试 3 次;降级=上游 URL+warnings+告警                                           | **部分** — 转存先于 settle 有;**无重试**(单次 30s);降级=静默上游 URL(无 warnings/告警);require_persist 提供「不降级改失败」开关                                                                                            | job-runner.ts:374-412;media-bytes.ts:23-45                               |
| **4.4 输入管线**(白名单→扫描→探测→转码→四种上游形式)                                                   | **部分** — 上传/入库/URL 交付有;其余无(见 3.5 行)                                                                                                                                                                          | files.service.ts                                                         |
| **4.4 输出管线**(高优转存队列/分片下载重试3断点续传/sha256/CDN 预热/art\_ 记录)                        | **部分** — settle 内联转存(非独立队列);单次全缓冲下载,无重试/续传/分片/sha256/CDN;file*object≈art* 记录(含媒体维度)                                                                                                        | media-result.ts:124-177;job-exec.processor.ts:82-117                     |
| **4.4** 签名 URL 默认 TTL 24h 可续签                                                                   | **部分** — presigned GET 3600s,可反复铸新;产物主 URL 是**永久公开** URL(超出 spec 的暴露面)                                                                                                                                | storage.ts:20-22;media-result.ts:152                                     |
| **4.4** 生命周期:输入 7 天/产物 90 天/legal hold                                                       | **部分** — 统一 opt-in TTL(默认永久),无输入/产物区分,无 legal hold                                                                                                                                                         | file-lifecycle-reaper.processor.ts                                       |
| **4.4** 大对象全程流式,禁止整文件入内存                                                                | **无** — fetch→arrayBuffer 全量缓冲(下载与上传均是)                                                                                                                                                                        | media-bytes.ts:30-45                                                     |

---

## 值得注意的事实

1. **回调链路对真实供应商形状断链**:`POST /v1/callbacks/:provider` 的 correlate 依赖 `adapter.parseCallback(parsedBody)`,但 `asyncMediaAdapter.parseCallback` 只认内部 envelope(需 secret/rawBody),永远解析不了裸 `{task_id,data}` 体;当前只有 mock 形状 `{upstreamJobId,status}` 走得通(e2e 即此形状)。生产 async-media 实际全靠轮询兜底。(async-media.ts:326-337;callbacks.service.ts:107-119;stream-callbacks.e2e.test.ts:467)
2. **非终态回调会杀任务**:`handleCallback` 把一切非 succeeded 当 fail(job-runner.ts:494-497)——上游发一条「processing」回调即可把 running 任务打成 failed(hold 释放);spec 的「旧状态到达直接丢弃」不成立。
3. **崩溃≠接管**:worker 崩溃后任务不被续跑——BullMQ 重投的 process 对 running 行 no-op,只能等 hold-reaper(≤15min)取消并退款。「15min hold TTL」同时是事实上的全局 max_run_time 上限:渠道把 poll budget 配超 15min 时,reaper 会在轮询中途取消任务(后到的 settle 被守卫吞掉,用户拿到 canceled + 退款,上游其实做完了)。
4. **轮询单次 HTTP 错误即失败**:poll 的非 2xx 直接映射 `{status:'failed'}`,无 poll 级容错(async-media.ts:297-299)——瞬时 502 会终结一个已花钱的视频任务。
5. **webhook payload 无事件语义**:成功通知只有 `{job_id}`(连 status 都没有),消费方必须回查 GET /v1/jobs/:id;签名无时间戳无重放防护;secret 解析不到时**不签名照发**。
6. **媒体转存拉取无 SSRF 防护且全内存缓冲**:`fetchBytesWithTimeout` 直接 fetch 上游返回的任意 URL(30s 超时),不过 infra/ssrf.ts;大视频整段进 Uint8Array(内存放大)。(runtime.ts:116;media-bytes.ts:30-35;备忘录记载 media-fetch-SSRF 为已知推迟项)
7. **产物主 URL 是永久公开 URL**(STORAGE_PUBLIC_BASE_URL/{tenant}/{job}.ext),无签名无 TTL;spec 设想的是自有域名**签名** URL + expires_at。key 里含 tenantId+jobId(可枚举性低但非签名)。
8. **持久化的 file_object 与 job 无外键关联**:产物行不带 jobId/subjectId(createFileObject 只传 tenantId,job-exec.processor.ts:98-103)——产物→任务的反向追溯要靠 key 命名约定。
9. **幂等 claim→createJob 用同一预生成 uuid**(execution-service.ts:370-392),这是 e2e 竞态修复(备忘录 concatMap AWAIT)后的形态:claim 行永不指向不存在的 job;但 `claimIdempotency` 不校验请求体指纹——同 key 不同 body 会静默回放旧结果(admin 面的 request_idempotency 反而有 fingerprint,schema/execution.ts:183-188)。
10. **queues.ts 声明了 `poll-upstream` 队列但零使用**(queues.ts:6)——疑似为独立轮询调度器预留的名字,从未实现。
11. **进度 0-100 不存在**:PollResult/上游解析都不提取进度;SSE 的 progress 帧只是状态视图,JobProgressEvent.progress 字段是死代码。
12. 媒体方言(/v1/images/generations、/v1/audio/speech)是把 async 任务**in-process 跑到终态**的同步封装(media-dialect.service.ts:158-194),阻塞时长受渠道 poll budget 约束;它复用与 worker 完全相同的 hold/settle/persist 路径。
13. io_schema `file` 输入解析出的 presigned GET(3600s)在提交给上游时作为 `image_url` 透传(async-media.ts:81-87)——上游取件窗口=1h,与 spec「TTL 覆盖任务时长」的意图一致但值固定。
14. 事务性 outbox 保证 webhook 只在 settle/fail 成功落库时产生(settle.ts:97-103)——「webhook 在转存完成后才发」在当前实现里是自然成立的(转存在 settle 前、outbox 在 settle 事务内、dispatcher 只发已落库行)。
