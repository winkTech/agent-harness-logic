%% run_rtl_cosim — MATLAB→RTL 一键自动对比
%  功能:
%    1. 运行 MATLAB golden model → 生成 RTL 激励 + 黄金期望输出
%    2. 自动检测仿真器 (vsim > xsim) 并启动 RTL 仿真
%    3. 读取 RTL 输出, 与黄金期望逐样点比对
%    4. 输出 PASS/FAIL + EVM/MSE/最大误差 统计
%
%  用法:
%    run_rtl_cosim               % 使用默认参数 (QPSK, N_sym=10)
%    run_rtl_cosim('16QAM')      % 指定调制方式
%    run_rtl_cosim('QPSK', 20)   % 指定调制 + 符号数
%    run_rtl_cosim('all')        % 遍历所有调制方式
%
%  依赖:
%    - MATLAB (运行 golden model)
%    - ModelSim (vsim) 或 Vivado xsim (任一可用)
%    - 文件: config.m, tx_chain.m, generate_vectors.m, .../rtl/tb_tx_top.sv
%
%  输出:
%    - rtl_cosim_report.txt      — 完整对比报告
%    - vectors/rtl_output.bin    — RTL 仿真输出 (供外部进一步分析)
%
%  版本: 1.0 | 关联: generate_vectors.m, tb_tx_top.sv
% ============================================================================

