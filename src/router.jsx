import React, { useState } from 'react';

/**
 * The application's tiny history router for the Launch and Markets surfaces.
 * It keeps navigation independent of the larger app entry module.
 *
 * It is deliberately small: `pushState` plus a `popstate` listener. There is no route matching
 * beyond exact equality, because MemeVerse has a fixed set of top-level surfaces and a parameter
 * grammar would be capability the product does not use.
 */

export const RouterContext = React.createContext(null);

export function BrowserRouter({ basename = '', children }) {
  const routePath = React.useCallback(() => {
    const withoutBase = basename && (window.location.pathname === basename || window.location.pathname.startsWith(`${basename}/`))
      ? window.location.pathname.slice(basename.length)
      : window.location.pathname;
    return withoutBase.replace(/\/+$/, '') || '/';
  }, [basename]);
  const [pathname, setPathname] = useState(routePath);

  React.useEffect(() => {
    const onPopState = () => setPathname(routePath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [routePath]);

  function navigate(to) {
    const href = `${basename}${to === '/' ? '/' : to}`;
    if (window.location.pathname === href && !window.location.search && !window.location.hash) return;
    window.history.pushState({}, '', href);
    setPathname(to);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }

  return <RouterContext.Provider value={{ basename, pathname, navigate }}>{children}</RouterContext.Provider>;
}

export function NavLink({ to, className = '', children, onClick: handleClick, ...props }) {
  const router = React.useContext(RouterContext);
  const active = router.pathname === to;
  const href = `${router.basename}${to === '/' ? '/' : to}`;

  function onClick(event) {
    handleClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !props.download && (!props.target || props.target === '_self')) {
      event.preventDefault();
      router.navigate(to);
    }
  }

  return (
    <a
      href={href}
      className={`${className}${active ? ' active' : ''}`.trim()}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      {...props}
    >
      {children}
    </a>
  );
}

export function Route() {
  return null;
}

/**
 * Renders the matching route, or `notFound` when nothing matches.
 *
 * The fallback is not optional in practice. Hosting this application requires SPA history
 * fallback, so the edge answers *every* path under the base with `index.html` — which means a
 * mistyped URL reaches the browser as a successful page load. Without a not-found element that
 * would render an empty document under a working header, which is exactly the blank panel every
 * other surface here goes out of its way to avoid.
 */
export function Routes({ children, notFound = null }) {
  const { pathname } = React.useContext(RouterContext);
  const route = React.Children.toArray(children).find((child) => child.props.path === pathname);
  return route?.props.element ?? notFound;
}
