# Tealbrick sample apps (spine test fixtures)

Four small mini apps (`sample-gate`, `sample-caller`, `sample-pay`, `sample-mismatch`) that exercise the platform spine: hooks, hold verdicts, companion calls, money holds and manifest mismatch. They exist for QA. They are dev-channel only and never reach a stable workspace.

- Repository: `Tealbrick/opt2-tealbrick-samples` (GitHub organisation `Tealbrick`)
- Visibility: PUBLIC (Core fetches the example fixtures anonymously).
- Licence: Apache-2.0 (`LICENSE`, `NOTICE`). The upstream licences of what the apps bundle are in `THIRD_PARTY_NOTICES.md`.
- Status: all four apps at `0.2.0-dev.4`. CI template ci-v9.9. Built on old SDK pins (ui 0.2.3, miniapp-sdk 0.1.16, manifest 0.1.12); the pins are served from the dist host.

Do not put secrets, tokens, keys, customer data or personal data in this repository, its issues or its pull requests. This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables, Woodpecker secrets) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every CI run starts with a secret scan (gitleaks, a step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so the CI scan is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## What this repo is and is not

Fixtures, not products. Core must not know them: zero platform change for a new app is spine test T6.

## Quick start

Each app is an independent project in its own folder.

```sh
cd sample-gate
corepack enable && pnpm install --frozen-lockfile --ignore-scripts
pnpm test && pnpm conformance
```

## Layout

| Path | Content |
|---|---|
| `sample-gate/` | miniapp `sample-gate`: notes + before/context/after hooks on `sample-caller`'s `caller_send` (`gate_forbidden`, `gate_hold`, `gate_timeout`, `gate_tag`, `gate_redact`: refuse, hold, timeout, tag, redact); wildcard companion to `tb.holds_pending` and the owner page "All approvals". Declares `requires.bridge: "0.1.17"` |
| `sample-caller/` | miniapp `sample-caller`: `caller_send` echoes its hook context and writes a note in `sample-gate` (companion call); `caller_dm` is an outward first-contact op |
| `sample-pay/` | QA fixture, dev channel only, never in the default catalog: `pay_test` is a money op (always held, never adoptable) that records a pretend payment; no money moves |
| `sample-mismatch/` | QA fixture, dev channel only, never in the default catalog: deliberately serves a manifest different from its release record (bridge refuses it, `manifest_mismatch`) |
| `acme-data-sources/` | NOT a miniapp, not in CI `paths`: the mock company data service for the DEV "second brain" demo (fictional Acme LLC: fake Stripe, Slack, Drive, HubSpot, orders Postgres) as REST and one MCP server with 15 read-only tools and text resources. Own `README.md` |
| `tealbrick-ci.json` | One `miniapp` config with the four app folders in `paths` and four images |

Each app is a full project of its own (package.json, pnpm-lock.yaml with tarball integrity, Dockerfile, manifest `tealbrick.manifest.json`, `src`, migrations, skills, tests, `conformance.start.ts`), scaffolded with `create-tealbrick-miniapp` 0.1.3 and kept on the conventions of 0.1.8 (UNVERIFIED: no file in this repo records the scaffolder version). Product ids appear only as manifest data.

## Configuration

Same as every app (SDK variables). Nothing else.

## Spine tests T8, T9, T10

Deploy both apps in one workspace (bridge 0.1.17 or later; `sample-gate` declares `requires.bridge: "0.1.17"`). The owner approves a hold on the app's holds page `/holds/<id>`, opened with the Portal launch ticket (Inbox link or the "All approvals" link in Sample Gate).

**T8, hold from a hook**
1. The agent calls `sample-caller__caller_send` with a text that contains "hold". The answer is `held`, reason "needs owner review", family `policy`, held by `sample-gate/gate_hold`.
2. The owner approves the hold on Sample Caller's holds page.
3. The agent repeats the same call (same input, same key). It runs once. A different text with "hold" is held again.
4. Refuse after approval: the agent calls with a NEW text that contains "hold" and "deny". It is held. The owner approves it.
5. The agent repeats that call. The bridge refuses it ("denied by sample-gate"). The approved call does not run (no new note in Sample Gate).

**T9, holds of all apps (consent)**
1. Before consent: Sample Gate, page "All approvals", shows `no_grant`.
2. The owner gives the consent "This app can see the pending approvals of all apps". With a T8 hold open, the page lists Sample Caller's hold (product, op, family, reason, decide link). It shows no payload.
3. The owner revokes the consent. The page shows `no_grant` again.
4. An agent that calls Sample Caller's standard op `tb.holds_pending` sees only its own holds.

**T10, first contact on a default card**
1. Create a new agent card with the defaults only.
2. The agent calls `sample-caller__caller_dm` with `{to, text}`. The answer is `held`, family `first_contact`, no `heldBy`. Nothing is sent.
3. The owner approves the hold. The agent repeats the same call. It runs once: one outbox row, answer `{sent: true, id}`.
4. The same call with a new key is held again. On a card where the owner removed `first_contact`, the call runs without a hold.

## CI and release

Woodpecker CI with the shared opt2 pipeline template ci-v9.9 from `Tealbrick/opt2-tealbrick-platform` (`.woodpecker/ci.yaml`; images are published by the GitHub Actions release workflow `.github/workflows/opt2-release.yml`; both are generated copies, so do not edit them). `tealbrick-ci.json` lists the four app folders in `paths` and one image per app (`opt2-tealbrick-samples-gate`, `-caller`, `-pay`, `-mismatch`). The stages install, typecheck, lint, test, conformance, build and gen run in each app folder; `image-check` builds each declared image and never pushes.

One `v<semver>` tag releases all four apps (the four manifest versions must be equal). The platform signer (`ci/tb-ci.ts` in the platform repo) lists these four products, and `fleet`, in `DEV_ONLY_PRODUCTS`: every release of them goes to channel `dev` with `devOnly: true`, whatever the tag says, and a stable release of them is refused. Core never offers or deploys them on a stable workspace.

## Language

New code is TypeScript (Node 24+).

## Documentation

- `ARCHITECTURE.md` explains the design (the four apps, the spine tests T1 to T10, the old SDK pins).
- `CONTRIBUTING.md` explains how to change it.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
