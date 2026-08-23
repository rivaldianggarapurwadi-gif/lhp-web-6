"""
Two experiments against the real schema:

A. Show that ordering/backfilling by created_at can silently lose a message
   when two sends overlap -- the justification for adding messages.seq.

B. Show that the seq allocator stays gapless and correctly ordered under
   concurrent senders, and that client_message_id makes a retried send a no-op.
"""
import threading
import time
import uuid

import psycopg2

DSN = "host=/tmp/pgrun port=5433 user=claude dbname=ceko"


def conn():
    return psycopg2.connect(DSN)


def setup():
    c = conn()
    cur = c.cursor()
    cur.execute("DELETE FROM messages")
    cur.execute("DELETE FROM conversation_participants")
    cur.execute("DELETE FROM conversations")
    cur.execute("DELETE FROM users")
    admin = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO users (id, username, tag, password_hash, is_admin) "
        "VALUES (%s,'admin','ADMN23','x',true)", (admin,))
    users = []
    for i, tag in enumerate(["AAAA23", "BBBB34", "CCCC45", "DDDD56"]):
        uid = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO users (id, username, tag, password_hash, created_by) "
            "VALUES (%s,%s,%s,'x',%s)", (uid, f"user{i}", tag, admin))
        users.append(uid)
    conv = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO conversations (id, type, name, created_by) "
        "VALUES (%s,'group','test',%s)", (conv, admin))
    for uid in users:
        cur.execute(
            "INSERT INTO conversation_participants (conversation_id, user_id) "
            "VALUES (%s,%s)", (conv, uid))
    c.commit()
    c.close()
    return conv, users


