import type { SummaryPromptContext, SummaryPrompts } from "./types.js"

/**
 * Default, agent-neutral summarization prompts.
 *
 * These describe *what* to preserve without asserting anything about who the
 * agent is. A harness with a personality (Niri) or a specialist rubric (a PR
 * reviewer) supplies its own via {@link SummaryPrompts}; most only need to
 * override `segment` and `merge`.
 */

/**
 * Kept verbatim from Niri's original prompt, and exported because it is not
 * personality — it is a correctness rule about what compaction must never drop.
 * Any agent that talks to people should include it.
 */
export const SAFETY_CRITICAL_SUMMARY_INSTRUCTION =
  "SAFETY-CRITICAL EVENTS ARE ALWAYS LOAD-BEARING. If the transcript contains anything involving someone's physical safety, mental health crisis, self-harm, suicidal ideation, overdose, abuse, or threat of violence — preserve it in full detail regardless of whether it was resolved. Include: what was said (direct quotes where possible), who was involved, how it was handled, and what the plan is going forward. These events do not get compressed into general relationship threads. They get their own section. Resolution does not make them less important — the fact that it happened and how people responded IS the memory."

export const DEFAULT_SUMMARY_HEADER = "[context summary v1]"

export const DEFAULT_SUMMARY_NOTE =
  "Compressed notes of older conversation turns. They are a lossy but faithful record of work you actually did. If something looks missing, use the segment ids to search or expand the verbatim archive rather than assuming it did not happen. If a compressed note conflicts with a newer raw message, trust the newer message."

function groundingBlock(ctx: SummaryPromptContext): string {
  if (!ctx.grounding) return ""
  return (
    "\n\nGrounding — background on the agent and its current work. Use it to recognize the people, projects, and threads that appear in the transcript. " +
    "Do NOT pull facts from this grounding into the summary unless the transcript itself supports them: you are summarizing the transcript, not this context.\n\n" +
    ctx.grounding
  )
}

function recollectionBlock(ctx: SummaryPromptContext, label: string): string {
  if (!ctx.directRecollection?.trim()) return ""
  return `\n\n${label}\n\n${ctx.directRecollection}`
}

const RECOLLECTION_LABEL = "the agent recorded this directly before compaction; weave it in"

export const defaultSummaryPrompts: SummaryPrompts = {
  segment(ctx) {
    return (
      `You are summarizing a transcript of work done by an agent named ${ctx.agentName}, to be re-read later as its own record of what happened. ` +
      "Organize the summary as a set of ongoing threads: a person, a project, a problem, a decision — whatever is load-bearing enough to carry forward. " +
      "Threads are peers, not nested. Some items belong to several threads; let them. " +
      `${SAFETY_CRITICAL_SUMMARY_INSTRUCTION} ` +
      "Within each thread preserve: key facts, goals, decisions, and actions taken; outstanding work and exact identifiers (file paths, URLs, ids, line numbers); " +
      "open questions and unresolved uncertainty, not only settled conclusions; and specifics — names, exact phrasings, particular values — because specifics are what make the record usable later, and summarizers default to abstraction. " +
      "This is one independent chronological segment: summarize only the supplied transcript and do not assume another summary carries its details. " +
      "No commentary, no preamble. The input is always a transcript — never ask for more, summarize what is there." +
      groundingBlock(ctx) +
      recollectionBlock(ctx, RECOLLECTION_LABEL)
    )
  },

  merge(ctx) {
    return (
      `Consolidate these ordered memory segments into one higher-level recollection for ${ctx.agentName}. ` +
      `${SAFETY_CRITICAL_SUMMARY_INSTRUCTION} ` +
      "Every input segment remains recoverable as a child in a lossless DAG, but this summary must preserve the load-bearing facts, people, decisions, unfinished work, exact identifiers, and important contradictions across all children so the agent can orient without expanding them. " +
      "Do not mention the merge machinery. Do not discard a significant thread merely because it appears in only one child. No preamble or commentary." +
      groundingBlock(ctx) +
      recollectionBlock(ctx, RECOLLECTION_LABEL)
    )
  },

  chunkSuffix(part, total) {
    return `\n\nThis is chronological part ${part} of ${total}. Summarize every load-bearing thread in this part; a later pass will combine all parts.`
  },

  consolidate(ctx) {
    return (
      `Consolidate these ordered partial recollections into one memory segment for ${ctx.agentName}. ` +
      `${SAFETY_CRITICAL_SUMMARY_INSTRUCTION} ` +
      "Preserve every load-bearing person, event, project, correction, decision, identifier, and unfinished thread represented in any part. " +
      "Do not let later parts erase earlier ones. Do not mention chunks, partial summaries, or the consolidation process. No preamble or commentary." +
      recollectionBlock(ctx, RECOLLECTION_LABEL)
    )
  },

  recollectionPrompt:
    "Before this conversation is compressed, record what mattered: the decisions made, the things still unresolved, the details you would lose if this were summarized by someone else. Write it as your own notes, not a report.",

  recollectionTurnInstruction:
    "This is a pre-compaction recollection turn. No tools are available. Answer directly in prose; do not attempt, narrate, or promise a tool call. Normal work resumes after compaction.",

  recollectionLabel: RECOLLECTION_LABEL,

  summaryHeader: DEFAULT_SUMMARY_HEADER,
  summaryNote: DEFAULT_SUMMARY_NOTE,
}
