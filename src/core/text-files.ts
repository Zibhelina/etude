// Text files Notes keeps as files (opened in a plain editor, kept exactly as written) rather than pages:
// code, LaTeX, data and config. Shared by the core, the CLI and the web app, so nothing here needs Node.
/** The editor picks the language from the extension in the file's name. */
export const TEXT_FILE_EXTENSIONS = [
  "py", "pyi", "ipy", "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "json", "jsonc", "html", "htm", "css", "scss", "sass", "less", "vue", "svelte",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "java", "kt", "kts", "scala", "go", "rs", "swift", "m", "mm", "rb", "php", "pl", "lua", "r", "jl", "dart", "zig", "nim", "hs", "ml", "mli", "fs", "ex", "exs", "erl", "clj", "lisp", "el", "scm", "rkt", "v", "sv", "vhd", "vhdl", "asm", "s",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "proto",
  "tex", "sty", "cls", "bib", "ltx",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "svg", "csv", "tsv", "log", "diff", "patch", "dockerfile", "makefile", "cmake", "gradle", "nix", "tf", "txt", "text", "rst", "org", "adoc",
];
const TEXT_FILE_RE = new RegExp(`(?:\\.(?:${TEXT_FILE_EXTENSIONS.join("|")})|(?:^|/)(?:Makefile|Dockerfile|LICENSE|README))$`, "i");
/** True when a path (or name) is a text file Notes keeps as a file. Markdown is a page, not a file. */
export const isTextFile = (path: string) => TEXT_FILE_RE.test(path) && !/\.(md|markdown)$/i.test(path);
