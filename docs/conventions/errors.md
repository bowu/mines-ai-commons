# Error Handling Conventions

## Typed Errors

Error classes live in `src/lib/errors.ts`:

- `AppError` — base class with `statusCode` and `code`
- `NotFoundError` — 404
- `ValidationError` — 400
- `DatabaseError` — 500

Throw these from route handlers and services. Do not catch and respond inline.

## Global Error Middleware

`src/middleware/error-handler.ts` catches all thrown errors and:

1. Returns standardized `{ error: { message, code } }` JSON.
2. Logs with request context (method, path).
3. Never leaks stack traces in production (`NODE_ENV=production`).

This middleware is mounted last in `src/app.ts`.

## Migration Strategy

Existing routes have inline try/catch blocks. Don't rewrite them proactively — migrate to the throw-based pattern when you're already modifying a handler for other reasons.
