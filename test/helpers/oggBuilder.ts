/**
 * Minimal Ogg page / Opus packet fixture builders used by the test
 * suite and the HTTP smoke test. These are deliberately low-level so
 * tests can produce corrupt or spec-edge streams.
 */

import { oggCrc32 } from "../../src/crc32ogg.ts";

export const DEFAULT_SERIAL = 0x4f50_5553; // "OPUS"

export const FLAG_CONTINUED = 0x01;
export const FLAG_BOS = 0x02;
export const FLAG_EOS = 0x04;

export interface RawPageOptions {
  serial?: number;
  sequence: number;
  flags: number;
  /** 64-bit granule; pass -1n for the "no packet finishes" marker. */
  granule: bigint;
  segments: Uint8Array;
  body: Uint8Array;
  /** Override the computed CRC, or pass {zero:true} to blank it. */
  crcOverride?: number | { zero: true };
}

export function buildRawPage(opts: RawPageOptions): Uint8Array {
  if (opts.body.length !== sumLacing(opts.segments)) {
    throw new Error("body length does not match segment table");
  }
  const header = new Uint8Array(27 + opts.segments.length);
  header.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  header[4] = 0;
  header[5] = opts.flags;
  writeU64Le(header, 6, opts.granule);
  writeU32Le(header, 14, opts.serial ?? DEFAULT_SERIAL);
  writeU32Le(header, 18, opts.sequence);
  // CRC field at 22..25 stays zero until computed.
  header[26] = opts.segments.length;
  header.set(opts.segments, 27);

  const page = new Uint8Array(header.length + opts.body.length);
  page.set(header, 0);
  page.set(opts.body, header.length);

  if (opts.crcOverride === undefined) {
    const crc = oggCrc32(page);
    writeU32Le(page, 22, crc);
  } else if (typeof opts.crcOverride === "number") {
    writeU32Le(page, 22, opts.crcOverride);
  }
  // {zero:true} leaves the field zero.
  return page;
}

export interface LacingResult {
  segments: number[];
  body: Uint8Array;
}

/** Encode whole packets into lacing values + concatenated body. */
export function lacePackets(packets: Uint8Array[]): LacingResult {
  const segments: number[] = [];
  const bodyParts: Uint8Array[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    if (remaining === 0) {
      segments.push(0);
      continue;
    }
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    segments.push(remaining);
    bodyParts.push(packet);
  }
  return { segments, body: concat(bodyParts) };
}

/**
 * Split a (large) packet across pages. Returns the lacing/body pieces
 * for `chunks` pages; each page except the last ends open.
 */
export function splitPacketAcrossPages(
  packet: Uint8Array,
  chunkSizes: number[],
): { segments: number[]; body: Uint8Array }[] {
  const out: { segments: number[]; body: Uint8Array }[] = [];
  let offset = 0;
  for (let i = 0; i < chunkSizes.length; i++) {
    const size = i === chunkSizes.length - 1 ? packet.length - offset : chunkSizes[i]!;
    if (size < 0 || offset + size > packet.length) {
      throw new Error("chunk sizes exceed packet length");
    }
    const piece = packet.subarray(offset, offset + size);
    const segments: number[] = [];
    let remaining = size;
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    const isLast = i === chunkSizes.length - 1;
    if (!isLast) {
      if (remaining !== 0) {
        throw new Error("intermediate split point must be a 255-byte lacing boundary");
      }
    } else {
      segments.push(remaining);
    }
    out.push({ segments, body: piece.slice() });
    offset += size;
  }
  if (offset !== packet.length) {
    throw new Error("packet was not fully covered by chunk sizes");
  }
  return out;
}

