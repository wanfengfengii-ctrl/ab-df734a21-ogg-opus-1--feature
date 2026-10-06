import { test } from "node:test";
import assert from "node:assert/strict";
import { auditOggOpus, AuditError } from "../src/audit.ts";
import { oggCrc32 } from "../src/crc32ogg.ts";
import {
  monoSubstream,
  multistreamPacket,
  OggFileBuilder,
  opusHeadFamily1,
  opusPacket,
  opusSelfDelimitedPacket,
  stereoSubstream,
  type SubstreamSpec,
} from "./helpers/oggBuilder.ts";

/** One well-formed Ogg packet for the canonical family 1 layout of `channels`. */
function validPacket(channels: number, frameByte = 1): Uint8Array {
  const layout = channelsToLayout(channels);
  const subs: SubstreamSpec[] = [];
  for (let i = 0; i < layout.streams; i++) {
    subs.push(i < layout.coupled ? stereoSubstream(31, frameByte) : monoSubstream(31, frameByte));
  }
  return multistreamPacket(subs);
}

function channelsToLayout(channels: number): { streams: number; coupled: number } {
  const table: Record<number, { streams: number; coupled: number }> = {
    1: { streams: 1, coupled: 0 },
    2: { streams: 1, coupled: 1 },
    3: { streams: 2, coupled: 1 },
    4: { streams: 2, coupled: 2 },
    5: { streams: 3, coupled: 2 },
    6: { streams: 4, coupled: 2 },
    7: { streams: 5, coupled: 2 },
    8: { streams: 5, coupled: 3 },
  };
  return table[channels]!;
}

function validFamily1File(channels: number, packetCount = 8): Uint8Array {
  const packets = Array.from({ length: packetCount }, () => validPacket(channels));
  return new OggFileBuilder({ preSkip: 312, channels })
    .writeHeaders()
    .writeAudioPackets(packets)
    .build();
}

function expectFail(input: Uint8Array, code: string, page: number | null): void {
  try {
    auditOggOpus(input);
    assert.fail("expected audit to fail");
  } catch (err) {
    assert.ok(err instanceof AuditError, `expected AuditError, got ${err}`);
    assert.equal((err as AuditError).code, code);
    assert.equal((err as AuditError).pageIndex, page);
    assert.equal((err as AuditError).status, 422);
  }
}

/* ------------------------------ valid cases ----------------------------- */

test("family 1 5.1 record counts duration once per Ogg packet, not per substream", () => {
  // 6 channels -> N=4 streams (2 coupled stereo + 2 mono); 10 packets of
  // 20 ms each. A broken counter that summed the four substreams would
  // report 38400 samples instead of 9600.
  const file = validFamily1File(6, 10);
  const r = auditOggOpus(file);
  assert.equal(r.pageCount, 3);
  assert.equal(r.audioPacketCount, 10);
  assert.equal(r.decodedSamples, 9600);
  assert.equal(r.playableSamples, 9600 - 312);
});

test("family 1 statistics are stable across repeated audits", () => {
  const file = validFamily1File(8, 5);
  const a = auditOggOpus(file);
  const b = auditOggOpus(file);
  assert.deepEqual(a, b);
  assert.equal(a.decodedSamples, 5 * 960);
  assert.equal(a.audioPacketCount, 5);
});

test("canonical family 1 headers are accepted for every channel count 1..8", () => {
  for (let c = 1; c <= 8; c++) {
    const r = auditOggOpus(validFamily1File(c, 2));
    assert.equal(r.audioPacketCount, 2, `C=${c}`);
    assert.equal(r.decodedSamples, 1920, `C=${c}`);
    assert.equal(r.playableSamples, 1920 - 312, `C=${c}`);
  }
});

test("family 1 multichannel packet split across Ogg pages stays valid", () => {
  // Each packet carries four sizable substreams so the whole Ogg packet
  // exceeds a 510-byte lacing run and must span two pages.
  const big = validPacket(6, 200);
  assert.ok(big.length > 510);
  const before = validPacket(6, 1);
  const after = validPacket(6, 1);
  const file = new OggFileBuilder({ preSkip: 0, channels: 6 })
    .writeHeaders()
    .writeSpanningAudio([before, big, after], 1)
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.pageCount, 4);
  assert.equal(r.audioPacketCount, 3);
  assert.equal(r.decodedSamples, 3 * 960);
});

