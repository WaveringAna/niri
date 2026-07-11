let available = (process.env.NIRI_DISABLE_DISCORD_TOOLS ?? "").trim().toLowerCase() !== "true"

export function areDiscordToolsAvailable(): boolean {
  return available
}

export function setDiscordToolsAvailable(next: boolean): void {
  available = next && (process.env.NIRI_DISABLE_DISCORD_TOOLS ?? "").trim().toLowerCase() !== "true"
}
