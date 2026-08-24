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
