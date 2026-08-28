import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../dist/api/passwords.js";

test("hash de senha usa salt e valida somente a senha correta", () => {
  const first = hashPassword("uma-senha-forte");
  const second = hashPassword("uma-senha-forte");

  assert.notEqual(first, second);
  assert.equal(verifyPassword("uma-senha-forte", first), true);
  assert.equal(verifyPassword("senha-errada", first), false);
  assert.equal(verifyPassword("uma-senha-forte", "invalido"), false);
});
