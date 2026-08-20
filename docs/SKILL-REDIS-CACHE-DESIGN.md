# Skill Redis Cache 修改方案

## 目标

在不改变 Skill 授权、`load_skill` 证据链、Package 完整性校验语义的前提下，引入 Redis 作为加速缓存，降低高频 Run 中重复读取 Skill 元数据、正文和重复 inspect Package 的成本。

核心约束：

- Redis 只能是缓存层，不能成为 Skill 权威源。
- `load_skill` 仍必须在当前 Run/Step 中产生 ToolResult，作为 Skill 激活和后续 Assessment 的 canonical evidence。
- compaction 后如果旧 `load_skill` ToolResult 离开近期尾部，仍必须重新执行 `load_skill`，不能用 Redis 或摘要替代。
- 所有缓存读取前必须先通过 owner、Plan Step、Capability Grant 授权，不能按 Skill name 直接取正文。

## 当前链路

当前实现中，`load_skill` 并不是每次直接读 `SKILL.md`：

1. `SkillService.refreshSkillDirectory()` 发现正式 `skills/` 目录。
2. `SkillService.provisionDiscovered(ownerUserId)` 将发现到的 Skill 物化为当前用户隔离的只读 Package，并把 `instructions`、`contentHash`、`packageHash` 等元数据写入 DB。
3. `RunService` 在 Run/Plan/Step 边界调用 `resolveForConversation()` 或 `getMany()` 取得 `PrivateSkill`。
4. `createSkillLoader(stepSkills)` 用当前 Step 已授权的 `PrivateSkill` 构造 `load_skill` Tool。
5. 模型调用 `load_skill({name})` 后，Runtime 返回 `formatLoadedSkill(skill)`，该 ToolResult 进入当前 Run transcript。

真正可能重复消耗较高的位置：

- `resolveForConversation()` 多次从 DB 读取同一用户 Skill 列表和正文。
- `assertIntegrity()` 对 package Skill 多次 `inspectSkillPackage()`，重复遍历文件、计算 package hash。
- compaction 后重新 `load_skill` 是正确行为，但其背后的正文格式化可以使用缓存。

## 设计原则

### 权威边界

| 数据 | 权威源 | Redis 角色 |
| --- | --- | --- |
| Skill owner、version、授权关系 | DB/PostgreSQL | 可缓存查询结果，但必须可回源 |
| Skill package/object bytes | 只读 Package Store / Object Storage | 可缓存正文或 hash 校验结果 |
| Run transcript、ToolResult、Assessment | DB/Event Store | 不缓存为权威 |
| `load_skill` 激活状态 | 当前 Run transcript + context tail | 不由 Redis 判定 |
| Package 完整性结论 | packageHash + immutable storage | 可缓存正向校验结果 |

Redis 故障时系统应该退化为回源读取和重新校验，不能导致授权扩大、Skill 消失、或错误地跳过 `load_skill`。

### 缓存 key 必须版本化

禁止使用裸 `skillName` 作为正文缓存 key。推荐 key：

```text
agentloop:skill:private:v1:{ownerUserId}:{skillId}:{version}:{contentHash}
agentloop:skill:loaded:v1:{skillId}:{version}:{contentHash}:{packageHashOrInline}
agentloop:skill:integrity:v1:{packageHash}
agentloop:skill:catalog:v1:{ownerUserId}:{catalogRevision}
```

其中：

- `skillId/version/contentHash` 决定正文不可混用。
- `ownerUserId` 只用于用户目录/查询结果缓存；具体正文缓存仍必须在授权后读取。
- `packageHash` 适合做 immutable package 的完整性正向缓存。
- `catalogRevision` 可以先用用户 Skill 最大 `updatedAt` + 数量拼接生成，后续迁移到显式 revision。

## 修改范围

### 1. 新增缓存接口

新增 `src/skills/skill-cache.ts`：

```ts
export interface SkillCache {
  getPrivateSkill(key: SkillPrivateCacheKey): Promise<CachedPrivateSkill | undefined>;
  setPrivateSkill(key: SkillPrivateCacheKey, value: CachedPrivateSkill, ttlMs: number): Promise<void>;

  getLoadedSkill(key: SkillLoadedCacheKey): Promise<string | undefined>;
  setLoadedSkill(key: SkillLoadedCacheKey, value: string, ttlMs: number): Promise<void>;

  getIntegrity(packageHash: string): Promise<CachedIntegrity | undefined>;
  setIntegrity(packageHash: string, value: CachedIntegrity, ttlMs: number): Promise<void>;
}
```

同时提供：

- `NoopSkillCache`：默认实现，不引入 Redis 时保持当前行为。
- `MemorySkillCache`：用于单进程开发和测试。
- `RedisSkillCache`：生产可选实现。

### 2. SkillService 接入缓存

`SkillServiceOptions` 增加：

```ts
readonly cache?: SkillCache;
readonly cachePolicy?: {
  readonly privateSkillTtlMs?: number;
  readonly loadedSkillTtlMs?: number;
  readonly integrityTtlMs?: number;
};
```

接入点：

- `get(ownerUserId, skillId)`：DB 仍负责 owner 校验；可在 DB 命中后写入正文缓存。若要读缓存，必须先确认该 `skillId` 属于 `ownerUserId`。
- `getMany(ownerUserId, skillIds)`：先按授权 ID 集合批量读取，后续可优化为 repository 批量 SQL。
- `resolveForConversation(ownerUserId)`：可缓存用户 Skill catalog summary，但正文仍按授权结果加载。
- `assertIntegrity(skills)`：对于 package Skill，若 `integrity:{packageHash}` 命中且 package root/object key 与记录一致，可以跳过本次文件遍历；miss 时执行现有 `inspectSkillPackage()`，校验通过后写入 Redis。

