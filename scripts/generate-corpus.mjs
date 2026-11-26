#!/usr/bin/env node
// Generates deterministic, reproducible Wikipedia-style UTF-8 corpora for hutter-swarm
// and updates targets.json with exact byte lengths and SHA-256 checksums.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s;
  };
}

function pick(rng, arr) {
  return arr[rng() % arr.length];
}

const TOPICS = [
  ["Algorithmic information theory", "Solomonoff induction", "Ray Solomonoff", "1960", "Kolmogorov complexity"],
  ["Data compression", "Shannon entropy", "Claude Shannon", "1948", "Huffman coding"],
  ["Burrows-Wheeler transform", "Suffix array", "Michael Burrows", "1994", "Move-to-front transform"],
  ["Busy beaver", "Turing machine", "Tibor Rado", "1962", "Halting problem"],
  ["Kissing number", "Sphere packing", "Gregory Kabatiansky", "1978", "Leech lattice"],
  ["Strassen algorithm", "Matrix multiplication", "Volker Strassen", "1969", "Bilinear complexity"],
  ["Context mixing", "PAQ8", "Matt Mahoney", "2006", "Hutter Prize"],
  ["Arithmetic coding", "Asymmetric numeral systems", "Jarek Duda", "2009", "Entropy encoding"],
];

const VERBS = ["generalizes", "computes", "transforms", "bounds", "compresses", "minimizes", "proves", "relates"];
const DOMAINS = ["mathematics", "theoretical computer science", "information theory", "coding theory", "combinatorics"];

function generateArticlesCorpus(targetBytes) {
  const rng = makeRng(0x48555431);
  let out = "<mediawiki xmlns=\"http://www.mediawiki.org/xml/export-0.10/\" xml:lang=\"en\">\n";
  let id = 1001;
  while (Buffer.byteLength(out, "utf8") < targetBytes) {
    const [title, relA, author, year, relB] = pick(rng, TOPICS);
    const rev = 900000000 + (rng() % 90000000);
    const domain = pick(rng, DOMAINS);
    const verb = pick(rng, VERBS);
    const ts = `2026-0${1 + (rng() % 9)}-${10 + (rng() % 18)}T1${rng() % 9}:${10 + (rng() % 49)}:00Z`;
    out +=
      `  <page>\n` +
      `    <title>${title} (${id})</title>\n` +
      `    <ns>0</ns>\n` +
      `    <id>${id}</id>\n` +
      `    <revision>\n` +
      `      <id>${rev}</id>\n` +
      `      <timestamp>${ts}</timestamp>\n` +
      `      <contributor><username>WikiBot_${id % 17}</username><id>${500 + (id % 97)}</id></contributor>\n` +
      `      <text bytes="420" xml:space="preserve">{{Short description|Concept in ${domain}}}\n` +
      `'''${title}''' is a foundational topic in [[${domain}]], introduced around ${year} by [[${author}]].\n` +
      `In formal analysis, [[${relA}]] ${verb} exact descriptions alongside [[${relB}]].\n` +
      `== Formal properties ==\n` +
      `Given a binary string x of length ${64 + (rng() % 960)}, its prefix complexity K(x) satisfies ` +
      `K(x) <= |x| + 2*log2(|x|) + O(1). See also [[${relB}]] and [[${title}]].\n` +
      `[[Category:${domain}]] [[Category:${author}]]\n` +
      `</text>\n` +
      `    </revision>\n` +
      `  </page>\n`;
    id += 1;
  }
  return Buffer.from(out, "utf8").subarray(0, targetBytes);
}

function generateInfoboxCorpus(targetBytes) {
  const rng = makeRng(0x494e4632);
  let out = "";
  let idx = 1;
  while (Buffer.byteLength(out, "utf8") < targetBytes) {
    const [title, relA, author, year, relB] = pick(rng, TOPICS);
    const km = 1200 + (rng() % 88000);
    const pop = 45000 + (rng() % 9500000);
    out +=
      `{{Infobox benchmark\n` +
      `| name = ${title} Benchmark #${idx}\n` +
      `| author = [[${author}]]\n` +
      `| year = ${year}\n` +
      `| field = [[${pick(rng, DOMAINS)}]]\n` +
      `| primary_metric = ${km} bytes\n` +
      `| sample_count = ${pop}\n` +
      `| related = [[${relA}]], [[${relB}]]\n` +
      `| license = Apache-2.0\n` +
      `}}\n` +
      `{| class="wikitable sortable"\n` +
      `! Method !! Compressed Size (bytes) !! Bitrate (bpc) !! Deterministic\n` +
      `|-\n` +
      `| BWT + MTF + RLE0 || ${km} || ${(3.2 + (rng() % 20) * 0.1).toFixed(2)} || Yes\n` +
      `|-\n` +
      `| Context Mixing || ${Math.floor(km * 0.65)} || ${(1.4 + (rng() % 15) * 0.08).toFixed(2)} || Yes\n` +
      `|}\n\n`;
    idx += 1;
  }
  return Buffer.from(out, "utf8").subarray(0, targetBytes);
}

