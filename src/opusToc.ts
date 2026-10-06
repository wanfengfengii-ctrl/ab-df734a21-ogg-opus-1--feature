/**
 * Opus packet TOC/framing validation (RFC 6716 section 3).
 *
 * We do not decode compressed audio: the number of samples an Opus
 * decoder returns for a packet is fixed purely by its TOC byte
 * (RFC 6716 Table 2 + frame count code), so validating the internal
 * framing is enough to derive the 48 kHz sample count deterministically.
 */

/** Samples per frame at 48 kHz for TOC configs 0..31 (RFC 6716 Table 2). */
const CONFIG_FRAME_SAMPLES: readonly number[] = [
  // SILK-only
  480, 960, 1920, 2880, // 0..3   NB 10/20/40/60 ms
  480, 960, 1920, 2880, // 4..7   MB
  480, 960, 1920, 2880, // 8..11  WB
  // Hybrid (SILK + CELT)
  480, 960, // 12..13 SWB 10/20 ms
  480, 960, // 14..15 FB  10/20 ms
  // CELT-only
  120, 240, 480, 960, // 16..19 NB  2.5/5/10/20 ms
  120, 240, 480, 960, // 20..23 WB
  120, 240, 480, 960, // 24..27 SWB
  120, 240, 480, 960, // 28..31 FB
];

export const MAX_PACKET_SAMPLES = 5760; // 120 ms at 48 kHz (RFC 6716 [R5])
const MAX_FRAME_BYTES = 1275; // RFC 6716 [R2]

export interface OpusPacketInfo {
  config: number;
  stereo: boolean;
  code: number;
  frameCount: number;
  samplesPerFrame: number;
  /** Total decoder output samples at 48 kHz. */
  totalSamples: number;
}

export class OpusFormatError extends Error {}

/**
 * Raised when framing declares more bytes than the enclosing buffer
 * provides. Extends OpusFormatError because a short packet is a format
 * failure for a single stream; multistream callers distinguish it to
 * report a cut-off substream separately.
 */
export class OpusPacketTruncatedError extends OpusFormatError {}

/** Parse the 1- or 2-byte VBR frame length (RFC 6716 3.2.1). */
function parseFrameLength(
  data: Uint8Array,
  pos: number,
  available: number,
): { length: number; bytes: number } {
  // Mirror parse_size(): the first byte must be readable, and values
  // 252..255 require a second byte.
  if (available < 1) {
    throw new OpusPacketTruncatedError("truncated frame length");
  }
  const first = data[pos];
  if (first === undefined) {
    throw new OpusPacketTruncatedError("truncated frame length");
  }
  if (first <= 251) {
    return { length: first, bytes: 1 };
  }
  if (available < 2) {
    throw new OpusPacketTruncatedError("truncated two-byte frame length");
  }
  const second = data[pos + 1];
  if (second === undefined) {
    throw new OpusPacketTruncatedError("truncated two-byte frame length");
  }
  return { length: second * 4 + first, bytes: 2 };
}

/**
 * Validate an Opus packet's internal framing and return its 48 kHz
 * sample count. Mirrors the structural checks of opus_packet_parse_impl
 * (RFC 6716 3.2, rules R1..R7).
 */
export function inspectOpusPacket(packet: Uint8Array): OpusPacketInfo {
  if (packet.length < 1) {
    throw new OpusFormatError("empty opus packet"); // [R1]
  }
  return inspectAt(packet, 0, false).info;
}

/**
 * Validate one Opus packet beginning at `start` inside a multistream Ogg
 * packet and report the offset just past it. Non-final substreams use the
 * self-delimiting framing of RFC 6716 Appendix B: an extra one-/two-byte
 * length precedes the first frame, which makes the packet boundary
 * discoverable without knowing its total length. The final substream
 * uses ordinary framing and always runs to the end of the buffer.
 */
