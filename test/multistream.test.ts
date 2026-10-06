import { test } from "node:test";
import assert from "node:assert/strict";
import { auditOggOpus, AuditError } from "../src/audit.ts";
import {
  buildRawPage,
  findPageOffset,
  FLAG_EOS,
  lacePackets,
  multistreamPacket,
  OggFileBuilder,
  opusHeadFamily1,
  opusPacket,
  FAMILY1_STANDARD,
  repairAllCrcs,
  writePageGranule,
  type MultistreamSubpacket,
} from "./helpers/oggBuilder.ts";

const byte = (value: number): Uint8Array => new Uint8Array([value]);

/** Family-1 head for the standard N/M/mapping of `channels` outputs. */
function standardHead(channels: number, preSkip = 0): Uint8Array {
  const spec = FAMILY1_STANDARD[channels]!;
  return opusHeadFamily1({ channels, ...spec, preSkip });
}

/** One well-formed multistream Ogg packet for a standard declaration. */
function standardPacket(channels: number, sub: Partial<MultistreamSubpacket> = {}): Uint8Array {
  const spec = FAMILY1_STANDARD[channels]!;
  const make = (stereo: boolean): MultistreamSubpacket => ({
    config: 31,
    frameData: [byte(0x10)],
    ...sub,
    stereo,
  });
  return multistreamPacket([
    ...Array.from({ length: spec.coupledCount }, () => make(true)),
    ...Array.from({ length: spec.streamCount - spec.coupledCount }, () => make(false)),
  ]);
}

function standardFile(
  channels: number,
  packets: Uint8Array[],
  options: { preSkip?: number; finalPageTrim?: number; packetsPerPage?: number } = {},
): Uint8Array {
  const writer = new OggFileBuilder({ preSkip: options.preSkip ?? 0 })
    .writeHeaders({ head: standardHead(channels, options.preSkip ?? 0) });
  writer.writeAudioPackets(packets, {
    ...(options.finalPageTrim !== undefined ? { finalPageTrim: options.finalPageTrim } : {}),
    ...(options.packetsPerPage !== undefined ? { packetsPerPage: options.packetsPerPage } : {}),
  });
  return writer.build();
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

/* ------------------------------- valid cases ---------------------------- */

test("family 1 with 1..8 channels all audit and keep stable statistics", () => {
  for (const channels of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const packets = Array.from({ length: 5 }, () => standardPacket(channels));
    const file = standardFile(channels, packets);
    const a = auditOggOpus(file);
    const b = auditOggOpus(file);
    assert.deepEqual(a, b, `channels=${channels}`);
    assert.equal(a.pageCount, 3, `channels=${channels}`);
    assert.equal(a.audioPacketCount, 5, `channels=${channels}`);
    assert.equal(a.decodedSamples, 5 * 960, `channels=${channels}`); // counted once per Ogg packet
    assert.equal(a.playableSamples, 5 * 960, `channels=${channels}`);
  }
});

test("5.1 (four streams, two coupled) accepts mixed TOC codes incl. VBR and padding", () => {
  const packet = multistreamPacket([
    { config: 31, stereo: true, code: 3, frameCount: 2, frameData: [byte(1), byte(1)] },
    { config: 31, stereo: true, code: 1, frameData: [byte(2)] },
    { config: 31, stereo: false, code: 2, frameData: [byte(3), byte(4)] },
    { config: 31, stereo: false, code: 3, frameCount: 2, frameData: [byte(5), byte(6)] },
  ]);
  const file = standardFile(6, [packet]);
  const r = auditOggOpus(file);
  assert.equal(r.audioPacketCount, 1);
  assert.equal(r.decodedSamples, 1920); // two 20 ms frames, counted once
});

test("self-delimited code 3 VBR and long padding stay inside their boundary", () => {
  const packet = multistreamPacket([
    {
      config: 28,
      stereo: true,
      code: 3,
      vbr: true,
      frameData: [byte(1), byte(2), byte(3), byte(4), byte(5), byte(6)],
    },
    {
      config: 28,
      stereo: false,
      code: 3,
      padding: 300,
      frameCount: 6,
      frameData: Array.from({ length: 6 }, () => byte(7)),
    },
  ]);
  const file = standardFile(3, [packet]);
  assert.equal(auditOggOpus(file).decodedSamples, 720); // 6 * 2.5 ms per substream
});

test("a large multistream packet spanning Ogg pages is counted once", () => {
  const bigFrames = Array.from({ length: 6 }, () => new Uint8Array(120));
  const packet = multistreamPacket([
    { config: 28, stereo: true, code: 3, frameData: bigFrames },
    { config: 28, stereo: false, code: 3, frameData: bigFrames },
  ]);
  const before = standardPacket(3, { config: 31, frameData: [byte(1)] });
  const after = standardPacket(3, { config: 31, frameData: [byte(2)] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head: standardHead(3) })
    .writeSpanningAudio([before, packet, after], 1)
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.pageCount, 4); // head, tags, open page, continuation page
  assert.equal(r.audioPacketCount, 3);
  assert.equal(r.decodedSamples, 960 + 720 + 960);
  assert.equal(r.playableSamples, r.decodedSamples);
});

