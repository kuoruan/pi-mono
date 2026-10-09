#!/usr/bin/env python3
"""Reflow the prompt's prose blocks with flowmark, the semantic-line-break formatter.

The rules live inside TS template literals, and no formatter rewrites string
contents — oxfmt and Prettier both leave them verbatim, because rewriting a
string would change a runtime value. So this script does the shell work around
the tool: extract the literal, unwrap it, let flowmark wrap it, re-escape,
write back.

A literal is only touched when it is exactly `const NAME = `...`;` with no
interpolation. Anything else — an interpolated template, a closing backtick
not followed by `;`, a name declared twice, two targets whose spans overlap —
is refused rather than guessed at, because the file being rewritten holds the
prompt that gates whether an agent's command runs.

It refuses to write unless the result is provably the same text apart from
whitespace:

1. word tokens are identical, in order — catches any character change,
   including inside the JSON sample lines that are a parser contract;
2. logical units are identical, in order and in kind — headings, bullets, JSON
   lines, paragraphs — so a re-wrap that turns a one-line JSON sample into a
   two-line paragraph is a difference, not a coincidence of text.

Usage:
  python3 scripts/reflow-prompt.py                     # reflow every prose literal in place
  python3 scripts/reflow-prompt.py --check             # report only; exit 1 if a reflow would change it
  python3 scripts/reflow-prompt.py --literal SAFETY_RULES --width 100
  python3 scripts/reflow-prompt.py --flowmark flowmark # use a locally installed binary instead of uvx

Exit status: 0 wrote (or everything was already reflowed), 1 a check found a
reflow due, or a literal that must not be written, 2 the input could not be
used (unusable literal, bad flags, flowmark failure).

The pin is `flowmark==0.8.0`, the Python reference implementation; the
`flowmark-rs` package is a separate Rust port on its own version line. The pin
matters because the wrapping *is* the tool's output, so a version bump can
legitimately rewrap the block — as a reviewable diff, not a silent change.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from collections import Counter
from itertools import pairwise
from pathlib import Path

FLOWMARK_VERSION = "0.8.0"
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FILE = PACKAGE_ROOT / "src/review/engines/chat/prompt.ts"
DEFAULT_LITERALS = ("SAFETY_RULES", "VERDICT_SECTION")
JSON_LINE = re.compile(r"^\s*\{.*\}\s*$")


class LiteralError(Exception):
    """A literal this script will not touch."""


def literal_body(source: str, name: str) -> tuple[int, int]:
    """The half-open span of `const NAME = `...`;`'s body.

    Scanned rather than matched: the terminator is a backtick, which the body
    may contain escaped, so a regex over `...`;` can stop early or run into the
    next declaration.
    """
    anchors = list(re.finditer(rf"\bconst\s+{re.escape(name)}\s*=\s*", source))
    if not anchors:
        raise LiteralError(f"no `const {name} = ...` declaration")
    if len(anchors) > 1:
        raise LiteralError(f"`{name}` is declared {len(anchors)} times")
    open_tick = anchors[0].end()
    if source[open_tick : open_tick + 1] != "`":
        raise LiteralError(f"`{name}` is not a template literal")
    at = open_tick + 1
    while at < len(source):
        char = source[at]
        if char == "\\":
            at += 2
            continue
        if char == "`":
            after = at + 1
            while after < len(source) and source[after] in " \t\r\n":
                after += 1
            if source[after : after + 1] != ";":
                raise LiteralError(
                    f"`{name}`'s closing backtick is not followed by `;`"
                )
            return open_tick + 1, at
        if char == "$" and source[at + 1 : at + 2] == "{":
            raise LiteralError(
                f"`{name}` uses interpolation, which this script does not support"
            )
        at += 1
    raise LiteralError(f"`{name}` has no closing backtick")


def word_tokens(text: str) -> list[str]:
    return text.split()


def logical_units(text: str) -> list[str]:
    """Headings, bullets, JSON lines, paragraphs, and blank separators, in order.

    Each unit carries its kind (`@HEAD`, `@BULLET`, `@JSON`, `@PARA`) so a
    re-wrap that changes a unit's shape is visible even when its words are not.
    """
    units: list[str] = []
    current: str | None = None

    def flush() -> None:
        nonlocal current
        if current is not None:
            units.append(current)
            current = None

    for line in text.split("\n"):
        if not line.strip():
            flush()
            units.append("")
        elif line.startswith("#"):
            flush()
            units.append("@HEAD " + line.strip())
        elif re.match(r"^\s*- ", line):
            flush()
            current = "@BULLET " + line.strip()
        elif JSON_LINE.match(line):
            flush()
            current = "@JSON " + line.strip()
        else:
            current = (
                f"{current} {line.strip()}" if current else "@PARA " + line.strip()
            )
    flush()
    while units and units[-1] == "":
        units.pop()
    return units


def first_difference(before: list[str], after: list[str], label: str) -> str | None:
    """Where two token/unit lists diverge, or None when identical."""
    for i, (a, b) in enumerate(zip(before, after)):
        if a != b:
            return f"{label} diverge at #{i}:\n  before: {a[:160]}\n  after:  {b[:160]}"
    if len(before) != len(after):
        return f"{label} differ in count: {len(before)} → {len(after)}"
    return None


