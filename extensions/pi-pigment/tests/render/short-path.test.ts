import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveToolPath, shortPath } from "#src/render/paths.ts";

const HOME = homedir();

describe("shortPath", () => {
  it("renders project-internal paths relative to cwd", () => {
    expect(shortPath("/proj", "/proj/src/app.ts")).toBe("src/app.ts");
    expect(shortPath("/proj", "/proj")).toBe("");
  });

  it("renders home-relative paths with a ~ prefix", () => {
    expect(shortPath("/proj", join(HOME, ".bashrc"))).toBe("~/.bashrc");
    expect(shortPath("/proj", join(HOME, "work/a.ts"))).toBe("~/work/a.ts");
  });

  it("keeps outside-of-home absolute paths untouched", () => {
    expect(shortPath("/proj", "/etc/hosts")).toBe("/etc/hosts");
    expect(shortPath("/proj", "/srv/data/x.log")).toBe("/srv/data/x.log");
  });

  it("does not match a home-looking prefix that is not the home", () => {
    // e.g. home is /home/alice and the path lives under /home/alicey — a plain
    // substring replace would corrupt this into ~y/other.
    const sibling = `${HOME}y/other`;
    expect(shortPath("/proj", sibling)).toBe(sibling);
  });

  it("passes empty paths through", () => {
    expect(shortPath("/proj", "")).toBe("");
  });
});

describe("inside-outside boundary (path segments, not prefixes)", () => {
  it("keeps a file literally named ..foo inside cwd relative", () => {
    // `..foo` is a filename, not a parent hop — the old prefix check
    // (`r.startsWith("..")`) misread it as outside and fell to absolute.
    expect(shortPath("/a/b", "/a/b/..foo")).toBe("..foo");
  });

  it("keeps sibling and parent paths absolute", () => {
    expect(shortPath("/a/b", "/a/c")).toBe("/a/c");
    expect(shortPath("/a/b", "/a")).toBe("/a");
  });
});

describe("resolveToolPath", () => {
  it("resolves relative args against the session cwd, never process.cwd()", () => {
    expect(resolveToolPath("/session", "src/a.ts")).toBe("/session/src/a.ts");
    // `@` strips first — `@/x.ts` is the absolute /x.ts, not cwd-relative.
    expect(resolveToolPath("/session", "@/x.ts")).toBe("/x.ts");
    expect(resolveToolPath("/session", "@rel/x.ts")).toBe("/session/rel/x.ts");
  });

  it("keeps absolute args and expands ~", () => {
    expect(resolveToolPath("/session", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolveToolPath("/session", "@/etc/hosts")).toBe("/etc/hosts");
    expect(resolveToolPath("/session", "~/.bashrc")).toBe(join(HOME, ".bashrc"));
  });

  it("passes empty args through as empty", () => {
    expect(resolveToolPath("/session", "")).toBe("");
  });
});