test("several multistream packets per page accumulate once each", () => {
  const packets = Array.from({ length: 12 }, () => standardPacket(6, {
    config: 28,
    frameData: [byte(1)],
  }));
  const file = standardFile(6, packets, { preSkip: 10, packetsPerPage: 5 });
  const r = auditOggOpus(file);
  assert.equal(r.pageCount, 5);
  assert.equal(r.audioPacketCount, 12);
  assert.equal(r.decodedSamples, 12 * 120);
  assert.equal(r.playableSamples, 12 * 120 - 10);
});

test("EOS end-trim and pre-skip rules are unchanged for family 1", () => {
  const packets = Array.from({ length: 5 }, () => standardPacket(8));
  const file = standardFile(8, packets, { preSkip: 312, finalPageTrim: 123 });
  const r = auditOggOpus(file);
  assert.equal(r.decodedSamples, 4800);
  assert.equal(r.playableSamples, 4800 - 312 - 123);
});

test("a non-standard but valid mapping (duplicated outputs) is accepted", () => {
  // N = 2, M = 0 (both mono), 4 outputs all driven by the two streams;
  // index 2*M+k maps to mono stream k.
  const head = opusHeadFamily1({
    channels: 4,
    streamCount: 2,
    coupledCount: 0,
    mapping: [0, 1, 0, 1],
    preSkip: 0,
  });
  const packet = multistreamPacket([
    { config: 31, stereo: false, frameData: [byte(1)] },
    { config: 31, stereo: false, frameData: [byte(2)] },
  ]);
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head })
    .writeAudioPackets([packet])
    .build();
  assert.equal(auditOggOpus(file).decodedSamples, 960);
});

/* ----------------------- invalid OpusHead declarations ------------------- */

test("family 1 OpusHead shorter than its mapping table fails", () => {
  const head = standardHead(6).subarray(0, 21 + 6 - 1);
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  repairAllCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 OpusHead with trailing bytes fails", () => {
  const base = standardHead(6);
  const head = new Uint8Array(base.length + 1);
  head.set(base, 0);
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  repairAllCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 with zero streams fails", () => {
  const head = opusHeadFamily1({
    channels: 3,
    streamCount: 0,
    coupledCount: 0,
    mapping: [255, 255, 255],
    preSkip: 0,
  });
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  repairAllCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_INVALID", 0);
});

test("coupled stream count above the total stream count fails", () => {
  const head = opusHeadFamily1({
    channels: 3,
    streamCount: 1,
    coupledCount: 2,
    mapping: [0, 1, 2],
    preSkip: 0,
  });
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  repairAllCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_INVALID", 0);
});

test("stream plus coupled count beyond 255 decoded channels fails", () => {
  const head = opusHeadFamily1({
    channels: 3,
    streamCount: 200,
    coupledCount: 200,
    mapping: [0, 1, 2],
    preSkip: 0,
  });
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  repairAllCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_INVALID", 0);
});

test("family 1 with more than eight output channels fails", () => {
  const head = opusHeadFamily1({
    channels: 9,
    streamCount: 6,
    coupledCount: 3,
    mapping: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    preSkip: 0,
  });
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  repairAllCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_INVALID", 0);
});

test("a silence (255) mapping entry is accepted", () => {
  // One coupled stereo stream feeds outputs 0/1; output 2 is silent.
  const head = opusHeadFamily1({
    channels: 3,
    streamCount: 1,
    coupledCount: 1,
    mapping: [0, 1, 255],
    preSkip: 0,
  });
  const packet = multistreamPacket([
    { config: 31, stereo: true, frameData: [byte(1)] },
  ]);
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head })
    .writeAudioPackets([packet])
    .build();
  assert.equal(auditOggOpus(file).decodedSamples, 960);
});

