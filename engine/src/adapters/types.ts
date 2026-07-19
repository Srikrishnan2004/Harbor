/**
 * A client adapter knows one MCP client: where its config lives, how to read the
 * servers it declares (for scan/import), and how to install the single Harbor
 * gateway entry. Adapters are the surface most likely to break as clients
 * evolve, so they're deliberately small and isolated — see adapters/README.md.
 */

export interface DiscoveredServer {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** The client this was found in. */
  source: string;
}

export interface Adapter {
  /** Stable id used as `--client` value and binding match. */
  readonly id: string;
  readonly displayName: string;

  /** Absolute path to this client's user-level config file. */
  configPath(): string;

  /** True if this client appears to be installed / configured on the machine. */
  detect(): boolean;

  /** Parse the MCP servers declared in a given config file (default: user config). */
  readServers(file?: string): DiscoveredServer[];

  /** Whether the Harbor gateway entry is already installed. */
  isInstalled(): boolean;

  /** Add or update the Harbor gateway entry. Returns true if the file changed. */
  install(harborCommand?: string): boolean;

  /** Remove the Harbor gateway entry. Returns true if the file changed. */
  uninstall(): boolean;

  /** Filenames this client uses for per-project MCP config (for folder scans). */
  readonly projectConfigNames: string[];
}

export const HARBOR_ENTRY_NAME = "harbor";
