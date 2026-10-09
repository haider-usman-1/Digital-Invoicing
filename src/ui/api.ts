/**
 * Browser-side API client.
 *
 * Every /api call carries the per-launch session key. The key itself is fetched once from
 * /api/session, which another site can request but cannot read — no CORS headers are sent, so the
 * same-origin policy keeps the response body out of reach. See src/server/security.ts.
 */

export interface Session {
  secret: string;
  header: string;
  mock: boolean;
  /** Today's date in Pakistan, YYYY-MM-DD. */
  today: string;
  dataDir: string;
}

let session: Session | null = null;

export async function initSession(): Promise<Session> {
  const response = await fetch("/api/session");
  if (!response.ok) throw new Error("Couldn't start a session with the local server.");
  session = (await response.json()) as Session;
  return session;
}

export function currentSession(): Session {
  if (!session) throw new Error("Session not started.");
  return session;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { header, secret } = currentSession();

  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
      [header]: secret,
    },
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`The local server replied with something unexpected: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = (body as { error?: string }).error;
    throw new Error(message ?? `Request failed (${response.status}).`);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body?: unknown) =>
    call<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  delete: <T>(path: string) => call<T>(path, { method: "DELETE" }),
};
