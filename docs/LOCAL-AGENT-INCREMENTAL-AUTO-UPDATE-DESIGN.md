# Local Agent 增量自动更新设计

**状态：提案**
**适用范围：** AgentLoop Local Runtime 的 macOS、Windows 发行包及其发布服务
**不在范围内：** 云端 Router/Web/Runtime Host 的 Docker/Compose 发布；它们继续由服务端发布流程管理。

## 1. 决策摘要

Local Agent 的更新分成两个独立问题：

1. **按版本自动更新**：已安装的设备能判断某个发布物是否可信、兼容且比当前版本新，并能安全切换或回退。
2. **增量传输**：只下载新版本中本机没有的内容，而不是每次下载整个 Node、Python、依赖和 Skills 运行时。

推荐采用“**稳定 Bootstrap + 版本化 Runtime payload + 已签名更新 feed**”的方案。Bootstrap 是原生托盘/启动程序，更新频率低，仍由 macOS PKG 或 Windows MSI 安装；Runtime payload 位于每个用户可写的数据目录，使用内容寻址的块增量下载，经过验签、预校验和健康检查后原子切换。

这使日常 Runtime、Node/Python 依赖和内置 Skills 的更新不需要管理员权限；而改变 Bootstrap、自定义 URL handler 或系统级注册信息的升级，仍明确走系统原生安装与用户授权。不能也不应通过保存管理员密码、`sudo` 或由网页触发静默安装来绕开该边界。

## 2. 当前事实与根因

当前发行链路已具备一些可复用的基础：

- 发布脚本将 PKG/MSI 复制到不可覆盖的版本路径，复核 SHA-256，并原子替换 catalog。
- Router 可以从挂载文件重读 release catalog；Web 端支持不可变文件和 Range 下载。
- Agent 会报告自身版本；本地 Runtime 已支持 `drain`、活动任务计数和生命周期操作。
- macOS PKG 与 Windows MSI 都会在替换文件前关闭旧进程，且运行数据位于安装目录之外。

但这不是自动更新闭环：

1. `signature` 当前是给下载页展示的字符串，不是客户端可验证的签名。
2. “最新版本”按 `publishedAt` 排序；发布时间较晚的低版本也可能被视为当前版本，不能作为防回滚决策。
3. macOS 安装位置为 `/Applications`，Windows 为 `Program Files`，两个位置都不能由普通用户进程无权限静默替换。
4. 发行包把 Node、Python、第三方依赖、内置 Skills 和 Agent 一起打进完整安装包；没有 payload 文件清单、块索引、断点恢复或版本槽位。
5. Linux 目前不是 Local Agent 的受支持安装目标：解析器拒绝 Linux 发布物，仓库的 Linux/CentOS 内容是服务端部署，不是桌面 Agent 安装包。

因此第一处语义断裂是“**不可变的安装包发布元数据**”到“**设备可安全执行的更新决策与切换**”之间缺少可信更新协议和本机更新器，而不是缺少一个普通版本查询接口。

## 3. 目标、非目标与约束

### 3.1 目标

- 自动发现可信的、更高版本且兼容当前平台/架构/渠道的发布。
- Runtime 日常更新无需管理员权限，并能仅传输缺失内容。
- 任何下载中断、掉电、进程崩溃或新版本启动失败，都不破坏现有可运行版本和用户数据。
- 不中断正在执行的任务：先停止新任务分配、排空或检查点化已有任务，再切换。
- 支持 stable、beta、internal 三个渠道和渐进放量；同一设备的放量结果稳定。
- 让 macOS/Windows 使用同一份发布协议和安全语义，但保留各自正确的安装与启动实现。

### 3.2 非目标

- 不对可执行文件做 bsdiff/xdelta 等二进制补丁。Node、Python 和签名后二进制对这种补丁的失败、审计和回滚成本过高。
- 不把用户上传的 Skill、模型凭据、设备身份、工作区、SQLite 数据库或日志放入可替换 payload。
- 不将云端 Linux 容器滚动发布伪装成 Local Agent 自动更新。
- 第一阶段不承诺 Bootstrap 本身完全无感更新；系统级文件的替换必须遵守操作系统授权模型。

### 3.3 设计约束

- 客户端必须内置更新根公钥，不能信任由网络返回的公钥。
- 发布版本不可变；发现构建错误时发布更高版本或做服务端撤回，而不是覆盖同版本文件。
- 更新检查不可携带登录令牌、模型密钥或用户可识别的业务数据。
- 所有代码和原生安装包必须有真实的生产签名；哈希只能证明下载内容与已信任元数据一致，不能替代签名信任。

