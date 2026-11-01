import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ImapFlow } from "imapflow";
import { createConfigured126MailConnector, type MailMessage } from "../src/index.ts";

async function readFixture(t: TestContext, source: Buffer, size = source.length) {
  const queries: Record<string, unknown>[] = [];
  let released = false;
  t.mock.method(ImapFlow.prototype, "connect", async () => undefined);
  t.mock.method(ImapFlow.prototype, "logout", async () => undefined);
  t.mock.method(ImapFlow.prototype, "getMailboxLock", async (_folder, options) => {
    assert.equal(options.readOnly, true);
    return { release() { released = true; } };
  });
  t.mock.method(ImapFlow.prototype, "fetchOne", async (_uid, query, options) => {
    assert.equal(options.uid, true);
    queries.push(query);
    return { uid: 12, size, envelope: { subject: "fixture" },
      ...(query.source ? { source } : {}),
      bodyStructure: { type: "multipart/mixed", childNodes: [
        { part: "2", type: "application/octet-stream", disposition: "attachment",
          dispositionParameters: { filename: "test.bin" }, size: 4 },
      ] },
    };
  });
  const connector = createConfigured126MailConnector({ config: {}, fetch: globalThis.fetch });
  const credentialProvider = { get: async () => ({ email: "test@126.com", authorizationCode: "fixture-only" }) };
  const instance = await connector.connect({
    connection: { id: "mail", connectorKey: "126-mail", ownerType: "user", ownerId: "owner", scopes: [], credentialRef: "secret", status: "active" },
    credentialProvider,
  });
  const read = () => instance.execute("email.read", { messageId: "12" }, {
    runId: "test", actorUserId: "owner", connection: instance.connection, credentialProvider,
  });
  return { read, queries, released: () => released };
}

test("126 read decodes nested MIME alternatives and never treats attachment bytes as body", async (t) => {
  const source = Buffer.from([
    "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="outer"', "",
    "--outer", 'Content-Type: multipart/alternative; boundary="inner"', "",
    "--inner", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from("你好，邮件正文。").toString("base64"),
    "--inner", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
    "<p>=E4=BD=A0=E5=A5=BD=EF=BC=8C=E9=82=AE=E4=BB=B6=E6=AD=A3=E6=96=87=E3=80=82</p>",
    "--inner--", "--outer", 'Content-Type: application/octet-stream; name="test.bin"',
    'Content-Disposition: attachment; filename="test.bin"', "Content-Transfer-Encoding: base64", "",
    Buffer.from("ATTACHMENT_NOT_BODY").toString("base64"), "--outer--", "",
  ].join("\r\n"));
  const fixture = await readFixture(t, source);
  const result = (await fixture.read()).data as MailMessage;
  assert.equal(result.text?.trim(), "你好，邮件正文。");
  assert.equal(result.html?.trim(), "<p>你好，邮件正文。</p>");
  assert.doesNotMatch(result.text!, /Content-Transfer-Encoding|--inner|ATTACHMENT_NOT_BODY/);
  assert.deepEqual(result.attachments, [{ id: "2", name: "test.bin", mediaType: "application/octet-stream", byteSize: 4 }]);
  assert.equal(fixture.released(), true);
});

test("126 read decodes quoted-printable GB18030 bytes before converting them to Unicode", async (t) => {
  const fixture = await readFixture(t, Buffer.from([
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=gb18030", "Content-Transfer-Encoding: quoted-printable", "",
    "=D6=D0=CE=C4=\r\n=D5=FD=CE=C4",
  ].join("\r\n")));
  assert.equal(((await fixture.read()).data as MailMessage).text?.trim(), "中文正文");
});

test("126 HTML-only mail exposes decoded HTML and readable text", async (t) => {
  const fixture = await readFixture(t, Buffer.from("Content-Type: text/html; charset=utf-8\r\n\r\n<p>只有 HTML 正文</p>"));
  const message = (await fixture.read()).data as MailMessage;
  assert.equal(message.html, "<p>只有 HTML 正文</p>");
  assert.match(message.text!, /只有 HTML 正文/);
});

test("126 read rejects truncated source instead of returning partial MIME as a complete message", async (t) => {
  const fixture = await readFixture(t, Buffer.from("Content-Type: text/plain\r\n\r\npartial"), 1_000);
  await assert.rejects(fixture.read(), /incomplete/i);
  assert.equal(fixture.released(), true);
});

test("126 read rejects oversized mail before fetching its source", async (t) => {
  const fixture = await readFixture(t, Buffer.from("unused"), 10 * 1024 * 1024 + 1);
  await assert.rejects(fixture.read(), /size limit/i);
  assert.equal(fixture.queries.some((query) => query.source), false);
  assert.equal(fixture.released(), true);
});
