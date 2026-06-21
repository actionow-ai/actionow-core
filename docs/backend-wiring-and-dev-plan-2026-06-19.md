# 后端接口接入盘点 + 开发计划（2026-06-19）

> 配套文档：[frontend-design-review-2026-06-19.md](./frontend-design-review-2026-06-19.md)（逐页设计评审）。
> 本文盘点**后端接口的前端接入现状**，并结合评审给出**前后端合一的开发计划**。
> 口径：以后端路由装饰器 + 前端 `lib/api`（`admin.ts` / `consoleApi.ts`）实际调用为准交叉核对。

---

## 一、先分清「数据面」与「控制面」

**数据面（runtime / relay，由租户 SDK 或 webhook 调用，不是控制台 UI 的接入对象）：**

- `v1/chat/*`（OpenAI 兼容）、`v1/messages`（Anthropic 兼容）、`v1beta/models/*`（Gemini 兼容）、`v1/models`
- `v1/run` · `v1/resources` · `v1/jobs` · `v1/files`（执行 / 任务 / 资源 / 文件）
- `v1/callbacks`（异步回调）、`v1/payments`（支付 webhook）
- `auth/login` · `auth/register` · `auth/oauth/:provider`（用户登录——这部分控制台**确实接入了**，见 AuthProvider/AuthPage）

> ⚠️ **当前 relay 只有文本 chat**（OpenAI/Anthropic/Gemini）+ 执行/Dify 工作流（图像走 workflow）。**没有原生 image / audio / embeddings / video relay 端点**——Landing 的多模态调用日志是示意数据（已在 Phase 0 加「示意数据」标注，二者一致）。

**控制面（控制台 UI 的接入对象）：** `admin/*` · `console/*` · `admin/auth/*`。下面只盘点控制面。

---

## 二、控制面接入现状

### A. ✅ 完全已接入（client + 页面消费）——健康

- **租户 `console/*` 全量接入**：api-keys(list/create/rotate/disable)、analytics/usage、balance、me、models、payments(list)+intents、usage、usage-log、settings(改密码)。6 个 `/app` 面全部消费。
- **管理 `admin/*` 已接入并 surface**：tenants(list/create)、accounts(**list 本次新增** + create + topup)、api-keys(list/create/delete + group 绑定)、models(全 CRUD + grants 授权/撤销 + sync-models)、resources + channels(全 CRUD)、pricebook(create)、official-prices(全 CRUD)、modifiers(list/create)、route-groups(全 CRUD + 成员)、relay-traces、analytics/usage、dify/import、secrets(经 `SecretSelect` 列表 + `ChannelEditor` 创建)。

### B. 🟡 后端有能力、前端只用了一半（list/create only，缺 edit/delete/toggle）

| 资源          | 后端已提供                                         | 前端缺的接线                                                                                        |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Modifiers** | `GET/PATCH/DELETE admin/modifiers/:id`             | 编辑 / 删除 / 启停（评审标记的「只读列表」根因——**后端早就支持**，只差 client + UI）                |
| **Pricebook** | `PATCH/DELETE admin/pricebook/:id`                 | 编辑 / 删除（ResourceDetailPane 目前只能新增定价）                                                  |
| **Tenants**   | `GET admin/tenants/:id`、`PATCH admin/tenants/:id` | 详情拉取 + 编辑隔离模式（本会话的 Tenants 中枢抽屉目前 isolation 只读，**PATCH 已就绪，只差接线**） |

### C. 🟠 半接入（client 方法已写好，但没有任何页面 surface）

| client 方法           | 端点                          | 现状 / 影响                                                                                                                                |
| --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `generateCodes`       | `POST admin/redemption-codes` | **无兑换码后台**；且 `GET admin/redemption-codes`（list）连 client 都没有。Landing 明确宣传「卡密兑换」——**功能已宣传、后端已具备、零 UI** |
| `listLedger`          | `GET admin/ledger`            | 无管理端「租户流水」视图                                                                                                                   |
| `listUsage`           | `GET admin/usage`             | 无管理端「全局逐次调用日志」页（Analytics 用的是 rollup，不是原始 log）                                                                    |
| `listPayments`(admin) | `GET admin/payments`          | 无管理端「充值/支付」列表页（AppBilling 用的是 `console/payments`，是另一个端点）                                                          |
| `deleteSecret`        | `DELETE admin/secrets/:id`    | 凭证**只增不删**，无吊销 UI                                                                                                                |

### D. 🔴 完全未接入（无 client、无 UI）

- **上游 OAuth / Codex 渠道凭证管理（5 个端点）**：
  `GET/POST/DELETE admin/oauth-sessions` + `POST admin/oauth-sessions/codex/login/{start,complete}`。
  把 ChatGPT/Codex 等 OAuth 账号挂成 relay 渠道的能力，**后端已在真账号上验证**（见项目记忆 p1a），但前端零接入——目前只能靠 API/脚本操作。这是一块「已具备、未产品化」的能力。
- `GET admin/accounts/:id`、`GET admin/secrets/:id`：list 已覆盖，**可不补**。

---

## 三、开发计划（前后端合一，按优先级 / 依赖排序）

> 标注：**FE**=前端 · **BE**=后端 · **FE+BE**=需协同。括号内为预估相对体量。

### P0 ✅ 本会话已完成（基线）

