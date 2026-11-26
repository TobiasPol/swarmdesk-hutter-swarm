// Zero-dependency deterministic bytecode decompressor for swarmcomp-v1.
// No dynamic code execution; bounded memory and exact stage-overhead byte accounting.

export const HEADER_BYTES = 4; // 4-byte magic/version header ("SCV1")
export const MAX_STAGE_COUNT = 12;
export const MAX_DECODED_BYTES = 262_144; // 256 KiB hard cap per stage
export const MAX_DICT_ENTRIES = 255; // index 255 is reserved for escaped literal byte

const VALID_OPS = new Set(["raw", "rle0", "mtf", "bwt", "delta", "lz77", "dict", "huffman"]);

function stageOverhead(stage) {
  switch (stage.op) {
    case "raw":
    case "rle0":
    case "mtf":
    case "delta":
    case "lz77":
      return 1;
    case "bwt":
      return 5; // 1 opcode + 4-byte primary_index
    case "dict": {
      let total = 2; // 1 opcode + 1 escape byte
      for (const entry of stage.entries) {
        total += 2 + Buffer.byteLength(entry, "utf8");
      }
      return total;
    }
    case "huffman":
      return 1 + 4 + 128; // 1 opcode + 4-byte out_len + 256 4-bit code lengths
    default:
      throw new Error(`unsupported op: ${stage.op}`);
  }
}

export function validatePipeline(pipeline) {
  if (!Array.isArray(pipeline) || pipeline.length === 0 || pipeline.length > MAX_STAGE_COUNT) {
    return `pipeline must contain 1..${MAX_STAGE_COUNT} stages`;
  }
  for (let i = 0; i < pipeline.length; i += 1) {
    const s = pipeline[i];
    if (!s || typeof s !== "object" || Array.isArray(s) || !VALID_OPS.has(s.op)) {
      return `pipeline[${i}] has invalid op`;
    }
    const keys = Object.keys(s);
    if (s.op === "raw" || s.op === "rle0" || s.op === "mtf" || s.op === "delta" || s.op === "lz77") {
      if (keys.length !== 1) return `pipeline[${i}] (${s.op}) accepts no extra fields`;
    } else if (s.op === "bwt") {
      if (keys.length !== 2 || !Number.isInteger(s.primary_index) || s.primary_index < 0) {
        return `pipeline[${i}] (bwt) requires non-negative integer primary_index`;
      }
    } else if (s.op === "dict") {
      if (
        keys.length !== 3 ||
        !Number.isInteger(s.escape) ||
        s.escape < 0 ||
        s.escape > 255 ||
        !Array.isArray(s.entries) ||
        s.entries.length > MAX_DICT_ENTRIES ||
        !s.entries.every((e) => typeof e === "string" && e.length > 0 && Buffer.byteLength(e, "utf8") <= 1024)
      ) {
        return `pipeline[${i}] (dict) requires escape byte 0..255 and <= ${MAX_DICT_ENTRIES} non-empty string entries`;
      }
    } else if (s.op === "huffman") {
      if (
        keys.length !== 3 ||
        !Number.isInteger(s.out_len) ||
        s.out_len < 0 ||
        s.out_len > MAX_DECODED_BYTES ||
        !Array.isArray(s.lengths) ||
        s.lengths.length !== 256 ||
        !s.lengths.every((l) => Number.isInteger(l) && l >= 0 && l <= 15)
      ) {
        return `pipeline[${i}] (huffman) requires out_len in 0..${MAX_DECODED_BYTES} and 256 bit lengths in 0..15`;
      }
    }
  }
  return null;
}

export function computeTotalBytes(pipeline, payloadBytes) {
  let overhead = HEADER_BYTES;
  for (const stage of pipeline) {
    overhead += stageOverhead(stage);
  }
  return overhead + payloadBytes;
}

function decodeRle0(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    i += 1;
    if (b !== 0) {
      out.push(b);
      if (out.length > MAX_DECODED_BYTES) throw new Error("rle0 exceeded output limit");
      continue;
    }
    let count = 0;
    let shift = 0;
    while (true) {
      if (i >= buf.length) throw new Error("truncated rle0 varint");
      const byte = buf[i];
      i += 1;
      count |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 21) throw new Error("rle0 varint overflow");
    }
    if (count < 1 || out.length + count > MAX_DECODED_BYTES) {
      throw new Error("invalid rle0 run count");
    }
    for (let z = 0; z < count; z += 1) out.push(0);
  }
  return Buffer.from(out);
}

function decodeMtf(buf) {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = i;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i += 1) {
    const idx = buf[i];
    const sym = table[idx];
    out[i] = sym;
    for (let j = idx; j > 0; j -= 1) table[j] = table[j - 1];
    table[0] = sym;
  }
  return out;
}

function decodeDelta(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  let acc = 0;
  for (let i = 0; i < buf.length; i += 1) {
    acc = (acc + buf[i]) & 0xff;
    out[i] = acc;
  }
  return out;
}

function decodeBwt(buf, primaryIndex) {
  const n = buf.length;
  if (n === 0) return Buffer.alloc(0);
  if (primaryIndex < 0 || primaryIndex >= n) {
    throw new Error("bwt primary_index out of bounds");
  }
  const counts = new Int32Array(256);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const b = buf[i];
    rank[i] = counts[b];
    counts[b] += 1;
  }
  const starts = new Int32Array(256);
  let sum = 0;
  for (let b = 0; b < 256; b += 1) {
    starts[b] = sum;
    sum += counts[b];
  }
  const out = Buffer.allocUnsafe(n);
  let row = primaryIndex;
  for (let i = n - 1; i >= 0; i -= 1) {
    const b = buf[row];
    out[i] = b;
    row = starts[b] + rank[row];
  }
  return out;
}

