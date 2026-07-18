export const locale = {
  zhCN: {
    landing: {
      login: '登录',
      enterConsole: '进入控制台',
      createAccount: '创建账户',
      signInConsole: '登录控制台',
      title1: '一个网关，',
      title2: '接住所有模型调用',
      subtitle:
        'OpenAI 兼容 /v1 统一接入聊天与异步媒体任务，µ积分 调用前预扣、按量结算、失败自动退还——每个内部产品就是一个租户。',
      point1: 'OpenAI 兼容端点，SDK 零改造',
      point2: '失败自动释放预扣积分',
      point3: '签名 Webhook 回调与任务中心',
      codeComment: '// 200 OK · usage 计入租户钱包',
      step1Title: '接入供给',
      step1Body: '在管理台登记服务商、渠道与模型，连通性探测通过后启用。',
      step2Title: '兼容调用',
      step2Body: 'OpenAI 兼容 /v1，聊天流式与异步媒体任务共用同一把 ak_ 密钥。',
      step3Title: '积分结算',
      step3Body: '调用前预扣、按量结算、失败自动退还，限额与审计全程留痕。',
      ctaTitle: '把模型调用统一接进网关',
      ctaBody: '注册即开通租户与积分钱包，签发 ak_ 密钥后立即可调。',
      footerSignIn: '登录控制台',
    },
  },
  en: {
    landing: {
      login: 'Sign in',
      enterConsole: 'Open console',
      createAccount: 'Create account',
      signInConsole: 'Sign in to console',
      title1: 'One gateway,',
      title2: 'every model call covered',
      subtitle:
        'Chat and async media tasks behind one OpenAI-compatible /v1 surface. Micro-credits are reserved before each call, settled by usage, and refunded on failure — every internal product is a tenant.',
      point1: 'OpenAI-compatible endpoints, zero SDK changes',
      point2: 'Failures release reserved credits automatically',
      point3: 'Signed webhooks and an async task center',
      codeComment: '// 200 OK · usage billed to the tenant wallet',
      step1Title: 'Connect supply',
      step1Body:
        'Register providers, channels, and models in the admin console; enable them once the connectivity probe passes.',
      step2Title: 'Call /v1',
      step2Body: 'OpenAI-compatible /v1 — streaming chat and async media jobs share one ak_ key.',
      step3Title: 'Settle in credits',
      step3Body:
        'Reserved before the call, settled by usage, refunded on failure — limits and audit trails cover the whole path.',
      ctaTitle: 'Put every model call behind one gateway',
      ctaBody:
        'Registering provisions a tenant and its credit wallet — issue an ak_ key and start calling.',
      footerSignIn: 'Sign in to console',
    },
  },
};
