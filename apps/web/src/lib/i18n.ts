import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export type AppLanguage = 'zh-CN' | 'en';

export interface InitI18nOptions {
  resources: { 'zh-CN': Record<string, unknown>; en: Record<string, unknown> };
  storageKey?: string;
}

let storageKeyInUse = 'graphite.language';

function storedLanguage(storageKey: string): AppLanguage {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'en' ? 'en' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function syncDocumentLanguage(language: string) {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
}

export function initI18n({ resources, storageKey = 'graphite.language' }: InitI18nOptions) {
  storageKeyInUse = storageKey;
  void i18n.use(initReactI18next).init({
    resources: {
      'zh-CN': { translation: resources['zh-CN'] },
      en: { translation: resources.en },
    },
    lng: storedLanguage(storageKey),
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  });

  syncDocumentLanguage(i18n.language);

  i18n.on('languageChanged', (language) => {
    syncDocumentLanguage(language);
    try {
      window.localStorage.setItem(storageKeyInUse, language);
    } catch {
      // The selection still applies for this session without persistence.
    }
  });

  return i18n;
}

export function toggleLanguage() {
  void i18n.changeLanguage(i18n.language === 'en' ? 'zh-CN' : 'en');
}

export { i18n };
