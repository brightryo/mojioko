export const APP_NAME = 'MOJIOKO'
export const APP_VERSION = '1.0.0'

/** Human-readable display string shown in title bar and About dialog. */
export const APP_DISPLAY = `${APP_NAME} ${APP_VERSION}`

/** Folder name under %APPDATA% for user settings, logs, and cached models. */
export const APP_DATA_FOLDER = APP_NAME

/**
 * GitHub repository coordinates used to build every github.com / api.github.com
 * URL the app references.  Single source of truth — change here when the repo
 * is renamed or migrated and the rest of the URLs update automatically.
 *
 * Casing is intentionally lowercase: GitHub itself accepts mixed-case in
 * browser URLs but normalises lowercase in the API.  Keeping the constants
 * lowercase avoids drift between docs and code.
 */
export const GITHUB_OWNER = 'brightryo'
export const GITHUB_REPO = 'mojioko'

/** Repository landing page. */
export const GITHUB_REPO_URL =
  `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

/** Issues tracker. */
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`

/**
 * Public distribution / download landing page, served from GitHub Pages.
 *
 * The Help → "Open Download Page" menu item opens this URL in the user's
 * default browser; there is no in-app version comparison.  This avoids the
 * authentication burden of querying a (private) source repo through the
 * GitHub REST API.
 */
export const GITHUB_PAGES_URL =
  `https://${GITHUB_OWNER}.github.io/${GITHUB_REPO}/`

/** External URLs. Update once real pages exist. */
export const DOCUMENTATION_URLS = {
  userGuide: `${GITHUB_REPO_URL}#usage`,
  obsSetup: `${GITHUB_REPO_URL}#obs-setup`,
  /** @deprecated kept for fallback; individual donation URLs are preferred */
  donations: `https://github.com/sponsors/${GITHUB_OWNER}`,
  donationBooth: `https://${GITHUB_OWNER}.booth.pm/items/8414334`,
  donationBuyMeACoffee: `https://buymeacoffee.com/${GITHUB_OWNER}g`,
  donationGitHub: `https://github.com/sponsors/${GITHUB_OWNER}`,
} as const

/** URL whitelisted for shell.openExternal. Add others here as needed. */
export const ALLOWED_EXTERNAL_URLS: readonly string[] = [
  DOCUMENTATION_URLS.userGuide,
  DOCUMENTATION_URLS.obsSetup,
  DOCUMENTATION_URLS.donations,
  DOCUMENTATION_URLS.donationBooth,
  DOCUMENTATION_URLS.donationBuyMeACoffee,
  DOCUMENTATION_URLS.donationGitHub,
  GITHUB_REPO_URL,
  GITHUB_ISSUES_URL,
  GITHUB_PAGES_URL,
]

/** Locale codes supported by the app. The Settings dialog discovers them from this list. */
export const SUPPORTED_LANGUAGES = ['ja', 'en'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en'
