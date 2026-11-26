import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyCandidate, verifySelfCheck } from "./verify.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function encodeRle0(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0) {
      out.push(buf[i]);
      i += 1;
      continue;
    }
    let count = 0;
    while (i + count < buf.length && buf[i + count] === 0 && count < 127) count += 1;
    out.push(0, count);
    i += count;
  }
  return Buffer.from(out);
}

function encodeMtf(buf) {
  const table = Array.from({ length: 256 }, (_, idx) => idx);
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i += 1) {
    const sym = buf[i];
    const idx = table.indexOf(sym);
    out[i] = idx;
    table.splice(idx, 1);
    table.unshift(sym);
  }
  return out;
}

function encodeDict(buf, escapeByte, entries) {
  const text = buf.toString("utf8");
  const esc = escapeByte;
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let matched = -1;
    for (let e = 0; e < entries.length; e += 1) {
      if (text.startsWith(entries[e], i) && Buffer.byteLength(entries[e], "utf8") === entries[e].length) {
        matched = e;
        break;
      }
    }
    if (matched !== -1) {
      out.push(esc, matched);
      i += entries[matched].length;
    } else if (buf[i] === esc) {
      out.push(esc, 255);
      i += 1;
    } else {
      out.push(buf[i]);
      i += 1;
    }
  }
  return Buffer.from(out);
}

function encodeLz77Repeated(buf) {
  // Valid greedy literal + exact match encoder over small window
  const out = [];
  let i = 0;
  let lits = [];
  const flush = () => {
    while (lits.length > 0) {
      const chunk = lits.slice(0, 255);
      out.push(0, chunk.length, ...chunk);
      lits = lits.slice(chunk.length);
    }
  };
  while (i < buf.length) {
    let bestLen = 0;
    let bestDist = 0;
    const minPos = Math.max(0, i - 4096);
    for (let p = minPos; p < i; p += 1) {
      let l = 0;
      while (l < 258 && i + l < buf.length && buf[p + l] === buf[i + l]) l += 1;
      if (l >= 4 && l > bestLen) {
        bestLen = l;
        bestDist = i - p;
      }
    }
    if (bestLen >= 4) {
      flush();
      out.push(1, bestDist & 0xff, (bestDist >> 8) & 0xff, bestLen - 3);
      i += bestLen;
    } else {
      lits.push(buf[i]);
      i += 1;
    }
  }
  flush();
  return Buffer.from(out);
}

test("all baseline manifests and corpora pass self-check", () => {
  const res = verifySelfCheck(resolve(ROOT, "targets.json"));
  assert.equal(res.ok, true);
  assert.equal(res.checked, 4);
});

test("dict + mtf + rle0 pipeline compresses corpus losslessly and wins", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "targets.json"), "utf8"));
  const spec = manifest.targets[1]; // enwik_infobox_32k
  const corpus = readFileSync(resolve(ROOT, spec.corpus_path));
  const entries = ["{{Infobox benchmark\n", "| primary_metric = ", "[[Category:", " class=\"wikitable sortable\"\n"];
  const afterDict = encodeDict(corpus, 0x1f, entries);
  const afterMtf = encodeMtf(afterDict);
  const afterRle = encodeRle0(afterMtf);
  // Decode order in pipeline is inverse order: first rle0 -> mtf -> dict
  const doc = {
    target: spec.name,
    format: "swarmcomp-v1",
    pipeline: [
      { op: "rle0" },
      { op: "mtf" },
      { op: "dict", escape: 0x1f, entries },
    ],
    payload_b64: afterRle.toString("base64"),
  };
  const verdict = verifyCandidate(JSON.stringify(doc), spec, corpus, spec.baseline_value);
  assert.equal(verdict.verdict, "ACCEPTED");
  assert.ok(verdict.metric_value < spec.baseline_value);
});

test("lz77 compressed payload achieves huge reduction and beats holder", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "targets.json"), "utf8"));
  const spec = manifest.targets[0];
  const corpus = readFileSync(resolve(ROOT, spec.corpus_path));
  const lz = encodeLz77Repeated(corpus);
  const doc = {
    target: spec.name,
    format: "swarmcomp-v1",
    pipeline: [{ op: "lz77" }],
    payload_b64: lz.toString("base64"),
  };
  const verdict = verifyCandidate(JSON.stringify(doc), spec, corpus, spec.baseline_value);
  assert.equal(verdict.verdict, "ACCEPTED");
  assert.ok(verdict.metric_value < 20000);
});

test("corrupted decoded byte is rejected with SHA-256 mismatch", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "targets.json"), "utf8"));
  const spec = manifest.targets[0];
  const corpus = readFileSync(resolve(ROOT, spec.corpus_path));
  const mutated = Buffer.from(corpus);
  mutated[42] ^= 0x01;
  const doc = {
    target: spec.name,
    format: "swarmcomp-v1",
    pipeline: [{ op: "raw" }],
    payload_b64: mutated.toString("base64"),
  };
  const verdict = verifyCandidate(JSON.stringify(doc), spec, corpus, spec.baseline_value + 10);
  assert.equal(verdict.verdict, "REJECTED");
  assert.equal(verdict.reason_code, "wrong_answer");
});

test("non-improving submission is rejected with bound_not_improved", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "targets.json"), "utf8"));
  const spec = manifest.targets[0];
  const corpus = readFileSync(resolve(ROOT, spec.corpus_path));
  const raw = readFileSync(resolve(ROOT, spec.file_path), "utf8");
  const verdict = verifyCandidate(raw, spec, corpus, spec.baseline_value);
  assert.equal(verdict.verdict, "REJECTED");
  assert.equal(verdict.reason_code, "bound_not_improved");
});
