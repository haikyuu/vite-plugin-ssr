import type { PageFile } from './getPageFiles'
import { assert, assertUsage, hasProp, isPlainObject, objectAssign } from './utils'
import { addComputedUrlProps, PageContextUrlSource } from './addComputedUrlProps'
import { resolvePrecendence, RouteType } from './route/resolvePrecedence'
import { resolveRouteString } from './route/resolveRouteString'
import { resolveFilesystemRoute } from './route/resolveFilesystemRoute'
import { resolveRouteFunction } from './route/resolveRouteFunction'
import { callOnBeforeRouteHook } from './route/callOnBeforeRouteHook'
import { PageRoutes, loadPageRoutes } from './route/loadPageRoutes'
import { isErrorPageId } from './route/error-page'
import { debug } from './route/debug'

export { route, loadPageRoutes }
export type { PageRoutes, PageContextForRoute, RouteMatches }

export { isErrorPageId }
export { getErrorPageId } from './route/error-page'
export { isStaticRouteString } from './route/resolveRouteString'
export { isParameterizedFilesystemRoute } from './route/resolveFilesystemRoute'

type PageContextForRoute = PageContextUrlSource & {
  _pageFilesAll: PageFile[]
  _allPageIds: string[]
}
type RouteMatch = {
  pageId: string
  routeString?: string
  precedence?: number | null
  routeType: RouteType
  routeParams: Record<string, string>
}
type RouteMatches = 'CUSTOM_ROUTE' | RouteMatch[]

async function route(pageContext: PageContextForRoute): Promise<{
  pageContextAddendum: {
    _pageId: string | null
    routeParams: Record<string, string>
    _routingProvidedByOnBeforeRouteHook: boolean
    _routeMatches: RouteMatches
  } & Record<string, unknown>
}> {
  addComputedUrlProps(pageContext)

  const { pageRoutes, onBeforeRouteHook } = await loadPageRoutes(pageContext)
  debug(
    'Pages routes:',
    pageRoutes.map((pageRoute) => ({
      pageId: pageRoute.pageId,
      filesystemRoute: pageRoute.filesystemRoute,
      pageRouteFile: pageRoute.pageRouteFile && {
        filePath: pageRoute.pageRouteFile.filePath,
        routeValue: pageRoute.pageRouteFile.routeValue
      }
    }))
  )

  const pageContextAddendum = {}
  if (onBeforeRouteHook) {
    const pageContextAddendumHook = await callOnBeforeRouteHook(onBeforeRouteHook, pageContext)
    if (pageContextAddendumHook) {
      objectAssign(pageContextAddendum, pageContextAddendumHook)
      if (hasProp(pageContextAddendum, '_pageId', 'string') || hasProp(pageContextAddendum, '_pageId', 'null')) {
        // We bypass `vite-plugin-ssr`'s routing
        if (!hasProp(pageContextAddendum, 'routeParams')) {
          objectAssign(pageContextAddendum, { routeParams: {} })
        } else {
          assert(hasProp(pageContextAddendum, 'routeParams', 'object'))
        }
        objectAssign(pageContextAddendum, {
          _routingProvidedByOnBeforeRouteHook: true,
          _routeMatches: 'CUSTOM_ROUTE' as const
        })
        return { pageContextAddendum }
      }
      // We already assign so that `pageContext.urlOriginal === pageContextAddendum.urlOriginal`; enabling the `onBeforeRoute()` hook to mutate `pageContext.urlOriginal` before routing.
      objectAssign(pageContext, pageContextAddendum)
    }
  }
  objectAssign(pageContextAddendum, {
    _routingProvidedByOnBeforeRouteHook: false
  })

  // `vite-plugin-ssr`'s routing
  const allPageIds = pageContext._allPageIds
  assert(allPageIds.length >= 0)
  assertUsage(
    allPageIds.length > 0,
    'No `*.page.js` file found. You must create a `*.page.js` file, e.g. `pages/index.page.js` (or `pages/index.page.{jsx, tsx, vue, ...}`).'
  )
  const { urlPathname } = pageContext
  assert(urlPathname.startsWith('/'))

  const routeMatches: RouteMatch[] = []
  await Promise.all(
    pageRoutes.map(async (pageRoute): Promise<void> => {
      const { pageId, filesystemRoute, pageRouteFile } = pageRoute

      if (!pageRouteFile) {
        const match = resolveFilesystemRoute(filesystemRoute, urlPathname)
        if (match) {
          const { routeParams } = match
          routeMatches.push({ pageId, routeParams, routeType: 'FILESYSTEM' })
        }
      } else {
        const pageRouteFileExports = pageRouteFile.fileExports
        const pageRouteFilePath = pageRouteFile.filePath

        // Route with Route String defined in `.page.route.js`
        if (hasProp(pageRouteFileExports, 'default', 'string')) {
          const routeString = pageRouteFileExports.default
          assertUsage(
            routeString.startsWith('/'),
            `A Route String should start with a leading \`/\` but \`${pageRouteFilePath}\` has \`export default '${routeString}'\`. Make sure to \`export default '/${routeString}'\` instead.`
          )
          const match = resolveRouteString(routeString, urlPathname)
          if (match) {
            const { routeParams } = match
            routeMatches.push({
              pageId,
              routeString,
              routeParams,
              routeType: 'STRING'
            })
          }
        }

        // Route with Route Function defined in `.page.route.js`
        else if (hasProp(pageRouteFileExports, 'default', 'function')) {
          const match = await resolveRouteFunction(pageRouteFileExports, pageContext, pageRouteFilePath)
          if (match) {
            const { routeParams, precedence } = match
            routeMatches.push({ pageId, precedence, routeParams, routeType: 'FUNCTION' })
          }
        } else {
          assert(false)
        }
      }
    })
  )

  resolvePrecendence(routeMatches)
  const winner = routeMatches[0]

  debug(`Route matches for URL \`${urlPathname}\` (in precedence order):`, routeMatches)

  objectAssign(pageContextAddendum, { _routeMatches: routeMatches })

  if (!winner) {
    objectAssign(pageContextAddendum, {
      _pageId: null,
      routeParams: {}
    })
    return { pageContextAddendum }
  }

  const { pageId, routeParams } = winner
  assert(isPlainObject(routeParams))
  objectAssign(pageContextAddendum, {
    _pageId: pageId,
    routeParams
  })
  return { pageContextAddendum }
}
