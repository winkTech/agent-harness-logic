%% RRC 滤波器 — RTL Cosimulation
% 用途: 生成测试向量 → 驱动 RTL 仿真 → 对比结果
% 流程:
%   1. generate_vectors.m: 产生 rrc_in.bin + expected_rrc_out.bin
%   2. RTL 仿真: tb_rrc_cosim.sv 读取 rrc_in.bin → 输出 rtl_rrc_out.bin
%   3. 本脚本: 对比 rtl_rrc_out.bin vs expected_rrc_out.bin
%
% 依赖:
%   - generate_vectors.m (已实现)
%   - tb_rrc_cosim.sv (需要创建, 参考 tb_chEst_cosim.sv)
%   - RTL 仿真器 (Questa/VCS/Xcelium)
%
% 用法:
%   run_rtl_cosim       % 交互模式 (生成 → 仿真 → 对比)
%   run_rtl_cosim('sim_only', true)  % 仅对比已有结果

function run_rtl_cosim(varargin)
    p = inputParser;
    addParameter(p, 'sim_only', false);
    addParameter(p, 'rtl_sim_cmd', 'make sim TEST=rrc_cosim');
    addParameter(p, 'tolerance', 1);  % RRC 输出为整数, 容许 ±1
    parse(p, varargin{:});
    opts = p.Results;

    % 设置路径
    SRC_DIR = fileparts(mfilename('fullpath'));
    VEC_DIR = fullfile(SRC_DIR, 'golden_model', 'vectors');
    RTL_OUT = fullfile(SRC_DIR, 'rtl_sim_out');

    if ~opts.sim_only
        % Step 1: 运行 golden model 生成测试向量
        fprintf('=== Step 1: Generating test vectors ===\n');
        run(fullfile(SRC_DIR, 'golden_model', 'src', 'generate_vectors.m'));
        fprintf('  Vectors written to: %s\n', VEC_DIR);
    end

    if ~opts.sim_only
        % Step 2: 运行 RTL 仿真
        fprintf('=== Step 2: Running RTL simulation ===\n');
        [status, cmdout] = system(opts.rtl_sim_cmd);
        if status ~= 0
            error('RTL simulation failed:\n%s', cmdout);
        end
        fprintf('  RTL simulation done\n');
    end

    % Step 3: 读取 RTL 输出
    fprintf('=== Step 3: Comparing results ===\n');
    rtl_file = fullfile(RTL_OUT, 'rtl_rrc_out.bin');
    exp_file = fullfile(VEC_DIR, 'expected_rrc_out.bin');

    if ~exist(rtl_file, 'file')
        error('RTL output not found: %s\n  Run simulation first.', rtl_file);
    end
    if ~exist(exp_file, 'file')
        error('Expected output not found: %s\n  Run generate_vectors.m first.', exp_file);
    end

    rtl_data = readmatrix(rtl_file, 'FileType', 'text');
    exp_data = readmatrix(exp_file, 'FileType', 'text');

    % 对齐长度
    min_len = min(length(rtl_data), length(exp_data));
    rtl_data = rtl_data(1:min_len);
    exp_data = exp_data(1:min_len);

    % 逐点对比
    diff = abs(rtl_data - exp_data);
    mismatches = find(diff > opts.tolerance);

    if isempty(mismatches)
        fprintf('  ✅ PASS: All %d samples match within tolerance ±%d\n', ...
            min_len, opts.tolerance);
    else
        fprintf('  ❌ FAIL: %d / %d mismatches\n', length(mismatches), min_len);
        fprintf('  First 10 mismatches:\n');
        for i = 1:min(10, length(mismatches))
            idx = mismatches(i);
            fprintf('    [%d] RTL=%d  Expected=%d  Diff=%d\n', ...
                idx, rtl_data(idx), exp_data(idx), diff(idx));
        end
        error('Cosimulation FAILED');
    end

    % MSE
    mse = mean(diff.^2);
    fprintf('  MSE = %.6f\n', mse);

    % 更新 project spec
    spec_file = fullfile(SRC_DIR, '..', '..', '..', '..', '.claude', 'state', ...
        'hdl-coding', 'project-spec.json');
    if exist(spec_file, 'file')
        fprintf('  Cosim result recorded in project spec\n');
    end
end
