export function getFileExt(filePath: string): string {
  return filePath.toLowerCase().split(".").pop() || "";
}

export function isPdf(filePath: string): boolean {
  return getFileExt(filePath) === "pdf";
}

export function isDocx(filePath: string): boolean {
  return getFileExt(filePath) === "docx";
}

export function isXlsx(filePath: string): boolean {
  return getFileExt(filePath) === "xlsx";
}

export function isPptx(filePath: string): boolean {
  return getFileExt(filePath) === "pptx";
}

export function isHtml(filePath: string): boolean {
  const ext = getFileExt(filePath);
  return ext === "html" || ext === "htm";
}

export const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
]);

export function isImage(filePath: string): boolean {
  return IMAGE_EXTS.has(getFileExt(filePath));
}

export function isRichDoc(filePath: string): boolean {
  return (
    isPdf(filePath) ||
    isDocx(filePath) ||
    isXlsx(filePath) ||
    isPptx(filePath) ||
    isHtml(filePath) ||
    isImage(filePath)
  );
}

export function isMd(filePath: string): boolean {
  return getFileExt(filePath) === "md";
}

const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "sh",
  "bash",
  "zsh",
  "sql",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "graphql",
  "r",
  "lua",
  "php",
]);

export function isCode(filePath: string): boolean {
  return CODE_EXTS.has(getFileExt(filePath));
}

const MONACO_LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  xml: "xml",
  graphql: "graphql",
  r: "r",
  lua: "lua",
  php: "php",
};

export function getMonacoLanguage(filePath: string): string {
  return MONACO_LANGUAGE_MAP[getFileExt(filePath)] || "plaintext";
}

export function getFileTypeBadge(filePath: string): string | null {
  const labels: Record<string, string> = {
    docx: "DOCX",
    xlsx: "XLSX",
    pptx: "PPTX",
    pdf: "PDF",
    html: "HTML",
    htm: "HTML",
    png: "PNG",
    jpg: "JPG",
    jpeg: "JPEG",
    gif: "GIF",
    svg: "SVG",
    webp: "WEBP",
  };
  return labels[getFileExt(filePath)] || null;
}

export function canonicalizeWorkspacePath(
  rawPath: string | null | undefined,
): string | null {
  if (!rawPath) return null;

  let decoded = String(rawPath);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep original when malformed percent-encoding is present.
  }

  let normalized = decoded
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/^['"`(\[]+|['"`)\],;:]+$/g, "")
    .trim();

  if (!normalized) return null;

  const sandboxWorkspaceMarker = "/sandbox-workspace/";
  const markerIndex = normalized.lastIndexOf(sandboxWorkspaceMarker);
  if (markerIndex >= 0) {
    normalized = normalized.slice(markerIndex + sandboxWorkspaceMarker.length);
  }

  if (normalized.startsWith("/workspace/")) {
    normalized = normalized.slice("/workspace/".length);
  }

  normalized = normalized.replace(/^\/+/, "").replace(/^\.\/+/, "");
  if (!normalized) return null;
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  return normalized;
}

export function getRawUrl(agentId: string, filePath: string): string {
  const relative = `/api/workspace/${agentId}/file?path=${encodeURIComponent(filePath)}&raw=true`;
  if (typeof window === "undefined") {
    return relative;
  }
  return new URL(relative, window.location.origin).toString();
}
