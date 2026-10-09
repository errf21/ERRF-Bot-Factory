import { afterAll, expect, it } from "vitest";

import { fixture, seed, IDs, update } from "./helpers";
import { one, run } from "../src/core";
import type { SalesOrder } from "../src/commerce";
import type { Service } from "../src/types";
let f: Awaited<ReturnType<typeof fixture>> | undefined;
afterAll(async () => {
  await f?.mf.dispose();
});
it("real Worker HTTP webhook -> durable inbox -> receipt -> manual approval -> panel -> customer delivery", async () => {
  const requests: { method: string; payload: Record<string, unknown> }[] = [];
  let remoteClients: Record<string, unknown>[] = [];
  let creates = 0;
  f = await fixture({
    unsafeTriggerHandlers: true,
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.telegram.org") {
        const payload = (await request.json()) as Record<string, unknown>;
        requests.push({ method: url.pathname.split("/").at(-1)!, payload });
        return new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.hostname === "panel.example") {
        if (url.pathname.endsWith("/login"))
          return new Response('{"success":true,"obj":null}', {
            headers: {
              "content-type": "application/json",
              "set-cookie": "session=e2e; Secure",
            },
          });
        if (url.pathname.endsWith("/list"))
          return new Response(
            JSON.stringify({
              success: true,
              obj: [
                {
                  id: 1,
                  enable: true,
                  protocol: "vless",
                  remark: "E2E real local runtime target",
                  port: 443,
                  streamSettings: '{"network":"tcp","security":"tls"}',
                  settings: JSON.stringify({ clients: remoteClients }),
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        if (url.pathname.endsWith("/addClient")) {
          const body = new URLSearchParams(await request.text());
          remoteClients = JSON.parse(body.get("settings")!).clients;
          creates++;
          return new Response('{"success":true,"obj":null}', {
            headers: { "content-type": "application/json" },
          });
        }
      }
      throw new Error(
        "Unexpected external request in isolated end-to-end test",
      );
    },
  });
  await seed(f.env);
  await run(f.env, "UPDATE plans SET price_minor=10000 WHERE id=?", IDs.plan1);
  let next = 1;
  const poll = async <T>(
    fn: () => Promise<T>,
    valid: (value: T) => boolean,
  ) => {
    for (let i = 0; i < 150; i++) {
      const value = await fn();
      if (valid(value)) return value;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error("Timed out waiting for local durable workflow");
  };
  async function send(user: number, text: string, photo = false) {
    const seq = next++;
    const body = photo
      ? {
          ...update(user, "", seq),
          message: {
            ...update(user, "").message,
            caption: text,
            photo: [
              {
                file_id: "E2E-TEST-ONLY-IMAGE",
                file_unique_id: "E2E-UNIQUE",
                width: 400,
                height: 600,
                file_size: 2000,
              },
            ],
          },
        }
      : update(user, text, seq);
    const r = await f!.mf.dispatchFetch(
      `https://factory.example/telegram/${IDs.b1}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": `secret-${IDs.b1}`,
        },
        body: JSON.stringify(body),
      },
    );
    expect(r.status).toBe(200);
    await poll(
      () =>
        one<{ state: string; error_code: string | null }>(
          f!.env,
          "SELECT state,error_code FROM webhook_updates WHERE route=? AND update_id=?",
          IDs.b1,
          seq,
        ),
      (x) => !!x && ["DONE", "DEAD"].includes(x.state),
    ).then((x) => expect(x!.state, JSON.stringify(x)).toBe("DONE"));
    return seq;
  }
  await send(
    100,
    '/bank_set {"card_number":"1111222233334444","recipient_name":"FAKE TEST recipient","instructions":"ارسال تصویر رسید","enabled":true}',
  );
  await send(
    100,
    `/panel_edit {"id":"${IDs.p1}","connection_host":"edge.example"}`,
  );
  await send(300, `/plan ${IDs.plan1}`);
  await poll(
    async () =>
      requests.find(
        (x) =>
          x.payload.chat_id === 300 &&
          (
            x.payload.reply_markup as any
          )?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("/checkout"),
      ),
    (x) => !!x,
  );
  const product = requests.find(
    (x) =>
      x.payload.chat_id === 300 &&
      (
        x.payload.reply_markup as any
      )?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("/checkout"),
  )!;
  await send(
    300,
    (product.payload.reply_markup as any).inline_keyboard[0][0].callback_data,
  );
  const o = (await one<SalesOrder>(f.env, "SELECT * FROM orders"))!;
  expect(o.payment_state).toBe("AWAITING_RECEIPT");
  expect(await one(f.env, "SELECT id FROM services")).toBe(null);
  await send(300, `/receipt ${o.id}`, true);
  expect(
    (await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.payment_state,
  ).toBe("UNDER_REVIEW");
  expect(await one(f.env, "SELECT id FROM payments")).toBe(null);
  const rid = (await one<{ id: string }>(
    f.env,
    "SELECT id FROM manual_reviews",
  ))!.id;
  await send(100, `/confirm_pay ${rid}`);
  await poll(
    () => one<Service>(f!.env, "SELECT * FROM services"),
    (x) => x?.state === "ACTIVE",
  );
  const tick = await f.mf.dispatchFetch(
    "https://factory.example/cdn-cgi/local/scheduled",
  );
  expect(tick.status).toBe(200);
  await poll(
    async () =>
      requests.some(
        (x) =>
          x.payload.chat_id === 300 &&
          String(x.payload.text).includes("سرویس آماده"),
      ),
    (x) => x,
  );
  const active = (await one<Service>(f.env, "SELECT * FROM services"))!;
  await send(300, `/connect ${active.id}`);
  await poll(
    async () =>
      requests.some(
        (x) =>
          x.payload.chat_id === 300 &&
          String(x.payload.text).startsWith("vless://"),
      ),
    (x) => x,
  );
  expect(creates).toBe(1);
  expect((await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.state).toBe(
    "FULFILLED",
  );
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM payments"))!.n,
  ).toBe(1);
  expect(
    requests.some(
      (x) =>
        x.method === "sendPhoto" &&
        x.payload.chat_id === 100 &&
        x.payload.protect_content === true,
    ),
  ).toBe(true);
  // The same approval update via a NEW Telegram update ID is still financially idempotent.
  await send(100, `/confirm_pay ${rid}`);
  expect(creates).toBe(1);
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM services"))!.n,
  ).toBe(1);
}, 30000);
