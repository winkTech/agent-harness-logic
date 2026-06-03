function generate_vectors(tx_signal, tx_info, cfg)
%% 导出测试向量供 RTL 仿真使用
%  输出: .bin 文件 (十六进制文本)

    out_dir = '../vectors/';
    if ~exist(out_dir, 'dir')
        mkdir(out_dir);
    end

    %% 1. 发射时域信号 (I/Q 交错)
    sig_i = real(tx_signal);
    sig_q = imag(tx_signal);

    % 归一化到16bit范围
    max_val = max(abs([sig_i; sig_q]));
    scale = 32767 / max_val;
    sig_i_scaled = round(sig_i * scale);
    sig_q_scaled = round(sig_q * scale);

    % 写入 I/Q 文件
    fid_i = fopen(fullfile(out_dir, 'tx_i.bin'), 'w');
    fid_q = fopen(fullfile(out_dir, 'tx_q.bin'), 'w');
    fprintf(fid_i, '%04x\n', typecast(int16(sig_i_scaled), 'uint16'));
    fprintf(fid_q, '%04x\n', typecast(int16(sig_q_scaled), 'uint16'));
    fclose(fid_i); fclose(fid_q);

    %% 2. 频域符号 (IFFT输入)
    % 用于 RTL 仿真 IFFT 的激励
    freq = tx_info.freq_grid(:);
    freq_i = round(real(freq) * 32767);
    freq_q = round(imag(freq) * 32767);
    fid_fi = fopen(fullfile(out_dir, 'freq_i.bin'), 'w');
    fid_fq = fopen(fullfile(out_dir, 'freq_q.bin'), 'w');
    fprintf(fid_fi, '%04x\n', typecast(int16(freq_i), 'uint16'));
    fprintf(fid_fq, '%04x\n', typecast(int16(freq_q), 'uint16'));
    fclose(fid_fi); fclose(fid_fq);

    %% 3. 调制符号 (Mod Mapper输出)
    mod = tx_info.mod_sym(:);
    fprintf(fullfile(out_dir, 'mod_ref.bin'), ...
        '写入 %d 个调制符号参考\n', length(mod));

    %% 4. 参数写入
    fid_cfg = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid_cfg, 'FFT_N=%d\n', cfg.N);
    fprintf(fid_cfg, 'CP_LEN=%d\n', cfg.N_cp);
    fprintf(fid_cfg, 'N_SYM=%d\n', cfg.N_sym);
    fprintf(fid_cfg, 'MOD=%s\n', cfg.mod_type);
    fprintf(fid_cfg, 'SCALE=%f\n', scale);
    fclose(fid_cfg);

    fprintf('测试向量已写入: %s\n', fullfile(out_dir, ''));
end
