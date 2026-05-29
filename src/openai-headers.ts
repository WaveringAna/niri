export function envHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function openAIUserAgent(providerValue?: string): string | undefined {
  return envHeaderValue(providerValue) ?? envHeaderValue(process.env.OPENAI_USER_AGENT)
}

export function openAIHeaders(entries: readonly (readonly [string, string | undefined])[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  for (const [name, value] of entries) {
    const headerValue = envHeaderValue(value)
    if (headerValue) headers[name] = headerValue
  }
  return Object.keys(headers).length ? headers : undefined
}
