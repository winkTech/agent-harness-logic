# SQLite 持久层

> 位置: `engine/sqlite/`
> 数据库: `~/.claude/.wright/memory.db` (默认, git 不可见)
> 运行时: `node:sqlite` (Node ≥22 内置, 零依赖)

## 架构

```
engine/sqlite/
├── index.cjs           # 统一入口: openDb / closeDb / backupDb
├── schema.cjs          # 迁移管理: 扫描 + 幂等执行
├── migrations/
│   ├── 001-init.cjs    # 全系统初始 DDL
│   └── 004..008        # 事件/事实/作用域/消费者心跳/归因合同
├── store-memory.cjs    # 事实仓库 (scope/trust 过滤 + FTS5 + 链接)
├── store-memory-attribution.cjs # exposure/application/outcome 证据链
├── store-events.cjs    # 运行时事件 + consumer watermark/heartbeat
├── store-skills.cjs    # 技能注册表 (生命周期 + 统计 + 退役)
└── README.md
```

## 用法

### 基本连接

```js
const { openDb, closeAll } = require('./engine/sqlite');

// 默认数据库 (singleton, WAL 模式)
const db = openDb();

// :memory: 模式 (测试用)
const testDb = openDb({ path: ':memory:' });

// 获取统计
console.log(db.stats());
// { path, sizeBytes, pageCount, walMode }

// 关闭
db.close();
closeAll(); // 全关
```

### 记忆操作

```js
const mem = require('./engine/sqlite/store-memory.cjs');

// 写入
const { id } = mem.writeMemory({
  namespace: 'learnings',
  name: 'ldpc-encoding-tips',
  content: 'LDPC 编码时注意 H 矩阵的 girth 值...',
  source: 'manual:verified-learning',
  confidence: 0.9,
  projectId: 'project-<stable-hash>',
  scopeKind: 'path',
  pathScope: 'rtl/ldpc/**',
  triggerKind: 'file_edit',
  triggerSignature: 'ldpc_encoder',
  verificationState: 'verified',
  evidenceRef: 'test:ldpc-regression',
  contractHash: 'sha256:<contract-hash>',
  validUntil: Date.now() + 180 * 86_400_000,
});

// 默认只返回当前 scope 内未过期的 verified 事实
const results = mem.retrieveMemory('LDPC 编码', {
  limit: 3,
  trackHit: false,
  scope: {
    projectId: 'project-<stable-hash>',
    relativePath: 'rtl/ldpc/encoder.sv',
    triggerKind: 'file_edit',
    triggerSignature: 'ldpc_encoder',
  },
});

// 候选或跨作用域只能用于显式审查，不得作为默认 Agent 注入参数
const review = mem.retrieveMemory('LDPC 编码', {
  includeCandidates: true,
  allowCrossScopeReview: true,
  trackHit: false,
});

// 批量写入 (事务)
mem.writeBatch([
  { namespace: 'learnings', name: 'tip-1', content: '...' },
  { namespace: 'learnings', name: 'tip-2', content: '...' },
]);

// 清理过期
const deleted = mem.purgeExpired();

// 统计
console.log(mem.memoryStats());
// { total: 40, confirmed: 25, tentative: 12, low: 3, namespaces: 5 }
```

### 事件操作

```js
const events = require('./engine/sqlite/store-events.cjs');

// 记录事件
events.record({
  sessionId: 's1',
  type: 'tool_fail',
  payload: { tool: 'vlog', error: 'lint 失败' },
});

// 每个消费者独立消费并报告真实执行状态
const watermark = events.getWatermark({ consumer: 'dream' });
const items = events.sinceWatermark(watermark, 100);
events.beginConsumerRun('dream', {
  runId: 'dream-<unique-run-id>',
  processedThrough: watermark,
  pending: items.length,
});
// 仅真实成功消费后先推进独立 watermark，再闭合相同 runId 的 heartbeat
events.setWatermark(42, { consumer: 'dream' });
events.completeConsumerRun('dream', {
  runId: 'dream-<unique-run-id>',
  status: 'success',
  processedThrough: 42,
  processed: items.length,
  pending: 0,
});

// 统计
events.countByType();
// [{ type: 'tool_fail', count: 12 }, { type: 'drift_stuck', count: 5 }]
```

### 技能操作

```js
const skills = require('./engine/sqlite/store-skills.cjs');

// 注册
skills.register('sk_hdl_coding', 'hdl-coding', 'core', 'HDL 编码规范');

// 触发标记
skills.touch('hdl-coding', { success: true, query: '写RTL', durationMs: 45000 });

// 报告
console.log(skills.report());
// [{ name, tier, triggers, successRate, lastUsed }]

// 退役候选 (90 天未使用)
const candidates = skills.decayCandidates(90);
```

## 迁移系统

```
每次 openDb() 自动检查待迁移:
  1. 建 _migrations 追踪表
  2. 扫描 migrations/*.cjs 按文件名排序
  3. 执行未应用的迁移 (事务内, 幂等)
```

添加新迁移时使用下一个未占用序号；不得修改已应用迁移：

```js
module.exports = {
  name: '009-add-columns',
  up: `ALTER TABLE facts ADD COLUMN tags TEXT DEFAULT '[]'`,
};
```

## 设计原则

1. **零外部依赖** — 只用 `node:sqlite` (Node ≥22 内置)
2. **幂等迁移** — 所有 DDL 使用 IF NOT EXISTS
3. **单一逻辑事实层** — Markdown 是可审计来源，SQLite 是检索/事件/归因运行时；通过 stable source identity 对账
4. **注射式 db** — 所有 store 接受 `opts.db` 参数 (测试/共享连接)
5. **WAL 模式** — 并发读写不锁库
6. **同步 API** — DatabaseSync 是同步的, 适合 hook 场景
7. **先过滤后排名** — project/path/trigger/trust 在 SQL 层失败关闭，FTS5/LIKE 只对合格集合排名
8. **命中不等于效果** — hit count 仅是访问统计；效果必须经过 exposure → application → Verification Gate outcome，且不自动主张因果
