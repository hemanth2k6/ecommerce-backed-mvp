# E-Commerce Backend MVP

A minimal viable E-commerce backend built with PostgreSQL and a REST API. Supports customer accounts, a product catalog, and order placement.

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Core Features](#core-features)
- [API Endpoints](#api-endpoints)
- [Project Structure](#project-structure)
- [System Design](#system-design)

## Overview

This project is the backend service for an E-commerce MVP. It handles user registration and authentication, product catalog browsing, and order management. The full architecture, database schema, and endpoint specifications are documented in [design.md](./design.md).

## Tech Stack

- **Database:** PostgreSQL 14+
- **API:** REST (framework TBD — Node/Express, Python/FastAPI, Go/Fiber, etc.)
- **Authentication:** JWT (JSON Web Tokens)
- **Password Hashing:** bcrypt (cost factor ≥ 12)
- **Data Types:** `NUMERIC` for all monetary values to avoid floating-point drift

## Getting Started

> Application code is not yet written. This section is a placeholder for setup steps.

### Prerequisites

- PostgreSQL 14 or higher running locally or remotely
- Runtime environment for your chosen backend framework (Node.js 18+, Python 3.10+, Go 1.21+, etc.)
- A `.env` file with the following variables:
  ```
  DATABASE_URL=postgresql://user:pass@localhost:5432/ecommerce_mvp
  JWT_SECRET=<your-strong-random-secret>
  BCRYPT_COST=12
  PORT=8080
  ```

### Installation

_(To be added once application code is scaffolded)_

```bash
# 1. Install dependencies
# 2. Run database migrations (schema defined in design.md)
# 3. Start the dev server
```

## Core Features

1. **User Accounts** — Email/password registration and login with JWT sessions
2. **Product Catalog** — Paginated listing of active products with search and price-range filtering
3. **Order Placement** — Atomic order creation with stock decrement, in a single DB transaction
4. **Order History** — Authenticated users can list and view their past orders
5. **Data Integrity** — Price/name snapshots on order items so historical receipts are immutable

## API Endpoints

All endpoints live under `/api/v1`. 🔒 = requires `Authorization: Bearer <jwt>`.

| #   | Method | Path             | Auth | Description                                        |
| --- | ------ | ---------------- | ---- | -------------------------------------------------- |
| 1   | POST   | `/auth/register` | ❌   | Create a new customer account                      |
| 2   | POST   | `/auth/login`    | ❌   | Get a JWT token for an existing user               |
| 3   | GET    | `/products`      | ❌   | List products (paginated, searchable, filterable)  |
| 4   | POST   | `/orders`        | 🔒   | Place a new order from a list of items + addresses |
| 5   | GET    | `/orders/me`     | 🔒   | Fetch the authenticated user's order history       |

Full request/response schemas, status codes, and behavior are in [design.md](./design.md#4-core-api-endpoints-5).

## Project Structure

_(To be filled in once code is present. Expected layout example:)_

```
.
├── src/
│   ├── routes/         # API route handlers (one per domain)
│   ├── middleware/     # JWT auth, error handling, validation
│   ├── db/             # Schema migrations, DB client, queries
│   └── utils/          # bcrypt helpers, JWT sign/verify, etc.
├── supabase/           # (Optional) Supabase migration files
├── tests/              # Integration tests per endpoint
├── design.md           # System design document (schema + endpoints)
└── README.md           # This file
```

## System Design

See the complete system design document:

- [design.md](./design.md) — PostgreSQL schema (Users, Products, Orders, OrderItems), ER diagram, endpoint specifications with request/response examples, and auth/security notes.
