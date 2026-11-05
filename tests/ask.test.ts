import { test } from "node:test";
import assert from "node:assert/strict";
import { qrDataUrlFromMultipart, summarizeTransactions, unwrapToolResult } from "@/lib/ask/agent";

test("PayPal's multipart QR response is unpacked into a PNG data URL", () => {
  const png = Buffer.alloc(300, 7).toString("base64");
  const body = `--61642219-4b9e\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\n${png}\r\n--61642219-4b9e--\r\n`;
  assert.equal(qrDataUrlFromMultipart(body), `data:image/png;base64,${png}`);
  assert.equal(qrDataUrlFromMultipart("no image here"), null);
});

test("double-encoded toolkit results are unwrapped", () => {
  const multipart = "--b\r\nContent-Type: text/plain\r\n\r\nAAAA\r\n--b--";
  assert.equal(unwrapToolResult(JSON.stringify(multipart)), multipart);
  assert.deepEqual(unwrapToolResult('{"href":"x"}'), { href: "x" });
  assert.deepEqual(unwrapToolResult(JSON.stringify('{"href":"x"}')), { href: "x" });
  assert.equal(unwrapToolResult("plain text"), "plain text");
});

test("earnings count buyer payments only — not the sandbox's starting balance or refunds", () => {
  const s = summarizeTransactions({
    transaction_details: [
      { transaction_info: { transaction_event_code: "T1900", transaction_amount: { value: "5000.00" } } },
      { transaction_info: { transaction_event_code: "T0006", transaction_amount: { value: "32.00" }, fee_amount: { value: "-1.83" } } },
      { transaction_info: { transaction_event_code: "T0006", transaction_amount: { value: "32.00" }, fee_amount: { value: "-1.83" } } },
      { transaction_info: { transaction_event_code: "T1107", transaction_amount: { value: "-8.00" } } },
    ],
  });
  assert.deepEqual(s, { payments: 2, grossUsd: "64.00", feesUsd: "3.66", netUsd: "60.34" });
});
