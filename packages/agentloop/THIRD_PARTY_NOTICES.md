# Third-party notices

AgentLoop contains adapted control-flow and scheduling logic plus an unmodified
Skill package from the following MIT-licensed projects. References are
pinned so the provenance of each port or fixture is auditable.

## PI Agent

- Source: <https://github.com/badlogic/pi-mono>
- Commit: `58302d34e703e0453ea13bdd10c7e423589ce177`
- Adapted files: `packages/agent/src/agent-loop.ts`,
  `packages/agent/src/harness/system-prompt.ts`,
  `packages/agent/src/harness/skills.ts`, and the concurrency-limited mapper in
  `packages/coding-agent/examples/extensions/subagent/index.ts`
- Used in: `src/runtime/agent-loop.ts`, `src/planning/planner.ts`, and
  `src/skills/skill-context.ts`

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## presentation-skill

- Source: <https://github.com/siril9/presentation-skill>
- Commit: `3a22eed290fa2205b6a1e2de5549b4429c5fffd0`
- Included path: `plugins/presentation-skill/skills/presentation-skill`
- Local path: `skills/presentation-skill`
- Use: unmodified third-party Skill Package discovered by the AgentLoop Skill
  directory and privately provisioned for each user; it is not adapted
  framework code.

MIT License

Copyright (c) 2026 Siril Sengolraj

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Anthropic Agent Skills

- Source: <https://github.com/anthropics/skills>
- Commit: `f6656c1256d5a8adfa37db9110046ef20bac644c`
- Included upstream paths: `skills/algorithmic-art`,
  `skills/brand-guidelines`, `skills/canvas-design`,
  `skills/frontend-design`, `skills/internal-comms`, `skills/mcp-builder`,
  `skills/skill-creator`, `skills/slack-gif-creator`,
  `skills/theme-factory`, `skills/web-artifacts-builder`, and
  `skills/webapp-testing`
- Local paths: matching directories under `skills/`
- Use: unmodified Apache-2.0 Skill Packages discovered by AgentLoop. Every
  included Package retains its upstream `LICENSE.txt`. Source locks, if
  provided, are optional provenance records outside the Packages.
- Admission: AgentLoop discovers every structurally valid direct Package
  directory. Deployment operators are responsible for placing only materials
  they are authorized to retain, copy, and run, and may explicitly quarantine
  a directory with a sibling `.disabled.json` declaration.

Apache License 2.0 terms are retained in each included Package's
`LICENSE.txt` file. Copyright 2026 Anthropic, PBC.

## OpenCode

- Source: <https://github.com/sst/opencode>
- Commit: `4d68d30b48a99379b2baaf597dbad576707ea36d`
- Adapted concepts and snapshot boundaries:
  `packages/opencode/src/session/system.ts`,
  `packages/opencode/src/skill/index.ts`,
  `packages/opencode/src/tool/skill.ts`, and
  `packages/opencode/src/session/prompt.ts`
- Used in: `src/skills/skill-context.ts`, `src/planning/planner.ts`,
  `src/runtime/agent-loop.ts`, `src/runtime/tool-registry.ts`, and
  `src/runtime/run-service.ts`

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DeepSeek Harness

- Source: <https://github.com/deepseek-ai/deepseek-harness>
- Commit: `47f943859bef60e4160492346772ded9b24f765a`
- Adapted files: `packages/core/agent-loop/src/tool-calls.ts`,
  `packages/subagent/subagent/src/depth.ts`, and
  `packages/subagent/subagent/src/lifecycle.ts`
- Used in: `src/runtime/agent-loop.ts` and `src/runtime/run-service.ts`

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
