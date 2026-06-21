/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_OAUTH_ENABLED?: string;
  readonly VITE_BRAND_NAME?: string;
  readonly VITE_DEPLOYMENT_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
