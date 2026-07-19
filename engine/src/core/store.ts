import fs from "node:fs";
import YAML from "yaml";
import { configPath, ensureHome } from "./paths.js";
import {
  Binding,
  emptyConfig,
  HarborConfig,
  Instance,
  Profile,
  ServerDefinition,
} from "./types.js";
import { BUILTIN_DEFINITIONS } from "./registry.js";

/**
 * The single source of truth. Loads and persists `harbor.yaml`, and provides
 * typed CRUD over definitions, instances, profiles, and bindings. Built-in
 * server definitions are merged in on read so they're always available.
 */
export class ConfigStore {
  private config: HarborConfig;

  private constructor(config: HarborConfig) {
    this.config = config;
  }

  static load(): ConfigStore {
    const path = configPath();
    if (!fs.existsSync(path)) {
      return new ConfigStore(emptyConfig());
    }
    const raw = fs.readFileSync(path, "utf8");
    const parsed = YAML.parse(raw) ?? {};
    const config = HarborConfig.parse(parsed);
    return new ConfigStore(config);
  }

  save(): void {
    ensureHome();
    const doc = new YAML.Document(this.config);
    fs.writeFileSync(configPath(), String(doc), { mode: 0o600 });
  }

  get data(): HarborConfig {
    return this.config;
  }

  // ---- Definitions (built-ins + user-defined) ---------------------------

  get definitions(): ServerDefinition[] {
    const userIds = new Set(this.config.definitions.map((d) => d.id));
    const builtins = BUILTIN_DEFINITIONS.filter((d) => !userIds.has(d.id));
    return [...builtins, ...this.config.definitions];
  }

  getDefinition(id: string): ServerDefinition | undefined {
    return this.definitions.find((d) => d.id === id);
  }

  upsertDefinition(def: ServerDefinition): void {
    const validated = ServerDefinition.parse(def);
    const idx = this.config.definitions.findIndex((d) => d.id === validated.id);
    if (idx >= 0) this.config.definitions[idx] = validated;
    else this.config.definitions.push(validated);
  }

  removeDefinition(id: string): boolean {
    const before = this.config.definitions.length;
    this.config.definitions = this.config.definitions.filter((d) => d.id !== id);
    return this.config.definitions.length !== before;
  }

  // ---- Instances --------------------------------------------------------

  get instances(): Instance[] {
    return this.config.instances;
  }

  getInstance(id: string): Instance | undefined {
    return this.config.instances.find((i) => i.id === id);
  }

  upsertInstance(instance: Instance): void {
    const validated = Instance.parse(instance);
    const idx = this.config.instances.findIndex((i) => i.id === validated.id);
    if (idx >= 0) this.config.instances[idx] = validated;
    else this.config.instances.push(validated);
  }

  removeInstance(id: string): boolean {
    const before = this.config.instances.length;
    this.config.instances = this.config.instances.filter((i) => i.id !== id);
    // Drop the instance from any profiles referencing it.
    for (const profile of this.config.profiles) {
      profile.instances = profile.instances.filter((iid) => iid !== id);
    }
    return this.config.instances.length !== before;
  }

  // ---- Profiles ---------------------------------------------------------

  get profiles(): Profile[] {
    return this.config.profiles;
  }

  getProfile(id: string): Profile | undefined {
    return this.config.profiles.find((p) => p.id === id);
  }

  upsertProfile(profile: Profile): void {
    const validated = Profile.parse(profile);
    const idx = this.config.profiles.findIndex((p) => p.id === validated.id);
    if (idx >= 0) this.config.profiles[idx] = validated;
    else this.config.profiles.push(validated);
  }

  removeProfile(id: string): boolean {
    const before = this.config.profiles.length;
    this.config.profiles = this.config.profiles.filter((p) => p.id !== id);
    this.config.bindings = this.config.bindings.filter((b) => b.profile !== id);
    if (this.config.settings.defaultProfile === id) {
      this.config.settings.defaultProfile = undefined;
    }
    return this.config.profiles.length !== before;
  }

  /** Resolve a profile's instances, skipping disabled/missing ones. */
  profileInstances(profileId: string): Instance[] {
    const profile = this.getProfile(profileId);
    if (!profile) return [];
    return profile.instances
      .map((id) => this.getInstance(id))
      .filter((i): i is Instance => !!i && i.enabled);
  }

  // ---- Bindings ---------------------------------------------------------

  get bindings(): Binding[] {
    return this.config.bindings;
  }

  setBinding(binding: Binding): void {
    const validated = Binding.parse(binding);
    const idx = this.config.bindings.findIndex(
      (b) => b.scope === validated.scope && b.match === validated.match,
    );
    if (idx >= 0) this.config.bindings[idx] = validated;
    else this.config.bindings.push(validated);
  }

  removeBinding(scope: Binding["scope"], match?: string): boolean {
    const before = this.config.bindings.length;
    this.config.bindings = this.config.bindings.filter(
      (b) => !(b.scope === scope && b.match === match),
    );
    return this.config.bindings.length !== before;
  }

  // ---- Settings ---------------------------------------------------------

  get settings() {
    return this.config.settings;
  }
}
