#!/usr/bin/env python3
"""Normalize frontmatter for all docs in knowledge/primary/.

Logic:
  1. Has tags already -> skip
  2. Has frontmatter but no tags -> add tags
  3. No frontmatter -> add full frontmatter (tags + summary + related)

Usage: /c/Python312/python.exe scripts/normalize_frontmatter.py [--dry-run]
"""

import os, re, sys
from pathlib import Path

BASE = Path(os.path.expanduser("~/.claude/knowledge/primary")).resolve()
EXCLUDE_DIRS = {"examples"}
EXCLUDE_FILES = {"README.md", "readme.md"}

# -- Tag inference rules --

DOMAIN_MAP = {"comm": "comm", "fpga": "fpga", "python": "python", "matlab": "matlab"}
ALGO_MAP = {"ofdm": "ofdm", "rrc": "rrc", "channel_est": "channel-est", "synch": "sync", "ldpc": "ldpc"}
STANDARD_MAP = {"5g-nr": "5g-nr", "lte": "lte"}

TYPE_PATTERNS = [
    (re.compile(r"algorithm_spec"), "spec"),
    (re.compile(r"fixed_point_report"), "fixed-point"),
    (re.compile(r"resource_estimate"), "resource"),
    (re.compile(r"rtl_architecture"), "rtl"),
    (re.compile(r"testbench_plan"), "testbench"),
    (re.compile(r"report_.*_fpga_implementation"), "impl"),
    (re.compile(r"encoding_spec"), "spec"),
    (re.compile(r"-guide"), "guide"),
    (re.compile(r"overview"), "overview"),
    (re.compile(r"coding.standard"), "coding-style"),
    (re.compile(r"coding.style"), "coding-style"),
    (re.compile(r"best.practices"), "best-practices"),
    (re.compile(r"design.experience"), "experience"),
    (re.compile(r"learning.path"), "learning"),
    (re.compile(r"knowledge.graph"), "knowledge-graph"),
    (re.compile(r"cross.project"), "cross-project"),
    (re.compile(r"golden_model"), "golden-model"),
    (re.compile(r"avoid.global.reset"), "pitfall"),
    (re.compile(r"mimo"), "mimo"),
    (re.compile(r"polar"), "polar"),
]

EXTRA_TAGS = {
    "mimo-detection": ["mimo", "detection", "precoding"],
    "polar-code": ["polar", "channel-coding"],
    "bfp-compression": ["bfp", "compression"],
    "dfe-architecture": ["dfe", "cfr", "dpd"],
    "lowphy-architecture": ["lowphy", "fft", "phase-comp"],
    "nr-ldpc": ["ldpc", "channel-coding", "qc-ldpc"],
    "nr-prach": ["prach", "random-access"],
    "nr-frame-structure": ["frame-structure", "numerology"],
    "fr2-beam-management": ["beam-management", "fr2", "tci", "bfr"],
    "nr-test-mode": ["test-mode", "evm"],
    "nru": ["unlicensed", "lbt"],
    "ntn": ["satellite", "ntn", "doppler"],
    "pdsch": ["data-channel", "dmrs", "harq"],
    "pusch": ["data-channel", "dft-s-ofdm", "uci"],
    "pdcch": ["control-channel", "coreset", "dci"],
    "oran-interface": ["oran", "ecpri", "c-plane", "u-plane"],
    "oran-ric": ["oran", "ric", "xapp", "e2"],
    "oran-smo": ["oran", "smo", "o1", "a1"],
    "pcie-guide": ["pcie", "high-speed-io", "dma", "axi"],
    "aurora-guide": ["aurora", "high-speed-io", "gty"],
    "jesd204b-guide": ["jesd204b", "high-speed-io", "adc", "dac"],
    "selectmap-guide": ["selectmap", "configuration", "bitstream", "boot"],
    "vivado-automation-guide": ["vivado", "tcl", "automation"],
    "timing-convergence-cases": ["timing", "convergence", "optimization"],
    "uvm-verification-guide": ["uvm", "verification"],
    "rfsoc-guide": ["rfsoc", "sdr", "analog", "zcu"],
    "riscv-fpga-guide": ["riscv", "embedded", "processor"],
    "golden_model_lessons": ["golden-model", "lessons"],
    "communication-algorithms": ["comm", "algorithm", "dsp"],
    "algorithm-implementation": ["algorithm", "implementation"],
    "ai-hardware-coding-spec": ["ai", "coding-spec"],
}


