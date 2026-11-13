# Development Log

## Day 1 — Project foundation

### Goal

Create the client/server foundation and verify API health without claiming queue functionality.

### Planned work

- [x] Create the React/Vite client structure.
- [x] Create the Express API and MongoDB connection setup.
- [x] Add `GET /api/health` and a small client connection indicator.
- [x] Add initial README, architecture, API, and environment guidance.
- [x] Install dependencies and run the API test and client production build.

### Validation

- `npm test --prefix server` — passed (1 health-route test).
- `npm run build --prefix client` — passed (Vite production build).
- `npm install --prefix client` — reported 0 vulnerabilities.
- `npm audit --prefix server` — 0 vulnerabilities after pinning the transitive `minimatch` override to `^11.0.1` (resolved to 11.0.8). The earlier moderate advisory was for denial-of-service risk in `minimatch`, pulled in by `nodemon`.
- The dependency advisory scan found no known issues in the patched `minimatch` version or the directly declared dependencies.
- A live MongoDB connection was not tested because no database URI or running database was provided.

### Notes

No queue engine, worker, retry, lease, dead-letter, replay, or analytics behavior is complete yet.

## Day 1.5 — Atlas and Git setup

### Goal

Require a valid MongoDB connection before the backend listens, document local Atlas setup, and inspect Git safeguards.

### Changes

- Backend startup loads `server/.env` explicitly, independent of the current working directory.
- Missing MongoDB configuration now stops startup. Failed connection errors give safe troubleshooting hints without printing the URI or credentials.
- `.env.example` uses Atlas-style placeholders only; `.gitignore` excludes environment files, dependencies, build output, coverage, and logs.
- README, architecture, and API setup notes now describe the required database connection before the API listens.

### Validation

- `npm test --prefix server` — passed (3 tests: missing URI, malformed URI without secret disclosure, and health route).
- `node server/src/server.js` with no `server/.env` — exited with code 1 and `MONGODB_URI is missing`; the API did not start listening.
- MongoDB Atlas connection verified successfully through the `dev` script and `GET /api/health`; response reported `database: "connected"`.
- `server/.env` exists locally and is ignored by Git; its contents were not displayed.
- Git repository has no commits or remotes. Global Git user name and email are configured; values were not printed. GitHub CLI is not installed.

### Manual steps

- Review the pending project files before the initial commit.
- Never share or commit `server/.env`.
