import React, { useState } from 'react';

/**
 * The application's tiny history router, extracted from `main.jsx` so the lazily loaded Stage 2
 * and Stage 3 surfaces can link into the guided demo path without importing the entry module and
 * pulling it back into their chunk.
 *
 * It is deliberately small: `pushState` plus a `popstate` listener. There is no route matching
 * beyond exact equality, because MemeVerse has a fixed set of top-level surfaces and a parameter
 * grammar would be capability the product does not use.
 */

export const RouterContext = React.createContext(null);

export function BrowserRouter({ basename = '', children }) {
  const routePath = React.useCallback(() => {
    const withoutBase = basename && window.location.pathname.startsWith(basename)
      ? window.location.pathname.slice(basename.length)
      : window.location.pathname;
    return withoutBase || '/';
  }, [basename]);
  const [pathname, setPathname] = useState(routePath);

  React.useEffect(() => {
    const onPopState = () => setPathname(routePath());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [routePath]);

  function navigate(to) {
    const href = `${basename}${to === '/' ? '/' : to}`;
    window.history.pushState({}, '', href);
    setPathname(to);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }

  return <RouterContext.Provider value={{ basename, pathname, navigate }}>{children}</RouterContext.Provider>;
}

export function NavLink({ to, className = '', children, ...props }) {
  const router = React.useContext(RouterContext);
  const active = router.pathname === to;
  const href = `${router.basename}${to === '/' ? '/' : to}`;

  function onClick(event) {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      router.navigate(to);
    }
  }

  return (
    <a
      href={href}
      className={`${className}${active ? ' active' : ''}`.trim()}
      onClick={onClick}
      {...props}
    >
      {children}
    </a>
  );
}

/**
 * The contextual hand-off at the end of a surface.
 *
 * Every step of the judged demo path ends by naming the next one, so nobody has to return to the
 * homepage to discover where the story continues.
 */
export function NextStep({ to, label, detail }) {
  return (
    <NavLink className="next-step" to={to}>
      <small>NEXT STEP</small>
      <strong>{label}</strong>
      {detail ? <span>{detail}</span> : null}
      <b aria-hidden="true">→</b>
    </NavLink>
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
