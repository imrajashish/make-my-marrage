# Make My Marriage
## System Design Document

**Version:** V1  
**Status:** Draft for Review  
**Document Type:** System Design  
**Based On:** Product Requirements Document V1  
**Date:** 2 October 2026

---

# 1. System Overview

## 1.1 Purpose

This document translates the Make My Marriage PRD (V1) into a technical design: architecture, technology choices, data model, API surface, security model, infrastructure and implementation plan.

The PRD defines **what** the product does. This document defines **how** it is built.

## 1.2 Scope

All V1 features in PRD Section 9 are in scope:

- Authentication and wedding creation
- Wedding members (Admin, Manager)
- Events, tasks, guests
- Event-level invitations, RSVP, email, WhatsApp sharing
- Expenses, vendors, vendor discovery
- Wedding website and themes
- Photo gallery, guest upload, albums, QR code
- YouTube livestream
- Settings and dashboard

## 1.3 Deployment Context

The first deployment is the owner's own wedding:

- One wedding
- Approximately **100 guests**
- A small group of Wedding Members

The system is nevertheless designed as **multi-tenant** (every record belongs to a `Wedding`) because PRD Rule 5 and PRD Section 13 require strict cross-wedding isolation. This costs almost nothing now and avoids a rewrite if the product is later opened to other families.

## 1.4 Design Philosophy

> **Boring, managed, minimal moving parts.**

Every component should be a managed service, every request should be handled by one deployable application, and anything that can be deferred (queues, caches, workers, monitoring platforms) is deferred.

---

# 2. Design Goals and Constraints

## 2.1 Goals

1. Ship V1 incrementally following the PRD phases.
2. Keep the system operable by one developer.
3. Keep guest experiences fast on mobile networks.
4. Keep wedding data private and isolated per wedding.
5. Keep running cost near zero at ~100 guests.
6. Keep module boundaries clean enough to extract services later if ever needed.

## 2.2 Confirmed Decisions

| Area | Decision |
|---|---|
| Architecture | Modular monolith |
| Language | TypeScript |
| Frontend | Next.js |
| Backend | Next.js Route Handlers (REST) |
| Database | MongoDB Atlas |
| ODM | Mongoose |
| Validation | Zod |
| Authentication | Simple cookie sessions for members, token links for guests |
| Email verification | Not required at signup |
| File storage | Cloudflare R2 |
| CDN | Cloudflare |
| Email | Resend (batch sending) |
| Hosting | Vercel |
| QR code | Generated on demand, simple |
| RSVP model | Per event |
| Event location | Latitude / longitude shared with guests |
| Guest scale | ~100 guests |
| Media | Photos only, no video |
| Caching / Redis | Not used |
| Monitoring | Basic application logs only |

## 2.3 Constraints

- No long-running processes (Vercel serverless functions).
- Request body limit on serverless functions is small, so photos never pass through the application server.
- Resend free plan: 100 emails/day and 3,000/month, with each recipient counted separately.
- Guests must never create accounts.

---

# 3. Technical Non-Goals

V1 will NOT include:

- Microservices
- Message queues or background workers
- Redis or any cache layer
- Server-side image processing
- Real-time updates (WebSockets, SSE)
- External authentication providers or auth libraries
- Email verification
- Video upload
- Custom domains for wedding websites
- APM, tracing or error-tracking platforms
- WhatsApp or SMS API integrations
- Multi-region deployment

These map directly to the PRD non-goals and the decisions in Section 2.2. Section 20 lists how each could be added later.

---

# 4. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict mode) | Shared types between client and server |
| Framework | Next.js (App Router) | UI, public pages and API in one project |
| API style | REST Route Handlers under `/api` | JSON in, JSON out |
| Database | MongoDB Atlas | Region `ap-south-1` (Mumbai) |
| ODM | Mongoose | Schemas, indexes, transactions |
| Validation | Zod | One schema per DTO, also used to validate environment variables |
| Auth | Custom cookie sessions stored in MongoDB | See Section 7 |
| Password hashing | `@node-rs/argon2` | Prebuilt binaries work on Vercel; `bcryptjs` as fallback |
| Object storage | Cloudflare R2 | S3-compatible API |
| CDN | Cloudflare | Custom media domain bound to R2 |
| Email | Resend | Batch API |
| QR | `qrcode` | SVG / PNG on demand |
| Hosting | Vercel | Function region `bom1` |
| Client image resize | Canvas / `browser-image-compression` | Replaces server-side image processing |
| Vendor discovery | Google Places API (New) | Phase 4, proxied through the server |
| Styling | Tailwind CSS | Suggested, not yet confirmed |
| Testing | Vitest, `mongodb-memory-server`, Playwright | See Section 17 |

