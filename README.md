# chuggy-common

The worker core of [chuggy](https://github.com/kasofsk/chuggy): the harness that runs a ticket's work or a session inside a worker, and speaks the worker contract to chuggy's planes.

chuggy's worker image and the local companions consume it by commit. Nothing publishes it; `package.json`'s `files` is the set they copy.

```sh
npm ci
just check
```

`CLAUDE.md` holds the conventions. MIT licensed.

## The pool loop

A worker pool outside the cluster runs `poolLoop.mjs` over a backend of its own, which places, stops and lists its work, jobs and sessions each against its own ceiling, and names the work that ended of itself. `poolTokens.mjs` turns the pool's client credential into a token, `poolPlane.mjs` polls and settles over HTTP, each poll naming the capabilities its runner advertises where the runner gives them, less the agent of which no credential is available, and the credentials of each agent a job, or a chat host's session, would run on now, and each answer naming those its owner's thresholds pause, which the runner then passes over, `poolJobPlane.mjs` ends the attempt of a job that ended without reporting, `poolSessionPlane.mjs` tells a session's plane that its container ended, `register.mjs` redeems a registration token for the pool file, declaring the machine's platforms, the agents its runner can run and whatever capabilities its operator names, and finds by the same rules what a runner advertises when it starts, and `poolCredentials.mjs` reads it, `poolRunner.mjs` composes them beside the runner's backend and passes until the plane denies the pool or the runner has updated itself, and `control.mjs` is the running service's socket for the runner's own CLI. `runnerUpdate.mjs` installs the release of its package a poll names, once the release proves itself, under a lock from `fileLock.mjs`; the loop drains for it and the service manager restarts the runner on it. `poolIdentity.mjs` names what a runner keeps per pool. `containerBackend.mjs` is a backend over docker or podman on the runner's machine, a container per assignment, reaching the engine through `engine.mjs` and `engineArgv.mjs`. A workload is handed the credential file of the one agent its assignment requires, Claude's where it requires none or one the runner names no file for, and whether it can read that file is the runner's to say. A job whose assignment pins no image runs in the first image its owner listed as meeting what the assignment names. A job whose assignment names chuggy's runtime starts through a copy of it, and one its image cannot run is settled `Refused` with the image's fault. Given a record of its machine's images, it holds and records the images each placement uses and removes those no runner there needs, through `imageCleanup.mjs`, `imageRecord.mjs` and `imageSweep.mjs`. Given a measurement of its engine's free disk, it keeps a floor there through `diskFloor.mjs`, reclaiming images and taking no job under it and stopping one job a pass under half of it. `savedLog.mjs` bounds each workload's saved log. `hostBackend.mjs` runs a job that pins no image on the runner's own host instead, as a process of the core with nothing isolating it, where the host is the platform the job names and the pool was registered with `--host`, which its pool file says; `hostRoutedBackend` puts it beside a container backend. A runner may hand each job, and never a session, the engine itself through its socket. chuggy keeps its own TypeScript copy of the loop beside its Kubernetes backend; the contract's schemas are what hold the two copies to one wire.

## A kept workspace

A runner removes a job's workspace, a container's volume or a host job's directory, only where the job exited 0 and the record its core writes at the workspace's root says its work is safe, as `keptWorkspace.mjs` says. Every other workspace is kept, its runner's log says why and whose work it holds, and a record of it is written beside the saved logs. Nothing removes one but its operator. `containerKeptWorkspaces` and `hostKeptWorkspaces` list them with their sizes and the ticket, attempt and stage each record names.

The record is `chuggy-workspace.json`, and the records a runner keeps are in `kept-workspaces/` of its log directory, each named for its workspace's volume or the base name of its directory, `<workspace>.json`; a host runner renames a kept job directory to begin `kept-`, and one it cannot move it keeps where it is, which its record keeps from the next start's sweep. <!-- runtime -->

A job started through chuggy's runtime has its workspace in a volume of the workspace label, which the first command below lists. One started without the runtime has an anonymous volume with no label, which only its record names, as its `workspace`, and `containerKeptWorkspaces` lists. Where the engine named no volume for it, the record names it as the anonymous workspace of its container, and it is one of `docker volume ls --filter dangling=true`. <!-- runtime -->

```sh
# The kept workspace volumes of jobs started through chuggy's runtime (podman takes the same commands).
docker volume ls --filter label=io.chuggy.workspace-volume --filter dangling=true
# Every kept workspace's record, those started without the runtime included.
cat <log directory>/kept-workspaces/*.json
# Look inside one.
docker run --rm -it -v <volume>:/workspace -w /workspace <image> sh
# Get its work out: copy its checkout here, then commit what it holds and push it to a branch.
docker run --rm -v <volume>:/workspace -v "$PWD":/out <image> tar -C /workspace -cf /out/kept.tar repository
tar -xf kept.tar && cd repository && git add -A && git commit -m "kept workspace" && git push <remote> HEAD:refs/heads/<branch>
# Remove it, and its record.
docker volume rm <volume> && rm <log directory>/kept-workspaces/<record>.json
```

A kept host job's directory holds its workspace at `workspace`, and is removed with `rm -rf` and its record the same way.

## A personal runner

A member's personal runner is a pool file of kind `Personal`: it names its tenant and the member it serves, and no project or pool. It runs only that member's work, in the projects they allowlist for it in chuggy, and each assignment and session carries its own project, so nothing in the loop is fixed to one. A tenant administrator grants the member the right to register one; the member mints a personal registration token for the tenant through chuggy's API, `POST /api/v1/tenants/:tenant/personal-runner-registration-tokens`, and `register.mjs` redeems it when the ask is `personal`, which names no pool. A member may register a runner on each of their machines, and every one serves the same projects. Registering again on one machine writes its file over, and the registration it held before stays in chuggy, offline, until its member removes it in chuggy's console. `poolIdentity.mjs` keys a personal runner by tenant and owner, in forms no pool's can take.

## A chat host

A member's chat host is a pool file of kind `ChatHost`, registered by `register.mjs` when the ask is `chat`, from a token minted at `POST /api/v1/tenants/:tenant/chat-host-registration-tokens`. It takes the member's sessions alone, all in one container running `chatSupervisor.mjs`, in the image chuggy names on each poll unless the host's own setting names one. `chatHost.mjs` is its loop and that container's spec, and `chatHostBackend.mjs` the pool loop's backend over the supervisor's stream; each CLI brings the engine that runs the container. For a proved release of its runner, the host drains its supervisor, which ends each session once it holds no turn, and installs once it holds none. Asked to end, within a time its caller gives, the host polls no more, ends its supervisor and every session with it, names each session that ended to chuggy, and returns `Ended`; chuggy learns of whatever it has not answered by then as it would of a host that stopped. Its `idleSecs` setting is optional: unset, its sessions have no idle limit; set, each poll names it and chuggy caps it. Its `deadlineSecs` setting is optional: unset, its sessions have no deadline and run until they end or are stopped; set, each is stopped at it. Its `sessionCapabilities` setting is optional too: set, it narrows each of its threads' rosters, and it is named only to a plane whose answers say it implements `SessionCapabilitiesNamed`, the host claiming no session before then; a thread so narrowed hands its shell the API's origin, its bearer, its tenant and its project. Its `ticketWakes` setting is optional, `On` or `Off`: it says whether its threads that made no choice of their own are woken for events on the tickets they drafted, and it is named only to a plane whose answers say it implements `ThreadTicketWakes`, the host claiming sessions either way. Where neither the thread nor its host sets one, chuggy's default applies: no wakes.

A thread on a chat host whose agent has a shell holds a job host, `jobHost.mjs`: jobs, watches and timers it sets through tools of its `chuggy` server, each waking the thread only through chuggy's thread wake. Their state is kept in the thread's workspace and restored by its next session, which starts a job set to restart again and tells chuggy the thread is standing while one runs. Every thread, on a chat host or not, also holds `ticket_wakes`, from a plane that implements `ThreadTicketWakes`: with no input it answers the thread's own choice, its host's setting and the one that applies; given `On`, `Off` or `Host` it sets the thread's choice, `Host` following its host's `ticketWakes`.

A thread's sessions keep one workspace, `threads/<name>` in the host's sessions volume, `chuggy-chat-<digest>-sessions`, as `chatSession.mjs` says: what one session leaves there the next finds, its checkout included, which is cloned once, borrowing nothing from the supervisor's mirror, and has its remote-tracking branches fetched again for each later session. Its supervisor removes it once chuggy names the thread as closed and no session of it runs. Nothing else bounds the volume: each workspace holds a whole copy of its thread's repository and grows with what its thread's sessions write, and a session is not prepared once the volume has less free than `chatSessionFreeBytesMin`. chuggy names a closed thread only while it is among the most recently closed, so a thread that closed while its host was not polling keeps its workspace until a member removes it, while no session of the thread runs:

```sh
# Each thread's kept workspace and its size (podman takes the same commands).
docker run --rm -v chuggy-chat-<digest>-sessions:/sessions <image> du -sh /sessions/threads/*
# The name of one thread's, where neither identity holds a quote or a backslash.
printf '["%s","%s"]' <project> <session> | sha256sum
# Remove it.
docker run --rm -v chuggy-chat-<digest>-sessions:/sessions <image> rm -rf /sessions/threads/<name>
```

## The `chuggy` command

`chuggy <tool> '<json input>'`, this package's `bin`, runs one of the session's `chuggy` tools from a thread's shell, against the session its shell was handed, and prints the tool's answer as the agent reads it: a route's status line and its body. The input defaults to `{}`. It exits 1 on a refusal or a failed call, and 2 where a shell variable is unset, the tool is unknown or the input is not JSON. An unset variable is a shell handed no credential, which a thread's shell is handed only where its chat host's settings name `sessionCapabilities`. It offers every tool that reaches the API, so no owner's offers, and the API refuses what the session's bearer may not do. Each submitted command is an operation of its own, so one run again is a second submission.

## A person's own agent

`localTools.mjs` serves the `chuggy` tools a session pod has to a coding agent on a person's own machine, over stdio, for one site's one project: every project tool, no decision tool, each call under that person's own token. It also reads and changes that person's own agent accounts, whichever project it is bound to: `read_usage`, `update_usage_settings`, `retry_paused_agent` and `retire_credential`. `localSignIn.mjs` signs them in as the setup program's client, through a page on the machine's loopback address that a call answers with when there is no sign-in, and renews the token ahead of its expiry; `localTokenStore.mjs` keeps the renewal token in the worker contract's shared sign-in store, where chuggy's setup program keeps the same sign-in, and renews under the store's lock, which every program on the machine using it takes. `localToolServed` is the whole of it for a companion, which supplies the MCP SDK and the directory an earlier copy kept each site's sign-in in, moved into the store once.
