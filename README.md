# ResumeDoc

`resumes.ourstuff.space` is a static resume packet app backed by Firebase Auth,
a targeted Firebase Function codebase, and the shared Ourstuff Stripe Worker.

## Local Test

Open the repo with Five Server, then use the local function base in `config.js`:

```powershell
cd C:\Github\resumes.ourstuff.space\functions-resumes
npm install
cd ..
firebase emulators:start --only functions,firestore,storage
```

The app uses Firebase sign-in, creates private resume packages, asks the shared
Stripe Worker/Cloudflare D1 authority for access, and downloads the generated
DOCX through the authenticated Firebase API. Firestore stores package metadata;
D1 is the source of truth for free credits, codes, Stripe payment access, and
admin controls.

## Ready Check

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\github-ready.ps1 -UiChanged
```

Reports are written to `artifacts\frontend-validation`. When all checks pass,
the script stages non-ignored repo changes, commits them with a validation note,
and pushes the current branch. Use `-CommitMessage "Your message"` to choose the
commit subject, `-NoPush` to commit without pushing, or `-SkipPublish` to run
validation only.

The ready check also runs a no-cost DOCX smoke harness that builds three
different packets and extracts their text for inspection:

```powershell
node .\scripts\resumedoc-docx-smoke.mjs --mode=local
```

Outputs are written under `artifacts\docx-smoke\<timestamp>\` with a `.docx`,
readable `.txt`, and report for each run. Use `--mode=openrouter` only when you
intentionally want to spend OpenRouter credits on the same three-case pass.

## Deploy Notes

Use targeted deploys for the shared Firebase project:

```powershell
firebase deploy --only functions:resumes --project ourstuff-firebase
```

The checked-in Firestore and Storage rules include the current Ourstuff/AI Brain
rules plus ResumeDoc private package paths, but avoid broad deploys unless you
intend to refresh shared rules.

The Stripe checkout route lives in the shared Worker:

```powershell
cd C:\Codex\stripe-worker-api
npx wrangler d1 migrations apply ourstuff-payments --remote
npm run deploy
```

Firebase calls the Worker through the internal ResumeDoc routes, so
`WORKER_INTERNAL_TOKEN` must be configured with the same value in the Worker and
the `functions-resumes` runtime.

## AI Brain Notes Sync

Resume notes sync to AI Brain through the Firebase Function, not from the
browser. The function defaults to:

```text
https://api.ourstuff.space/v1
```

Set the AI Brain API key as a Firebase secret before deploying the ResumeDoc
function:

```powershell
firebase functions:secrets:set AI_BRAIN_API_TOKEN --project ourstuff-firebase
```

Do not commit the token to this repo. The function sends notes through
`/scrub` first, then `/remember` with `allowRawStorage=false`.
