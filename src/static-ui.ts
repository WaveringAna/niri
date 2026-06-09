export const WEB_UI_CACHE_CONTROL = "no-store, max-age=0, must-revalidate"

export function setWebUiCacheHeaders(res: { setHeader(name: string, value: string): unknown }) {
  res.setHeader("cache-control", WEB_UI_CACHE_CONTROL)
  res.setHeader("pragma", "no-cache")
  res.setHeader("expires", "0")
}
