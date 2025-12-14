import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 10,
  iterations: 10,
};

const BASE_URL = 'http://localhost:4000';
const EVENT_ID = 1;

export default function () {
  const seat = `S${__VU}`;

  // Reserve
  let res = http.post(
    `${BASE_URL}/events/${EVENT_ID}/seats/reserve`,
    JSON.stringify({
      userId: `user-${__VU}`,
      seatCodes: [seat]
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (res.status !== 200) return;

  const holdGroupId = JSON.parse(res.body).holdGroupId;

  // Confirm
  res = http.post(
    `${BASE_URL}/events/${EVENT_ID}/seats/confirm`,
    JSON.stringify({
      userId: `user-${__VU}`,
      holdGroupId
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, { 'confirmed': r => r.status === 200 });

  // Cancel
  res = http.post(
    `${BASE_URL}/bookings/${holdGroupId}/cancel`
  );

  check(res, { 'cancelled': r => r.status === 200 });
}
