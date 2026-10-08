import { test } from "node:test";
import assert from "node:assert/strict";
import { identityFieldPool } from "../src/features/card-scanner/identity-fields";
test("an unconfirmed name cannot overwrite confirmed identity fields even when its numbers are clear", () => {
  const trusted = { review: [], awakening: 1, extraCopies: 14 };
  const guessed = { review: ["이름 확인"], awakening: 3, extraCopies: 9 };
  assert.deepEqual(identityFieldPool([trusted, guessed]), [trusted]);
  assert.deepEqual(identityFieldPool([guessed]), [guessed]);
  assert.deepEqual(identityFieldPool([{ ...guessed, manual: ["name"] }]), [{ ...guessed, manual: ["name"] }]);
});
