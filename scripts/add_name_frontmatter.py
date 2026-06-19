#!/usr/bin/env python3
"""
Batch-add name: field to knowledge base .md files missing it.

Usage: python3 add_name_frontmatter.py [--dry-run]
"""

import os
import re
import sys
from pathlib import Path

KNOWLEDGE_BASE = Path(r"C:\Users\Lihan\.claude")
TARGET_DIRS = [
    "knowledge/primary",
    "knowledge/docs/templates",
]
EXCLUDE_PATTERNS = ["*/examples/*", "*/golden_model/*"]

def is_excluded(filepath: Path) -> bool:
    """Check if file matches any exclude pattern."""
    fp_str = filepath.as_posix()
    for pat in EXCLUDE_PATTERNS:
        if pat.startswith("*"):
            if pat[1:] in fp_str:
                return True
        elif pat in fp_str:
            return True
    return False

def slug_from_filename(filepath: Path) -> str:
    """Generate a name slug from the filename."""
    stem = filepath.stem  # filename without .md

    if stem.lower() == "readme":
        # Use parent directory name
        parent = filepath.parent.name
        slug = parent.lower().replace("_", "-").replace(" ", "-")
        # Clean multiple hyphens
        slug = re.sub(r"-+", "-", slug)
        return slug

    slug = stem.lower()
    slug = slug.replace("_", "-").replace(" ", "-")
    slug = re.sub(r"-+", "-", slug)
    slug = slug.strip("-")
    return slug

def has_name_field(content: str) -> bool:
    """Check if content already has a name: field in frontmatter."""
    # Match YAML frontmatter: starts with ---, then lines, then ---
    # Also check for name: at the very beginning of the file (no frontmatter markers)
    frontmatter_match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if frontmatter_match:
        fm = frontmatter_match.group(1)
        if re.search(r"^name:\s*\S", fm, re.MULTILINE):
            return True
    # Also check for name: right at the start without ---
    if re.match(r"^name:\s*\S", content, re.MULTILINE):
        return True
    return False

def has_title_field(content: str) -> bool:
    """Check if content already has a title: field in frontmatter."""
    frontmatter_match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if frontmatter_match:
        fm = frontmatter_match.group(1)
        if re.search(r"^title:\s*\S", fm, re.MULTILINE):
            return True
    return False

def add_name_to_frontmatter(content: str, slug: str) -> str:
    """Add name: field to the YAML frontmatter."""
    frontmatter_match = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)

    if frontmatter_match:
        # Has frontmatter - add name: after the first --- line
        fm_end = frontmatter_match.end()
        first_sep = content.index("---")
        first_sep_end = first_sep + 3  # after first ---\n

        # Insert name: after the first ---\n
        before_fm = content[:first_sep_end]
        after_fm = content[first_sep_end:]

        # Find where frontmatter content ends (before closing ---)
        close_fm_pos = after_fm.rfind("\n---")
        if close_fm_pos >= 0:
            fm_content = after_fm[:close_fm_pos]
            rest = after_fm[close_fm_pos:]

            # Insert name as first field in frontmatter
            new_fm_content = f"name: {slug}\n" + fm_content.lstrip("\n")
            new_content = before_fm + "\n" + new_fm_content + rest
            return new_content
        else:
            # Malformed frontmatter? Add after first ---
            new_content = before_fm + "\nname: " + slug + after_fm
            return new_content
    else:
        # No frontmatter - add one
        return f"---\nname: {slug}\n---\n\n{content}"

def process_file(filepath: Path, dry_run: bool = False) -> bool:
    """Process a single .md file. Returns True if modified."""
    content = filepath.read_text(encoding="utf-8")

    if has_name_field(content):
        return False  # Already has name:, skip

    slug = slug_from_filename(filepath)
    new_content = add_name_to_frontmatter(content, slug)

    if dry_run:
        print(f"  [DRY-RUN] Would modify: {filepath.relative_to(KNOWLEDGE_BASE)} (name: {slug})")
    else:
        filepath.write_text(new_content, encoding="utf-8")
        print(f"  MODIFIED: {filepath.relative_to(KNOWLEDGE_BASE)} -> name: {slug}")

    return True

def main():
    dry_run = "--dry-run" in sys.argv

    if not dry_run:
        print(f"{'='*60}")
        print("Adding name: field to .md files missing frontmatter name")
        print(f"{'='*60}")
    else:
        print(f"{'='*60}")
        print("DRY-RUN MODE - no files will be modified")
        print(f"{'='*60}")

    total_modified = 0
    total_scanned = 0

    for rel_dir in TARGET_DIRS:
        target_dir = KNOWLEDGE_BASE / rel_dir
        if not target_dir.exists():
            print(f"  SKIP (not found): {target_dir}")
            continue

        print(f"\n--- Scanning: {rel_dir} ---")

        for md_file in sorted(target_dir.rglob("*.md")):
            if is_excluded(md_file):
                continue

            total_scanned += 1
            try:
                if process_file(md_file, dry_run):
                    total_modified += 1
            except Exception as e:
                print(f"  ERROR: {md_file.relative_to(KNOWLEDGE_BASE)}: {e}")

    print(f"\n{'='*60}")
    print(f"Scanned: {total_scanned} files")
    print(f"Modified: {total_modified} files")
    if dry_run:
        print("NOTE: Dry-run mode, no actual changes made.")
    print(f"{'='*60}")

    # Final verification
    if not dry_run:
        print(f"\n{'='*60}")
        print("Verification: checking coverage...")
        print(f"{'='*60}")
        still_missing = 0
        for rel_dir in TARGET_DIRS:
            target_dir = KNOWLEDGE_BASE / rel_dir
            for md_file in sorted(target_dir.rglob("*.md")):
                if is_excluded(md_file):
                    continue
                content = md_file.read_text(encoding="utf-8")
                if not has_name_field(content):
                    print(f"  STILL MISSING: {md_file.relative_to(KNOWLEDGE_BASE)}")
                    still_missing += 1

        if still_missing == 0:
            print("  All files now have name: field. Coverage: 100%")
        else:
            print(f"  Files still missing name:: {still_missing}")

    return 0 if total_modified > 0 else 1

if __name__ == "__main__":
    sys.exit(main())
