# SimLife Classroom Pilot Deployment

This deployment is intentionally independent of CodeWorld. Create a new private
GitHub repository and a new Render web service from this repository's
`render.yaml`. Do not add this folder to the CodeWorld repository and do not
attach the CodeWorld Render service, database, environment group, or secrets.

## Before creating the service

1. Push this repository to its own private GitHub repository.
2. In Render, create a Blueprint from that repository. The blueprint creates a
   free `simlife-classroom` web service and generates a unique session secret.
3. Supply only these prompted secret values:
   - `SIMLIFE_DATABASE_URL`: financeWRLD's transaction-pooler connection string
   - `SIMLIFE_GOOGLE_CLIENT_ID`: the authorized Google web client ID
   - `SIMLIFE_TEACHER_EMAILS`: comma-separated teacher allowlist
4. Confirm the service has `SIMLIFE_ALLOWED_GOOGLE_DOMAIN=tcitys.org` and
   `SIMLIFE_DEMO_AUTH=false`.

Never paste CodeWorld's `DATABASE_URL`, session secret, or environment group.

## After the first deploy

1. Confirm Render reports `/api/health` healthy.
2. Open `https://<new-simlife-service>.onrender.com/api/auth/config` and verify:
   - domain is `tcitys.org`
   - `demoEnabled` is `false`
   - the Google client ID is present
3. Add `https://<new-simlife-service>.onrender.com` as an authorized JavaScript
   origin for the Google OAuth web client. Do not remove CodeWorld's origin.
4. Test teacher sign-in and one fictional or designated pilot student before
   issuing any class-wide money.
5. Test from a school Chromebook on the school network. A working CodeWorld
   URL does not prove a new Render subdomain is allowed by the district filter.

## Pilot sequence

1. Start with 3–5 students.
2. Have them sign in, join the correct period, open Banking, and sign out/in.
3. Issue a small clearly labeled test paycheck and bill.
4. Have students read the mail, make a partial payment, transfer to savings,
   and confirm the remainder persists after refresh.
5. Expand to the class only after the teacher roster and balances reconcile.

The initial Blueprint deliberately uses mock market prices. That isolates the
login/banking bug test from third-party quote outages. Switch to the separately
reviewed classroom quote provider only after the account pilot is stable.

## Rollback

If the pilot misbehaves, stop sharing the SimLife URL or suspend only the
`simlife-classroom` service. CodeWorld remains a different repository and
service and does not need to be rolled back or restarted.
