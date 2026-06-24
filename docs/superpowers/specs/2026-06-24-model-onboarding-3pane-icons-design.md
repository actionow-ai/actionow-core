# 模型接入 3-pane + Icon System + Vendor Naming — Design Spec

> **Status:** Approved (Q&A). Builds on [[catalog-supply-hierarchy]] + the catalog-tags-ia work. Keeps the data model (resource/平台 still owns channels+models for routing) but **re-projects the 模型接入 management UI as 插件→通道→模型** (platform hidden).

**Goal:** Merge the 模型接入 (platform two-pane) + 插件 pages into ONE 3-pane page; make plugins the top grouping; add a selectable brand-icon system on 插件/通道/模型; ship vendor-accurate default names + a vendor/protocol-subdivided plugin library.

---

## ① 模型接入 — one 3-pane page (replaces /console/catalog two-pane + the 插件 nav item)

Layout (`/console/catalog`, relabeled stays 模型接入):

- **Left 1/3 — 插件列表**: the provider-plugin library (vendor/protocol adapters). Selecting a plugin drives the middle column. A `+新建插件` action + each row editable (the old PluginsPage editor, incl. the CodeMirror handler).
- **Middle (left 1/3 of the right 2/3) — 通道卡片**: the channels **bound to the selected plugin** (`channel.plugin_id = plugin.id`). `+添加通道`, edit/enable/sync/delete.
- **Right (right 2/3 of the right 2/3) — 模型卡片网格**: the selected channel's served models (`channel_model`), click → model detail/edit.

Platform/resource stays in the DB (routing + `model.resource_id`) but is NOT a UI column. New-channel flow picks a plugin + a platform (platform may default/auto-create per plugin). The standalone 插件 nav item is removed (folded into 模型接入); 接入设置 group keeps 代理/Dify/凭据.

**Card-shadow/border clipping fix:** the 3-pane columns get inner padding (and `overflow` that doesn't clip the `.entity-card` hover-lift shadow + `is-selected` ring) — the round-3 edge-to-edge inset must not crop card chrome.

## ② Icon system (selectable, seeded)

- **`icon_asset` table** (migration 0035): `key` (PK, e.g. `openai`/`anthropic`/`volcengine`/`google`/`tencent`/`alibaba`/`kling`/`minimax`/`xai`/`deepseek`/`codex`), `label`, `svg` (inline SVG markup) OR `kind`+ref, `category`. Seeded with brand logos.
- **`icon` text column** on `provider_plugin`, `upstream_channel`, `model` (migration 0035) — stores an `icon_asset.key`; null → fall back to the provider-derived `ProviderIcon`. A model with no icon inherits its channel/plugin icon.
- **`IconPicker`** component (a grid of seeded icons) in the plugin/channel/model editors.
- **`BrandIcon`** component renders an `icon` key from the seeded library (with `ProviderIcon` fallback).
- Endpoint: `GET /admin/icons` → the seeded `icon_asset` list (for the picker). Contracts view + SDK.

## ③ Vendor-accurate naming + vendor/protocol plugin library

Rewrite `seed-plugins.ts` so built-ins are **subdivided by vendor/protocol** with official names + icons. Examples of the naming convention the operator sees:

- 插件 = vendor/protocol: `OpenAI` · `Anthropic` · `Google` · `火山引擎 (Volcengine)` · `腾讯混元` · `阿里 (Alibaba)` · `可灵 (Kling)` · `MiniMax` · `xAI (Grok)` · `Codex CLI` (the CLI reverse-proxy).
- 通道 = a concrete instance: `OpenAI 官方` / `OpenAI-Office` / `火山引擎官方`.
- 模型 = official model id: `gpt-5.5` / `Seedance 2.0`.
  Each built-in plugin carries: vendor-named `label`, `icon` key, `modalities`, `protocol`, `authStrategy`, `manifest`, `handler`. The protocol×auth matrix from the prior library stays, re-labeled per vendor. Reverse-proxy: **Codex CLI** (name); claude-code CLI = future.

---

## Phases

1. Data: `icon_asset` table + seed brand SVGs; `icon` column on plugin/channel/model (migration 0035); repos; `GET /admin/icons` + contracts/SDK; `icon` in plugin/channel/model views + create/update DTOs.
2. Vendor-named plugin seed rewrite (official names + icon keys + Codex CLI).
3. `BrandIcon` + `IconPicker`; wire icon into plugin/channel/model editors + cards.
4. The 3-pane 模型接入 page (plugin列表 │ 通道卡片 │ 模型网格); remove 插件 nav item; card-clipping fix.

## Testing

Contracts fixtures (+icon). Repo: icon round-trips. Web: 3-pane renders plugin→channel→model; icon picker sets an icon; card chrome not clipped; tooltip above subnav. Live-verify in preview.
