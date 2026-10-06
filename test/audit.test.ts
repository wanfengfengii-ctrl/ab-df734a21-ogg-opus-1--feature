import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { auditOggOpus, AuditError } from "../src/audit.ts";
import { oggCrc32 } from "../src/crc32ogg.ts";
import {
  buildRawPage,
  FLAG_BOS,
  FLAG_CONTINUED,
  FLAG_EOS,
  lacePackets,
  OggFileBuilder,
  opusHead,
  opusPacket,
  opusTags,
} from "./helpers/oggBuilder.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Standard small valid mono stream: 10 packets of 20 ms = 9600 samples. */
function validFile(options: { channels?: 1 | 2; preSkip?: number } = {}): Uint8Array {
  const channels = options.channels ?? 1;
  const packets = Array.from({ length: 10 }, () =>
    opusPacket({ config: 31, stereo: channels === 2, frameData: [new Uint8Array([0x20])] }),
  );
  return new OggFileBuilder({ preSkip: options.preSkip ?? 312, channels })
    .writeHeaders()
    .writeAudioPackets(packets)
    .build();
}

/** Recompute every page CRC after a semantic mutation. */
function fixCrcs(buf: Uint8Array): Uint8Array {
  let off = 0;
  while (off < buf.length) {
    const nseg = buf[off + 26]!;
    const bodyLen = buf
      .subarray(off + 27, off + 27 + nseg)
      .reduce((a, b) => a + b, 0);
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

test("valid mono stream reports stable page/packet/sample statistics", () => {
  const file = validFile();
  const a = auditOggOpus(file);
  const b = auditOggOpus(file);
  assert.deepEqual(a, b);
  assert.equal(a.pageCount, 3);
  assert.equal(a.audioPacketCount, 10);
  assert.equal(a.decodedSamples, 9600);
  assert.equal(a.playableSamples, 9600 - 312);
});

test("real libopus-encoded fixture matches probe-level expectations", () => {
  const golden = readFileSync(join(here, "fixtures", "golden_mono.opus"));
  const r = auditOggOpus(new Uint8Array(golden));
  assert.equal(r.pageCount, 3);
  assert.equal(r.audioPacketCount, 26);
  assert.equal(r.decodedSamples, 24960);
  assert.equal(r.playableSamples, 24000); // exactly 0.5 s at 48 kHz
});

test("cross-page audio packet counts once with granule -1 on the open page", () => {
  // Big code-3 packet, split at a 255 boundary, flanked by normal packets.
  const bigFrames = Array.from({ length: 6 }, () => new Uint8Array(120)); // > 510 bytes
  const big = opusPacket({ config: 28, code: 3, frameData: bigFrames }); // 720+2 bytes
  const before = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const after = opusPacket({ config: 31, frameData: [new Uint8Array([2])] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeSpanningAudio([before, big, after], 1)
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.pageCount, 4); // head, tags, open page, continuation page
  assert.equal(r.audioPacketCount, 3);
  assert.equal(r.decodedSamples, 960 + 120 * 6 + 960);
  assert.equal(r.playableSamples, r.decodedSamples);
});

test("EOS end-trim reduces playable but not decoded samples", () => {
  const packets = Array.from({ length: 5 }, () =>
    opusPacket({ config: 31, frameData: [new Uint8Array([0x10])] }),
  );
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeAudioPackets(packets, { finalPageTrim: 123 })
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.decodedSamples, 4800);
  assert.equal(r.playableSamples, 4800 - 123);
});

test("audio packets spread several packets per page accumulate correctly", () => {
  const packets = Array.from({ length: 12 }, () =>
    opusPacket({ config: 28, frameData: [new Uint8Array([1])] }),
  );
  const file = new OggFileBuilder({ preSkip: 10 })
    .writeHeaders()
    .writeAudioPackets(packets, { packetsPerPage: 5 })
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.pageCount, 5); // head, tags, 5+5+2
  assert.equal(r.audioPacketCount, 12);
  assert.equal(r.decodedSamples, 12 * 120);
  assert.equal(r.playableSamples, 12 * 120 - 10);
});

test("OpusTags may span multiple pages with -1 then zero granule", () => {
  const tags = opusTags("x".repeat(300));
  const cut = 255; // lacing boundary
  const headOnly = new OggFileBuilder().writeRawPages([
    {
      flags: FLAG_BOS,
      granule: 0n,
      ...pagePayload([opusHead()]),
    },
  ]);
  const page2 = buildRawPage({
    sequence: 1,
    flags: 0,
    granule: -1n,
    segments: new Uint8Array([255]),
    body: tags.subarray(0, cut),
  });
  const page3 = buildRawPage({
    sequence: 2,
    flags: FLAG_CONTINUED,
    granule: 0n,
    segments: new Uint8Array([tags.length - cut]),
    body: tags.subarray(cut),
  });
  const audio = opusPacket({ config: 31, frameData: [new Uint8Array([3])] });
  const lacing = lacePackets([audio]);
  const page4 = buildRawPage({
    sequence: 3,
    flags: FLAG_EOS,
    granule: 960n,
    segments: Uint8Array.from(lacing.segments),
    body: lacing.body,
  });
  const file = concatBytes([headOnly.build(), page2, page3, page4]);
  const r = auditOggOpus(file);
  assert.equal(r.audioPacketCount, 1);
  assert.equal(r.decodedSamples, 960);
});

test("a leading granule (joined stream offset) is rejected in archive mode", () => {
  const p1 = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const p2 = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeRawPages([
      { flags: 0, granule: 100000n + 960n, ...pagePayload([p1]) },
      { flags: FLAG_EOS, granule: 100000n + 1920n, ...pagePayload([p2]) },
    ])
    .build();
  expectFail(file, "GRANULE_MISMATCH", 2);
});

test("nil EOS page carries the final granule without packets", () => {
  const p = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeRawPages([
      { flags: 0, granule: 960n, ...pagePayload([p]) },
      { flags: FLAG_EOS, granule: 960n, segments: [], body: new Uint8Array(0) },
    ])
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.playableSamples, 960);
  assert.equal(r.audioPacketCount, 1);
});

