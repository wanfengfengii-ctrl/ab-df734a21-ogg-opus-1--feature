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

/** Parse the 1- or 2-byte VBR frame length (RFC 6716 3.2.1). */
function parseFrameLength(
  data: Uint8Array,
  pos: number,
  available: number,
): { length: number; bytes: number } {
  // Mirror parse_size(): the first byte must be readable, and values
  // 252..255 require a second byte.
  if (available < 1) {
    throw new OpusFormatError("truncated frame length");
  }
  const first = data[pos];
  if (first === undefined) {
    throw new OpusFormatError("truncated frame length");
  }
  if (first <= 251) {
    return { length: first, bytes: 1 };
  }
  if (available < 2) {
    throw new OpusFormatError("truncated two-byte frame length");
  }
  const second = data[pos + 1];
  if (second === undefined) {
    throw new OpusFormatError("truncated two-byte frame length");
  }
  return { length: second * 4 + first, bytes: 2 };
}

export class OpusFormatError extends Error {}

/**
 * Validate an Opus packet's internal framing and return its 48 kHz
 * sample count. Mirrors the structural checks of opus_packet_parse_impl
 * (RFC 6716 3.2, rules R1..R7).
 */
export function inspectOpusPacket(packet: Uint8Array): OpusPacketInfo {
  const n = packet.length;
  if (n < 1) {
    throw new OpusFormatError("empty opus packet"); // [R1]
  }
  const toc = packet[0]!;
  const config = toc >> 3;
  const stereo = (toc & 0x04) !== 0;
  const code = toc & 0x03;
  const samplesPerFrame = CONFIG_FRAME_SAMPLES[config]!;

  let frameCount: number;
  let pos = 1;
  let len = n - 1;

  switch (code) {
    case 0:
      frameCount = 1;
      // The single frame is implicit, but [R2] still caps it at 1275.
      if (len > MAX_FRAME_BYTES) {
        throw new OpusFormatError("code 0 frame exceeds 1275 bytes");
      }
      break;

    case 1:
      frameCount = 2;
      if (len % 2 !== 0) {
        throw new OpusFormatError("code 1 packet with odd payload length"); // [R3]
      }
      if (len / 2 > MAX_FRAME_BYTES) {
        throw new OpusFormatError("code 1 frame exceeds 1275 bytes"); // [R2]
      }
      break;

    case 2:
      frameCount = 2;
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
      break;

    default: {
      // code 3
      if (n < 2) {
        throw new OpusFormatError("code 3 packet missing frame count byte"); // [R6]
      }
      const ch = packet[1]!;
      frameCount = ch & 0x3f;
      const hasPadding = (ch & 0x40) !== 0;
      const vbr = (ch & 0x80) !== 0;
      if (frameCount === 0) {
        throw new OpusFormatError("code 3 packet with zero frames"); // [R5]
      }
      if (samplesPerFrame * frameCount > MAX_PACKET_SAMPLES) {
        throw new OpusFormatError("opus packet exceeds 120 ms"); // [R5]
      }
      pos = 2;
      len = n - 2;

      if (hasPadding) {
        let p: number;
        do {
          if (len <= 0) {
            throw new OpusFormatError("truncated opus padding length"); // [R6]
          }
          p = packet[pos]!;
          pos += 1;
          len -= 1;
          const add = p === 255 ? 254 : p;
          len -= add;
        } while (p === 255);
        if (len < 0) {
          throw new OpusFormatError("opus padding exceeds packet size"); // [R6]
        }
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
      break;
    }
  }

  return {
    config,
    stereo,
    code,
    frameCount,
    samplesPerFrame,
    totalSamples: samplesPerFrame * frameCount,
  };
}