def infer_tags(file_path):
    rel = file_path.relative_to(BASE)
    parts = rel.parts
    tags = []

    for d, t in DOMAIN_MAP.items():
        if d in parts:
            tags.append(t)
            break

    for d, t in {**ALGO_MAP, **STANDARD_MAP}.items():
        if d in parts:
            tags.append(t)

    fname = rel.name
    for pat, tag in TYPE_PATTERNS:
        if pat.search(fname) and tag not in tags:
            tags.append(tag)

    stem = rel.stem
    if stem in EXTRA_TAGS:
        for t in EXTRA_TAGS[stem]:
            if t not in tags:
                tags.append(t)

    return tags


def extract_summary(content):
    body = content
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            body = content[end + 3:]

    lines = body.split("\n")
    title = ""
    for line in lines:
        s = line.strip()
        if s.startswith("# ") and not s.startswith("##"):
            title = s[2:].strip()
            break

    summary = ""
    for line in lines:
        s = line.strip()
        if not s or s.startswith("#") or s.startswith(">") or s.startswith("-") or s.startswith("`") or s.startswith("<"):
            continue
        if len(s) > 30:
            summary = s[:200]
            break

    if not summary and title:
        summary = f"About {title}"

    return title, summary


def find_related(file_path, all_md):
    rel = file_path.relative_to(BASE)
    parts = rel.parts
    related = []

    for i, p in enumerate(parts):
        if p in ALGO_MAP or p in STANDARD_MAP:
            for other in all_md:
                if other == file_path:
                    continue
                oparts = other.relative_to(BASE).parts
                if p in oparts:
                    r = "/".join(oparts[-2:]) if len(oparts) >= 2 else oparts[-1]
                    if r not in related:
                        related.append(r)
            break

    if not related:
        for d in DOMAIN_MAP:
            if d in parts:
                for other in all_md:
                    if other == file_path:
                        continue
                    oparts = other.relative_to(BASE).parts
                    if d in oparts and len(oparts) <= len(parts) + 1:
                        r = "/".join(oparts[-2:]) if len(oparts) >= 2 else oparts[-1]
                        if r not in related:
                            related.append(r)
                break

    return related[:6]


def format_frontmatter(tags, title, summary, related):
    lines = ["---"]
    if title:
        lines.append(f'title: "{title}"')
    tag_str = ", ".join(tags)
    lines.append(f"tags: [{tag_str}]")
    if summary:
        lines.append(f'description: "{summary}"')
    if related:
        rel_str = ", ".join(related)
        lines.append(f"related: [{rel_str}]")
    lines.append("---\n")
    return "\n".join(lines)


def normalize_file(file_path, all_md, dry_run=False):
    content = file_path.read_text(encoding="utf-8")
    has_frontmatter = content.startswith("---")

    if has_frontmatter:
        end_idx = content.find("---", 3)
        if end_idx == -1:
            print(f"  [WARN] malformed frontmatter: {file_path.name}")
            return False

        fm_raw = content[3:end_idx].strip()
        body = content[end_idx + 3:]

        if "tags:" in fm_raw:
            return False  # already has tags

        tags = infer_tags(file_path)
        tag_line = f"tags: [{', '.join(tags)}]"
        lines = fm_raw.split("\n")
        while lines and not lines[-1].strip():
            lines.pop()
        lines.append(tag_line)
        new_fm = "\n".join(lines)
        new_content = f"---\n{new_fm}\n---{body}"

        if not dry_run:
            file_path.write_text(new_content, encoding="utf-8")
        print(f"  [ADD TAGS] {file_path.name} -> [{', '.join(tags)}]")
        return True

    else:
        if not content.strip():
            print(f"  [SKIP] empty: {file_path.name}")
            return False

        title, summary = extract_summary(content)
        tags = infer_tags(file_path)
        related = find_related(file_path, all_md)
        frontmatter = format_frontmatter(tags, title, summary, related)
        new_content = frontmatter + content

        if not dry_run:
            file_path.write_text(new_content, encoding="utf-8")
        print(f"  [ADD FM] {file_path.name} -> [{', '.join(tags)}]")
        return True


def main():
    dry_run = "--dry-run" in sys.argv
    all_md = sorted(BASE.rglob("*.md"))
    all_md = [f for f in all_md if not any(p in f.parts for p in EXCLUDE_DIRS)]
    all_md = [f for f in all_md if f.name not in EXCLUDE_FILES]

    print(f"Scanning {len(all_md)} files in {BASE}")
    if dry_run:
        print("[DRY RUN] no files will be modified\n")

    changed = 0
    for f in all_md:
        try:
            if normalize_file(f, all_md, dry_run):
                changed += 1
        except Exception as e:
            print(f"  [ERROR] {f.name}: {e}")

    status = "DRY" if dry_run else "DONE"
    print(f"\n[{status}] {changed} files {'would be' if dry_run else ''} modified.")


if __name__ == "__main__":
    main()
