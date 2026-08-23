/**
 * Transport-agnostic reconciliation store.
 *
 * Every hard part of a chat client lives here: an optimistic bubble that has to
 * survive the server's echo arriving before its own ack, a seq gap that means a
 * dropped frame rather than a missing message, and an outbox that has to resend
 * across a reconnect without producing duplicates.
 *
 * The store never touches a socket. It returns Effects that the transport
 * performs, which is what makes all of this testable without a network.
 */

export type MessageStatus = "sent" | "pending" | "failed";

export interface ServerMessage {
  id: string;
  conversationId: string;
  senderId: string;
  seq: number;
  type: "text" | "image" | "file" | "system";
  content: string | null;
  replyToMessageId: string | null;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  clientMessageId?: string | null;
}

export interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  senderId: string;
  type: "text" | "image" | "file";
  content: string;
  replyToMessageId: string | null;
  queuedAt: number;
  attempts: number;
  status: "pending" | "failed";
  error?: string;
}

/** What the UI renders: confirmed messages in seq order, then the outbox tail. */
export type TimelineEntry =
  | { kind: "sent"; message: ServerMessage }
  | { kind: "local"; pending: PendingMessage };

export type Effect =
  | { type: "backfill"; conversationId: string; afterSeq: number }
  | { type: "reload"; conversationId: string }
  | { type: "transmit"; pending: PendingMessage };

/**
 * Error codes the server will return for the same input no matter how many
 * times it is retried. Anything not on this list is treated as transport
 * trouble and stays in the outbox.
 */
const TERMINAL_ERRORS = new Set([
  "NOT_A_PARTICIPANT",
  "MESSAGE_TOO_LONG",
  "EMPTY_MESSAGE",
  "REPLY_TARGET_INVALID",
  "CONVERSATION_NOT_FOUND",
  "BLOCKED",
]);

const MAX_ATTEMPTS = 8;

interface ConversationState {
  id: string;
  /** Confirmed messages, always sorted ascending by seq. */
  list: ServerMessage[];
  byId: Map<string, ServerMessage>;
  bySeq: Map<number, ServerMessage>;
  /** Lowest seq we hold. Anything below this is history, not a gap. */
  baseSeq: number;
  /** Highest seq with an unbroken run up from baseSeq. The sync cursor. */
  contiguousUpTo: number;
  pending: PendingMessage[];
  lastReadSeq: number;
  hasMoreHistory: boolean;
  /** Set when the server said our backfill was too large to stream. */
  needsReload: boolean;
  gapSince: number | null;
}

function emptyConversation(id: string): ConversationState {
  return {
    id,
    list: [],
    byId: new Map(),
    bySeq: new Map(),
    baseSeq: 0,
    contiguousUpTo: 0,
    pending: [],
    lastReadSeq: 0,
    hasMoreHistory: true,
    needsReload: false,
    gapSince: null,
  };
}

/** How long a gap may stay open before we assume a frame was dropped. */
export const GAP_GRACE_MS = 250;

