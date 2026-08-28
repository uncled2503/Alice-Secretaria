import assert from "node:assert/strict";
import test from "node:test";

process.env.SESSION_SECRET = "segredo-de-teste-com-pelo-menos-32-caracteres";
const { clearSessionCookie, createSessionCookie, readStaffSession } = await import("../dist/api/staffSession.js");

test("cookie assinado preserva a identidade e rejeita adulteracao", () => {
  process.env.NODE_ENV = "test";
  const cookie = createSessionCookie({ id: "staff-1", name: "Maria", clinicId: "clinic-1", role: "client" });
  const session = readStaffSession(cookie);

  assert.equal(session?.id, "staff-1");
  assert.equal(session?.clinicId, "clinic-1");
  assert.equal(session?.role, "client");
  assert.doesNotMatch(cookie, /; Secure/);

  const cookieValue = cookie.split(";")[0];
  const last = cookieValue.at(-1);
  const tampered = cookieValue.slice(0, -1) + (last === "a" ? "b" : "a");
  assert.equal(readStaffSession(tampered), null);
});

test("cookies de producao recebem os atributos de seguranca", () => {
  process.env.NODE_ENV = "production";
  const cookie = createSessionCookie({ id: "admin-1", name: "Admin", clinicId: null, role: "admin" });

  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /; Secure$/);
  assert.match(clearSessionCookie(), /; Secure$/);
});
