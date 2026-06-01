"""
FPGA工具链工具
"""

import subprocess
from pathlib import Path
from .base import BaseTool
from core.tool_dispatch import Tool


class FpgaTools(BaseTool):
    """FPGA开发工具"""

    def get_tools(self) -> list[Tool]:
        return [
            Tool(
                name="run_vivado",
                description="执行Vivado命令",
                handler=self.run_vivado,
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Vivado命令"},
                        "project": {"type": "string", "description": "项目路径"},
                    },
                    "required": ["command"],
                },
                category="fpga",
            ),
            Tool(
                name="run_modelsim",
                description="执行ModelSim仿真",
                handler=self.run_modelsim,
                parameters={
                    "type": "object",
                    "properties": {
                        "script": {"type": "string", "description": "仿真脚本路径"},
                        "workdir": {"type": "string", "description": "工作目录"},
                    },
                    "required": ["script"],
                },
                category="fpga",
            ),
            Tool(
                name="synthesize",
                description="综合Verilog设计",
                handler=self.synthesize,
                parameters={
                    "type": "object",
                    "properties": {
                        "top_module": {"type": "string", "description": "顶层模块名"},
                        "sources": {"type": "string", "description": "源文件列表（逗号分隔）"},
                    },
                    "required": ["top_module", "sources"],
                },
                category="fpga",
            ),
        ]

    def run_vivado(self, command: str, project: str = None) -> str:
        """执行Vivado命令"""
        try:
            # 构建Vivado命令
            vivado_cmd = "vivado -mode batch"

            if project:
                vivado_cmd += f" -source {project}"

            vivado_cmd += f" -tclargs {command}"

            result = subprocess.run(
                vivado_cmd,
                shell=True,
                cwd=self.workdir,
                capture_output=True,
                text=True,
                timeout=300,
            )

            output = (result.stdout + result.stderr).strip()
            return output[:50000] if output else "(no output)"

        except subprocess.TimeoutExpired:
            return "Error: Vivado timeout (300s)"
        except Exception as e:
            return f"Error: {e}"

    def run_modelsim(self, script: str, workdir: str = None) -> str:
        """执行ModelSim仿真"""
        try:
            # 构建ModelSim命令
            vsim_cmd = f"vsim -c -do {script}"

            result = subprocess.run(
                vsim_cmd,
                shell=True,
                cwd=workdir or self.workdir,
                capture_output=True,
                text=True,
                timeout=600,
            )

            output = (result.stdout + result.stderr).strip()
            return output[:50000] if output else "(no output)"

        except subprocess.TimeoutExpired:
            return "Error: ModelSim timeout (600s)"
        except Exception as e:
            return f"Error: {e}"

    def synthesize(self, top_module: str, sources: str) -> str:
        """综合Verilog设计"""
        try:
            # 构建综合脚本
            source_list = [s.strip() for s in sources.split(',')]

            tcl_script = f"""
# 综合脚本
create_project -in_memory -part xc7a35tcpg236-1

# 添加源文件
"""
            for source in source_list:
                tcl_script += f"add_files {source}\n"

            tcl_script += f"""
# 设置顶层模块
set_property top {top_module} [current_fileset]

# 综合
launch_runs synth_1
wait_on_run synth_1

# 生成报告
open_run synth_1
report_utilization -file utilization.rpt
report_timing_summary -file timing.rpt
"""

            # 保存并执行脚本
            script_path = Path(self.workdir) / "synth.tcl"
            script_path.write_text(tcl_script, encoding="utf-8")

            return self.run_vivado(f"source {script_path}")

        except Exception as e:
            return f"Error: {e}"