test("a mapping index past the decoded channels fails", () => {
  // N = 2, M = 0 -> decoded channels 0 and 1; index 2 is out of range.
  const head = opusHeadFamily1({
    channels: 3,
    streamCount: 2,
    coupledCount: 0,
    mapping: [0, 1, 2],
    preSkip: 0,
  });
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  repairAllCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_INVALID", 0);
});

test("a declared stream absent from the outputs is accepted", () => {
  // RFC 7845 5.1.1 explicitly permits decoded channels with no output.
  // N = 2 mono streams, but only stream 0 feeds both outputs.
  const head = opusHeadFamily1({
    channels: 2,
    streamCount: 2,
    coupledCount: 0,
    mapping: [0, 0],
    preSkip: 0,
  });
  const packet = multistreamPacket([
    { config: 31, stereo: false, frameData: [byte(1)] },
    { config: 31, stereo: false, frameData: [byte(2)] },
  ]);
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head })
    .writeAudioPackets([packet])
    .build();
  assert.equal(auditOggOpus(file).decodedSamples, 960);
});

test("families other than 0 and 1 remain unsupported", () => {
  for (const family of [2, 100, 254, 255]) {
    const base = standardHead(3);
    base[18] = family;
    const file = new OggFileBuilder().writeHeaders({ head: base }).build();
    repairAllCrcs(file);
    expectFail(file, "CHANNEL_MAPPING_UNSUPPORTED", 0);
  }
});

/* ------------------------------ audio failures --------------------------- */

test("a missing final substream is reported on the failing page", () => {
  const good = standardPacket(6);
  // Rebuild the EOS audio page with the final (2-byte code 0) substream
  // removed: the declared streams can no longer all begin inside the
  // Ogg packet boundary.
  const cut = good.subarray(0, good.length - 2);
  const lacing = lacePackets([cut]);
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head: standardHead(6) })
    .writeRawPages([
      { flags: FLAG_EOS, granule: 960n, segments: lacing.segments, body: lacing.body },
    ])
    .build();
  repairAllCrcs(file);
  expectFail(file, "SUBSTREAM_TRUNCATED", 2);
});

test("a self-delimiting length overrunning its packet is a truncation", () => {
  const packet = standardPacket(6);
  // First substream starts with TOC then a 1-byte frame length (code 0).
  assert.equal(packet[0]! & 0x03, 0);
  packet[1] = 200; // claims 200 frame bytes the packet does not contain
  const file = standardFile(6, [packet]);
  repairAllCrcs(file);
  expectFail(file, "SUBSTREAM_TRUNCATED", 2);
});

test("a desynced substream boundary surfaces as a duration mismatch", () => {
  const good = standardPacket(3);
  // Substream 0 is a self-delimited code 0 packet laid out as
  // [TOC, frame length, frame]. Understating the length shifts the next
  // TOC into the frame run, so the following substream decodes a
  // different duration and cannot be a coherent packet.
  good[1] = 0;
  const file = standardFile(3, [good]);
  repairAllCrcs(file);
  expectFail(file, "SUBSTREAM_DURATION_MISMATCH", 2);
});

test("truncation on a later audio page reports that page", () => {
  const packets = Array.from({ length: 4 }, () => standardPacket(6));
  const file = standardFile(6, packets, { packetsPerPage: 1 }); // audio pages 2..5
  const page3 = findPageOffset(file, 3);
  const before = file.subarray(0, page3); // pages 0..2
  // Rebuild page 3 with its audio packet shortened by two bytes; the
  // missing EOS later is irrelevant because this page fails first.
  const cut = packets[1]!.subarray(0, packets[1]!.length - 2);
  const lacing = lacePackets([cut]);
  const rebuilt = buildRawPage({
    sequence: 3,
    flags: 0,
    granule: 960n * 2n,
    segments: Uint8Array.from(lacing.segments),
    body: lacing.body,
  });
  expectFail(concatBytes([before, rebuilt]), "SUBSTREAM_TRUNCATED", 3);
});

