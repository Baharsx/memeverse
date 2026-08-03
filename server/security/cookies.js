export const OPERATOR_SESSION_COOKIE = 'memeverse_operator_session';

export function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

export function serializeCookie(name, value, {
  maxAgeSeconds,
  secure = false,
  path = '/',
  sameSite = 'Strict',
  httpOnly = true,
} = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) attributes.push('HttpOnly');
  if (secure) attributes.push('Secure');
  if (maxAgeSeconds !== undefined) attributes.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  return attributes.join('; ');
}
