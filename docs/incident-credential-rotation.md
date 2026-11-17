# Incident review: OAuth client secret exposed during setup

**Date:** 17 November 2026
**Severity:** Low (no misuse possible; caught and rotated within minutes)
**Format:** blameless review

## Summary

While connecting the site to the Gmail API, the OAuth client secret was printed in plain text twice, both times by verification commands run in an AI-assisted terminal session, so the values were recorded in that session's transcript. Each exposed secret was revoked in Google Cloud and replaced before any refresh token existed for it. No email was sent and no account access was granted with an exposed secret.

## Timeline (UTC)

| Time | Event |
|---|---|
| ~17:40 | The client secret is copied from the downloaded Google JSON into a git-ignored `.env.local` file. A follow-up check meant to print only "filled (N chars)" uses `${v:+…}${v:-EMPTY}`, which also prints the value when it is set. **Secret #1 exposed.** |
| ~17:41 | Spotted in the output. A new secret is created and #1 is deleted in Google Cloud. |
| ~17:45 | The new secret is pasted by hand into the file. The paste lands inside the key name (`GMAIL_CLIENT_SECRETGOCSPX-…=`), and an editor save overwrites another value. |
| ~17:50 | A structure check prints any line it doesn't recognise, including the malformed one. **Secret #2 exposed.** |
| ~17:51 | Secret #2 and an unused, never-copied secret are deleted; a third is created and downloaded as JSON. |
| ~17:53 | The values are moved from the JSON into the config file by a script that prints only lengths, and the JSON files go to the Trash. |
| ~17:58 | The OAuth consent step completes; the refresh token is written to the file without being printed. A token request confirms the credentials work with only the `gmail.send` scope. |

## Impact

- An OAuth client secret alone cannot send mail or read a mailbox. That also needs a user's consent and a refresh token, and none had been issued for either exposed secret.
- The redirect URI is restricted to `http://localhost:53682/callback`, so a stolen secret couldn't be used to collect consent through someone else's site.
- **Actual impact: none.** Both exposed secrets were revoked within minutes.

## Root causes

1. **Verification output that could echo values.** The checks were written to confirm presence, but their fallback branches printed the raw value, through a shell parameter-expansion mistake and a "print unrecognised lines" debug branch.
2. **Manual copy and paste of secrets into a text file.** This produced a malformed line, and an open editor buffer later overwrote a value written by a script.

## What changed

- **Checks never print values:** only presence, prefix, length and, where the provider already shows them, the last four characters.
- **Secrets move by script, not paste:** credentials go from the provider's downloaded file straight into configuration, and the download is deleted afterwards.
- **No printing during the OAuth flow:** the helper ([`scripts/gmail-auth.mjs`](../scripts/gmail-auth.mjs)) writes the refresh token to the git-ignored file and never prints it.
- **Close editor tabs on secret files** before scripts modify them.

## Takeaways

The secret wasn't leaked by an attacker or a misconfigured server, but by tooling meant to verify it. Any command that touches a secret should be written so its worst-case output is still safe. And rotating immediately, rather than judging that the risk is probably fine, cost five minutes and removed the question entirely.