## 4. 总体架构

```text
离线/受控签名密钥
        │ 签名
        ▼
不可变对象存储/CDN ── feed.json + feed.sig ──► Bootstrap（内置根公钥）
  ├── payload manifest + signature                         │
  ├── sha256 内容块                                         ├── 版本/兼容性/放量决策
  └── 完整 payload 兜底包                                   ├── 下载、校验、组装 staging
                                                            ├── drain / 等待 checkpoint
                                                            └── 原子切换 current → 健康验证
                                                                  │              │
                                          保留旧 payload ◄────────┘              └──失败则回滚
```

### 4.1 角色

| 组件 | 责任 | 不应承担的责任 |
|---|---|---|
| 发布器 | 构建、代码签名、生成文件/块清单、签名并原子发布 feed | 选择某台设备何时切换 |
| Router/Web | 对外托管既有人工下载安装 catalog；可代理只读 feed | 给客户端下发未签名的“立即执行”命令 |
| Bootstrap | 验签、选择、下载、恢复、切换、回滚、呈现状态 | 保存用户业务凭据；解释业务任务 |
| Runtime payload | 执行 Agent 和本地 Runtime；提供 drain/status/health | 覆盖 Bootstrap 或修改发布信任根 |
| 用户数据域 | 设备身份、数据库、上传 Skills、配置、日志和下载缓存 | 被安装/更新流程删除或覆盖 |

### 4.2 本机目录与所有权

以下为逻辑目录，不要求完全相同的文件名：

```text
<user-data>/AgentLoop Local Runtime/
  data/                         # 既有持久状态；更新只读，迁移有备份
  payloads/
    0.1.16/                     # 已验证、不可变
    0.1.17/                     # 已验证、不可变
  staging/<release-sequence>/   # 可删除的下载/组装目录
  objects/sha256/<digest>       # 可复用、可断点续传的压缩内容块
  update-state.json             # 小型耐久状态机，不含密钥
  current                       # 原子指向已通过健康检查的 payload
```

Bootstrap 从 `current` 启动 Runtime，而不是让 LaunchAgent、注册表启动项或托盘程序直接绑定一个会被替换的 payload 路径。payload 目录永不原地修改：先完整组装和验收，再以原子 rename/指针替换激活。

Runtime 的 SQLite、device identity、用户上传 Skill、模型/集成密钥、运行定义与日志必须保留在既有用户数据域。任何涉及 schema 的迁移先创建可恢复快照；只有在新版本通过健康检查后才确认迁移。若迁移无法由旧 Runtime 读取，则发布物必须标记为不可自动回滚，并要求显式用户确认及本地备份。

## 5. 可信发布协议

### 5.1 Feed 与密钥

新增独立的 `v2` 更新 feed；不要复用当前下载页的 `releases.json` 作为执行依据。建议使用“原始字节的 JSON 文件 + Ed25519 detached signature”模式：客户端获取 `feed.json` 与 `feed.sig`，以 Bootstrap 内置的 `keyId → publicKey` 表验签原始字节。避免自行定义 JSON canonicalization。

根公钥轮换通过已信任旧密钥签名的新 keyring 完成；Bootstrap 至少保留当前和下一把公钥。私钥放在受控签名服务或离线介质，绝不写入 catalog、仓库、安装包或 CI 日志。

建议的逻辑记录如下（示例字段，不是最终 API）：

```json
{
  "schema": "agentloop.local-agent-update-feed/v2",
  "generatedAt": "2026-10-31T00:00:00Z",
  "targets": [{
    "releaseSequence": 117,
    "payloadVersion": "0.1.17",
    "bootstrapMinVersion": "0.1.15",
    "channel": "stable",
    "platform": "darwin",
    "arch": "arm64",
    "protocol": { "min": "1", "max": "1" },
    "rollout": { "percent": 10, "seedVersion": 1 },
    "payloadTreeSha256": "…",
    "payloadManifestUrl": "https://downloads.example/…/payload.json",
    "payloadManifestSha256": "…",
    "fullPayload": { "url": "https://downloads.example/…/payload.tar.zst", "sha256": "…", "bytes": 0 },
    "minimumSupportedVersion": "0.1.15",
    "mandatoryAfter": null,
    "releaseNotes": "…"
  }]
}
```

