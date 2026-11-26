#!/usr/bin/env node
// Zero-dependency deterministic compression verifier for swarmcomp-v1.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { computeTotalBytes, decodePipeline, validatePipeline } from "./decoder.mjs";

export const DEFAULT_MAX_BYTES = 262_144;
const REQUIRED_KEYS = ["target", "format", "pipeline", "payload_b64"];
const ALLOWED_KEYS = new Set(REQUIRED_KEYS);
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function rejected(reasonCode, reason, extra = {}) {
  return {
    verdict: "REJECTED",
    reason_code: reasonCode,
    reason,
    resolution: "",
    metric_value: extra.metric_value ?? null,
    holder_value: extra.holder_value ?? null,
    proof_lines: 0,
    wasm_bytes: 0,
    class_fuel: "{}",
  };
}

export function parseAndValidateSubmission(rawText, targetSpec, maxBytes = DEFAULT_MAX_BYTES) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return { ok: false, error: rejected("schema_error", "submission file is empty") };
  }
  if (Buffer.byteLength(rawText, "utf8") > maxBytes) {
    return { ok: false, error: rejected("size_limit", `submission exceeds ${maxBytes} bytes`) };
  }
  let doc;
  try {
    doc = JSON.parse(rawText);
  } catch {
    return { ok: false, error: rejected("schema_error", "submission is not strict JSON") };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: rejected("schema_error", "submission root must be an object") };
  }
  for (const k of Object.keys(doc)) {
    if (!ALLOWED_KEYS.has(k)) {
      return { ok: false, error: rejected("schema_error", `unexpected field: ${k.slice(0, 32)}`) };
    }
  }
  for (const k of REQUIRED_KEYS) {
    if (!(k in doc)) {
      return { ok: false, error: rejected("schema_error", `missing required field: ${k}`) };
    }
  }
  if (doc.target !== targetSpec.name) {
    return { ok: false, error: rejected("schema_error", "target does not match spec") };
  }
  if (doc.format !== "swarmcomp-v1") {
    return { ok: false, error: rejected("schema_error", "format must be swarmcomp-v1") };
  }
  const pipeErr = validatePipeline(doc.pipeline);
  if (pipeErr) {
    return { ok: false, error: rejected("schema_error", pipeErr) };
  }
  if (typeof doc.payload_b64 !== "string" || doc.payload_b64.length % 4 !== 0 || !B64_RE.test(doc.payload_b64)) {
    return { ok: false, error: rejected("schema_error", "payload_b64 must be canonical base64") };
  }
  const payload = Buffer.from(doc.payload_b64, "base64");
  const totalBytes = computeTotalBytes(doc.pipeline, payload.length);
  return { ok: true, doc, payload, totalBytes };
}

export function verifyCandidate(rawText, targetSpec, expectedCorpus, holderBytes, maxBytes = DEFAULT_MAX_BYTES) {
  const parsed = parseAndValidateSubmission(rawText, targetSpec, maxBytes);
  if (!parsed.ok) {
    return { ...parsed.error, holder_value: holderBytes };
  }
  const { doc, payload, totalBytes } = parsed;
  let decoded;
  try {
    decoded = decodePipeline(doc.pipeline, payload);
  } catch (err) {
    return rejected("wrong_answer", `decode error: ${err instanceof Error ? err.message : "unknown"}`, {
      metric_value: totalBytes,
      holder_value: holderBytes,
    });
  }
  if (decoded.length !== expectedCorpus.length) {
    return rejected(
      "wrong_answer",
      `decoded length ${decoded.length} !== expected ${expectedCorpus.length}`,
      { metric_value: totalBytes, holder_value: holderBytes },
    );
  }
  const gotSha = createHash("sha256").update(decoded).digest("hex");
  const expSha = createHash("sha256").update(expectedCorpus).digest("hex");
  if (gotSha !== expSha) {
    let firstDiff = -1;
    for (let i = 0; i < decoded.length; i += 1) {
      if (decoded[i] !== expectedCorpus[i]) {
        firstDiff = i;
        break;
      }
    }
    return rejected(
      "wrong_answer",
      `SHA-256 mismatch against corpus (first differing byte at offset ${firstDiff})`,
      { metric_value: totalBytes, holder_value: holderBytes },
    );
  }
  if (totalBytes >= holderBytes) {
    return rejected(
      "bound_not_improved",
      `total encoded size ${totalBytes} bytes does not beat holder ${holderBytes} bytes`,
      { metric_value: totalBytes, holder_value: holderBytes },
    );
  }
  return {
    verdict: "ACCEPTED",
    reason_code: "",
    reason: `lossless roundtrip verified (${doc.pipeline.length} stage(s), ${totalBytes} < ${holderBytes} bytes)`,
    resolution: "improved",
    metric_value: totalBytes,
    holder_value: holderBytes,
    proof_lines: doc.pipeline.length,
    wasm_bytes: totalBytes,
    class_fuel: "{}",
  };
}

