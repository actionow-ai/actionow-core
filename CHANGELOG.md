# Changelog

## [0.0.9](https://github.com/actionow-ai/actionow-core/compare/v0.0.8...v0.0.9) (2026-07-06)


### Bug Fixes

* **relay:** emit OpenAI-wire stream error frame and label served model on blocking responses ([#112](https://github.com/actionow-ai/actionow-core/issues/112)) ([2975eba](https://github.com/actionow-ai/actionow-core/commit/2975eba89ca5a0855d2e2cb7ce7942736e1a46a6))

## [0.0.8](https://github.com/actionow-ai/actionow-core/compare/v0.0.7...v0.0.8) (2026-07-06)


### Features

* **media:** per-request require_persist force-persist switch ([#2](https://github.com/actionow-ai/actionow-core/issues/2)) ([#110](https://github.com/actionow-ai/actionow-core/issues/110)) ([89eb6d0](https://github.com/actionow-ai/actionow-core/commit/89eb6d036b93158b980dfe98ea20a1a39c3763c8))

## [0.0.7](https://github.com/actionow-ai/actionow-core/compare/v0.0.6...v0.0.7) (2026-07-06)


### Features

* **files:** stable public_url on /v1/files + media force-persist switch ([#108](https://github.com/actionow-ai/actionow-core/issues/108)) ([137700e](https://github.com/actionow-ai/actionow-core/commit/137700e3e362e44b562a816228bc9a02871b4aff))

## [0.0.6](https://github.com/actionow-ai/actionow-core/compare/v0.0.5...v0.0.6) (2026-07-04)


### Features

* **media:** all HuiMeng image models + img2img (参考生图) + 3-min image poll budget ([#106](https://github.com/actionow-ai/actionow-core/issues/106)) ([a3f2025](https://github.com/actionow-ai/actionow-core/commit/a3f2025b8e46a2f25557a4e390c51cbfc3b3bcb7))

## [0.0.5](https://github.com/actionow-ai/actionow-core/compare/v0.0.4...v0.0.5) (2026-07-03)


### Features

* media model passthrough + HuiMeng media models; fix credentials list legibility; enable CORS ([#104](https://github.com/actionow-ai/actionow-core/issues/104)) ([e4286d1](https://github.com/actionow-ai/actionow-core/commit/e4286d1b28af9b1a61deda3401d6760bbc5eaa26))

## [0.0.4](https://github.com/actionow-ai/actionow-core/compare/v0.0.3...v0.0.4) (2026-07-03)


### Bug Fixes

* decouple prod demo-data seed gate from admin + render generic modality icons ([#102](https://github.com/actionow-ai/actionow-core/issues/102)) ([92b0013](https://github.com/actionow-ai/actionow-core/commit/92b0013b46cf9b05adcd4ae457ed76115853bacd))

## [0.0.3](https://github.com/actionow-ai/actionow-core/compare/v0.0.2...v0.0.3) (2026-07-03)


### Bug Fixes

* **seed:** gate demo/mock data out of prod, verify prices online, enrich model_spec ([#100](https://github.com/actionow-ai/actionow-core/issues/100)) ([7836ce4](https://github.com/actionow-ai/actionow-core/commit/7836ce4f763e54aedacf1b9a9cbf7c4e245c73a1))

## [0.0.2](https://github.com/actionow-ai/actionow-core/compare/v0.0.1...v0.0.2) (2026-07-03)


### Features

* **param:** phase 0 — per-(model×channel) param override (channel_model.param_override, mig 0062) ([#90](https://github.com/actionow-ai/actionow-core/issues/90)) ([53aad84](https://github.com/actionow-ai/actionow-core/commit/53aad8494c55f41f66234237e0bd5270290980ba))
* **param:** phase 1 — model ModelParamProfile (features + parameter_rules, migs 0063/0064) ([#91](https://github.com/actionow-ai/actionow-core/issues/91)) ([8e1c805](https://github.com/actionow-ai/actionow-core/commit/8e1c8051b5d7dac052a29b768031d1cdeb296c84))
* **param:** phase 2 — native_finish_reason + require_params routing + override-status UI ([#92](https://github.com/actionow-ai/actionow-core/issues/92)) ([ddbb02f](https://github.com/actionow-ai/actionow-core/commit/ddbb02f2332b7422ce5d2b75e2cd1546d968ca35))
* **web:** 中转追踪 按任务聚合 (group relay traces by job_id) ([#87](https://github.com/actionow-ai/actionow-core/issues/87)) ([c3f9cf6](https://github.com/actionow-ai/actionow-core/commit/c3f9cf6a34a59252f885a32460faaca873f8a2aa))
* **web:** 模型接入 改主从式布局(方案 A · 供给树 + 密集模型表) ([#88](https://github.com/actionow-ai/actionow-core/issues/88)) ([896298d](https://github.com/actionow-ai/actionow-core/commit/896298ddc69685b20d64eee543cdfef59718dfdf))


### Bug Fixes

* **caps:** reconcile capabilities↔features (Option C) + backfill capability data from catalog ([#94](https://github.com/actionow-ai/actionow-core/issues/94)) ([396e829](https://github.com/actionow-ai/actionow-core/commit/396e829e5464f3aaefa953b58037b42b4dfc74d1))
* **deploy:** nginx web listens on 8080 for Zeabur ingress ([#85](https://github.com/actionow-ai/actionow-core/issues/85)) ([12241f9](https://github.com/actionow-ai/actionow-core/commit/12241f9a9638af1ec584d9edefedf7f0d9c08b4b))
* **deploy:** point web nginx at api-gw:8080 (Zeabur internal port) ([#86](https://github.com/actionow-ai/actionow-core/issues/86)) ([128e889](https://github.com/actionow-ai/actionow-core/commit/128e889241d3555cb3bb4d43264623eb0360222f))
* resolve backend architecture-review findings ([#96](https://github.com/actionow-ai/actionow-core/issues/96)) ([2b4fd19](https://github.com/actionow-ai/actionow-core/commit/2b4fd190d812b098ed7c71e59f2727f584423b3c))
