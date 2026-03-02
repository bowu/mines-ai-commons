export interface PersistableSanitizeStats {
  stringsSanitized: number;
  nullBytesRemoved: number;
  invalidSurrogatesReplaced: number;
  circularRefsReplaced: number;
}

export interface PersistableSanitizeResult<T> {
  value: T;
  changed: boolean;
  stats: PersistableSanitizeStats;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function createStats(): PersistableSanitizeStats {
  return {
    stringsSanitized: 0,
    nullBytesRemoved: 0,
    invalidSurrogatesReplaced: 0,
    circularRefsReplaced: 0,
  };
}

export function hasSanitizationChanges(
  stats: PersistableSanitizeStats,
): boolean {
  return (
    stats.stringsSanitized > 0 ||
    stats.nullBytesRemoved > 0 ||
    stats.invalidSurrogatesReplaced > 0 ||
    stats.circularRefsReplaced > 0
  );
}

export function combineSanitizeStats(
  ...parts: PersistableSanitizeStats[]
): PersistableSanitizeStats {
  return parts.reduce(
    (acc, part) => ({
      stringsSanitized: acc.stringsSanitized + part.stringsSanitized,
      nullBytesRemoved: acc.nullBytesRemoved + part.nullBytesRemoved,
      invalidSurrogatesReplaced:
        acc.invalidSurrogatesReplaced + part.invalidSurrogatesReplaced,
      circularRefsReplaced:
        acc.circularRefsReplaced + part.circularRefsReplaced,
    }),
    createStats(),
  );
}

export function sanitizePersistableString(
  input: string,
): PersistableSanitizeResult<string> {
  const stats = createStats();
  let changed = false;
  const out: string[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);

    if (code === 0x0000) {
      changed = true;
      stats.nullBytesRemoved += 1;
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode =
        i + 1 < input.length ? input.charCodeAt(i + 1) : undefined;
      if (
        typeof nextCode === "number" &&
        nextCode >= 0xdc00 &&
        nextCode <= 0xdfff
      ) {
        out.push(input[i] as string);
        out.push(input[i + 1] as string);
        i += 1;
        continue;
      }

      changed = true;
      stats.invalidSurrogatesReplaced += 1;
      out.push("\uFFFD");
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      changed = true;
      stats.invalidSurrogatesReplaced += 1;
      out.push("\uFFFD");
      continue;
    }

    out.push(input[i] as string);
  }

  if (changed) {
    stats.stringsSanitized += 1;
  }

  return {
    value: changed ? out.join("") : input,
    changed,
    stats,
  };
}

export function sanitizePersistableValue<T>(
  input: T,
): PersistableSanitizeResult<T> {
  const stats = createStats();
  const inPath = new WeakSet<object>();

  const walk = (value: unknown): { value: unknown; changed: boolean } => {
    if (typeof value === "string") {
      const sanitized = sanitizePersistableString(value);
      stats.stringsSanitized += sanitized.stats.stringsSanitized;
      stats.nullBytesRemoved += sanitized.stats.nullBytesRemoved;
      stats.invalidSurrogatesReplaced +=
        sanitized.stats.invalidSurrogatesReplaced;
      return { value: sanitized.value, changed: sanitized.changed };
    }

    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry) => {
        const sanitized = walk(entry);
        changed = changed || sanitized.changed;
        return sanitized.value;
      });
      return changed
        ? { value: next, changed: true }
        : { value, changed: false };
    }

    if (!value || typeof value !== "object") {
      return { value, changed: false };
    }

    if (!isPlainObject(value)) {
      return { value, changed: false };
    }

    if (inPath.has(value)) {
      stats.circularRefsReplaced += 1;
      return { value: "[Circular]", changed: true };
    }

    inPath.add(value);
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const sanitized = walk(entry);
      changed = changed || sanitized.changed;
      next[key] = sanitized.value;
    }
    inPath.delete(value);

    return changed ? { value: next, changed: true } : { value, changed: false };
  };

  const sanitized = walk(input);
  return {
    value: sanitized.value as T,
    changed: sanitized.changed || hasSanitizationChanges(stats),
    stats,
  };
}
