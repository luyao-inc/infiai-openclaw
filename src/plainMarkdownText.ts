/** Chat prose only: never interpret HTML. Keep in sync with the PC compatibility copy. */
export function plainMarkdownText(raw: string): string {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  // Work on prose runs, not the entire message: a code example must not disable
  // cleanup in the surrounding answer. Protected runs retain their original formatting.
  const lines = text.split("\n");
  const output: string[] = [];
  let prose: string[] = [];
  let fence = "";
  let fenceLength = 0;
  const flush = () => {
    if (prose.length) output.push(cleanProse(prose.join("\n")));
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      output.push(line);
      if (
        mark &&
        mark[1][0] === fence &&
        mark[1].length >= fenceLength &&
        !mark[2].trim()
      )
        fence = "";
    } else if (mark) {
      flush();
      fence = mark[1][0];
      fenceLength = mark[1].length;
      output.push(line);
    } else if (
      /^(?: {4}|\t)/.test(line) ||
      (line.includes("|") &&
        (isTableRule(lines[i + 1] || "") ||
          isTableRule(line) ||
          (i > 0 && lines[i - 1].includes("|") && output.length > 0 && !prose.length)))
    ) {
      flush();
      output.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return output.join("\n");
}

function isTableRule(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function cleanProse(text: string): string {
  // Preserve inline code (including multiple-backtick delimiters) and escaped
  // punctuation. Placeholders are selected outside the input to avoid collisions.
  let prefix = "\u0000LX";
  while (text.includes(prefix)) prefix += "X";
  const literals: string[] = [];
  const protect = (value: string) => `${prefix}${literals.push(value) - 1}\u0000`;
  text = text.replace(/(`+)([\s\S]*?)\1(?!`)|\\[\\`*{}[\]()#+.!_>~-]/g, protect);
  text = text
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/gm, "")
    .replace(/^ {0,3}>[ \t]?/gm, "")
    .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
  // URLs are content even when they contain Markdown punctuation.
  text = text.replace(/https?:\/\/[^\s<>()`]+/g, (url) => {
    const closing = url.endsWith("**") ? "**" : "";
    return protect(closing ? url.slice(0, -2) : url) + closing;
  });
  // Paired emphasis may span lines. Require non-whitespace edges so arithmetic,
  // identifiers, globs and ordinary literal asterisks remain intact.
  // A bounded second pass handles nested emphasis after the inner marker is removed.
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    text = text
      .replace(/(?<![\\*])\*{3}([^*\s](?:[^*]*?[^*\s])?)\*{3}(?!\*)/g, "$1")
      .replace(/(?<![\\*])\*\*([^*\s](?:[^*]*?[^*\s])?)\*\*(?!\*)/g, "$1")
      .replace(/(?<![\w\\_])__([^_\s](?:[^_]*?[^_\s])?)__(?![\w_])/g, "$1")
      .replace(/(?<![\\*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![\w*])/g, "$1")
      .replace(/(?<![\w\\_])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\w_])/g, "$1")
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "$1");
    if (text === before) break;
  }
  text = text
    // Legacy split replies may have only an opening or closing strong marker.
    // Limit recovery to prose line edges; never delete arbitrary '*' characters.
    .replace(/^(\s*)\*\*(?=[\p{L}\p{N}“「『《])/gmu, "$1")
    .replace(/([\p{L}\p{N}。！？.!?，,；;：:”」』》])\*\*[ \t]*$/gmu, "$1")
    .replace(/^\s*\*\*[ \t]*$/gm, "");
  const token = new RegExp(`${prefix}(\\d+)\\u0000`, "g");
  return text.replace(token, (_, index: string) => literals[Number(index)]);
}