export class MessageStore {
  private convs = new Map<string, ConversationState>();
  private listeners = new Set<() => void>();
  /** Bumped on every mutation so React can memoise snapshots cheaply. */
  version = 0;
  /**
   * Server-issued timestamp of our last successful sync, echoed back as the
   * mutation cursor. Deliberately the SERVER's clock -- a device running five
   * minutes fast would otherwise skip five minutes of edits.
   */
  syncedAt: string | null = null;
  private effects: Effect[] = [];
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  // -- subscription ---------------------------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** The transport drains this after every call and performs what it finds. */
  drainEffects(): Effect[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  private conv(id: string): ConversationState {
    let c = this.convs.get(id);
    if (!c) {
      c = emptyConversation(id);
      this.convs.set(id, c);
    }
    return c;
  }

  // -- reading --------------------------------------------------------------

  timeline(conversationId: string): TimelineEntry[] {
    const c = this.convs.get(conversationId);
    if (!c) return [];
    const entries: TimelineEntry[] = c.list.map((message) => ({
      kind: "sent" as const,
      message,
    }));
    for (const pending of c.pending) entries.push({ kind: "local", pending });
    return entries;
  }

  unreadCount(conversationId: string): number {
    const c = this.convs.get(conversationId);
    if (!c) return 0;
    let n = 0;
    for (const m of c.list) if (m.seq > c.lastReadSeq && !m.deletedAt) n++;
    return n;
  }

  cursor(conversationId: string): number {
    return this.convs.get(conversationId)?.contiguousUpTo ?? 0;
  }

  /** Cursors for the N most recently active conversations, for `sync`. */
  syncCursors(limit = 20): Record<string, number> {
    const ranked = [...this.convs.values()]
      .filter((c) => c.contiguousUpTo > 0)
      .sort((a, b) => b.contiguousUpTo - a.contiguousUpTo)
      .slice(0, limit);
    const out: Record<string, number> = {};
    for (const c of ranked) out[c.id] = c.contiguousUpTo;
    return out;
  }

  hasGap(conversationId: string): boolean {
    const c = this.convs.get(conversationId);
    if (!c || c.list.length === 0) return false;
    return c.list[c.list.length - 1].seq > c.contiguousUpTo;
  }

  needsReload(conversationId: string): boolean {
    return this.convs.get(conversationId)?.needsReload ?? false;
  }

  outbox(conversationId?: string): PendingMessage[] {
    if (conversationId) return [...(this.convs.get(conversationId)?.pending ?? [])];
    return [...this.convs.values()].flatMap((c) => c.pending);
  }

  // -- loading --------------------------------------------------------------

  /**
   * Seed from REST history. The page is contiguous by construction -- seq is
   * gapless and the query is `WHERE seq < before ORDER BY seq DESC LIMIT n` --
   * PROVIDED the server returns soft-deleted rows as tombstones rather than
   * filtering them out. Filtering them punches holes in the sequence and the
   * client sees phantom gaps forever.
   */
  seedHistory(conversationId: string, messages: ServerMessage[], hasMore: boolean) {
    const c = this.conv(conversationId);
    c.needsReload = false;
    c.hasMoreHistory = hasMore;
    for (const m of messages) this.insert(c, m);
    if (messages.length > 0) {
      const seqs = messages.map((m) => m.seq);
      const lo = Math.min(...seqs);
      const hi = Math.max(...seqs);
      c.baseSeq = c.baseSeq === 0 ? lo : Math.min(c.baseSeq, lo);
      if (hi > c.contiguousUpTo) c.contiguousUpTo = hi;
      this.recomputeContiguity(c);
    }
    this.emit();
  }

  /** Wholesale replacement after a truncated sync. */
  resetConversation(conversationId: string) {
    this.convs.set(conversationId, emptyConversation(conversationId));
    this.emit();
  }

  // -- inbound realtime -----------------------------------------------------

  /**
   * A message from the server, whether it arrived as a `message:new` broadcast,
   * a send ack, or a backfill row. All three funnel here so the reconciliation
   * rules exist in exactly one place.
   */
  receive(message: ServerMessage, opts: { fromBackfill?: boolean } = {}) {
    const c = this.conv(message.conversationId);

    // Our own message coming back to us. Retire the optimistic copy first so
    // the two never render side by side, regardless of which arrived first.
    if (message.clientMessageId) {
      const i = c.pending.findIndex(
        (p) => p.clientMessageId === message.clientMessageId
      );
      if (i !== -1) c.pending.splice(i, 1);
    }

    const known = c.byId.get(message.id);
    if (known) {
      // Mutation (edit / delete) or a duplicate delivery. Upsert in place --
      // seq never changes, so position is stable.
      Object.assign(known, message);
      this.emit();
      return;
    }

    if (c.baseSeq === 0) c.baseSeq = message.seq;
    this.insert(c, message);

    if (message.seq === c.contiguousUpTo + 1 || c.contiguousUpTo === 0) {
      this.recomputeContiguity(c);
    } else if (message.seq > c.contiguousUpTo + 1) {
      this.recomputeContiguity(c);
    }

    if (!opts.fromBackfill) this.checkGap(c);
    this.emit();
  }

  /**
   * An edit or delete for a message we never loaded. Ignored deliberately --
   * we will get the current version whenever that part of history is loaded.
   * Mutations do not advance seq, so this is never a gap.
   */
  receiveMutation(message: ServerMessage) {
    const c = this.convs.get(message.conversationId);
    if (!c || !c.byId.has(message.id)) return;
    this.receive(message);
  }

  applyBackfill(
    conversationId: string,
    messages: ServerMessage[],
    truncated: boolean,
    syncedAt?: string
  ) {
    if (syncedAt) this.syncedAt = syncedAt;
    const c = this.conv(conversationId);
    if (truncated) {
      // Too far behind to stream. Cheaper to throw the cache away than to
      // paginate inside sync.
      this.convs.set(conversationId, emptyConversation(conversationId));
      this.convs.get(conversationId)!.needsReload = true;
      this.effects.push({ type: "reload", conversationId });
      this.emit();
      return;
    }
    for (const m of messages) {
      // A backfill carries two kinds of row: messages we missed (seq above our
      // cursor) and mutations of messages we may or may not hold. Inserting a
      // mutation for history we never loaded would strand a lone message far
      // below our base and open a gap that can never close.
      const isOldRow = m.seq <= c.contiguousUpTo;
      if (isOldRow && !c.byId.has(m.id)) continue;
      this.receive(m, { fromBackfill: true });
    }
    c.gapSince = null;
    this.recomputeContiguity(c);
    this.checkGap(c);
    this.emit();
  }

  markRead(conversationId: string, seq: number) {
    const c = this.conv(conversationId);
    if (seq > c.lastReadSeq) {
      c.lastReadSeq = seq; // monotonic, mirrors the server-side guard
      this.emit();
    }
  }

  // -- outbound -------------------------------------------------------------

  enqueue(input: {
    clientMessageId: string;
    conversationId: string;
    senderId: string;
    type?: "text" | "image" | "file";
    content: string;
    replyToMessageId?: string | null;
  }): PendingMessage {
    const c = this.conv(input.conversationId);
    const pending: PendingMessage = {
      clientMessageId: input.clientMessageId,
      conversationId: input.conversationId,
      senderId: input.senderId,
      type: input.type ?? "text",
      content: input.content,
      replyToMessageId: input.replyToMessageId ?? null,
      queuedAt: this.now(),
      attempts: 0,
      status: "pending",
    };
    c.pending.push(pending);
    this.effects.push({ type: "transmit", pending });
    this.emit();
    return pending;
  }

  markAttempted(clientMessageId: string, conversationId: string) {
    const p = this.findPending(conversationId, clientMessageId);
    if (p) p.attempts += 1;
  }

  /**
   * A send failed. Terminal errors stop immediately and surface to the user;
   * anything else stays in the outbox for the next reconnect.
   */
  failSend(
    conversationId: string,
    clientMessageId: string,
    error: { code: string; message: string }
  ) {
    const p = this.findPending(conversationId, clientMessageId);
    if (!p) return;
    if (TERMINAL_ERRORS.has(error.code) || p.attempts >= MAX_ATTEMPTS) {
      p.status = "failed";
      p.error = error.message;
    }
    this.emit();
  }

  retryFailed(conversationId: string, clientMessageId: string) {
    const p = this.findPending(conversationId, clientMessageId);
    if (!p || p.status !== "failed") return;
    p.status = "pending";
    p.attempts = 0;
    delete p.error;
    this.effects.push({ type: "transmit", pending: p });
    this.emit();
  }

  discard(conversationId: string, clientMessageId: string) {
    const c = this.conv(conversationId);
    const i = c.pending.findIndex((p) => p.clientMessageId === clientMessageId);
    if (i !== -1) c.pending.splice(i, 1);
    this.emit();
  }

  /**
   * Called once the socket is back. Everything still in an outbox goes out
   * again with its original clientMessageId -- the server's unique constraint
   * turns any that already landed into a lookup rather than a duplicate.
   */
  resumeOutbox(): PendingMessage[] {
    const resent: PendingMessage[] = [];
    for (const c of this.convs.values()) {
      for (const p of c.pending) {
        if (p.status !== "pending") continue;
        this.effects.push({ type: "transmit", pending: p });
        resent.push(p);
      }
    }
    if (resent.length) this.emit();
    return resent;
  }

  // -- internals ------------------------------------------------------------

  private findPending(conversationId: string, clientMessageId: string) {
    return this.convs
      .get(conversationId)
      ?.pending.find((p) => p.clientMessageId === clientMessageId);
  }

  private insert(c: ConversationState, m: ServerMessage) {
    if (c.byId.has(m.id)) {
      Object.assign(c.byId.get(m.id)!, m);
      return;
    }
    if (c.bySeq.has(m.seq)) return; // same seq, different id is impossible
    c.byId.set(m.id, m);
    c.bySeq.set(m.seq, m);
    const at = lowerBound(c.list, m.seq);
    c.list.splice(at, 0, m);
  }

  private recomputeContiguity(c: ConversationState) {
    if (c.list.length === 0) {
      c.contiguousUpTo = 0;
      return;
    }
    let run = Math.max(c.contiguousUpTo, c.baseSeq > 0 ? c.baseSeq - 1 : 0);
    if (!c.bySeq.has(run + 1) && c.contiguousUpTo === 0) run = c.list[0].seq - 1;
    while (c.bySeq.has(run + 1)) run++;
    c.contiguousUpTo = run;
  }

  /**
   * A gap is only ever a dropped frame, never a message that was not sent --
   * that is what gapless seq buys. Hold briefly for natural reordering, then
   * ask the server.
   */
  private checkGap(c: ConversationState) {
    const top = c.list.length ? c.list[c.list.length - 1].seq : 0;
    if (top <= c.contiguousUpTo) {
      c.gapSince = null;
      return;
    }
    const t = this.now();
    if (c.gapSince === null) {
      c.gapSince = t;
      return;
    }
    if (t - c.gapSince >= GAP_GRACE_MS) {
      c.gapSince = null;
      this.effects.push({
        type: "backfill",
        conversationId: c.id,
        afterSeq: c.contiguousUpTo,
      });
    }
  }

  /** The transport calls this on a timer to close gaps that stayed open. */
  tick() {
    for (const c of this.convs.values()) this.checkGap(c);
  }
}

function lowerBound(list: ServerMessage[], seq: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
