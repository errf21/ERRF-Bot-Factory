import { AppError, assert, integer, text } from "./core";
import type { Client, Inbound } from "./adapters/panel";
export interface TransportInbound extends Inbound {
  port: number;
  streamSettings: string;
}
export interface ConnectionOptions {
  connection_host?: string;
  connection_port?: number;
  reality_public_key?: string;
}
// Export only verified, explicitly supported transports. No guessed public addresses.
export function connectionURI(
  inbound: TransportInbound,
  client: Client,
  options: ConnectionOptions,
): string {
  assert(options.connection_host, "CONNECTION_HOST_UNCONFIGURED");
  const host = text(options.connection_host, 253);
  assert(
    /^[a-zA-Z0-9.-]+$/.test(host) && !host.includes(".."),
    "INVALID_CONNECTION_HOST",
  );
  const port = integer(options.connection_port ?? inbound.port, 1, 65535);
  let s: Record<string, any>;
  try {
    s = JSON.parse(inbound.streamSettings);
  } catch {
    throw new AppError("CONNECTION_FORMAT_UNSUPPORTED");
  }
  const network = s.network ?? "tcp",
    security = s.security ?? "none";
  assert(
    ["tcp", "ws", "grpc"].includes(network),
    "CONNECTION_TRANSPORT_UNSUPPORTED",
  );
  assert(
    ["none", "tls", "reality"].includes(security),
    "CONNECTION_SECURITY_UNSUPPORTED",
  );
  const q = new URLSearchParams({ type: network, security });
  if (network === "tcp") {
    assert(
      !s.tcpSettings?.header?.type || s.tcpSettings.header.type === "none",
      "CONNECTION_TRANSPORT_UNSUPPORTED",
    );
    q.set("headerType", "none");
  }
  if (network === "ws") {
    q.set("path", s.wsSettings?.path ?? "/");
    if (s.wsSettings?.headers?.Host) q.set("host", s.wsSettings.headers.Host);
  }
  if (network === "grpc") {
    q.set("serviceName", s.grpcSettings?.serviceName ?? "");
    q.set("mode", s.grpcSettings?.multiMode ? "multi" : "gun");
  }
  if (security === "tls") {
    const tls = s.tlsSettings ?? {};
    q.set("sni", tls.serverName || host);
    if (tls.alpn?.length) q.set("alpn", tls.alpn.join(","));
  }
  if (security === "reality") {
    const r = s.realitySettings ?? {},
      pk = options.reality_public_key ?? r.settings?.publicKey;
    assert(
      typeof pk === "string" && /^[A-Za-z0-9_-]{43}$/.test(pk),
      "REALITY_PUBLIC_KEY_UNCONFIGURED",
    );
    assert(r.serverNames?.length, "CONNECTION_FORMAT_UNSUPPORTED");
    q.set("pbk", pk);
    q.set("sni", r.serverNames[0]);
    q.set("sid", r.shortIds?.[0] ?? "");
    q.set("fp", "chrome");
  }
  if (inbound.protocol === "vless") {
    q.set("encryption", "none");
    if (client.flow) q.set("flow", client.flow);
    return `vless://${encodeURIComponent(client.id)}@${host}:${port}?${q}#${encodeURIComponent(inbound.remark || client.email)}`;
  }
  assert(
    inbound.protocol === "vmess" &&
      security !== "reality" &&
      network !== "grpc",
    "CONNECTION_FORMAT_UNSUPPORTED",
  );
  const vmess = {
    v: "2",
    ps: inbound.remark || client.email,
    add: host,
    port: String(port),
    id: client.id,
    aid: "0",
    scy: "auto",
    net: network,
    type: "none",
    host: q.get("host") ?? "",
    path: q.get("path") ?? "",
    tls: security === "tls" ? "tls" : "",
    sni: q.get("sni") ?? "",
    alpn: q.get("alpn") ?? "",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(vmess));
  return `vmess://${btoa(String.fromCharCode(...bytes))}`;
}