export function opusHead(options: { channels?: 1 | 2; preSkip?: number } = {}): Uint8Array {
  const channels = options.channels ?? 1;
  const preSkip = options.preSkip ?? 312;
  const p = new Uint8Array(19);
  p.set(new TextEncoder().encode("OpusHead"), 0);
  p[8] = 1; // version
  p[9] = channels;
  p[10] = preSkip & 0xff;
  p[11] = (preSkip >> 8) & 0xff;
  writeU32Le(p, 12, 48000);
  // output gain 0 at 16..17, mapping family 0 at 18
  return p;
}

/** Canonical RFC 7845 family 1 layout for 1..8 output channels. */
export const FAMILY1_LAYOUTS: Readonly<Record<number, { streams: number; coupled: number }>> = {
  1: { streams: 1, coupled: 0 },
  2: { streams: 1, coupled: 1 },
  3: { streams: 2, coupled: 1 },
  4: { streams: 2, coupled: 2 },
  5: { streams: 3, coupled: 2 },
  6: { streams: 4, coupled: 2 },
  7: { streams: 5, coupled: 2 },
  8: { streams: 5, coupled: 3 },
};

export interface Family1HeadOptions {
  channels: number;
  preSkip?: number;
  streams?: number;
  coupled?: number;
  /** Override individual mapping octets (sparse), defaults to 0..C-1. */
  mapping?: Record<number, number>;
}

/** Build a mapping-family-1 OpusHead (21 + C bytes), canonical by default. */
export function opusHeadFamily1(options: Family1HeadOptions): Uint8Array {
  const { channels } = options;
  const layout = FAMILY1_LAYOUTS[channels] ?? { streams: 1, coupled: 0 };
  const streams = options.streams ?? layout.streams;
  const coupled = options.coupled ?? layout.coupled;
  const preSkip = options.preSkip ?? 312;
  const p = new Uint8Array(21 + channels);
  p.set(new TextEncoder().encode("OpusHead"), 0);
  p[8] = 1; // version
  p[9] = channels;
  p[10] = preSkip & 0xff;
  p[11] = (preSkip >> 8) & 0xff;
  writeU32Le(p, 12, 48000);
  p[18] = 1; // mapping family
  p[19] = streams;
  p[20] = coupled;
  for (let i = 0; i < channels; i++) {
    p[21 + i] = options.mapping?.[i] ?? i;
  }
  return p;
}

export function opusTags(vendor = "test-encoder", comments: [string, string][] = []): Uint8Array {
  const vendorBytes = new TextEncoder().encode(vendor);
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(8 + 4 + vendorBytes.length + 4);
  head.set(new TextEncoder().encode("OpusTags"), 0);
  writeU32Le(head, 8, vendorBytes.length);
  head.set(vendorBytes, 12);
  writeU32Le(head, 12 + vendorBytes.length, comments.length);
  parts.push(head);
  for (const [key, value] of comments) {
    const bytes = new TextEncoder().encode(`${key}=${value}`);
    const len = new Uint8Array(4);
    writeU32Le(len, 0, bytes.length);
    parts.push(len, bytes);
  }
  return concat(parts);
}

/**
 * Build an Opus audio packet from TOC fields (RFC 6716 section 3.1).
 * `frameData` is opaque compressed frame data; tests mostly care about
 * TOC-derived durations and structural validity.
 */
