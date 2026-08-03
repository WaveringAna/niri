import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import * as sqliteVec from "sqlite-vec"
import { publishWorkerEvent } from "./awp/outbox"
import { NIRI_HOME as HOME_DIR } from "./agent-config"

const DB_PATH = path.join(HOME_DIR, "niri.db")
export const MEMORY_EMBEDDING_DIMENSIONS = 3072

let db: Database.Database
let vecAvailable = false

function ensureWritableDirOrThrow(dirPath: string, purpose: string): void {
  try {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
    fs.accessSync(dirPath, fs.constants.W_OK)
  } catch (err: any) {
    let owner = "unknown"
    try {
      const st = fs.statSync(dirPath)
      owner = `${st.uid}:${st.gid}`
    } catch {
      // ignore
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    const gid = typeof process.getgid === "function" ? process.getgid() : undefined
    const who = uid !== undefined && gid !== undefined ? `${uid}:${gid}` : "current user"

    throw new Error(
      [
        `[db] cannot write ${purpose} under ${dirPath}`,
        `- dir owner: ${owner}`,
        `- process uid:gid: ${who}`,
        "",
        "Fix:",
        "- If running locally: `sudo chown -R $(id -u):$(id -g) home`",
        "- If running via docker-compose: set `AGENT_UID`/`AGENT_GID` in .env to match `id -u`/`id -g`, then recreate the container",
        "",
        `Original error: ${err?.message ?? String(err)}`,
      ].join("\n"),
    )
  }
}

export function initDb(): void {
  ensureWritableDirOrThrow(HOME_DIR, "niri.db")
  db = new Database(DB_PATH)
  fs.chmodSync(DB_PATH, 0o600)

  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  try {
    sqliteVec.load(db)
    vecAvailable = true
  } catch (err: any) {
    vecAvailable = false
    console.warn(`[db] sqlite-vec unavailable: ${err?.message ?? String(err)}`)
  }

  db.exec(`
    create table if not exists conversations (
      id        integer primary key autoincrement,
      startedAt text    not null,
      source    text    not null,
      tokens    integer not null default 0
    );

    create table if not exists messages (
      id         integer primary key autoincrement,
      convId     integer not null references conversations(id),
      role       text    not null,
      content    text    not null,
      toolCalls  text,                          -- json blob, null if none
      toolCallId text,                          -- for role=tool responses
      createdAt  text    not null default (datetime('now'))
    );

    create table if not exists context_messages (
      id           text primary key,
      role         text not null,
      content_json text not null,
      content_text text not null,
      first_seen_at text not null,
      source       text not null
    );

    create index if not exists idx_context_messages_seen
      on context_messages(first_seen_at desc);

    create table if not exists context_summaries (
      id           text primary key,
      summary_text text not null,
      method       text not null,
      created_at   text not null
    );

    create table if not exists context_summary_messages (
      summary_id text not null references context_summaries(id) on delete cascade,
      message_id text not null references context_messages(id),
      ordinal    integer not null,
      primary key (summary_id, ordinal)
    );

    create index if not exists idx_context_summary_messages_order
      on context_summary_messages(summary_id, ordinal);

    create index if not exists idx_context_summary_messages_message
      on context_summary_messages(message_id);

    create table if not exists context_summary_parents (
      summary_id text not null references context_summaries(id) on delete cascade,
      parent_id  text not null references context_summaries(id),
      ordinal    integer not null,
      primary key (summary_id, parent_id)
    );

    create table if not exists discord_messages (
      message_id    text primary key,
      channel_id    text not null,
      guild_id      text,
      channel_type  integer,
      author_id     text,
      author_username text,
      content       text not null default '',
      created_at    text not null,
      is_dm         integer not null default 0,
      mentions_bot  integer not null default 0,
      is_from_bot   integer not null default 0,
      first_seen_at text not null,
      last_seen_at  text not null,
      raw_json      text not null
    );

    create index if not exists idx_discord_messages_channel
      on discord_messages(channel_id, message_id desc);
    create index if not exists idx_discord_messages_created
      on discord_messages(created_at desc);

    create table if not exists discord_message_embedding_meta (
      message_id    text primary key references discord_messages(message_id) on delete cascade,
      model         text not null,
      dimensions    integer not null,
      content_hash  text not null,
      updated_at    text not null default (datetime('now'))
    );

    create table if not exists discord_items (
      item_id         text primary key,
      message_id      text not null references discord_messages(message_id) on delete cascade,
      bucket          text not null,
      status          text not null default 'pending',
      action_taken    text not null default 'none',
      decision_note   text,
      first_seen_at   text not null,
      last_seen_at    text not null,
      last_decision_at text
    );

    create index if not exists idx_discord_items_status
      on discord_items(status, last_seen_at desc);
    create index if not exists idx_discord_items_message
      on discord_items(message_id);

    create table if not exists discord_channels (
      channel_id    text primary key,
      guild_id      text,
      channel_type  integer,
      channel_name  text,
      guild_name    text,
      topic         text,
      is_dm         integer not null default 0,
      configured    integer not null default 0,
      note          text,
      last_note_at  text,
      first_seen_at text not null,
      last_seen_at  text not null,
      raw_json      text not null
    );

    create index if not exists idx_discord_channels_configured
      on discord_channels(configured, guild_name, channel_name);
    create index if not exists idx_discord_channels_last_seen
      on discord_channels(last_seen_at desc);

    create table if not exists discord_meta (
      key        text primary key,
      value      text not null,
      updated_at text not null
    );

    create table if not exists discord_user_pronouns (
      user_id    text primary key,
      pronouns   text not null,
      updated_at text not null
    );

    create table if not exists delegated_tasks (
      id                text primary key,
      profile           text not null,
      objective         text not null,
      status            text not null,
      created_by_kind   text not null,
      created_by_id     text,
      created_by_name   text,
      created_at        text not null,
      started_at        text,
      completed_at      text,
      result_summary    text,
      error             text,
      discord_thread_id text unique,
      cancel_requested  integer not null default 0,
      token_count       integer not null default 0,
      context_size      integer not null default 0
    );

    create index if not exists idx_delegated_tasks_status
      on delegated_tasks(status, created_at);

    create table if not exists delegated_task_messages (
      id                 text primary key,
      task_id            text not null references delegated_tasks(id) on delete cascade,
      seq                integer not null,
      sender_kind        text not null,
      sender_id          text,
      sender_name        text not null,
      kind               text not null,
      content            text not null,
      created_at         text not null,
      discord_message_id text unique,
      unique(task_id, seq)
    );

    create index if not exists idx_delegated_task_messages_order
      on delegated_task_messages(task_id, seq);

    create table if not exists delegation_profile_feedback (
      id         text primary key,
      profile    text not null,
      task_id    text not null references delegated_tasks(id) on delete cascade,
      content    text not null,
      created_at text not null
    );

    create index if not exists idx_delegation_profile_feedback_order
      on delegation_profile_feedback(profile, created_at desc);

    create table if not exists memory_documents (
      id           integer primary key autoincrement,
      path         text    not null unique,
      kind         text    not null,
      title        text    not null,
      mtime_ms     integer not null,
      content_hash text    not null,
      updated_at   text    not null default (datetime('now'))
    );

    create index if not exists idx_memory_documents_kind
      on memory_documents(kind, path);

    create table if not exists memory_chunks (
      id           integer primary key autoincrement,
      document_id  integer not null references memory_documents(id) on delete cascade,
      chunk_index  integer not null,
      title        text    not null,
      heading_path text,
      chunk_text   text    not null,
      tags         text,
      created_at   text    not null default (datetime('now')),
      unique(document_id, chunk_index)
    );

    create index if not exists idx_memory_chunks_document
      on memory_chunks(document_id, chunk_index);

    create virtual table if not exists memory_chunks_fts using fts5(
      title,
      heading_path,
      chunk_text,
      tags,
      content='memory_chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    create trigger if not exists memory_chunks_ai after insert on memory_chunks begin
      insert into memory_chunks_fts(rowid, title, heading_path, chunk_text, tags)
      values (new.id, new.title, new.heading_path, new.chunk_text, new.tags);
    end;

    create trigger if not exists memory_chunks_ad after delete on memory_chunks begin
      insert into memory_chunks_fts(memory_chunks_fts, rowid, title, heading_path, chunk_text, tags)
      values ('delete', old.id, old.title, old.heading_path, old.chunk_text, old.tags);
    end;

    create trigger if not exists memory_chunks_au after update on memory_chunks begin
      insert into memory_chunks_fts(memory_chunks_fts, rowid, title, heading_path, chunk_text, tags)
      values ('delete', old.id, old.title, old.heading_path, old.chunk_text, old.tags);
      insert into memory_chunks_fts(rowid, title, heading_path, chunk_text, tags)
      values (new.id, new.title, new.heading_path, new.chunk_text, new.tags);
    end;

    create table if not exists memory_embedding_meta (
      chunk_id      integer primary key references memory_chunks(id) on delete cascade,
      model         text    not null,
      dimensions    integer not null,
      content_hash  text    not null,
      updated_at    text    not null default (datetime('now'))
    );

    create index if not exists idx_memory_embedding_meta_model
      on memory_embedding_meta(model, dimensions);

    create table if not exists memory_embedding_prototypes (
      id           integer primary key,
      name         text    not null unique,
      category     text    not null,
      model        text    not null,
      dimensions   integer not null,
      content_hash text    not null,
      updated_at   text    not null default (datetime('now'))
    );
  `)

  if (vecAvailable) {
    db.exec(`
      create virtual table if not exists memory_chunk_vec using vec0(
        embedding float[${MEMORY_EMBEDDING_DIMENSIONS}] distance_metric=cosine
      );

      create virtual table if not exists memory_prototype_vec using vec0(
        embedding float[${MEMORY_EMBEDDING_DIMENSIONS}] distance_metric=cosine
      );

      create virtual table if not exists discord_message_vec using vec0(
        embedding float[${MEMORY_EMBEDDING_DIMENSIONS}] distance_metric=cosine
      );
    `)
  }

  console.log("[db] ready")
}

export function startConversation(source: string, startedAt: string): number {
  const stmt = db.prepare("insert into conversations (startedAt, source) values (?, ?)")
  const result = stmt.run(startedAt, source)
  const conversationId = result.lastInsertRowid as number
  publishWorkerEvent("conversation.started", {
    conversationId,
    source,
    startedAt,
  })
  return conversationId
}

export function logMessage(
  convId: number,
  role: string,
  content: string,
  toolCalls?: unknown,
  toolCallId?: string,
): void {
  const createdAt = new Date().toISOString()
  const stmt = db.prepare(
    "insert into messages (convId, role, content, toolCalls, toolCallId, createdAt) values (?, ?, ?, ?, ?, ?)",
  )
  stmt.run(
    convId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolCallId ?? null,
    createdAt,
  )
  publishWorkerEvent("conversation.message", {
    conversationId: convId,
    role,
    content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    createdAt,
  })
}

export function endConversation(id: number, tokens: number): void {
  db.prepare("update conversations set tokens = ? where id = ?").run(tokens, id)
  publishWorkerEvent("conversation.ended", {
    conversationId: id,
    tokens,
    endedAt: new Date().toISOString(),
  })
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized")
  return db
}

export function isVecAvailable(): boolean {
  return vecAvailable
}
