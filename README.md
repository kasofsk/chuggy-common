# chuggy-common

The worker core of [chuggy](https://github.com/kasofsk/chuggy): the harness that runs a ticket's work or a session inside a worker, and speaks the worker contract to chuggy's planes.

chuggy's worker image and the local companions consume it by commit. Nothing publishes it; `package.json`'s `files` is the set they copy.

```sh
npm ci
just check
```

`CLAUDE.md` holds the conventions. MIT licensed.
