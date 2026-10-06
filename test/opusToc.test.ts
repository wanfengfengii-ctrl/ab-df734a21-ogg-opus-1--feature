import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectOpusPacket } from "../src/opusToc.ts";
import { opusPacket } from "./helpers/oggBuilder.ts";

test("all 32 TOC configurations map to documented 48 kHz frame sizes", () => {
  const expectedPerGroup: number[][] = [
    [480, 960, 1920, 2880], // 0..3 SILK NB
    [480, 960, 1920, 2880], // 4..7 SILK MB
    [480, 960, 1920, 2880], // 8..11 SILK WB
    [480, 960], // 12..13 hybrid SWB
    [480, 960], // 14..15 hybrid FB
    [120, 240, 480, 960], // 16..19 CELT NB
    [120, 240, 480, 960], // 20..23 CELT WB
    [120, 240, 480, 960], // 24..27 CELT SWB
    [120, 240, 480, 960], // 28..31 CELT FB
  ];
  let cfg = 0;
  for (const group of expectedPerGroup) {
    for (const expected of group) {
      const info = inspectOpusPacket(opusPacket({ config: cfg, frameData: [new Uint8Array(10)] }));
      assert.equal(info.config, cfg);
      assert.equal(info.samplesPerFrame, expected);
      assert.equal(info.totalSamples, expected);
      cfg += 1;
    }
  }
});

test("code 1 holds two equal frames", () => {
  const info = inspectOpusPacket(opusPacket({ config: 31, code: 1, frameData: [new Uint8Array(20)] }));
  assert.equal(info.frameCount, 2);
  assert.equal(info.totalSamples, 960 * 2);
});

test("code 2 holds two different sized frames", () => {
  const info = inspectOpusPacket(
    opusPacket({ config: 31, code: 2, frameData: [new Uint8Array(30), new Uint8Array(7)] }),
  );
  assert.equal(info.frameCount, 2);
  assert.equal(info.totalSamples, 1920);
});

test("code 3 CBR divides the payload evenly", () => {
  const info = inspectOpusPacket(
    opusPacket({ config: 28, code: 3, frameData: [new Uint8Array(5), new Uint8Array(5), new Uint8Array(5)] }),
  );
  assert.equal(info.frameCount, 3);
  assert.equal(info.totalSamples, 120 * 3);
});

test("code 3 VBR reads contiguous length prefixes", () => {
  const info = inspectOpusPacket(
    opusPacket({
      config: 28,
      code: 3,
      vbr: true,
      frameData: [new Uint8Array(11), new Uint8Array(22), new Uint8Array(3)],
    }),
  );
  assert.equal(info.frameCount, 3);
  assert.equal(info.totalSamples, 360);
});

test("code 3 honors trailing Opus padding", () => {
  const info = inspectOpusPacket(
    opusPacket({
      config: 28,
      code: 3,
      padding: 5,
      frameData: [new Uint8Array(4), new Uint8Array(4)],
    }),
  );
  assert.equal(info.frameCount, 2);
  assert.equal(info.totalSamples, 240);
});

test("code 3 with 254+ padding consumes continuation length bytes", () => {
  // 254 bytes => length byte 255 followed by 0
  const info = inspectOpusPacket(
    opusPacket({
      config: 28,
      code: 3,
      padding: 254,
      frameData: [new Uint8Array(2)],
    }),
  );
  assert.equal(info.frameCount, 1);
});

test("VBR length 252..255 uses two-byte coding", () => {
  const data = new Uint8Array(300);
  const info = inspectOpusPacket(opusPacket({ config: 31, code: 2, frameData: [data, new Uint8Array(5)] }));
  assert.equal(info.frameCount, 2);
});

test("rejects an empty packet", () => {
  assert.throws(() => inspectOpusPacket(new Uint8Array(0)), /empty opus packet/);
});

test("rejects code 1 with odd payload", () => {
  const p = opusPacket({ config: 31, code: 1, frameData: [new Uint8Array(20)] });
  // Mutate to an odd length: append a byte, breaking equal halves.
  assert.throws(() => inspectOpusPacket(Uint8Array.from([...p, 0])), /odd payload/);
});

test("rejects code 3 with zero frames", () => {
  const p = new Uint8Array([0xfb, 0x00]); // config 31, code 3, M=0
  assert.throws(() => inspectOpusPacket(p), /zero frames/);
});

test("rejects code 3 exceeding 120 ms", () => {
  // config 31 = 20 ms frames; 7 frames = 140 ms > 5760 samples
  const p = opusPacket({
    config: 31,
    code: 3,
    frameCount: 7,
    frameData: [new Uint8Array(1)],
  });
  assert.throws(() => inspectOpusPacket(p), /120 ms/);
});

test("accepts the maximum 120 ms packet", () => {
  // config 28 = 2.5 ms; 48 frames = 120 ms
  const info = inspectOpusPacket(
    opusPacket({
      config: 28,
      code: 3,
      frameCount: 48,
      frameData: Array.from({ length: 48 }, () => new Uint8Array(1)),
    }),
  );
  assert.equal(info.totalSamples, 5760);
});

test("rejects code 3 CBR payload that does not divide", () => {
  const p = opusPacket({
    config: 28,
    code: 3,
    frameCount: 3,
    frameData: [new Uint8Array(1), new Uint8Array(1)], // only 2 data bytes
  });
  assert.throws(() => inspectOpusPacket(p), /not divisible/);
});

test("rejects code 2 whose signaled first frame overruns the packet", () => {
  // toc code 2, length 100, but only 1 byte follows
  const p = new Uint8Array([(31 << 3) | 2, 100, 0]);
  assert.throws(() => inspectOpusPacket(p), /exceeds payload/);
});

test("rejects code 2 with a truncated two-byte length", () => {
  const p = new Uint8Array([(31 << 3) | 2, 253]);
  assert.throws(() => inspectOpusPacket(p), /invalid first frame length/);
});

test("rejects code 3 padding that runs past the packet", () => {
  const p = new Uint8Array([(31 << 3) | 3, 0x41, 20]); // M=1, pad flag, 20 pad bytes missing
  assert.throws(() => inspectOpusPacket(p), /padding/);
});

test("reports stereo flag from the TOC", () => {
  const info = inspectOpusPacket(opusPacket({ config: 31, stereo: true }));
  assert.equal(info.stereo, true);
});
