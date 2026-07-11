import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Fastify, { FastifyInstance } from "fastify";

interface CachedSessionHashes {
  trajectoryId: string;
  hashes: Array<[any, string]>;
}

interface BridgeState {
  clientId: string;
  clientSecret: string;
  cachedToken: string | null;
  tokenExpiry: number;
  projectId: string | null;
  thoughtSignatureCache: Record<string, string>;
  sessionsCache: Record<string, [string, string]>;
  hashCache: CachedSessionHashes[];
}

let state: BridgeState | null = null;
let bridgeServer: FastifyInstance | null = null;

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/home/mayer";
}

async function getBinaryPath(): Promise<string> {
  if (process.env.ANTIGRAVITY_BINARY_PATH) {
    return process.env.ANTIGRAVITY_BINARY_PATH;
  }
  const home = getHomeDir();
  const macPath = path.join(home, ".local", "bin", "agy");
  try {
    await fs.access(macPath);
    return macPath;
  } catch {}
  const linuxPath = "/home/mayer/.local/bin/agy";
  try {
    await fs.access(linuxPath);
    return linuxPath;
  } catch {}
  return "agy";
}

async function getBinarySha256(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function loadExpectedSha256(): Promise<string | null> {
  if (process.env.ANTIGRAVITY_EXPECTED_SHA256) {
    return process.env.ANTIGRAVITY_EXPECTED_SHA256.trim();
  }
  const home = getHomeDir();
  const filePath = path.join(home, ".gemini", "antigravity-cli", "agy.sha256");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.trim();
  } catch {
    return null;
  }
}

async function extractCredentialsCandidates(filePath: string): Promise<{ clientIds: string[], clientSecrets: string[] }> {
  const buffer = await fs.readFile(filePath);
  const content = buffer.toString("latin1");

  const clientIdRegex = /\d{10,15}-[a-z0-9_-]{20,50}\.apps\.googleusercontent\.com/g;
  const clientIds: string[] = [];
  let match;
  while ((match = clientIdRegex.exec(content)) !== null) {
    clientIds.push(match[0]);
  }

  const clientSecretRegex = /GOCSPX-[A-Za-z0-9_-]{28}/g;
  const clientSecrets: string[] = [];
  while ((match = clientSecretRegex.exec(content)) !== null) {
    clientSecrets.push(match[0]);
  }

  return {
    clientIds: Array.from(new Set(clientIds)).sort(),
    clientSecrets: Array.from(new Set(clientSecrets)).sort()
  };
}

async function loadRefreshToken(): Promise<string> {
  if (process.env.ANTIGRAVITY_REFRESH_TOKEN) {
    return process.env.ANTIGRAVITY_REFRESH_TOKEN;
  }
  const home = getHomeDir();
  const filePath = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const content = await fs.readFile(filePath, "utf-8");
  const val = JSON.parse(content);
  const token = val?.token?.refresh_token;
  if (!token) {
    throw new Error("No refresh_token found in antigravity-oauth-token JSON");
  }
  return token;
}

async function verifyAndBindCredentials(
  refreshToken: string,
  clientIds: string[],
  clientSecrets: string[]
): Promise<{ clientId: string; clientSecret: string }> {
  for (const clientId of clientIds) {
    for (const clientSecret of clientSecrets) {
      try {
        const params = new URLSearchParams();
        params.append("client_id", clientId);
        params.append("client_secret", clientSecret);
        params.append("refresh_token", refreshToken);
        params.append("grant_type", "refresh_token");

        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString()
        });

        if (res.status === 200) {
          console.log(`[bridge] Dynamic credential binding successful with client_id start: ${clientId.substring(0, 15)}`);
          return { clientId, clientSecret };
        }
      } catch {}
    }
  }
  throw new Error("Dynamic credential extraction failed to verify working pair.");
}

async function fetchProjectId(accessToken: string): Promise<string> {
  const res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity/cli/1.0.10 linux/amd64"
    },
    body: JSON.stringify({
      metadata: { ideType: "ANTIGRAVITY" }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetch_project_id returned status ${res.status}: ${text}`);
  }
  const data: any = await res.json();
  const project = data?.cloudaicompanionProject;
  if (!project) {
    throw new Error(`cloudaicompanionProject field missing in loadCodeAssist response payload: ${JSON.stringify(data)}`);
  }
  return project;
}

async function loadSignatures(): Promise<Record<string, string>> {
  try {
    const home = getHomeDir();
    const filePath = path.join(home, ".gemini", "antigravity-cli", "signatures.json");
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveSignatures(cache: Record<string, string>): Promise<void> {
  try {
    const home = getHomeDir();
    const dir = path.join(home, ".gemini", "antigravity-cli");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "signatures.json");
    await fs.writeFile(filePath, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("[bridge] failed to save signatures:", e);
  }
}

async function loadSessions(): Promise<Record<string, [string, string]>> {
  try {
    const home = getHomeDir();
    const filePath = path.join(home, ".gemini", "antigravity-cli", "sessions.json");
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveSessions(cache: Record<string, [string, string]>): Promise<void> {
  try {
    const home = getHomeDir();
    const dir = path.join(home, ".gemini", "antigravity-cli");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "sessions.json");
    await fs.writeFile(filePath, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn("[bridge] failed to save sessions:", e);
  }
}

async function initBridgeState(): Promise<void> {
  if (state) return;

  let clientId = process.env.ANTIGRAVITY_CLIENT_ID || "";
  let clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET || "";
  let projectId = process.env.ANTIGRAVITY_PROJECT_ID || null;

  const refreshToken = await loadRefreshToken();

  const expectedSha = await loadExpectedSha256();
  if (expectedSha) {
    const binaryPath = await getBinaryPath();
    const actualSha = await getBinarySha256(binaryPath);
    if (actualSha !== expectedSha) {
      throw new Error(`CRITICAL: agy binary SHA256 hash changed! Expected ${expectedSha}, got ${actualSha}.`);
    }
    console.log(`[bridge] agy SHA256 verified successfully: ${actualSha}`);
  }

  if (!clientId || !clientSecret) {
    const binaryPath = await getBinaryPath();
    console.log(`[bridge] Extracting OAuth candidates from ${binaryPath}...`);
    const { clientIds, clientSecrets } = await extractCredentialsCandidates(binaryPath);
    console.log(`[bridge] Found ${clientIds.length} client ID and ${clientSecrets.length} client secret candidates.`);

    const bound = await verifyAndBindCredentials(refreshToken, clientIds, clientSecrets);
    clientId = bound.clientId;
    clientSecret = bound.clientSecret;
  }

  const thoughtSignatureCache = await loadSignatures();
  const sessionsCache = await loadSessions();

  state = {
    clientId,
    clientSecret,
    cachedToken: null,
    tokenExpiry: 0,
    projectId,
    thoughtSignatureCache,
    sessionsCache,
    hashCache: []
  };
}

async function getValidTokenAndProject(): Promise<{ token: string; project: string }> {
  await initBridgeState();
  if (!state) throw new Error("Bridge state not initialized");

  const now = Math.floor(Date.now() / 1000);
  if (state.cachedToken && state.projectId && now < state.tokenExpiry - 60) {
    return { token: state.cachedToken, project: state.projectId };
  }

  const refreshToken = await loadRefreshToken();
  const params = new URLSearchParams();
  params.append("client_id", state.clientId);
  params.append("client_secret", state.clientSecret);
  params.append("refresh_token", refreshToken);
  params.append("grant_type", "refresh_token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to refresh OAuth token: ${text}`);
  }

  const data: any = await res.json();
  const token = data.access_token;
  const expiresIn = data.expires_in || 3600;
  if (!token) {
    throw new Error("access_token missing in oauth response");
  }

  state.cachedToken = token;
  state.tokenExpiry = now + expiresIn;

  if (!state.projectId) {
    state.projectId = await fetchProjectId(token);
  }

  return { token, project: state.projectId };
}

