import type { Env, Panel, Service } from "../types";
import { AppError, assert, integer } from "../core";
import { open } from "../crypto";
import {
  connectionURI,
  type ConnectionOptions,
  type TransportInbound,
} from "../connections";
export interface Client {
  id: string;
  email: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  subId?: string;
  flow?: string;
  [key: string]: unknown;
}
export interface Inbound {
  id: number;
  remark: string;
  protocol: string;
  enable: boolean;
  settings: string;
}
export interface Usage {
  up: number;
  down: number;
  total: number;
  expiryTime: number;
  enable: boolean;
}
export interface PanelAdapter {
  list(): Promise<Inbound[]>;
  find(service: Service): Promise<Client | null>;
  create(service: Service): Promise<void>;
  update(service: Service, client: Client): Promise<void>;
  revoke(service: Service): Promise<void>;
  usage(email: string): Promise<Usage>;
  connection(service: Service): Promise<string>;
}
export function validatePanelURL(env: Env, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("INVALID_PANEL_URL");
  }
  const hosts = env.PANEL_ALLOWED_HOSTS.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443"),
    "INVALID_PANEL_URL",
  );
  assert(
    /^[a-z0-9.-]+$/.test(url.hostname) &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) &&
      !url.hostname.endsWith(".localhost") &&
      url.hostname !== "localhost" &&
      hosts.includes(url.hostname),
    "PANEL_HOST_NOT_ALLOWED",
  );
  url.pathname = url.pathname.replace(/\/*$/, "/");
  return url;
}
class Sanaei implements PanelAdapter {
  private cookie = "";
  constructor(
    private url: URL,
    private credentials: {
      username: string;
      password: string;
    } & ConnectionOptions,
  ) {}
  private async request<T>(
    path: string,
    data?: Record<string, unknown>,
    login = false,
  ): Promise<T> {
    if (!login && !this.cookie) await this.authenticate();
    let response: Response;
    try {
      response = await fetch(new URL(this.url.href + path), {
        method: data ? "POST" : "GET",
        headers: {
          ...(data
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {}),
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        body: data
          ? new URLSearchParams(
              Object.entries(data).map(([k, v]) => [k, String(v)]),
            )
          : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new AppError("PANEL_NETWORK_UNCERTAIN", 502);
    }
    if (response.status >= 300 && response.status < 400)
      throw new AppError("PANEL_REDIRECT_DENIED", 502);
    if (response.status === 401 || response.status === 403)
      throw new AppError("PANEL_AUTH_FAILED", 502);
    if (!response.ok) throw new AppError("PANEL_HTTP_ERROR", 502);
    let body: { success: boolean; obj: T };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new AppError("PANEL_API_INCOMPATIBLE", 502);
    }
    if (body.success !== true)
      throw new AppError(login ? "PANEL_AUTH_FAILED" : "PANEL_REJECTED", 502);
    if (login) {
      const cookies = response.headers.getSetCookie();
      this.cookie = cookies.map((c) => c.split(";")[0]).join("; ");
      assert(this.cookie, "PANEL_AUTH_FAILED");
    }
    return body.obj;
  }
  private async authenticate() {
    await this.request(
      "login",
      {
        username: this.credentials.username,
        password: this.credentials.password,
      },
      true,
    );
  }
  async list(): Promise<Inbound[]> {
    const v = await this.request<Inbound[]>("panel/api/inbounds/list");
    assert(Array.isArray(v), "PANEL_API_INCOMPATIBLE");
    return v.filter(
      (i) =>
        i.enable &&
        ["vless", "vmess"].includes(i.protocol) &&
        Number.isSafeInteger(i.id) &&
        typeof i.settings === "string",
    );
  }
  async find(s: Service): Promise<Client | null> {
    const inbound = (await this.list()).find((i) => i.id === s.inbound_id);
    assert(inbound, "INBOUND_UNAVAILABLE");
    let settings: { clients: Client[] };
    try {
      settings = JSON.parse(inbound.settings) as typeof settings;
    } catch {
      throw new AppError("PANEL_API_INCOMPATIBLE");
    }
    assert(Array.isArray(settings.clients), "PANEL_API_INCOMPATIBLE");
    const found = settings.clients.find(
      (c) => c.id === s.client_id || c.email === s.email,
    );
    if (found)
      assert(
        found.id === s.client_id && found.email === s.email,
        "PANEL_CLIENT_CONFLICT",
      );
    return found ?? null;
  }
  async create(s: Service) {
    await this.request("panel/api/inbounds/addClient", {
      id: s.inbound_id,
      settings: JSON.stringify({
        clients: [
          {
            id: s.client_id,
            email: s.email,
            enable: true,
            totalGB: s.bytes,
            expiryTime: s.expires_at * 1000,
            limitIp: 0,
            tgId: "",
            subId: s.client_id.replace(/-/g, ""),
            reset: 0,
            flow: "",
          },
        ],
      }),
    });
  }
  async update(s: Service, client: Client) {
    await this.request(
      `panel/api/inbounds/updateClient/${encodeURIComponent(s.client_id)}`,
      { id: s.inbound_id, settings: JSON.stringify({ clients: [client] }) },
    );
  }
  async revoke(s: Service) {
    await this.request(
      `panel/api/inbounds/${s.inbound_id}/delClient/${encodeURIComponent(s.client_id)}`,
      {},
    );
  }
  async connection(service: Service) {
    const inbound = (await this.list()).find(
      (i) => i.id === service.inbound_id,
    );
    assert(inbound, "INBOUND_UNAVAILABLE");
    const client = JSON.parse(inbound.settings).clients.find(
      (c: Client) => c.id === service.client_id && c.email === service.email,
    ) as Client | undefined;
    assert(client, "SERVICE_MISSING_REMOTE");
    return connectionURI(inbound as TransportInbound, client, this.credentials);
  }
  async usage(email: string) {
    const v = await this.request<Usage>(
      `panel/api/inbounds/getClientTraffics/${encodeURIComponent(email)}`,
    );
    assert(v && typeof v === "object", "USAGE_UNAVAILABLE");
    integer(v.up, 0);
    integer(v.down, 0);
    integer(v.total, 0);
    integer(v.expiryTime, 0);
    assert(typeof v.enable === "boolean", "PANEL_API_INCOMPATIBLE");
    return v;
  }
}
export async function adapter(env: Env, panel: Panel): Promise<PanelAdapter> {
  assert(panel.adapter === "sanaei-2.8", "UNSUPPORTED_PANEL");
  const url = validatePanelURL(
    env,
    await open(env, panel.url_enc, `panel:${panel.bot_id}:${panel.id}:url`),
  );
  const credentials = JSON.parse(
    await open(
      env,
      panel.credentials_enc,
      `panel:${panel.bot_id}:${panel.id}:credentials`,
    ),
  ) as { username: string; password: string } & ConnectionOptions;
  return new Sanaei(url, credentials);
}
