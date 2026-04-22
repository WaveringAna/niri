import Database from "better-sqlite3"
import path from "path"
import { fileURLToPath } from "url"

const HOME_DIR = path.resolve(fileURLToPath(import.meta.url), "../../home")
const DB_PATH = path.join(HOME_DIR, "niri.db")

let db: Database.Database

export function initDb(): void {
  db = new Database(DB_PATH)

  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")

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
  `)

  console.log("[db] ready")
}

export function startConversation(source: string, startedAt: string): number {
  const stmt = db.prepare("insert into conversations (startedAt, source) values (?, ?)")
  const result = stmt.run(startedAt, source)
  return result.lastInsertRowid as number
}

export function logMessage(
  convId: number,
  role: string,
  content: string,
  toolCalls?: unknown,
  toolCallId?: string,
): void {
  const stmt = db.prepare(
    "insert into messages (convId, role, content, toolCalls, toolCallId) values (?, ?, ?, ?, ?)",
  )
  stmt.run(
    convId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolCallId ?? null,
  )
}

export function endConversation(id: number, tokens: number): void {
  db.prepare("update conversations set tokens = ? where id = ?").run(tokens, id)
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized")
  return db
}