---

# 5. Architecture Overview

## 5.1 Architectural Style

A **modular monolith**: one repository, one Next.js application, one deployment. Business capabilities are separated into modules with explicit boundaries (Section 6).

## 5.2 System Context

```text
        Wedding Members / Guests (mobile + desktop browsers)
                          |
                          | HTTPS
                          v
   +--------------------------------------------------+
   | Vercel (region bom1)                             |
   |                                                  |
   |  Next.js application                             |
   |   - Pages: dashboard, invite, gallery, website   |
   |   - Route Handlers: /api/*                       |
   |   - Modules: services + repositories             |
   +-------+-----------------+---------------+--------+
           |                 |               |
           v                 v               v
     MongoDB Atlas     Cloudflare R2       Resend
     (ap-south-1)      + CDN (media.*)     (email)
                            ^
                            | direct upload (presigned PUT)
                       Browser

   Optional (Phase 4): Google Places API via server proxy
```

## 5.3 Key Request Flows

### Member request

```text
Browser -> /api/... (cookie)
  -> resolve session -> resolve membership {userId, weddingId, role}
  -> Zod validation
  -> service -> repository (always scoped by weddingId)
  -> JSON response
```

### Guest RSVP

```text
Guest opens /invite/{token}
  -> server resolves guest by token, returns wedding + invited events
Guest submits RSVP
  -> PUT /api/public/invite/{token}/rsvp
  -> validate events and counts against guest.maxGuests
  -> update guest.invitations + guest.rsvpSummary
```

### Guest photo upload

```text
Browser resizes photo (display + thumbnail)
  -> POST /api/public/gallery/{token}/uploads   (server returns presigned PUT URLs)
  -> Browser PUTs files directly to R2
  -> POST .../uploads/{photoId}/complete        (server verifies object, marks ready)
  -> Gallery fetches thumbnails from media CDN
```

## 5.4 Why No Worker or Queue

For ~100 guests, every operation fits inside a single request:

- A full email batch is one Resend API call.
- Photo resizing happens in the uploader's browser.
- Upload verification is a HEAD plus a tiny ranged GET.

Introducing a queue would add infrastructure with no user-visible benefit. Section 20 describes the trigger points for adding one.

---

# 6. Code Structure

## 6.1 Project Layout

```text
src/
  app/                          Next.js App Router
    (auth)/                     login, signup, forgot-password, reset-password
    (app)/                      dashboard, events, tasks, guests, expenses,
                                vendors, website, photos, livestream, settings
    invite/[token]/             guest invitation + RSVP        (public)
    g/[token]/                  guest gallery + upload          (public)
    w/[slug]/                   wedding website                 (public)
    join/[token]/               accept wedding member invite
    api/                        Route Handlers
  modules/
    auth/  weddings/  members/  events/  tasks/  guests/  invitations/
    expenses/  vendors/  website/  gallery/  livestream/  dashboard/
      <module>.model.ts         Mongoose schema
      <module>.repository.ts    all database access for the module
      <module>.service.ts       business rules
      <module>.dto.ts           Zod schemas + inferred types
  lib/
    db.ts  session.ts  http.ts  errors.ts  logger.ts  env.ts
    tokens.ts  rate-limit.ts  dates.ts  money.ts  geo.ts
    r2.ts  resend.ts  qr.ts
  components/
```

## 6.2 Layering Rules

1. **Route Handlers are thin.** Authenticate, validate with Zod, call a service, return JSON.
2. **Services own business rules.** They never touch Mongoose models directly.
3. **Repositories own database access.** Every repository function takes `weddingId` as its first argument. There is no unscoped `findById`.
4. **Modules communicate through services only.** A module never imports another module's repository or model. This is enforced with an ESLint boundaries rule.
5. **Shared schemas.** Zod DTOs are used by both client forms and server handlers.

## 6.3 Request Helpers

```text
withMember({ minRole })   resolves session + membership, injects { userId, weddingId, role }
withPublic()              no auth; used for token-based guest endpoints
parseBody(schema)         Zod validation, throws AppError(400) with field details
AppError(code, status)    mapped to the error response format in Section 10.2
```

---

# 7. Authentication and Session Design

## 7.1 Principles

- Members authenticate with **email + password** and receive a **cookie session**.
- Guests never authenticate. They hold unguessable **tokens** in their links.
- No email verification. Signup is name, email and password.