/* ----------------------------- error cases ----------------------------- */

test("empty input is a 400-level error", () => {
  try {
    auditOggOpus(new Uint8Array(0));
    assert.fail();
  } catch (e) {
    assert.equal((e as AuditError).status, 400);
    assert.equal((e as AuditError).code, "EMPTY_INPUT");
  }
});

test("body over 8 MiB is a 413-level error", () => {
  try {
    auditOggOpus(new Uint8Array(8 * 1024 * 1024 + 1));
    assert.fail();
  } catch (e) {
    assert.equal((e as AuditError).status, 413);
    assert.equal((e as AuditError).code, "PAYLOAD_TOO_LARGE");
  }
});

test("bad capture pattern fails on the offending page", () => {
  const file = validFile();
  file[0] = 0x00;
  fixCrcs(file); // keep CRC honest so the magic itself is the failure
  expectFail(file, "BAD_CAPTURE_PATTERN", 0);
});

test("unsupported Ogg version fails", () => {
  const file = validFile();
  file[4] = 1;
  fixCrcs(file);
  expectFail(file, "UNSUPPORTED_OGG_VERSION", 0);
});

test("reserved header flag bits fail", () => {
  const file = validFile();
  file[5] = 0x80;
  fixCrcs(file);
  expectFail(file, "RESERVED_HEADER_FLAG", 0);
});

test("a body byte flip is caught by the page CRC", () => {
  const file = validFile();
  // Flip a byte inside the audio page body.
  file[file.length - 5]! ^= 0xff;
  expectFail(file, "BAD_CRC", 2);
});

test("truncated final page is reported", () => {
  const file = validFile();
  expectFail(file.subarray(0, file.length - 10), "TRUNCATED_PAGE", 2);
});

test("truncated mid-page header is reported", () => {
  const file = validFile();
  // Find start of page 2 and cut its header short.
  const page1End = pageOffset(file, 1);
  expectFail(file.subarray(0, page1End + 10), "TRUNCATED_PAGE", 1);
});

test("first page without BOS fails", () => {
  const file = validFile();
  file[5] = 0; // strip BOS
  fixCrcs(file);
  expectFail(file, "BOS_FLAG_INVALID", 0);
});