def experiment_a(conv, users):
    """created_at cursor loses a message when transactions overlap."""
    print("=" * 68)
    print("A. Backfilling by created_at, with two overlapping sends")
    print("=" * 68)

    slow = conn()
    slow_cur = slow.cursor()
    slow_cur.execute("BEGIN")
    slow_cur.execute(
        "INSERT INTO messages (conversation_id, sender_id, content, seq) "
        "VALUES (%s,%s,'FIRST (slow txn)', 1) RETURNING id, created_at",
        (conv, users[0]))
    slow_id, slow_ts = slow_cur.fetchone()
    print(f"  t0  sender A opens a transaction, INSERT gets created_at={slow_ts.time()}")

    time.sleep(0.05)

    fast = conn()
    fast_cur = fast.cursor()
    fast_cur.execute(
        "INSERT INTO messages (conversation_id, sender_id, content, seq) "
        "VALUES (%s,%s,'SECOND (fast txn)', 2) RETURNING id, created_at",
        (conv, users[1]))
    fast_id, fast_ts = fast_cur.fetchone()
    fast.commit()
    print(f"  t1  sender B inserts and COMMITS,      created_at={fast_ts.time()}")

    # A client reconnects here and backfills. It sees only the committed row.
    reader = conn()
    rcur = reader.cursor()
    rcur.execute(
        "SELECT content, created_at FROM messages WHERE conversation_id=%s "
        "ORDER BY created_at", (conv,))
    visible = rcur.fetchall()
    print(f"  t2  client syncs, sees {len(visible)} message(s): "
          f"{[v[0] for v in visible]}")
    cursor_ts = max(v[1] for v in visible)
    print(f"      client stores cursor = {cursor_ts.time()}")

    slow.commit()
    print(f"  t3  sender A's transaction finally COMMITS")

    rcur.execute(
        "SELECT content FROM messages WHERE conversation_id=%s "
        "AND created_at > %s ORDER BY created_at", (conv, cursor_ts))
    missed = rcur.fetchall()
    print(f"  t4  client polls 'created_at > cursor' -> {[m[0] for m in missed]}")

    rcur.execute(
        "SELECT content, created_at, seq FROM messages WHERE conversation_id=%s "
        "ORDER BY seq", (conv,))
    every = rcur.fetchall()
    print()
    print("      What is actually in the table now:")
    for content, ts, seq in every:
        marker = "  <-- never delivered" if ts <= cursor_ts and content == "FIRST (slow txn)" else ""
        print(f"        seq={seq}  created_at={ts.time()}  {content}{marker}")

    print()
    print("      FIRST committed after the cursor was taken, but its created_at")
    print("      is BEFORE it -- so 'created_at > cursor' skips it permanently.")

    slow.close(); fast.close(); reader.close()
    print()

    # ---- A2: the same race, but both senders go through the allocator -------
    print("-" * 68)
    print("A2. Same overlap, but seq is allocated via UPDATE conversations")
    print("-" * 68)

    c = conn(); cur = c.cursor()
    cur.execute("DELETE FROM messages WHERE conversation_id=%s", (conv,))
    cur.execute("UPDATE conversations SET last_seq=0 WHERE id=%s", (conv,))
    c.commit(); c.close()

    slow = conn(); slow_cur = slow.cursor()
    slow_cur.execute("BEGIN")
    slow_cur.execute(
        "UPDATE conversations SET last_seq = last_seq + 1 WHERE id=%s "
        "RETURNING last_seq", (conv,))
    s_seq = slow_cur.fetchone()[0]
    slow_cur.execute(
        "INSERT INTO messages (conversation_id, sender_id, content, seq) "
        "VALUES (%s,%s,'FIRST (slow txn)',%s)", (conv, users[0], s_seq))
    print(f"  t0  sender A takes the row lock, gets seq={s_seq}, stays open")

    state = {}

    def second_sender():
        cn = conn(); cu = cn.cursor()
        t_start = time.time()
        cu.execute("BEGIN")
        cu.execute(
            "UPDATE conversations SET last_seq = last_seq + 1 WHERE id=%s "
            "RETURNING last_seq", (conv,))
        state["waited"] = time.time() - t_start
        state["seq"] = cu.fetchone()[0]
        cu.execute(
            "INSERT INTO messages (conversation_id, sender_id, content, seq) "
            "VALUES (%s,%s,'SECOND (fast txn)',%s)", (conv, users[1], state["seq"]))
        cn.commit(); cn.close()

    th = threading.Thread(target=second_sender)
    th.start()
    time.sleep(0.4)
    print(f"  t1  sender B tries to allocate -- still blocked after 400 ms: "
          f"{th.is_alive()}")

    reader = conn(); rcur = reader.cursor()
    rcur.execute(
        "SELECT count(*) FROM messages WHERE conversation_id=%s", (conv,))
    print(f"  t2  a client syncing right now sees {rcur.fetchone()[0]} message(s) "
          f"-- no seq to skip past")

    slow.commit()
    th.join()
    print(f"  t3  sender A commits; sender B unblocks after "
          f"{state['waited']*1000:.0f} ms with seq={state['seq']}")

    rcur.execute(
        "SELECT seq, content FROM messages WHERE conversation_id=%s ORDER BY seq",
        (conv,))
    rows = rcur.fetchall()
    print(f"  t4  final: {[(s, c) for s, c in rows]}")
    print()
    print("      B could not commit ahead of A, so no client can ever observe")
    print("      seq=2 while seq=1 is still invisible. That is what makes")
    print("      'WHERE seq > cursor' a safe backfill and created_at not one.")

    slow.close(); reader.close()
    print()


