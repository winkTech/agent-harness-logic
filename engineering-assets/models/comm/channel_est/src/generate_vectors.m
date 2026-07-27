function generate_vectors(Y, H_interp, cfg)
%% 导出信道估计 RTL 仿真测试向量
%  功能:  生成 RTL 输入激励 + 黄金期望输出, 支撑自动化 RTL cosim
%  输入:
%    Y        — 接收频域信号 [N×1 complex] (含导频)
%    H_interp — 黄金信道估计 [N×1 complex]
%    cfg      — 配置结构体 (.N, .pilot_idx, .est_method, .mod)
%
%  输出文件 (到 ../vectors/):
%    rx_chEst.bin          — RTL 输入: Y 信号 (Q2.14, 64 子载波)
%    expected_chEst.bin    — 黄金期望: H_interp (Q2.14, packed {Q[15:0], I[15:0]})
%    vector_config.txt     — 仿真参数
%
%  格式约定:
%    Q2.14: 乘以 2^14 = 16384, int16 限幅
%    {Q_s16[15:0], I_s16[15:0]} 打包为 uint32 hex (一行一个样点)
%
%  关联: run_rtl_cosim.m, tb_channel_est_top.sv

    out_dir = '../vectors/';
    if ~exist(out_dir, 'dir')
        mkdir(out_dir);
    end

    Q14_SCALE = 16384;

    % =========================================================================
    % 1. RTL 输入激励: 接收频域信号 Y
    % =========================================================================
    % RTL channel_est_top 通过 AXI-Stream 接收 Y (64 个子载波, 逐个时钟)
    Y_i = round(real(Y) * Q14_SCALE);
    Y_q = round(imag(Y) * Q14_SCALE);
    Y_i_s16 = int16(max(-32768, min(32767, Y_i)));
    Y_q_s16 = int16(max(-32768, min(32767, Y_q)));

    % 打包 {Q[15:0], I[15:0]}
    Y_u32 = bitor(bitshift(uint32(typecast(Y_q_s16, 'uint16')), 16), ...
                   uint32(typecast(Y_i_s16, 'uint16')));

    fid_y = fopen(fullfile(out_dir, 'rx_chEst.bin'), 'w');
    fprintf(fid_y, '%08x\n', Y_u32);
    fclose(fid_y);
    fprintf('[generate_vectors] RTL 激励已写入: rx_chEst.bin (%d subcarriers, Q2.14)\n', ...
        length(Y));

    % =========================================================================
    % 2. 黄金期望输出: 信道估计 H_interp
    % =========================================================================
    H_i = round(real(H_interp) * Q14_SCALE);
    H_q = round(imag(H_interp) * Q14_SCALE);
    H_i_s16 = int16(max(-32768, min(32767, H_i)));
    H_q_s16 = int16(max(-32768, min(32767, H_q)));

    H_u32 = bitor(bitshift(uint32(typecast(H_q_s16, 'uint16')), 16), ...
                   uint32(typecast(H_i_s16, 'uint16')));

    fid_exp = fopen(fullfile(out_dir, 'expected_chEst.bin'), 'w');
    fprintf(fid_exp, '%08x\n', H_u32);
    fclose(fid_exp);
    fprintf('[generate_vectors] 黄金期望输出: expected_chEst.bin (%d subcarriers, Q2.14)\n', ...
        length(H_interp));

    % =========================================================================
    % 3. 参数写入
    % =========================================================================
    fid_cfg = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid_cfg, 'N_FFT=%d\n', cfg.N);
    fprintf(fid_cfg, 'N_PILOT=%d\n', length(cfg.pilot_idx));
    fprintf(fid_cfg, 'PILOT_IDX=%s\n', mat2str(cfg.pilot_idx));
    fprintf(fid_cfg, 'EST_METHOD=%s\n', cfg.est_method);
    fprintf(fid_cfg, 'MOD=%s\n', cfg.mod);
    fprintf(fid_cfg, 'SNR_DB=%.1f\n', cfg.snr_db);
    fprintf(fid_cfg, 'CHANNEL=%s\n', cfg.channel_type);
    fprintf(fid_cfg, 'Q14_SCALE=%d\n', Q14_SCALE);
    fclose(fid_cfg);

    fprintf('[generate_vectors] 参数已写入: vector_config.txt\n');
end
