// Thin JSON client for the Coven service. Never logs request or response bodies.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `HTTP ${status}`));
    this.name = "ApiError";
    this.status = status;
    this.code = String(body.error ?? "error");
    this.body = body;
  }
}

export interface ApiOptions {
  base?: string;
  app: "break-glass" | "last-light";
  /** Node only: keep the cookies ourselves. Browsers use their cookie store. */
  cookieJar?: boolean;
}

export class Api {
  readonly base: string;
  readonly app: string;
  private readonly cookies = new Map<string, string>();
  private readonly jar: boolean;

  constructor(opts: ApiOptions) {
    this.base = opts.base ?? "";
    this.app = opts.app;
    this.jar = opts.cookieJar ?? false;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "X-Coven-App": this.app, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.jar && this.cookies.size > 0) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (this.jar) this.keepCookies(res.headers);
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  /** Node only: name to value; a cookie the service expires is dropped. A hosted service sets two. */
  private keepCookies(h: Headers) {
    const all = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [h.get("set-cookie") ?? ""];
    for (const line of all) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = value === "" || value === '""' || attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }

  async signIn(user: string): Promise<{ user: string; name: string; role: string }> {
    return this.post("/api/session", { user });
  }
}
