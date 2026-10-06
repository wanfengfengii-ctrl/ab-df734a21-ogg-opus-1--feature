/**
 * Ogg CRC-32 as defined in RFC 3533 section 6:
 * polynomial 0x04c11db7, init 0, no reflection, no final XOR.
 */
const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) {
            r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
        }
        table[i] = r >>> 0;
    }
    return table;
})();
export function oggCrc32(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
        crc = ((crc << 8) ^ TABLE[((crc >>> 24) & 0xff) ^ (data[i] ?? 0)]) >>> 0;
    }
    return crc >>> 0;
}
