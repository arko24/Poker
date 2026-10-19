// Telegram WebApp SDK wrapper (CLIENT-ONLY). Loads window.Telegram.WebApp,
// applies the Telegram theme params as CSS variables, and exposes initData
// retrieval plus ready()/expand(). This module never imports any server-only
// code and holds no secrets — identity is proven server-side from initData.
//
// The telegram-web-app.js script is loaded via a <script> tag in layout.tsx;
// here we only read the global it defines.

/** Minimal shape of the Telegram WebApp object we depend on. */
interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  [key: string]: string | undefined;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id?: number; username?: string; first_name?: string } };
  themeParams?: TelegramThemeParams;
  colorScheme?: "light" | "dark";
  ready: () => void;
  expand: () => void;
  onEvent?: (event: string, handler: () => void) => void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

function getWebApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

/**
 * Apply the Telegram theme params as CSS custom properties on :root so the
 * CSS Modules can theme off them (with sensible fallbacks in the stylesheets).
 */
function applyTheme(app: TelegramWebApp): void {
  if (typeof document === "undefined") return;
  const params = app.themeParams ?? {};
  const root = document.documentElement;
  const map: Record<string, string | undefined> = {
    "--tg-bg-color": params.bg_color,
    "--tg-text-color": params.text_color,
    "--tg-hint-color": params.hint_color,
    "--tg-link-color": params.link_color,
    "--tg-button-color": params.button_color,
    "--tg-button-text-color": params.button_text_color,
    "--tg-secondary-bg-color": params.secondary_bg_color,
  };
  for (const [key, value] of Object.entries(map)) {
    if (value) root.style.setProperty(key, value);
  }
  if (app.colorScheme) root.setAttribute("data-tg-color-scheme", app.colorScheme);
}

/**
 * Call once on mount. Signals readiness to Telegram, expands the viewport, and
 * applies the theme. Safe no-op when not running inside Telegram (e.g. a plain
 * browser during development).
 */
export function initTelegram(): void {
  const app = getWebApp();
  if (!app) return;
  try {
    app.ready();
    app.expand();
    applyTheme(app);
    app.onEvent?.("themeChanged", () => applyTheme(app));
  } catch {
    // Never let SDK quirks crash the shell; the app still works via polling.
  }
}

/**
 * Freshly read initData string for POST /api/auth. Read fresh on every (re)auth
 * so a long-backgrounded app gets the latest value. Empty string when not
 * running inside Telegram.
 *
 * DEV BYPASS: when NOT inside Telegram and NEXT_PUBLIC_ALLOW_DEV_AUTH="true",
 * return a sentinel "dev:<id>" string so the app can authenticate in a plain
 * browser for testing. The server still only honors this if its own
 * ALLOW_DEV_AUTH="true" flag is set, so this is safe to ship — a production
 * deployment without ALLOW_DEV_AUTH rejects it. The id can be overridden with
 * ?dev=2 in the URL to simulate a second player in another tab.
 */
export function getInitData(): string {
  const real = getWebApp()?.initData ?? "";
  if (real.length > 0) return real;

  if (
    typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_ALLOW_DEV_AUTH === "true"
  ) {
    let id = "1";
    if (typeof window !== "undefined") {
      const fromUrl = new URLSearchParams(window.location.search).get("dev");
      if (fromUrl && /^\d+$/.test(fromUrl)) id = fromUrl;
    }
    return `dev:${id}`;
  }
  return "";
}

/** True when running inside the Telegram WebApp container. */
export function isTelegramEnvironment(): boolean {
  return getInitData().length > 0;
}
