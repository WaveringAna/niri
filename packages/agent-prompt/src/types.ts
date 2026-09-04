import type { ToolCapability, WorkspaceDescriptor } from "@mira/harness-protocol"
import type { ToolDefinition } from "@mira/harness-core"

/**
 * Composable system-prompt assembly.
 *
 * Replaces `bootstrap.ts`'s single 150-line template literal, which interleaved
 * reusable material (workspace description, tool docs, context-archive usage)
 * with Niri-only material (hearth/forge posture, "Always Be Journaling", rest
 * philosophy). Sections let a harness keep the first and drop the second.
 */

export type PromptContext = {
  agentName: string
  homeDir: string
  /** Capabilities the attached client actually exposes. */
  clientCapabilities: readonly ToolCapability[]
  workspace: WorkspaceDescriptor | null
  /** Full tool surface, so a section can document exactly what is present. */
  tools: readonly ToolDefinition[]
  /** Arbitrary host-supplied values addressed by section id. */
  extras: Readonly<Record<string, unknown>>
}

/**
 * One contiguous block of the system prompt.
 *
 * Returning `null` omits the section entirely — that is how a section
 * disappears when its feature is off, instead of emitting "X is not available"
 * filler.
 */
export type PromptSection = {
  id: string
  /** Ascending; ties keep registration order. Convention: 100s per band. */
  order: number
  render(ctx: PromptContext): string | null | Promise<string | null>
}

export type PromptBuilderOptions = {
  /** Prepended verbatim ahead of every section — Niri's soul.md goes here. */
  preamble?: string | null
  /** Separator between rendered sections. */
  separator?: string
}

/**
 * Assembles sections into a system prompt. Sections are sorted by `order`,
 * rendered (possibly concurrently), and joined; nulls are dropped.
 */
export interface PromptBuilder {
  readonly sections: readonly PromptSection[]
  /** Returns a new builder with the section added or replaced by id. */
  with(section: PromptSection): PromptBuilder
  /** Returns a new builder without the named sections. */
  without(...sectionIds: string[]): PromptBuilder
  build(ctx: PromptContext, options?: PromptBuilderOptions): Promise<string>
}