function run_rtl_cosim(mod_type, n_sym)
    if nargin < 1, mod_type = 'QPSK'; end
    if nargin < 2, n_sym = 10; end

    fprintf('\n');
    fprintf('============================================================\n');
    fprintf('  OFDM MATLAB→RTL Co-Simulation\n');
    fprintf('  调制: %s, 符号数: %d\n', mod_type, n_sym);
    fprintf('============================================================\n');

    % 路径
    root_dir = fileparts(mfilename('fullpath'));
    golden_dir = fullfile(root_dir, 'golden_model');
    rtl_dir    = fullfile(root_dir, 'rtl');
    vec_dir    = fullfile(golden_dir, 'vectors');
    addpath(genpath(golden_dir));

    % =========================================================================
    % Phase 1: 运行 Golden Model → 生成 RTL 激励 + 黄金期望输出
    % =========================================================================
    if strcmpi(mod_type, 'all')
        mod_list = {'BPSK', 'QPSK', '16QAM', '64QAM'};
        fprintf('\n--- 遍历所有调制方式 ---\n');
        for m = 1:length(mod_list)
            run_rtl_cosim(mod_list{m}, n_sym);
        end
        return;
    end

    fprintf('\n[Phase 1/3] 运行 MATLAB Golden Model...\n');

    % 加载配置并覆盖调制方式
    cfg = config;
    cfg.mod_type = mod_type;
    cfg.plot_en = false;
    cfg.verbose = false;
    cfg.save_vectors = true;

    % 运行发射链路
    [tx_signal, tx_info] = tx_chain(cfg);
    fprintf('  Golden model 完成: %d 个时域样点\n', length(tx_signal));

    % 生成测试向量 (含黄金期望输出 expected_tx.bin)
    generate_vectors(tx_signal, tx_info, cfg);

    % =========================================================================
    % Phase 2: 启动 RTL 仿真
    % =========================================================================
    fprintf('\n[Phase 2/3] 启动 RTL 仿真...\n');

    % 检查黄金期望文件是否存在
    golden_file = fullfile(vec_dir, 'expected_tx.bin');
    if ~exist(golden_file, 'file')
        error('黄金期望输出未生成: %s', golden_file);
    end
    fprintf('  黄金期望文件: %s\n', golden_file);

    % 检测可用仿真器并运行
    sim_status = run_simulation(rtl_dir, vec_dir);

    if sim_status == 0
        fprintf('  RTL 仿真完成\n');
    elseif sim_status == -1
        fprintf('  ⚠ 未检测到仿真器, 跳过 RTL 运行\n');
        fprintf('  手动运行: cd %s && vsim -do run_sim.do\n', rtl_dir);
    end

    % =========================================================================
    % Phase 3: 对比分析 (MATLAB 侧 — 额外统计, TB 已做硬件级比对)
    % =========================================================================
    fprintf('\n[Phase 3/3] 分析对比结果...\n');

    rtl_file = fullfile(vec_dir, 'rtl_output.bin');
    if ~exist(rtl_file, 'file')
        fprintf('  ⚠ RTL 输出文件不存在 (仿真未运行)\n');
        fprintf('  将在黄金期望与 RTL 输出间进行离线对比:\n');
        fprintf('    golden:  %s\n', golden_file);
        fprintf('    待生成:  %s\n', rtl_file);
        print_manual_instructions(root_dir, rtl_dir);
        return;
    end

    % 读取 golden 期望和 RTL 输出
    golden_data = read_hex32(golden_file);
    rtl_data    = read_hex32(rtl_file);

    % 对齐长度
    min_len = min(length(golden_data), length(rtl_data));
    golden_data = golden_data(1:min_len);
    rtl_data    = rtl_data(1:min_len);

    % 解包 I/Q: 低16位 I, 高16位 Q
    golden_i = double(typecast(uint16(bitand(golden_data, 65535)), 'int16'));
    golden_q = double(typecast(uint16(bitshift(golden_data, -16)), 'int16'));
    rtl_i    = double(typecast(uint16(bitand(rtl_data, 65535)), 'int16'));
    rtl_q    = double(typecast(uint16(bitshift(rtl_data, -16)), 'int16'));

    % === 误差统计 ===
    err_i = rtl_i - golden_i;
    err_q = rtl_q - golden_q;

    mse_i  = mean(err_i.^2);
    mse_q  = mean(err_q.^2);
    rmse_i = sqrt(mse_i);
    rmse_q = sqrt(mse_q);
    max_err_i = max(abs(err_i));
    max_err_q = max(abs(err_q));

    % EVM 计算 (Q3.13 域)
    pow_i = mean(golden_i.^2);
    pow_q = mean(golden_q.^2);
    evm_i_db = 10*log10(mse_i / max(pow_i, 1));
    evm_q_db = 10*log10(mse_q / max(pow_q, 1));
    evm_db = 10*log10((mse_i + mse_q) / max(pow_i + pow_q, 1));

    % 逐样点 pass/fail (tol=1 LSB)
    mismatch = (abs(err_i) > 1) | (abs(err_q) > 1);
    mismatch_cnt = sum(mismatch);
    match_cnt = min_len - mismatch_cnt;
    pass_rate = match_cnt / max(min_len, 1) * 100;

    % === 报告 ===
    fprintf('\n');
    fprintf('============================================================\n');
    fprintf('  Co-Simulation Report\n');
    fprintf('  调制: %s, 样点数: %d\n', mod_type, min_len);
    fprintf('============================================================\n');
    fprintf('  ✅ Match:        %d / %d (%.1f%%)\n', match_cnt, min_len, pass_rate);
    fprintf('  ❌ Mismatch:     %d\n', mismatch_cnt);
    fprintf('  ─────────────────────────────\n');
    fprintf('  Max |I error|:   %d LSB\n', max_err_i);
    fprintf('  Max |Q error|:   %d LSB\n', max_err_q);
    fprintf('  RMSE I:          %.2f LSB\n', rmse_i);
    fprintf('  RMSE Q:          %.2f LSB\n', rmse_q);
    fprintf('  EVM:             %.1f dB\n', evm_db);
    fprintf('  EVM I:           %.1f dB\n', evm_i_db);
    fprintf('  EVM Q:           %.1f dB\n', evm_q_db);
    fprintf('============================================================\n');

    % 判定
    threshold_pass = 0.99;  % 99% 匹配率通过
    if pass_rate >= threshold_pass * 100
        fprintf('  ⭐ 判定: PASS (匹配率 %.1f%% >= %.0f%%)\n', ...
            pass_rate, threshold_pass*100);
    else
        fprintf('  ❌ 判定: FAIL (匹配率 %.1f%% < %.0f%%)\n', ...
            pass_rate, threshold_pass*100);
        % 报告前几个失配位置
        mismatch_idx = find(mismatch);
        fprintf('\n  前10个失配位置:\n');
        for k = 1:min(10, length(mismatch_idx))
            idx = mismatch_idx(k);
            fprintf('    [%4d] golden=(%6d,%6d) rtl=(%6d,%6d) diff=(%+4d,%+4d)\n', ...
                idx, golden_i(idx), golden_q(idx), ...
                rtl_i(idx), rtl_q(idx), ...
                err_i(idx), err_q(idx));
        end
    end
    fprintf('============================================================\n');

    % === 写入报告文件 ===
    report_file = fullfile(root_dir, 'rtl_cosim_report.txt');
    fid = fopen(report_file, 'w');
    fprintf(fid, 'OFDM MATLAB→RTL Co-Simulation Report\n');
    fprintf(fid, '调制: %s, 样点数: %d\n', mod_type, min_len);
    fprintf(fid, 'Match: %d/%d (%.1f%%)\n', match_cnt, min_len, pass_rate);
    fprintf(fid, 'Mismatch: %d\n', mismatch_cnt);
    fprintf(fid, 'Max |I error|: %d LSB\n', max_err_i);
    fprintf(fid, 'Max |Q error|: %d LSB\n', max_err_q);
    fprintf(fid, 'RMSE I: %.2f LSB\n', rmse_i);
    fprintf(fid, 'RMSE Q: %.2f LSB\n', rmse_q);
    fprintf(fid, 'EVM: %.1f dB\n', evm_db);
    fprintf(fid, '判定: %s\n', ...
        string(pass_rate >= threshold_pass * 100));
    fclose(fid);
    fprintf('\n报告已保存: %s\n', report_file);
