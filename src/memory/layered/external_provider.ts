import fs from "fs";
import type { UserHomePaths } from "../../home/index.js";
import type { MemoryProvider } from "./provider.js";
import { FileMemory } from "./file_memory.js";
import { RetrievalMemory } from "./retrieval_memory.js";
import { LocalFileExternalMemoryProvider, UnsupportedExternalMemoryProvider } from "./providers.js";

export type ExternalMemoryProviderKind = "local-file" | "honcho";

export interface ExternalMemoryProviderConfig {
  kind: ExternalMemoryProviderKind;
  options?: Record<string, unknown>;
}

export interface ExternalMemoryProviderFactoryOptions {
  homePaths: UserHomePaths;
  fileMemory: FileMemory;
  retrievalMemory: RetrievalMemory;
}

export function createExternalMemoryProvider(
  options: ExternalMemoryProviderFactoryOptions,
): MemoryProvider {
  const config = readExternalMemoryProviderConfig(options.homePaths);
  if (config.kind === "honcho") {
    return new UnsupportedExternalMemoryProvider("honcho", config.options);
  }

  return new LocalFileExternalMemoryProvider(options.fileMemory, options.retrievalMemory);
}

export function readExternalMemoryProviderConfig(homePaths: UserHomePaths): ExternalMemoryProviderConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(homePaths.thothAgentConfigPath, "utf-8")) as {
      memory?: {
        externalProvider?: {
          kind?: string;
          options?: Record<string, unknown>;
        };
      };
    };
    const kind = raw.memory?.externalProvider?.kind;
    if (kind === "honcho") {
      return {
        kind: "honcho",
        options: raw.memory?.externalProvider?.options || {},
      };
    }
  } catch {
    // ignore malformed or missing config and fall back to local-file
  }

  return {
    kind: "local-file",
    options: {},
  };
}