test("BOS and EOS together on the first page fail", () => {
  const file = validFile();
  file[5] = FLAG_BOS | FLAG_EOS;
  fixCrcs(file);
  expectFail(file, "EOS_FLAG_INVALID", 0);
});

test("BOS flag on a later page fails", () => {
  const file = validFile();
  const off = pageOffset(file, 1);
  file[off + 5] = FLAG_BOS;
  fixCrcs(file);
  expectFail(file, "BOS_FLAG_INVALID", 1);
});

test("a page after EOS fails", () => {
  const p1 = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const p2 = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeRawPages([
      { flags: FLAG_EOS, granule: 960n, ...pagePayload([p1]) },
      { flags: 0, granule: 1920n, ...pagePayload([p2]) },
    ])
    .build();
  expectFail(file, "EOS_FLAG_INVALID", 3);
});

test("serial number mismatch fails", () => {
  const file = validFile();
  const off = pageOffset(file, 2);
  file[off + 14] = 0x01;
  fixCrcs(file);
  expectFail(file, "SERIAL_NUMBER_MISMATCH", 2);
});

test("sequence number gap fails", () => {
  const file = validFile();
  const off = pageOffset(file, 2);
  file[off + 18] = 5;
  fixCrcs(file);
  expectFail(file, "PAGE_SEQUENCE_INVALID", 2);
});

test("open packet without continuation flag on next page fails", () => {
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const cut = 510;
  const head = new OggFileBuilder().writeHeaders().build();
  const p2 = buildRawPage({
    sequence: 2,
    flags: 0,
    granule: -1n,
    segments: new Uint8Array([255, 255]),
    body: big.subarray(0, cut),
  });
  const remainder = big.subarray(cut);
  const restLacing = lacePackets([remainder]);
  const p3 = buildRawPage({
    sequence: 3,
    flags: FLAG_EOS, // missing FLAG_CONTINUED
    granule: 720n,
    segments: Uint8Array.from(restLacing.segments),
    body: restLacing.body,
  });
  const file = concatBytes([head, p2, p3]);
  expectFail(file, "CONTINUATION_FLAG_INVALID", 3);
});

test("continuation flag without an open packet fails", () => {
  const p = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const lacing = pagePayload([p]);
  const file = new OggFileBuilder()
    .writeHeaders()
    .writeRawPages([{ flags: FLAG_CONTINUED | FLAG_EOS, granule: 960n, ...lacing }])
    .build();
  expectFail(file, "CONTINUATION_FLAG_INVALID", 2);
});

test("OpusHead with bad magic fails", () => {
  const head = opusHead();
  head[0] = 0x00;
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  fixCrcs(file);
  expectFail(file, "ID_HEADER_INVALID", 0);
});

test("OpusHead version other than 1 fails", () => {
  const head = opusHead();
  head[8] = 2;
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  fixCrcs(file);
  expectFail(file, "ID_HEADER_INVALID", 0);
});

test("OpusHead with zero channels fails", () => {
  const head = opusHead();
  head[9] = 0;
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  fixCrcs(file);
  expectFail(file, "ID_HEADER_INVALID", 0);
});

test("unsupported channel mapping family fails", () => {
  const head = opusHead();
  head[18] = 2; // reserved family
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  fixCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_UNSUPPORTED", 0);
});

test("family 255 mapping still fails", () => {
  const head = opusHead();
  head[18] = 255;
  const file = new OggFileBuilder().writeHeaders({ head }).build();
  fixCrcs(file);
  expectFail(file, "CHANNEL_MAPPING_UNSUPPORTED", 0);
});

test("OpusTags with trailing bytes fails", () => {
  const tags = opusTags();
  const padded = new Uint8Array(tags.length + 1);
  padded.set(tags, 0);
  const file = new OggFileBuilder().writeHeaders({ tags: padded }).build();
  fixCrcs(file);
  expectFail(file, "COMMENT_HEADER_INVALID", 1);
});

test("playable samples clamp to zero when pre-skip exceeds the granule", () => {
  // EOS granule 960 is allowed above pre-skip 312, so craft a stream
  // whose final (and only) EOS granule is 312 exactly -> playable 0.
  const p = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 312 })
    .writeHeaders()
    .writeRawPages([{ flags: FLAG_EOS, granule: 312n, ...pagePayload([p]) }])
    .build();
  const r = auditOggOpus(file);
  assert.equal(r.decodedSamples, 960);
  assert.equal(r.playableSamples, 0);
});

