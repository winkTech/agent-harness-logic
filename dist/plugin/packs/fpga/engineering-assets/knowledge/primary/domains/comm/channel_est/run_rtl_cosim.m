%% run_rtl_cosim — ChEst MATLAB→RTL 一键自动对比
%  功能:
%    1. 运行 MATLAB golden model → 生成 RTL 激励 + 黄金期望输出
%    2. 自动检测仿真器 (vsim > xsim) 并启动 RTL 仿真
%    3. 读取 RTL 输出, 与黄金期望逐子载波比对
%    4. 输出 PASS/FAIL + MSE 统计
%
%  用法:
%    run_rtl_cosim                   % 默认 (LS+线性插值, Rayleigh, SNR=20)
%    run_rtl_cosim('ls_dft')         % 指定 DFT 插值
%    run_rtl_cosim('ls_linear', 25)  % 指定方法 + SNR
%    run_rtl_cosim('all')            % 遍历所有方法
%
%  依赖:
%    - MATLAB (运行 golden model)
%    - ModelSim (vsim) 或 Vivado xsim (任一可用)
%    - 文件: config.m, sim_channel.m, ls_channel_est.m
%           rtl/sim/tb_chEst_cosim.sv
%
%  输出:
%    - rtl_cosim_report.txt  — 完整对比报告
%    - vectors/rtl_chEst_out.bin — RTL 仿真输出
%
%  版本: 1.0 | 关联: generate_vectors.m, tb_chEst_cosim.sv, tb_channel_est_top.sv
% ============================================================================

