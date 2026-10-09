export const testAppOrigin = 'http://127.0.0.1:5173';

export function originHeaders(extra = {}) {
  return { 'content-type': 'application/json', origin: testAppOrigin, ...extra };
}
