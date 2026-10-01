# chuggy-common

The worker core of [chuggy](https://github.com/kasofsk/chuggy): the harness that runs a ticket's work or a session inside a worker, and speaks the worker contract to chuggy's planes.

chuggy's worker image and the local companions consume it by commit. Nothing publishes it; `package.json`'s `files` is the set they copy.

```sh
npm ci
just check
```

`CLAUDE.md` holds the conventions. MIT licensed.

## The pool loop

A worker pool outside the cluster runs `poolLoop.mjs` over a backend of its own, which places, stops and lists its work, jobs and sessions each against its own ceiling, and names the work that ended of itself. `poolTokens.mjs` turns the pool's client credential into a token, `poolPlane.mjs` polls and settles over HTTP, `poolJobPlane.mjs` ends the attempt of a job that ended without reporting, `poolSessionPlane.mjs` tells a session's plane that its container ended, and `poolCredentials.mjs` reads the file a registration writes. chuggy keeps its own TypeScript copy of the loop beside its Kubernetes backend; the contract's schemas are what hold the two copies to one wire.