test("a coupled substream flagged mono fails the channel configuration", () => {
  const spec = FAMILY1_STANDARD[6]!;
  const packet = multistreamPacket([
    ...Array.from({ length: spec.coupledCount }, (_, i) => ({
      config: 31,
      stereo: i !== 0, // first coupled stream wrongly mono
      frameData: [byte(1)],
    })),
    ...Array.from({ length: spec.streamCount - spec.coupledCount }, () => ({
      config: 31,
      stereo: false,
      frameData: [byte(2)],
    })),
  ]);
  const file = standardFile(6, [packet]);
  expectFail(file, "CHANNEL_CONFIG_MISMATCH", 2);
});

test("a mono substream flagged stereo fails the channel configuration", () => {
  const spec = FAMILY1_STANDARD[6]!;
  const packet = multistreamPacket([
    ...Array.from({ length: spec.coupledCount }, () => ({
      config: 31,
      stereo: true,
      frameData: [byte(1)],
    })),
    ...Array.from({ length: spec.streamCount - spec.coupledCount }, (_, i) => ({
      config: 31,
      stereo: i === 0, // first mono stream wrongly stereo
      frameData: [byte(2)],
    })),
  ]);
  const file = standardFile(6, [packet]);
  expectFail(file, "CHANNEL_CONFIG_MISMATCH", 2);
});

test("substreams with different decoded sample counts are rejected", () => {
  const packet = multistreamPacket([
    { config: 31, stereo: true, frameData: [byte(1)] }, // 960 samples
    { config: 28, stereo: false, frameData: [byte(2)] }, // 120 samples
  ]);
  const file = standardFile(3, [packet]);
  expectFail(file, "SUBSTREAM_DURATION_MISMATCH", 2);
});

test("substream duration mismatch on a later page reports that page", () => {
  const packets = [
    standardPacket(3),
    multistreamPacket([
      { config: 31, stereo: true, code: 3, frameCount: 2, frameData: [byte(1), byte(1)] },
      { config: 31, stereo: false, frameData: [byte(2)] },
    ]),
  ];
  const file = standardFile(3, packets, { packetsPerPage: 1 });
  expectFail(file, "SUBSTREAM_DURATION_MISMATCH", 3);
});

test("a malformed Opus substream is OPUS_PACKET_INVALID", () => {
  // code 3 with zero frames in the final (ordinary-framed) substream.
  const packet = multistreamPacket([
    { config: 31, stereo: true, frameData: [byte(1)] },
    { config: 31, stereo: false, frameData: [byte(2)] },
  ]);
  // Replace final substream TOC+M with a code 3 M=0 pair of bytes.
  packet[packet.length - 2] = (31 << 3) | 3;
  packet[packet.length - 1] = 0x00;
  const file = standardFile(3, [packet]);
  repairAllCrcs(file);
  expectFail(file, "OPUS_PACKET_INVALID", 2);
});

test("an EOS multistream page ending inside an open packet is truncated", () => {
  const big = standardPacket(8, {
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const head = new OggFileBuilder().writeHeaders({ head: standardHead(8) }).build();
  const openEos = buildRawPage({
    sequence: 2,
    flags: FLAG_EOS,
    granule: -1n,
    segments: new Uint8Array([255, 255]),
    body: big.subarray(0, 510),
  });
  expectFail(concatBytes([head, openEos]), "AUDIO_PACKET_TRUNCATED", 2);
});

test("family 1 audio pages still obey the granule timeline", () => {
  const packets = Array.from({ length: 6 }, () => standardPacket(6));
  const file = standardFile(6, packets, { packetsPerPage: 2 });
  // Page 3 is a middle (non-EOS) page; bump its granule by one.
  writePageGranule(file, findPageOffset(file, 3), 1921n);
  repairAllCrcs(file);
  expectFail(file, "GRANULE_MISMATCH", 3);
});

test("EOS granule trim beyond the previous granule is still rejected", () => {
  const p1 = standardPacket(6);
  const p2 = standardPacket(6);
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head: standardHead(6) })
    .writeRawPages([
      { flags: 0, granule: 960n, ...lacePackets([p1]) },
      { flags: FLAG_EOS, granule: 900n, ...lacePackets([p2]) },
    ])
    .build();
  expectFail(file, "EOS_GRANULE_INVALID", 3);
});

/* ------------------------------ family 0 parity -------------------------- */

test("family 0 mono requests still take the single-stream path", () => {
  const packet = opusPacket({ config: 31, frameData: [byte(1)] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.audioPacketCount, 1);
  assert.equal(r.decodedSamples, 960);
});

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
