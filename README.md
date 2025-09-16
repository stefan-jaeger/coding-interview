# Collaborative Code Editor (JS/TS/Java)

Monorepo with:
- apps/frontend: React + Vite + TypeScript + Monaco editor, WebSocket client (STOMP over SockJS), sessions via URL, cursors/selections/colors, language switching, formatting and IntelliSense.
- apps/backend: Spring Boot 3, Gradle Kotlin DSL, Java code. STOMP/WebSocket for collaboration, REST for session join/health, code execution runners (JS/TS via Node+ts-node/register, Java via `javac`/`java`).

## Prereqs
- Node 18+
- Java 21+
- Gradle Wrapper (included)

## Quick start

```bash
# install
npm run bootstrap

# start dev (frontend :5173, backend :8080)
npm run dev

# build all
npm run build

# test all
npm test
```

## URL scheme
- Visit / => prompt for name and auto-create session, redirect to /s/{sessionId}
- Join existing by opening /s/{sessionId}?name=YourName

## Notes
- WebSockets: STOMP topic /topic/session.{id}
- Backend exec is naive and for demo only; do not expose publicly.
