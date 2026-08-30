# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Implemented controls

- API routes require a generated per-user bearer token except health, auth
  discovery, and demo-user creation.
- Agent and project services enforce Agent ownership and project owner/member
  permissions on the server; the UI is not the authorization boundary.
- Denied Agent and project actions are persisted as audit records.
- Run details, live trace streams, checkpoint reads, and checkpoint restoration
  verify access to the associated Agent before returning or materializing data.
- Runtime containers drop Linux capabilities, enable `no-new-privileges`, apply
  CPU/memory/PID limits, and mount only the selected workspace and Codex home.
- Authorization and cookie headers are redacted from application logs.

## Identity and token model

When a name is first entered, the control plane generates a per-user bearer
token, persists it in `launchpad.json`, returns it to the browser, and the
browser stores it in local storage. Entering an existing name currently returns
the same token. This is convenient persona selection for a local demo, not
proof of identity: anyone who knows a name can resume that persona.

`APP_AUTH_TOKEN` is separate legacy deployment configuration. The current API
hook does not accept it as a user credential; it validates the generated user
tokens above. Do not substitute `APP_AUTH_TOKEN` for a user token.

## Known limitations

- Demo names are not secure authentication; there are no passwords, SSO, token
  hashing, rotation, expiry, or account recovery controls.
- No tenant isolation despite server-side ownership and project-role checks.
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key. Treat generated user tokens and any configured
  `APP_AUTH_TOKEN` as secrets even though they serve different purposes.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending generated user tokens or other secrets over an
  untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
