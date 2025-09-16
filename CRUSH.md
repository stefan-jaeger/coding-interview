# CRUSH.md

Repository bootstrap notes for agentic tools

Build/lint/test
- No toolchain detected. Default to Node + npm if package.json exists; otherwise use Python + pytest when tests folder exists.
- Node: install deps: npm ci; build: npm run build; lint: npm run lint; typecheck: npm run typecheck; test all: npm test; single test: npm test -- "<pattern>".
- Yarn: yarn; build: yarn build; lint: yarn lint; typecheck: yarn typecheck; test: yarn test; single: yarn test -t "<pattern>".
- PNPM: pnpm i --frozen-lockfile; build: pnpm build; lint: pnpm lint; typecheck: pnpm typecheck; test: pnpm test; single: pnpm test -t "<pattern>".
- Python: create venv: python3 -m venv .venv && source .venv/bin/activate; deps: pip install -r requirements.txt; lint: ruff check .; format: ruff format .; typecheck: mypy .; test: pytest; single: pytest -k "<expr>".
- Go: deps: go mod download; build: go build ./...; lint: golangci-lint run; test: go test ./...; single: go test ./path -run "TestName".
- Rust: cargo build; fmt: cargo fmt -- --check; lint: cargo clippy -- -D warnings; test: cargo test; single: cargo test <name>.

Cursor/Copilot rules
- If .cursor/rules or .cursorrules exist, read and follow them; summarize key constraints (style, testing, commit messages) in PRs and code reviews.
- If .github/copilot-instructions.md exists, adhere to its guidelines and reflect them in code style below.

Code style
- Imports: group by std, third-party, local; use sorted order and no unused imports.
- Formatting: adopt formatter (prettier/ruff/black/gofmt/rustfmt) and run before commit.
- Types: enable strict type checking (TS strict, mypy strict, Go/Rust default); prefer explicit return types on public APIs.
- Naming: PascalCase for types/classes, camelCase for functions/vars, CONSTANT_CASE for constants; files kebab-case (web) or snake_case (py).
- Errors: prefer typed errors (TS Error subclasses, Go error wrapping, Rust anyhow/thiserror); never swallow errors; log with context and propagate.
- Null-safety: avoid null/undefined; use Optionals/Result or narrow types; validate inputs at boundaries.
- Testing: follow AAA; keep fast unit tests; isolate side effects; name tests clearly; use -t/-k filters for focus.
- Git hygiene: small commits with clear messages focused on why; no secrets; run lint/typecheck/tests locally.
- Security: do not log secrets; validate external input; pin dependencies; review licenses.

Conventions for agents
- Detect stack and commands via package.json/pyproject.toml/go.mod/Cargo.toml; prefer repo scripts over global tools.
- Before edits, run lint and typecheck using the scripts above; after edits, re-run tests (single test if applicable).