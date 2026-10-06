import { test } from "node:test";
import assert from "node:assert/strict";
import { oggCrc32 } from "../src/crc32ogg.ts";

// Ogg uses CRC-32/MPEG-2 polynomial 0x04c11db7 with init=0, no
// reflection and no final XOR (RFC 3533 section 6). With init 0 (rather
// than the MPEG-2 check convention's 0xffffffff) the "123456789"
// check string yields 0x89a1897f.
test("ogg CRC matches the init-zero polynomial check value", () => {
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(oggCrc32(bytes), 0x89a1897f);
});

test("ogg CRC is stable and order-sensitive", () => {
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  const b = new Uint8Array([1, 2, 3, 4, 5]);
  const c = new Uint8Array([5, 4, 3, 2, 1]);
  assert.equal(oggCrc32(a), oggCrc32(b));
  assert.notEqual(oggCrc32(a), oggCrc32(c));
  assert.equal(oggCrc32(new Uint8Array(0)), 0);
});