注意：`assertIntegrity()` 的缓存只能缓存“同 hash immutable package 校验通过”。如果当前部署的 package store 允许原地修改，TTL 必须很短，或者禁用该缓存。

### 3. `load_skill` 输出缓存

`formatLoadedSkill(skill)` 是纯格式化，可以缓存完整 ToolResult 字符串：

```text
agentloop:skill:loaded:v1:{skillId}:{version}:{contentHash}:{packageHashOrInline}
```

但 `createSkillLoader()` 的语义不变：

1. 先从当前 Step 的 `byName` 找到 Skill。
2. 再校验 `context.grant.allowedSkillIds.has(skill.id)`。
3. 然后才读缓存或格式化。
4. 返回值仍作为本次 `load_skill` ToolResult 写入 transcript。

这样 Redis 只减少格式化和大正文传递前的对象构造成本，不替代 ToolResult 证据。

### 4. Redis 配置

新增环境变量：

```text
REDIS_URL=redis://127.0.0.1:6379
SKILL_CACHE_ENABLED=1
SKILL_CACHE_PRIVATE_TTL_MS=300000
SKILL_CACHE_LOADED_TTL_MS=3600000
SKILL_CACHE_INTEGRITY_TTL_MS=3600000
```

默认：

- 未配置 `REDIS_URL` 或 `SKILL_CACHE_ENABLED` 不为 `1` 时使用 `NoopSkillCache`。
- Redis 连接失败时记录 warning，并降级 `NoopSkillCache`。
- 不因为 Redis 写失败中断 Run。

### 5. 可观测性

新增 Runtime/服务日志指标：

- `skill.cache.private.hit/miss`
- `skill.cache.loaded.hit/miss`
- `skill.cache.integrity.hit/miss`
- `skill.cache.error`
- `skill.integrity.inspect.duration_ms`
- `load_skill.result.bytes`

这些指标用于判断缓存是否真的减少重复读取和 inspect 成本。

## 失效策略

### Inline Skill

Inline Skill 修改会产生新 version/contentHash。旧 key 自然失效，不需要主动删除。

### Package Skill

Package Skill 的缓存 key 包含 packageHash。只读 immutable package 场景下：

- packageHash 不变则可复用完整性缓存。
- packageHash 变化即产生新 key。

如果保留本地 Package Store 原地可变能力，则必须：

- 保留现有 `assertIntegrity()` 周期性真实校验，或
- 将 integrity TTL 设置很短，或
- 只对对象存储 immutable key 开启长 TTL。

### Directory Discovery

目录发现缓存不能掩盖目录变更。推荐第一阶段不缓存 `discoverSkillDirectory()` 结果，只缓存已物化后的用户 Skill 读取和 package integrity。

## 分阶段实施

### Phase 1：接口与本地缓存

- 新增 `SkillCache`、`NoopSkillCache`、`MemorySkillCache`。
- `SkillService` 注入 cache，但默认 Noop。
- 对 `formatLoadedSkill()` 结果和 `assertIntegrity()` 正向结果做缓存。
- 添加单元测试证明 Noop 行为不变、Memory 命中后仍要求 `load_skill` ToolResult。

### Phase 2：Redis 实现

- 引入 Redis 客户端封装，连接失败降级。
- 实现 JSON 序列化、TTL、key 前缀。
- 加配置和日志指标。
- 测试 Redis miss/hit/error 降级。

### Phase 3：生产化与压测

- 用真实大 Skill Package 做压测，比较：
  - `assertIntegrity()` 耗时
  - `resolveForConversation()` 耗时
  - Run 中 `load_skill` 相关 action 延迟
  - Redis hit rate
- 根据数据决定是否缓存 catalog summary。

## 回归测试要求

必须覆盖以下行为：

1. Redis 命中时，未授权用户仍无法加载 Skill。
2. Redis 命中时，当前 Step 未绑定的 Skill 仍无法通过 `load_skill` 读取。
3. compaction 后，旧 Skill activation 失效，下一轮仍必须重新 `load_skill`。
4. `load_skill` ToolResult 内容与未缓存路径完全一致，包括 `sha256`、package metadata、base directory。
5. packageHash 变化后不能使用旧 integrity 缓存。
6. Redis 不可用时 Run 可继续，语义与 Noop 缓存一致。
7. Assessment 仍只评估 actually activated Skills，不能因为 Redis 中存在正文就进入 `skill_compliance_assessments.skills`。

## 不做事项

- 不把 Redis 作为 Run/Event/Assessment 的权威存储。
- 不跳过当前 Run 的 `load_skill` ToolCall。
- 不用 Redis 保存 Skill activation lease。
- 不把 compaction summary 里的 Skill 摘要提升为 Skill 正文。
- 不按 Skill name 跨用户共享正文读取结果。
- 不为某个具体 Skill 或业务场景加硬编码缓存逻辑。

## 推荐落点

第一版最小可交付修改：

1. `src/skills/skill-cache.ts`：定义接口和 Noop/Memory 实现。
2. `src/skills/skill-service.ts`：注入 cache；缓存 `assertIntegrity()` 正向结果。
3. `src/skills/skill-context.ts` 或 `RunService.createSkillLoader()` 附近：缓存 `formatLoadedSkill()` 输出，但保留授权校验顺序。
4. `tests/skill-cache.test.ts` 或扩展 `tests/skill-package.test.ts`：覆盖授权、cache hit、integrity hash 变化和 Noop 降级。

第一版先不接 Redis 网络客户端也可以，先把缓存边界和测试立住；第二版再加 `RedisSkillCache`。