class LineDecoder {
  private buffer = "";

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.substring(0, index);
      this.buffer = this.buffer.substring(index + 1);
      if (line.endsWith("\r")) {
        line = line.substring(0, line.length - 1);
      }
      lines.push(line);
    }
    return lines;
  }
}

function hashMessagesIncrementalCached(
  messages: any[],
  hashCache: CachedSessionHashes[]
): { prefixHashes: string[]; newCacheHashes: Array<[any, string]> } {
  let bestMatchIndex: number | null = null;
  let bestMatchLen = 0;

  for (let cacheIdx = 0; cacheIdx < hashCache.length; cacheIdx++) {
    const cached = hashCache[cacheIdx];
    let matchLen = 0;
    for (let i = 0; i < messages.length; i++) {
      if (i < cached.hashes.length && JSON.stringify(cached.hashes[i][0]) === JSON.stringify(messages[i])) {
        matchLen++;
      } else {
        break;
      }
    }
    if (matchLen > bestMatchLen) {
      bestMatchLen = matchLen;
      bestMatchIndex = cacheIdx;
    }
  }

  const prefixHashes: string[] = [];
  let currentHash = Buffer.alloc(32, 0);
  const newCacheHashes: Array<[any, string]> = [];

  if (bestMatchIndex !== null) {
    const cached = hashCache[bestMatchIndex];
    for (let i = 0; i < bestMatchLen; i++) {
      const hashStr = cached.hashes[i][1];
      prefixHashes.push(hashStr);
      newCacheHashes.push([messages[i], hashStr]);
    }
    if (bestMatchLen > 0) {
      const lastHex = cached.hashes[bestMatchLen - 1][1];
      currentHash = Buffer.from(lastHex, "hex");
    }
  }

  for (let i = bestMatchLen; i < messages.length; i++) {
    const msg = messages[i];
    const msgJson = JSON.stringify(msg);
    const msgHash = crypto.createHash("sha256").update(msgJson).digest();

    const chainHasher = crypto.createHash("sha256");
    chainHasher.update(currentHash);
    chainHasher.update(msgHash);
    const finalHash = chainHasher.digest();
    currentHash = finalHash;

    const hashStr = finalHash.toString("hex");
    prefixHashes.push(hashStr);
    newCacheHashes.push([msg, hashStr]);
  }

  if (bestMatchIndex !== null) {
    hashCache.splice(bestMatchIndex, 1);
  }

  return { prefixHashes, newCacheHashes };
}

function sniffMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "GIF8") {
    return "image/gif";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "%PDF") {
    return "application/pdf";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    return "audio/wav";
  }
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") {
    return "audio/mpeg";
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
    return "audio/mpeg";
  }
  if (bytes.length >= 8 && bytes.toString("ascii", 4, 8) === "ftyp") {
    return "video/mp4";
  }
  return null;
}

function validateMediaSignature(mime: string, bytes: Buffer): boolean {
  const mimeLower = mime.toLowerCase();
  if (mimeLower.startsWith("image/png")) {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 && bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A;
  }
  if (mimeLower.startsWith("image/jpeg") || mimeLower.startsWith("image/jpg")) {
    return bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }
  if (mimeLower.startsWith("image/gif")) {
    return bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "GIF8";
  }
  if (mimeLower.startsWith("image/webp")) {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  if (mimeLower.startsWith("application/pdf")) {
    return bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "%PDF";
  }
  if (mimeLower.startsWith("audio/wav") || mimeLower.startsWith("audio/x-wav")) {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  }
  if (mimeLower.startsWith("audio/mpeg") || mimeLower.startsWith("audio/mp3")) {
    return bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0);
  }
  if (mimeLower.startsWith("video/mp4")) {
    return bytes.length >= 8 && bytes.toString("ascii", 4, 8) === "ftyp";
  }
  return bytes.length > 0;
}

function sniffOrValidateMime(mime: string, bytes: Buffer): string | null {
  const mimeLower = mime.toLowerCase();
  if (mimeLower === "application/octet-stream" || !mimeLower) {
    const sniffed = sniffMimeType(bytes);
    if (sniffed) return sniffed;
  }
  if (validateMediaSignature(mime, bytes)) {
    return mime;
  }
  const sniffed = sniffMimeType(bytes);
  if (sniffed) return sniffed;
  return null;
}

function parseDataUrl(url: string): { mime: string; data: string } | null {
  if (!url.startsWith("data:")) return null;
  const commaIdx = url.indexOf(",");
  if (commaIdx === -1) return null;
  const header = url.substring(0, commaIdx);
  const data = url.substring(commaIdx + 1);
  if (!header.endsWith(";base64")) return null;
  const mime = header.substring("data:".length, header.length - ";base64".length);
  return { mime, data };
}

function parseTextWithMedia(text: string, parts: any[]): void {
  const dataUrlRegex = /data:([a-zA-Z0-9\-+\.]+\/[a-zA-Z0-9\-+\.]+);base64,([a-zA-Z0-9/+=]+)/g;
  let lastMatchEnd = 0;
  let match;

  while ((match = dataUrlRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const mime = match[1];
    const data = match[2];
    const start = match.index;

    const preceding = text.substring(lastMatchEnd, start);
    if (preceding) {
      parts.push({ text: preceding });
    }

    const cleanedData = data.replace(/\s+/g, "");
    try {
      const decoded = Buffer.from(cleanedData, "base64");
      const finalMime = sniffOrValidateMime(mime, decoded);
      if (finalMime) {
        parts.push({
          inlineData: {
            mimeType: finalMime,
            data: cleanedData
          }
        });
      } else {
        parts.push({ text: fullMatch });
      }
    } catch {
      parts.push({ text: fullMatch });
    }

    lastMatchEnd = dataUrlRegex.lastIndex;
  }

  const remaining = text.substring(lastMatchEnd);
  if (remaining) {
    parts.push({ text: remaining });
  }
}

export function convertSchemaTypes(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  const cleaned: any = {};

  if (schema.type) {
    if (typeof schema.type === "string") {
      cleaned.type = schema.type.toUpperCase();
    } else {
      cleaned.type = schema.type;
    }
  }

  if (schema.format !== undefined) cleaned.format = schema.format;
  if (schema.description !== undefined) cleaned.description = schema.description;
  if (schema.nullable !== undefined) cleaned.nullable = schema.nullable;
  if (schema.enum !== undefined) cleaned.enum = schema.enum;
  if (schema.required !== undefined) cleaned.required = schema.required;

  if (schema.properties && typeof schema.properties === "object") {
    const cleanedProps: any = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      cleanedProps[k] = convertSchemaTypes(v);
    }
    cleaned.properties = cleanedProps;
  }

  if (schema.items) {
    cleaned.items = convertSchemaTypes(schema.items);
  }

  return cleaned;
}

