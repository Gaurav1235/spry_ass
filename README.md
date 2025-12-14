# Event Seat Booking API

A high-performance event seat booking system built with Node.js, Express, PostgreSQL, and Redis. This system handles concurrent seat reservations with a 5-minute hold mechanism, ensuring data consistency and preventing double-booking.

## Features

- **Event Management**: Create events with configurable seat capacity
- **Bulk Seat Reservation**: Reserve multiple seats in a single transaction
- **Temporary Holds**: 5-minute hold period for seats before confirmation
- **Atomic Operations**: Uses Redis Lua scripts and PostgreSQL transactions for data consistency
- **Concurrent Safety**: Prevents race conditions and double-booking
- **Soft Cancellation**: Cancel confirmed bookings without data deletion
- **Real-time Availability**: Track confirmed, held, and available seats

## Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js 5.2
- **Database**: PostgreSQL 8.16+
- **Cache/Queue**: Redis 5.10+
- **UUID Generation**: uuid 13.0+

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v14.8+ for top-level await support)
- **PostgreSQL** (v12+)
- **Redis** (v6+)

## Setup Instructions

### 1. Clone the Repository

```bash
git clone <repository-url>
cd "Spry Assessment"
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Database Setup

Create a PostgreSQL database and run the following schema:

```sql
-- Create database
CREATE DATABASE booking;

-- Connect to the database
\c booking

-- Events table
CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    event_date TIMESTAMP NOT NULL,
    location VARCHAR(255) NOT NULL,
    total_seats INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Seats table
CREATE TABLE seats (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    seat_code VARCHAR(50) NOT NULL,
    UNIQUE(event_id, seat_code)
);