test("family 1 accepts code-3 VBR self-delimited substreams with padding", () => {
  // C=3 -> N=2, M=1: one stereo coupled stream, one mono stream. Both
  // use code 3 VBR with three 5 ms CELT frames = 360 samples; the
  // coupled stream additionally carries Opus padding.
  const stereo: SubstreamSpec = {
    stereo: true,
    config: 28,
    code: 3,
    vbr: true,
    frameData: [new Uint8Array(11), new Uint8Array(22), new Uint8Array(3)],
    padding: 7,
  };
  const mono: SubstreamSpec = {
    stereo: false,
    config: 28,
    code: 3,
    vbr: true,
    frameData: [new Uint8Array(5), new Uint8Array(9), new Uint8Array(2)],
  };
  const packets = Array.from({ length: 4 }, () => multistreamPacket([stereo, mono]));
  const file = new OggFileBuilder({ preSkip: 10, channels: 3 })
    .writeHeaders()
    .writeAudioPackets(packets)
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.audioPacketCount, 4);
  assert.equal(r.decodedSamples, 4 * 360);
  assert.equal(r.playableSamples, 4 * 360 - 10);
});

test("family 1 accepts CBR code-3 self-delimited substreams", () => {
  const stereo: SubstreamSpec = {
    stereo: true,
    config: 28,
    code: 3,
    frameData: Array.from({ length: 3 }, () => new Uint8Array(6)),
  };
  const mono: SubstreamSpec = {
    stereo: false,
    config: 28,
    code: 3,
    frameData: Array.from({ length: 3 }, () => new Uint8Array(4)),
  };
  const packet = multistreamPacket([stereo, mono]);
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.decodedSamples, 360);
});

test("family 1 single stream (C=1/C=2) uses regular framing just like family 0", () => {
  for (const c of [1, 2] as const) {
    const packet = multistreamPacket([
      c === 2 ? stereoSubstream(31) : monoSubstream(31),
    ]);
    const file = new OggFileBuilder({ preSkip: 0, channels: c })
      .writeHeaders()
      .writeAudioPackets([packet, packet])
      .build();
    const r = auditOggOpus(file);
    assert.equal(r.decodedSamples, 1920, `C=${c}`);
  }
});

test("family 1 EOS end-trim and pre-skip still follow the page timeline", () => {
  const packets = Array.from({ length: 4 }, () => validPacket(6));
  const file = new OggFileBuilder({ preSkip: 312, channels: 6 })
    .writeHeaders()
    .writeAudioPackets(packets, { finalPageTrim: 120 })
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.decodedSamples, 3840);
  assert.equal(r.playableSamples, 3840 - 120 - 312);
});

/* ----------------------------- invalid cases ---------------------------- */

