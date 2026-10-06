/**
 * Structural audit of a single-logical-stream Ogg Opus file
 * (RFC 3533 + RFC 7845 + RFC 6716).
 *
 * The auditor is deliberately stricter than a tolerant player: it never
 * re-synchronises after a bad capture pattern, checks every page CRC,
 * verifies BOS/EOS/continuation flag consistency, reconstructs every
 * Ogg packet across page boundaries, validates each Opus packet's TOC
 * framing, and proves that the granule-position timeline matches the
 * 48 kHz sample counts derived from the TOC bytes.
 */
import { oggCrc32 } from "./crc32ogg.js";
import { inspectOpusPacket, inspectSelfDelimitedOpusPacket, OpusFormatError, OpusTruncationError, } from "./opusToc.js";
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_PAGES = 2048;
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const OPUS_HEAD_MAGIC = 0x4f70757348656164n; // "OpusHead", big-endian bytes
const OPUS_TAGS_MAGIC = "OpusTags";
const GRANULE_UNSET = -1;
const FLAG_CONTINUED = 0x01;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
const KNOWN_FLAGS = FLAG_CONTINUED | FLAG_BOS | FLAG_EOS;
export class AuditError extends Error {
    code;
    status;
    /** Zero-based index of the first failing page. */
    pageIndex;
    constructor(code, pageIndex, message, status = 422) {
        super(message);
        this.name = "AuditError";
        this.code = code;
        this.pageIndex = pageIndex;
        this.status = status;
    }
}
function fail(code, pageIndex, message, status = 422) {
    throw new AuditError(code, pageIndex, message, status);
}
function readU32Le(data, offset) {
    return ((data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)) >>>
        0);
}
function readGranule(data, offset, pageIndex) {
    let raw = 0n;
    for (let i = 0; i < 8; i++) {
        raw |= BigInt(data[offset + i]) << BigInt(i * 8);
    }
    if (raw === 0xffffffffffffffffn) {
        return GRANULE_UNSET;
    }
    // Anything beyond 2^53-1 cannot describe a credible 48 kHz timeline
    // (~59 million years) and would lose integer precision downstream.
    if (raw > Number.MAX_SAFE_INTEGER) {
        fail("GRANULE_SPAN_INVALID", pageIndex, "granule position exceeds the integer-safe range");
    }
    return Number(raw);
}
function parsePage(buf, start, index) {
    if (start + 27 > buf.length) {
        fail("TRUNCATED_PAGE", index, "page header is incomplete");
    }
    for (let i = 0; i < 4; i++) {
        if (buf[start + i] !== OGG_MAGIC[i]) {
            fail("BAD_CAPTURE_PATTERN", index, "missing OggS capture pattern");
        }
    }
    if (buf[start + 4] !== 0) {
        fail("UNSUPPORTED_OGG_VERSION", index, "unsupported Ogg stream structure version");
    }
    const headerType = buf[start + 5];
    if (headerType & ~KNOWN_FLAGS) {
        fail("RESERVED_HEADER_FLAG", index, "reserved header type flag bits are set");
    }
    const granule = readGranule(buf, start + 6, index);
    const serial = readU32Le(buf, start + 14);
    const sequence = readU32Le(buf, start + 18);
    const storedCrc = readU32Le(buf, start + 22);
    const segmentCount = buf[start + 26];
    const headerSize = 27 + segmentCount;
    if (start + headerSize > buf.length) {
        fail("TRUNCATED_PAGE", index, "segment table runs past end of input");
    }
    const segments = buf.subarray(start + 27, start + headerSize);
    let bodyLength = 0;
    for (let i = 0; i < segments.length; i++) {
        bodyLength += segments[i];
    }
    const pageEnd = start + headerSize + bodyLength;
    if (pageEnd > buf.length) {
        fail("TRUNCATED_PAGE", index, "page body runs past end of input");
    }
    // CRC covers the whole page with the 4 CRC bytes treated as zero.
    const crcBytes = buf.slice(start, pageEnd);
    crcBytes[22] = 0;
    crcBytes[23] = 0;
    crcBytes[24] = 0;
    crcBytes[25] = 0;
    if (oggCrc32(crcBytes) !== storedCrc) {
        fail("BAD_CRC", index, "Ogg page CRC-32 mismatch");
    }
    const body = buf.subarray(start + headerSize, pageEnd);
    return { index, headerType, granule, serial, sequence, segments, body, pageStart: start, pageEnd };
}
const FAMILY_1_LAYOUTS = {
    1: { streams: 1, coupled: 0, mapping: [0] },
    2: { streams: 1, coupled: 1, mapping: [0, 1] },
    3: { streams: 2, coupled: 1, mapping: [0, 1, 2] },
    4: { streams: 2, coupled: 2, mapping: [0, 1, 2, 3] },
    5: { streams: 3, coupled: 2, mapping: [0, 1, 2, 3, 4] },
    6: { streams: 4, coupled: 2, mapping: [0, 1, 2, 3, 4, 5] },
    7: { streams: 5, coupled: 2, mapping: [0, 1, 2, 3, 4, 5, 6] },
    8: { streams: 5, coupled: 3, mapping: [0, 1, 2, 3, 4, 5, 6, 7] },
};
function validateIdHeader(packet, pageIndex) {
    let magic = 0n;
    for (let i = 0; i < 8; i++) {
        magic = (magic << 8n) | BigInt(packet[i] ?? 0);
    }
    if (magic !== OPUS_HEAD_MAGIC) {
        fail("ID_HEADER_INVALID", pageIndex, "first packet is not OpusHead");
    }
    if (packet.length < 19) {
        fail("ID_HEADER_INVALID", pageIndex, "OpusHead packet shorter than 19 bytes");
    }
    const version = packet[8];
    if (version !== 1) {
        fail("ID_HEADER_INVALID", pageIndex, `unsupported OpusHead version ${version}`);
    }
    const channels = packet[9];
    if (channels === 0) {
        fail("ID_HEADER_INVALID", pageIndex, "OpusHead channel count is zero");
    }
    const preSkip = packet[10] | (packet[11] << 8);
    const mappingFamily = packet[18];
    if (mappingFamily === 0) {
        if (channels > 2) {
            fail("ID_HEADER_INVALID", pageIndex, "mapping family 0 allows at most 2 channels");
        }
        if (packet.length !== 19) {
            fail("ID_HEADER_INVALID", pageIndex, "family 0 OpusHead must be exactly 19 bytes");
        }
        return {
            channels,
            preSkip,
            mappingFamily: 0,
            streamCount: 1,
            coupledStreamCount: channels - 1,
        };
    }
    if (mappingFamily === 1) {
        if (channels < 1 || channels > 8) {
            fail("CHANNEL_MAPPING_INVALID", pageIndex, "mapping family 1 records carry 1 to 8 channels");
        }
        // RFC 7845 5.1: streams (19), coupled streams (20), then C mapping octets.
        const expectedLength = 21 + channels;
        if (packet.length < expectedLength) {
            fail("CHANNEL_MAPPING_INVALID", pageIndex, "family 1 OpusHead too short for stream count, coupled count and mapping table");
        }
        if (packet.length > expectedLength) {
            fail("CHANNEL_MAPPING_INVALID", pageIndex, "trailing bytes after the family 1 channel mapping table");
        }
        const streamCount = packet[19];
        const coupledStreamCount = packet[20];
        if (streamCount === 0) {
            fail("CHANNEL_MAPPING_INVALID", pageIndex, "family 1 stream count must not be zero");
        }
        if (coupledStreamCount > streamCount) {
            fail("CHANNEL_MAPPING_INVALID", pageIndex, "coupled stream count must not exceed the total stream count");
        }
        if (streamCount + coupledStreamCount > channels) {
            fail("CHANNEL_MAPPING_INVALID", pageIndex, "decoded channel count (streams + coupled) exceeds the output channel count");
        }
        const layout = FAMILY_1_LAYOUTS[channels];
        if (layout === undefined ||
            streamCount !== layout.streams ||
            coupledStreamCount !== layout.coupled) {
            fail("CHANNEL_MAPPING_INVALID", pageIndex, `family 1 ${channels}-channel header must declare ${layout?.streams ?? "?"} streams with ${layout?.coupled ?? "?"} coupled`);
        }
        const mapping = Array.from(packet.subarray(21, 21 + channels));
        for (let i = 0; i < mapping.length; i++) {
            if (mapping[i] !== layout.mapping[i]) {
                fail("CHANNEL_MAPPING_INVALID", pageIndex, `family 1 ${channels}-channel mapping table must be the canonical Vorbis layout`);
            }
        }
        return { channels, preSkip, mappingFamily: 1, streamCount, coupledStreamCount };
    }
    fail("CHANNEL_MAPPING_UNSUPPORTED", pageIndex, `channel mapping family ${mappingFamily} is not supported`);
}
function validateCommentHeader(packet, pageIndex) {
    if (packet.length < 16) {
        fail("COMMENT_HEADER_INVALID", pageIndex, "OpusTags packet shorter than 16 bytes");
    }
    for (let i = 0; i < 8; i++) {
        if (packet[i] !== OPUS_TAGS_MAGIC.charCodeAt(i)) {
            fail("COMMENT_HEADER_INVALID", pageIndex, "second packet is not OpusTags");
        }
    }
    let pos = 8;
    const vendorLength = readU32Le(packet, pos);
    pos += 4;
    if (vendorLength > packet.length - pos) {
        fail("COMMENT_HEADER_INVALID", pageIndex, "vendor string runs past OpusTags packet");
    }
    pos += vendorLength;
    if (pos + 4 > packet.length) {
        fail("COMMENT_HEADER_INVALID", pageIndex, "missing comment count in OpusTags");
    }
    const commentCount = readU32Le(packet, pos);
    pos += 4;
    for (let i = 0; i < commentCount; i++) {
        if (pos + 4 > packet.length) {
            fail("COMMENT_HEADER_INVALID", pageIndex, "comment length runs past OpusTags packet");
        }
        const commentLength = readU32Le(packet, pos);
        pos += 4;
        if (commentLength > packet.length - pos) {
            fail("COMMENT_HEADER_INVALID", pageIndex, "comment body runs past OpusTags packet");
        }
        pos += commentLength;
    }
    if (pos !== packet.length) {
        fail("COMMENT_HEADER_INVALID", pageIndex, "trailing bytes after OpusTags comments");
    }
}
function concatChunks(chunks) {
    if (chunks.length === 1) {
        // Copy so the retained packet never aliases the shared input buffer.
        return chunks[0].slice();
    }
    let total = 0;
    for (const chunk of chunks) {
        total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
/**
 * Walk one page's lacing values together with any packet continued from
 * the previous page. Returns the Ogg packets that complete on this page
 * and the (copied) chunks of a packet still open at its end.
 */
function walkPageSegments(page, carriedChunks) {
    const completed = [];
    let chunks = carriedChunks;
    let cursor = 0;
    for (let i = 0; i < page.segments.length; i++) {
        const lacing = page.segments[i];
        const slice = page.body.subarray(cursor, cursor + lacing);
        cursor += lacing;
        if (chunks === null) {
            chunks = [];
        }
        chunks.push(slice);
        if (lacing < 255) {
            completed.push(concatChunks(chunks));
            chunks = null;
        }
    }
    return { completed, openChunks: chunks };
}
/**
 * Validate one audio Ogg packet against the OpusHead layout and return
 * its 48 kHz duration (counted once per Ogg packet, never per
 * substream).
 *
 * Mapping family 0 packets carry one regular Opus packet. Mapping
 * family 1 packets pack N Opus substreams (RFC 7845 3): the first N-1
 * use RFC 6716 Appendix B self-delimiting framing, the last one uses
 * regular framing. Every substream must be present with intact bounds;
 * the first M are stereo and the rest mono; and all of them must decode
 * the same number of samples (they share one packet duration).
 */
function inspectAudioPacket(packet, id, pageIndex) {
    if (packet.length === 0) {
        fail("OPUS_PACKET_INVALID", pageIndex, "zero-octet audio packet");
    }
    if (id.mappingFamily === 0) {
        let info;
        try {
            info = inspectOpusPacket(packet);
        }
        catch (err) {
            if (err instanceof OpusFormatError) {
                fail("OPUS_PACKET_INVALID", pageIndex, `malformed Opus packet: ${err.message}`);
            }
            throw err;
        }
        if (info.stereo !== (id.coupledStreamCount === 1)) {
            fail("CHANNEL_CONFIG_MISMATCH", pageIndex, "audio packet stereo flag does not match the OpusHead channel count");
        }
        return info.totalSamples;
    }
    // --- mapping family 1 multistream packet ---
    const n = id.streamCount;
    const m = id.coupledStreamCount;
    let cursor = 0;
    let expectedSamples = null;
    const reportFraming = (err, pageIndex, substream) => {
        if (err instanceof OpusTruncationError) {
            fail("SUBSTREAM_TRUNCATED", pageIndex, `multichannel substream ${substream} is missing or its bounds are incomplete: ${err.message}`);
        }
        if (err instanceof OpusFormatError) {
            fail("MULTISTREAM_PACKET_INVALID", pageIndex, `malformed multichannel substream ${substream}: ${err.message}`);
        }
        throw err;
    };
    for (let s = 0; s < n; s++) {
        const wantStereo = s < m;
        let info;
        if (s < n - 1) {
            // All but the last substream use self-delimiting framing.
            try {
                const result = inspectSelfDelimitedOpusPacket(packet, cursor);
                info = result.info;
                cursor = result.next;
            }
            catch (err) {
                reportFraming(err, pageIndex, s);
            }
        }
        else {
            // The final substream uses regular framing and, per RFC 7845 3,
            // consumes every remaining byte of the Ogg packet.
            if (cursor >= packet.length) {
                fail("SUBSTREAM_TRUNCATED", pageIndex, `multichannel packet ends before substream ${s}`);
            }
            try {
                info = inspectOpusPacket(packet.subarray(cursor));
            }
            catch (err) {
                reportFraming(err, pageIndex, s);
            }
        }
        if (info.stereo !== wantStereo) {
            fail("CHANNEL_CONFIG_MISMATCH", pageIndex, `substream ${s} stereo flag does not match the coupled/uncoupled stream layout`);
        }
        if (expectedSamples === null) {
            expectedSamples = info.totalSamples;
        }
        else if (info.totalSamples !== expectedSamples) {
            fail("SUBSTREAM_DURATION_MISMATCH", pageIndex, `substream ${s} decodes ${info.totalSamples} samples but earlier substreams decode ${expectedSamples}`);
        }
    }
    return expectedSamples ?? 0;
}
export function auditOggOpus(input) {
    if (input.length === 0) {
        fail("EMPTY_INPUT", null, "request body is empty", 400);
    }
    if (input.length > MAX_BODY_BYTES) {
        fail("PAYLOAD_TOO_LARGE", null, "input exceeds 8 MiB limit", 413);
    }
    let offset = 0;
    let pageCount = 0;
    let phase = "id";
    let serial = null;
    let expectedSequence = 0;
    let sawEos = false;
    let openChunks = null;
    let previousEndedOpen = false;
    let decodedSamples = 0;
    let audioPacketCount = 0;
    let lastAudioGranule = null;
    let id = {
        channels: 0,
        preSkip: 0,
        mappingFamily: 0,
        streamCount: 1,
        coupledStreamCount: 0,
    };
    while (offset < input.length) {
        const index = pageCount;
        if (index >= MAX_PAGES) {
            fail("TOO_MANY_PAGES", index, "stream exceeds 2048 pages");
        }
        const page = parsePage(input, offset, index);
        pageCount += 1;
        offset = page.pageEnd;
        const eosFlag = (page.headerType & FLAG_EOS) !== 0;
        const continuedFlag = (page.headerType & FLAG_CONTINUED) !== 0;
        const bosFlag = (page.headerType & FLAG_BOS) !== 0;
        /* ---- stream-level flag / sequencing checks ---- */
        if (index === 0) {
            if (!bosFlag || continuedFlag) {
                fail("BOS_FLAG_INVALID", index, "first page must be BOS without continuation");
            }
            if (eosFlag) {
                fail("EOS_FLAG_INVALID", index, "BOS page cannot also be EOS");
            }
            if (page.sequence !== 0) {
                fail("PAGE_SEQUENCE_INVALID", index, "first page sequence number must be 0");
            }
        }
        else {
            if (bosFlag) {
                fail("BOS_FLAG_INVALID", index, "BOS flag set after the first page");
            }
            if (page.sequence !== expectedSequence) {
                fail("PAGE_SEQUENCE_INVALID", index, `expected sequence ${expectedSequence}, got ${page.sequence}`);
            }
            if (previousEndedOpen !== continuedFlag) {
                fail("CONTINUATION_FLAG_INVALID", index, previousEndedOpen
                    ? "packet continues from previous page but continuation flag is unset"
                    : "continuation flag set without an open packet on the previous page");
            }
            if (sawEos) {
                fail("EOS_FLAG_INVALID", index, "page present after end-of-stream");
            }
        }
        expectedSequence = (page.sequence + 1) >>> 0;
        if (serial === null) {
            serial = page.serial;
        }
        else if (page.serial !== serial) {
            fail("SERIAL_NUMBER_MISMATCH", index, "all pages must share one logical stream serial");
        }
        /* ---- lacing / packet reconstruction ---- */
        const { completed, openChunks: nextOpenChunks } = walkPageSegments(page, continuedFlag ? openChunks : null);
        const endsOpen = nextOpenChunks !== null;
        if (phase === "id") {
            if (endsOpen || completed.length !== 1) {
                fail("ID_HEADER_INVALID", index, "OpusHead must complete alone on the first page");
            }
            if (page.granule !== 0) {
                fail("HEADER_GRANULE_INVALID", index, "ID header page granule must be zero");
            }
            const parsedId = validateIdHeader(completed[0], index);
            id.channels = parsedId.channels;
            id.preSkip = parsedId.preSkip;
            id.mappingFamily = parsedId.mappingFamily;
            id.streamCount = parsedId.streamCount;
            id.coupledStreamCount = parsedId.coupledStreamCount;
            phase = "tags";
        }
        else if (phase === "tags") {
            if (eosFlag) {
                fail("EOS_FLAG_INVALID", index, "stream ends before any audio data");
            }
            if (completed.length === 0) {
                // OpusTags still spanning this page: no packet finishes here.
                if (page.segments.length === 0 || !endsOpen) {
                    fail("EMPTY_PAGE_INVALID", index, "empty page inside the comment header span");
                }
                if (page.granule !== GRANULE_UNSET) {
                    fail("HEADER_GRANULE_INVALID", index, "page spanned by OpusTags must carry granule -1");
                }
            }
            else {
                if (completed.length !== 1 || endsOpen) {
                    fail("COMMENT_HEADER_INVALID", index, "no other packet may share the page where OpusTags completes");
                }
                if (page.granule !== 0) {
                    fail("HEADER_GRANULE_INVALID", index, "OpusTags completion page granule must be zero");
                }
                validateCommentHeader(completed[0], index);
                phase = "audio";
            }
        }
        else {
            /* ---- audio phase ---- */
            if (page.segments.length === 0) {
                // RFC 3533 allows a segment-less "nil" page, but only as the
                // final EOS page carrying the definitive granule position.
                if (!eosFlag) {
                    fail("EMPTY_PAGE_INVALID", index, "non-EOS page without segment data");
                }
                if (page.granule !== (lastAudioGranule ?? 0)) {
                    fail("EOS_GRANULE_INVALID", index, "nil EOS page granule must equal the previous completed-packet granule");
                }
            }
            else if (completed.length === 0) {
                // Entirely inside a packet that completes on a later page.
                if (page.granule !== GRANULE_UNSET) {
                    fail("GRANULE_SPAN_INVALID", index, "page without a completed packet must carry granule -1");
                }
                if (eosFlag) {
                    fail("AUDIO_PACKET_TRUNCATED", index, "stream ends with an unclosed audio packet");
                }
            }
            else {
                let pageSamples = 0;
                for (const packet of completed) {
                    // Each Ogg audio packet contributes its duration once even
                    // though a family 1 packet holds several Opus substreams.
                    pageSamples += inspectAudioPacket(packet, id, index);
                }
                if (page.granule === GRANULE_UNSET) {
                    fail("GRANULE_MISSING", index, "page completing audio packets must carry a granule");
                }
                if (eosFlag) {
                    // RFC 7845 4.4: the EOS granule trims the packets completing
                    // on the final page, so it sits between the previous granule
                    // and that granule plus this page's own packet samples. A
                    // leading offset on the first page is preserved in the
                    // granule timeline, hence the comparison is against the
                    // previous granule, not the raw decoded-sample total.
                    const previous = lastAudioGranule ?? 0;
                    if (page.granule < previous) {
                        fail("EOS_GRANULE_INVALID", index, "EOS granule trims past the previous completed-packet granule");
                    }
                    if (page.granule > previous + pageSamples) {
                        fail("EOS_GRANULE_INVALID", index, "EOS granule exceeds the samples completed on the final page");
                    }
                    if (lastAudioGranule === null && page.granule < id.preSkip) {
                        fail("EOS_GRANULE_INVALID", index, "single-page EOS granule is smaller than the OpusHead pre-skip");
                    }
                }
                else {
                    // Every ordinary (non-EOS) audio page must place its granule
                    // exactly at the accumulated 48 kHz sample count. RFC 7845
                    // 4.5 permits a larger initial granule for joined live
                    // streams, but an archive record must not carry such an
                    // offset: it would look like a duration drift after the
                    // player's tolerance concealed it.
                    const expected = (lastAudioGranule ?? 0) + pageSamples;
                    if (page.granule !== expected) {
                        fail("GRANULE_MISMATCH", index, "audio page granule does not equal accumulated packet samples");
                    }
                }
                lastAudioGranule = page.granule;
                decodedSamples += pageSamples;
                audioPacketCount += completed.length;
            }
            if (eosFlag && endsOpen) {
                fail("AUDIO_PACKET_TRUNCATED", index, "EOS page ends with an unclosed audio packet");
            }
        }
        if (eosFlag) {
            sawEos = true;
        }
        openChunks = nextOpenChunks;
        previousEndedOpen = endsOpen;
    }
    if (phase !== "audio") {
        fail("STREAM_NOT_TERMINATED", pageCount - 1, "both OpusHead and OpusTags are required");
    }
    if (previousEndedOpen) {
        fail("AUDIO_PACKET_TRUNCATED", pageCount - 1, "last page leaves an audio packet without a closing lacing value");
    }
    if (!sawEos) {
        fail("STREAM_NOT_TERMINATED", pageCount - 1, "logical stream has no end-of-stream page; record may be truncated");
    }
    const finalGranule = lastAudioGranule ?? 0;
    const playableSamples = Math.max(0, finalGranule - id.preSkip);
    return {
        pageCount,
        audioPacketCount,
        decodedSamples,
        playableSamples,
    };
}
