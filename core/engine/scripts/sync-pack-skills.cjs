#!/usr/bin/env node
/**
 * core/engine/scripts/sync-pack-skills.cjs — 【已废弃】转发到 sync-skills.cjs。
 *
 * Phase 1.5（refactor/core-split）起，pack 技能镜像由 sync-skills.cjs 统一投放：
 * 真源 core/skills/ + packs/{fpga,office}/skills/ → 三宿主目录（含 frontmatter
 * 归一）。本脚本保留为兼容 shim（历史调用方与文档引用零破坏），语义映射：
 *   默认（同步镜像） → sync-skills 默认（全量投放，覆盖原 9 目录镜像职责）
 *   --check          → sync-skills --check
 *
 * 退出码透传 sync-skills（0 / 1 漂移 / 2 真源异常）。
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const args = process.argv.slice(2);
const forwarded = [path.join(__dirname, 'sync-skills.cjs'), ...args];
const result = spawnSync(process.execPath, forwarded, { stdio: 'inherit', windowsHide: true });
process.exit(result.status === null ? 2 : result.status);