function inspectAt(
  packet: Uint8Array,
  start: number,
  selfDelimiting: boolean,
): { info: OpusPacketInfo; next: number } {
  const n = packet.length;
  if (start >= n) {
    throw new OpusPacketTruncatedError("missing Opus substream TOC byte");
  }
  const toc = packet[start]!;
  const config = toc >> 3;
  const stereo = (toc & 0x04) !== 0;
  const code = toc & 0x03;
  const samplesPerFrame = CONFIG_FRAME_SAMPLES[config]!;

  let frameCount: number;
  let pos = start + 1;
  let len = n - pos;
  // Only present for code 3 self-delimited packets: padding follows the
  // frame run, so its length is remembered while the frames are walked.
  let trailingPadding = 0;

  switch (code) {
    case 0:
      frameCount = 1;
      if (selfDelimiting) {
        const delim = parseFrameLength(packet, pos, len);
        pos += delim.bytes;
        if (delim.length > n - pos) {
          throw new OpusPacketTruncatedError("self-delimited code 0 frame overruns the packet");
        }
        if (delim.length > MAX_FRAME_BYTES) {
          throw new OpusFormatError("code 0 frame exceeds 1275 bytes"); // [R2]
        }
        pos += delim.length;
        return done(pos);
      }
      // The single frame is implicit, but [R2] still caps it at 1275.
      if (len > MAX_FRAME_BYTES) {
        throw new OpusFormatError("code 0 frame exceeds 1275 bytes");
      }
      return done(n);

    case 1:
      frameCount = 2;
      if (selfDelimiting) {
        const delim = parseFrameLength(packet, pos, len);
        pos += delim.bytes;
        if (2 * delim.length > n - pos) {
          throw new OpusPacketTruncatedError("self-delimited code 1 frames overrun the packet");
        }
        if (delim.length > MAX_FRAME_BYTES) {
          throw new OpusFormatError("code 1 frame exceeds 1275 bytes"); // [R2]
        }
        pos += 2 * delim.length;
        return done(pos);
      }
      if (len % 2 !== 0) {
        throw new OpusFormatError("code 1 packet with odd payload length"); // [R3]
      }
      if (len / 2 > MAX_FRAME_BYTES) {
        throw new OpusFormatError("code 1 frame exceeds 1275 bytes"); // [R2]
      }
      return done(n);

    case 2:
      frameCount = 2;
      if (selfDelimiting) {
        // Figure 27: TOC, N1, N2, frame 1, frame 2 -- both lengths coded.
        const first = parseFrameLength(packet, pos, n - pos);
        pos += first.bytes;
        const second = parseFrameLength(packet, pos, n - pos);
        pos += second.bytes;
        if (first.length > MAX_FRAME_BYTES || second.length > MAX_FRAME_BYTES) {
          throw new OpusFormatError("code 2 frame exceeds 1275 bytes"); // [R2]
        }
        if (first.length + second.length > n - pos) {
          throw new OpusPacketTruncatedError("self-delimited code 2 frames overrun the packet");
        }
        pos += first.length + second.length;
        return done(pos);
      }
      {
        // parse_size may consume 1 or 2 bytes; the signaled length must
        // leave enough room for the (possibly zero-byte) second frame.
        let n1: number;
        try {
          const parsed = parseFrameLength(packet, pos, len);
          n1 = parsed.length;
          pos += parsed.bytes;
          len -= parsed.bytes;
        } catch (err) {
          if (err instanceof OpusFormatError) {
            throw new OpusFormatError("code 2 packet has invalid first frame length");
          }
          throw err;
        }
        if (n1 > len) {
          throw new OpusFormatError("code 2 first frame length exceeds payload"); // [R4]
        }
        if (len - n1 > MAX_FRAME_BYTES) {
          throw new OpusFormatError("code 2 implicit frame exceeds 1275 bytes"); // [R2]
        }
      }
      return done(n);

    default: {
      // code 3
      if (pos >= n) {
        if (selfDelimiting) {
          throw new OpusPacketTruncatedError("code 3 substream missing its frame count byte");
        }
        throw new OpusFormatError("code 3 packet missing frame count byte"); // [R6]
      }
      const ch = packet[pos]!;
      pos += 1;
      len -= 1;
      frameCount = ch & 0x3f;
      const hasPadding = (ch & 0x40) !== 0;
      const vbr = (ch & 0x80) !== 0;
      if (frameCount === 0) {
        throw new OpusFormatError("code 3 packet with zero frames"); // [R5]
      }
      if (samplesPerFrame * frameCount > MAX_PACKET_SAMPLES) {
        throw new OpusFormatError("opus packet exceeds 120 ms"); // [R5]
      }

      if (hasPadding) {
        let p: number;
        do {
          if (len <= 0) {
            // A self-delimited substream cut off before its padding run
            // ends is a broken packet boundary; an ordinary packet simply
            // cannot have padding past its own end.
            if (selfDelimiting) {
              throw new OpusPacketTruncatedError("truncated opus padding length");
            }
            throw new OpusFormatError("truncated opus padding length"); // [R6]
          }
          p = packet[pos]!;
          pos += 1;
          len -= 1;
          const add = p === 255 ? 254 : p;
          if (selfDelimiting) {
            trailingPadding += add;
          } else {
            len -= add;
          }
        } while (p === 255);
        if (!selfDelimiting && len < 0) {
          throw new OpusFormatError("opus padding exceeds packet size"); // [R6]
        }
      }

      if (selfDelimiting) {
        // Figures 28/29: every frame length sits in the header. In VBR
        // packets the M-th (last) length is coded right after the M-1
        // regular fields; in CBR one length covers all M frames.
        let frameBytes = 0;
        if (vbr) {
          for (let i = 0; i < frameCount; i++) {
            const parsed = parseFrameLength(packet, pos, n - pos);
            pos += parsed.bytes;
            if (parsed.length > MAX_FRAME_BYTES) {
              throw new OpusFormatError("code 3 frame exceeds 1275 bytes"); // [R2]
            }
            frameBytes += parsed.length;
          }
        } else {
          const parsed = parseFrameLength(packet, pos, n - pos);
          pos += parsed.bytes;
          if (parsed.length > MAX_FRAME_BYTES) {
            throw new OpusFormatError("code 3 frame exceeds 1275 bytes"); // [R2]
          }
          frameBytes = parsed.length * frameCount;
        }
        if (frameBytes > n - pos) {
          throw new OpusPacketTruncatedError("self-delimited code 3 frames overrun the packet");
        }
        pos += frameBytes;
        if (trailingPadding > n - pos) {
          throw new OpusPacketTruncatedError("self-delimited padding overruns the packet");
        }
        return done(pos + trailingPadding);
      }

      if (vbr) {
        // In code 3 VBR packets ALL the (M-1) frame-length fields are
        // contiguous in the header; the frame bytes follow as one run
        // (RFC 6716 Figure 7). We walk the length fields, tracking the
        // bytes left for the signaled frames and the implicit last one.
        let lastSize = len;
        let lengthPos = pos;
        for (let i = 0; i < frameCount - 1; i++) {
          let parsed: { length: number; bytes: number };
          try {
            parsed = parseFrameLength(packet, lengthPos, len);
          } catch (err) {
            if (err instanceof OpusFormatError) {
              throw new OpusFormatError("code 3 vbr frame length invalid");
            }
            throw err;
          }
          lengthPos += parsed.bytes;
          len -= parsed.bytes;
          if (parsed.length > len) {
            throw new OpusFormatError("code 3 vbr frame exceeds payload"); // [R7]
          }
          if (parsed.length > MAX_FRAME_BYTES) {
            throw new OpusFormatError("code 3 frame exceeds 1275 bytes"); // [R2]
          }
          len -= parsed.length;
          lastSize -= parsed.bytes + parsed.length;
        }
        if (lastSize < 0) {
          throw new OpusFormatError("code 3 vbr frames exceed packet"); // [R7]
        }
        if (lastSize > MAX_FRAME_BYTES) {
          throw new OpusFormatError("code 3 implicit frame exceeds 1275 bytes"); // [R2]
        }
      } else {
        // CBR: remaining payload must divide evenly across frames.
        if (len % frameCount !== 0) {
          throw new OpusFormatError("code 3 cbr payload not divisible by frame count"); // [R6]
        }
        if (len / frameCount > MAX_FRAME_BYTES) {
          throw new OpusFormatError("code 3 cbr frame exceeds 1275 bytes"); // [R2]
        }
      }
      return done(n);
    }
  }

  function done(next: number): { info: OpusPacketInfo; next: number } {
    return {
      info: {
        config,
        stereo,
        code,
        frameCount,
        samplesPerFrame,
        totalSamples: samplesPerFrame * frameCount,
      },
      next,
    };
  }
}

