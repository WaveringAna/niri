export type LoopBudget = {
  tokenCount: number
  contextSize: number
}

let snapshot: LoopBudget = {
  tokenCount: 0,
  contextSize: 0,
}

export function setLoopBudget(update: Partial<LoopBudget>): void {
  snapshot = {
    tokenCount: update.tokenCount ?? snapshot.tokenCount,
    contextSize: update.contextSize ?? snapshot.contextSize,
  }
}

export function readLoopBudget(): LoopBudget {
  return { ...snapshot }
}
