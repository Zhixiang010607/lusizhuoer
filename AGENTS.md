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

Do not publish or hand off a cloud function package when its runtime, README,
tests, or ZIP filename disagree about the version.
