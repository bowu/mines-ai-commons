import {
  DisksClient,
  ImagesClient,
  InstancesClient,
  ZoneOperationsClient,
} from "@google-cloud/compute";
import { config } from "../../config.js";
import { isGpuMachineType } from "./machine-types.js";

export interface GceVmResult {
  vmName: string;
  vmIp: string;
  vmZone: string;
  dataDiskName: string;
}

const clientOptions = config.gcpServiceAccountKey
  ? { credentials: config.gcpServiceAccountKey }
  : {};
const disksClient = new DisksClient(clientOptions);
const imagesClient = new ImagesClient(clientOptions);
const instancesClient = new InstancesClient(clientOptions);
const zoneOperationsClient = new ZoneOperationsClient(clientOptions);
const IMAGE_RESOLVER_CACHE_TTL_MS = 60_000;
const MIN_GCE_OPERATION_WAIT_TIMEOUT_MS = 10 * 60_000;

interface ImageResolverCacheEntry {
  selfLink: string;
  expiresAtMs: number;
}

const resolvedImageCache = new Map<string, ImageResolverCacheEntry>();

function assertGceEnabled() {
  if (config.sandboxMode !== "gce") return;
  if (!config.gcpProjectId || !config.gcpZone) {
    throw new Error("GCE mode requires GCP_PROJECT_ID and GCP_ZONE");
  }
  if (!config.vmServiceAccountEmail) {
    throw new Error("GCE mode requires VM_SERVICE_ACCOUNT_EMAIL");
  }
}

function compactAgentId(agentId: string): string {
  const compact = agentId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact || "agent";
}

function buildResourceName(prefix: string, agentId: string): string {
  const compact = compactAgentId(agentId);
  const raw = `${prefix}-${compact}`;
  return raw.slice(0, 63).replace(/-+$/, "");
}

function vmNameForAgent(agentId: string): string {
  return buildResourceName("agent", agentId);
}

function diskNameForAgent(agentId: string): string {
  return buildResourceName("workspace", agentId);
}

function zoneToRegion(zone: string): string {
  const parts = zone.split("-");
  if (parts.length < 3) return zone;
  return parts.slice(0, -1).join("-");
}

function isNotFoundError(error: unknown): boolean {
  const candidate = error as any;
  const code = Number(candidate?.code || candidate?.statusCode || 0);
  const message = String(candidate?.message || "");
  return code === 404 || code === 5 || message.includes("was not found");
}

function extractResourceLeaf(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const segments = trimmed.split("/");
  return segments[segments.length - 1] || "";
}

function shouldStopInsteadOfSuspend(instance: any): boolean {
  const machineType = extractResourceLeaf(instance?.machineType);
  if (machineType && isGpuMachineType(machineType)) {
    return true;
  }

  const accelerators = Array.isArray(instance?.guestAccelerators)
    ? instance.guestAccelerators
    : [];
  for (const accelerator of accelerators) {
    const countRaw = Number(accelerator?.acceleratorCount ?? 0);
    if (Number.isFinite(countRaw) && countRaw > 0) {
      return true;
    }
  }

  return false;
}

function operationErrors(operation: any): string[] {
  const errors = operation?.error?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry: any) => String(entry?.message || entry?.code || "").trim())
    .filter(Boolean);
}

function requireOperationName(operation: any): string {
  const name = operation?.name;
  if (typeof name !== "string" || !name) {
    throw new Error("Missing GCE operation name");
  }
  return name;
}

