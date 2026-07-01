# 05 · 迁移:场景一(Model-A)→ 场景二(Model-B)

从「core 托管用户」升级到「你自持用户、把 core 当能力基座」。**零数据迁移**——core 侧的 subject / 钱包 / 用量 / 文件全不动。

## 关键事实(决定怎么迁)

- Model-A 的 subject 由 `POST /auth/register-member` 建,只有 **email + password**,**没有 `external_id`**。
- `external_id` **不可变**(建后不能改;`PATCH /console/subjects/:id` 根本不接受该字段)。
- ⇒ 你**不能**给旧 subject 补 `external_id`。别试。

所以迁移不是「回填 external*id」,而是**按 subject 的 `id`(UUID)联邦** + 给它铸一把 \*\*subject-scoped `ak*`**(归属靠 key,不靠 `end_user`)。

## 步骤

1. **建你的用户表**,为每个 Model-A 用户存 core 的 **`subject_id`(UUID)**。`GET /console/subjects` **没有 email 过滤**(只 keyset 分页)—— 翻完整列表、在你侧按 `email` 对上(`SubjectView` 带 `email`),用你已握有的 email 匹配即可。
2. **给每个 subject 铸 `ak_`**:`POST /console/api-keys { subjectId }` → 存 `plaintext`(加密)。这把 key 绑定该 subject,天然归属,无需 `end_user`。
3. **你的应用接管认证**:停用 core 的 `login-member`(改由你验证密码/SSO);之后 AI 调用用该用户的 `ak_`。
4. **core 侧不动**:subject 的余额、历史用量、文件全部原样保留。

机制细节(建 key / subject):[../../actionow-integration/reference/01-authentication.md](../../actionow-integration/reference/01-authentication.md)。

## 新用户怎么办

迁移之后,**新用户直接走场景二**:`POST /console/subjects { externalId=<你的用户id> }` → 发 key。新 subject 有 `external_id`(可用 `end_user` 归属或直接用 subject-scoped key)。老用户按 `subject_id` 关联、新用户按 `external_id` 关联并存,不冲突。

## 反模式

- `PATCH /console/subjects/:id` 想改 `external_id` —— 该字段不可变,会被忽略/拒绝。
- 为老用户**新建重复 subject**(想让它带 external_id)—— email 会冲突(`registerMember` 已占用),而且会**丢掉**老 subject 的余额/用量。用 `subject_id` 关联即可。
