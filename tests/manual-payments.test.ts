import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  fixture,
  reset,
  seed,
  IDs,
  update,
  telegramResponse,
  getPanel,
} from "./helpers";
import {
  setCard,
  createOrder,
  offer,
  checkout,
  beginReceipt,
  submitEvidence,
  decide,
  orderView,
  reviewView,
  reviewQueue,
  reasonMessage,
  type SalesOrder,
} from "../src/commerce";
import { handle } from "../src/commands";
import { one, rows, run } from "../src/core";
import { seal, open } from "../src/crypto";
import { processOperations } from "../src/operations";
import { deliver } from "../src/delivery";
import type { Client } from "../src/adapters/panel";
import type { Service, Env } from "../src/types";
let f: Awaited<ReturnType<typeof fixture>>;
let clients: Client[];
let created: number;
let uncertain: boolean;
let hostCalls: string[];
let telegramCalls: { method: string; body: Record<string, unknown> }[];
const fakeCard = {
  card_number: "1111222233334444",
  recipient_name: "Test recipient — not a real account",
  instructions: "مبلغ سفارش را واریز و فقط تصویر رسید را ارسال کنید.",
  enabled: true,
};
beforeAll(async () => {
  f = await fixture();
});
beforeEach(async () => {
  await reset(f.env);
  await seed(f.env);
  clients = [];
  created = 0;
  uncertain = false;
  hostCalls = [];
  telegramCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.hostname === "api.telegram.org") {
        telegramCalls.push({
          method: u.pathname.split("/").at(-1)!,
          body: JSON.parse(String(init?.body)),
        });
        return telegramResponse();
      }
      hostCalls.push(u.hostname);
      if (u.pathname.endsWith("/login"))
        return new Response(JSON.stringify({ success: true, obj: null }), {
          headers: { "set-cookie": "session=test; Secure" },
        });
      let obj: unknown = null;
      if (u.pathname.endsWith("/list"))
        obj = [
          {
            id: 1,
            enable: true,
            protocol: "vless",
            remark: "Live fixture inbound",
            port: 443,
            streamSettings:
              '{"network":"tcp","security":"tls","tlsSettings":{"serverName":"edge.example"}}',
            settings: JSON.stringify({ clients }),
          },
        ];
      if (u.pathname.endsWith("/addClient")) {
        created++;
        const p = new URLSearchParams(String(init?.body));
        clients.push(...JSON.parse(p.get("settings")!).clients);
        if (uncertain) throw new Error("uncertain after commit");
      }
      if (u.pathname.includes("/updateClient/")) {
        const p = new URLSearchParams(String(init?.body));
        clients = JSON.parse(p.get("settings")!).clients;
      }
      if (u.pathname.includes("/delClient/")) clients = [];
      if (u.pathname.includes("getClientTraffics/"))
        obj = {
          up: 100,
          down: 200,
          total: clients[0]?.totalGB ?? 0,
          expiryTime: clients[0]?.expiryTime ?? 0,
          enable: true,
        };
      return new Response(JSON.stringify({ success: true, obj }));
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await f.mf.dispose();
});
async function configured() {
  await setCard(f.env, IDs.b1, 100, JSON.stringify(fakeCard));
  await run(f.env, "UPDATE plans SET price_minor=50000 WHERE id=?", IDs.plan1);
}
async function paidOrder(key = "purchase") {
  await configured();
  return createOrder(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, key);
}
function receipt(orderId: string, updateId = 11, customer = 300) {
  return {
    ...update(customer, "", updateId),
    message: {
      ...update(customer, "").message,
      caption: `/receipt ${orderId}`,
      photo: [
        {
          file_id: "TEST-ONLY-FILE-ID",
          file_unique_id: "TEST-UNIQUE",
          width: 400,
          height: 600,
          file_size: 1200,
        },
      ],
    },
  };
}
async function review(o: SalesOrder, key = "receipt") {
  await submitEvidence(f.env, IDs.b1, 300, receipt(o.id), key);
  return (await one<{ id: string }>(
    f.env,
    "SELECT id FROM manual_reviews WHERE order_id=? ORDER BY created_at DESC",
    o.id,
  ))!.id;
}
async function count(table: string) {
  return (await one<{ n: number }>(
    f.env,
    `SELECT count(*) AS n FROM ${table}`,
  ))!.n;
}
it("configures card encrypted, masks admin response, rejects secret fields", async () => {
  const result = await setCard(f.env, IDs.b1, 100, JSON.stringify(fakeCard));
  expect(result.text).not.toContain(fakeCard.card_number);
  const bank = await one<{ settings_enc: string }>(
    f.env,
    "SELECT settings_enc FROM bank_settings",
  );
  expect(bank!.settings_enc).not.toContain(fakeCard.card_number);
  await expect(
    setCard(
      f.env,
      IDs.b1,
      100,
      JSON.stringify({ ...fakeCard, PIN: "never-store-this" }),
    ),
  ).rejects.toThrow("UNSUPPORTED_SETTING");
});
it("rejects other tenant owner setting recipient card", async () => {
  await expect(
    setCard(f.env, IDs.b1, 200, JSON.stringify(fakeCard)),
  ).rejects.toThrow("FORBIDDEN");
});
it("creates awaiting-receipt order and displays exact amount/card/panel without provisioning", async () => {
  const o = await paidOrder();
  expect(o.state).toBe("AWAITING_PAYMENT");
  expect(o.payment_state).toBe("AWAITING_RECEIPT");
  expect(await count("services")).toBe(0);
  expect(await count("operations")).toBe(0);
  const view = await orderView(f.env, IDs.b1, 300, o.id);
  expect(view.text).toContain(fakeCard.card_number);
  expect(view.text).toContain(fakeCard.recipient_name);
  expect(view.text).toContain("panel.example");
});
it("receipt screenshot creates review and admin delivery but cannot mark payment paid", async () => {
  const o = await paidOrder();
  await review(o);
  expect(
    (await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.payment_state,
  ).toBe("UNDER_REVIEW");
  expect(await count("payments")).toBe(0);
  expect(await count("operations")).toBe(0);
  const r = await one<{ id: string; evidence_enc: string }>(
    f.env,
    "SELECT id,evidence_enc FROM manual_reviews",
  );
  expect(r!.evidence_enc).not.toContain("TEST-ONLY-FILE-ID");
  await deliver(f.env, 5);
  expect(
    telegramCalls.some(
      (c) => c.method === "sendPhoto" && c.body.chat_id === 100,
    ),
  ).toBe(true);
});
it("approval atomically records reviewer/payment and exactly one queued service", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "decision");
  expect(await count("payments")).toBe(1);
  expect(await count("services")).toBe(1);
  expect(await count("operations")).toBe(1);
  const payment = await one<{
    provider: string;
    reviewer_id: number;
    review_id: string;
  }>(f.env, "SELECT provider,reviewer_id,review_id FROM payments");
  expect(payment).toEqual({
    provider: "manual-card",
    reviewer_id: 100,
    review_id: rid,
  });
  expect(
    (await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.payment_state,
  ).toBe("APPROVED");
  expect(created).toBe(0);
});
it("duplicate approvals never duplicate payment or provisioning", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "first");
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "second");
  expect(await count("payments")).toBe(1);
  expect(await count("operations")).toBe(1);
  expect(await count("services")).toBe(1);
});
it("concurrent approval/rejection has one final decision and matching ledger", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await run(f.env, "INSERT INTO tenant_admins VALUES('t1',400,'ADMIN')");
  await Promise.all([
    decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "approve-race"),
    decide(
      f.env,
      IDs.b1,
      400,
      rid,
      "REJECTED",
      "واریز قابل تأیید نیست",
      "reject-race",
    ),
  ]);
  const r = await one<{ state: string }>(
    f.env,
    "SELECT state FROM manual_reviews",
  );
  expect(["APPROVED", "REJECTED"]).toContain(r!.state);
  expect(await count("payments")).toBe(r!.state === "APPROVED" ? 1 : 0);
  expect(await count("operations")).toBe(r!.state === "APPROVED" ? 1 : 0);
  expect(
    (await one<{ n: number }>(
      f.env,
      "SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'PAYMENT_%'",
    ))!.n,
  ).toBe(1);
});
it("concurrent approvals by different administrators create one service", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await run(f.env, "INSERT INTO tenant_admins VALUES('t1',400,'ADMIN')");
  await Promise.all([
    decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "a"),
    decide(f.env, IDs.b1, 400, rid, "APPROVED", "", "b"),
  ]);
  expect(await count("services")).toBe(1);
  expect(await count("payments")).toBe(1);
});
it("rejection requires a reason and preserves reviewer/time without provisioning", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await expect(
    decide(f.env, IDs.b1, 100, rid, "REJECTED", "", "reject"),
  ).rejects.toThrow();
  await decide(
    f.env,
    IDs.b1,
    100,
    rid,
    "REJECTED",
    "شماره پیگیری خوانا نیست",
    "reject",
  );
  const r = await one<{
    state: string;
    reviewed_at: number;
    reason_enc: string;
  }>(f.env, "SELECT state,reviewed_at,reason_enc FROM manual_reviews");
  expect(r!.state).toBe("REJECTED");
  expect(r!.reviewed_at).toBeGreaterThan(0);
  expect(await open(f.env, r!.reason_enc, `reason:${IDs.b1}:${rid}`)).toBe(
    "شماره پیگیری خوانا نیست",
  );
  expect(await count("payments")).toBe(0);
  expect(await count("services")).toBe(0);
});
it("additional evidence preserves review history and permits later manual approval", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(
    f.env,
    IDs.b1,
    100,
    rid,
    "MORE_EVIDENCE",
    "رسید کامل را ارسال کنید",
    "more",
  );
  await submitEvidence(
    f.env,
    IDs.b1,
    300,
    receipt(o.id, 22),
    "second-evidence",
  );
  const rs = await rows<{ id: string; state: string }>(
    f.env,
    "SELECT id,state FROM manual_reviews ORDER BY id",
  );
  expect(rs).toHaveLength(2);
  const pending = rs.find((r) => r.state === "PENDING")!;
  await decide(f.env, IDs.b1, 100, pending.id, "APPROVED", "", "approve");
  expect(await count("payments")).toBe(1);
  expect(await count("services")).toBe(1);
});
it("receipt replay is idempotent", async () => {
  const o = await paidOrder();
  await submitEvidence(f.env, IDs.b1, 300, receipt(o.id), "same-receipt");
  await submitEvidence(f.env, IDs.b1, 300, receipt(o.id), "same-receipt");
  expect(await count("manual_reviews")).toBe(1);
});
it("rejects receipt without an explicit order or selected session", async () => {
  await paidOrder();
  const r = receipt("unused");
  r.message.caption = "";
  await expect(submitEvidence(f.env, IDs.b1, 300, r, "x")).rejects.toThrow(
    "SELECT_ORDER_BEFORE_RECEIPT",
  );
});
it("uses selected receipt session and rejects expired sessions", async () => {
  const o = await paidOrder();
  await beginReceipt(f.env, IDs.b1, 300, o.id);
  await run(f.env, "UPDATE receipt_sessions SET expires_at=1");
  const r = receipt(o.id);
  r.message.caption = "";
  await expect(submitEvidence(f.env, IDs.b1, 300, r, "x")).rejects.toThrow(
    "SELECT_ORDER_BEFORE_RECEIPT",
  );
  await beginReceipt(f.env, IDs.b1, 300, o.id);
  await submitEvidence(f.env, IDs.b1, 300, r, "y");
  expect(await count("manual_reviews")).toBe(1);
});
it("does not fall back to session when explicit receipt caption is malformed", async () => {
  const o = await paidOrder();
  await beginReceipt(f.env, IDs.b1, 300, o.id);
  const r = receipt(o.id);
  r.message.caption = "/receipt not-a-valid-order";
  await expect(submitEvidence(f.env, IDs.b1, 300, r, "x")).rejects.toThrow(
    "INVALID_RECEIPT_CAPTION",
  );
});
it("rejects another customer receipt and unauthorized review", async () => {
  const o = await paidOrder();
  await expect(
    submitEvidence(f.env, IDs.b1, 400, receipt(o.id, 11, 400), "x"),
  ).rejects.toThrow("ORDER_NOT_ACCEPTING_EVIDENCE");
  const rid = await review(o);
  await expect(
    decide(f.env, IDs.b1, 300, rid, "APPROVED", "", "x"),
  ).rejects.toThrow("FORBIDDEN");
  await expect(reviewView(f.env, IDs.b2, 200, rid)).rejects.toThrow(
    "REVIEW_NOT_FOUND",
  );
});
it("self-approval is prohibited even for an authorized admin", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await run(f.env, "INSERT INTO tenant_admins VALUES('t1',300,'ADMIN')");
  await expect(
    decide(f.env, IDs.b1, 300, rid, "APPROVED", "", "x"),
  ).rejects.toThrow("SELF_APPROVAL_FORBIDDEN");
});
it("prevents review media delivery to an administrator revoked before delivery", async () => {
  await run(f.env, "INSERT INTO tenant_admins VALUES('t1',400,'ADMIN')");
  const o = await paidOrder();
  await review(o);
  await run(
    f.env,
    "DELETE FROM tenant_admins WHERE tenant_id='t1' AND user_id=400",
  );
  await deliver(f.env, 10);
  expect(
    telegramCalls.some(
      (c) => c.method === "sendPhoto" && c.body.chat_id === 400,
    ),
  ).toBe(false);
  expect(
    await one(
      f.env,
      "SELECT id FROM outbox WHERE chat_id=400 AND state='DEAD' AND error_code='ADMIN_PERMISSION_REVOKED'",
    ),
  ).not.toBe(null);
});
it("database batch failure leaves approval pending and safely retryable", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  const broken = {
    ...f.env,
    DB: {
      prepare: f.env.DB.prepare.bind(f.env.DB),
      batch: async () => {
        throw new Error("injected rollback boundary");
      },
    },
  } as unknown as Env;
  await expect(
    decide(broken, IDs.b1, 100, rid, "APPROVED", "", "x"),
  ).rejects.toThrow("injected");
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM manual_reviews"))!
      .state,
  ).toBe("PENDING");
  expect(await count("payments")).toBe(0);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "x");
  expect(await count("payments")).toBe(1);
});
it("failed selected panel after approval is retried without paying or creating twice", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "x");
  uncertain = true;
  await processOperations(f.env);
  expect(created).toBe(1);
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM operations"))!
      .state,
  ).toBe("UNKNOWN");
  uncertain = false;
  await run(f.env, "UPDATE operations SET next_at=0");
  await processOperations(f.env);
  expect(created).toBe(1);
  expect(await count("payments")).toBe(1);
  expect((await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.state).toBe(
    "FULFILLED",
  );
  expect(hostCalls.every((h) => h === "panel.example")).toBe(true);
});
it("order snapshots keep original price/quota/recipient after configuration changes", async () => {
  const o = await paidOrder();
  await run(
    f.env,
    "UPDATE plans SET bytes=999999,price_minor=999 WHERE id=?",
    IDs.plan1,
  );
  await setCard(
    f.env,
    IDs.b1,
    100,
    JSON.stringify({ ...fakeCard, card_number: "4444333322221111" }),
  );
  expect((await orderView(f.env, IDs.b1, 300, o.id)).text).toContain(
    fakeCard.card_number,
  );
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "x");
  expect(
    (await one<{ bytes: number }>(f.env, "SELECT bytes FROM services"))!.bytes,
  ).toBe(1073741824);
  expect(
    (await one<{ amount_minor: number }>(
      f.env,
      "SELECT amount_minor FROM payments",
    ))!.amount_minor,
  ).toBe(50000);
});
it("requires reconfirmation when a displayed plan changes", async () => {
  const result = await offer(f.env, IDs.b1, 300, IDs.plan1);
  const data = (result.reply_markup as any).inline_keyboard[0][0].callback_data;
  await run(f.env, "UPDATE plans SET price_minor=77 WHERE id=?", IDs.plan1);
  await expect(
    checkout(f.env, IDs.b1, 300, data.split(" ")[1], "x"),
  ).rejects.toThrow("PLAN_CHANGED_RECONFIRM");
});
it("paid renewal retains original service/panel and fulfils its own order", async () => {
  const first = await createOrder(
    f.env,
    IDs.b1,
    300,
    IDs.p1,
    IDs.plan1,
    "free",
  );
  await processOperations(f.env);
  const s = (await one<Service>(f.env, "SELECT * FROM services"))!;
  await configured();
  const renewed = await createOrder(
    f.env,
    IDs.b1,
    300,
    IDs.p1,
    IDs.plan1,
    "renewal",
    s.id,
  );
  const rid = await review(renewed);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "renew-approval");
  expect(await count("services")).toBe(1);
  await processOperations(f.env);
  const actual = (await one<Service>(f.env, "SELECT * FROM services"))!;
  expect(actual.id).toBe(s.id);
  expect(actual.bytes).toBe(s.bytes + 1073741824);
  expect(actual.expires_at).toBe(s.expires_at + 30 * 86400);
  expect(
    (await one<SalesOrder>(
      f.env,
      "SELECT * FROM orders WHERE id=?",
      renewed.id,
    ))!.state,
  ).toBe("FULFILLED");
  expect(hostCalls.every((h) => h === "panel.example")).toBe(true);
});
it("customer UI traverses offer/checkout/receipt/review/confirm/service end to end", async () => {
  await configured();
  const product = (await handle(
    f.env,
    IDs.b1,
    update(300, `/plan ${IDs.plan1}`),
  ))!;
  const confirm = (product.reply_markup as any).inline_keyboard[0][0]
    .callback_data;
  await handle(f.env, IDs.b1, update(300, confirm, 2));
  const o = (await one<SalesOrder>(f.env, "SELECT * FROM orders"))!;
  await handle(f.env, IDs.b1, update(300, `/receipt ${o.id}`, 3));
  await handle(f.env, IDs.b1, receipt(o.id, 4));
  const rid = (await one<{ id: string }>(
    f.env,
    "SELECT id FROM manual_reviews",
  ))!.id;
  const preview = (await handle(
    f.env,
    IDs.b1,
    update(100, `/approve ${rid}`, 5),
  ))!;
  expect(preview.text).toContain("تصویر به‌تنهایی");
  await handle(f.env, IDs.b1, update(100, `/confirm_pay ${rid}`, 6));
  await processOperations(f.env);
  const s = (await one<Service>(f.env, "SELECT * FROM services"))!;
  const status = (await handle(
    f.env,
    IDs.b1,
    update(300, `/service ${s.id}`, 7),
  ))!;
  expect(status.text).toContain("باقی‌مانده");
  expect(status.text).toContain("مصرف واقعی");
});
it("typed administrator reason applies only to the selected pending review", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await handle(f.env, IDs.b1, update(100, `/ask_more ${rid}`));
  await handle(f.env, IDs.b1, update(100, "رسید خوانا نیست", 33));
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM manual_reviews"))!
      .state,
  ).toBe("MORE_EVIDENCE");
});
it("approved payment is not lost when a plan is later unpublished", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await run(f.env, "UPDATE plans SET enabled=0 WHERE id=?", IDs.plan1);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "x");
  expect(await count("operations")).toBe(1);
});
it("receipt formats and size limits reject unsupported documents", async () => {
  const o = await paidOrder();
  const base = update(300, "");
  const doc = {
    ...base,
    message: {
      ...base.message,
      caption: `/receipt ${o.id}`,
      document: {
        file_id: "bad",
        file_unique_id: "bad",
        mime_type: "application/x-msdownload",
        file_size: 100,
      },
    },
  };
  await expect(submitEvidence(f.env, IDs.b1, 300, doc, "bad")).rejects.toThrow(
    "EVIDENCE_FORMAT_UNSUPPORTED",
  );
  const big = receipt(o.id);
  big.message.photo[0]!.file_size = 11 * 1024 * 1024;
  await expect(submitEvidence(f.env, IDs.b1, 300, big, "big")).rejects.toThrow(
    "EVIDENCE_TOO_LARGE",
  );
});
it("bank envelope is isolated from other bot contexts", async () => {
  await configured();
  const row = (await one<{ settings_enc: string }>(
    f.env,
    "SELECT settings_enc FROM bank_settings",
  ))!;
  await expect(open(f.env, row.settings_enc, `bank:${IDs.b2}`)).rejects.toThrow(
    "CREDENTIAL_DECRYPT_FAILED",
  );
});
it("routing policy is enforced beyond menu buttons", async () => {
  await run(
    f.env,
    "INSERT INTO routing_rules(bot_id,customer_id,panel_id) VALUES(?,?,?)",
    IDs.b1,
    300,
    IDs.p1,
  );
  await expect(
    createOrder(f.env, IDs.b1, 300, IDs.p2, IDs.plan2, "bad"),
  ).rejects.toThrow("ROUTING_POLICY_DENIED");
});
it("disabled destination cannot trigger approval on another panel", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await run(f.env, "UPDATE panels SET enabled=0 WHERE id=?", IDs.p1);
  await expect(
    decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "x"),
  ).rejects.toThrow("PANEL_NOT_AVAILABLE");
  expect(await count("payments")).toBe(0);
  expect(hostCalls).toHaveLength(0);
});