`releaseSequence` 必须对每个 `platform/arch/channel` 单调递增，作为防回滚锚点；SemVer 负责可读版本和预发布比较。客户端持久化“已接受的最高 sequence”，拒绝更低 sequence，除非 feed 中有由根密钥签名的明确 `rollbackTo` 指令。`protocol` 不是当前单一的协议分组键，而是双方兼容范围；不兼容版本只能提示用户升级 Bootstrap 或停止分发，不能盲目安装。

### 5.2 Payload manifest 与真正的增量

每个 payload 都有独立签名的 manifest，列出：目录树、权限、每个文件由哪些压缩块按顺序构成、文件 SHA-256、payload tree hash、最小 Bootstrap 版本和代码签名信息。块固定为 1–4 MiB，按未压缩内容 SHA-256 命名；压缩格式和字典版本写入 manifest。

更新器按 digest 查看本机 `objects/` 缓存，只下载缺失块，逐块哈希校验，在 staging 重建文件并校验所有文件、目录树和 Runtime 代码签名。任一检查失败即丢弃 staging，不触碰 `current`。CDN 可用 Range 支持断点续传，但 Range 仅是传输优化，不能作为完整性依据。

对于首装、缓存淘汰或差异比例过大的情况，使用同一 manifest 中的完整 payload 兜底包。这样“增量”由可验证的内容块实现，而非难以审计的可执行二进制 patch。

### 5.3 渠道与放量

- 默认渠道为 `stable`；只有用户显式加入才使用 `beta` 或 `internal`。
- 为每台设备首次生成随机 `rolloutSeed` 并只保存在本机。`hash(releaseSequence || rolloutSeed)` 决定是否落入百分比，重试与重启不改变结果。
- 发布顺序为 internal → beta → stable 1% → 10% → 50% → 100%；每一步需要上一阶段的安装、回滚、健康失败率满足门槛。
- “撤回”从 feed 去掉/标记目标，使未更新设备不再选择它；已更新且健康的设备不被远程强制降级。紧急回滚使用显式、签名的 `rollbackTo`。

## 6. 客户端状态机和切换流程

`update-state.json` 至少记录目标 sequence、阶段、重试次数、下载块、旧 active version、错误代码和时间。状态转换必须落盘并可幂等恢复：

```text
idle → checking → available → downloading → verifying → staged
  → draining → switching → starting → healthy → committed
                                      └→ failed → rolling-back → rolled-back
```

1. Bootstrap 在启动后延迟检查、每 6 小时检查一次，并提供“检查更新”菜单；失败使用指数退避，用户手动检查可绕过退避。
2. 验证 feed 签名、有效期、渠道、平台、架构、sequence、SemVer、Bootstrap 最低版本和协议范围。只读检查不携带业务 token。
3. 下载/复用块，组装 staging 并进行 manifest、tree hash 和平台代码签名检查。
4. 请求 Local Agent 将所有 Runtime 标记为 draining；Router 因而不再派发新任务。等待现有任务结束；支持检查点的任务按既有 checkpoint 流程恢复。超过策略时限只报告“等待任务完成”，**不**默认杀死用户任务。
5. 原子切换 `current` 到新 payload，重启由 Bootstrap 持有的 Agent 进程或其 OS 启动项。
6. 用固定时限检查 loopback health、报告的 payload version/protocol、Runtime catalog 和 Router 握手。此检查不把“能启动进程”误判为可工作。
7. 失败时恢复 `current`、重启旧版本、保存诊断并对该 target 做冷却；成功后记录 sequence，解除 draining，并延后清理至多保留两个已知成功版本。

磁盘空间不足、签名失败、协议不匹配、活动任务未排空、用户已禁用自动更新、Bootstrap 太旧均是显式状态，不可静默降级或删除旧版本。

## 7. 操作系统差异

### 7.1 macOS

| 项目 | 方案 |
|---|---|
| 当前安装边界 | PKG 安装到 `/Applications/AgentLoop Local Runtime.app`；预安装脚本会卸载旧 LaunchAgent 并终止旧进程。 |
| 高频 Runtime 更新 | Bootstrap 保持在 `.app` 中；payload 与块缓存放在 `~/Library/Application Support/AgentLoop Local Runtime/`。每个登录用户各自维护 payload、数据与 rollout seed。 |
| Bootstrap 更新 | 使用 Developer ID Application 签名、Developer ID Installer 签名并完成 notarize/staple 的 PKG；首次或 Bootstrap 升级时由用户授权系统安装。不要调用 `sudo`，也不要从 Runtime 保存管理员凭据。 |
| 启动管理 | LaunchAgent 应指向稳定 Bootstrap launcher；切换 payload 后由 Bootstrap 使用 `launchctl kickstart -k`，而不是改写/杀死正在替换的 payload 文件。 |
| 架构 | `darwin/arm64` 与 `darwin/x64` 是不同 target、不同代码签名和不同 feed 项；Rosetta 不是分发选择依据。 |
| Gatekeeper | 每次 payload 中的 Mach-O/可执行文件在激活前验证 Team ID、bundle identifier 和签名；网络下载隔离属性不得被无条件移除。 |

