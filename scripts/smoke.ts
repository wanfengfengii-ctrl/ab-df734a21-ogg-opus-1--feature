/**
 * HTTP smoke test run once by the `verify` Compose service after the
 * API is healthy. It exercises the real server over HTTP, including an
 * audio packet split across Ogg pages and every documented failure
 * class, then exits non-zero if anything does not behave.
 */

import {
  buildRawPage,
  FLAG_EOS,
  monoSubstream,
  multistreamPacket,
  OggFileBuilder,
  opusHeadFamily1,
  opusPacket,
  stereoSubstream,
} from "../test/helpers/oggBuilder.ts";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function postAudit(body: Uint8Array, contentType = "audio/ogg"): Promise<{
  status: number;
  json: any;
}> {
  const res = await fetch(`${BASE_URL}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        console.log(`api healthy at ${BASE_URL}`);
        return;
      }
      lastError = `status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`api never became healthy: ${lastError}`);
}

function validSpanningStream(): Uint8Array {
  // A 722-byte code-3 packet (six 120-byte frames) cannot fit on one
  // lacing boundary run without a 255 edge, so it is forced across two
  // pages with a granule of -1 on the open page.
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const before = opusPacket({ config: 31, frameData: [new Uint8Array([7])] });
  const after = opusPacket({ config: 31, frameData: [new Uint8Array([9])] });
  return new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeSpanningAudio([before, big, after], 1)
    .build();
}

function corruptCrc(stream: Uint8Array): Uint8Array {
  const copy = stream.slice();
  // Flip a byte in the last page's body without updating its CRC.
  copy[copy.length - 3]! ^= 0x01;
  return copy;
}

function unclosedPacketStream(): Uint8Array {
  const big = opusPacket({
    config: 28,
    code: 3,
    frameData: Array.from({ length: 6 }, () => new Uint8Array(120)),
  });
  const head = new OggFileBuilder().writeHeaders().build();
  const openEosPage = buildRawPage({
    sequence: 2,
    flags: FLAG_EOS,
    granule: -1n,
    segments: new Uint8Array([255, 255]),
    body: big.subarray(0, 510),
  });
  const out = new Uint8Array(head.length + openEosPage.length);
  out.set(head, 0);
  out.set(openEosPage, head.length);
  return out;
}

function granuleContradictionStream(): Uint8Array {
  const packets = Array.from({ length: 6 }, () =>
    opusPacket({ config: 31, frameData: [new Uint8Array([1])] }),
  );
  const stream = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders()
    .writeAudioPackets(packets, { packetsPerPage: 2 })
    .build();
  // Bump the middle audio page (index 3) granule by one, then repair
  // CRCs so only the timeline contradiction remains.
  const off = pageOffset(stream, 3);
  // Rewrite the middle audio page granule to 1921 (should be 1920),
  // then repair its CRC so only the timeline contradiction remains.
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  view.setBigUint64(off + 6, 1921n, true);
  repairPageCrc(stream, off);
  return stream;
}

/* ----------------------- mapping family 1 fixtures ---------------------- */

/** One well-formed 5.1 (6 channels, N=4, M=2) Ogg packet, 20 ms. */
function family1Packet(frameByte = 1): Uint8Array {
  return multistreamPacket([
    stereoSubstream(31, frameByte),
    stereoSubstream(31, frameByte),
    monoSubstream(31, frameByte),
    monoSubstream(31, frameByte),
  ]);
}

function validMultichannelStream(): Uint8Array {
  const packets = Array.from({ length: 8 }, () => family1Packet());
  return new OggFileBuilder({ preSkip: 312, channels: 6 })
    .writeHeaders()
    .writeAudioPackets(packets)
    .build();
}

function multichannelSpanningStream(): Uint8Array {
  // Four ~200-byte-frame substreams push the Ogg packet past 510 bytes,
  // forcing it across two pages while its substream bounds stay intact.
  const big = family1Packet(200);
  const before = family1Packet(1);
  const after = family1Packet(1);
  return new OggFileBuilder({ preSkip: 0, channels: 6 })
    .writeHeaders()
    .writeSpanningAudio([before, big, after], 1)
    .build();
}

