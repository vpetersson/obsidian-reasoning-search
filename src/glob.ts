/**
 * Convert an exclusion glob to a RegExp over vault-relative paths.
 * `**` crosses folders, `*` and `?` don't. A pattern with no wildcards is a folder
 * (or file) prefix, so `Templates` excludes everything under `Templates/`.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.?\/+/, "");
  if (!/[*?]/.test(pattern)) pattern = `${pattern.replace(/\/+$/, "")}{,/**}`;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (pattern.startsWith("{,/**}", i)) {
      re += "(?:/.*)?";
      i += 5;
    } else if (pattern.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function compileExcludes(globs: string[]): (path: string) => boolean {
  const res = globs.map((g) => g.trim()).filter(Boolean).map(globToRegExp);
  return (path) => res.some((re) => re.test(path));
}