function decodeLz77(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    i += 1;
    if (tag === 0) {
      if (i >= buf.length) throw new Error("truncated lz77 literal len");
      const len = buf[i];
      i += 1;
      if (len === 0 || i + len > buf.length) throw new Error("invalid lz77 literal span");
      if (out.length + len > MAX_DECODED_BYTES) throw new Error("lz77 exceeded output limit");
      for (let j = 0; j < len; j += 1) out.push(buf[i + j]);
      i += len;
    } else if (tag === 1) {
      if (i + 3 > buf.length) throw new Error("truncated lz77 match");
      const dist = buf[i] | (buf[i + 1] << 8);
      const len = buf[i + 2] + 3; // stored as len - 3 (3..258)
      i += 3;
      if (dist === 0 || dist > out.length) throw new Error("invalid lz77 match distance");
      if (out.length + len > MAX_DECODED_BYTES) throw new Error("lz77 exceeded output limit");
      for (let j = 0; j < len; j += 1) {
        out.push(out[out.length - dist]);
      }
    } else {
      throw new Error(`unknown lz77 tag ${tag}`);
    }
  }
  return Buffer.from(out);
}

function decodeDict(buf, escape, entries) {
  const entryBufs = entries.map((e) => Buffer.from(e, "utf8"));
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    i += 1;
    if (b !== escape) {
      out.push(b);
      if (out.length > MAX_DECODED_BYTES) throw new Error("dict exceeded output limit");
      continue;
    }
    if (i >= buf.length) throw new Error("truncated dict escape");
    const idx = buf[i];
    i += 1;
    if (idx === 255) {
      out.push(escape);
      if (out.length > MAX_DECODED_BYTES) throw new Error("dict exceeded output limit");
      continue;
    }
    if (idx >= entryBufs.length) throw new Error("dict index out of bounds");
    const sub = entryBufs[idx];
    if (out.length + sub.length > MAX_DECODED_BYTES) throw new Error("dict exceeded output limit");
    for (let j = 0; j < sub.length; j += 1) out.push(sub[j]);
  }
  return Buffer.from(out);
}

function decodeHuffman(buf, lengths, outLen) {
  if (outLen === 0) return Buffer.alloc(0);
  const blCount = new Int32Array(16);
  let maxLen = 0;
  for (let s = 0; s < 256; s += 1) {
    const l = lengths[s];
    if (l > 0) {
      blCount[l] += 1;
      if (l > maxLen) maxLen = l;
    }
  }
  if (maxLen === 0) throw new Error("huffman lengths are all zero");

  // Validate Kraft inequality: sum 2^(-l) <= 1 (exact scaled to 2^maxLen)
  let kraft = 0;
  const maxWeight = 1 << maxLen;
  for (let l = 1; l <= maxLen; l += 1) {
    kraft += blCount[l] * (1 << (maxLen - l));
  }
  if (kraft > maxWeight) throw new Error("huffman lengths violate Kraft inequality");

  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits += 1) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  // Canonical code lookup table keyed by `${len}:${code}` or fast prefix trie
  const tree = [{ sym: -1, zero: -1, one: -1 }];
  for (let s = 0; s < 256; s += 1) {
    const l = lengths[s];
    if (l === 0) continue;
    const c = nextCode[l];
    nextCode[l] += 1;
    let node = 0;
    for (let bitIdx = l - 1; bitIdx >= 0; bitIdx -= 1) {
      const bit = (c >> bitIdx) & 1;
      const edge = bit === 0 ? "zero" : "one";
      if (tree[node][edge] === -1) {
        tree[node][edge] = tree.length;
        tree.push({ sym: -1, zero: -1, one: -1 });
      }
      node = tree[node][edge];
    }
    if (tree[node].sym !== -1) throw new Error("duplicate huffman prefix");
    tree[node].sym = s;
  }

  const out = Buffer.allocUnsafe(outLen);
  let written = 0;
  let node = 0;
  let bytePos = 0;
  let bitLeft = 8;
  let curByte = buf.length > 0 ? buf[0] : 0;

  while (written < outLen) {
    if (bitLeft === 0) {
      bytePos += 1;
      if (bytePos >= buf.length) throw new Error("truncated huffman bitstream");
      curByte = buf[bytePos];
      bitLeft = 8;
    }
    bitLeft -= 1;
    const bit = (curByte >> bitLeft) & 1;
    node = bit === 0 ? tree[node].zero : tree[node].one;
    if (node === -1) throw new Error("invalid huffman code in bitstream");
    if (tree[node].sym !== -1) {
      out[written] = tree[node].sym;
      written += 1;
      node = 0;
    }
  }
  return out;
}

export function decodePipeline(pipeline, payloadBuf) {
  let cur = payloadBuf;
  for (const stage of pipeline) {
    switch (stage.op) {
      case "raw":
        break;
      case "rle0":
        cur = decodeRle0(cur);
        break;
      case "mtf":
        cur = decodeMtf(cur);
        break;
      case "delta":
        cur = decodeDelta(cur);
        break;
      case "bwt":
        cur = decodeBwt(cur, stage.primary_index);
        break;
      case "lz77":
        cur = decodeLz77(cur);
        break;
      case "dict":
        cur = decodeDict(cur, stage.escape, stage.entries);
        break;
      case "huffman":
        cur = decodeHuffman(cur, stage.lengths, stage.out_len);
        break;
      default:
        throw new Error(`unsupported op: ${stage.op}`);
    }
  }
  return cur;
}
