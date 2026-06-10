# Phase 6: 回归覆盖率（原 Phase 5）

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 确保改动不破坏已有功能，覆盖关键功能场景。
> [增强] 必须真跑编译/仿真，不能写文字描述替代。

---

## 回归测试

### 第一步：检查 Makefile

检查 Makefile 是否有 compile/sim/regress 目标：

```
make help          # 列出所有目标
make compile       # 编译所有源文件
make sim           # 运行仿真
make regress       # 全量回归
```

### 第二步：如有完整目标 → 真跑

```
make regress
```

确认所有已有 PASS 的 case 回归不能变 FAIL。

### 第三步：如无完整目标 → 自动生成最小环境

如果 Makefile 缺少 compile/sim 目标：

1. **自动扫描** `01_src/` 下所有 .sv/.v 文件
2. **检测 EDA 工具链**（使用 `eda-detect.cjs`）
3. **生成临时 compile 脚本**（list file 或 do file）
4. **跑一次实际 compile**，确认至少可综合检查通过

**[MUST] 必须真跑编译/仿真。如果 EDA 工具链不可用，至少完成 lint + 语法检查。禁止仅文字描述。**

---

## 覆盖率

- **mandatory**（核心功能路径）— 要求 100% 触发
- **informative**（边界/异常路径）— 提供覆盖率趋势参考，不阻塞审查

**红线规则**:
- 已有 PASS 的 case 回归不能变 FAIL
- Mandatory 覆盖点 < 100% 不能进审查
- 总体功能覆盖率 < 90% 提示"需评估风险"，不强制阻塞

---

## 检查点

`make regress` 全绿（或真实编译/仿真日志），covergroup 全部触发。

**关联 Skill**: `hdl-coding`（仿真流程）
**数据输入**: `.claude/state/hdl-coding/layer-status.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_6
```
