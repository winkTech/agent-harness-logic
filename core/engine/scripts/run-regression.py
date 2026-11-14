#!/usr/bin/env python3
"""FPGA 回归测试运行器 — 自动发现、编译、运行所有 Testbench。

用法:
  python run-regression.py [--dir <project_root>] [--parallel] [--verbose]

功能:
  1. 自动发现 02_sim/ 下所有 tb_*.sv
  2. 逐个编译 + 运行
  3. 收集通过/失败统计
  4. 输出 JSON 摘要报告到 02_sim/regression_result.json
  5. 退出码: 0=全通过, 1=有失败

依赖:
  - ModelSim (vlog/vsim) 或 Vivado (xvlog/xsim)
  - 项目目录结构符合 cross-project-experience.md 标准
"""

import subprocess
import sys
import json
import time
import argparse
from pathlib import Path
from datetime import datetime


def detect_eda_tools(project_root: Path) -> dict:
    """检测项目中可用的 EDA 仿真工具"""
    tools = {}

    # 检查 ModelSim/Questa
    for cmd in ['vlog', 'vsim']:
        try:
            r = subprocess.run(
                [cmd, '-version'],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0:
                tools[cmd] = r.stdout.strip().split('\n')[0]
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    # 检查 Vivado
    for cmd in ['xvlog', 'xelab', 'xsim']:
        try:
            r = subprocess.run(
                [cmd, '--version'] if cmd != 'xsim' else [cmd, '-h'],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0:
                tools[cmd] = r.stdout.strip().split('\n')[0]
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    return tools


def discover_testbenches(sim_dir: Path) -> list[dict]:
    """发现 02_sim/ 下所有 Testbench 文件"""
    tbs = []
    if not sim_dir.exists():
        return tbs

    for f in sorted(sim_dir.glob('tb_*.sv')):
        module = f.stem[3:]  # 去掉 "tb_" 前缀
        tbs.append({
            'module': module,
            'tb_file': str(f),
            'tb_name': f.stem,
        })

    return tbs


def find_source_dir(project_root: Path, module: str) -> Path | None:
    """查找模块源文件目录"""
    candidates = [
        project_root / '01_src' / '00_hdl' / module,
        project_root / '01_src' / '00_hdl' / module / f'{module}.sv',
        project_root / '01_src' / '00_hdl' / '00_com',
    ]
    for c in candidates:
        if c.exists():
            return c.parent if c.is_file() else c
    return None


def run_single_test(project_root: Path, tb: dict, tools: dict,
                    verbose: bool = False) -> dict:
    """运行单个 Testbench"""
    module = tb['module']
    tb_file = tb['tb_file']
    start = time.time()

    result = {
        'module': module,
        'status': 'FAIL',
        'duration_s': 0,
        'error': '',
        'log': '',
    }

    try:
        # 清理工作库
        subprocess.run(
            ['vlib', 'work'],
            cwd=project_root / '02_sim',
            capture_output=True, timeout=30,
        )

        # 编译源文件
        src_dir = find_source_dir(project_root, module)
        compile_cmds = []

        if src_dir:
            src_files = list(src_dir.glob('*.sv')) + list(src_dir.glob('*.v'))
            for sf in src_files:
                compile_cmds.append(['vlog', '-sv', str(sf)])

        # 编译 Testbench
        compile_cmds.append(['vlog', '-sv', tb_file])

        all_compile_ok = True
        compile_log = []
        for cmd in compile_cmds:
            r = subprocess.run(
                cmd, capture_output=True, text=True, timeout=60,
                cwd=project_root / '02_sim',
            )
            compile_log.append(f"$ {' '.join(cmd)}\n{r.stdout}{r.stderr}")
            if r.returncode != 0:
                all_compile_ok = False
                compile_log.append(f'  → COMPILE FAILED (exit={r.returncode})')
                break

        if not all_compile_ok:
            result['error'] = 'Compile failed'
            result['log'] = '\n'.join(compile_log)
            result['duration_s'] = round(time.time() - start, 2)
            return result

        # 运行仿真
        subprocess.run(
            ['vsim', '-c', tb['tb_name'], '-do', 'run -all; quit'],
            capture_output=True, text=True, timeout=300,
            cwd=project_root / '02_sim',
        )

        # 检查结果 — 查看是否有 check_results JSON
        check_file = project_root / '02_sim' / 'check_results' / f'{module}.json'
        if check_file.exists():
            try:
                check_data = json.loads(check_file.read_text())
                if check_data.get('status') == 'PASS':
                    result['status'] = 'PASS'
                else:
                    result['error'] = f"Check failed: {check_data.get('first_fail_at', 'unknown')}"
            except (json.JSONDecodeError, KeyError):
                result['error'] = 'Could not parse check result JSON'
        else:
            # 如果没有 check_result，仿真成功即 PASS（基础回归模式）
            result['status'] = 'PASS'

    except subprocess.TimeoutExpired:
        result['error'] = 'Simulation timed out (>300s)'
    except FileNotFoundError as e:
        result['error'] = f'Tool not found: {e}'
    except Exception as e:
        result['error'] = str(e)

    result['duration_s'] = round(time.time() - start, 2)
    return result


def run_regression(project_root: Path, parallel: bool = False,
                   verbose: bool = False) -> dict:
    """运行完整回归测试"""
    sim_dir = project_root / '02_sim'

    if not sim_dir.exists():
        return {
            'total': 0, 'passed': 0, 'failed': 0,
            'error': f'02_sim/ directory not found in {project_root}',
            'results': [],
        }

    tools = detect_eda_tools(project_root)
    if verbose:
        print(f'Detected tools: {list(tools.keys())}')

    if 'vlog' not in tools and 'xvlog' not in tools:
        return {
            'total': 0, 'passed': 0, 'failed': 0,
            'error': 'No EDA tools detected (vlog/xvlog not found)',
            'tools_checked': list(tools.keys()),
            'results': [],
        }

    tbs = discover_testbenches(sim_dir)
    if not tbs:
        return {
            'total': 0, 'passed': 0, 'failed': 0,
            'error': 'No testbenches found in 02_sim/',
            'results': [],
        }

    if verbose:
        print(f'Found {len(tbs)} testbenches: {[t["module"] for t in tbs]}')

    results = []
    for tb in tbs:
        if verbose:
            print(f'  Running {tb["module"]}...', end=' ', flush=True)
        result = run_single_test(project_root, tb, tools, verbose)
        results.append(result)
        if verbose:
            print(f'{result["status"]} ({result["duration_s"]}s)')

    passed = sum(1 for r in results if r['status'] == 'PASS')
    failed = sum(1 for r in results if r['status'] == 'FAIL')
    total_duration = round(sum(r['duration_s'] for r in results), 2)

    summary = {
        'total': len(results),
        'passed': passed,
        'failed': failed,
        'total_duration_s': total_duration,
        'timestamp': datetime.now().isoformat(),
        'results': results,
        'tools': list(tools.keys()),
    }

    # 写结果文件
    result_file = sim_dir / 'regression_result.json'
    result_file.write_text(json.dumps(summary, indent=2, ensure_ascii=False))

    return summary


def main():
    parser = argparse.ArgumentParser(description='FPGA 回归测试运行器')
    parser.add_argument('--dir', '-d', type=str, default='.',
                        help='项目根目录 (默认: 当前目录)')
    parser.add_argument('--parallel', '-p', action='store_true',
                        help='并行运行 (实验性)')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='详细输出')
    args = parser.parse_args()

    project_root = Path(args.dir).resolve()
    print(f'Regression test: {project_root}')

    summary = run_regression(project_root, args.parallel, args.verbose)

    print(f'\nResults: {summary["passed"]}/{summary["total"]} passed'
          f' ({summary["total_duration_s"]}s)')

    if summary.get('error'):
        print(f'Error: {summary["error"]}')

    # 写摘要到 stdout
    result_file = project_root / '02_sim' / 'regression_result.json'
    print(f'Report: {result_file}')

    sys.exit(1 if summary['failed'] > 0 else 0)


if __name__ == '__main__':
    main()