export type MultistreamViolation = "truncated" | "invalid" | "stereo" | "duration";

export class OpusMultistreamError extends OpusFormatError {
  readonly reason: MultistreamViolation;

  constructor(reason: MultistreamViolation, message: string) {
    super(message);
    this.name = "OpusMultistreamError";
    this.reason = reason;
  }
}

export interface MultistreamPacketInfo {
  /** TOC stereo flag of every substream, in declared stream order. */
  stereo: boolean[];
  /** 48 kHz decoder output samples; identical for every substream. */
  totalSamples: number;
}

/**
 * Split one multistream Ogg packet into its `streamCount` Opus substreams
 * (RFC 7845 section 3), validate every boundary and the per-substream
 * channel assignment, and prove all substreams decode the same number of
 * samples. The first (N-1) substreams use Appendix B self-delimiting
 * framing; the last uses ordinary framing.
 */
export function inspectMultistreamPacket(
  packet: Uint8Array,
  streamCount: number,
  coupledCount: number,
): MultistreamPacketInfo {
  const stereo: boolean[] = [];
  let totalSamples: number | null = null;
  let pos = 0;

  for (let i = 0; i < streamCount; i++) {
    const selfDelimiting = i < streamCount - 1;
    let parsed: { info: OpusPacketInfo; next: number };
    try {
      parsed = inspectAt(packet, pos, selfDelimiting);
    } catch (err) {
      if (err instanceof OpusPacketTruncatedError) {
        throw new OpusMultistreamError(
          "truncated",
          `audio packet substream ${i} is truncated: ${err.message}`,
        );
      }
      if (err instanceof OpusFormatError) {
        throw new OpusMultistreamError(
          "invalid",
          `audio packet substream ${i} is malformed: ${err.message}`,
        );
      }
      throw err;
    }
    if (parsed.next > packet.length || (!selfDelimiting && parsed.next !== packet.length)) {
      throw new OpusMultistreamError(
        "truncated",
        `audio packet substream ${i} crosses the Ogg packet boundary`,
      );
    }
    pos = parsed.next;

    const expectedStereo = i < coupledCount;
    if (parsed.info.stereo !== expectedStereo) {
      throw new OpusMultistreamError(
        "stereo",
        `substream ${i} TOC stereo flag does not match the ${coupledCount} coupled stream(s)`,
      );
    }
    if (totalSamples === null) {
      totalSamples = parsed.info.totalSamples;
    } else if (parsed.info.totalSamples !== totalSamples) {
      throw new OpusMultistreamError(
        "duration",
        `substream ${i} decodes ${parsed.info.totalSamples} samples but substream 0 decodes ${totalSamples}`,
      );
    }
    stereo.push(parsed.info.stereo);
  }

  if (pos !== packet.length) {
    throw new OpusMultistreamError(
      "truncated",
      "declared substreams do not fill the audio packet boundary",
    );
  }

  return { stereo, totalSamples: totalSamples! };
}
