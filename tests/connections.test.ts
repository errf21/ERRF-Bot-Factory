import { expect, it } from "vitest";
import { connectionURI, type TransportInbound } from "../src/connections";
const inbound: TransportInbound = {
  id: 1,
  remark: "سرویس ERRF",
  protocol: "vless",
  enable: true,
  settings: "{}",
  port: 443,
  streamSettings: JSON.stringify({
    network: "ws",
    security: "tls",
    wsSettings: { path: "/x", headers: { Host: "cdn.example" } },
    tlsSettings: { serverName: "edge.example", alpn: ["h2", "http/1.1"] },
  }),
};
const client = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "service",
  totalGB: 1,
  expiryTime: 1,
  enable: true,
};
it("exports actual VLESS client, port, transport and TLS settings", () => {
  const uri = connectionURI(inbound, client, {
    connection_host: "edge.example",
  });
  const u = new URL(uri);
  expect(u.username).toBe(client.id);
  expect(u.port).toBe("443");
  expect(u.searchParams.get("path")).toBe("/x");
  expect(u.searchParams.get("sni")).toBe("edge.example");
  expect(u.searchParams.get("host")).toBe("cdn.example");
});
it("does not guess a public connection host", () => {
  expect(() => connectionURI(inbound, client, {})).toThrow(
    "CONNECTION_HOST_UNCONFIGURED",
  );
});
it("exports VMess JSON with UTF-8 remarks", () => {
  const uri = connectionURI({ ...inbound, protocol: "vmess" }, client, {
    connection_host: "edge.example",
  });
  const data = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(uri.slice(8)), (x) => x.charCodeAt(0)),
    ),
  );
  expect(data.ps).toBe(inbound.remark);
  expect(data.id).toBe(client.id);
});
it("rejects unsupported transport instead of fabricating URI", () => {
  expect(() =>
    connectionURI(
      { ...inbound, streamSettings: '{"network":"quic"}' },
      client,
      { connection_host: "edge.example" },
    ),
  ).toThrow("CONNECTION_TRANSPORT_UNSUPPORTED");
});
it("does not derive reality public key from a secret private key", () => {
  expect(() =>
    connectionURI(
      {
        ...inbound,
        streamSettings: JSON.stringify({
          network: "tcp",
          security: "reality",
          realitySettings: {
            privateKey: "secret",
            serverNames: ["edge.example"],
          },
        }),
      },
      client,
      { connection_host: "edge.example" },
    ),
  ).toThrow("REALITY_PUBLIC_KEY_UNCONFIGURED");
});
