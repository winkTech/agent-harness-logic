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
│   └── 001-init.cjs    # 全系统初始 DDL (13 张表 + FTS5 + 种子数据)
├── store-memory.cjs    # 记忆仓库 (CRUD + FTS5 + 链接 + 批量/清理)
├── store-events.cjs    # 运行时事件 (Dream 自学习输入源)
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
  source: 'skill:handoff',
  confidence: 0.7,
});

// 检索
const results = mem.retrieveMemory('LDPC 编码', { limit: 5 });
// → FTS5 BM25 排名结果, 自动更新 hit_count

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

// 消费事件 (Dream 用)
const items = events.sinceWatermark(0);     // 水印之后
events.setWatermark(42);                    // 更新水印

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

添加新迁移: `migrations/002-cjk-fts5.cjs`

```js
module.exports = {
  name: '002-add-columns',
  up: `ALTER TABLE facts ADD COLUMN tags TEXT DEFAULT '[]'`,
};
```

## 设计原则

1. **零外部依赖** — 只用 `node:sqlite` (Node ≥22 内置)
2. **幂等迁移** — 所有 DDL 使用 IF NOT EXISTS
3. **双写兼容** — Phase 1 前文件系统 + SQLite 共存
4. **注射式 db** — 所有 store 接受 `opts.db` 参数 (测试/共享连接)
5. **WAL 模式** — 并发读写不锁库
6. **同步 API** — DatabaseSync 是同步的, 适合 hook 场景
7. **FTS5 全文搜索** — 生产用 BM25, 失败降级到 LIKE
