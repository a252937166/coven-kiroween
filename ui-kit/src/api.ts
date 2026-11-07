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
  /** Node only: keep the session cookie ourselves. Browsers use their cookie store. */
  cookieJar?: boolean;
}

export class Api {
  readonly base: string;
  readonly app: string;
  private cookie: string | undefined;
  private readonly jar: boolean;

  constructor(opts: ApiOptions) {
    this.base = opts.base ?? "";
    this.app = opts.app;
    this.jar = opts.cookieJar ?? false;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "X-Coven-App": this.app, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.jar && this.cookie) headers.Cookie = this.cookie;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (this.jar) {
      const set = res.headers.get("set-cookie");
      if (set) this.cookie = set.split(";")[0];
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
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
