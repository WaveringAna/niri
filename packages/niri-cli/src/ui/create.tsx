import { useState } from "react"
import { Box, Text, useInput } from "ink"
import { TextInput } from "./text-input.js"
import { creationHints } from "../creation-hints.js"
import type { AgentConfig, NiriClient } from "../client.js"

export type CreateFlowProps = {
  client: NiriClient
  /** Given by `niri agents create ID`; the flow asks for an id when it is absent. */
  id?: string
  start?: boolean
  onDone: () => void
}

type Field = "id" | "provider" | "model" | "baseUrl" | "key" | "discord" | "token" | "owner"
type Draft = { id: string; provider: "openai" | "anthropic"; name: string; baseUrl: string; key: string; discord: boolean; token: string; owner: string }
type Step = Field | "submit" | "cancel"
type Question = { prompt: (draft: Draft) => string; accept: (draft: Draft, answer: string) => Draft; next: (draft: Draft) => Step }

const blank: Draft = { id: "", provider: "openai", name: "", baseUrl: "", key: "", discord: false, token: "", owner: "" }
/** Every openai-compatible endpoint is reached by pointing the provider elsewhere. */
const providerDefaults = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" } as const
const yes = (answer: string): boolean => /^(?:y|yes|true|1)$/i.test(answer.trim())
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The questionnaire as data: prompt, how an answer lands in the draft, and where it goes next. */
const script: Record<Field, Question> = {
  id: { prompt: () => "new agent id: ", accept: (draft, answer) => ({ ...draft, id: answer.trim() }), next: (draft) => draft.id ? "provider" : "cancel" },
  provider: {
    prompt: () => "model provider [openai/anthropic, default openai]: ",
    accept: (draft, answer) => ({ ...draft, provider: answer.trim().toLowerCase().startsWith("a") ? "anthropic" : "openai" }),
    next: () => "model",
  },
  model: {
    prompt: (draft) => `model name (e.g. ${draft.provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini"}): `,
    accept: (draft, answer) => ({ ...draft, name: answer.trim() }),
    next: () => "baseUrl",
  },
  baseUrl: {
    prompt: (draft) => `api base url (enter for ${providerDefaults[draft.provider]}): `,
    accept: (draft, answer) => ({ ...draft, baseUrl: answer.trim().replace(/\/+$/, "") }),
    next: () => "key",
  },
  key: {
    prompt: () => "api key (paste it, or env:VAR_NAME to reference one, enter to skip): ",
    accept: (draft, answer) => ({ ...draft, key: answer.trim() }),
    next: () => "discord",
  },
  discord: { prompt: () => "discord: enable? [y/N]: ", accept: (draft, answer) => ({ ...draft, discord: yes(answer) }), next: (draft) => draft.discord ? "token" : "submit" },
  token: { prompt: () => "discord bot token: ", accept: (draft, answer) => ({ ...draft, token: answer.trim() }), next: () => "owner" },
  owner: { prompt: () => "your discord user id (added to the dm whitelist): ", accept: (draft, answer) => ({ ...draft, owner: answer.trim() }), next: () => "submit" },
}

/** Enter skips a field; a fully skipped questionnaire creates the agent on server defaults. */
export const draftConfig = ({ provider, name, baseUrl, key, discord, token, owner }: Draft): AgentConfig | undefined => {
  const config: Record<string, unknown> = {}
  if (name || baseUrl || key) {
    config.model = { provider, ...(name ? { name } : {}), ...(baseUrl ? { baseUrl } : {}), ...(key && !key.startsWith("env:") ? { apiKey: key } : {}) }
    if (key.startsWith("env:")) config.secrets = { "model.apiKey": { env: key.slice(4).trim() } }
  }
  if (discord) config.discord = { enabled: true, ...(token ? { token } : {}), ...(owner ? { dmWhitelist: owner } : {}) }
  return Object.keys(config).length ? config as AgentConfig : undefined
}

type Phase = { kind: "ask"; field: Field } | { kind: "saving" } | { kind: "saved"; hints: string } | { kind: "failed"; error: string }

export function CreateFlow({ client, id, start = false, onDone }: CreateFlowProps) {
  const [draft, setDraft] = useState<Draft>({ ...blank, id: id ?? "" })
  const [phase, setPhase] = useState<Phase>({ kind: "ask", field: id ? "provider" : "id" })
  const [answer, setAnswer] = useState("")
  const [answered, setAnswered] = useState<string[]>([])

  const save = async (final: Draft): Promise<void> => {
    setPhase({ kind: "saving" })
    try {
      const created = await client.create(final.id, draftConfig(final), start, false)
      const model = created.config?.model as { name?: unknown } | undefined
      setPhase({ kind: "saved", hints: creationHints(final.id, Boolean(model && typeof model.name === "string" && model.name)) })
    } catch (error) { setPhase({ kind: "failed", error: message(error) }) }
  }

  const advance = (value: string): void => {
    if (phase.kind !== "ask") return
    const question = script[phase.field]
    const next = question.accept(draft, value)
    setDraft(next)
    setAnswer("")
    setAnswered((lines) => [...lines, `${question.prompt(draft)}${value}`])
    const step = question.next(next)
    if (step === "cancel") return onDone()
    if (step === "submit") return void save(next)
    setPhase({ kind: "ask", field: step })
  }

  // Ctrl-C abandons the draft — it dies with the screen — and any key leaves a finished one.
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || phase.kind === "saved" || phase.kind === "failed") onDone()
  })

  return (
    <Box flexDirection="column">
      <Text><Text bold color="cyan">niri</Text><Text color="gray">  new agent</Text></Text>
      {answered.map((line, index) => <Text key={index} color="gray">{line}</Text>)}
      {phase.kind === "ask" ? (
        <Text>
          <Text color="cyan">{script[phase.field].prompt(draft)}</Text>
          <TextInput value={answer} onChange={setAnswer} onSubmit={advance} />
        </Text>
      ) : null}
      {phase.kind === "saving" ? <Text color="gray">creating {draft.id}…</Text> : null}
      {phase.kind === "saved" ? <Text>{phase.hints}</Text> : null}
      {phase.kind === "failed" ? <Text color="red">{phase.error}</Text> : null}
      {phase.kind === "saved" || phase.kind === "failed" ? <Text color="gray">press enter to continue</Text> : null}
    </Box>
  )
}