export function opusPacket(options: {
  config?: number;
  stereo?: boolean;
  code?: 0 | 1 | 2 | 3;
  frameData?: Uint8Array[];
  frameCount?: number;
  vbr?: boolean;
  padding?: number;
}): Uint8Array {
  const cfg = options.config ?? 28; // CELT FB 2.5 ms
  const stereo = options.stereo ?? false;
  const code = options.code ?? 0;
  const toc = ((cfg & 0x1f) << 3) | (stereo ? 0x04 : 0) | code;
  const frames = options.frameData ?? [new Uint8Array([0x00])];
  const parts: Uint8Array[] = [new Uint8Array([toc])];

  if (code === 0) {
    parts.push(frames[0] ?? new Uint8Array(0));
  } else if (code === 1) {
    const f = frames[0]!;
    parts.push(f, f);
  } else if (code === 2) {
    const n1 = frames[0]!.length;
    parts.push(encodeLength(n1), frames[0]!, frames[1] ?? new Uint8Array(0));
  } else {
    const m = options.frameCount ?? frames.length;
    const vbr = options.vbr ?? false;
    const padding = options.padding ?? 0;
    parts.push(new Uint8Array([(vbr ? 0x80 : 0) | (padding > 0 ? 0x40 : 0) | (m & 0x3f)]));
    if (padding > 0) {
      let rest = padding;
      while (rest >= 254) {
        parts.push(new Uint8Array([255]));
        rest -= 254;
      }
      parts.push(new Uint8Array([rest]));
    }
    if (vbr) {
      // All M-1 frame lengths precede the frame bytes (RFC 6716 Fig 7).
      const lengths: Uint8Array[] = [];
      for (let i = 0; i < m - 1; i++) {
        lengths.push(encodeLength(frames[i]!.length));
      }
      parts.push(...lengths);
      for (const f of frames) {
        parts.push(f);
      }
    } else {
      for (const f of frames) {
        parts.push(f);
      }
    }
    if (padding > 0) {
      parts.push(new Uint8Array(padding));
    }
  }
  return concat(parts);
}

export function encodeLength(length: number): Uint8Array {
  if (length < 252) {
    return new Uint8Array([length]);
  }
  const first = 252 + (length % 4);
  const second = (length - first) / 4;
  return new Uint8Array([first, second]);
}

/**
 * Build an RFC 6716 Appendix B self-delimited Opus packet: identical to
 * {@link opusPacket} but with one extra frame-length field so the
 * packet's total size is discoverable when packed with neighbours.
 */
export function opusSelfDelimitedPacket(options: {
  config?: number;
  stereo?: boolean;
  code?: 0 | 1 | 2 | 3;
  frameData?: Uint8Array[];
  frameCount?: number;
  vbr?: boolean;
  padding?: number;
}): Uint8Array {
  const cfg = options.config ?? 28;
  const stereo = options.stereo ?? false;
  const code = options.code ?? 0;
  const toc = ((cfg & 0x1f) << 3) | (stereo ? 0x04 : 0) | code;
  const frames = options.frameData ?? [new Uint8Array([0x00])];
  const parts: Uint8Array[] = [new Uint8Array([toc])];

  if (code === 0) {
    const f = frames[0] ?? new Uint8Array(0);
    parts.push(encodeLength(f.length), f);
  } else if (code === 1) {
    const f = frames[0]!;
    parts.push(encodeLength(f.length), f, f);
  } else if (code === 2) {
    const f0 = frames[0]!;
    const f1 = frames[1] ?? new Uint8Array(0);
    parts.push(encodeLength(f0.length), encodeLength(f1.length), f0, f1);
  } else {
    const m = options.frameCount ?? frames.length;
    const vbr = options.vbr ?? false;
    const padding = options.padding ?? 0;
    parts.push(new Uint8Array([(vbr ? 0x80 : 0) | (padding > 0 ? 0x40 : 0) | (m & 0x3f)]));
    if (padding > 0) {
      let rest = padding;
      while (rest >= 254) {
        parts.push(new Uint8Array([255]));
        rest -= 254;
      }
      parts.push(new Uint8Array([rest]));
    }
    if (vbr) {
      // N1..N[M-1] regular length fields, then Appendix B's N[M].
      for (let i = 0; i < m - 1; i++) {
        parts.push(encodeLength(frames[i]!.length));
      }
      parts.push(encodeLength(frames[m - 1]!.length));
      for (const f of frames) {
        parts.push(f);
      }
    } else {
      parts.push(encodeLength(frames[0]!.length));
      for (const f of frames) {
        parts.push(f);
      }
    }
    if (padding > 0) {
      parts.push(new Uint8Array(padding));
    }
  }
  return concat(parts);
}

