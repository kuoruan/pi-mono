import { describe, expect, it } from "vitest";

import { astInjectRegions, fallbackHeredocRegions } from "#src/render/heredoc-inject.ts";
import { hlBlock } from "#src/theme/highlight.ts";
import { resolveDiffPalette } from "#src/theme/palette.ts";
import { buildFakeTheme, plain, resetPigmentForTest } from "#test/fixtures.ts";

describe("astInjectRegions", () => {
  it("finds interpreter heredocs with byte-precise offsets", () => {
    const cmd = "cd /x && python3 << 'PYEOF'\nimport sys\nprint('hi')\nPYEOF";
    const regions = astInjectRegions(cmd);
    expect(regions).not.toBeNull();
    expect(regions).toHaveLength(1);
    expect(regions![0]!.language).toBe("python");
    expect(cmd.slice(regions![0]!.start, regions![0]!.end)).toBe("import sys\nprint('hi')\n");
  });

  it("maps interpreter heads: node, ruby, jq, path-prefixed python", () => {
    expect(astInjectRegions("node << 'EOF'\nconsole.log(1)\nEOF")![0]!.language).toBe("javascript");
    expect(astInjectRegions("ruby << 'EOF'\nputs 1\nEOF")![0]!.language).toBe("ruby");
    expect(astInjectRegions("jq << 'EOF'\n{a: 1}\nEOF")![0]!.language).toBe("json");
    expect(astInjectRegions("/usr/bin/python3 -u << 'EOF'\nx = 1\nEOF")![0]!.language).toBe(
      "python",
    );
  });

  it("injects heredoc file-writes by the target's extension (cat/tee)", () => {
    const cat = astInjectRegions("cat > app.py << 'EOF'\nx = 1\nEOF");
    expect(cat![0]!.language).toBe("python");
    const tee = astInjectRegions("sudo tee /etc/hosts.ts << 'EOF'\nexport const x = 1;\nEOF");
    expect(tee![0]!.language).toBe("typescript");
    // Bare cat (data, no target): no injection.
    expect(astInjectRegions("cat << 'EOF'\njust text\nEOF")).toHaveLength(0);
    // Unknown extension: no injection.
    expect(astInjectRegions("cat > data.unknownext << 'EOF'\nx\nEOF")).toHaveLength(0);
  });

  it("injects inline code arguments (python -c / node -e), quoted region only", () => {
    const cmd = "python3 -c 'print(42)'";
    const regions = astInjectRegions(cmd)!;
    expect(regions).toHaveLength(1);
    expect(regions[0]!.language).toBe("python");
    // The region is the code INSIDE the quotes.
    expect(cmd.slice(regions[0]!.start, regions[0]!.end)).toBe("print(42)");

    expect(astInjectRegions("node -e 'console.log(1)'")![0]!.language).toBe("javascript");
    expect(astInjectRegions('node --eval "let x = 1"')![0]!.language).toBe("javascript");
    // Multi-line inline code.
    const multi = astInjectRegions("python3 -c '\nimport sys\nprint(sys.argv)\n'")!;
    expect(multi[0]!.language).toBe("python");
    expect(multi).toHaveLength(1);
    // Non-flag arguments don't inject.
    expect(astInjectRegions("echo 'print(42)'")).toHaveLength(0);
    // Double-quoted with command substitution inside: still injected (the
    // AST gives the region; substitution coloring degrades within it).
    expect(astInjectRegions('python3 -c "print(42)"')![0]!.language).toBe("python");
  });

  it("handles multiple regions in one command", () => {
    const cmd = "python3 << 'EOF'\na = 1\nEOF\nnode << 'JS'\nlet x;\nJS\npython3 -c 'print(2)'";
    const regions = astInjectRegions(cmd)!;
    expect(regions.map((r) => r.language)).toEqual(["python", "javascript", "python"]);
  });

  it("returns null on parse failures (caller falls back to the scanner)", () => {
    expect(astInjectRegions("a ||| b")).toBeNull();
  });

  it("heredocs inside control-flow bodies parse since @aliou/sh 0.3.1 (the compound-redirects fix)", () => {
    // 0.3.0 ate the closing keyword (a parse throw → regex fallback);
    // 0.3.1 attaches compound redirects to the AST — the cat-heredoc
    // resolves to regions (empty: cat carries data, no injection) and an
    // interpreter heredoc inside if injects its body.
    expect(astInjectRegions("if true; then\ncat << 'EOF'\nx\nEOF\nfi")).toEqual([]);
    const regions = astInjectRegions("if true; then\npython3 << 'EOF'\nprint(1)\nEOF\nfi");
    expect(regions).toEqual([
      { start: expect.any(Number), end: expect.any(Number), language: "python" },
    ]);
  });

  it("injects assignment-prefixed heredocs (FOO=1 python3 << EOF)", () => {
    // The parser separates assigns from words — the old manual tokenizer
    // saw the assignment as the program name and silently skipped these.
    expect(astInjectRegions("FOO=1 python3 << 'EOF'\nx = 1\nEOF")![0]!.language).toBe("python");
    expect(astInjectRegions("PYTHONPATH=/x python3 -u << 'EOF'\nx\nEOF")![0]!.language).toBe(
      "python",
    );
  });

  it("injects env-wrapped heredocs (env VAR=x python3 << EOF)", () => {
    expect(astInjectRegions("env PYTHONPATH=/x python3 << 'EOF'\nx\nEOF")![0]!.language).toBe(
      "python",
    );
  });

  it('resolves quoted write targets whole (cat > "my app.py" << EOF)', () => {
    // The redirect's target word carries the full path including the
    // space; the old whitespace tokenizer resolved `\"my` and matched no
    // extension.
    const cat = astInjectRegions("cat > \"my app.py\" << 'EOF'\nx = 1\nEOF");
    expect(cat![0]!.language).toBe("python");
    const sgl = astInjectRegions("cat > 'src/my file.ts' << 'EOF'\nconst x = 1;\nEOF");
    expect(sgl![0]!.language).toBe("typescript");
  });

  it("keeps merged heredoc commands' languages distinct through line windows", () => {
    // The parser merges consecutive heredoc commands into one node; the
    // per-redirect line window recovers each command's own words.
    const cmd = "python3 << 'EOF'\na = 1\nEOF\nnode << 'JS'\nlet x;\nJS";
    const regions = astInjectRegions(cmd)!;
    expect(regions.map((r) => r.language)).toEqual(["python", "javascript"]);
  });

  it("resolves tee targets past append flags (tee -a out.py << EOF)", () => {
    expect(astInjectRegions("tee -a out.py << 'EOF'\nx = 1\nEOF")![0]!.language).toBe("python");
    expect(astInjectRegions("sudo tee --append log.py << 'EOF'\nx\nEOF")![0]!.language).toBe(
      "python",
    );
  });

  it("maps R and Rscript heredocs to r (the lowercase lookup the whitelist keys on)", () => {
    expect(astInjectRegions("R --no-save << 'EOF'\nx <- 1\nEOF")![0]!.language).toBe("r");
    expect(astInjectRegions("Rscript << 'EOF'\nx <- 1\nEOF")![0]!.language).toBe("r");
  });

  it("injects inline code args behind transparent prefixes (sudo/env/assigns)", () => {
    // The prefix-transparency rule is shared with heredoc resolution —
    // `sudo python3 -c` injects exactly like `python3 -c`.
    const sudo = astInjectRegions("sudo python3 -c 'print(1)'")!;
    expect(sudo).toHaveLength(1);
    expect(sudo[0]!.language).toBe("python");
    const env = astInjectRegions("env PYTHONPATH=/x python3 -c 'print(1)'")!;
    expect(env[0]!.language).toBe("python");
    const node = astInjectRegions("sudo node -e 'console.log(1)'")!;
    expect(node[0]!.language).toBe("javascript");
  });

  it("no regions for plain commands", () => {
    expect(astInjectRegions("pnpm vitest run | head -3")).toHaveLength(0);
    expect(astInjectRegions("echo hi")).toHaveLength(0);
  });
});