function mapOpenaiToolsToGemini(openaiTools: any): any[] | null {
  if (!Array.isArray(openaiTools)) return null;

  const declarations: any[] = [];
  for (const tool of openaiTools) {
    if (tool?.type === "function" && tool.function) {
      const fnObj = tool.function;
      const decl: any = {
        name: fnObj.name || "",
        description: fnObj.description || ""
      };
      if (fnObj.parameters) {
        decl.parameters = convertSchemaTypes(fnObj.parameters);
      }
      declarations.push(decl);
    }
  }

  if (declarations.length > 0) {
    return [{ functionDeclarations: declarations }];
  }
  return null;
}

export function mapModelName(model: string, thinkingLevel?: string): string {
  const modelLower = model.toLowerCase();

  const exactMapping: Record<string, string> = {
    "gemini-3.5-flash-medium": "gemini-3.5-flash-low",
    "gemini-3.5-flash-high": "gemini-3-flash-agent",
    "gemini-3.5-flash-low": "gemini-3.5-flash-extra-low",
    "gemini-3.1-pro-low": "gemini-3.1-pro-low",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "claude-sonnet-4-6": "gemini-3.5-flash-low",
    "claude-opus-4-6-thinking": "gemini-3-flash-agent",
    "gpt-oss-120b-medium": "gpt-oss-120b-medium",
    "gemini 3.5 flash (medium)": "gemini-3.5-flash-low",
    "gemini 3.5 flash (high)": "gemini-3-flash-agent",
    "gemini 3.5 flash (low)": "gemini-3.5-flash-extra-low",
    "gemini 3.1 pro (low)": "gemini-3.1-pro-low",
    "gemini 3.1 pro (high)": "gemini-pro-agent",
    "claude sonnet 4.6 (thinking)": "gemini-3.5-flash-low",
    "claude opus 4.6 (thinking)": "gemini-3-flash-agent",
    "gpt-oss 120b (medium)": "gpt-oss-120b-medium"
  };

  if (exactMapping[modelLower]) {
    return exactMapping[modelLower];
  }

  const validModels = [
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-thinking",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-pro",
    "gemini-3.5-flash-low",
    "gemini-3-flash-agent",
    "gemini-3.5-flash-extra-low",
    "gemini-pro-agent",
    "gemini-3.1-pro-low",
    "gemini-3.1-pro-high",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "gpt-oss-120b-medium"
  ];

  if (validModels.includes(modelLower)) {
    return modelLower;
  }

  if (modelLower.includes("flash")) {
    if (thinkingLevel) {
      const lvl = thinkingLevel.toLowerCase();
      if (lvl === "high") return "gemini-3-flash-agent";
      if (lvl === "low") return "gemini-3.5-flash-extra-low";
      return "gemini-3.5-flash-low";
    } else if (modelLower.includes("high")) {
      return "gemini-3-flash-agent";
    } else if (modelLower.includes("low")) {
      return "gemini-3.5-flash-extra-low";
    } else {
      return "gemini-3.5-flash-low";
    }
  } else if (modelLower.includes("pro")) {
    if (modelLower.includes("high")) {
      return "gemini-pro-agent";
    } else {
      return "gemini-3.1-pro-low";
    }
  } else if (modelLower.includes("sonnet")) {
    return "gemini-3.5-flash-low";
  } else if (modelLower.includes("haiku")) {
    return "gemini-3.5-flash-extra-low";
  } else if (modelLower.includes("opus")) {
    return "gemini-3-flash-agent";
  } else if (modelLower.includes("gpt-oss")) {
    return "gpt-oss-120b-medium";
  } else {
    return model;
  }
}

