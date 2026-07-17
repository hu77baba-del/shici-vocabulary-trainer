export const ROUTE_VIEWS = Object.freeze([
  "home",
  "growth",
  "import",
  "library",
  "review",
  "settings",
  "study"
]);

const ROUTE_SET = new Set(ROUTE_VIEWS);
export const HISTORY_MARKER = "shici-navigation-v1";

export function normalizeRoute(value) {
  return ROUTE_SET.has(value) ? value : "home";
}

export function routeFromHash(hash) {
  return normalizeRoute(String(hash || "").replace(/^#/, ""));
}

export function routeUrl(view) {
  return `#${normalizeRoute(view)}`;
}

export function makeHistoryState(view, guard = false) {
  return { marker: HISTORY_MARKER, view: normalizeRoute(view), guard: guard === true };
}

export function isAppHistoryState(state) {
  return state?.marker === HISTORY_MARKER;
}
