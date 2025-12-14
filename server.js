import express from 'express';
import { createClient } from 'redis';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

/* =========================
   CONFIG
========================= */
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PG_URL =
  process.env.PG_URL || 'postgres://apple:@localhost:5432/booking';
const HOLD_SECONDS = 300;

/* =========================
   REDIS
========================= */
const redis = createClient({ url: REDIS_URL });
redis.on('error', console.error);
await redis.connect();

/* =========================
   POSTGRES
========================= */
const pg = new Pool({ connectionString: PG_URL });

/* =========================
   HELPERS
========================= */
const seatKey = (eventId, seatCode) => `seat:${eventId}:${seatCode}`;
const heldCountKey = (eventId) => `event:${eventId}:held_count`;
const holdGroupKey = (groupId) => `hold:${groupId}`;

/* =========================
   LUA SCRIPTS
========================= */
const BULK_RESERVE_LUA = `
local n = tonumber(ARGV[3])

for i = 1, n do
  if redis.call("EXISTS", KEYS[i]) == 1 then
    return {err="SEAT_ALREADY_HELD"}
  end
end

for i = 1, n do
  redis.call("SET", KEYS[i], ARGV[1], "EX", ARGV[2])
end

redis.call("INCRBY", KEYS[n + 1], n)
redis.call("SET", KEYS[n + 2], ARGV[1], "EX", ARGV[2])

return "OK"
`;