it("approved creation waits for panel recovery before anchoring full validity", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "x");
  await run(f.env, "UPDATE services SET expires_at=1");
  await processOperations(f.env);
  const s = (await one<Service>(f.env, "SELECT * FROM services"))!;
  expect(s.expires_at).toBeGreaterThan(
    Math.floor(Date.now() / 1000) + 29 * 86400,
  );
});
it("successful retry of a failed paid creation fulfils the original paid order", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "APPROVED", "", "x");
  const s = (await one<Service>(f.env, "SELECT * FROM services"))!;
  clients = [
    {
      id: "wrong",
      email: s.email,
      totalGB: s.bytes,
      expiryTime: s.expires_at * 1000,
      enable: true,
    },
  ];
  await processOperations(f.env);
  expect((await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.state).toBe(
    "FAILED",
  );
  clients = [];
  await handle(
    f.env,
    IDs.b1,
    update(
      100,
      `/retry ${(await one<{ id: string }>(f.env, "SELECT id FROM operations"))!.id}`,
    ),
  );
  await processOperations(f.env);
  expect((await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.state).toBe(
    "FULFILLED",
  );
  expect(await count("payments")).toBe(1);
});
it("an expired worker cannot complete or overwrite a newer operation claim", async () => {
  const o = await createOrder(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "fenced");
  const original = globalThis.fetch;
  let replaced = false;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const response = await original(input, init);
    if (String(input).endsWith("/addClient") && !replaced) {
      replaced = true;
      await run(
        f.env,
        "UPDATE operations SET claim_id='newer-owner',state='PROCESSING'",
      );
    }
    return response;
  });
  await processOperations(f.env);
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM operations"))!
      .state,
  ).toBe("PROCESSING");
  expect((await one<SalesOrder>(f.env, "SELECT * FROM orders"))!.state).toBe(
    "PROVISIONING",
  );
});
it("financial key rotation rewraps bank/recipient/receipt/reason without changing content", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "MORE_EVIDENCE", "تصویر کامل", "m");
  const { rewrapFinance } = await import("../src/recovery");
  const v2 = { ...f.env, KEY_VERSION: "v2" };
  const result = await rewrapFinance(v2, IDs.b1, 100);
  expect(result.rewrapped).toBe(4);
  expect(result.more).toBe(false);
  const r = (await one<{ evidence_enc: string; reason_enc: string }>(
    f.env,
    "SELECT * FROM manual_reviews",
  ))!;
  expect(JSON.parse(r.evidence_enc).v).toBe("v2");
  expect(await open(v2, r.reason_enc, `reason:${IDs.b1}:${rid}`)).toBe(
    "تصویر کامل",
  );
});
it("terminal evidence retention clears private file references but preserves audit/payment ledger", async () => {
  const o = await paidOrder();
  const rid = await review(o);
  await decide(f.env, IDs.b1, 100, rid, "REJECTED", "خوانا نیست", "reject");
  await run(f.env, "UPDATE manual_reviews SET reviewed_at=1");
  await run(f.env, "UPDATE orders SET created_at=1");
  const { retainFinancialEvidence } = await import("../src/recovery");
  await retainFinancialEvidence(f.env);
  expect(
    (await one<{ evidence_enc: string }>(
      f.env,
      "SELECT * FROM manual_reviews",
    ))!.evidence_enc,
  ).toBe("");
  expect(
    (await one<{ recipient_enc: string | null }>(
      f.env,
      "SELECT * FROM order_snapshots",
    ))!.recipient_enc,
  ).toBe(null);
  expect(await count("manual_reviews")).toBe(1);
  expect((await reviewView(f.env, IDs.b1, 100, rid)).media).toBeUndefined();
});
it("unsupported banking-auth fields never enter configuration or logs", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    setCard(
      f.env,
      IDs.b1,
      100,
      JSON.stringify({
        ...fakeCard,
        banking_password: "SENSITIVE-TEST-SENTINEL",
      }),
    ),
  ).rejects.toThrow("UNSUPPORTED_SETTING");
  expect(await one(f.env, "SELECT bot_id FROM bank_settings")).toBe(null);
  expect(JSON.stringify(log.mock.calls)).not.toContain(
    "SENSITIVE-TEST-SENTINEL",
  );
  log.mockRestore();
});
it("finite customer renewal rejects unlimited imported quota or expiry before taking payment", async () => {
  await createOrder(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "free");
  await processOperations(f.env);
  const s = (await one<Service>(f.env, "SELECT * FROM services"))!;
  await configured();
  for (const [quota, expiry] of [
    [0, s.expires_at],
    [s.bytes, 0],
  ]) {
    await run(
      f.env,
      "UPDATE services SET bytes=?,expires_at=? WHERE id=?",
      quota,
      expiry,
      s.id,
    );
    await expect(offer(f.env, IDs.b1, 300, IDs.plan1, s.id)).rejects.toThrow(
      "UNLIMITED_RENEWAL_UNSUPPORTED",
    );
    await expect(
      createOrder(
        f.env,
        IDs.b1,
        300,
        IDs.p1,
        IDs.plan1,
        `unlimited-${quota}`,
        s.id,
      ),
    ).rejects.toThrow("UNLIMITED_RENEWAL_UNSUPPORTED");
  }
  expect(await count("payments")).toBe(0);
  expect(await count("orders")).toBe(1);
});
