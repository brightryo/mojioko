// REQ-0379 — minimal react-i18next stand-in for the pixel harness, so the real
// panel renders without a full i18n runtime.  Returns the key as the string.
import React from 'react'

export function useTranslation() {
  return { t: (k: string) => k, i18n: { language: 'en', changeLanguage: () => Promise.resolve() } }
}
export function Trans({ children }: { children?: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children)
}
export function initReactI18next() {}
export default { useTranslation, Trans }