-- Bookings table
CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id),
    seat_id INTEGER NOT NULL REFERENCES seats(id),
    user_id VARCHAR(255) NOT NULL,
    booking_group_id VARCHAR(255) NOT NULL,
    hold_group_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'CONFIRMED',
    confirmed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_bookings_event_id ON bookings(event_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_group_id ON bookings(booking_group_id);
```

### 4. Configure Environment Variables

Create a `.env` file (optional) or set environment variables:

```bash
# PostgreSQL connection string
export PG_URL="postgres://username:password@localhost:5432/booking"

# Redis connection URL
export REDIS_URL="redis://localhost:6379"

# Server port (default: 4000)
export PORT=4000
```

**Default values** (if not set):
- `PG_URL`: `postgres://apple:@localhost:5432/booking`
- `REDIS_URL`: `redis://localhost:6379`
- `PORT`: `4000`

### 5. Start Services

#### Start PostgreSQL
```bash
# macOS (Homebrew)
brew services start postgresql

# Linux
sudo systemctl start postgresql

# Or use Docker
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=password postgres
```

#### Start Redis
```bash
# macOS (Homebrew)
brew services start redis

# Linux
sudo systemctl start redis

# Or use Docker
docker run -d -p 6379:6379 redis
```

### 6. Start the Server

```bash
node server.js
```

You should see:
```
Booking API running on :4000
```

## API Documentation

### Base URL
```
http://localhost:4000
```

### Endpoints

#### 1. Create Event
Create a new event with seats.

**POST** `/events`

**Request Body:**
```json
{
  "name": "Coldplay Concert",
  "date": "2025-01-10T18:00:00.000Z",
  "location": "Mumbai",
  "totalSeats": 500
}
```

**Response:**
```json
{
  "eventId": 1
}
```

#### 2. Get Event Details
Get event information with seat availability.

**GET** `/events/:eventId`

**Response:**
```json
{
  "id": 1,
  "name": "Coldplay Concert",
  "event_date": "2025-01-10T18:00:00.000Z",
  "location": "Mumbai",
  "total_seats": 500,
  "confirmedSeats": 10,
  "heldSeats": 5,
  "availableSeats": 485
}
```

#### 3. Reserve Seats
Reserve one or multiple seats (5-minute hold).

**POST** `/events/:eventId/seats/reserve`

**Request Body:**
```json
{
  "userId": "user123",
  "seatCodes": ["S1", "S2", "S3"]
}
```

**Response:**
```json
{
  "holdGroupId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 300
}
```

**Error Responses:**
- `400`: Invalid input (seatCodes required)
- `409`: Not enough seats available or seat already held

#### 4. Confirm Booking
Confirm a reservation and create permanent booking.

**POST** `/events/:eventId/seats/confirm`

**Request Body:**
```json
{
  "userId": "user123",
  "holdGroupId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "success": true,
  "bookingGroupId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error Responses:**
- `400`: Event ID mismatch
- `403`: Not owner of the hold
- `404`: Seat not found
- `409`: Seat already booked
- `410`: Hold expired

#### 5. Release Hold
Cancel a reservation before confirmation.

**POST** `/events/:eventId/seats/release`

**Request Body:**
```json
{
  "userId": "user123",
  "holdGroupId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response:**
```json
{
  "released": true
}
```

#### 6. Cancel Booking
Soft cancel a confirmed booking.

**POST** `/bookings/:bookingGroupId/cancel`

**Response:**
```json
{
  "cancelled": true
}
```

#### 7. View Booking
Get details of a booking group.

**GET** `/bookings/:bookingGroupId`

**Response:**
```json
[
  {
    "booking_group_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "CONFIRMED",
    "user_id": "user123",
    "name": "Coldplay Concert",
    "event_date": "2025-01-10T18:00:00.000Z",
    "seat_code": "S1"
  },
  {
    "booking_group_id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "CONFIRMED",
    "user_id": "user123",
    "name": "Coldplay Concert",
    "event_date": "2025-01-10T18:00:00.000Z",
    "seat_code": "S2"
  }
]
```

#### 8. Test PostgreSQL Connection
Test the database connection.

**GET** `/test-pg`

**Response:**
```json
{
  "connected": true,
  "currentTime": "2025-01-10T12:00:00.000Z",
  "version": "PostgreSQL 15.0",
  "connectionString": "postgres://user:****@localhost:5432/booking"
}
```

## Architecture & Design Decisions

### Data Consistency

1. **Redis for Temporary Holds**: Seats are held in Redis with a 5-minute TTL (Time To Live)
2. **PostgreSQL for Permanent Bookings**: Confirmed bookings are stored in PostgreSQL
3. **Atomic Operations**: 
   - Redis Lua scripts ensure atomic bulk reservations
   - PostgreSQL transactions ensure booking consistency
4. **Race Condition Prevention**: 
   - `FOR UPDATE` locks in PostgreSQL prevent concurrent modifications
   - Redis `SET NX` (set if not exists) prevents duplicate holds

### Hold Mechanism

- **Hold Duration**: 300 seconds (5 minutes)
- **Automatic Expiry**: Redis TTL automatically releases expired holds
- **Group Holds**: Multiple seats can be reserved together with a single `holdGroupId`
- **Safe Release**: Lua script ensures only the owner can release their hold

### Error Handling

- Comprehensive error messages for debugging
- Proper HTTP status codes
- Transaction rollback on failures
- Connection error logging

## Testing

### Manual Testing with cURL

```bash
# Create an event
curl -X POST http://localhost:4000/events \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Event",
    "date": "2025-01-10T18:00:00.000Z",
    "location": "Test Venue",
    "totalSeats": 100
  }'

# Get event details
curl http://localhost:4000/events/1

# Reserve seats
curl -X POST http://localhost:4000/events/1/seats/reserve \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user1",
    "seatCodes": ["S1", "S2"]
  }'

# Confirm booking (use holdGroupId from previous response)
curl -X POST http://localhost:4000/events/1/seats/confirm \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user1",
    "holdGroupId": "YOUR_HOLD_GROUP_ID"
  }'
```

### Load Testing with k6

A k6 test script is provided in `test.js`. Install k6 and run:

```bash
# Install k6 (macOS)
brew install k6

# Run load test
k6 run test.js
```

## Project Structure

```
.
├── server.js          # Main application file
├── test.js            # k6 load testing script
├── package.json       # Dependencies and configuration
├── package-lock.json  # Locked dependency versions
└── README.md          # This file
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PG_URL` | PostgreSQL connection string | `postgres://apple:@localhost:5432/booking` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `PORT` | Server port | `4000` |

## Troubleshooting

### PostgreSQL Connection Issues

1. Verify PostgreSQL is running:
   ```bash
   psql -l
   ```

2. Test connection:
   ```bash
   curl http://localhost:4000/test-pg
   ```

3. Check connection string format:
   ```
   postgres://username:password@host:port/database
   ```

### Redis Connection Issues

1. Verify Redis is running:
   ```bash
   redis-cli ping
   # Should return: PONG
   ```

2. Check Redis URL format:
   ```
   redis://localhost:6379
   ```

### Port Already in Use

If port 4000 is already in use:

```bash
# Find process using port 4000
lsof -ti:4000

# Kill the process
kill -9 $(lsof -ti:4000)

# Or use a different port
PORT=3000 node server.js
```

## License

This project is part of a technical assessment.

## Author

Developed as part of the Spry Assessment.