## 7.2 Signup and Onboarding Flow

```text
Signup (name, email, password)
  -> session created
  -> if arrived via a member invite link: accept invite -> join that wedding
  -> else: "Create a wedding" or "Join with an invite link"
```

A user without a membership can only access the onboarding screens. Rule 1 (one user, one wedding) is enforced by a unique index on `memberships.userId`.

## 7.3 Sessions

- Collection `sessions`: `{ tokenHash, userId, createdAt, lastUsedAt, expiresAt }` with a **TTL index** on `expiresAt`.
- The cookie holds a random 32-byte token (base64url). Only its **SHA-256 hash** is stored.
- Cookie: `__Host-mmm_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- Expiry: 30 days, sliding. `lastUsedAt` is refreshed at most once per day to avoid a database write on every request.
- Logout deletes the session row. Password reset deletes all of the user's sessions.
- Membership is looked up **per request**, so removing a member or changing a role takes effect immediately. The role is never stored in the cookie.

## 7.4 Passwords

- Hashed with argon2id (`@node-rs/argon2`).
- Minimum length 8, validated by Zod.
- Emails are lowercased and trimmed; uniqueness enforced by a unique index.

## 7.5 Password Reset

- `POST /api/auth/forgot-password` always returns success (no account enumeration).
- A reset token (random, hashed at rest, 1 hour TTL, single use) is emailed through Resend.
- `POST /api/auth/reset-password` sets the new password and invalidates all sessions.

## 7.6 Wedding Member Invites

- Admin creates an invite: `{ role, optional label/email }`.
- The server returns a one-time link `/join/{token}`. The token is stored **hashed**, so the link is shown only at creation time.
- Primary delivery is **Copy link** or **Share on WhatsApp**. Email via Resend is optional.
- Invites expire after 7 days (TTL index) and can be revoked.
- **The token is the credential.** Because emails are unverified, the invite is not matched against the signup email.
- Accepting requires being logged in (signup first if needed). Acceptance creates the membership and marks the invite used.
- If the user already belongs to a wedding, acceptance is rejected (Rule 1).

## 7.7 CSRF

- `SameSite=Lax` cookies.
- Mutating handlers also verify that the `Origin` header matches the application origin.

---

# 8. Authorization and Tenancy

## 8.1 Role Matrix

| Capability | Admin | Manager | Guest (token) |
|---|---|---|---|
| Edit wedding details | Yes | Yes | No |
| Invite / remove members, change roles | **Yes** | No | No |
| Events, tasks, guests | Yes | Yes | No |
| Send invitations and reminders | Yes | Yes | No |
| Expenses, vendors, vendor discovery | Yes | Yes | No |
| Website, gallery settings, livestream | Yes | Yes | No |
| Upload / delete / download photos | Yes | Yes | No |
| View own invitation and RSVP | No | No | Yes (own link) |
| View and upload gallery photos | Yes | Yes | Yes (gallery link) |

Managers may list members by name for task assignment (`GET /api/members/assignees`), but cannot see or change member administration.

## 8.2 Tenant Isolation

1. `weddingId` is **always derived from the session**, never accepted from request bodies, queries or paths.
2. Repository functions require `weddingId` as their first argument and include it in every query.
3. Access to another wedding's resource returns **404**, not 403, so existence is not leaked.
4. Compound indexes lead with `weddingId`.
5. A cross-wedding test matrix covers every member route (Section 17).

## 8.3 Wedding Member Invariants

- A wedding must never have zero Admins. Removing or demoting the last Admin fails with `409`. The check and the write run in a **MongoDB transaction**.
- Removing a member also unassigns their tasks (`tasks.assigneeUserId` set to null).
- A removed user simply has no membership; they may create or join another wedding.

## 8.4 Guest Access

- Invitation link `/invite/{token}` grants access to **one guest's** invitation only.
- Gallery link `/g/{token}` grants access to **one wedding's** gallery only.
- Both tokens are 128-bit random values (see Section 12).

---

# 9. Data Model

## 9.1 Conventions

| Topic | Convention |
|---|---|
| IDs | MongoDB `ObjectId` internally, strings in the API |
| Tenancy | Every wedding-owned document has `weddingId` |
| Timestamps | `createdAt`, `updatedAt` on every collection (Mongoose `timestamps`) |
| Dates | Date-only values stored as `"YYYY-MM-DD"` strings; times as `"HH:mm"` strings |
| Timezone | `weddings.timezone` (IANA, default `Asia/Kolkata`); countdowns computed in that timezone |
| Money | Integer **paise** (never floats); formatted with `Intl.NumberFormat('en-IN')` |
| Coordinates | Plain `lat` / `lng` numbers; validated `-90..90` and `-180..180` |
| Tokens | Random bytes, base64url, generated with `crypto.randomBytes` |
| Deletes | Hard delete; destructive actions that affect other records show an impact preview first |

Wedding "day" values are never stored as UTC instants. This avoids off-by-one date bugs.

## 9.2 Relationship Overview

```text
User
  |