/* =========================
   API: CREATE EVENT
========================= */
app.post('/events', async (req, res) => {
  const { name, date, location, totalSeats } = req.body;
  const client = await pg.connect();

  try {
    await client.query('BEGIN');

    const ev = await client.query(
      `INSERT INTO events (name, event_date, location, total_seats)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, date, location, totalSeats]
    );

    const eventId = ev.rows[0].id;

    for (let i = 1; i <= totalSeats; i++) {
      await client.query(
        `INSERT INTO seats (event_id, seat_code) VALUES ($1,$2)`,
        [eventId, `S${i}`]
      );
    }

    await client.query('COMMIT');
    await redis.set(heldCountKey(eventId), 0);

    res.json({ eventId });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Create event failed' });
  } finally {
    client.release();
  }
});

/* =========================
   API: RESERVE (1 or N)
========================= */
app.post('/events/:eventId/seats/reserve', async (req, res) => {
  const { eventId } = req.params;
  const { userId, seatCodes } = req.body;

  if (!Array.isArray(seatCodes) || seatCodes.length === 0) {
    return res.status(400).json({ error: 'seatCodes required' });
  }

  const holdGroupId = uuidv4();
  const payload = JSON.stringify({ 
    holdGroupId, 
    userId, 
    eventId: String(eventId), // Ensure it's stored as string
    seatCodes 
  });

  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    const ev = await client.query(
      `SELECT total_seats FROM events WHERE id=$1 FOR UPDATE`,
      [eventId]
    );

    if (ev.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }

    const confirmed = await client.query(
      `SELECT COUNT(*)::int FROM bookings
       WHERE event_id=$1 AND status='CONFIRMED'`,
      [eventId]
    );

    const held = parseInt(await redis.get(heldCountKey(eventId)) || '0');

    if (confirmed.rows[0].count + held + seatCodes.length > ev.rows[0].total_seats) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Not enough seats available' });
    }

    await client.query('COMMIT');

    const keys = [
      ...seatCodes.map(c => seatKey(eventId, c)),
      heldCountKey(eventId),
      holdGroupKey(holdGroupId)
    ];

    const result = await redis.eval(BULK_RESERVE_LUA, {
      keys,
      arguments: [
        payload,
        HOLD_SECONDS.toString(),
        seatCodes.length.toString()
      ]
    });

    if (result !== 'OK') return res.status(409).json({ error: result });

    res.json({ holdGroupId, expiresIn: HOLD_SECONDS });
  } finally {
    client.release();
  }
});

/* =========================
   API: CONFIRM (1 or N)
========================= */
app.post('/events/:eventId/seats/confirm', async (req, res) => {
  const { eventId } = req.params;
  const { userId, holdGroupId } = req.body;

  const raw = await redis.get(holdGroupKey(holdGroupId));
  if (!raw) return res.status(410).json({ error: 'Hold expired' });

  const group = JSON.parse(raw);
  if (group.userId !== userId) {
    return res.status(403).json({ error: 'Not owner' });
  }
  
  // Use group.eventId after validation (it's the source of truth)
  const validatedEventId = String(group.eventId);
  if (validatedEventId !== String(eventId)) {
    console.error('Event ID mismatch:', { 
      groupEventId: group.eventId, 
      groupEventIdType: typeof group.eventId,
      urlEventId: eventId, 
      urlEventIdType: typeof eventId 
    });
    return res.status(400).json({ error: 'Event ID mismatch' });
  }

  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    for (const seatCode of group.seatCodes) {
      const seat = await client.query(
        `SELECT id FROM seats WHERE event_id=$1 AND seat_code=$2`,
        [validatedEventId, seatCode]
      );

      if (seat.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Seat ${seatCode} not found` });
      }

      // Check if seat is already booked
      const existing = await client.query(
        `SELECT id FROM bookings 
         WHERE seat_id=$1 AND status='CONFIRMED' FOR UPDATE`,
        [seat.rows[0].id]
      );

      if (existing.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Seat ${seatCode} already booked` });
      }

      // Generate unique hold_id for each seat (hold_id has unique constraint)
      const uniqueHoldId = `${holdGroupId}-${seatCode}`;
      
      await client.query(
        `INSERT INTO bookings
         (event_id, seat_id, user_id, booking_group_id, hold_group_id, status, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,'CONFIRMED',now())`,
        [validatedEventId, seat.rows[0].id, userId, holdGroupId, uniqueHoldId]
      );

      await redis.del(seatKey(validatedEventId, seatCode));
    }

    await redis.decrBy(heldCountKey(validatedEventId), group.seatCodes.length);
    await redis.del(holdGroupKey(holdGroupId));

    await client.query('COMMIT');
    res.json({ success: true, bookingGroupId: holdGroupId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Confirm failed', details: err.message });
  } finally {
    client.release();
  }
});

/* =========================
   API: RELEASE (1 or N)
========================= */
app.post('/events/:eventId/seats/release', async (req, res) => {
  const { userId, holdGroupId } = req.body;

  const raw = await redis.get(holdGroupKey(holdGroupId));
  if (!raw) return res.status(404).json({ error: 'Hold not found' });

  const group = JSON.parse(raw);
  if (group.userId !== userId) {
    return res.status(403).json({ error: 'Not owner' });
  }

  for (const seatCode of group.seatCodes) {
    await redis.del(seatKey(group.eventId, seatCode));
  }

  await redis.decrBy(heldCountKey(group.eventId), group.seatCodes.length);
  await redis.del(holdGroupKey(holdGroupId));

  res.json({ released: true });
});

/* =========================
   API: CANCEL BOOKING (SOFT)
========================= */
app.post('/bookings/:bookingGroupId/cancel', async (req, res) => {
  const r = await pg.query(
    `UPDATE bookings
     SET status='CANCELLED', cancelled_at=now()
     WHERE booking_group_id=$1 AND status='CONFIRMED'
     RETURNING id`,
    [req.params.bookingGroupId]
  );

  if (!r.rowCount) return res.status(409).json({ error: 'Invalid booking' });
  res.json({ cancelled: true });
});

/* =========================
   API: VIEW BOOKING (GROUP)
========================= */
app.get('/bookings/:bookingGroupId', async (req, res) => {
  const r = await pg.query(
    `
    SELECT b.booking_group_id, b.status, b.user_id,
           e.name, e.event_date, s.seat_code
    FROM bookings b
    JOIN events e ON e.id=b.event_id
    JOIN seats s ON s.id=b.seat_id
    WHERE b.booking_group_id=$1
    `,
    [req.params.bookingGroupId]
  );

  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows);
});

/* =========================
   API: EVENT DETAILS
========================= */
app.get('/events/:eventId', async (req, res) => {
  const ev = await pg.query(
    `SELECT * FROM events WHERE id=$1`,
    [req.params.eventId]
  );

  if (ev.rowCount === 0) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const confirmed = await pg.query(
    `SELECT COUNT(*)::int FROM bookings
     WHERE event_id=$1 AND status='CONFIRMED'`,
    [req.params.eventId]
  );

  const held = parseInt(await redis.get(heldCountKey(req.params.eventId)) || '0');

  res.json({
    ...ev.rows[0],
    confirmedSeats: confirmed.rows[0].count,
    heldSeats: held,
    availableSeats:
      ev.rows[0].total_seats - confirmed.rows[0].count - held
  });
});

/* =========================
   API: TEST POSTGRES CONNECTION
========================= */
app.get('/test-pg', async (req, res) => {
  try {
    const client = await pg.connect();
    const result = await client.query('SELECT NOW() as current_time, version() as pg_version');
    client.release();
    res.json({ 
      connected: true, 
      currentTime: result.rows[0].current_time,
      version: result.rows[0].pg_version.split(' ')[0] + ' ' + result.rows[0].pg_version.split(' ')[1],
      connectionString: PG_URL.replace(/:[^:@]+@/, ':****@') // Hide password
    });
  } catch (err) {
    res.status(500).json({ 
      connected: false, 
      error: err.message,
      connectionString: PG_URL.replace(/:[^:@]+@/, ':****@')
    });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(4000, () => console.log('Booking API running on :4000'));
