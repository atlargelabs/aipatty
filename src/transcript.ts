import type { Context } from "@earendil-works/chord/context";
import type { Conversation, EntryId, EntryRecord } from "@earendil-works/pi-durable";

/** Raw transcript entries in chronological order, with an exclusive cursor for the next older page. */
export interface TranscriptPage {
  entries: EntryRecord[];
  before: EntryId | null;
}

/** Select a backward page, looking one entry further to distinguish a full last page from more history. */
export async function transcriptPage(
  conversation: Conversation, context: Context, limit: number, before?: number,
): Promise<TranscriptPage> {
  const query = before === undefined ? {} : { maxEntryId: (before - 1) as EntryId };
  const { items } = await conversation.entries(query, limit + 1, undefined, context);
  const entries = items.slice(0, limit).reverse();
  return { entries, before: items.length > limit ? entries[0].id : null };
}
