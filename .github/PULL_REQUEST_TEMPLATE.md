## What this changes

<!-- One or two sentences. If it fixes an issue, say which. -->

## Checks

- [ ] `node test/all.mjs` passes (or `--fast` if no model server is available)
- [ ] `./test/typecheck.sh` passes
- [ ] If `host.js` changed: I ran it against a real DSH profile, not only the test stubs
- [ ] If behaviour changed: both READMEs say what it now does
- [ ] If `package.json`, `cordis.patch.yml` or the flow config shape changed: the install still works from a clean profile

## On testing

The test suites exercise the plugin's own logic. They cannot tell whether DSH
accepts a projection schema, whether a prompt section has the fields the host
requires, or whether a slot renders. Every bug this project has had that reached
a user was found by loading it for real, so a change to `host.js` or `client.js`
should say how it was checked beyond `npm test`.
