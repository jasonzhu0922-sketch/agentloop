# Third-party Skill Directory

This is AgentLoop's explicit, server-discovered Skill source directory.

Each admitted immediate child directory is an unmodified third-party Skill
Package rooted at `SKILL.md`. A sibling `<name>.source.json` may optionally
pin an upstream HTTPS repository, commit, Package hash, file inventory, and
`SKILL.md` hash. Verified provenance remains outside Package directories so it
does not change Package bytes, but absence or invalidity of that optional file
does not stop package discovery. An explicit `<name>.disabled.json` excludes a
directory from inspection, copying, disclosure, and loading.

At runtime these sources are never used as a shared mutable user Skill. After
directory verification, AgentLoop copies each discovered Package byte-for-byte
into the current user's isolated read-only Package Store. Planner disclosure,
`load_skill`, assessment, and terminal integrity checks operate on that private
copy.

## Included sources

The included package inventory is the set of structurally valid direct
subdirectories. Package discovery does not grant any copyright or license
rights; deployment operators are responsible for admitting only packages they
are authorized to retain, copy, and run.