def unwrap_inline_code(text: str) -> str:
    """Join a code span an earlier wrap split — flowmark preserves spans verbatim, so it cannot."""
    if text.count("`") % 2:
        raise ValueError(
            f"odd number of backticks ({text.count('`')}) — cannot pair spans"
        )
    return re.sub(r"`[^`]*`", lambda span: " ".join(span.group(0).split()), text)


def run_flowmark(text: str, width: int, flowmark: str | None) -> str:
    command = (
        [flowmark]
        if flowmark
        else ["uvx", "--from", f"flowmark=={FLOWMARK_VERSION}", "flowmark"]
    )
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "prompt.md"
        source.write_text(text)
        result = subprocess.run(
            [*command, "--semantic", "--width", str(width), str(source)],
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise RuntimeError(
            f"flowmark failed ({result.returncode}): {result.stderr.strip() or result.stdout.strip()}\n"
            f"command: {' '.join(command)}"
        )
    if not result.stdout.strip():
        raise RuntimeError("flowmark returned no output")
    return result.stdout


def verify(before: str, after: str) -> list[str]:
    """The reasons the reflow must not be written; empty means it is safe."""
    return [
        problem
        for problem in (
            first_difference(word_tokens(before), word_tokens(after), "word tokens"),
            first_difference(
                logical_units(before), logical_units(after), "logical units"
            ),
        )
        if problem
    ]


class Target:
    def __init__(self, name: str, body: str, start: int, end: int) -> None:
        self.name = name
        self.body = body.replace("\\`", "`")
        self.newline = "\r\n" if "\r\n" in self.body else "\n"
        self.start = start
        self.end = end
        self.reflowed: str | None = None
        self.problems: list[str] = []

    def compute(self, width: int, flowmark: str | None) -> None:
        try:
            unwrapped = unwrap_inline_code(self.body)
        except ValueError as error:
            self.problems = [str(error)]
            return
        formatted = run_flowmark(unwrapped, width, flowmark).rstrip("\n")
        self.problems = verify(self.body, formatted)
        if not self.problems:
            self.reflowed = formatted

    def replacement(self) -> str:
        """The new body, escaped for the template string and using the file's own line ending."""
        escaped = self.reflowed.replace("`", "\\`")
        return escaped.replace("\n", "\r\n") if self.newline == "\r\n" else escaped


def resolve(source: str, names: list[str]) -> list[Target]:
    """Every named target's span, refusing duplicates and overlaps."""
    repeated = sorted(name for name, count in Counter(names).items() if count > 1)
    if repeated:
        raise LiteralError(f"repeated target: {', '.join(repeated)}")
    targets: list[Target] = []
    for name in names:
        start, end = literal_body(source, name)
        targets.append(Target(name, source[start:end], start, end))
    ordered = sorted(targets, key=lambda target: target.start)
    for earlier, later in pairwise(ordered):
        if earlier.end > later.start:
            raise LiteralError(f"`{earlier.name}` and `{later.name}` overlap")
    return targets


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--file", type=Path, default=DEFAULT_FILE, help="file holding the literals"
    )
    parser.add_argument(
        "--literal",
        action="append",
        default=None,
        help="const name to reflow (repeatable)",
    )
    parser.add_argument(
        "--width", type=int, default=88, help="flowmark line width (default 88)"
    )
    parser.add_argument(
        "--flowmark", default=None, help="path to a flowmark binary instead of uvx"
    )
    parser.add_argument("--check", action="store_true", help="report only; never write")
    args = parser.parse_args()

    with args.file.open("r", encoding="utf-8", newline="") as handle:
        source = handle.read()
    try:
        targets = resolve(source, args.literal or list(DEFAULT_LITERALS))
    except LiteralError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    for target in targets:
        try:
            target.compute(args.width, args.flowmark)
        except (RuntimeError, FileNotFoundError) as error:
            print(f"error: {target.name}: {error}", file=sys.stderr)
            return 2

    failed = False
    for target in targets:
        if target.problems:
            failed = True
            print(f"{target.name} would not be written:", file=sys.stderr)
            for problem in target.problems:
                print("  " + problem.replace("\n", "\n  "), file=sys.stderr)
            continue
        before_lines = len(target.body.split(target.newline))
        after_lines = len(target.reflowed.split("\n"))
        if args.check:
            already = target.reflowed == target.body
            print(
                f"{target.name}: {'already reflowed' if already else f'needs reflowing ({before_lines} → {after_lines} lines)'}"
            )
            failed = failed or not already
        else:
            print(
                f"{target.name}: {before_lines} → {after_lines} lines, width {args.width}"
            )

    if failed:
        return 1
    if args.check:
        return 0

    # Back-to-front, so an earlier edit cannot move a later one.
    for target in sorted(targets, key=lambda target: target.start, reverse=True):
        source = source[: target.start] + target.replacement() + source[target.end :]
    with args.file.open("w", encoding="utf-8", newline="") as handle:
        handle.write(source)
    print(f"wrote {args.file} — words and structure unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