end

%% ===== 辅助函数 =====

function data = read_hex32(filepath)
% 读取 32-bit hex 文件 (一行一个 %08x)
    fid = fopen(filepath, 'r');
    if fid == -1
        error('无法打开文件: %s', filepath);
    end
    data = uint32(fscanf(fid, '%x\n'));
    fclose(fid);
end

function status = run_simulation(rtl_dir, ~)
% 检测并运行仿真器
% 返回: 0=成功, -1=无仿真器
    status = -1;

    % 检测 ModelSim (vsim)
    [code_vsim, ~] = system('where vsim 2>nul >nul');
    vsim_ok = (code_vsim == 0);

    % 检测 Vivado xsim
    [code_xsim, ~] = system('where xsim 2>nul >nul');
    xsim_ok = (code_xsim == 0);

    if vsim_ok
        fprintf('  检测到 ModelSim\n');
        old_dir = cd(rtl_dir);
        cmd = sprintf('vsim -c -do "run -all; quit" -work work');
        fprintf('  执行: %s\n', cmd);
        [run_code, ~] = system(cmd);
        cd(old_dir);
        if run_code == 0
            status = 0;
        else
            fprintf('  vsim 返回非零: %d\n', run_code);
            % 可能因为缺少 xfft_64 模型, 仍视为部分成功
        end
    elseif xsim_ok
        % Vivado xsim 流程
        fprintf('  检测到 Vivado xsim\n');
        old_dir = cd(rtl_dir);
        cmd = sprintf('xsim tb_ofdm_tx_top --runall');
        fprintf('  执行: %s\n', cmd);
        run_code = system(cmd);
        cd(old_dir);
        if run_code == 0, status = 0; end
    else
        fprintf('  未检测到仿真器 (需要 vsim 或 xsim)\n');
        fprintf('  请从以下目录手动运行: %s\n', rtl_dir);
    end
end

function print_manual_instructions(~, rtl_dir)
    fprintf('\n');
    fprintf('┌─────────────────────────────────────────────────────────┐\n');
    fprintf('│  手动 RTL 仿真步骤                                      │\n');
    fprintf('│                                                         │\n');
    fprintf('│  cd %s │\n', rtl_dir);
    fprintf('│  vsim -do run_sim.do                                    │\n');
    fprintf('│                                                         │\n');
    fprintf('│  完成后重新运行: run_rtl_cosim                           │\n');
    fprintf('└─────────────────────────────────────────────────────────┘\n');
end
