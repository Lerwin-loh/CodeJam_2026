# TechJam 2026 — Local Test Setup

Before making any changes, make sure the original Agent Launchpad works successfully on your machine.

## 1. Prerequisites

Install:

- Node.js 22+
- npm 10+
- Docker Desktop
- WSL2 + Ubuntu (recommended for Windows)
- Git

For Windows, enable:

Docker Desktop → Settings → Resources → WSL Integration → Ubuntu

Verify:

```bash
node --version
npm --version
docker --version
docker run hello-world
```

## 2. Clone the Repository

```bash
git clone https://github.com/Lerwin-loh/CodeJam_2026.git
cd CodeJam_2026
```

Open in VS Code:

```bash
code .
```

## 3. Install Dependencies

```bash
npm install
```

## 4. Add `.env`

Get the `.env` file from the team and place it in the repository root.

Do not commit or share the `.env` file publicly.


## 5. Load Ark Variables

Export only the required Ark variables:

```bash
export ARK_API_KEY='<API_KEY>'
export ARK_MODEL='dola-seed-2-1-turbo-260628'
export ARK_BASE_URL='https://ark.ap-southeast.bytepluses.com/api/v3'
```

Do not export the `/app/...` path variables from `.env`.

## 6. Run the Local POC

```bash
npm run poc
```

Open:

```text
http://localhost:3000
```

## 7. Baseline Test

Create a new Agent and send:

> Create a TypeScript hello-world CLI, add a test, run it, and summarize the files you created.

The Agent should create files, run its tests successfully, and return a summary.

Generated Agent files can be viewed at:

```text
.local/workspaces/<agent-id>/
```

If this works, your local setup is ready.

Please confirm the baseline works before starting development.