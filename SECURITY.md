# Security Policy

## Supported Versions

Security fixes are applied to the current default branch. This project does
not currently publish a release-support or backport SLA.

## Scope

This policy covers:

- The FastAPI WebSocket, SSE, message, status, and tool endpoints.
- Browser command and response routing.
- Redis-backed connection and session state.
- The Chrome extension, its permissions, and controlled browser window.
- Optional screenshot and VLM integration.
- Deployment configuration maintained in this repository.

## Security Model and Trust Boundaries

Sensitive assets include authenticated browser sessions, page content,
screenshots, typed input, MCP commands, command responses, VLM credentials,
and user or session identifiers.

Relevant trust boundaries include:

- MCP client to the HTTP/SSE server.
- Chrome extension to the WebSocket server.
- Server worker to Redis.
- Chrome extension to the configured VLM provider.
- Extension code to arbitrary web pages and page-controlled DOM content.

`user_id` and `session_id` are routing identifiers. They must not be treated
as authentication credentials or authorization proof.

## Security Invariants

Production deployments and future changes should preserve these properties:

- WebSocket, SSE, and message access is authenticated and authorized before
  browser commands can be sent.
- One authenticated user cannot connect to, replace, inspect, or command
  another user's browser session.
- Commands and responses remain bound to the intended user and session.
- Browser actions remain inside the intended controlled browser context.
- Page-controlled content is treated as untrusted input.
- Secrets, page content, and screenshots are not written to logs.
- VLM credentials are sent only to the explicitly configured VLM endpoint.
- Redis is not reachable by untrusted networks and cannot be used to inject
  commands across users or workers.
- Extension permission and external data transmission remain visible and
  revocable for the user.

## Known Limitations and Deployment Requirements

- The current application endpoints do not implement built-in authentication
  or authorization.
- Anyone who can reach an endpoint and supply a known `user_id` may attempt to
  interact with the corresponding route.
- Deployments must use authenticated TLS termination or an equivalently
  restricted trusted network. Do not expose the application directly to the
  public Internet.
- The extension requests `tabs`, `activeTab`, `scripting`, `storage`,
  `system.display`, and `<all_urls>` access.
- VLM settings, including the API key, are stored in `chrome.storage.local`.
- When VLM mode is enabled, screenshots are transmitted to the configured VLM
  endpoint.
- Multi-worker deployments place connection metadata and command or response
  payloads in Redis. Queue and SSE keys use TTLs, while connection-hash cleanup
  depends on disconnect handling.
- External Redis deployments require network isolation, authentication,
  encryption where available, access monitoring, and stale-state cleanup.
- The built-in fakeredis configuration is intended only for single-process
  local development.

## Reportable Security Issues

Examples include:

- Authentication or authorization bypass.
- Cross-user browser control or session replacement.
- Browser commands escaping the intended controlled context.
- Disclosure of page content, screenshots, credentials, tokens, or VLM keys.
- Redis command injection, cross-user routing, or stale-session takeover.
- Malicious page content causing unintended privileged browser actions.
- Unsafe handling of WebSocket, SSE, forwarded-host, or proxy data.
- A dependency vulnerability that is reachable through this project.

Unauthenticated remote browser control, cross-user command execution, and
credential or authenticated-session compromise will generally be treated as
high or critical severity. Severity remains dependent on reachability,
required privileges, user interaction, and practical impact.

## Out of Scope

No project-specific accepted risks or security exclusions are currently
defined.

Vulnerabilities solely in third-party browsers, MCP clients, Redis, or VLM
providers should normally be reported to the relevant upstream project unless
this repository's integration makes the issue exploitable.

## Reporting a Vulnerability

Do not disclose vulnerability details in a public Issue or Pull Request.

Use GitHub Private Vulnerability Reporting through this repository's
**Security → Report a vulnerability** page. Include:

- Affected component and revision.
- Preconditions and deployment assumptions.
- Reproduction steps or a sanitized proof of concept.
- Expected and actual security behavior.
- Potential impact and suggested remediation, if known.

Do not include real credentials, tokens, private page content, or user data.

If private vulnerability reporting is unavailable, open a public Issue asking
the maintainer to provide a private contact channel, without including
technical vulnerability details.