Membership (unique per user)
  |
Wedding
  |
  +-- MemberInvites
  +-- Events
  +-- Tasks            (-> assignee User, -> Event?)
  +-- Guests
  |     +-- invitations[]   one entry per invited Event, each with its own RSVP
  +-- Vendors          (-> Events[])
  +-- Expenses         (-> Event?, -> Vendor?)
  +-- Photos           (-> Event?)
  +-- website, gallery, livestream   (embedded in Wedding)
```

## 9.3 Collections

### users

| Field | Type | Notes |
|---|---|---|
| name | string | |
| email | string | lowercase, **unique** |
| passwordHash | string | argon2id |

### sessions

| Field | Type | Notes |
|---|---|---|
| tokenHash | string | SHA-256, **unique** |
| userId | ObjectId | |
| lastUsedAt | Date | |
| expiresAt | Date | **TTL index** |

### passwordResets

| Field | Type | Notes |
|---|---|---|
| tokenHash | string | unique |
| userId | ObjectId | |
| usedAt | Date? | |
| expiresAt | Date | **TTL index**, 1 hour |

### weddings

| Field | Type | Notes |
|---|---|---|
| brideName, groomName | string | required |
| title | string? | optional |
| description | string? | optional |
| date | string | `YYYY-MM-DD` |
| timezone | string | default `Asia/Kolkata` |
| location | `{ city, lat?, lng? }` | city required; coordinates optional |
| coverImage | `{ key }`? | R2 key |
| slug | string | **unique**, used for `/w/{slug}` |
| galleryToken | string | **unique**, used for `/g/{token}` and the QR code |
| gallery | `{ enabled, guestUploadEnabled, maxPhotos }` | `guestUploadEnabled` defaults to `false` |
| website | `{ theme, published, welcomeMessage }` | theme: `classic_indian`, `minimal_elegant`, `modern_celebration` |
| livestream | `{ url?, youtubeVideoId? }` | |
| createdBy | ObjectId | |

Website, gallery and livestream settings are one-to-one with the wedding and always read together, so they are **embedded**.

### memberships

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| userId | ObjectId | **unique** (enforces Rule 1) |
| role | `admin` \| `manager` | |
| invitedBy | ObjectId? | |

### memberInvites

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| role | `admin` \| `manager` | |
| label | string? | name or email, display only |
| tokenHash | string | **unique** |
| createdBy | ObjectId | |
| acceptedAt, acceptedBy | Date?, ObjectId? | |
| expiresAt | Date | **TTL index**, 7 days |

### events

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| name | string | |
| type | enum | `roka`, `engagement`, `mehendi`, `haldi`, `sangeet`, `cocktail`, `wedding`, `reception`, `custom` |
| date | string | `YYYY-MM-DD` |
| startTime, endTime | string? | `HH:mm` |
| venueName, address | string? | |
| lat, lng | number? | shared with guests as a map link |
| description, dressCode | string? | |
| coverImage | `{ key }`? | |

An event may fall after the primary wedding date and may have no venue; neither is validated against.

### tasks

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| title | string | |
| description | string? | |
| assigneeUserId | ObjectId? | must be a current member |
| eventId | ObjectId? | |
| dueDate | string? | `YYYY-MM-DD` |
| priority | `low` \| `medium` \| `high` | |
| status | `todo` \| `in_progress` \| `completed` | |
| completedAt | Date? | |

### guests

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| name | string | |
| email, phone | string? | both optional |
| maxGuests | integer | at least 1 |
| invitations | array | one entry per invited event (below) |
| rsvpSummary | `pending` \| `attending` \| `not_attending` | denormalised, see below |
| inviteToken | string | **unique**, 128-bit random |
| invite | object | delivery and view tracking (below) |
| notes | string? | |

`invitations[]` entry:

| Field | Type | Notes |
|---|---|---|
| eventId | ObjectId | |
| status | `pending` \| `attending` \| `not_attending` | |
| attendingCount | integer | 0 unless attending; at most `maxGuests` |
| respondedAt | Date? | |

`invite` object:

| Field | Type | Notes |
|---|---|---|
| emailSentAt, lastEmailSentAt | Date? | |
| emailSendCount | integer | |
| lastReminderAt | Date? | |
| whatsappSharedAt | Date? | |
| firstViewedAt, lastViewedAt | Date? | set by a client beacon, never by crawlers |
| viewCount | integer | |

**Per-event RSVP.** A guest represents one invitation (PRD 9.7), but responds per event, so a family can attend the Sangeet and skip the Haldi.

**`rsvpSummary` is derived and stored** on every RSVP or invitation change so it can be indexed and filtered:

- `pending` if any invited event is still pending
- `attending` if at least one event is attending and none are pending
- `not_attending` if all invited events are declined

A guest with no invited events is `pending` until events are assigned.

### vendors

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| name | string | |
| category | enum | `photographer`, `videographer`, `venue`, `caterer`, `decorator`, `dj`, `makeup_artist`, `mehendi_artist`, `pandit`, `choreographer`, `florist`, `wedding_planner`, `transport`, `other` |
| contactPerson, phone, email, address, website | string? | |
| totalAgreedCostPaise | integer? | |
| eventIds | ObjectId[] | |
| notes | string? | |
| source | `{ type: manual \| discovery, placeId? }` | |

### expenses

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| title | string | |
| amountPaise | integer | non-negative |
| date | string | `YYYY-MM-DD` |
| category | enum | `venue`, `catering`, `photography`, `videography`, `decoration`, `clothing`, `jewellery`, `entertainment`, `invitations`, `gifts`, `travel`, `makeup`, `miscellaneous` |
| eventId, vendorId | ObjectId? | both optional and independent |
| notes | string? | |

### photos

| Field | Type | Notes |
|---|---|---|
| weddingId | ObjectId | |
| eventId | ObjectId? | null means "Other / Wedding Memories" |
| status | `pending` \| `ready` | |
| keys | `{ display, thumb, original? }` | R2 object keys; `original` only for member uploads |
| mime, sizeBytes | string, integer | |
| width, height | integer | for layout |
| uploadedBy | `{ kind: member \| guest, userId? }` | |

### rateLimits

| Field | Type | Notes |
|---|---|---|
| key | string | **unique**, e.g. `login:{ip}:{email}` |
| count | integer | |
| expiresAt | Date | **TTL index** |

## 9.4 Indexes

| Collection | Index |
|---|---|
| users | `{ email }` unique |
| sessions | `{ tokenHash }` unique; `{ expiresAt }` TTL; `{ userId }` |
| memberships | `{ userId }` unique; `{ weddingId }` |
| memberInvites | `{ tokenHash }` unique; `{ weddingId }`; `{ expiresAt }` TTL |
| weddings | `{ slug }` unique; `{ galleryToken }` unique |
| events | `{ weddingId, date }` |
| tasks | `{ weddingId, status, dueDate }`; `{ weddingId, assigneeUserId }` |
| guests | `{ inviteToken }` unique; `{ weddingId, rsvpSummary }`; `{ weddingId, name }` |
| vendors | `{ weddingId, category }` |
| expenses | `{ weddingId, date }`; `{ weddingId, category }` |
| photos | `{ weddingId, status, eventId, createdAt }` |
| rateLimits | `{ key }` unique; `{ expiresAt }` TTL |

## 9.5 Event Deletion Cascade

Deleting an event runs in one transaction after an **impact preview** (Section 15):

- Remove the entry from `guests.invitations` and recompute `rsvpSummary`
- Set `tasks.eventId`, `expenses.eventId` and `photos.eventId` to null
- Remove the event from `vendors.eventIds`
- Delete the event

Photos moved to "no event" appear under **Other / Wedding Memories**.

---

# 10. API Design

## 10.1 Conventions

- REST, JSON, all under `/api`.
- Member endpoints require a session and are wrapped in `withMember`.
- Public (guest) endpoints live under `/api/public/...` and are authorized by token only.
- All inputs validated with Zod. Unknown fields are rejected.
- List endpoints support `limit` and `cursor`; the guest list at ~100 rows can be returned in one page.
- Status codes: `400` validation, `401` not signed in, `403` insufficient role, `404` not found or cross-wedding, `409` conflict, `429` rate limited.

## 10.2 Error Format

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": { "fieldErrors": { "email": ["Invalid email"] } }
  }
}
```

