import type { PromptBuilder, PromptBuilderOptions, PromptContext, PromptSection } from "./types.js"

/**
 * Conventional order bands. Sections within a band keep registration order, so
 * a harness can insert its own without renumbering anything.
 */
export const PromptOrder = {
  /** Who the agent is. Usually supplied as `preamble` rather than a section. */
  Identity: 100,
  /** Where it runs: workspace, home, platform. */
  Environment: 200,
  /** What it can do: tool documentation. */
  Tools: 300,
  /** How it should work: policies, rubrics, house style. */
  Conduct: 400,
  /** Session mechanics: waiting, resting, continuation. */
  Lifecycle: 500,
} as const

function sortSections(sections: readonly PromptSection[]): PromptSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => a.section.order - b.section.order || a.index - b.index)
    .map(({ section }) => section)
}

export function createPromptBuilder(sections: readonly PromptSection[] = []): PromptBuilder {
  const own = [...sections]

  return {
    sections: own,

    with(section) {
      const index = own.findIndex((existing) => existing.id === section.id)
      const next = [...own]
      if (index >= 0) next[index] = section
      else next.push(section)
      return createPromptBuilder(next)
    },

    without(...sectionIds) {
      const drop = new Set(sectionIds)
      return createPromptBuilder(own.filter((section) => !drop.has(section.id)))
    },

    async build(ctx: PromptContext, options: PromptBuilderOptions = {}) {
      const separator = options.separator ?? "\n\n"
      // Sections may do I/O (reading a soul file, a rubric); run them together.
      const rendered = await Promise.all(sortSections(own).map((section) => section.render(ctx)))
      const blocks = rendered
        .map((block) => block?.trim())
        .filter((block): block is string => Boolean(block))
      const preamble = options.preamble?.trim()
      return [...(preamble ? [preamble] : []), ...blocks].join(separator)
    },
  }
}

/** Convenience for the common case of a static block. */
export function staticSection(id: string, order: number, content: string): PromptSection {
  return { id, order, render: () => content }
}

/**
 * A section that renders only when a predicate holds.
 *
 * Prefer this over emitting "X is not available" filler: an absent capability
 * should be absent from the prompt, not described.
 */
export function conditionalSection(
  section: PromptSection,
  when: (ctx: PromptContext) => boolean,
): PromptSection {
  return {
    id: section.id,
    order: section.order,
    render: (ctx) => (when(ctx) ? section.render(ctx) : null),
  }
}
