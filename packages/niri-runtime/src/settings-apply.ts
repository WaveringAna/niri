/**
 * Live settings apply. The control plane owns durable config; this is the
 * worker's side of a revision that can take effect without a replacement.
 *
 * A setting is only hot because someone verified it is read per use or has a
 * hook here. Everything else is applied by replacing the worker, so this module
 * stays small on purpose.
 *
 * @module settings-apply
 */

export type ReloadHook = (changed: ReadonlySet<string>) => void | Promise<void>

type Registration = { keys: readonly string[]; run: ReloadHook }

const registrations = new Set<Registration>()

/** Register a subsystem that must be told when one of its settings changed. */
export function onSettingsChanged(keys: readonly string[], run: ReloadHook): () => void {
  const registration: Registration = { keys, run }
  registrations.add(registration)
  return () => registrations.delete(registration)
}

/** Test seam: forget every hook. */
export function resetSettingsHooks(): void { registrations.clear() }

const write = (environment: NodeJS.ProcessEnv, key: string, value: string | null): boolean => {
  const before = environment[key]
  if (value === null) delete environment[key]
  else environment[key] = value
  return before !== (value ?? undefined)
}

/**
 * Apply a settings delta and run every hook that owns a changed key. A hook that
 * throws aborts the apply so the control plane hears about a half-applied
 * revision instead of assuming success.
 */
export async function applySettings(
  settings: Record<string, string | null>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const changed = new Set<string>()
  for (const [key, value] of Object.entries(settings)) if (write(environment, key, value)) changed.add(key)
  for (const registration of registrations) {
    if (!registration.keys.some((key) => changed.has(key))) continue
    await registration.run(changed)
  }
  return Object.keys(settings)
}
