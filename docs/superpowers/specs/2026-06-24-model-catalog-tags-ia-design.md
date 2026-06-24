# Model Catalog — Tags, Facets & Single-Entry IA — Design Spec

> **Status:** Approved (analysis of ZenMux → keep our 平台→通道→模型 design, borrow metadata/tagging/IA). Builds on [[catalog-supply-hierarchy]].

**Goal:** Borrow ZenMux's model-catalog ergonomics WITHOUT adopting its model-centric architecture: add a tag/metadata system on models, a faceted model list, denser model cards, and collapse the supply-side console into a single role-aware **「模型」** entry.

**Non-goal:** No restructure of 平台→通道→模型. `model` stays resource-scoped; channels (通道) stay the route. (ZenMux is model-centric with global models served by N providers — explicitly NOT adopted.)

---

## ① Tag / metadata system (model)

New `model` columns (migration `0034`, all nullable/defaulted — additive):

- `tags text[]` default `'{}'` — free-form operator labels (推荐/便宜/快/长上下文/代码…), filterable.
- `maker text` — the model's **developer/maker** (anthropic/alibaba/z-ai/openai…); ZenMux's 开发者 axis. Distinct from `provider_type` (which is the protocol/adapter).
- `context_length integer` — max context window (tokens); ZenMux's 上下文长度.
- `reasoning text` — enum `none | optional | always` (无/可切换/始终); ZenMux's 推理. Null → unset.

Repo (`repositories/model.ts`): `createModel`/`updateModel` accept the 4 fields (conditional spreads, matching existing pattern); `ModelRow` picks them up via `InferSelectModel` automatically.

Contracts (`catalog-views.ts`): `modelViewSchema` += `tags: string[]`, `maker: string | null`, `context_length: number | null`, `reasoning: string | null`. Create/Update model DTOs (in `admin-dtos`/contracts) += the same (optional). Regen SDK.

## ② Faceted model list

A reusable faceted list: filter models by **modality · maker · capability · tag · status**. Facets derive from the loaded models (no extra endpoints). Used by:

- **Tenant `/app/models`** (the read-only catalog) — primary.
- **Admin** model view (optional, within the platform's model grid or a flat model list).

Component: `FacetedModelList` (or extend the existing list) — a left/top facet rail + the model card grid. Each facet shows distinct values + counts; multi-select within a facet (OR), AND across facets.

## ③ Card density

Model card + `ModelDetailDrawer` gain:

- **tag chips** + **maker** + **context_length** + **reasoning** badge.
- **协议正名**: surface `provider_type` (of the model's resource) as a 「协议」 label (display-only rename — no data change).
- **uptime sparkline + availability%** (reuse the status-page `modelHealth` data) on the card.
- **「N 个通道」** badge from `served_channel_ids.length`.

## ④ 「模型」 catalog vs 「接入设置」 management (role-aware IA)

Split "WHICH models exist" (browse) from "HOW they're wired" (admin plumbing).

**Admin console (`/console`, ADMIN_NAV):**

- **「模型」** — a NEW standalone top entry (route `/console/models`) = the model **catalog**: the faceted flat list of ALL models (②③), click → detail (read + quick edit). Same component the tenant uses, with admin extras (status, 通道数, edit).
- New **「接入设置」** group (admin-only) — the wiring/onboarding:
  - **模型接入** — the platform→通道→模型 two-pane management (the existing `模型服务`/ResourceDetailPane at `/console/catalog`, **relabeled 模型接入**).
  - **插件** (/console/plugins) · **代理** (/console/proxies) · **Dify** (/console/dify) · **凭据** (/console/oauth-sessions).
- 运营 / 计费与路由 / 租户 groups unchanged. The old 接入与供给 group dissolves (its items move to 接入设置; 模型 catalog is promoted to its own entry).

**Tenant app (`/app`, TENANT_NAV):** the **「模型」** entry (`/app/models`) = the read-only faceted catalog (②③). No channel/plugin/proxy internals.

Role-differentiation is inherent (admin → /console, tenant → /app, separate nav configs). New admin catalog route `/console/models` reuses the faceted-list component; `/console/catalog` stays as 模型接入 (management).

---

## Phases

1. Schema + repo + contracts/SDK (tags/maker/context_length/reasoning).
2. Model editor inputs + card/drawer display (tags/maker/context/reasoning + 协议 + sparkline + 通道数).
3. Faceted model list (tenant /app/models, then admin).
4. IA: nav collapse → 「模型」 (with 插件 sub-tab) + 「接入设置」 group.

## Testing

Contracts fixtures (+4 fields). Repo: create/update round-trip the fields. Web: model editor saves tags; facet filter narrows; nav renders the new groups. Live-verify in preview.
