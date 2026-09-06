/** The post-creation cheat sheet: how to edit the saved config and how to wake the agent. */
export const creationHints = (id: string, hasModel: boolean): string => [
  "",
  hasModel ? `agent ${id} is saved and stopped.` : `agent ${id} is saved and stopped \u2014 no model set yet.`,
  "edit:  niri config set " + id + " model.name <model>",
  "       niri config set " + id + " discord.token <token>   # any config path works",
  "       niri config show " + id + "                        # current saved config",
  "       niri config apply " + id + " agent.yaml            # seed file (yaml/json/nix)",
  "wake:  niri agents start " + id + "   # boots the runtime on the saved config",
  "       niri chat " + id + "           # your first message wakes it; discord and cron wake it once enabled",
  "the agent can edit itself too, with niri.config.update(...) in its repl.",
].join("\n")
