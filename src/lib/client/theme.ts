export type Theme = "light" | "dark";

export const THEME_KEY = "haat-theme";
const THEME_EVENT = "haat-theme-change";
const THEME_COLOURS = { light: "#f6f3ee", dark: "#1c1b19" } as const;

/** Runs synchronously before paint. An explicit choice wins; a new visitor always gets light. */
export const THEME_SCRIPT = `(()=>{let t="light";try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="dark")t="dark"}catch{}document.documentElement.dataset.theme=t;const m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="dark"?${JSON.stringify(THEME_COLOURS.dark)}:${JSON.stringify(THEME_COLOURS.light)})})()`;

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOURS[theme]);
}

export function isDarkTheme() {
  return document.documentElement.dataset.theme === "dark";
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  // A blocked/full storage must not prevent switching for the current page session.
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Keeps controls and other open tabs in sync, without making the root layout dynamic. */
export function subscribeToTheme(onChange: () => void) {
  // Metadata may be streamed after the early script; sync the browser chrome once mounted.
  applyTheme(isDarkTheme() ? "dark" : "light");
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== null && event.storageArea !== localStorage) return;
    } catch { return; }
    applyTheme(event.newValue === "dark" ? "dark" : "light");
    onChange();
  };
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