现有 Swift tray 程序可以演进为 Bootstrap，但应把“启动 Agent”的资源路径从 app bundle 内固定 executable 改为由 `current` 解析出的已验证 payload。现有 PKG 的停止逻辑只保留给 Bootstrap 的系统级升级；不应用于日常 payload 更新。

### 7.2 Windows

| 项目 | 方案 |
|---|---|
| 当前安装边界 | WiX MSI 为 `perMachine`，安装到 `Program Files`，MajorUpgrade 会关闭旧 tray/Agent，升级通常要求 UAC。 |
| 高频 Runtime 更新 | 保持已签名的 tray Bootstrap 在 Program Files；payload 与块缓存放在 `%LOCALAPPDATA%\AgentLoop Local Runtime\`，不写 Program Files。每个 Windows 用户独立更新。 |
| Bootstrap 更新 | 使用 Authenticode 签名的 MSI；个人设备由用户/UAC 安装，企业设备可由 Intune/SCCM/GPO 等管理工具部署。不要让普通 Runtime 调用 `msiexec` 试图绕过 UAC。 |
| 启动管理 | 当前 HKCU `Run` 启动项应稳定指向 Bootstrap；Bootstrap 持有并停止其子 Agent，切换 payload 后启动新子进程。 |
| 架构 | 当前只支持 `windows/x64`。增加 arm64 前须有原生 Node/Python/托盘构建、MSI UpgradeCode 策略和单独 target，不把 x64 包标成通用 Windows 包。 |
| 信誉与防护 | 发布物及 Bootstrap 签 Authenticode，并在激活前验证签名发布者和 manifest hash；记录 SmartScreen/防病毒阻断为可诊断安装失败。 |

不建议使用 MSI Patch (`.msp`) 实现增量：它仍受系统安装权限、MSI 组件规则和回滚限制约束，且与按内容块缓存的 payload 更新重复。MSI 应承担 Bootstrap 生命周期，payload 更新应使用本设计的独立协议。

### 7.3 Linux

Linux 当前不进入 Local Agent 自动更新范围。当前 release catalog 解析明确拒绝 `linux`，而 CentOS/Compose 文档描述的是服务器镜像和下载站部署；二者不能混用。

如果未来要支持 Linux 桌面 Local Agent，需要单独立项并先明确受支持发行版与安装模型：

- `.deb`/`.rpm`：由 apt/dnf/yum 或企业包仓库处理 Bootstrap 更新；payload 仍可采用用户目录版本槽位。
- AppImage/Flatpak：应采用对应生态的签名、权限和更新机制，不能直接复用 PKG/MSI 安装指令。
- 容器化 Linux Runtime：继续使用镜像 digest、编排器 drain/rolling update，不使用桌面 feed。

在有真实构建、签名、安装和原生验收之前，feed schema 不应开放 Linux target。

## 8. 发行与运维流程

1. 在隔离的 macOS/Windows 构建机生成 payload 和 Bootstrap 安装包；锁定 Node、Python、依赖和 Skills 的构建输入。
2. 对 Bootstrap 进行平台原生签名；macOS 完成 notarize/staple，Windows 完成 Authenticode 签名与时间戳。
3. 生成 chunk、payload manifest、tree hash 和完整 payload fallback；在干净设备验证可组装和启动。
4. 上传所有内容到版本/哈希不可变路径，读取回校验哈希；对象可用后才签名并发布 feed。feed 发布必须是单一原子指针更新。
5. 先进行原生安装、覆盖升级、配对、真实本机 Runtime Run 和更新回滚验收；下载页出现版本或健康端点 ready 不代表发布完成。
6. 按渠道和放量推进；监控安装成功率、下载/签名/组装失败、drain 超时、启动健康失败和自动回滚率。指标只含版本、平台、错误类别和耗时，不含任务内容、密钥或访问 URL。

发布器保留当前人工下载 catalog：它服务首次安装、历史版本下载和 Bootstrap 更新。新的 v2 feed 是独立的机器执行协议；发布脚本应同时生成二者，但不得从人类展示字段推断自动更新行为。

## 9. 分阶段实施计划

### Phase 0：先建立可信版本决策

- 定义 v2 feed、Ed25519 验签库、keyring 和严格 SemVer/sequence 选择器。
- 给发布器加入签名、不可变对象上传前校验、撤回和渠道/放量字段。
- 保留现有 v1 catalog 和下载页，避免破坏首次安装。
- 增加仅检查不安装的 Bootstrap 菜单与状态展示。

完成标准：篡改 feed、错误签名、降级 sequence、错误渠道、错误架构、Bootstrap 太旧和协议不兼容均被拒绝且给出可诊断状态。

### Phase 1：版本槽位与可靠回滚（先可全量 payload）

- 将托盘程序重构为稳定 Bootstrap；将 Runtime 启动路径解析为 `current` payload。
- 实现 staging、原子切换、启动健康检查、回滚、旧版本保留和磁盘配额。
- 接入已有 drain/active-run/checkpoint 能力；添加“等待任务完成”可见状态。
- 首先允许下载完整 payload，以验证本机状态机，再引入块增量。

完成标准：在每个状态转换后强制终止 Bootstrap，重启后能继续或安全回到旧版本；更新失败不会丢失 device identity、SQLite、配置、上传 Skill 或日志。

### Phase 2：内容块增量、断点恢复和放量

- 生成并发布文件/块 manifest；实现对象缓存、并发受限下载、Range 恢复、组装和缓存回收。
- 实现稳定 rollout seed、渠道订阅、失败冷却和 server-side 撤回。
- 对“增量小于完整包的收益”做度量；当增量不划算时自动选择完整 payload。

完成标准：从相邻版本更新只下载缺失块；损坏、截断或重放的块不能被激活；更新中断后恢复无需重新下载已校验块。

### Phase 3：Bootstrap/企业管理完善

- macOS：真实 Developer ID、notarization、用户可见的 Bootstrap 更新引导；如确有企业无交互需求，再单独评估受管理的特权 helper/MDM。
- Windows：真实 Authenticode、MSI Bootstrap 升级提示和企业软件分发手册。
- 为管理员提供版本、渠道、最后检查、失败原因、活动/回滚版本的本地诊断导出。

完成标准：真实 macOS/Windows 设备上的首次安装、Bootstrap 覆盖升级、payload 增量更新、离线恢复和卸载后的数据保留/清理策略均通过验收。

## 10. 验收与回归测试

| 类别 | 必须证明的契约 |
|---|---|
| 信任 | feed、manifest、块、代码签名任一被篡改时，旧版本继续运行且不会执行新代码。 |
| 版本 | 预发布、同版本重发、发布时间倒序、sequence 回退、强制回滚和协议不兼容均有确定行为。 |
| 传输 | Range 中断、网络切换、磁盘满、缓存块损坏、CDN 返回错误内容不会激活 staging。 |
| 原子性 | 下载、drain、切换、启动、健康检查的任意点崩溃后，重启不会出现没有可启动版本的状态。 |
| 任务 | 更新开始后新任务不再分派；活动任务完成或检查点后才切换；超时默认不杀任务。 |
| 数据 | 升级与回滚后 device identity、数据库、模型/集成秘密、Skill 包、Runtime 定义和日志仍符合原契约。 |
| macOS | arm64/x64 分别验证签名、公证、LaunchAgent、多个登录用户、PKG Bootstrap 覆盖升级。 |
| Windows | x64 验证 Authenticode、UAC/MSI MajorUpgrade、HKCU 启动项、多个用户及旧进程路径隔离。 |
| 发布 | 对每个 target 做干净机器首次安装、上一稳定版升级、失败回滚与真实本机 Run；不能以“catalog 已更新”代替验收。 |

## 11. 建议的初始实现边界

第一批代码只实现 Phase 0 和 Phase 1 的最小闭环：**已签名 feed → 严格选择 → 完整 payload staging → drain → 原子切换 → health check → 自动回滚**。这已经解决“按版本自动更新”的核心可靠性问题，且不依赖不安全的系统安装绕过。

内容块、断点恢复和渐进发布在状态机稳定后进入 Phase 2；否则会把传输优化和权限、签名、回滚问题同时引入，难以定位失败边界。

在开始实现前，产品/运维需要确认三项外部前提：生产 Apple Developer ID 与 notarization 流程、Windows 代码签名证书与时间戳服务、以及 stable 渠道默认是“自动下载后任务空闲时自动安装”还是“只提示用户确认”。本设计的默认建议是前者允许自动安装 payload，后者用于 Bootstrap 更新。
