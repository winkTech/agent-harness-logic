# 工具脚本参考

> Agent 配置和管理工具脚本

---

## 性能监控

| 脚本 | 用途 | 命令 |
|------|------|------|
| `perf-monitor.sh` | 检查 Agent 配置性能 | `bash scripts/perf-monitor.sh` |

**检查指标**：
- CLAUDE.md 行数
- 参考文档数量
- 插件数量和缓存
- 知识库文档数
- 启动延迟估算

---

## 知识库管理

| 脚本 | 用途 | 命令 |
|------|------|------|
| `kb-search.sh` | 知识库检索 | `bash scripts/kb-search.sh "关键词"` |

**检索方式**：
- 关键词搜索
- 标签搜索
- 标题搜索
- 相关文档推荐

---

## 记忆管理

| 脚本 | 用途 | 命令 |
|------|------|------|
| `memory-cleanup.sh` | 清理过期记忆 | `bash scripts/memory-cleanup.sh` |
| `memory-retrieve.sh` | 智能检索记忆 | `bash scripts/memory-retrieve.sh "关键词"` |
| `memory-trigger.sh` | 记忆积累触发器 | `bash scripts/memory-trigger.sh <action>` |
| `auto-record-error.sh` | 自动记录错误 | `bash scripts/auto-record-error.sh <类型> <描述> [方案]` |
| `auto-record-success.sh` | 自动记录成功 | `bash scripts/auto-record-success.sh <类型> <描述> [组件]` |

**触发器 actions**：
- `work-start` - 工作开始
- `work-end` - 工作结束
- `daily-review` - 每日回顾
- `weekly-summary` - 每周总结

---

## 插件管理

| 脚本 | 用途 | 命令 |
|------|------|------|
| `plugin-stats.sh` | 插件使用统计 | `bash scripts/plugin-stats.sh` |

**统计内容**：
- 已安装插件列表
- 插件缓存大小
- 插件文件数量
- 插件启用状态

---

## 高级功能

| 脚本 | 用途 | 命令 |
|------|------|------|
| `memory-link.sh` | 记忆关联管理 | `bash scripts/memory-link.sh <action> [参数]` |
| `memory-test.sh` | 记忆系统测试 | `bash scripts/memory-test.sh` |
| `semantic-search.sh` | 语义检索 | `bash scripts/semantic-search.sh "关键词"` |
| `smart-recommend.sh` | 智能推荐 | `bash scripts/smart-recommend.sh "任务描述"` |

**关联管理 actions**：
- `add <记忆A> <记忆B> [描述]` - 添加关联
- `show` - 显示所有关联
- `find <关键词>` - 查找关联
