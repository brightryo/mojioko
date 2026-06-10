import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_LANGUAGE } from '../shared/app-info'

import jaCommon from './locales/ja/common.json'
import jaStep1 from './locales/ja/step1.json'
import jaStep2 from './locales/ja/step2.json'
import jaStep3 from './locales/ja/step3.json'
import jaSettings from './locales/ja/settings.json'
import jaErrors from './locales/ja/errors.json'
import jaDonation from './locales/ja/donation.json'

import enCommon from './locales/en/common.json'
import enStep1 from './locales/en/step1.json'
import enStep2 from './locales/en/step2.json'
import enStep3 from './locales/en/step3.json'
import enSettings from './locales/en/settings.json'
import enErrors from './locales/en/errors.json'
import enDonation from './locales/en/donation.json'

i18n.use(initReactI18next).init({
  lng: DEFAULT_LANGUAGE,
  fallbackLng: 'en',
  // REQ-082: 'commands' namespace removed alongside the command palette.
  ns: ['common', 'step1', 'step2', 'step3', 'settings', 'errors', 'donation'],
  defaultNS: 'common',
  resources: {
    ja: {
      common: jaCommon,
      step1: jaStep1,
      step2: jaStep2,
      step3: jaStep3,
      settings: jaSettings,
      errors: jaErrors,
      donation: jaDonation
    },
    en: {
      common: enCommon,
      step1: enStep1,
      step2: enStep2,
      step3: enStep3,
      settings: enSettings,
      errors: enErrors,
      donation: enDonation
    }
  },
  interpolation: {
    escapeValue: false
  }
})

export default i18n
