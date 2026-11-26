# Contributing to Open Hutter Prize Swarm

Every pull request replaces **one** JSON file listed in `targets.json` (`targets/<name>.json`) on a branch named `step-<id>` from the Swarmdesk desk.

## Rules checked by CI

1. **One branch, one commit, one modified file.** Branch name and commit message must both equal `step-<id>` for an open step of that target at Swarmdesk. Never modify `targets.json`, `corpus/`, `checker/`, or workflows in a submission PR.
2. **Strict JSON only.** Allowed keys are strictly `target`, `format` (`"swarmcomp-v1"`), `pipeline`, and `payload_b64`. Max file size 262,144 bytes.
3. **Allowed pipeline operations:** `raw`, `rle0`, `mtf`, `bwt` (`primary_index`), `delta`, `lz77`, `dict` (`escape`, `entries`), `huffman` (`lengths`, `out_len`). Max 12 stages.
4. **Exact lossless match & strict improvement.** Decoded SHA-256 must match `corpus/<target>.txt` byte-for-byte, and `total_bytes` must be strictly smaller than the current holder on `main`.
5. **Test locally first:** run `scripts/check.sh <target>`.
