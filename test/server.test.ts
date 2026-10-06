import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createAuditServer } from "../src/server.ts";
import {
  FAMILY1_STANDARD,
  multistreamPacket,
  OggFileBuilder,
  opusHeadFamily1,
  opusPacket,
} from "./helpers/oggBuilder.ts";

let server: Server;
let baseUrl: string;

before(async () => {
  server = createAuditServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("server has no address");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function validStream(): Uint8Array {
  const packets = Array.from({ length: 4 }, () =>
    opusPacket({ config: 31, frameData: [new Uint8Array([0x11])] }),
  );
  return new OggFileBuilder({ preSkip: 0 }).writeHeaders().writeAudioPackets(packets).build();
}

/** Valid 5.1 family-1 record: four substreams per Ogg packet. */
function validFamily1Stream(): Uint8Array {
  const spec = FAMILY1_STANDARD[6]!;
  const head = opusHeadFamily1({ channels: 6, ...spec, preSkip: 0 });
  const packets = Array.from({ length: 4 }, () =>
    multistreamPacket([
      ...Array.from({ length: spec.coupledCount }, () => ({
        config: 31,
        stereo: true,
        frameData: [new Uint8Array([0x31])],
      })),
      ...Array.from({ length: spec.streamCount - spec.coupledCount }, () => ({
        config: 31,
        stereo: false,
        frameData: [new Uint8Array([0x32])],
      })),
    ]),
  );
  return new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head })
    .writeAudioPackets(packets)
    .build();
}

interface ErrorBody {
  error: { code: string; page?: number; message: string };
}

async function readErrorBody(res: Response): Promise<ErrorBody> {
  return (await res.json()) as ErrorBody;
}

test("GET /health reports ok", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("POST valid audio/ogg returns stable statistics", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: validStream(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    pageCount: 3,
    audioPacketCount: 4,
    decodedSamples: 3840,
    playableSamples: 3840,
  });
});

test("POST valid family 1 multichannel returns single-counted statistics", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: validFamily1Stream(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    pageCount: 3,
    audioPacketCount: 4,
    decodedSamples: 3840, // 4 * 960, not 4 * 960 * 4 substreams
    playableSamples: 3840,
  });
});

test("family 1 illegal mapping yields 422 CHANNEL_MAPPING_INVALID on page 0", async () => {
  const head = opusHeadFamily1({
    channels: 3,
    streamCount: 1,
    coupledCount: 2,
    mapping: [0, 1, 2],
  });
  const body = new OggFileBuilder().writeHeaders({ head }).build();
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body,
  });
  assert.equal(res.status, 422);
  const err = await readErrorBody(res);
  assert.equal(err.error.code, "CHANNEL_MAPPING_INVALID");
  assert.equal(err.error.page, 0);
});

test("family 1 truncated substream yields 422 SUBSTREAM_TRUNCATED", async () => {
  const spec = FAMILY1_STANDARD[6]!;
  const head = opusHeadFamily1({ channels: 6, ...spec, preSkip: 0 });
  const full = multistreamPacket([
    ...Array.from({ length: spec.coupledCount }, () => ({
      config: 31,
      stereo: true,
      frameData: [new Uint8Array([0x31])],
    })),
    ...Array.from({ length: spec.streamCount - spec.coupledCount }, () => ({
      config: 31,
      stereo: false,
      frameData: [new Uint8Array([0x32])],
    })),
  ]);
  const cut = full.subarray(0, full.length - 2);
  const body = new OggFileBuilder({ preSkip: 0 })
    .writeHeaders({ head })
    .writeAudioPackets([cut])
    .build();
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body,
  });
  assert.equal(res.status, 422);
  const err = await readErrorBody(res);
  assert.equal(err.error.code, "SUBSTREAM_TRUNCATED");
  assert.equal(err.error.page, 2);
});

test("content-type with charset is still accepted", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg; charset=binary" },
    body: validStream(),
  });
  assert.equal(res.status, 200);
});

test("wrong content type yields 415", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: validStream(),
  });
  assert.equal(res.status, 415);
  const body = await readErrorBody(res);
  assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("unknown route yields 404 with a stable error code", async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await readErrorBody(res)).error.code, "NOT_FOUND");
});

test("empty body yields 400 EMPTY_INPUT", async () => {
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: new Uint8Array(0),
  });
  assert.equal(res.status, 400);
  assert.equal((await readErrorBody(res)).error.code, "EMPTY_INPUT");
});

test("a corrupted stream yields 422 with code and failing page", async () => {
  const bad = validStream();
  bad[bad.length - 1]! ^= 0xff; // damage last page body -> CRC fail
  const res = await fetch(`${baseUrl}/api/opus/audit`, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: bad,
  });
  assert.equal(res.status, 422);
  const body = await readErrorBody(res);
  assert.equal(body.error.code, "BAD_CRC");
  assert.equal(body.error.page, 2);
  assert.equal(typeof body.error.message, "string");
});

test("body beyond the configured byte cap yields 413", async () => {
  const smallServer = createAuditServer({ maxBytes: 64 });
  await new Promise<void>((resolve) => smallServer.listen(0, "127.0.0.1", resolve));
  const addr = smallServer.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}/api/opus/audit`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "audio/ogg" },
    body: new Uint8Array(128),
  });
  assert.equal(res.status, 413);
  assert.equal((await readErrorBody(res)).error.code, "PAYLOAD_TOO_LARGE");
  await new Promise<void>((resolve, reject) =>
    smallServer.close((err) => (err ? reject(err) : resolve())),
  );
});
