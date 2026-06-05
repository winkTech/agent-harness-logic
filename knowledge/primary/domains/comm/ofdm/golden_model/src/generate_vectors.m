function generate_vectors(tx_signal, tx_info, cfg)
%% 导出测试向量供 RTL 仿真使用
%  功能:  生成 RTL 输入激励 + 黄金期望输出, 支撑自动化 RTL cosim
%  输出:
%    RTL 输入:
%      freq_i.bin/freq_q.bin — 频域 IFFT 输入 (Q2.14, int16 hex)
%      vector_config.txt     — 仿真参数
%    RTL 黄金期望输出:
%      expected_tx.bin       — 时域 CP 后输出 {Q3.13_I[15:0], Q3.13_Q[15:0]}
%                             (uint32 hex, 匹配 RTL m_axis_tdata 格式)
%  注意:
%    期望输出不做幅度归一化, 直接使用 Q3.13 定点量化以匹配 RTL
%    比对时 RTL TB 使用 ±1 LSB tolerance

    out_dir = '../vectors/';
    if ~exist(out_dir, 'dir')
        mkdir(out_dir);
    end

    % =========================================================================
    % 1. RTL 输入激励: 频域符号 (IFFT输入)
    % =========================================================================
    % 用于驱动 RTL IFFT 输入 (匹配 RTL Q2.14 格式)
    freq = tx_info.freq_grid(:);
    freq_i = round(real(freq) * 32767);
    freq_q = round(imag(freq) * 32767);
    fid_fi = fopen(fullfile(out_dir, 'freq_i.bin'), 'w');
    fid_fq = fopen(fullfile(out_dir, 'freq_q.bin'), 'w');
    fprintf(fid_fi, '%04x\n', typecast(int16(freq_i), 'uint16'));
    fprintf(fid_fq, '%04x\n', typecast(int16(freq_q), 'uint16'));
    fclose(fid_fi); fclose(fid_fq);

    % =========================================================================
    % 2. 黄金期望输出: 时域 IFFT+CP 后, Q3.13 打包 {Q[15:0], I[15:0]}
    % =========================================================================
    % RTL m_axis_tdata = {Q3.13_Q[15:0], Q3.13_I[15:0]}
    % 黄金模型 tx_signal = IFFT+CP 输出 (复数 double)
    % 直接量化到 Q3.13 (保留小数 13-bit), 不额外归一化

    % 时域信号 (CP 已添加, tx_signal 是串行化后的列向量)
    t_i = real(tx_signal);
    t_q = imag(tx_signal);

    % 量化到 Q3.13: 乘以 2^13 = 8192
    q13_scale = 8192;
    t_i_q13 = round(t_i * q13_scale);
    t_q_q13 = round(t_q * q13_scale);

    % Int16 限幅 + 类型转换 (SIMULINK uint16 打包)
    t_i_s16 = int16(max(-32768, min(32767, t_i_q13)));
    t_q_s16 = int16(max(-32768, min(32767, t_q_q13)));

    % 打包为 uint32: {Q_s16[15:0], I_s16[15:0]}
    t_u32 = bitor(bitshift(uint32(typecast(t_q_s16, 'uint16')), 16), ...
                   uint32(typecast(t_i_s16, 'uint16')));

    % 写入黄金期望文件 (hex, 一行一个样点)
    fid_exp = fopen(fullfile(out_dir, 'expected_tx.bin'), 'w');
    fprintf(fid_exp, '%08x\n', t_u32);
    fclose(fid_exp);

    % =========================================================================
    % 3. 参数写入
    % =========================================================================
    fid_cfg = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid_cfg, 'FFT_N=%d\n', cfg.N);
    fprintf(fid_cfg, 'CP_LEN=%d\n', cfg.N_cp);
    fprintf(fid_cfg, 'N_SYM=%d\n', cfg.N_sym);
    fprintf(fid_cfg, 'N_SAMPLES=%d\n', length(tx_signal));
    fprintf(fid_cfg, 'MOD=%s\n', cfg.mod_type);
    fprintf(fid_cfg, 'Q13_SCALE=%d\n', q13_scale);
    fclose(fid_cfg);

    fprintf('[generate_vectors] RTL 激励已写入: %s\n', fullfile(out_dir, ''));
    fprintf('[generate_vectors] 黄金期望输出: expected_tx.bin (%d samples, Q3.13)\n', ...
        length(tx_signal));
end