test("family 1 header with a wrong stream count is rejected", () => {
  // 5.1 requires N=4; claim N=3 instead.
  const head = opusHeadFamily1({ channels: 6, streams: 3, coupled: 2 });
  const file = new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 header with a wrong coupled count is rejected", () => {
  const head = opusHeadFamily1({ channels: 6, streams: 4, coupled: 3 });
  const file = new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("coupled stream count above total stream count is rejected", () => {
  const head = opusHeadFamily1({ channels: 6, streams: 2, coupled: 3 });
  const file = new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 header with a wrong mapping octet is rejected", () => {
  const head = opusHeadFamily1({ channels: 6, mapping: { 5: 4 } }); // LFE slot must be 5
  const file = new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 header shorter than 21+C bytes is rejected", () => {
  const full = opusHeadFamily1({ channels: 6 });
  const head = full.subarray(0, full.length - 1);
  const file = new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 header with trailing mapping bytes is rejected", () => {
  const full = opusHeadFamily1({ channels: 6 });
  const head = new Uint8Array(full.length + 1);
  head.set(full, 0);
  const file = new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 zero stream count is rejected", () => {
  const head = opusHeadFamily1({ channels: 6, streams: 0, coupled: 0 });
  const file = new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 beyond 8 channels is rejected", () => {
  const head = opusHeadFamily1({ channels: 9, streams: 5, coupled: 4 });
  const file = new OggFileBuilder({ channels: 9 }).writeHeaders({ head }).build();
  expectFail(repair(file), "CHANNEL_MAPPING_INVALID", 0);
});

test("packet missing a declared substream is rejected as truncated", () => {
  // Header says N=4 (5.1) but the packet physically packs only 3.
  const three = multistreamPacket([
    stereoSubstream(31),
    stereoSubstream(31),
    monoSubstream(31),
  ]);
  const file = new OggFileBuilder({ preSkip: 0, channels: 6 })
    .writeHeaders()
    .writeAudioPackets([three])
    .build();
  expectFail(file, "SUBSTREAM_TRUNCATED", 2);
});

test("a self-delimited substream whose length overruns is rejected as truncated", () => {
  // First (delimited) substream claims a 200-byte frame but barely any
  // bytes follow, so it runs into the next substream / packet end.
  const badFirst = (() => {
    const toc = (31 << 3) | 0; // config 31, mono, code 0
    return Uint8Array.of(toc, 200, 0x42);
  })();
  const last = opusPacket({ config: 31, stereo: false, frameData: [new Uint8Array(1)] });
  const packet = new Uint8Array(badFirst.length + last.length);
  packet.set(badFirst, 0);
  packet.set(last, badFirst.length);
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
  expectFail(file, "SUBSTREAM_TRUNCATED", 2);
});

test("a final regular substream whose framing does not consume its bytes is rejected", () => {
  // RFC 7845 lets the last (regular-framed) substream consume every
  // remaining byte. A code-1 packet needs an even payload, so one stray
  // trailing byte must surface as a multistream framing error rather
  // than being silently accepted.
  const first = opusSelfDelimitedPacket({
    config: 31,
    stereo: true,
    code: 1,
    frameData: [new Uint8Array(2)],
  });
  const lastEven = opusPacket({
    config: 31,
    stereo: false,
    code: 1,
    frameData: [new Uint8Array(2)],
  });
  const packet = new Uint8Array(first.length + lastEven.length + 1);
  packet.set(first, 0);
  packet.set(lastEven, first.length);
  packet[packet.length - 1] = 0;
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
  expectFail(file, "MULTISTREAM_PACKET_INVALID", 2);
});

test("a malformed final (regular) substream is rejected", () => {
  // Code 3 with M=0 frames.
  const badLast = Uint8Array.of((31 << 3) | 3, 0x00);
  const first = opusSelfDelimitedPacket({
    config: 31,
    stereo: true,
    frameData: [new Uint8Array(1)],
  });
  const packet = concat([first, badLast]);
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
  expectFail(file, "MULTISTREAM_PACKET_INVALID", 2);
});

test("coupled substream coded mono is a channel config mismatch", () => {
  const packet = multistreamPacket([
    monoSubstream(31), // stream 0 must be stereo for C=3 (M=1)
    monoSubstream(31),
  ]);
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
  expectFail(file, "CHANNEL_CONFIG_MISMATCH", 2);
});

test("uncoupled substream coded stereo is a channel config mismatch", () => {
  const packet = multistreamPacket([
    stereoSubstream(31),
    stereoSubstream(31), // stream 1 must be mono for C=3 (M=1)
  ]);
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
  expectFail(file, "CHANNEL_CONFIG_MISMATCH", 2);
});

test("substreams with different packet durations are rejected", () => {
  // Coupled stream: 20 ms (config 31). Mono stream: 2.5 ms (config 28).
  const packet = multistreamPacket([
    stereoSubstream(31),
    monoSubstream(28),
  ]);
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet, validPacket(3)])
    .build();
  expectFail(file, "SUBSTREAM_DURATION_MISMATCH", 2);
});

test("duration mismatch on the second audio page reports that page", () => {
  const packet = multistreamPacket([stereoSubstream(31), monoSubstream(28)]);
  const file = new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([validPacket(3), packet], { packetsPerPage: 1 })
    .build();
  expectFail(file, "SUBSTREAM_DURATION_MISMATCH", 3);
});

test("a cut-off multistream packet at EOS fails page CRC before parsing", () => {
  // Dropping trailing Ogg bytes is a page truncation; the dedicated
  // substream errors need structurally intact pages, which the other
  // cases above already cover.
  const file = validFamily1File(6, 3);
  expectFail(file.subarray(0, file.length - 4), "TRUNCATED_PAGE", 2);
});

test("family 1 stream without an EOS page is rejected", () => {
  const packets = [validPacket(6)];
  const file = new OggFileBuilder({ preSkip: 0, channels: 6 })
    .writeHeaders()
    .writeAudioPackets(packets, { eos: false })
    .build();
  expectFail(file, "STREAM_NOT_TERMINATED", 2);
});

/* ------------------------------- helpers -------------------------------- */

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Recompute every page CRC (header-only fixtures mutate the head page). */
function repair(buf: Uint8Array): Uint8Array {
  let off = 0;
  while (off < buf.length) {
    const nseg = buf[off + 26]!;
    const bodyLen = buf.subarray(off + 27, off + 27 + nseg).reduce((a, b) => a + b, 0);
    const end = off + 27 + nseg + bodyLen;
    buf[off + 22] = 0;
    buf[off + 23] = 0;
    buf[off + 24] = 0;
    buf[off + 25] = 0;
    const crc = oggCrc32(buf.subarray(off, end));
    buf[off + 22] = crc & 0xff;
    buf[off + 23] = (crc >>> 8) & 0xff;
    buf[off + 24] = (crc >>> 16) & 0xff;
    buf[off + 25] = (crc >>> 24) & 0xff;
    off = end;
  }
  return buf;
}