describe("fallbackHeredocRegions (the regex scanner)", () => {
  it("emits the same region shape as the AST path when it is unavailable", () => {
    const command = "cd /x && python3 << 'PYEOF'\nimport sys\nprint('hi')\nPYEOF\necho done";
    const regions = fallbackHeredocRegions(command);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.language).toBe("python");
    // Offsets slice out exactly the body (like the AST path).
    expect(command.slice(regions[0]!.start, regions[0]!.end)).toBe("import sys\nprint('hi')\n");
  });

  it("keeps data heredocs and unterminated bodies region-free (pure shell)", () => {
    expect(fallbackHeredocRegions("cat << 'EOF'\njust text\nEOF")).toHaveLength(0);
    expect(fallbackHeredocRegions("python3 << 'EOF'\na = 1")).toHaveLength(0);
  });
});

describe("injection rendering (discriminating colors, end-to-end)", () => {
  it("colors a python heredoc body with python token colors, not the shell string blob", async () => {
    resetPigmentForTest();
    const theme = buildFakeTheme({ syntaxColors: true });
    const palette = resolveDiffPalette(theme);
    const command = "python3 << 'PYEOF'\nimport sys\nprint('hello')\nPYEOF";

    const regions = astInjectRegions(command)!;
    const parts: string[] = [];
    let cursor = 0;
    for (const region of regions) {
      const gap = command.slice(cursor, region.start);
      if (gap)
        parts.push(
          ...(await hlBlock({
            code: gap,
            language: "shellscript",
            palette,
            piTheme: theme,
          })),
        );
      parts.push(
        ...(await hlBlock({
          code: command.slice(region.start, region.end),
          language: "python",
          palette,
          piTheme: theme,
        })),
      );
      cursor = region.end;
    }
    parts.push(
      ...(await hlBlock({
        code: command.slice(cursor),
        language: "shellscript",
        palette,
        piTheme: theme,
      })),
    );
    const rendered = parts.join("\n");

    const bodyLine = rendered.split("\n")[1] ?? "";
    // The discriminator: under the shell grammar the WHOLE body line is
    // the heredoc string blob (one color); under python the keyword gets
    // its own color — "import" must not be one big string.
    expect(bodyLine).not.toContain("38;2;224;185;169mimport");
    // eslint-disable-next-line no-control-regex -- intentionally matches ESC
    expect(bodyLine).toMatch(/\x1b\[38;2;\d+;\d+;\d+mimport\x1b\[39m/);
    // print carries the function color, impossible under the string blob.
    expect(rendered.split("\n")[2] ?? "").toContain("38;2;220;220;170mprint");
    // Reassembly is byte-faithful.
    expect(plain(rendered)).toBe(command);
  });

  it("colors a cat file-write heredoc by the target's extension", async () => {
    resetPigmentForTest();
    const theme = buildFakeTheme({ syntaxColors: true });
    const palette = resolveDiffPalette(theme);
    const command = "cat > app.py << 'EOF'\nimport os\nEOF";

    const regions = astInjectRegions(command)!;
    expect(regions[0]!.language).toBe("python");
    const body = await hlBlock({
      code: command.slice(regions[0]!.start, regions[0]!.end),
      language: "python",
      palette,
      piTheme: theme,
    });
    // "import" is python-colored, not the shell string blob.
    expect(body[0] ?? "").not.toContain("38;2;224;185;169mimport");
    // eslint-disable-next-line no-control-regex -- intentionally matches ESC
    expect(body[0] ?? "").toMatch(/\x1b\[38;2;\d+;\d+;\d+mimport\x1b\[39m/);
  });
});