设计评审 Phase 0–2 + Phase 4 可做项：错误态系统化（QueryBoundary/ErrorState/DataTable·CardCollection error）、enum/status/Money 一致性（全 20 面）、`GET /admin/accounts`（BE）+ Tenants 中枢抽屉吸收 Accounts、Landing nav 修正 + 示意数据标注、Auth 字段级错误、Settings 表单化、Overview「查看全部」。前端 269 测试 + 后端 e2e 34 全绿。

### P1 — 收口 needs-rework：纯前端补接线（后端已就绪，**最高杠杆/最低风险**）

1. **Tenants 抽屉接 `PATCH /tenants/:id`**（FE 小）：client `updateTenant` + 抽屉里隔离模式可编辑 + RowAction。补完 Tenants 中枢的「可改」。
2. **Modifiers 补全 CRUD**（FE 中）：client `updateModifier`/`deleteModifier` + 卡片 RowAction（编辑/删除/启停）+ 编辑抽屉。**直接收口评审的 needs-rework**。
3. **Pricebook 补 edit/delete**（FE 小）：client `updatePricebook`/`deletePricebook` + ResourceDetailPane 定价表 RowAction。
4. **凭证可吊销**（FE 小）：`SecretSelect`/凭证处接 `deleteSecret` + ConfirmDialog。

> ✅ P1 完成后，modifiers/pricebook/official-prices 都成完整 CRUD —— **解锁评审 Phase 5 的 `/console/pricing` 三合一 IA 合并**。

### P2 — 把「已具备未产品化」的后端能力补 UI（**FE+BE 协同，但 BE 多已就绪**）

5. **兑换码后台**（FE+BE）：BE 补 `listRedemptionCodes` client（GET 已存在）；FE 全新页面——mint 表单（面额/数量）+ 列表（状态过滤、分页）+ 复制/导出。落地已宣传的「卡密兑换」。
6. **上游 OAuth/Codex 渠道凭证管理**（FE+BE）：BE 5 端点已就绪；FE 全新页面/抽屉——粘贴授权（paste-auth）/ codex 登录引导（start→complete）/ 会话列表 / 吊销。把已验证的 relay 凭证能力产品化（建议挂在 catalog 或新「凭证」分组）。
7. **管理端运营视图**（FE，client 已有）：把 `listLedger`/`listUsage`/`listPayments`(admin) surface 出来——可作为 **Tenants 详情抽屉的 Tab**（该租户的流水/调用日志/充值），避免新增碎片路由。
   - ⚠️ BE 核对项：确认 `admin/ledger`/`admin/usage`/`admin/payments` 支持按 `tenantId` 过滤（前端 `qk.ledger(tenantId)` 暗示支持，需后端确认参数）。

### P3 — 设计系统 / 共享原语（来自评审，**纯前端重构**，建议独立 PR 评审）

8. `UsageAnalyticsShell` 抽取（admin Analytics + tenant Usage 高度重复，传入列定义 + 指标白名单，租户隐藏 provider_cost/margin）。
9. `useApiKeyLifecycle` + `<RevealKeyModal>`（租户 + 管理两端复用 mint/rotate/reveal；统一 `--fail` 警告 + 「我已保存」勾选）。
10. `ui/Tabs` 增 `fill`/`column` 变体，CatalogPage 删手写 tab（找回 44px 触控高度）。
11. DS token 补洞：`--fw-*`(补 500/650)、`--track-*`、`--s-*` 中间档（28/36/48/56），统一引用消除字面量漂移。

### P4 — 内容 / 可信度 / a11y / IA

12. **Landing 死链**（产品决策→BE/运营给 URL）：pricing「Read the docs」「Contact us」+ footer「Docs」三个 `href="#"` 需真实文档/联系 URL。
13. **忘记密码**（FE+BE）：BE 补密码重置流程（请求重置 + token 校验 + 改密 3 端点）；FE 加入口 + 流程页。
14. **a11y**（FE，需真机测试）：Modal/Drawer 背景 `inert`；密集控件 hit-slop。
15. **Billing**（FE）：充值落地页显示当前余额卡；二维码渲染成真二维码图（接 qrcode 库）而非裸字符串。
16. **`/console/pricing` IA 合并**（FE，**依赖 P1#2/#3 完成**）：groups + official-prices + modifiers 收敛为单路由页内 tab。

---

## 四、后端「需调整 / 补充」单独汇总

绝大多数 P1/P2 **后端已就绪，只差前端接线**。真正需要后端动的：

- **新增**：密码重置流程（auth，P4#13）。
- **核对/可能新增过滤参数**：`admin/ledger` / `admin/usage` / `admin/payments` 的按租户过滤（P2#7）。
- **可选新增（性能优化）**：`admin/accounts` 或 `admin/tenants/:id` 返回聚合计数（keys/resources/usage），让 Tenants 抽屉一次拿全，省去前端多次查询（评审建议）。
- **可选新增**：原生 image/audio/embeddings relay（若要兑现 Landing 的多模态宣传，而非仅 Dify workflow 路径）——属产品路线决策，非 bug。

**建议执行顺序**：P1（纯前端收口，解锁 IA）→ P2#5/#6（产品化已验证能力）→ P3（设计系统重构，独立评审）→ P4（内容/a11y/IA，部分依赖 P1 与产品输入）。
