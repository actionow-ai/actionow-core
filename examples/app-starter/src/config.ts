function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export const config = {
  baseUrl: () => req('ACTIONOW_BASE_URL').replace(/\/$/, ''),
  consoleEmail: () => req('ACTIONOW_CONSOLE_EMAIL'),
  consolePassword: () => req('ACTIONOW_CONSOLE_PASSWORD'),
  proxyApiKey: () => req('ACTIONOW_PROXY_API_KEY'),
  webhookSecret: () => req('ACTIONOW_WEBHOOK_SECRET'),
  // Public origin core can reach, used to build media callback_url (webhook mode).
  publicBaseUrl: (): string | undefined => process.env.PUBLIC_BASE_URL?.replace(/\/$/, ''),
  model: () => process.env.ACTIONOW_MODEL ?? 'gpt-4o',
  port: () => Number(process.env.PORT ?? 8787),
};