## 10.3 Endpoint Catalogue

### Authentication

| Method | Path | Notes |
|---|---|---|
| POST | /api/auth/signup | name, email, password |
| POST | /api/auth/login | |
| POST | /api/auth/logout | |
| GET | /api/auth/me | user + membership (or none) |
| POST | /api/auth/forgot-password | |
| POST | /api/auth/reset-password | |

### Wedding and Dashboard

| Method | Path | Role |
|---|---|---|
| POST | /api/weddings | signed-in user without membership |
| GET | /api/wedding | Admin, Manager |
| PATCH | /api/wedding | Admin, Manager |
| GET | /api/dashboard | Admin, Manager |

### Wedding Members

| Method | Path | Role |
|---|---|---|
| GET | /api/members | Admin |
| GET | /api/members/assignees | Admin, Manager (id and name only) |
| PATCH | /api/members/:userId | Admin (change role) |
| DELETE | /api/members/:userId | Admin |
| POST | /api/members/invites | Admin |
| GET | /api/members/invites | Admin |
| DELETE | /api/members/invites/:id | Admin |
| GET | /api/join/:token | signed-in (preview wedding + role) |
| POST | /api/join/:token/accept | signed-in |

### Events and Tasks

| Method | Path | Notes |
|---|---|---|
| GET / POST | /api/events | |
| GET / PATCH | /api/events/:id | |
| GET | /api/events/:id/impact | counts of guests, tasks, expenses, vendors, photos affected |
| DELETE | /api/events/:id | transactional cascade |
| GET / POST | /api/tasks | filters: `view` (all, mine, completed), `status`, `eventId`, `assigneeId`, `priority` |
| PATCH / DELETE | /api/tasks/:id | |

