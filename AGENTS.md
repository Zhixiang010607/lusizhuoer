# Project context rule

Before changing business logic, permissions, database migrations, cloud
functions, web pages, or the mini-program, read `PROJECT_CONTEXT.md` completely.
It is the current cross-device business-rule baseline.  Its final rules and
explicitly retired designs take precedence over historical migration names and
older narrative documentation.  When a later user decision changes a rule,
update `PROJECT_CONTEXT.md` in the same commit and remove or clearly retire the
superseded wording.

# Cloud function release rule

Whenever deployable code under `cloudfunctions/<function>/` changes:

1. Increment that cloud function's public runtime version.
2. Update the function README's visible current version in the same commit.
3. Update cross-function deployment instructions and version contract tests.
4. Name the upload ZIP with the same version and verify the ZIP-root README
   reports that version before delivery.
5. Create the verified archive at
   `deployments/<function>-v<version>.zip` and include a clickable absolute
   link to that ZIP in the final response so it can be dragged directly into
   Tencent Cloud.

Do not publish or hand off a cloud function package when its runtime, README,
tests, or ZIP filename disagree about the version.

# Delivery handoff rule

A completed change is not ready for handoff until every applicable artifact is
available:

1. Any SQL the user must run must be saved as a standalone
   `database/cloudbase-console/<number>-<purpose>.sql` file that can be copied in
   full into the Tencent Cloud SQL editor. Do not require the user to reconstruct
   SQL from Markdown, diffs, shell substitutions, or chat messages. Multi-step
   operations use ordered SQL files plus a README that states the execution
   order. Link every required SQL file in the final response and state whether
   it has been executed.
2. After validation succeeds, commit all and only the scoped changes, push the
   current branch to `origin`, and verify local HEAD equals the upstream HEAD.
   Never force-push. If commit or push fails, report the task as incomplete and
   state the blocker.

A source push does not mean that SQL, cloud functions, static hosting, or a
mini-program release has been deployed. Report each deployment state separately.

# Upload transport and verification rule

For release work, use the `lusizhuoer-release-upload` skill when available.
Prefer the verified official WeChat DevTools cloud-function deployment route
with an explicit function path. Before standalone CloudBase CLI upload, inspect
the actual packing scope; some CLI versions can resolve `functionPath: '.'`
against the working directory even when `--dir` is supplied. Never upload the
repository root as a function package.

Use `scripts/wechat_upload_fast.py check` before the Mini Program COS upload
helper. Preserve TLS validation, keep uploads serialized, and check remote state
after a timeout before retrying. A completed cloud-function upload additionally
requires runtime-version verification and downloaded-code comparison; a Mini
Program upload requires the official final upload receipt. Static Web publishing
uses a scoped staging directory with `--safe --verify` and public-byte readback.
For CloudBase CLI 3.8.7 static hosting at the bucket root, omit the optional
`cloudPath` argument (empty root); do not pass `/`. Its consistent-deploy
manifest can retain the leading slash while COS keys do not, causing false
missing-file verification and an unsafe rollback scope. Preserve failed-attempt
receipts, recheck remote state, and correct the path before retrying.

# Production database backup rule

Treat every production database row and schema object as critical data. Before
every production database write, migration, cleanup, repair, import, or manual
SQL change:

1. Run a read-only preview that resolves the exact environment and targets.
2. Use `scripts/cloudbase-pg-change.js` to create a transaction-consistent
   snapshot of every `public` base table and the current public sequence values.
3. Verify the backup manifest has no row-count mismatch before applying the
   change. If backup creation or verification fails, stop; never run the write
   directly as a workaround.
4. Execute the scoped SQL only through the same backup gate, then run an
   independent read-only post-change verification.
5. Preserve the backup schema and the private local receipt until the user has
   accepted the result. Do not commit production data, account identifiers, or
   backup contents to Git.

Creating the verified backup itself is the only initial database write exempt
from needing an earlier backup. Every subsequent production mutation is covered,
including one-off console SQL and data-only changes with no migration file.

Database cleanup does not release a phone while its CloudBase Auth identity
remains BLOCKED. Phone release requires explicit user authorization, a fresh
verified backup, a private Auth metadata receipt, and an inventory of all Auth
phone identities, including ones missing from staff_accounts. Protect current
business/contact mappings by both UID and normalized phone, including newly
created accounts. Delete only exact rechecked unbound UIDs and independently
verify phone absence plus preserved identities. Auth passwords cannot be
restored from the database snapshot. Never turn this maintenance operation into
an automatic login/account-creation fallback or normal archive behavior.

# Client isolation rule

- The current root-level HTML/CSS/JavaScript files are the legacy Web client.
- `miniprogram-app/` contains only the WeChat Mini Program client.
- A future native application must be created under `native-app/`; it must not
  be placed in the Web root or `miniprogram-app/`.
- `cloudfunctions/` and `database/` are shared server-side components, not
  client source directories.
- Client-specific UI, routing, session storage, platform APIs, build output,
  and dependencies must not be imported or copied across client boundaries.
- A request for one client changes only that client unless a shared server
  contract must change. Shared contract changes must preserve compatibility or
  coordinate all affected clients, with separate regression tests for Web,
  Mini Program, and any future native App.
- Moving the legacy Web client into `web-app/` is a dedicated migration and
  must not be mixed into an unrelated feature change.