export interface SubstreamSpec {
  stereo: boolean;
  config?: number;
  code?: 0 | 1 | 2 | 3;
  frameData?: Uint8Array[];
  frameCount?: number;
  vbr?: boolean;
  padding?: number;
}

/**
 * Pack one Ogg multichannel audio packet (RFC 7845 section 3): the first
 * N-1 substreams use self-delimiting framing, the last one regular
 * framing.
 */
export function multistreamPacket(substreams: SubstreamSpec[]): Uint8Array {
  if (substreams.length === 0) {
    throw new Error("multistream packet needs at least one substream");
  }
  const parts: Uint8Array[] = [];
  substreams.forEach((spec, i) => {
    const builder = i < substreams.length - 1 ? opusSelfDelimitedPacket : opusPacket;
    parts.push(builder(spec));
  });
  return concat(parts);
}

/** Equal-sized code-0 frames for one substream of `samples` duration. */
export function monoSubstream(config = 31, frameByte = 1): SubstreamSpec {
  return { stereo: false, config, frameData: [new Uint8Array(frameByte)] };
}

export function stereoSubstream(config = 31, frameByte = 1): SubstreamSpec {
  return { stereo: true, config, frameData: [new Uint8Array(frameByte)] };
}

/**
 * Stateful writer that emits a well-formed single-logical-stream file.
 * Audio page granule positions are computed automatically unless given.
 */
export class OggFileBuilder {
  private sequence = 0;
  readonly pages: Uint8Array[] = [];
  private openPiece: { packet: Uint8Array; offset: number } | null = null;
  private accumulated = 0;
  readonly preSkip: number;
  readonly channels: number;

  constructor(options: { preSkip?: number; channels?: number } = {}) {
    this.preSkip = options.preSkip ?? 312;
    this.channels = options.channels ?? 1;
  }

  writeHeaders(options: { tags?: Uint8Array; head?: Uint8Array } = {}): this {
    const head = options.head ??
      (this.channels === 1 || this.channels === 2
        ? opusHead({ channels: this.channels, preSkip: this.preSkip })
        : opusHeadFamily1({ channels: this.channels, preSkip: this.preSkip }));
    const tags = options.tags ?? opusTags();
    const idLacing = lacePackets([head]);
    this.pages.push(
      buildRawPage({
        sequence: this.sequence++,
        flags: FLAG_BOS,
        granule: 0n,
        segments: Uint8Array.from(idLacing.segments),
        body: idLacing.body,
      }),
    );
    const tagsLacing = lacePackets([tags]);
    this.pages.push(
      buildRawPage({
        sequence: this.sequence++,
        flags: 0,
        granule: 0n,
        segments: Uint8Array.from(tagsLacing.segments),
        body: tagsLacing.body,
      }),
    );
    return this;
  }

  /** Write a run of audio packets, packetCountPerPage per page. */
  writeAudioPackets(
    packets: Uint8Array[],
    options: { packetsPerPage?: number; finalPageTrim?: number; eos?: boolean } = {},
  ): this {
    const perPage = options.packetsPerPage ?? packets.length;
    let idx = 0;
    while (idx < packets.length) {
      const slice = packets.slice(idx, idx + perPage);
      idx += perPage;
      const last = idx >= packets.length;
      const eos = last && (options.eos ?? true);
      let pageSamples = 0;
      for (const p of slice) {
        pageSamples += packetSamples(p);
      }
      this.accumulated += pageSamples;
      const granule = eos && options.finalPageTrim !== undefined
        ? this.accumulated - options.finalPageTrim
        : this.accumulated;
      const lacing = lacePackets(slice);
      this.pages.push(
        buildRawPage({
          sequence: this.sequence++,
          flags: eos ? FLAG_EOS : 0,
          granule: BigInt(granule),
          segments: Uint8Array.from(lacing.segments),
          body: lacing.body,
        }),
      );
    }
    return this;
  }