function generateMathCorpus(targetBytes) {
  const rng = makeRng(0x4d415433);
  let out = "";
  let theoremNo = 1;
  while (Buffer.byteLength(out, "utf8") < targetBytes) {
    const [title, relA, author, year] = pick(rng, TOPICS);
    const p = pick(rng, [2, 3, 5, 7, 11, 13, 17, 19]);
    const n = 2 + (rng() % 64);
    const q = 3 + (rng() % 97);
    out +=
      `=== Theorem ${theoremNo} (${title}, ${year}) ===\n` +
      `Let <math>x \\in \\{0, 1\\}^{${n}}</math> be encoded over <math>\\mathbb{F}_{${p}}</math> with modulus ${q}.\n` +
      `By ${author}'s theorem on ${relA}, the minimal lossless program length satisfies:\n` +
      `:<math>\\ell(x) \\ge \\sum_{i=1}^{${n}} -p_i \\log_2 p_i + \\frac{1}{${q}}</math>\n` +
      `Proof outline: Apply Jensen's inequality to the Kraft sum <math>\\sum 2^{-\\ell_i} \\le 1</math>. ` +
      `Every deterministic prefix decoder recovers byte stream S[0..${n - 1}] with zero distortion. QED.\n\n`;
    theoremNo += 1;
  }
  return Buffer.from(out, "utf8").subarray(0, targetBytes);
}

function generateMixedCorpus(targetBytes) {
  const rng = makeRng(0x4d495834);
  let out = "";
  let n = 1;
  while (Buffer.byteLength(out, "utf8") < targetBytes) {
    const [title, relA, author, year, relB] = pick(rng, TOPICS);
    const verb = pick(rng, VERBS);
    out +=
      `<!-- entry:${n} sha:${((rng() >>> 0).toString(16)).padStart(8, "0")} -->\n` +
      `[[${title}]] (${year}): [[${author}]] ${verb} [[${relA}]].\n` +
      `\`\`\`json\n` +
      `{"target":"${relB.toLowerCase().replace(/[^a-z0-9]+/g, "_")}","step":${n},"rank":${12 + (rng() % 80)},"ring":"Q"}\n` +
      `\`\`\`\n` +
      `* Ref: <ref name="r${n}">${author}, "On ${title}", Journal of Information (${year}), pp. ${n}-${n + 19}.</ref>\n\n`;
    n += 1;
  }
  return Buffer.from(out, "utf8").subarray(0, targetBytes);
}

const TARGETS = [
  {
    name: "enwik_articles_64k",
    title: "Wikipedia XML Articles (64 KiB)",
    summary: "Compress a deterministic 65,536-byte MediaWiki XML article dump losslessly using reversible bytecode transforms.",
    domain: "Lossless compression",
    bytes: 65536,
    sota_value: 14500,
    gen: generateArticlesCorpus,
  },
  {
    name: "enwik_infobox_32k",
    title: "Wikipedia Infobox & Tables (32 KiB)",
    summary: "Compress 32,768 bytes of structured MediaWiki infoboxes, parameters, and sortable tables losslessly.",
    domain: "Structured markup compression",
    bytes: 32768,
    sota_value: 5500,
    gen: generateInfoboxCorpus,
  },
  {
    name: "enwik_math_32k",
    title: "Encyclopedic Math & Proofs (32 KiB)",
    summary: "Compress 32,768 bytes of LaTeX math equations and proof prose losslessly with compact predictive transforms.",
    domain: "Symbolic text compression",
    bytes: 32768,
    sota_value: 7200,
    gen: generateMathCorpus,
  },
  {
    name: "enwik_mixed_64k",
    title: "Wikipedia Mixed Prose, JSON & Refs (64 KiB)",
    summary: "Compress 65,536 bytes of mixed encyclopedia prose, JSON blocks, XML comments, and citation tags losslessly.",
    domain: "Mixed entropy coding",
    bytes: 65536,
    sota_value: 16000,
    gen: generateMixedCorpus,
  },
];

export function generateAll() {
  mkdirSync(resolve(ROOT, "corpus"), { recursive: true });
  mkdirSync(resolve(ROOT, "targets"), { recursive: true });

  const manifestTargets = [];
  for (const spec of TARGETS) {
    const buf = spec.gen(spec.bytes);
    if (buf.length !== spec.bytes) {
      throw new Error(`${spec.name}: expected ${spec.bytes} bytes, got ${buf.length}`);
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const corpusRel = `corpus/${spec.name}.txt`;
    writeFileSync(resolve(ROOT, corpusRel), buf);

    const baselineDoc = {
      target: spec.name,
      format: "swarmcomp-v1",
      pipeline: [{ op: "raw" }],
      payload_b64: buf.toString("base64"),
    };
    const fileRel = `targets/${spec.name}.json`;
    writeFileSync(resolve(ROOT, fileRel), `${JSON.stringify(baselineDoc)}\n`);

    const baselineBytes = 4 + 1 + buf.length;
    manifestTargets.push({
      name: spec.name,
      title: spec.title,
      summary: spec.summary,
      file_path: fileRel,
      corpus_path: corpusRel,
      corpus_bytes: buf.length,
      corpus_sha256: sha256,
      kind: "bound",
      direction: "minimize",
      baseline_value: baselineBytes,
      sota_value: spec.sota_value,
      metric_unit: "bytes",
      domain: spec.domain,
      source_url: "http://prize.hutter1.net/",
      approach: "Use BWT, MTF, RLE0, LZ77, dict, or canonical Huffman in swarmcomp-v1 pipeline stages to minimize encoded_bytes.",
    });
  }

  const manifest = {
    problem: "hutter-swarm",
    format: "swarmcomp-v1",
    max_bytes: 262144,
    targets: manifestTargets,
  };
  writeFileSync(resolve(ROOT, "targets.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestTargets;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = generateAll();
  console.log(`Generated ${list.length} corpora and baseline targets.`);
}
