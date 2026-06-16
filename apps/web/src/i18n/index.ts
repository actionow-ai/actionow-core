import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import enCommon from './locales/en/common.json';
import enLanding from './locales/en/landing.json';
import zhCommon from './locales/zh-CN/common.json';
import zhLanding from './locales/zh-CN/landing.json';

export const SUPPORTED = ['zh-CN', 'en'] as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: zhCommon, landing: zhLanding },
      en: { common: enCommon, landing: enLanding },
    },
    fallbackLng: 'zh-CN',
    supportedLngs: SUPPORTED,
    ns: ['common', 'landing'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'actionow.lang',
      caches: ['localStorage'],
    },
  });

i18n.on('languageChanged', (lng) => {
  document.documentElement.setAttribute('lang', lng);
});

export default i18n;
