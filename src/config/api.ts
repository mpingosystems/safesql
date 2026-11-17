// Path for first-party /api/* calls from the browser.
//
// Always same-origin and relative: the app calls the origin that served it, so
// no browser request needs CORS. There is no base-URL override. An earlier
// cross-origin workaround (VITE_API_BASE_URL → *.pages.dev) existed because
// the custom domain showed a bare 502; that came from the zone replacing an
// origin 502/504 response with its own page, not from the request itself
// (docs/502-investigation.md). Functions now never return 502/504.
//
// cli/sameOriginApi.test.ts enforces this: apiUrl() returns a relative
// path, and no browser code builds an absolute /api URL.
export function apiUrl(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}
