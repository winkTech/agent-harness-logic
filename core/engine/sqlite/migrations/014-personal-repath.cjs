'use strict';

/**
 * 014-personal-repath — memory/ 状态文件迁 personal/ 的 source_path 重映射（Phase 1.7）。
 *
 * 背景：Phase 1.7 把 harness 根的 memory/ 状态目录整体迁至 personal/
 * （个人状态与框架分家；MEMORY_RULES 与模板已于 1.1 归 core）。
 *
 * 实测口径（与方案 v2.2 修订 A2 的差异——本迁移按实测写）：
 *   - source_key 为 **memory 目录内相对路径**（'agents/x.md'，由对账侧
 *     path.relative(memoryDir, file) 派生）——目录整体改名不改变相对键，
 *     因此 source_key 无需重映射，对账键天然连续；
 *   - source_path 存**绝对路径**（'c:\Users\...\memory\agents\x.md'）——
 *     必须把其中的 \memory\ / /memory/ 段改写为 \personal\ / /personal/，
 *     否则对账的 fileBacked 定位全部指向旧目录。
 *
 * 幂等：只重写仍含 memory 段的行；已重映射/与目录无关的行零触碰。
 * 顺序纪律（方案铁律）：本迁移必须与 memory/ → personal/ 的文件移动
 * **同窗执行**——先移文件再跑本迁移，或同一提交序列内完成。
 */
module.exports = {
  name: '014-personal-repath',
  up(db) {
    // 兼容正反斜杠两种历史写法；大小写盘符均覆盖。
    const remap = (column) => db.prepare(`
      UPDATE facts
      SET ${column} = REPLACE(REPLACE(${column}, '\\memory\\', '\\personal\\'), '/memory/', '/personal/')
      WHERE ${column} IS NOT NULL
        AND (instr(${column}, '\\memory\\') > 0 OR instr(${column}, '/memory/') > 0)
    `).run();

    const pathRows = remap('source_path');
    // source_key 实测为目录内相对键，理论上不含 memory 段；此 UPDATE 仅作
    // 防御性兜底（万一历史上有绝对路径形态的 key），幂等无副作用。
    const keyRows = remap('source_key');

    // stderr 而非 stdout: 迁移会在 hook 进程首次开库时触发, hook 的 stdout
    // 被 Claude Code 当作协议输出解析（与 schema.cjs 迁移日志同一契约）。
    console.error(`[014-personal-repath] source_path 重映射 ${pathRows.changes} 行, source_key 兜底 ${keyRows.changes} 行`);
  },
};