export function mapOpenaiMessagesToGemini(
  messages: any[],
  signatureCache: Record<string, string>
): { contents: any[]; systemInstruction: any | null } {
  const contents: any[] = [];
  let systemInstruction: any | null = null;

  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (Array.isArray(msg?.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc?.id && tc?.function?.name) {
          toolNameById.set(tc.id, tc.function.name);
        }
      }
    }
  }

  for (const msg of messages) {
    const role = msg.role || "user";
    const content = msg.content || "";

    switch (role) {
      case "system":
        systemInstruction = {
          role: "user",
          parts: [{ text: content }]
        };
        break;

      case "tool": {
        const tcId = msg.tool_call_id || "";
        const fnName = toolNameById.get(tcId) || "unknown_tool";

        let responseObj: any;
        try {
          const val = typeof content === "string" ? JSON.parse(content) : content;
          if (val && typeof val === "object" && !Array.isArray(val)) {
            responseObj = val;
          } else {
            responseObj = { result: val };
          }
        } catch {
          responseObj = { result: content };
        }

        const parts: any[] = [{
          functionResponse: {
            name: fnName,
            response: responseObj,
            id: tcId
          }
        }];

        if (fnName === "read_media" && typeof content === "string") {
          const dataUrlRegex = /data:([a-zA-Z0-9\-+\.]+\/[a-zA-Z0-9\-+\.]+);base64,([a-zA-Z0-9/+=]+)/g;
          let match;
          while ((match = dataUrlRegex.exec(content)) !== null) {
            const mime = match[1];
            const data = match[2];
            const cleanedData = data.replace(/\s+/g, "");
            try {
              const decoded = Buffer.from(cleanedData, "base64");
              const finalMime = sniffOrValidateMime(mime, decoded);
              if (finalMime) {
                parts.push({
                  inlineData: {
                    mimeType: finalMime,
                    data: cleanedData
                  }
                });
              }
            } catch {}
          }
        }

        contents.push({
          role: "model",
          parts
        });
        break;
      }

      case "assistant":
      case "model": {
        const parts: any[] = [];
        if (content) {
          parts.push({ text: content });
        }

        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            if (tc?.type === "function" && tc.function) {
              const func = tc.function;
              const funcName = func.name || "";
              let argsVal: any;
              if (typeof func.arguments === "string") {
                try {
                  argsVal = JSON.parse(func.arguments);
                } catch {
                  argsVal = {};
                }
              } else if (func.arguments && typeof func.arguments === "object") {
                argsVal = func.arguments;
              } else {
                argsVal = {};
              }

              const tcId = tc.id || "";
              const signature = signatureCache[tcId] || "";

              parts.push({
                functionCall: {
                  name: funcName,
                  args: argsVal,
                  id: tcId
                },
                thoughtSignature: signature
              });
            }
          }
        }

        if (parts.length > 0) {
          contents.push({
            role: "model",
            parts
          });
        }
        break;
      }

      default: {
        const parts: any[] = [];
        if (typeof content === "string") {
          if (content) {
            parseTextWithMedia(content, parts);
          }
        } else if (Array.isArray(content)) {
          for (const item of content) {
            if (item?.type === "text" && item.text) {
              parts.push({ text: item.text });
            } else if (item?.type === "image_url" && item.image_url?.url) {
              const parsed = parseDataUrl(item.image_url.url);
              if (parsed) {
                const cleanedData = parsed.data.replace(/\s+/g, "");
                try {
                  const decoded = Buffer.from(cleanedData, "base64");
                  const finalMime = sniffOrValidateMime(parsed.mime, decoded) || parsed.mime;
                  parts.push({
                    inlineData: {
                      mimeType: finalMime,
                      data: cleanedData
                    }
                  });
                } catch {
                  parts.push({
                    inlineData: {
                      mimeType: parsed.mime,
                      data: cleanedData
                    }
                  });
                }
              }
            } else if (["image", "document", "audio", "video", "file"].includes(item?.type)) {
              if (item.source?.type === "base64" && item.source.media_type && item.source.data) {
                const cleanedData = item.source.data.replace(/\s+/g, "");
                try {
                  const decoded = Buffer.from(cleanedData, "base64");
                  const finalMime = sniffOrValidateMime(item.source.media_type, decoded) || item.source.media_type;
                  parts.push({
                    inlineData: {
                      mimeType: finalMime,
                      data: cleanedData
                    }
                  });
                } catch {
                  parts.push({
                    inlineData: {
                      mimeType: item.source.media_type,
                      data: cleanedData
                    }
                  });
                }
              }
              const urlKey = `${item.type}_url`;
              if (item[urlKey]?.url) {
                const parsed = parseDataUrl(item[urlKey].url);
                if (parsed) {
                  const cleanedData = parsed.data.replace(/\s+/g, "");
                  try {
                    const decoded = Buffer.from(cleanedData, "base64");
                    const finalMime = sniffOrValidateMime(parsed.mime, decoded) || parsed.mime;
                    parts.push({
                      inlineData: {
                        mimeType: finalMime,
                        data: cleanedData
                      }
                    });
                  } catch {
                    parts.push({
                      inlineData: {
                        mimeType: parsed.mime,
                        data: cleanedData
                      }
                    });
                  }
                }
              }
            }
          }
        }

        if (parts.length > 0) {
          contents.push({
            role: "user",
            parts
          });
        }
        break;
      }
    }
  }

  return { contents, systemInstruction };
}

export function mapAnthropicMessagesToGemini(
  messages: any[],
  signatureCache: Record<string, string>
): { contents: any[] } {
  const contents: any[] = [];
  const toolNameById = new Map<string, string>();

  for (const msg of messages) {
    if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_use" && block.id && block.name) {
          toolNameById.set(block.id, block.name);
        }
      }
    }
  }

  for (const msg of messages) {
    const role = msg.role || "user";
    const geminiRole = role === "assistant" ? "model" : "user";

    let parts: any[] = [];
    const contentVal = msg.content;

    if (typeof contentVal === "string") {
      if (contentVal) {
        parseTextWithMedia(contentVal, parts);
      }
    } else if (Array.isArray(contentVal)) {
      for (const block of contentVal) {
        const blockType = block?.type || "";
        switch (blockType) {
          case "text":
            if (block.text) {
              parts.push({ text: block.text });
            }
            break;

          case "image":
          case "document":
            if (block.source?.type === "base64" && block.source.media_type && block.source.data) {
              const cleanedData = block.source.data.replace(/\s+/g, "");
              try {
                const decoded = Buffer.from(cleanedData, "base64");
                const finalMime = sniffOrValidateMime(block.source.media_type, decoded) || block.source.media_type;
                parts.push({
                  inlineData: {
                    mimeType: finalMime,
                    data: cleanedData
                  }
                });
              } catch {
                parts.push({
                  inlineData: {
                    mimeType: block.source.media_type,
                    data: cleanedData
                  }
                });
              }
            }
            break;

          case "tool_use": {
            const funcName = block.name || "";
            const argsVal = block.input || {};
            const tcId = block.id || "";
            const signature = signatureCache[tcId] || "";

            parts.push({
              functionCall: {
                name: funcName,
                args: argsVal,
                id: tcId
              },
              thoughtSignature: signature
            });
            break;
          }

          case "tool_result": {
            const tcId = block.tool_use_id || "";
            const fnName = toolNameById.get(tcId) || "unknown_tool";
            const blockContent = block.content;

            let responseObj: any;
            let nestedParts: any[] = [];

            if (typeof blockContent === "string") {
              try {
                const val = JSON.parse(blockContent);
                if (val && typeof val === "object" && !Array.isArray(val)) {
                  responseObj = val;
                } else {
                  responseObj = { result: val };
                }
              } catch {
                responseObj = { result: blockContent };
              }
            } else if (blockContent && typeof blockContent === "object" && !Array.isArray(blockContent)) {
              responseObj = blockContent;
            } else if (Array.isArray(blockContent)) {
              let textAccum = "";
              const mediaParts: any[] = [];
              for (const nestedBlock of blockContent) {
                if (nestedBlock?.type === "text" && nestedBlock.text) {
                  textAccum += nestedBlock.text;
                } else if (["image", "document"].includes(nestedBlock?.type)) {
                  if (nestedBlock.source?.type === "base64" && nestedBlock.source.media_type && nestedBlock.source.data) {
                    const cleanedData = nestedBlock.source.data.replace(/\s+/g, "");
                    try {
                      const decoded = Buffer.from(cleanedData, "base64");
                      const finalMime = sniffOrValidateMime(nestedBlock.source.media_type, decoded) || nestedBlock.source.media_type;
                      mediaParts.push({
                        inlineData: {
                          mimeType: finalMime,
                          data: cleanedData
                        }
                      });
                    } catch {
                      mediaParts.push({
                        inlineData: {
                          mimeType: nestedBlock.source.media_type,
                          data: cleanedData
                        }
                      });
                    }
                  }
                }
              }
              responseObj = { result: textAccum };
              nestedParts = mediaParts;
            } else {
              responseObj = { result: String(blockContent) };
            }

            if (parts.length > 0) {
              contents.push({
                role: "user",
                parts
              });
              parts = [];
            }

            const toolParts = [{
              functionResponse: {
                name: fnName,
                response: responseObj,
                id: tcId
              }
            }, ...nestedParts];

            contents.push({
              role: "user",
              parts: toolParts
            });
            break;
          }
        }
      }
    }

    if (parts.length > 0) {
      contents.push({
        role: geminiRole,
        parts
      });
    }
  }

  const mergedContents: any[] = [];
  for (const item of contents) {
    const lastItem = mergedContents[mergedContents.length - 1];
    if (lastItem && lastItem.role === item.role) {
      if (Array.isArray(lastItem.parts) && Array.isArray(item.parts)) {
        lastItem.parts.push(...item.parts);
        continue;
      }
    }
    mergedContents.push(item);
  }

  const resolvedIds = new Set<string>();
  for (const item of mergedContents) {
    if (Array.isArray(item.parts)) {
      for (const part of item.parts) {
        if (part?.functionResponse?.id) {
          resolvedIds.add(part.functionResponse.id);
        }
      }
    }
  }

  for (const item of mergedContents) {
    if (item.role === "model" && Array.isArray(item.parts)) {
      item.parts = item.parts.filter((part: any) => {
        if (part?.functionCall?.id) {
          return resolvedIds.has(part.functionCall.id);
        }
        return true;
      });
    }
  }

  const finalContents = mergedContents.filter((item: any) => {
    return !Array.isArray(item.parts) || item.parts.length > 0;
  });

  return { contents: finalContents };
}

