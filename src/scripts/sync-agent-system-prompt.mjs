#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const sourcePath = path.resolve(repoRoot, "prompts/agent-system-prompt.yaml");
const apiTargetPath = path.resolve(
  repoRoot,
  "src/shared/agent-system-prompt.ts",
);
const sandboxTargetPath = path.resolve(
  repoRoot,
  "sandbox/src/shared/agent-system-prompt.ts",
);
const checkMode = process.argv.includes("--check");

function fail(message) {
  throw new Error(`[sync:prompt] ${message}`);
}

function assertRecord(value, atPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`Expected object at ${atPath}`);
  }
  return value;
}

function assertString(value, atPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`Expected non-empty string at ${atPath}`);
  }
  return value;
}

function assertStringArray(value, atPath) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`Expected non-empty string array at ${atPath}`);
  }
  return value.map((entry, index) =>
    assertString(entry, `${atPath}[${index}]`),
  );
}

function assertExactKeys(record, expectedKeys, atPath) {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(`missing: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`extra: ${extra.join(", ")}`);
    }
    fail(`Invalid keys at ${atPath} (${parts.join("; ")})`);
  }
}

function validatePromptTemplate(rawTemplate) {
  const root = assertRecord(rawTemplate, "root");
  assertExactKeys(
    root,
    [
      "base_default",
      "skills",
      "tools",
      "output_folder",
      "guidelines",
      "file_links",
    ],
    "root",
  );

  const skills = assertRecord(root.skills, "skills");
  assertExactKeys(
    skills,
    ["section_title", "intro", "installed_note", "inspect_note"],
    "skills",
  );

  const tools = assertRecord(root.tools, "tools");
  assertExactKeys(tools, ["section_title", "lines"], "tools");

  const outputFolder = assertRecord(root.output_folder, "output_folder");
  assertExactKeys(outputFolder, ["section_title", "lines"], "output_folder");

  const guidelines = assertRecord(root.guidelines, "guidelines");
  assertExactKeys(guidelines, ["section_title", "lines"], "guidelines");

  const fileLinks = assertRecord(root.file_links, "file_links");
  assertExactKeys(fileLinks, ["section_title", "lines"], "file_links");

  return {
    base_default: assertString(root.base_default, "base_default"),
    skills: {
      section_title: assertString(skills.section_title, "skills.section_title"),
      intro: assertString(skills.intro, "skills.intro"),
      installed_note: assertString(
        skills.installed_note,
        "skills.installed_note",
      ),
      inspect_note: assertString(skills.inspect_note, "skills.inspect_note"),
    },
    tools: {
      section_title: assertString(tools.section_title, "tools.section_title"),
      lines: assertStringArray(tools.lines, "tools.lines"),
    },
    output_folder: {
      section_title: assertString(
        outputFolder.section_title,
        "output_folder.section_title",
      ),
      lines: assertStringArray(outputFolder.lines, "output_folder.lines"),
    },
    guidelines: {
      section_title: assertString(
        guidelines.section_title,
        "guidelines.section_title",
      ),
      lines: assertStringArray(guidelines.lines, "guidelines.lines"),
    },
    file_links: {
      section_title: assertString(
        fileLinks.section_title,
        "file_links.section_title",
      ),
      lines: assertStringArray(fileLinks.lines, "file_links.lines"),
    },
  };
}

function buildGeneratedModule(template) {
  return `// AUTO-GENERATED FILE. Do not edit manually.
// Source: prompts/agent-system-prompt.yaml

interface PromptTemplate {
  base_default: string;
  skills: {
    section_title: string;
    intro: string;
    installed_note: string;
    inspect_note: string;
  };
  tools: {
    section_title: string;
    lines: string[];
  };
  output_folder: {
    section_title: string;
    lines: string[];
  };
  guidelines: {
    section_title: string;
    lines: string[];
  };
  file_links: {
    section_title: string;
    lines: string[];
  };
}

const TEMPLATE = ${JSON.stringify(template, null, 2)} as PromptTemplate;

export interface SystemPromptSkill {
  name: string;
  whenToUse: string;
  instructions: string;
  skillMarkdown?: string;
  installPath?: string | null;
}

function renderSectionLines(lines: string[]): string {
  return lines.join("\\n") + "\\n";
}

function renderOutputFolderLines(outputFolder: string): string {
  return TEMPLATE.output_folder.lines
    .map((line) => line.replace(/\\{\\{output_folder\\}\\}/g, outputFolder))
    .join("\\n");
}

export function buildSystemPrompt(
  basePrompt: string,
  skills: SystemPromptSkill[],
  outputFolder?: string,
): string {
  let prompt = basePrompt || TEMPLATE.base_default;

  if (skills.length > 0) {
    prompt += "\\n\\n" + TEMPLATE.skills.section_title + "\\n";
    prompt += TEMPLATE.skills.intro + "\\n\\n";
    for (const skill of skills) {
      prompt += \`### \${skill.name}\\n\`;
      if (skill.installPath) {
        prompt += \`**Skill folder:** \\\`\${skill.installPath}/\\\`\\n\`;
      }
      if (skill.skillMarkdown?.trim()) {
        prompt += \`**Injected SKILL.md:**\\n\\\`\\\`\\\`markdown\\n\${skill.skillMarkdown.trim()}\\n\\\`\\\`\\\`\\n\\n\`;
      } else {
        prompt += \`**When to use:** \${skill.whenToUse}\\n\`;
        prompt += \`**Instructions:**\\n\${skill.instructions}\\n\\n\`;
      }
    }
    prompt += TEMPLATE.skills.installed_note + "\\n";
    prompt += TEMPLATE.skills.inspect_note + "\\n";
  }

  prompt += "\\n" + TEMPLATE.tools.section_title + "\\n";
  prompt += renderSectionLines(TEMPLATE.tools.lines);

  if (outputFolder) {
    prompt += \`\\n\${TEMPLATE.output_folder.section_title}\\n\`;
    prompt += renderOutputFolderLines(outputFolder) + "\\n";
  }

  prompt += "\\n" + TEMPLATE.guidelines.section_title + "\\n";
  prompt += renderSectionLines(TEMPLATE.guidelines.lines);

  prompt += "\\n" + TEMPLATE.file_links.section_title + "\\n";
  prompt += renderSectionLines(TEMPLATE.file_links.lines);

  return prompt;
}
`;
}

function formatGenerated(content, filePath) {
  const biome = spawnSync(
    "pnpm",
    ["exec", "biome", "format", "--stdin-file-path", filePath],
    {
      cwd: repoRoot,
      input: content,
      encoding: "utf8",
    },
  );
  if ((biome.status ?? 1) !== 0) {
    fail(
      `Failed to format generated prompt module: ${biome.stderr || "unknown error"}`,
    );
  }
  return biome.stdout;
}

async function readMaybe(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function toRelativePath(filePath) {
  return path.relative(repoRoot, filePath) || filePath;
}

const source = await readFile(sourcePath, "utf8");
const parsed = YAML.parse(source);
const template = validatePromptTemplate(parsed);
const generated = buildGeneratedModule(template);

const targets = [apiTargetPath, sandboxTargetPath];
const staleTargets = [];
let wroteFiles = false;

for (const targetPath of targets) {
  const formatted = formatGenerated(generated, targetPath);
  const current = await readMaybe(targetPath);
  if (current === formatted) {
    continue;
  }

  if (checkMode) {
    staleTargets.push(toRelativePath(targetPath));
    continue;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, formatted, "utf8");
  wroteFiles = true;
}

if (checkMode) {
  if (staleTargets.length > 0) {
    console.error(
      "Prompt modules are out of date. Run `pnpm run sync:prompt`.",
    );
    for (const stalePath of staleTargets) {
      console.error(`- ${stalePath}`);
    }
    process.exit(1);
  }
  console.log("Prompt modules are up to date.");
} else if (wroteFiles) {
  console.log("Synced prompt modules from YAML.");
}