async function withGceTimeout<T>(
  action: string,
  fn: () => Promise<T>,
  timeoutMs = config.sandboxGceOperationTimeoutMs,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`GCE ${action} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForZoneOperation(
  operationName: string,
  action: string,
): Promise<void> {
  assertGceEnabled();
  const project = config.gcpProjectId;
  const zone = config.gcpZone;

  const waitTimeoutMs = Math.max(
    config.sandboxGceOperationTimeoutMs,
    MIN_GCE_OPERATION_WAIT_TIMEOUT_MS,
  );
  const deadlineMs = Date.now() + waitTimeoutMs;
  while (Date.now() < deadlineMs) {
    const remainingMs = Math.max(1, deadlineMs - Date.now());
    const [operation] = await withGceTimeout(
      `wait operation (${action})`,
      () =>
        zoneOperationsClient.wait({
          operation: operationName,
          project,
          zone,
        }),
      remainingMs,
    );
    if (operation?.status === "DONE") {
      const errors = operationErrors(operation);
      if (errors.length > 0) {
        throw new Error(`GCE ${action} failed: ${errors.join("; ")}`);
      }
      return;
    }
  }

  throw new Error(`GCE ${action} timed out after ${waitTimeoutMs}ms`);
}

async function getInstanceByName(vmName: string): Promise<any | null> {
  assertGceEnabled();
  try {
    const [instance] = await withGceTimeout(`get instance (${vmName})`, () =>
      instancesClient.get({
        project: config.gcpProjectId,
        zone: config.gcpZone,
        instance: vmName,
      }),
    );
    return instance;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function getInstance(agentId: string): Promise<any | null> {
  assertGceEnabled();
  if (config.sandboxMode === "local") return null;
  return getInstanceByName(vmNameForAgent(agentId));
}

export async function listInstances(filter?: string): Promise<any[]> {
  assertGceEnabled();
  if (config.sandboxMode === "local") return [];

  const request: Record<string, string> = {
    project: config.gcpProjectId,
    zone: config.gcpZone,
  };
  if (filter) {
    request.filter = filter;
  }

  const [instances] = await withGceTimeout("list instances", () =>
    instancesClient.list(request),
  );
  return Array.isArray(instances) ? instances : [];
}

async function getDisk(diskName: string): Promise<any | null> {
  assertGceEnabled();
  try {
    const [disk] = await withGceTimeout(`get disk (${diskName})`, () =>
      disksClient.get({
        project: config.gcpProjectId,
        zone: config.gcpZone,
        disk: diskName,
      }),
    );
    return disk;
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function getVmIp(instance: any): string {
  const externalIp =
    instance?.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
  if (typeof externalIp === "string" && externalIp) return externalIp;
  if (config.gceUseExternalIp) return "";
  const internalIp = instance?.networkInterfaces?.[0]?.networkIP;
  if (typeof internalIp === "string" && internalIp) return internalIp;
  return "";
}

function buildSubnetworkPath(subnetwork: string): string {
  if (subnetwork.startsWith("regions/") || subnetwork.startsWith("projects/")) {
    return subnetwork;
  }
  return `regions/${zoneToRegion(config.gcpZone)}/subnetworks/${subnetwork}`;
}

function sanitizeStartupValue(value: string | undefined): string {
  return (value || "").replace(/\r?\n/g, "").trim();
}

function buildStartupScript(agentId: string): string {
  const callbackUrl = config.apiCallbackUrl.replace(/\/+$/, "");
  const runtimeEnv: Record<string, string> = {
    AGENT_ID: sanitizeStartupValue(agentId),
    API_CALLBACK_URL: sanitizeStartupValue(callbackUrl),
    VM_BOOTSTRAP_SECRET: sanitizeStartupValue(config.vmBootstrapSecret),
    SANDBOX_PORT: "8888",
    SANDBOX_WORKSPACE_DIR: "/workspace",
    SANDBOX_RUNTIME_VERSION_FILE: "/opt/mines-ai/sandbox/runtime-version",
    HOME: "/workspace",
    PATH: "/workspace/.venv/bin:/workspace/.npm-global/bin:/workspace/.py-user/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    NPM_CONFIG_PREFIX: "/workspace/.npm-global",
    PYTHONUSERBASE: "/workspace/.py-user",
    XDG_CACHE_HOME: "/workspace/.cache",
    PIP_CACHE_DIR: "/workspace/.cache/pip",
  };

  if (config.litellmProxyUrl) {
    runtimeEnv.LITELLM_PROXY_URL = sanitizeStartupValue(config.litellmProxyUrl);
  }
  if (config.litellmModelGemini) {
    runtimeEnv.LITELLM_MODEL_GEMINI = sanitizeStartupValue(
      config.litellmModelGemini,
    );
  }
  if (config.litellmModelSonnet) {
    runtimeEnv.LITELLM_MODEL_SONNET = sanitizeStartupValue(
      config.litellmModelSonnet,
    );
  }
  if (config.litellmModelOpus) {
    runtimeEnv.LITELLM_MODEL_OPUS = sanitizeStartupValue(
      config.litellmModelOpus,
    );
  }
  if (config.litellmModelGpt) {
    runtimeEnv.LITELLM_MODEL_GPT = sanitizeStartupValue(config.litellmModelGpt);
  }
  if (config.litellmProxyApiKey) {
    runtimeEnv.LITELLM_PROXY_API_KEY = sanitizeStartupValue(
      config.litellmProxyApiKey,
    );
    runtimeEnv.OPENAI_API_KEY = sanitizeStartupValue(config.litellmProxyApiKey);
  }

  const allowProviderKeyCompat =
    config.nodeEnv !== "production" &&
    config.sandboxMode === "gce" &&
    config.devGceAllowProviderKeys;

  // Temporary GCE dev fallback for legacy runtime bundles.
  // Disabled by default to keep VM env proxy-only.
  if (allowProviderKeyCompat) {
    if (config.geminiApiKey) {
      runtimeEnv.GEMINI_API_KEY = sanitizeStartupValue(config.geminiApiKey);
    }
    if (config.braveApiKey) {
      runtimeEnv.BRAVE_API_KEY = sanitizeStartupValue(config.braveApiKey);
    }
    if (config.awsAccessKeyId) {
      runtimeEnv.AWS_ACCESS_KEY_ID = sanitizeStartupValue(
        config.awsAccessKeyId,
      );
    }
    if (config.awsSecretAccessKey) {
      runtimeEnv.AWS_SECRET_ACCESS_KEY = sanitizeStartupValue(
        config.awsSecretAccessKey,
      );
    }
    if (config.awsSessionToken) {
      runtimeEnv.AWS_SESSION_TOKEN = sanitizeStartupValue(
        config.awsSessionToken,
      );
    }
    if (config.awsRegion) {
      runtimeEnv.AWS_REGION = sanitizeStartupValue(config.awsRegion);
    }
  }

  const runtimeEnvLines = Object.entries(runtimeEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  return `#!/bin/bash
set -euo pipefail

AGENT_ID=${sanitizeStartupValue(agentId)}
API_CALLBACK_URL=${sanitizeStartupValue(callbackUrl)}
RUNTIME_ARCHIVE=/opt/mines-ai/sandbox-runtime.tar.gz
RUNTIME_DIR=/opt/mines-ai/sandbox
RUNTIME_VERSION_EXPECTED=${sanitizeStartupValue(config.sandboxExpectedRuntimeVersion)}
FORCE_RUNTIME_BUNDLE=${config.devGceForceRuntimeBundle ? "true" : "false"}
WORKSPACE_DEVICE=/dev/disk/by-id/google-workspace
mkdir -p /workspace

for attempt in $(seq 1 30); do
  if [ -b "\${WORKSPACE_DEVICE}" ]; then
    break
  fi
  sleep 1
done

if [ ! -b "\${WORKSPACE_DEVICE}" ]; then
  echo "Workspace data disk not found at \${WORKSPACE_DEVICE}" >&2
  exit 1
fi

if ! blkid "\${WORKSPACE_DEVICE}" >/dev/null 2>&1; then
  mkfs.ext4 -F "\${WORKSPACE_DEVICE}"
  mkdir -p /mnt/mines-workspace-seed
  mount "\${WORKSPACE_DEVICE}" /mnt/mines-workspace-seed
  if [ -n "$(ls -A /workspace 2>/dev/null || true)" ]; then
    cp -a /workspace/. /mnt/mines-workspace-seed/ || true
  fi
  sync
  umount /mnt/mines-workspace-seed
  rmdir /mnt/mines-workspace-seed
fi

WORKSPACE_UUID="$(blkid -s UUID -o value "\${WORKSPACE_DEVICE}" || true)"
if [ -n "\${WORKSPACE_UUID}" ] && ! grep -q "UUID=\${WORKSPACE_UUID} /workspace " /etc/fstab; then
  echo "UUID=\${WORKSPACE_UUID} /workspace ext4 defaults,discard,nofail 0 2" >> /etc/fstab
fi

if ! mountpoint -q /workspace; then
  mount /workspace || mount "\${WORKSPACE_DEVICE}" /workspace
fi

mkdir -p /opt/mines-ai /workspace/.npm-global /workspace/.py-user /workspace/.cache/pip /workspace/.mines

cat >/etc/default/mines-ai-sandbox <<'EOF'
${runtimeEnvLines}
EOF

install_service() {
  cat >/etc/systemd/system/mines-ai-sandbox.service <<'UNIT'
[Unit]
Description=Mines AI Sandbox Runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/default/mines-ai-sandbox
WorkingDirectory=/opt/mines-ai/sandbox
ExecStart=/usr/local/bin/node dist/sandbox-server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable mines-ai-sandbox.service
}

legacy_bootstrap_runtime() {
  local NODE_VERSION=v22.19.0

  if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v22\.'; then
    curl -fsSL "https://nodejs.org/dist/\${NODE_VERSION}/node-\${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node-runtime.tar.xz
    mkdir -p /opt/node-runtime
    tar -xJf /tmp/node-runtime.tar.xz --strip-components=1 -C /opt/node-runtime
    ln -sf /opt/node-runtime/bin/node /usr/local/bin/node
    ln -sf /opt/node-runtime/bin/npm /usr/local/bin/npm
  fi

  local attempt token
  for attempt in $(seq 1 60); do
    token=$(
      curl -fsS -H "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=\${API_CALLBACK_URL}&format=full" \
      || true
    )
    if [ -n "\${token}" ] && curl -fsS -H "Authorization: Bearer \${token}" "\${API_CALLBACK_URL}/api/internal/agents/\${AGENT_ID}/runtime-bundle" -o "\${RUNTIME_ARCHIVE}"; then
      mkdir -p "\${RUNTIME_DIR}"
      tar -xzf "\${RUNTIME_ARCHIVE}" -C "\${RUNTIME_DIR}"
      cd "\${RUNTIME_DIR}"
      npm install --omit=dev --no-audit --no-fund
      return 0
    fi
    echo "Runtime bundle bootstrap attempt \${attempt}/60 failed; retrying..." >&2
    sleep 5
  done

  return 1
}

need_runtime_bundle=false
if [ "\${FORCE_RUNTIME_BUNDLE}" = "true" ]; then
  need_runtime_bundle=true
fi

if [ ! -f "\${RUNTIME_DIR}/dist/sandbox-server.js" ]; then
  echo "Pre-baked sandbox runtime missing; runtime-bundle bootstrap required" >&2
  need_runtime_bundle=true
fi

if [ -n "\${RUNTIME_VERSION_EXPECTED}" ]; then
  current_runtime_version=""
  if [ -f "\${RUNTIME_DIR}/runtime-version" ]; then
    current_runtime_version="$(tr -d '\r\n' < "\${RUNTIME_DIR}/runtime-version")"
  fi
  if [ "\${current_runtime_version}" != "\${RUNTIME_VERSION_EXPECTED}" ]; then
    echo "Runtime version mismatch (have='\${current_runtime_version}' expected='\${RUNTIME_VERSION_EXPECTED}'); runtime-bundle bootstrap required" >&2
    need_runtime_bundle=true
  fi
fi

if [ "\${need_runtime_bundle}" = "true" ]; then
  if ! legacy_bootstrap_runtime; then
    echo "Failed to bootstrap sandbox runtime bundle" >&2
    exit 1
  fi
  if [ -n "\${RUNTIME_VERSION_EXPECTED}" ]; then
    printf '%s\n' "\${RUNTIME_VERSION_EXPECTED}" > "\${RUNTIME_DIR}/runtime-version"
  fi
fi

install_service
systemctl restart mines-ai-sandbox.service || systemctl start mines-ai-sandbox.service

if systemctl list-unit-files | grep -q '^sandbox-server.service'; then
  systemctl disable --now sandbox-server.service || true
fi
`;
}

function buildImageFamilyReference(): string {
  return `projects/${config.gceImageProject}/global/images/family/${config.gceImageFamily}`;
}

function sanitizeImageLabelValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "");
}

async function resolveSandboxImageReference(): Promise<string> {
  const expectedVersion = config.sandboxExpectedRuntimeVersion;
  if (!expectedVersion) {
    return buildImageFamilyReference();
  }

  const cached = resolvedImageCache.get(expectedVersion);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.selfLink;
  }

  const runtimeLabel = sanitizeImageLabelValue(expectedVersion);
  if (!runtimeLabel) {
    throw new Error(
      "SANDBOX_EXPECTED_RUNTIME_VERSION contains unsupported characters",
    );
  }

  const [images] = await withGceTimeout(
    `list promoted images (${runtimeLabel})`,
    () =>
      imagesClient.list({
        project: config.gceImageProject,
        filter: `labels.runtime_version=${runtimeLabel} AND labels.state=promoted`,
      }),
  );

  const candidates = (Array.isArray(images) ? images : [])
    .map((image) => {
      const createdAtMs = Date.parse(String(image?.creationTimestamp || ""));
      return {
        selfLink: String(image?.selfLink || ""),
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
      };
    })
    .filter((candidate) => candidate.selfLink);

  if (candidates.length === 0) {
    throw new Error(
      `No promoted image found for runtime version ${expectedVersion}`,
    );
  }

  const selected = candidates.sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
  if (!selected) {
    throw new Error(
      `No promoted image found for runtime version ${expectedVersion}`,
    );
  }

  // Promotion updates can take up to this TTL to propagate through the resolver cache.
  resolvedImageCache.set(expectedVersion, {
    selfLink: selected.selfLink,
    expiresAtMs: Date.now() + IMAGE_RESOLVER_CACHE_TTL_MS,
  });
  return selected.selfLink;
}

function buildDiskTypePath(): string {
  return `zones/${config.gcpZone}/diskTypes/pd-balanced`;
}

function buildMachineTypePath(machineType: string): string {
  if (machineType.startsWith("zones/") || machineType.startsWith("projects/")) {
    return machineType;
  }
  return `zones/${config.gcpZone}/machineTypes/${machineType}`;
}

function buildAcceleratorTypePath(acceleratorType: string): string {
  if (
    acceleratorType.startsWith("zones/") ||
    acceleratorType.startsWith("projects/")
  ) {
    return acceleratorType;
  }
  return `zones/${config.gcpZone}/acceleratorTypes/${acceleratorType}`;
}

function buildDataDiskPath(diskName: string): string {
  return `projects/${config.gcpProjectId}/zones/${config.gcpZone}/disks/${diskName}`;
}

async function instanceToVmResult(
  instance: any,
  agentId: string,
): Promise<GceVmResult> {
  const vmName = instance?.name || vmNameForAgent(agentId);
  const vmIp = getVmIp(instance);
  if (!vmIp) {
    throw new Error(`Instance ${vmName} has no reachable IP`);
  }
  return {
    vmName,
    vmIp,
    vmZone: config.gcpZone,
    dataDiskName: diskNameForAgent(agentId),
  };
}

export async function createDataDisk(
  agentId: string,
  sizeGb = config.gceDataDiskSizeGb,
): Promise<{ dataDiskName: string }> {
  assertGceEnabled();
  if (config.sandboxMode === "local") {
    return { dataDiskName: "local-disk" };
  }

  const diskName = diskNameForAgent(agentId);
  const existing = await getDisk(diskName);
  if (existing) {
    return { dataDiskName: diskName };
  }

  const [operation] = await withGceTimeout(`insert disk (${diskName})`, () =>
    disksClient.insert({
      project: config.gcpProjectId,
      zone: config.gcpZone,
      diskResource: {
        name: diskName,
        sizeGb: String(sizeGb),
        type: buildDiskTypePath(),
        labels: {
          managed_by: "mines_ai",
          agent_id: compactAgentId(agentId).slice(0, 63),
        },
      },
    }),
  );

  await waitForZoneOperation(
    requireOperationName(operation),
    `disk create (${diskName})`,
  );
  return { dataDiskName: diskName };
}

export async function createVM(
  agentId: string,
  machineType: string,
  options?: { sourceImage?: string | null; acceleratorType?: string | null },
): Promise<GceVmResult> {
  assertGceEnabled();
  if (config.sandboxMode === "local") {
    return {
      vmName: `local-${agentId}`,
      vmIp: "127.0.0.1",
      vmZone: "local",
      dataDiskName: `workspace-${agentId}`,
    };
  }

  const vmName = vmNameForAgent(agentId);
  const diskName = diskNameForAgent(agentId);
  const existing = await getInstanceByName(vmName);
  if (existing) {
    return instanceToVmResult(existing, agentId);
  }

  await createDataDisk(agentId, config.gceDataDiskSizeGb);

  const selectedMachineType = machineType || config.gceMachineType;
  const selectedAcceleratorType = options?.acceleratorType?.trim() || null;
  const requiresGpuScheduling =
    Boolean(selectedAcceleratorType) || isGpuMachineType(selectedMachineType);
  const startupScript = buildStartupScript(agentId);
  const sourceImage =
    options?.sourceImage || (await resolveSandboxImageReference());

  const networkInterface: any = {
    network: `global/networks/${config.gceNetwork}`,
  };
  if (config.gceSubnetwork) {
    networkInterface.subnetwork = buildSubnetworkPath(config.gceSubnetwork);
  }
  if (config.gceUseExternalIp) {
    networkInterface.accessConfigs = [{ name: "External NAT" }];
  }

  const instanceResource: any = {
    name: vmName,
    machineType: buildMachineTypePath(selectedMachineType),
    labels: {
      managed_by: "mines_ai",
      agent_id: compactAgentId(agentId).slice(0, 63),
    },
    networkInterfaces: [networkInterface],
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage,
          diskSizeGb: String(config.gceBootDiskSizeGb),
          diskType: buildDiskTypePath(),
        },
      },
      {
        boot: false,
        autoDelete: false,
        source: buildDataDiskPath(diskName),
        deviceName: "workspace",
        mode: "READ_WRITE",
      },
    ],
    metadata: {
      items: [
        { key: "agent-id", value: agentId },
        { key: "api-callback-url", value: config.apiCallbackUrl },
        { key: "vm-bootstrap-secret", value: config.vmBootstrapSecret },
        { key: "startup-script", value: startupScript },
      ],
    },
    serviceAccounts: [
      {
        email: config.vmServiceAccountEmail,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    ],
  };

  if (selectedAcceleratorType) {
    instanceResource.guestAccelerators = [
      {
        acceleratorType: buildAcceleratorTypePath(selectedAcceleratorType),
        acceleratorCount: 1,
      },
    ];
  }

  // Only GPU profiles require explicit scheduling overrides.
  // Non-GPU machine families such as e2 reject onHostMaintenance=TERMINATE
  // unless preemptible, so leave default scheduling for those VMs.
  if (requiresGpuScheduling) {
    instanceResource.scheduling = {
      onHostMaintenance: "TERMINATE",
      automaticRestart: false,
      provisioningModel: "STANDARD",
    };
  }

  const [operation] = await withGceTimeout(`insert instance (${vmName})`, () =>
    instancesClient.insert({
      project: config.gcpProjectId,
      zone: config.gcpZone,
      instanceResource,
    }),
  );
  await waitForZoneOperation(
    requireOperationName(operation),
    `instance create (${vmName})`,
  );

  const created = await getInstanceByName(vmName);
  if (!created) {
    throw new Error(`Instance ${vmName} was not found after creation`);
  }

  return instanceToVmResult(created, agentId);
}

export async function startVM(agentId: string): Promise<GceVmResult> {
  assertGceEnabled();
  if (config.sandboxMode === "local") {
    return {
      vmName: "local-vm",
      vmIp: "127.0.0.1",
      vmZone: "local",
      dataDiskName: "local-disk",
    };
  }

  const vmName = vmNameForAgent(agentId);
  const instance = await getInstanceByName(vmName);
  if (!instance) {
    throw new Error(`Instance ${vmName} was not found`);
  }

  const status = String(instance.status || "");
  if (status === "RUNNING") {
    return instanceToVmResult(instance, agentId);
  }

  if (status === "SUSPENDED") {
    const [operation] = await withGceTimeout(
      `resume instance (${vmName})`,
      () =>
        instancesClient.resume({
          project: config.gcpProjectId,
          zone: config.gcpZone,
          instance: vmName,
        }),
    );
    await waitForZoneOperation(
      requireOperationName(operation),
      `instance resume (${vmName})`,
    );
    const resumed = await getInstanceByName(vmName);
    if (!resumed) {
      throw new Error(`Instance ${vmName} was not found after resume`);
    }
    return instanceToVmResult(resumed, agentId);
  }

  if (status === "PROVISIONING" || status === "STAGING") {
    const inFlight = await getInstanceByName(vmName);
    if (!inFlight) {
      throw new Error(`Instance ${vmName} was not found during startup`);
    }
    return instanceToVmResult(inFlight, agentId);
  }

  const [operation] = await withGceTimeout(`start instance (${vmName})`, () =>
    instancesClient.start({
      project: config.gcpProjectId,
      zone: config.gcpZone,
      instance: vmName,
    }),
  );
  await waitForZoneOperation(
    requireOperationName(operation),
    `instance start (${vmName})`,
  );

  const started = await getInstanceByName(vmName);
  if (!started) {
    throw new Error(`Instance ${vmName} was not found after start`);
  }
  return instanceToVmResult(started, agentId);
}

export async function suspendVM(agentId: string): Promise<void> {
  assertGceEnabled();
  if (config.sandboxMode === "local") return;

  const vmName = vmNameForAgent(agentId);
  const instance = await getInstanceByName(vmName);
  if (!instance) return;

  const status = String(instance.status || "");
  if (
    status === "TERMINATED" ||
    status === "STOPPED" ||
    status === "STOPPING" ||
    status === "SUSPENDED" ||
    status === "SUSPENDING"
  ) {
    return;
  }

  if (shouldStopInsteadOfSuspend(instance)) {
    const [operation] = await withGceTimeout(`stop instance (${vmName})`, () =>
      instancesClient.stop({
        project: config.gcpProjectId,
        zone: config.gcpZone,
        instance: vmName,
      }),
    );
    await waitForZoneOperation(
      requireOperationName(operation),
      `instance stop (${vmName})`,
    );
    return;
  }

  const [operation] = await withGceTimeout(`suspend instance (${vmName})`, () =>
    instancesClient.suspend({
      project: config.gcpProjectId,
      zone: config.gcpZone,
      instance: vmName,
    }),
  );
  await waitForZoneOperation(
    requireOperationName(operation),
    `instance suspend (${vmName})`,
  );
}

export async function deleteVM(agentId: string): Promise<void> {
  assertGceEnabled();
  if (config.sandboxMode === "local") return;

  const vmName = vmNameForAgent(agentId);
  const existing = await getInstanceByName(vmName);
  if (!existing) return;

  try {
    const [operation] = await withGceTimeout(
      `delete instance (${vmName})`,
      () =>
        instancesClient.delete({
          project: config.gcpProjectId,
          zone: config.gcpZone,
          instance: vmName,
        }),
    );
    await waitForZoneOperation(
      requireOperationName(operation),
      `instance delete (${vmName})`,
    );
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

export async function deleteDataDisk(agentId: string): Promise<void> {
  assertGceEnabled();
  if (config.sandboxMode === "local") return;

  const diskName = diskNameForAgent(agentId);
  const existing = await getDisk(diskName);
  if (!existing) return;

  try {
    const [operation] = await withGceTimeout(`delete disk (${diskName})`, () =>
      disksClient.delete({
        project: config.gcpProjectId,
        zone: config.gcpZone,
        disk: diskName,
      }),
    );
    await waitForZoneOperation(
      requireOperationName(operation),
      `disk delete (${diskName})`,
    );
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

export const _testOnly = {
  buildStartupScript,
  shouldStopInsteadOfSuspend,
};