test("OpusTags with bad magic fails", () => {
  const tags = opusTags();
  tags[0] = 0x00;
  const file = new OggFileBuilder().writeHeaders({ tags }).build();
  fixCrcs(file);
  expectFail(file, "COMMENT_HEADER_INVALID", 1);
});

test("OpusTags vendor length overrun fails", () => {
  const tags = opusTags();
  tags[8] = 0xff;
  tags[9] = 0xff;
  tags[10] = 0xff;
  tags[11] = 0x7f;
  const file = new OggFileBuilder().writeHeaders({ tags }).build();
  fixCrcs(file);
  expectFail(file, "COMMENT_HEADER_INVALID", 1);
});

test("nonzero granule on the ID header page fails", () => {
  const file = validFile();
  const off = pageOffset(file, 0);
  writeGranule(file, off, 5n);
  fixCrcs(file);
  expectFail(file, "HEADER_GRANULE_INVALID", 0);
});

test("nonzero granule on the OpusTags completion page fails", () => {
  const file = validFile();
  const off = pageOffset(file, 1);
  writeGranule(file, off, 9n);
  fixCrcs(file);
  expectFail(file, "HEADER_GRANULE_INVALID", 1);
});

test("page sharing audio with OpusTags completion fails", () => {
  const tags = opusTags();
  const audio = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const lacing = lacePackets([tags, audio]);
  const head = new OggFileBuilder().writeHeaders().build();
  const badPage = buildRawPage({
    sequence: 1,
    flags: 0,
    granule: 0n,
    segments: Uint8Array.from(lacing.segments),
    body: lacing.body,
  });
  const file = concatBytes([head.subarray(0, pageOffset(head, 1)), badPage]);
  expectFail(file, "COMMENT_HEADER_INVALID", 1);
});

test("audio packet stereo flag must match OpusHead channels", () => {
  const file = new OggFileBuilder({ channels: 2 })
    .writeHeaders()
    .writeAudioPackets([opusPacket({ config: 31, stereo: false })])
    .build();
  expectFail(file, "CHANNEL_CONFIG_MISMATCH", 2);
});

test("zero-octet audio packet fails", () => {
  const empty = new Uint8Array(0);
  const lacing = lacePackets([empty]);
  const file = new OggFileBuilder()
    .writeHeaders()
    .writeRawPages([{ flags: FLAG_EOS, granule: 0n, ...lacing }])
    .build();
  expectFail(file, "OPUS_PACKET_INVALID", 2);
});

test("malformed Opus packet (code 3, 140 ms) fails", () => {
  const bad = opusPacket({
    config: 31,
    code: 3,
    frameCount: 7,
    frameData: Array.from({ length: 7 }, () => new Uint8Array(1)),
  });
  const file = new OggFileBuilder()
    .writeHeaders()
    .writeRawPages([{ flags: FLAG_EOS, granule: 0n, ...pagePayload([bad]) }])
    .build();
  expectFail(file, "OPUS_PACKET_INVALID", 2);
});

test("open audio page must carry granule -1", () => {
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const cut = 510;
  const head = new OggFileBuilder().writeHeaders().build();
  const p2 = buildRawPage({
    sequence: 2,
    flags: 0,
    granule: 123n, // wrong: must be -1
    segments: new Uint8Array([255, 255]),
    body: big.subarray(0, cut),
  });
  const file = concatBytes([head, p2]);
  expectFail(file, "GRANULE_SPAN_INVALID", 2);
});

test("page completing packets must not carry granule -1", () => {
  const p = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder()
    .writeHeaders()
    .writeRawPages([{ flags: FLAG_EOS, granule: -1n, ...pagePayload([p]) }])
    .build();
  expectFail(file, "GRANULE_MISSING", 2);
});

test("non-EOS audio page granule must equal accumulated samples", () => {
  const packets = Array.from({ length: 6 }, () =>
    opusPacket({ config: 31, frameData: [new Uint8Array([1])] }),
  );
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeAudioPackets(packets, { packetsPerPage: 2 })
    .build();
  // Page index 3 is the middle (non-EOS) audio page: corrupt its granule.
  const off = pageOffset(file, 3);
  writeGranule(file, off, 1921n);
  fixCrcs(file);
  expectFail(file, "GRANULE_MISMATCH", 3);
});

