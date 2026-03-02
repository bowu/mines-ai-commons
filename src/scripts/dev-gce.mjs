import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

const devAuthProvider = (process.env.DEV_AUTH_PROVIDER || "").trim();
process.env.AUTH_PROVIDER = devAuthProvider || "none";
process.env.SANDBOX_MODE = "gce";

// Dev ergonomics: keep legacy sandbox images usable in pnpm dev:gce.
// Production remains proxy-only because the compat path is gated by NODE_ENV.
if (!(process.env.DEV_GCE_ALLOW_PROVIDER_KEYS || "").trim()) {
  process.env.DEV_GCE_ALLOW_PROVIDER_KEYS = "true";
}

// Dev ergonomics: ensure dev:gce picks up local sandbox runtime changes
// without requiring a new image build/promotion.
if (!(process.env.DEV_GCE_FORCE_RUNTIME_BUNDLE || "").trim()) {
  process.env.DEV_GCE_FORCE_RUNTIME_BUNDLE = "true";
}

function toPublicHttpsUrl(value, label) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  if (!/^https:\/\//i.test(trimmed)) {
    throw new Error(`${label} must be https://... (got ${trimmed})`);
  }
  if (/localhost|127\.0\.0\.1/i.test(trimmed)) {
    throw new Error(
      `${label} must be publicly reachable from GCE VMs (got ${trimmed})`,
    );
  }
  return trimmed;
}

function requireAny(keys, message) {
  for (const key of keys) {
    if ((process.env[key] || "").trim()) return;
  }
  throw new Error(message);
}

function normalizeProxyBaseUrl(value) {
  const base = value.replace(/\/+$/, "");
  if (base.endsWith("/v1")) return base;
  return `${base}/v1`;
}

function parseBoolean(value, fallback = false) {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function freePortIfOccupied(port) {
  const finder = spawnSync("lsof", ["-ti", `:${port}`], {
    encoding: "utf8",
  });
  if (finder.error || finder.status !== 0 || !finder.stdout?.trim()) return;
  const pids = finder.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pids.length === 0) return;
  spawnSync("kill", pids, { stdio: "ignore" });
}

function pipePrefixed(stream, prefix, onLine) {
  let buffer = "";
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.length === 0) continue;
      process.stdout.write(`[${prefix}] ${line}\n`);
      onLine?.(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      process.stdout.write(`[${prefix}] ${buffer}\n`);
      onLine?.(buffer);
      buffer = "";
    }
  });
}