function badMappingStream(): Uint8Array {
  // 5.1 requires N=4 streams; a header declaring N=3 is invalid.
  const head = opusHeadFamily1({ channels: 6, streams: 3, coupled: 2 });
  return new OggFileBuilder({ channels: 6 }).writeHeaders({ head }).build();
}

function durationMismatchStream(): Uint8Array {
  // Coupled stream 20 ms, uncoupled stream 2.5 ms in the same packet.
  const packet = multistreamPacket([
    stereoSubstream(31),
    stereoSubstream(31),
    monoSubstream(31),
    monoSubstream(28),
  ]);
  return new OggFileBuilder({ preSkip: 0, channels: 6 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
}

function substreamTruncatedStream(): Uint8Array {
  // First self-delimited substream (C=3 -> stream 0, stereo) claims a
  // 200-byte frame but almost nothing follows, overrunning the packet.
  const toc = (31 << 3) | 0x04; // config 31, stereo, code 0
  const bogusFirst = Uint8Array.of(toc, 200, 0x42);
  const last = opusPacket({ config: 31, stereo: false, frameData: [new Uint8Array(1)] });
  const packet = new Uint8Array(bogusFirst.length + last.length);
  packet.set(bogusFirst, 0);
  packet.set(last, bogusFirst.length);
  return new OggFileBuilder({ preSkip: 0, channels: 3 })
    .writeHeaders()
    .writeAudioPackets([packet])
    .build();
}

function pageOffset(buf: Uint8Array, wanted: number): number {
  let off = 0;
  for (let idx = 0; idx < wanted; idx++) {
    const nseg = buf[off + 26]!;
    let bodyLen = 0;
    for (let i = 0; i < nseg; i++) bodyLen += buf[off + 27 + i]!;
    off += 27 + nseg + bodyLen;
  }
  return off;
}

function repairPageCrc(buf: Uint8Array, pageStart: number): void {
  const nseg = buf[pageStart + 26]!;
  let bodyLen = 0;
  for (let i = 0; i < nseg; i++) bodyLen += buf[pageStart + 27 + i]!;
  const end = pageStart + 27 + nseg + bodyLen;
  for (let i = 0; i < 4; i++) buf[pageStart + 22 + i] = 0;
  // CRC is recomputed with an inline implementation to keep the smoke
  // script self-contained apart from fixture builders.
  let crc = 0;
  const table = crcTable();
  for (let i = pageStart; i < end; i++) {
    crc = ((crc << 8) ^ table[((crc >>> 24) ^ buf[i]!) & 0xff]!) >>> 0;
  }
  buf[pageStart + 22] = crc & 0xff;
  buf[pageStart + 23] = (crc >>> 8) & 0xff;
  buf[pageStart + 24] = (crc >>> 16) & 0xff;
  buf[pageStart + 25] = (crc >>> 24) & 0xff;
}

let cachedTable: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (cachedTable) return cachedTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  cachedTable = table;
  return table;
}

async function main(): Promise<void> {
  await waitForHealth();

  console.log("1. valid cross-page stream");
  const good = validSpanningStream();
  const r1 = await postAudit(good);
  check("returns 200", r1.status === 200, `status=${r1.status} ${JSON.stringify(r1.json)}`);
  check("page count is 4", r1.json?.pageCount === 4, JSON.stringify(r1.json));
  check("three audio packets", r1.json?.audioPacketCount === 3, JSON.stringify(r1.json));
  check(
    "decoded samples = 960 + 6*120 + 960",
    r1.json?.decodedSamples === 960 + 720 + 960,
    JSON.stringify(r1.json),
  );
  check(
    "playable equals decoded with zero pre-skip",
    r1.json?.playableSamples === r1.json?.decodedSamples,
    JSON.stringify(r1.json),
  );

  console.log("2. statistics are stable across requests");
  const r2 = await postAudit(good);
  check("second response is identical", JSON.stringify(r2.json) === JSON.stringify(r1.json));

  console.log("3. corrupted page is rejected");
  const bad = await postAudit(corruptCrc(good));
  check("returns 422", bad.status === 422, `status=${bad.status}`);
  check("stable error code BAD_CRC", bad.json?.error?.code === "BAD_CRC", JSON.stringify(bad.json));
  check("reports a page index", typeof bad.json?.error?.page === "number", JSON.stringify(bad.json));

  console.log("4. unclosed packet at EOS is rejected");
  const unclosed = await postAudit(unclosedPacketStream());
  check("returns 422", unclosed.status === 422, `status=${unclosed.status}`);
  check(
    "stable error code AUDIO_PACKET_TRUNCATED",
    unclosed.json?.error?.code === "AUDIO_PACKET_TRUNCATED",
    JSON.stringify(unclosed.json),
  );
  check("failure page is the EOS page (2)", unclosed.json?.error?.page === 2, JSON.stringify(unclosed.json));

  console.log("5. granule timeline contradiction is rejected");
  const contradiction = await postAudit(granuleContradictionStream());
  check("returns 422", contradiction.status === 422, `status=${contradiction.status}`);
  check(
    "stable error code GRANULE_MISMATCH",
    contradiction.json?.error?.code === "GRANULE_MISMATCH",
    JSON.stringify(contradiction.json),
  );
  check("failure page is 3", contradiction.json?.error?.page === 3, JSON.stringify(contradiction.json));

  console.log("6. transport-level rejection");
  const wrongType = await postAudit(good, "application/octet-stream");
  check("non audio/ogg payload is 415", wrongType.status === 415, `status=${wrongType.status}`);

  console.log("7. valid family 1 5.1 record");
  const mc = validMultichannelStream();
  const r7 = await postAudit(mc);
  check("returns 200", r7.status === 200, `status=${r7.status} ${JSON.stringify(r7.json)}`);
  check("eight audio packets", r7.json?.audioPacketCount === 8, JSON.stringify(r7.json));
  check(
    "duration counted once per Ogg packet (8 * 960)",
    r7.json?.decodedSamples === 8 * 960,
    JSON.stringify(r7.json),
  );
  check("pre-skip applied once", r7.json?.playableSamples === 8 * 960 - 312, JSON.stringify(r7.json));
  const r7b = await postAudit(mc);
  check("family 1 statistics are stable", JSON.stringify(r7b.json) === JSON.stringify(r7.json));

  console.log("8. family 1 multichannel packet spanning Ogg pages");
  const r8 = await postAudit(multichannelSpanningStream());
  check("returns 200", r8.status === 200, `status=${r8.status} ${JSON.stringify(r8.json)}`);
  check("three audio packets on four pages", r8.json?.audioPacketCount === 3, JSON.stringify(r8.json));
  check("page count is 4", r8.json?.pageCount === 4, JSON.stringify(r8.json));
  check("decoded samples counted once per packet", r8.json?.decodedSamples === 3 * 960, JSON.stringify(r8.json));

  console.log("9. family 1 invalid mapping declaration is rejected");
  const r9 = await postAudit(badMappingStream());
  check("returns 422", r9.status === 422, `status=${r9.status}`);
  check(
    "stable error code CHANNEL_MAPPING_INVALID",
    r9.json?.error?.code === "CHANNEL_MAPPING_INVALID",
    JSON.stringify(r9.json),
  );
  check("failure page is the OpusHead page (0)", r9.json?.error?.page === 0, JSON.stringify(r9.json));

  console.log("10. family 1 substream truncation is rejected");
  const r10 = await postAudit(substreamTruncatedStream());
  check("returns 422", r10.status === 422, `status=${r10.status}`);
  check(
    "stable error code SUBSTREAM_TRUNCATED",
    r10.json?.error?.code === "SUBSTREAM_TRUNCATED",
    JSON.stringify(r10.json),
  );
  check("failure page is 2", r10.json?.error?.page === 2, JSON.stringify(r10.json));

  console.log("11. family 1 substream duration mismatch is rejected");
  const r11 = await postAudit(durationMismatchStream());
  check("returns 422", r11.status === 422, `status=${r11.status}`);
  check(
    "stable error code SUBSTREAM_DURATION_MISMATCH",
    r11.json?.error?.code === "SUBSTREAM_DURATION_MISMATCH",
    JSON.stringify(r11.json),
  );
  check("failure page is 2", r11.json?.error?.page === 2, JSON.stringify(r11.json));

  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