test("first audio granule below accumulated samples fails", () => {
  const p = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeRawPages([{ flags: 0, granule: 10n, ...pagePayload([p]) }])
    .build();
  expectFail(file, "GRANULE_MISMATCH", 2);
});

test("EOS granule cannot trim past the previous granule", () => {
  const p1 = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const p2 = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeRawPages([
      { flags: 0, granule: 960n, ...pagePayload([p1]) },
      { flags: FLAG_EOS, granule: 900n, ...pagePayload([p2]) },
    ])
    .build();
  expectFail(file, "EOS_GRANULE_INVALID", 3);
});

test("EOS granule cannot exceed accumulated decoded samples", () => {
  const p = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeRawPages([{ flags: FLAG_EOS, granule: 5000n, ...pagePayload([p]) }])
    .build();
  expectFail(file, "EOS_GRANULE_INVALID", 2);
});

test("single-page EOS granule below pre-skip fails", () => {
  const p = opusPacket({ config: 31, frameData: [new Uint8Array([1])] });
  const file = new OggFileBuilder({ preSkip: 312 })
    .writeHeaders()
    .writeRawPages([{ flags: FLAG_EOS, granule: 100n, ...pagePayload([p]) }])
    .build();
  expectFail(file, "EOS_GRANULE_INVALID", 2);
});

test("stream without an EOS page fails as truncated", () => {
  const packets = [opusPacket({ config: 31, frameData: [new Uint8Array([1])] })];
  const file = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeAudioPackets(packets, { eos: false })
    .build();
  expectFail(file, "STREAM_NOT_TERMINATED", 2);
});

test("EOS page ending inside an open packet fails", () => {
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const cut = 510;
  const head = new OggFileBuilder().writeHeaders().build();
  const p2 = buildRawPage({
    sequence: 2,
    flags: FLAG_EOS,
    granule: -1n,
    segments: new Uint8Array([255, 255]),
    body: big.subarray(0, cut),
  });
  const file = concatBytes([head, p2]);
  expectFail(file, "AUDIO_PACKET_TRUNCATED", 2);
});

test("input ending with a still-open packet (no EOS) fails as truncated", () => {
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const cut = 510;
  const head = new OggFileBuilder().writeHeaders().build();
  const p2 = buildRawPage({
    sequence: 2,
    flags: 0, // no EOS, packet never closes
    granule: -1n,
    segments: new Uint8Array([255, 255]),
    body: big.subarray(0, cut),
  });
  const file = concatBytes([head, p2]);
  expectFail(file, "AUDIO_PACKET_TRUNCATED", 2);
});

test("more than 2048 pages fails", () => {
  const builder = new OggFileBuilder({ preSkip: 0 }).writeHeaders();
  // 2047 audio pages are allowed (2 + 2047 = 2049 pages total triggers
  // the cap on page index 2048).
  const specs = Array.from({ length: 2047 }, (_unused, i) => ({
    flags: i === 2046 ? FLAG_EOS : 0,
    granule: BigInt((i + 1) * 120),
    ...pagePayload([opusPacket({ config: 28, frameData: [new Uint8Array([1])] })]),
  }));
  builder.writeRawPages(specs);
  expectFail(builder.build(), "TOO_MANY_PAGES", 2048);
});

/* ------------------------------- helpers ------------------------------- */

function pagePayload(packets: Uint8Array[]): { segments: number[]; body: Uint8Array } {
  const lacing = lacePackets(packets);
  return { segments: lacing.segments, body: lacing.body };
}

function pageOffset(buf: Uint8Array, wanted: number): number {
  let off = 0;
  let idx = 0;
  while (idx < wanted) {
    const nseg = buf[off + 26]!;
    const bodyLen = buf
      .subarray(off + 27, off + 27 + nseg)
      .reduce((a, b) => a + b, 0);
    off = off + 27 + nseg + bodyLen;
    idx += 1;
  }
  return off;
}

function writeGranule(buf: Uint8Array, pageStart: number, value: bigint): void {
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    buf[pageStart + 6 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

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