function waitForTryCloudflareUrl(child, label, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const regex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`${label} quick tunnel did not report a URL in time`));
    }, timeoutMs);

    const resolveFromLine = (line) => {
      if (resolved) return;
      const match = line.match(regex);
      if (!match?.[0]) return;
      resolved = true;
      clearTimeout(timer);
      resolve(match[0].replace(/\/+$/, ""));
    };

    pipePrefixed(child.stdout, label, resolveFromLine);
    pipePrefixed(child.stderr, label, resolveFromLine);

    child.once("exit", (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      reject(
        new Error(
          `${label} exited before URL was discovered (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
    });
  });
}

async function startQuickTunnel(label, localUrl) {
  const child = spawn(
    "cloudflared",
    ["--config", "/dev/null", "tunnel", "--url", localUrl],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  const publicUrl = await waitForTryCloudflareUrl(child, label);
  return { child, publicUrl };
}

const useLocalProxy = parseBoolean(process.env.DEV_GCE_USE_LOCAL_PROXY, false);
const useQuickCallbackTunnel = parseBoolean(
  process.env.DEV_GCE_USE_QUICK_TUNNEL,
  !process.env.DEV_GCE_CALLBACK_PUBLIC_URL,
);
const useQuickProxyTunnel = parseBoolean(
  process.env.DEV_GCE_USE_QUICK_PROXY_TUNNEL,
  useLocalProxy && !process.env.DEV_GCE_PROXY_PUBLIC_URL,
);

// Keep local dev endpoints predictable (same behavior as pnpm dev predev hook).
freePortIfOccupied(3001);
freePortIfOccupied(5173);
if (useLocalProxy) {
  freePortIfOccupied(Number(process.env.LITELLM_PROXY_PORT || "4000"));
}

const managedChildren = [];
const appCommands = ["pnpm run dev:serve"];

let callbackPublicUrl = "";
if (useQuickCallbackTunnel) {
  const callbackTunnel = await startQuickTunnel(
    "callback-tunnel",
    "http://127.0.0.1:3001",
  );
  managedChildren.push(callbackTunnel.child);
  callbackPublicUrl = callbackTunnel.publicUrl;
} else {
  callbackPublicUrl = toPublicHttpsUrl(
    process.env.DEV_GCE_CALLBACK_PUBLIC_URL || process.env.API_CALLBACK_URL,
    "DEV_GCE_CALLBACK_PUBLIC_URL (or API_CALLBACK_URL)",
  );
  requireAny(
    ["CLOUDFLARED_TUNNEL_TOKEN", "CLOUDFLARED_CONFIG"],
    "Missing callback tunnel config: set CLOUDFLARED_TUNNEL_TOKEN or CLOUDFLARED_CONFIG",
  );
  appCommands.push("pnpm run dev:tunnel");
}

let proxyPublicUrl = "";
if (useLocalProxy) {
  appCommands.push("pnpm run dev:proxy");
  if (useQuickProxyTunnel) {
    const proxyPort = Number(process.env.LITELLM_PROXY_PORT || "4000");
    const proxyTunnel = await startQuickTunnel(
      "proxy-tunnel",
      `http://127.0.0.1:${proxyPort}`,
    );
    managedChildren.push(proxyTunnel.child);
    proxyPublicUrl = proxyTunnel.publicUrl;
  } else {
    proxyPublicUrl = toPublicHttpsUrl(
      process.env.DEV_GCE_PROXY_PUBLIC_URL || process.env.LITELLM_PROXY_URL,
      "DEV_GCE_PROXY_PUBLIC_URL (or LITELLM_PROXY_URL)",
    );
    requireAny(
      [
        "CLOUDFLARED_PROXY_TUNNEL_TOKEN",
        "CLOUDFLARED_PROXY_CONFIG",
        "CLOUDFLARED_TUNNEL_TOKEN",
        "CLOUDFLARED_CONFIG",
      ],
      "Missing proxy tunnel config: set CLOUDFLARED_PROXY_TUNNEL_TOKEN/CLOUDFLARED_PROXY_CONFIG (or fallback to CLOUDFLARED_TUNNEL_TOKEN/CLOUDFLARED_CONFIG)",
    );
    appCommands.push("pnpm run dev:proxy:tunnel");
  }
} else {
  proxyPublicUrl = toPublicHttpsUrl(
    process.env.DEV_GCE_PROXY_PUBLIC_URL || process.env.LITELLM_PROXY_URL,
    "DEV_GCE_PROXY_PUBLIC_URL (or LITELLM_PROXY_URL)",
  );
}

if (!(process.env.LITELLM_PROXY_API_KEY || "").trim()) {
  throw new Error("LITELLM_PROXY_API_KEY is required for pnpm dev:gce");
}

process.env.API_CALLBACK_URL = callbackPublicUrl;
process.env.LITELLM_PROXY_URL = normalizeProxyBaseUrl(proxyPublicUrl);

const sandboxBuild = spawnSync("pnpm", ["--filter", "sandbox", "build"], {
  stdio: "inherit",
  env: process.env,
});
if ((sandboxBuild.status ?? 1) !== 0) {
  throw new Error("Failed to build sandbox runtime bundle for dev:gce");
}

const names =
  appCommands.length === 1
    ? "app"
    : appCommands.map((_, idx) => `app${idx + 1}`).join(",");
const colors =
  appCommands.length === 1
    ? "blue"
    : ["blue", "cyan", "green", "yellow", "magenta"]
        .slice(0, appCommands.length)
        .join(",");

const child = spawn(
  "pnpm",
  [
    "exec",
    "concurrently",
    "-k",
    "--kill-signal",
    "SIGKILL",
    "-n",
    names,
    "-c",
    colors,
    ...appCommands,
  ],
  {
    stdio: "inherit",
    env: process.env,
  },
);

const stopManagedChildren = () => {
  for (const proc of managedChildren) {
    if (!proc.killed) {
      proc.kill("SIGTERM");
    }
  }
};

for (const proc of managedChildren) {
  proc.on("exit", (code, signal) => {
    // If a required tunnel dies, kill the app group to avoid silent hangs.
    if (!child.killed) {
      process.stderr.write(
        `Managed tunnel exited (code=${code ?? "null"} signal=${signal ?? "null"}); stopping dev:gce.\n`,
      );
      child.kill("SIGTERM");
    }
  });
}

child.on("exit", (code, signal) => {
  stopManagedChildren();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