  /**
   * Lay out packets/pages with explicit control over packet splitting,
   * granule positions and flags. Each spec is one page.
   */
  writeRawPages(
    specs: {
      flags?: number;
      granule: bigint;
      segments: number[];
      body: Uint8Array;
      serial?: number;
      crcOverride?: number | { zero: true };
    }[],
  ): this {
    for (const spec of specs) {
      this.pages.push(
        buildRawPage({
          sequence: this.sequence++,
          flags: spec.flags ?? 0,
          granule: spec.granule,
          segments: Uint8Array.from(spec.segments),
          body: spec.body,
          ...(spec.serial !== undefined ? { serial: spec.serial } : {}),
          ...(spec.crcOverride !== undefined ? { crcOverride: spec.crcOverride } : {}),
        }),
      );
    }
    return this;
  }

  /**
   * Emit `packets[splitIndex]` across two pages: it opens on page A
   * (which may also complete preceding packets) and closes on a
   * continued page B (which may also carry the remaining packets).
   * The split point is a 255-byte lacing boundary.
   */
  writeSpanningAudio(
    packets: Uint8Array[],
    splitIndex: number,
    options: { splitAt?: number; eos?: boolean } = {},
  ): this {
    const big = packets[splitIndex]!;
    const before = packets.slice(0, splitIndex);
    const after = packets.slice(splitIndex + 1);

    const cut = options.splitAt ?? 510;
    if (cut % 255 !== 0 || cut <= 0 || cut >= big.length) {
      throw new Error("split point must be a positive 255-multiple inside the packet");
    }

    // Page A: completed preceding packets, then `cut` bytes that end on
    // a 255 lacing value so the packet stays open.
    const beforeLacing = lacePackets(before);
    const openSegments: number[] = [];
    for (let i = 0; i < cut / 255; i++) openSegments.push(255);
    const pageASegments = [...beforeLacing.segments, ...openSegments];
    const pageABody = concat([beforeLacing.body, big.subarray(0, cut)]);
    let granuleA = 0;
    for (const p of before) granuleA += packetSamples(p);
    this.accumulated += granuleA;
    this.pages.push(
      buildRawPage({
        sequence: this.sequence++,
        flags: 0,
        granule: before.length > 0 ? BigInt(this.accumulated) : -1n,
        segments: Uint8Array.from(pageASegments),
        body: pageABody,
      }),
    );

    // Page B: continuation flag, remainder closes the packet, then the
    // packets that follow it.
    const remainder = big.subarray(cut);
    const restLacing = lacePackets([remainder, ...after]);
    this.accumulated += packetSamples(big);
    for (const p of after) this.accumulated += packetSamples(p);
    const eos = options.eos ?? true;
    this.pages.push(
      buildRawPage({
        sequence: this.sequence++,
        flags: FLAG_CONTINUED | (eos ? FLAG_EOS : 0),
        granule: BigInt(this.accumulated),
        segments: Uint8Array.from(restLacing.segments),
        body: restLacing.body,
      }),
    );
    return this;
  }

  build(): Uint8Array {
    return concat(this.pages);
  }

  get pageCount(): number {
    return this.pages.length;
  }
}

const FRAME_SAMPLES: readonly number[] = [
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
  480, 960, 480, 960,
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

export function packetSamples(packet: Uint8Array): number {
  const toc = packet[0]!;
  const config = toc >> 3;
  const perFrame = FRAME_SAMPLES[config]!;
  const code = toc & 3;
  if (code === 0) return perFrame;
  if (code === 1 || code === 2) return perFrame * 2;
  return perFrame * (packet[1]! & 0x3f);
}

function sumLacing(segments: Uint8Array): number {
  let n = 0;
  for (const v of segments) n += v;
  return n;
}

function concat(parts: Uint8Array[]): Uint8Array {
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

function writeU32Le(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64Le(data: Uint8Array, offset: number, value: bigint): void {
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    data[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}