export function verifySelfCheck(manifestPath) {
  const absManifest = resolve(manifestPath);
  const rootDir = dirname(absManifest);
  const manifest = JSON.parse(readFileSync(absManifest, "utf8"));
  const maxBytes = manifest.max_bytes ?? DEFAULT_MAX_BYTES;
  const results = [];
  let allOk = true;
  for (const target of manifest.targets ?? []) {
    const corpusBuf = readFileSync(resolve(rootDir, target.corpus_path));
    const corpusSha = createHash("sha256").update(corpusBuf).digest("hex");
    if (corpusSha !== target.corpus_sha256 || corpusBuf.length !== target.corpus_bytes) {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: "schema_error", reason: "corpus checksum mismatch" });
      continue;
    }
    const raw = readFileSync(resolve(rootDir, target.file_path), "utf8");
    const res = verifyCandidate(raw, target, corpusBuf, target.baseline_value + 1, maxBytes);
    if (res.verdict !== "ACCEPTED") {
      allOk = false;
      results.push({ target: target.name, ok: false, reason_code: res.reason_code, reason: res.reason });
      continue;
    }
    results.push({ target: target.name, ok: true, encoded_bytes: res.metric_value, stages: res.proof_lines });
  }
  return { ok: allOk, checked: results.length, results };
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function holderTotalBytes(holderPath, targetSpec) {
  if (!holderPath) return targetSpec.baseline_value;
  try {
    const doc = JSON.parse(readFileSync(holderPath, "utf8"));
    return computeTotalBytes(doc.pipeline, Buffer.from(doc.payload_b64, "base64").length);
  } catch {
    return targetSpec.baseline_value;
  }
}

function main(argv) {
  if (argv[0] === "--self-check") {
    const res = verifySelfCheck(argv[1] ?? "targets.json");
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  if (argv[0] === "--score") {
    const doc = JSON.parse(readFileSync(argv[1], "utf8"));
    console.log(computeTotalBytes(doc.pipeline, Buffer.from(doc.payload_b64, "base64").length));
    process.exit(0);
  }
  if (argv[0] === "verify") {
    const flags = parseFlags(argv.slice(1));
    const manifestPath = flags.targets ?? "targets.json";
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const rootDir = dirname(resolve(manifestPath));
    const targetSpec = (manifest.targets ?? []).find((t) => t.name === flags.target);
    if (!targetSpec) {
      const err = rejected("schema_error", "unknown target");
      if (flags.out) writeFileSync(flags.out, `${JSON.stringify(err)}\n`);
      console.log(JSON.stringify(err));
      process.exit(0);
    }
    const expectedCorpus = readFileSync(resolve(rootDir, targetSpec.corpus_path));
    const holderBytes = holderTotalBytes(flags.holder, targetSpec);
    const rawCandidate = readFileSync(flags.candidate, "utf8");
    const verdict = verifyCandidate(
      rawCandidate,
      targetSpec,
      expectedCorpus,
      holderBytes,
      manifest.max_bytes ?? DEFAULT_MAX_BYTES,
    );
    if (flags.out) writeFileSync(flags.out, `${JSON.stringify(verdict)}\n`);
    console.log(JSON.stringify(verdict));
    process.exit(0);
  }
  console.error("usage: verify.mjs --self-check [targets.json] | --score <file> | verify --targets <targets.json> --target <name> --candidate <file>");
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
