/// <reference types="vite/client" />

/**
 * Every value this site reads from the environment.
 *
 * Declared so a typo in a variable name is a compile error rather than a
 * silently missing link — which on a page whose entire job is links is the
 * failure worth catching early.
 */
interface ImportMetaEnv {
  readonly VITE_CLIENT_PORTAL_URL?: string;
  readonly VITE_ADMIN_DASHBOARD_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_GITHUB_URL?: string;
  readonly VITE_CONTACT_URL?: string;
  readonly VITE_LINKEDIN_URL?: string;
  readonly VITE_X_URL?: string;
  readonly VITE_APK_URL?: string;
  readonly VITE_APK_VERSION?: string;
  readonly VITE_APK_BUILD?: string;
  readonly VITE_APK_SIZE?: string;
  readonly VITE_APK_RELEASE_DATE?: string;
  readonly VITE_APK_MIN_ANDROID?: string;
  readonly VITE_APK_CHANGELOG?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_DATE?: string;
  readonly VITE_COMPANY_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
