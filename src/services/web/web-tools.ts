import { config } from "../../config.js";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_FETCH_MAX_CHARS = 20_000;
const DEFAULT_FETCH_MAX_BYTES = 2_000_000;

const BRAVE_API_KEY = config.braveApiKey;

const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

export interface WebSearchParams {
  query: string;
  count?: number;
  country?: string;
  searchLang?: string;
  uiLang?: string;
  freshness?: string;
}

export interface WebSearchItem {
  title: string;
  url: string;
  description: string;
  published?: string;
}

export interface WebSearchPayload {
  provider: "brave";
  query: string;
  count: number;
  results: WebSearchItem[];
  fetchedAt: string;
}

export interface WebFetchParams {
  url: string;
  maxChars?: number;
  timeoutMs?: number;
}

export interface WebFetchPayload {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  length: number;
  truncated: boolean;
  fetchedAt: string;
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseContentType(value: string | null): string {
  if (!value) return "application/octet-stream";
  const [raw] = value.split(";");
  return (raw || "").trim().toLowerCase() || "application/octet-stream";
}

function normalizeFreshness(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (
    BRAVE_FRESHNESS_SHORTCUTS.has(normalized) ||
    BRAVE_FRESHNESS_RANGE.test(normalized)
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeCountry(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return undefined;
  if (normalized === "ALL") return normalized;
  if (/^[A-Z]{2}$/.test(normalized)) return normalized;
  return undefined;
}

function normalizeLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/^[a-z]{2,3}(?:-[a-z0-9]+)?$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function stripTags(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]
    ? decodeHtmlEntities(titleMatch[1]).trim()
    : undefined;

  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const withBreaks = withoutScripts
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6|section|article)>/gi, "\n");

  const noTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(noTags);
  const compact = decoded
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  return { title, text: compact };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    });
}

function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

function withTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

export function isWebSearchConfigured(): boolean {
  return Boolean(BRAVE_API_KEY);
}

export async function performWebSearch(
  params: WebSearchParams,
): Promise<WebSearchPayload> {
  if (!BRAVE_API_KEY) {
    throw new Error("Web search is not configured. BRAVE_API_KEY is missing.");
  }

  const query = params.query.trim();
  if (!query) {
    throw new Error("Query is required.");
  }

  const count = clampInteger(
    params.count,
    DEFAULT_SEARCH_COUNT,
    1,
    MAX_SEARCH_COUNT,
  );
  const country = normalizeCountry(params.country);
  const searchLang = normalizeLanguage(params.searchLang);
  const uiLang = normalizeLanguage(params.uiLang);
  const freshness = normalizeFreshness(params.freshness);

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  if (country) url.searchParams.set("country", country);
  if (searchLang) url.searchParams.set("search_lang", searchLang);
  if (uiLang) url.searchParams.set("ui_lang", uiLang);
  if (freshness) url.searchParams.set("freshness", freshness);

  const { signal, cleanup } = withTimeoutSignal(15_000);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
      signal,
    });

    if (!res.ok) {
      throw new Error(
        `Brave Search API error: ${res.status} ${res.statusText}`,
      );
    }

    const body = (await res.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
    };

    const results = (body.web?.results || [])
      .map((item) => ({
        title: item.title || "",
        url: item.url || "",
        description: item.description || "",
        published: item.age || undefined,
      }))
      .filter((item) => item.url);

    return {
      provider: "brave",
      query,
      count: results.length,
      results,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    cleanup();
  }
}

export async function performWebFetch(
  params: WebFetchParams,
): Promise<WebFetchPayload> {
  const parsed = new URL(params.url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported.");
  }

  const maxChars = clampInteger(
    params.maxChars,
    DEFAULT_FETCH_MAX_CHARS,
    500,
    100_000,
  );
  const timeoutMs = clampInteger(
    params.timeoutMs,
    DEFAULT_FETCH_TIMEOUT_MS,
    1_000,
    120_000,
  );

  const { signal, cleanup } = withTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      method: "GET",
      headers: {
        Accept:
          "text/html,text/plain,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        "User-Agent": "MinesAICommons/1.0 (+https://mines.edu)",
      },
      redirect: "follow",
      signal,
    });

    if (!res.ok) {
      throw new Error(`Web fetch failed: ${res.status} ${res.statusText}`);
    }

    const contentLengthHeader = res.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (
        Number.isFinite(contentLength) &&
        contentLength > DEFAULT_FETCH_MAX_BYTES
      ) {
        throw new Error(`Response too large: ${contentLength} bytes`);
      }
    }

    const contentType = parseContentType(res.headers.get("content-type"));
    const rawBuffer = Buffer.from(await res.arrayBuffer());
    const limitedBuffer =
      rawBuffer.length > DEFAULT_FETCH_MAX_BYTES
        ? rawBuffer.subarray(0, DEFAULT_FETCH_MAX_BYTES)
        : rawBuffer;
    const sourceText = new TextDecoder("utf-8").decode(limitedBuffer);

    let title: string | undefined;
    let extractedText = sourceText;
    if (contentType.includes("text/html") || /^\s*</.test(sourceText)) {
      const html = stripTags(sourceText);
      title = html.title;
      extractedText = html.text;
    } else if (contentType.includes("application/json")) {
      try {
        extractedText = JSON.stringify(JSON.parse(sourceText), null, 2);
      } catch {
        extractedText = sourceText;
      }
    }

    const truncated = truncateText(extractedText, maxChars);
    return {
      url: parsed.toString(),
      finalUrl: res.url || parsed.toString(),
      status: res.status,
      contentType,
      title,
      text: truncated.text,
      length: truncated.text.length,
      truncated: truncated.truncated || rawBuffer.length > limitedBuffer.length,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    cleanup();
  }
}