function run_rtl_cosim(est_method, snr_db)
    if nargin < 1, est_method = 'ls_linear'; end
    if nargin < 2, snr_db = 20; end

    fprintf('\n');
    fprintf('============================================================\n');
    fprintf('  ChEst MATLAB→RTL Co-Simulation\n');
    fprintf('  方法: %s, SNR: %d dB\n', est_method, snr_db);
    fprintf('============================================================\n');

    % 路径
    root_dir   = fileparts(mfilename('fullpath'));
    golden_dir = fullfile(root_dir, 'golden_model');
    rtl_dir    = fullfile(root_dir, 'rtl', 'sim');
    vec_dir    = fullfile(golden_dir, 'vectors');
    addpath(genpath(golden_dir));

    % =========================================================================
    % Phase 1: 运行 Golden Model → 生成向量
    % =========================================================================
    if strcmpi(est_method, 'all')
        methods = {'ls_linear', 'ls_dft'};
        fprintf('\n--- 遍历所有估计方法 ---\n');
        for m = 1:length(methods)
            run_rtl_cosim(methods{m}, snr_db);
        end
        return;
    end

    fprintf('\n[Phase 1/3] 运行 MATLAB Golden Model...\n');

    % 固定种子保证可重复性
    rng(42);

    % 加载配置
    cfg = config;
    cfg.est_method = est_method;
    cfg.snr_db     = snr_db;
    cfg.plot_en    = false;
    cfg.save_vectors = false;

    % 添加 M 阶调制 (用于 sim_channel)
    switch lower(cfg.mod)
        case 'bpsk',  cfg.M = 2;
        case 'qpsk',  cfg.M = 4;
        case '16qam', cfg.M = 16;
        case '64qam', cfg.M = 64;
        otherwise,    cfg.M = 16;
    end

    % 运行信道仿真: 生成 Y (接收信号), X (发送符号), H_true
    [H_true, Y, X, ~] = sim_channel(cfg);

    % LS 信道估计
    pilot_val = X(cfg.pilot_idx);
    [H_est_pilot, H_interp] = ls_channel_est(Y, pilot_val, cfg.pilot_idx, cfg.N, ...
        strrep(est_method, 'ls_', ''));

    fprintf('  Golden model 完成: Y 接收信号 %d 子载波\n', length(Y));
    fprintf('  导频 LS 估计: %d 个导频\n', length(H_est_pilot));
    fprintf('  插值後全信道: %d 子载波\n', length(H_interp));

    % 生成测试向量: Y → rx_chEst.bin, H_interp → expected_chEst.bin
    generate_vectors(Y, H_interp, cfg);

    % =========================================================================
    % Phase 2: 启动 RTL 仿真
    % =========================================================================
    fprintf('\n[Phase 2/3] 启动 RTL 仿真...\n');

    golden_file = fullfile(vec_dir, 'expected_chEst.bin');
    if ~exist(golden_file, 'file')
        error('黄金期望输出未生成: %s', golden_file);
    end
    fprintf('  黄金期望文件: %s\n', golden_file);

    sim_status = run_simulation(rtl_dir, vec_dir);

    if sim_status == 0
        fprintf('  RTL 仿真完成\n');
    elseif sim_status == -1
        fprintf('  ⚠ 未检测到仿真器, 跳过 RTL 运行\n');
        fprintf('  手动运行: cd %s && vsim -do run_cosim.do\n', rtl_dir);
    end

    % =========================================================================
    % Phase 3: MATLAB 侧分析 — H_est 逐子载波对比
    % =========================================================================
    fprintf('\n[Phase 3/3] 分析对比结果...\n');

    rtl_file = fullfile(vec_dir, 'rtl_chEst_out.bin');
    if ~exist(rtl_file, 'file')
        fprintf('  ⚠ RTL 输出文件不存在 (仿真未运行)\n');
        fprintf('  将在黄金期望与 RTL 输出间进行离线对比:\n');
        fprintf('    golden:  %s\n', golden_file);
        fprintf('    待生成:  %s\n', rtl_file);
        print_manual_instructions(rtl_dir);
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

    % === 误差统计 (Q2.14 域) ===
    err_i = rtl_i - golden_i;
    err_q = rtl_q - golden_q;

    mse_i  = mean(err_i.^2);
    mse_q  = mean(err_q.^2);
    rmse   = sqrt(mean(err_i.^2 + err_q.^2));
    max_err_i = max(abs(err_i));
    max_err_q = max(abs(err_q));

    % MSE (dB)
    mse_db = 10*log10(mean(err_i.^2 + err_q.^2) / max(mean(golden_i.^2 + golden_q.^2), 1));

    % 逐子载波 pass/fail (tol=3 LSB, 因为插值舍入误差)
    mismatch = (abs(err_i) > 3) | (abs(err_q) > 3);
    mismatch_cnt = sum(mismatch);
    match_cnt = min_len - mismatch_cnt;
    pass_rate = match_cnt / max(min_len, 1) * 100;

    % === 报告 ===
    fprintf('\n');
    fprintf('============================================================\n');
    fprintf('  ChEst Co-Simulation Report\n');
    fprintf('  方法: %s, SNR: %d dB, 子载波: %d\n', est_method, snr_db, min_len);
    fprintf('============================================================\n');
    fprintf('  ✅ Match:        %d / %d (%.1f%%)\n', match_cnt, min_len, pass_rate);
    fprintf('  ❌ Mismatch:     %d\n', mismatch_cnt);
    fprintf('  ─────────────────────────────\n');
    fprintf('  Max |I error|:   %d LSB\n', max_err_i);
    fprintf('  Max |Q error|:   %d LSB\n', max_err_q);
    fprintf('  RMSE:            %.2f LSB\n', rmse);
    fprintf('  MSE (归一化):    %.1f dB\n', mse_db);
    fprintf('============================================================\n');

    % 判定
    threshold_pass = 0.95;  % 95% 匹配率通过 (插值算法允许小幅舍入误差)
    if pass_rate >= threshold_pass * 100
        fprintf('  ⭐ 判定: PASS (匹配率 %.1f%% >= %.0f%%)\n', ...
            pass_rate, threshold_pass*100);
    else
        fprintf('  ❌ 判定: FAIL (匹配率 %.1f%% < %.0f%%)\n', ...
            pass_rate, threshold_pass*100);
        mismatch_idx = find(mismatch);
        fprintf('\n  前10个失配位置 (子载波):\n');
        for k = 1:min(10, length(mismatch_idx))
            idx = mismatch_idx(k);
            fprintf('    SC[%2d] golden=(%6d,%6d) rtl=(%6d,%6d) diff=(%+4d,%+4d)\n', ...
                idx, golden_i(idx), golden_q(idx), ...
                rtl_i(idx), rtl_q(idx), ...
                err_i(idx), err_q(idx));
        end
    end
    fprintf('============================================================\n');

    % === 写入报告文件 ===
    report_file = fullfile(root_dir, 'rtl_cosim_report.txt');
    fid = fopen(report_file, 'w');
    fprintf(fid, 'ChEst MATLAB→RTL Co-Simulation Report\n');
    fprintf(fid, '方法: %s, SNR: %d dB\n', est_method, snr_db);
    fprintf(fid, 'Match: %d/%d (%.1f%%)\n', match_cnt, min_len, pass_rate);
    fprintf(fid, 'Mismatch: %d\n', mismatch_cnt);
    fprintf(fid, 'Max |I error|: %d LSB\n', max_err_i);
    fprintf(fid, 'Max |Q error|: %d LSB\n', max_err_q);
    fprintf(fid, 'RMSE: %.2f LSB\n', rmse);
    fprintf(fid, 'MSE (norm): %.1f dB\n', mse_db);
    fprintf(fid, '判定: %s\n', string(pass_rate >= threshold_pass * 100));
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

    [code_vsim, ~] = system('where vsim 2>nul >nul');
    vsim_ok = (code_vsim == 0);

    [code_xsim, ~] = system('where xsim 2>nul >nul');
    xsim_ok = (code_xsim == 0);

    if vsim_ok
        fprintf('  检测到 ModelSim\n');
        old_dir = cd(rtl_dir);
        % 向量权威位置 = models/comm/channel_est/vectors/（治理规范 §5.5 V-1）。
        % 原值 ../../golden_model/vectors/ 指向的目录从未存在, 该 cosim 一直是死路径。
        % 由 root_dir 上溯到 engineering-assets 再下行, 避免脆弱的多级相对路径:
        %   root_dir = <ea>/knowledge/primary/domains/comm/channel_est  → 上溯 5 级
        % 该目录当前为空(向量未由 MATLAB 导出), TB 会 fail-closed —— 这是正确行为:
        % 向量到位前不得产出可作门禁证据的 PASS。
        vec_dir = fullfile(root_dir, '..', '..', '..', '..', '..', ...
                           'models', 'comm', 'channel_est', 'vectors');
        cmd = ['vsim -c -novopt -suppress 12110 +VEC_DIR=' strrep(vec_dir, '\', '/') '/ ' ...
               '-do "vsim work.tb_chEst_cosim; run -all; quit"'];
        fprintf('  执行: %s\n', cmd);
        [run_code, ~] = system(char(cmd));
        cd(old_dir);
        if run_code == 0, status = 0; end
    elseif xsim_ok
        fprintf('  检测到 Vivado xsim\n');
        old_dir = cd(rtl_dir);
        cmd = 'xsim tb_chEst_cosim --runall';
        fprintf('  执行: %s\n', cmd);
        run_code = system(cmd);
        cd(old_dir);
        if run_code == 0, status = 0; end
    else
        fprintf('  未检测到仿真器 (需要 vsim 或 xsim)\n');
    end
end

function print_manual_instructions(rtl_dir)
    fprintf('\n');
    fprintf('┌─────────────────────────────────────────────────────────┐\n');
    fprintf('│  手动 RTL 仿真步骤                                      │\n');
    fprintf('│                                                         │\n');
    fprintf('│  cd %s │\n', rtl_dir);
    fprintf('│  vsim -do "vsim work.tb_chEst_cosim; run -all; quit"    │\n');
    fprintf('│                                                         │\n');
    fprintf('│  完成后重新运行: run_rtl_cosim                           │\n');
    fprintf('└─────────────────────────────────────────────────────────┘\n');
end