function mapAnthropicToolsToGemini(anthropicTools: any): any[] | null {
  if (!Array.isArray(anthropicTools)) return null;

  const declarations: any[] = [];
  for (const tool of anthropicTools) {
    const decl: any = {
      name: tool.name || "",
      description: tool.description || ""
    };
    if (tool.input_schema) {
      decl.parameters = convertSchemaTypes(tool.input_schema);
    }
    declarations.push(decl);
  }

  if (declarations.length > 0) {
    return [{ functionDeclarations: declarations }];
  }
  return null;
}

function mapAnthropicSystemInstruction(system: any): any | null {
  if (typeof system === "string") {
    if (system) {
      return {
        role: "user",
        parts: [{ text: system }]
      };
    }
  } else if (Array.isArray(system)) {
    const parts: any[] = [];
    for (const block of system) {
      if (block?.type === "text" && block.text) {
        parts.push({ text: block.text });
      }
    }
    if (parts.length > 0) {
      return {
        role: "user",
        parts
      };
    }
  }
  return null;
}

async function sendTelemetryMetrics(
  token: string,
  project: string,
  trajectoryId: string,
  traceId: string | null,
  firstLatencyMs: number,
  totalLatencyMs: number
): Promise<void> {
  try {
    const nowStr = new Date().toISOString();
    const payload = {
      project,
      requestId: crypto.randomUUID(),
      metadata: {
        ideType: "ANTIGRAVITY",
        ideVersion: "1.0.10",
        platform: "LINUX_AMD64"
      },
      metrics: [
        {
          timestamp: nowStr,
          conversationOffered: {
            status: "ACTION_STATUS_NO_ERROR",
            traceId: traceId || "",
            streamingLatency: {
              firstMessageLatency: `${(firstLatencyMs / 1000).toFixed(9)}s`,
              totalLatency: `${(totalLatencyMs / 1000).toFixed(9)}s`
            },
            isAgentic: true,
            initiationMethod: "AGENT",
            trajectoryId,
            language: "unspecified"
          }
        }
      ]
    };

    console.log(`[bridge] Sending recordCodeAssistMetrics telemetry (trajectory_id: ${trajectoryId})...`);
    const res = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:recordCodeAssistMetrics", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "antigravity/cli/1.0.10 linux/amd64"
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[bridge] recordCodeAssistMetrics returned status ${res.status}: ${text}`);
    } else {
      console.log("[bridge] Successfully recorded telemetry metrics.");
    }
  } catch (e) {
    console.warn("[bridge] Failed to record telemetry metrics:", e);
  }
}

export function createBridgeServer(): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 15 * 1024 * 1024
  });

  const getModels = async (_req: any, reply: any) => {
    return reply.send({
      data: [
        { id: "Gemini 3.5 Flash (Medium)", object: "model" },
        { id: "Gemini 3.5 Flash (High)", object: "model" },
        { id: "Gemini 3.5 Flash (Low)", object: "model" },
        { id: "Gemini 3.1 Pro (Low)", object: "model" },
        { id: "Gemini 3.1 Pro (High)", object: "model" },
        { id: "Claude Sonnet 4.6 (Thinking)", object: "model" },
        { id: "Claude Opus 4.6 (Thinking)", object: "model" },
        { id: "GPT-OSS 120B (Medium)", object: "model" }
      ]
    });
  };
  app.get("/v1/models", getModels);
  app.get("/models", getModels);

  app.post("/v1/chat/completions", async (req: any, reply: any) => {
    const startBridge = Date.now();
    let authVals;
    try {
      authVals = await getValidTokenAndProject();
    } catch (e: any) {
      console.error("[bridge] Auth failed:", e);
      return reply.code(500).send({ error: `Auth failed: ${e.message}` });
    }
    const tAuth = Date.now() - startBridge;

    const body = req.body || {};
    const messages = body.messages || [];
    const model = body.model || "";
    const thinkingLevel = body.thinking_level || null;
    const tools = body.tools || null;

    const modelId = mapModelName(model, thinkingLevel);

    const tStartMapping = Date.now();
    const { contents, systemInstruction } = mapOpenaiMessagesToGemini(messages, state?.thoughtSignatureCache || {});
    const tMapping = Date.now() - tStartMapping;

    let budget = 0;
    const modelLower = modelId.toLowerCase();
    if (modelLower.includes("high") || modelLower.includes("agent")) {
      budget = 4096;
    } else if (modelLower.includes("low")) {
      budget = 2048;
    }

    const tStartHashing = Date.now();
    const { prefixHashes, newCacheHashes } = hashMessagesIncrementalCached(messages, state?.hashCache || []);

    let trajId: string | null = null;
    let sessId: string | null = null;

    if (prefixHashes.length > 0 && state) {
      for (let i = prefixHashes.length - 2; i >= 0; i--) {
        const prefixHash = prefixHashes[i];
        if (state.sessionsCache[prefixHash]) {
          [trajId, sessId] = state.sessionsCache[prefixHash];
          break;
        }
      }
    }

    const trajectoryId = trajId || crypto.randomUUID();
    const sessionId = sessId || Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
    const tHashing = Date.now() - tStartHashing;

    const tStartDisk = Date.now();
    if (state) {
      state.hashCache.unshift({
        trajectoryId,
        hashes: newCacheHashes
      });
      state.hashCache = state.hashCache.slice(0, 10);

      const currentHash = prefixHashes[prefixHashes.length - 1];
      if (currentHash) {
        state.sessionsCache[currentHash] = [trajectoryId, sessionId];
        saveSessions(state.sessionsCache); // background async save
      }
    }
    const tDisk = Date.now() - tStartDisk;

    const setupMs = Date.now() - startBridge;
    console.log(`[bridge] setup finished in ${setupMs}ms (auth: ${tAuth}ms, mapping: ${tMapping}ms, hashing: ${tHashing}ms, disk: ${tDisk}ms)`);

    const payload: any = {
      project: authVals.project,
      requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
      request: {
        contents,
        generationConfig: {
          maxOutputTokens: 8192,
          thinkingConfig: {
            includeThoughts: budget > 0,
            thinkingBudget: budget
          }
        },
        labels: {
          last_step_index: "1",
          model_enum: "MODEL_PLACEHOLDER_M132",
          trajectory_id: trajectoryId,
          used_claude: "false",
          used_claude_conservative: "false"
        },
        sessionId
      },
      model: modelId,
      userAgent: "antigravity",
      requestType: "chat",
      enabledCreditTypes: ["GOOGLE_ONE_AI"]
    };

    if (tools) {
      const mappedTools = mapOpenaiToolsToGemini(tools);
      if (mappedTools) {
        payload.request.tools = mappedTools;
      }
    }

    if (systemInstruction) {
      payload.request.systemInstruction = systemInstruction;
    }

    console.log(`[bridge] Forwarding streamGenerateContent request for model: ${modelId} (thinkingBudget=${budget})...`);

    let response;
    try {
      response = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${authVals.token}`,
          "Content-Type": "application/json",
          "User-Agent": "antigravity/cli/1.0.10 linux/amd64",
          "Accept": "text/event-stream",
          "Cache-Control": "no-cache"
        },
        body: JSON.stringify(payload)
      });
    } catch (e: any) {
      console.error("[bridge] API request failed:", e);
      return reply.code(500).send({ error: `API request failed: ${e.message}` });
    }

    if (!response.ok) {
      const status = response.status;
      const errText = await response.text();
      console.error(`[bridge] daily-cloudcode API returned status ${status}: ${errText}`);
      return reply.code(status).send({ error: `API returned ${status}: ${errText}` });
    }

    const requestIdHeader = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").substring(0, 12)}`;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "x-bridge-setup-ms": setupMs.toString()
    });

    const reader = response.body?.getReader();
    const textDecoder = new TextDecoder("utf-8");
    const lineDecoder = new LineDecoder();

    let firstMsgLatency: number | null = null;
    let traceId: string | null = null;
    const startTime = Date.now();
    let toolCallIndex = 0;

    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = textDecoder.decode(value, { stream: true });
          const lines = lineDecoder.feed(chunk);
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const dataStr = trimmed.substring("data: ".length);
            if (dataStr === "[DONE]") break;

            try {
              const chunkVal = JSON.parse(dataStr);
              if (firstMsgLatency === null) {
                firstMsgLatency = Date.now() - startTime;
              }
              if (chunkVal.traceId) {
                traceId = chunkVal.traceId;
              }

              const responsePart = chunkVal.response || {};

              if (responsePart.usageMetadata) {
                const usageMeta = responsePart.usageMetadata;
                const out = {
                  id: requestIdHeader,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [],
                  usage: {
                    prompt_tokens: usageMeta.promptTokenCount || 0,
                    completion_tokens: usageMeta.candidatesTokenCount || 0,
                    total_tokens: usageMeta.totalTokenCount || 0,
                    cached_prompt_tokens: usageMeta.cachedContentTokenCount || 0
                  }
                };
                reply.raw.write(`data: ${JSON.stringify(out)}\n\n`);
              }

              if (Array.isArray(responsePart.candidates) && responsePart.candidates.length > 0) {
                const candidate = responsePart.candidates[0];
                let finishReason: any = null;
                if (candidate.finishReason) {
                  const fr = candidate.finishReason;
                  finishReason = fr === "STOP"
                    ? (toolCallIndex > 0 ? "tool_calls" : "stop")
                    : (fr === "MAX_TOKENS" ? "length" : (["SAFETY", "RECITATION"].includes(fr) ? "content_filter" : "stop"));
                }

                if (Array.isArray(candidate.content?.parts)) {
                  for (const part of candidate.content.parts) {
                    const text = part.text || "";
                    const isThought = !!part.thought;
                    const func = part.functionCall;

                    if (isThought) {
                      if (text) {
                        const out = {
                          id: requestIdHeader,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: modelId,
                          choices: [{
                            index: 0,
                            delta: { reasoning_content: text },
                            finish_reason: null
                          }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(out)}\n\n`);
                      }
                    } else if (func && typeof func === "object") {
                      const name = func.name || "";
                      const argsVal = func.args;
                      const argsStr = typeof argsVal === "object" ? JSON.stringify(argsVal) : (argsVal || "{}");

                      const tcId = func.id || `call_${crypto.randomUUID().replace(/-/g, "").substring(0, 12)}`;
                      const thoughtSig = part.thoughtSignature || part.thought_signature;
                      if (thoughtSig && state) {
                        state.thoughtSignatureCache[tcId] = thoughtSig;
                        saveSignatures(state.thoughtSignatureCache);
                      }

                      const out = {
                        id: requestIdHeader,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: modelId,
                        choices: [{
                          index: 0,
                          delta: {
                            tool_calls: [{
                              index: toolCallIndex,
                              id: tcId,
                              type: "function",
                              function: {
                                name,
                                arguments: argsStr
                              }
                            }]
                          },
                          finish_reason: "tool_calls"
                        }]
                      };
                      toolCallIndex++;
                      reply.raw.write(`data: ${JSON.stringify(out)}\n\n`);
                    } else {
                      if (text) {
                        const out = {
                          id: requestIdHeader,
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: modelId,
                          choices: [{
                            index: 0,
                            delta: { content: text },
                            finish_reason: null
                          }]
                        };
                        reply.raw.write(`data: ${JSON.stringify(out)}\n\n`);
                      }
                    }
                  }
                }

                if (finishReason !== null) {
                  const out = {
                    id: requestIdHeader,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelId,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: finishReason
                    }]
                  };
                  reply.raw.write(`data: ${JSON.stringify(out)}\n\n`);
                }
              }
            } catch (err) {
              console.error("[bridge] Failed to parse SSE line JSON:", err);
            }
          }
        }
      } catch (streamErr) {
        console.error("[bridge] Stream read error:", streamErr);
      } finally {
        reader.releaseLock();
      }
    }

    const totalLatency = Date.now() - startTime;
    void sendTelemetryMetrics(
      authVals.token,
      authVals.project,
      trajectoryId,
      traceId,
      firstMsgLatency || totalLatency,
      totalLatency
    );

    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  });

  const handleAnthropicMessages = async (req: any, reply: any) => {
    const startBridge = Date.now();
    let authVals;
    try {
      authVals = await getValidTokenAndProject();
    } catch (e: any) {
      console.error("[bridge] Auth failed:", e);
      return reply.code(500).send({ error: `Auth failed: ${e.message}` });
    }
    const tAuth = Date.now() - startBridge;

    const body = req.body || {};
    const messages = body.messages || [];
    const model = body.model || "";
    const system = body.system || null;
    const maxTokens = body.max_tokens || 8192;
    const stream = !!body.stream;
    const thinking = body.thinking || null;

    const modelId = mapModelName(model);

    const tStartMapping = Date.now();
    const { contents } = mapAnthropicMessagesToGemini(messages, state?.thoughtSignatureCache || {});
    const systemInstruction = system ? mapAnthropicSystemInstruction(system) : null;
    const tMapping = Date.now() - tStartMapping;

    let budget = 0;
    if (thinking && thinking.type === "enabled") {
      budget = thinking.budget_tokens || 2048;
    } else {
      const modelLower = modelId.toLowerCase();
      if (modelLower.includes("high") || modelLower.includes("agent")) {
        budget = 4096;
      } else if (modelLower.includes("low")) {
        budget = 2048;
      }
    }

    const tStartHashing = Date.now();
    const { prefixHashes, newCacheHashes } = hashMessagesIncrementalCached(messages, state?.hashCache || []);

    let trajId: string | null = null;
    let sessId: string | null = null;

    if (prefixHashes.length > 0 && state) {
      for (let i = prefixHashes.length - 2; i >= 0; i--) {
        const prefixHash = prefixHashes[i];
        if (state.sessionsCache[prefixHash]) {
          [trajId, sessId] = state.sessionsCache[prefixHash];
          break;
        }
      }
    }

    const trajectoryId = trajId || crypto.randomUUID();
    const sessionId = sessId || Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
    const tHashing = Date.now() - tStartHashing;

    const tStartDisk = Date.now();
    if (state) {
      state.hashCache.unshift({
        trajectoryId,
        hashes: newCacheHashes
      });
      state.hashCache = state.hashCache.slice(0, 10);

      const currentHash = prefixHashes[prefixHashes.length - 1];
      if (currentHash) {
        state.sessionsCache[currentHash] = [trajectoryId, sessionId];
        saveSessions(state.sessionsCache);
      }
    }
    const tDisk = Date.now() - tStartDisk;

    const setupMs = Date.now() - startBridge;
    console.log(`[bridge] setup finished in ${setupMs}ms (auth: ${tAuth}ms, mapping: ${tMapping}ms, hashing: ${tHashing}ms, disk: ${tDisk}ms)`);

    const payload: any = {
      project: authVals.project,
      requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
      request: {
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens,
          thinkingConfig: {
            includeThoughts: budget > 0,
            thinkingBudget: budget
          }
        },
        labels: {
          last_step_index: "1",
          model_enum: "MODEL_PLACEHOLDER_M132",
          trajectory_id: trajectoryId,
          used_claude: "false",
          used_claude_conservative: "false"
        },
        sessionId
      },
      model: modelId,
      userAgent: "antigravity",
      requestType: "chat",
      enabledCreditTypes: ["GOOGLE_ONE_AI"]
    };

    if (body.tools) {
      const mappedTools = mapAnthropicToolsToGemini(body.tools);
      if (mappedTools) {
        payload.request.tools = mappedTools;
      }
    }

    if (systemInstruction) {
      payload.request.systemInstruction = systemInstruction;
    }

    console.log(`[bridge] Forwarding Anthropic streamGenerateContent request for model: ${modelId} (thinkingBudget=${budget})...`);

    let response;
    try {
      response = await fetch("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${authVals.token}`,
          "Content-Type": "application/json",
          "User-Agent": "antigravity/cli/1.0.10 linux/amd64",
          "Accept": "text/event-stream",
          "Cache-Control": "no-cache"
        },
        body: JSON.stringify(payload)
      });
    } catch (e: any) {
      console.error("[bridge] API request failed:", e);
      return reply.code(500).send({ error: `API request failed: ${e.message}` });
    }

    if (!response.ok) {
      const status = response.status;
      const errText = await response.text();
      console.error(`[bridge] daily-cloudcode API returned status ${status}: ${errText}`);
      return reply.code(status).send({ error: `API returned ${status}: ${errText}` });
    }

    const messageId = `msg_01${crypto.randomUUID().replace(/-/g, "").substring(0, 20)}`;

    const reader = response.body?.getReader();
    const textDecoder = new TextDecoder("utf-8");
    const lineDecoder = new LineDecoder();

    let firstMsgLatency: number | null = null;
    let traceId: string | null = null;
    const startTime = Date.now();

    if (stream) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "x-bridge-setup-ms": setupMs.toString()
      });

      const msgStartVal = {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: modelId,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0
          }
        }
      };
      reply.raw.write(`event: message_start\ndata: ${JSON.stringify(msgStartVal)}\n\n`);

      let currentBlockIndex = 0;
      let currentBlockType: string | null = null;
      let hasToolCalls = false;
      let completionTokens = 0;

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = textDecoder.decode(value, { stream: true });
            const lines = lineDecoder.feed(chunk);
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const dataStr = trimmed.substring("data: ".length);
              if (dataStr === "[DONE]") break;

              try {
                const chunkVal = JSON.parse(dataStr);
                if (firstMsgLatency === null) {
                  firstMsgLatency = Date.now() - startTime;
                }
                if (chunkVal.traceId) {
                  traceId = chunkVal.traceId;
                }

                const responsePart = chunkVal.response || {};

                if (responsePart.usageMetadata) {
                  completionTokens = responsePart.usageMetadata.candidatesTokenCount || 0;
                }

                if (Array.isArray(responsePart.candidates) && responsePart.candidates.length > 0) {
                  const candidate = responsePart.candidates[0];
                  if (Array.isArray(candidate.content?.parts)) {
                    for (const part of candidate.content.parts) {
                      const text = part.text || "";
                      const isThought = !!part.thought;
                      const func = part.functionCall;

                      if (isThought) {
                        if (text) {
                          if (currentBlockType !== "thinking") {
                            if (currentBlockType !== null) {
                              reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
                              currentBlockIndex++;
                            }
                            currentBlockType = "thinking";
                            reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                              type: "content_block_start",
                              index: currentBlockIndex,
                              content_block: { type: "thinking", thinking: "" }
                            })}\n\n`);
                          }
                          reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                            type: "content_block_delta",
                            index: currentBlockIndex,
                            delta: { type: "thinking_delta", thinking: text }
                          })}\n\n`);
                        }
                      } else if (func && typeof func === "object") {
                        hasToolCalls = true;
                        if (currentBlockType !== null) {
                          reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
                          currentBlockIndex++;
                        }

                        const name = func.name || "";
                        const argsVal = func.args;
                        const argsStr = typeof argsVal === "object" ? JSON.stringify(argsVal) : (argsVal || "{}");

                        const tcId = func.id || `toolu_01${crypto.randomUUID().replace(/-/g, "").substring(0, 20)}`;
                        const thoughtSig = part.thoughtSignature || part.thought_signature;
                        if (thoughtSig && state) {
                          state.thoughtSignatureCache[tcId] = thoughtSig;
                          saveSignatures(state.thoughtSignatureCache);
                        }

                        reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                          type: "content_block_start",
                          index: currentBlockIndex,
                          content_block: { type: "tool_use", id: tcId, name, input: {} }
                        })}\n\n`);

                        reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                          type: "content_block_delta",
                          index: currentBlockIndex,
                          delta: { type: "input_json_delta", partial_json: argsStr }
                        })}\n\n`);

                        currentBlockType = "tool_use";
                      } else {
                        if (text) {
                          if (currentBlockType !== "text") {
                            if (currentBlockType !== null) {
                              reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
                              currentBlockIndex++;
                            }
                            currentBlockType = "text";
                            reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({
                              type: "content_block_start",
                              index: currentBlockIndex,
                              content_block: { type: "text", text: "" }
                            })}\n\n`);
                          }
                          reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({
                            type: "content_block_delta",
                            index: currentBlockIndex,
                            delta: { type: "text_delta", text }
                          })}\n\n`);
                        }
                      }
                    }
                  }
                }
              } catch (err) {
                console.error("[bridge] Failed to parse SSE line JSON:", err);
              }
            }
          }
        } catch (streamErr) {
          console.error("[bridge] Stream read error:", streamErr);
        } finally {
          reader.releaseLock();
        }
      }

      if (currentBlockType !== null) {
        reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: currentBlockIndex })}\n\n`);
      }

      const totalLatency = Date.now() - startTime;
      void sendTelemetryMetrics(
        authVals.token,
        authVals.project,
        trajectoryId,
        traceId,
        firstMsgLatency || totalLatency,
        totalLatency
      );

      const stopReason = hasToolCalls ? "tool_use" : "end_turn";
      reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: completionTokens }
      })}\n\n`);

      reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      reply.raw.end();
    } else {
      let contentBlocks: any[] = [];
      let completionTokens = 0;
      let promptTokens = 0;
      let stopReason = "end_turn";

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = textDecoder.decode(value, { stream: true });
            const lines = lineDecoder.feed(chunk);
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const dataStr = trimmed.substring("data: ".length);
              if (dataStr === "[DONE]") break;

              try {
                const chunkVal = JSON.parse(dataStr);
                if (firstMsgLatency === null) {
                  firstMsgLatency = Date.now() - startTime;
                }
                if (chunkVal.traceId) {
                  traceId = chunkVal.traceId;
                }

                const responsePart = chunkVal.response || {};
                if (responsePart.usageMetadata) {
                  completionTokens = responsePart.usageMetadata.candidatesTokenCount || 0;
                  promptTokens = responsePart.usageMetadata.promptTokenCount || 0;
                }

                if (Array.isArray(responsePart.candidates) && responsePart.candidates.length > 0) {
                  const candidate = responsePart.candidates[0];
                  if (Array.isArray(candidate.content?.parts)) {
                    for (const part of candidate.content.parts) {
                      const text = part.text || "";
                      const isThought = !!part.thought;
                      const func = part.functionCall;

                      if (isThought) {
                        if (text) {
                          const lastBlock = contentBlocks[contentBlocks.length - 1];
                          if (lastBlock && lastBlock.type === "thinking") {
                            lastBlock.thinking += text;
                          } else {
                            contentBlocks.push({ type: "thinking", thinking: text });
                          }
                        }
                      } else if (func && typeof func === "object") {
                        stopReason = "tool_use";
                        const name = func.name || "";
                        const argsVal = func.args;
                        const argsObj = typeof argsVal === "object" ? argsVal : JSON.parse(argsVal || "{}");

                        const tcId = func.id || `toolu_01${crypto.randomUUID().replace(/-/g, "").substring(0, 20)}`;
                        const thoughtSig = part.thoughtSignature || part.thought_signature;
                        if (thoughtSig && state) {
                          state.thoughtSignatureCache[tcId] = thoughtSig;
                          saveSignatures(state.thoughtSignatureCache);
                        }

                        contentBlocks.push({
                          type: "tool_use",
                          id: tcId,
                          name,
                          input: argsObj
                        });
                      } else {
                        if (text) {
                          const lastBlock = contentBlocks[contentBlocks.length - 1];
                          if (lastBlock && lastBlock.type === "text") {
                            lastBlock.text += text;
                          } else {
                            contentBlocks.push({ type: "text", text });
                          }
                        }
                      }
                    }
                  }
                }
              } catch (err) {
                console.error("[bridge] Failed to parse SSE line JSON:", err);
              }
            }
          }
        } catch (streamErr) {
          console.error("[bridge] Stream read error:", streamErr);
        } finally {
          reader.releaseLock();
        }
      }

      const totalLatency = Date.now() - startTime;
      void sendTelemetryMetrics(
        authVals.token,
        authVals.project,
        trajectoryId,
        traceId,
        firstMsgLatency || totalLatency,
        totalLatency
      );

      return reply.header("x-bridge-setup-ms", setupMs.toString()).send({
        id: messageId,
        type: "message",
        role: "assistant",
        content: contentBlocks,
        model: modelId,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens
        }
      });
    }
  };

  app.post("/v1/messages", handleAnthropicMessages);
  app.post("/messages", handleAnthropicMessages);

  return app;
}

export async function startAntigravityBridge(): Promise<void> {
  const enabled = process.env.ANTIGRAVITY_BRIDGE_ENABLED === "true";
  if (!enabled) {
    return;
  }

  const port = parseInt(process.env.ANTIGRAVITY_BRIDGE_PORT || "8000", 10);
  console.log(`[bridge] Starting Antigravity Bridge on port ${port}...`);

  try {
    await initBridgeState();
    bridgeServer = createBridgeServer();
    await bridgeServer.listen({ port, host: "127.0.0.1" });
    console.log(`[bridge] Antigravity Bridge successfully listening on http://127.0.0.1:${port}`);
  } catch (err) {
    console.error("[bridge] Failed to start Antigravity Bridge:", err);
    throw err;
  }
}

export async function stopAntigravityBridge(): Promise<void> {
  if (bridgeServer) {
    console.log("[bridge] Stopping Antigravity Bridge...");
    await bridgeServer.close();
    bridgeServer = null;
    console.log("[bridge] Antigravity Bridge stopped.");
  }
}
