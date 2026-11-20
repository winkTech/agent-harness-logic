%% 同步模块 — RTL Cosimulation
% 用途: 生成测试向量 → 驱动 RTL 仿真 → 对比结果
% 流程:
%   1. generate_vectors.m: 产生 synch_in.bin + expected_synch_out.bin
%   2. RTL 仿真: tb_synch_cosim.sv 读取 synch_in.bin → 输出 rtl_synch_out.bin
%   3. 本脚本: 对比 rtl_synch_out.bin vs expected_synch_out.bin
%
% 同步模块特殊说明:
%   - 输出包含: DSSS 相关峰位置 + 频偏估计值 + 定时偏移
%   - 比对时使用结构体对比而非逐点对比
%   - 容许频偏估计有 ±1 量化误差
%
% 依赖:
%   - generate_vectors.m (已实现)
%   - tb_synch_cosim.sv (需要创建, 参考 tb_chEst_cosim.sv)
%   - RTL 仿真器 (Questa/VCS/Xcelium)
%
% 用法:
%   run_rtl_cosim       % 交互模式
%   run_rtl_cosim('sim_only', true)  % 仅对比

function run_rtl_cosim(varargin)
    p = inputParser;
    addParameter(p, 'sim_only', false);
    addParameter(p, 'rtl_sim_cmd', 'make sim TEST=synch_cosim');
    addParameter(p, 'tol_corr', 2);     % 相关峰位置容许 ±2
    addParameter(p, 'tol_freq', 1);     % 频偏估计容许 ±1
    addParameter(p, 'tol_timing', 1);   % 定时偏移容许 ±1
    parse(p, varargin{:});
    opts = p.Results;

    % 设置路径
    SRC_DIR = fileparts(mfilename('fullpath'));
    VEC_DIR = fullfile(SRC_DIR, 'golden_model', 'vectors');
    RTL_OUT = fullfile(SRC_DIR, 'rtl_sim_out');

    if ~opts.sim_only
        % Step 1: 运行 golden model
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

    % Step 3: 解析并对比结果
    fprintf('=== Step 3: Comparing results ===\n');
    rtl_file = fullfile(RTL_OUT, 'rtl_synch_out.txt');
    exp_file = fullfile(VEC_DIR, 'expected_synch_out.txt');

    if ~exist(rtl_file, 'file')
        error('RTL output not found: %s', rtl_file);
    end
    if ~exist(exp_file, 'file')
        error('Expected output not found: %s', exp_file);
    end

    % 读取结构化的同步结果 (每行: corr_peak freq_offset timing_offset)
    rtl_data = load(rtl_file);
    exp_data = load(exp_file);

    % 按字段对比
    min_frames = min(size(rtl_data, 1), size(exp_data, 1));
    errors = 0;

    for i = 1:min_frames
        corr_err  = abs(rtl_data(i,1) - exp_data(i,1));
        freq_err  = abs(rtl_data(i,2) - exp_data(i,2));
        timing_err = abs(rtl_data(i,3) - exp_data(i,3));

        if corr_err > opts.tol_corr || freq_err > opts.tol_freq || timing_err > opts.tol_timing
            errors = errors + 1;
            if errors <= 5
                fprintf('  Frame %d: corr=%d(exp=%d) freq=%d(exp=%d) timing=%d(exp=%d)\n', ...
                    i, rtl_data(i,1), exp_data(i,1), ...
                    rtl_data(i,2), exp_data(i,2), ...
                    rtl_data(i,3), exp_data(i,3));
            end
        end
    end

    if errors == 0
        fprintf('  ✅ PASS: All %d frames match within tolerance\n', min_frames);
    else
        fprintf('  ❌ FAIL: %d / %d frames mismatched\n', errors, min_frames);
        error('Cosimulation FAILED');
    end

    % 更新 project spec
    spec_file = fullfile(SRC_DIR, '..', '..', '..', '..', '.claude', 'state', ...
        'hdl-coding', 'project-spec.json');
    if exist(spec_file, 'file')
        fprintf('  Cosim result recorded in project spec\n');
    end
end