### Guests and Invitations

| Method | Path | Notes |
|---|---|---|
| GET / POST | /api/guests | filters: `rsvp`, `eventId`, `q` |
| POST | /api/guests/bulk | CSV rows parsed in the browser, sent as JSON |
| GET / PATCH / DELETE | /api/guests/:id | response includes `inviteUrl` |
| POST | /api/invitations/send | `{ guestIds? , resend? }`, one Resend batch |
| POST | /api/invitations/remind | guests with `rsvpSummary = pending` and an email |
| POST | /api/guests/:id/whatsapp-shared | optional tracking only |

### Public Invitation (token)

| Method | Path | Notes |
|---|---|---|
| GET | /api/public/invite/:token | guest, wedding info, invited events with map links |
| PUT | /api/public/invite/:token/rsvp | `{ responses: [{ eventId, status, attendingCount }] }` |
| POST | /api/public/invite/:token/viewed | client beacon, once per browser session |

### Expenses and Vendors

| Method | Path | Notes |
|---|---|---|
| GET / POST | /api/expenses | filters: `category`, `eventId`, `vendorId`, date range |
| PATCH / DELETE | /api/expenses/:id | |
| GET | /api/expenses/summary | total and per-category totals |
| GET / POST | /api/vendors | |
| PATCH / DELETE | /api/vendors/:id | |
| GET | /api/vendors/discover | `category`, `q`; server-side Google Places proxy (Phase 4) |

### Website, Livestream, Gallery (members)

| Method | Path | Notes |
|---|---|---|
| GET / PATCH | /api/website | theme, welcome message, publish status, slug |
| PUT / DELETE | /api/livestream | accepts a YouTube URL |
| PATCH | /api/gallery | `enabled`, `guestUploadEnabled` |
| POST | /api/gallery/rotate-token | explicit, invalidates printed QR codes |
| GET | /api/gallery/qr | QR as SVG or PNG |
| GET | /api/photos | filters: `eventId`, `cursor` |
| POST | /api/photos/uploads | member upload init |
| POST | /api/photos/:id/complete | |
| DELETE | /api/photos/:id | |

### Public Gallery (token)

| Method | Path | Notes |
|---|---|---|
| GET | /api/public/gallery/:token | settings and albums |
| GET | /api/public/gallery/:token/photos | filters: `eventId`, `cursor` |
| POST | /api/public/gallery/:token/uploads | init, requires guest upload enabled |
| POST | /api/public/gallery/:token/uploads/:photoId/complete | |

### Public Pages (server-rendered, no API)

| Path | Purpose |
|---|---|
| /invite/[token] | digital invitation + RSVP |
| /g/[token] | guest gallery and upload |
| /w/[slug] | wedding website |
| /join/[token] | member invite acceptance |

---
