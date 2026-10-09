/**
 * Guards for the local HTTP API.
 *
 * This server can file real tax invoices under the user's NTN, which makes it a privileged surface
 * even though it only listens on loopback. "The browser never holds the token" is a weaker
 * guarantee than it sounds: the browser holds the AUTHORITY to use it, so any website open in the
 * same browser could POST to http://127.0.0.1:PORT/api/invoice/submit and file an invoice.
 *
 * Three cheap defences, all of which are expensive to retrofit:
 *
 *   1. A random per-launch secret, required as a header on every /api call. A cross-origin page
 *      cannot read it: the secret is served from an endpoint with no CORS headers, so the
 *      same-origin policy stops the attacker's JavaScript from seeing the response body.
 *   2. An Origin check, so a request that announces a foreign origin is refused outright.
 *   3. A Host check, which is what catches DNS rebinding — there the Host header carries the
 *      attacker's hostname rather than 127.0.0.1.
 *
 * The server also binds explicitly to 127.0.0.1; binding 0.0.0.0 would let the whole network file
 * invoices as the user.
 */

import { randomBytes } from "node:crypto";

export const SESSION_SECRET = randomBytes(32).toString("hex");
export const SESSION_HEADER = "x-fbr-session";

export const LOOPBACK_HOST = "127.0.0.1";

function allowedHosts(port: number): string[] {
  return [`${LOOPBACK_HOST}:${port}`, `localhost:${port}`];
}

function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

/** True when the request really came from our own page on loopback. */
export function isLocalRequest(request: Request, port: number): boolean {
  const host = request.headers.get("host");
  if (!host || !allowedHosts(port).includes(host.toLowerCase())) return false;

  // Origin is absent on same-origin GETs but always present on cross-origin requests.
  const origin = request.headers.get("origin");
  if (origin !== null && !allowedOrigins(port).includes(origin.toLowerCase())) return false;

  return true;
}

export function hasSessionSecret(request: Request): boolean {
  const provided = request.headers.get(SESSION_HEADER);
  // Length check first so the comparison below isn't the thing that leaks the length.
  return provided !== null && provided.length === SESSION_SECRET.length && provided === SESSION_SECRET;
}

export function forbidden(reason: string): Response {
  return Response.json({ error: reason }, { status: 403 });
}