def experiment_b(conv, users):
    """Concurrent senders through the seq allocator."""
    print("=" * 68)
    print("B. 40 concurrent sends through the last_seq allocator")
    print("=" * 68)

    c = conn(); cur = c.cursor()
    cur.execute("DELETE FROM messages WHERE conversation_id=%s", (conv,))
    cur.execute("UPDATE conversations SET last_seq=0 WHERE id=%s", (conv,))
    c.commit(); c.close()

    errors = []
    barrier = threading.Barrier(40)

    def send(n):
        try:
            cn = conn()
            cu = cn.cursor()
            barrier.wait()
            cu.execute("BEGIN")
            cu.execute(
                "UPDATE conversations SET last_seq = last_seq + 1, "
                "last_message_at = now() WHERE id=%s RETURNING last_seq", (conv,))
            seq = cu.fetchone()[0]
            cu.execute(
                "INSERT INTO messages (conversation_id, sender_id, content, seq, "
                "client_message_id) VALUES (%s,%s,%s,%s,%s)",
                (conv, users[n % 4], f"msg {n}", seq, str(uuid.uuid4())))
            cn.commit()
            cn.close()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=send, args=(i,)) for i in range(40)]
    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.time() - t0

    c = conn(); cur = c.cursor()
    cur.execute(
        "SELECT count(*), min(seq), max(seq), count(DISTINCT seq) "
        "FROM messages WHERE conversation_id=%s", (conv,))
    n, lo, hi, distinct = cur.fetchone()
    cur.execute("SELECT last_seq FROM conversations WHERE id=%s", (conv,))
    last_seq = cur.fetchone()[0]

    print(f"  errors={len(errors)}  rows={n}  seq range={lo}..{hi}  "
          f"distinct seq={distinct}  conversations.last_seq={last_seq}")
    print(f"  gapless: {distinct == n == hi == last_seq and lo == 1}   "
          f"({elapsed*1000:.0f} ms wall for 40 serialised inserts)")

    # Ordering: seq order must match commit order, i.e. must be consistent
    # with created_at never going backwards by more than txn overlap.
    cur.execute(
        "SELECT seq, created_at FROM messages WHERE conversation_id=%s "
        "ORDER BY seq", (conv,))
    rows = cur.fetchall()
    inversions = sum(
        1 for i in range(1, len(rows)) if rows[i][1] < rows[i - 1][1])
    print(f"  created_at inversions within seq order: {inversions}"
          f"   <-- why created_at is not the sort key")

    print()
    print("  Retrying a send with the same client_message_id:")
    cmid = str(uuid.uuid4())
    cur.execute("BEGIN")
    cur.execute(
        "UPDATE conversations SET last_seq = last_seq + 1 WHERE id=%s "
        "RETURNING last_seq", (conv,))
    seq = cur.fetchone()[0]
    cur.execute(
        "INSERT INTO messages (conversation_id, sender_id, content, seq, "
        "client_message_id) VALUES (%s,%s,'retry me',%s,%s) RETURNING id",
        (conv, users[0], seq, cmid))
    first_id = cur.fetchone()[0]
    c.commit()
    print(f"    first attempt  -> inserted id={str(first_id)[:8]} seq={seq}")

    try:
        cur.execute("BEGIN")
        cur.execute(
            "UPDATE conversations SET last_seq = last_seq + 1 WHERE id=%s "
            "RETURNING last_seq", (conv,))
        seq2 = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO messages (conversation_id, sender_id, content, seq, "
            "client_message_id) VALUES (%s,%s,'retry me',%s,%s)",
            (conv, users[0], seq2, cmid))
        c.commit()
        print("    second attempt -> INSERTED AGAIN (bad)")
    except psycopg2.errors.UniqueViolation as exc:
        c.rollback()
        print(f"    second attempt -> rejected by {exc.diag.constraint_name}")
        cur.execute(
            "SELECT id, seq FROM messages WHERE conversation_id=%s "
            "AND client_message_id=%s", (conv, cmid))
        row = cur.fetchone()
        print(f"    server re-reads and acks the original: "
              f"id={str(row[0])[:8]} seq={row[1]}")
        cur.execute("SELECT last_seq FROM conversations WHERE id=%s", (conv,))
        print(f"    rolled-back seq was not consumed, last_seq still "
              f"{cur.fetchone()[0]}  <-- gapless survives the retry")

    cur.execute(
        "SELECT count(*) FROM messages WHERE conversation_id=%s "
        "AND client_message_id=%s", (conv, cmid))
    print(f"    rows with that client_message_id: {cur.fetchone()[0]}")
    c.close()
    print()


if __name__ == "__main__":
    conv, users = setup()
    experiment_a(conv, users)
    experiment_b(conv, users)
