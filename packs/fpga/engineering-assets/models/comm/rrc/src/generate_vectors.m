function generate_vectors(x_in, y_quant, cfg)
%% 导出 RRC 测试向量供 RTL 仿真使用
%  输出:
%    RTL 激励:   rrc_stimulus.bin — {Q[15:0], I[15:0]} 32-bit hex (Q2.14)
%    黄金期望:   expected_tx.bin  — RRC 滤波后输出 {Q[15:0], I[15:0]} (Q2.14)
%    参数文件:   vector_config.txt
% ============================================================================

    out_dir = '../vectors/';
    if ~exist(out_dir, 'dir')
        mkdir(out_dir);
    end

    % RRC 输出是 Q2.14, 无需归一化, 直接打包
    % RTL 格式: m_axis_tdata = {Q[15:0], I[15:0]}

    %% 1. 激励 (输入符号)
    n_in = min(length(x_in), 2048);
    stim_packed = zeros(n_in, 1, 'uint32');
    for i = 1:n_in
        i_s16 = int16(round(real(x_in(i)) * 2^14));
        q_s16 = int16(round(imag(x_in(i)) * 2^14));
        stim_packed(i) = bitor(bitshift(uint32(typecast(q_s16, 'uint16')), 16), ...
                                uint32(typecast(i_s16, 'uint16')));
    end
    fid_stim = fopen(fullfile(out_dir, 'rrc_stimulus.bin'), 'w');
    fprintf(fid_stim, '%08x\n', stim_packed);
    fclose(fid_stim);

    %% 2. 黄金期望输出 (量化后, Q2.14)
    n_out = min(length(y_quant), 8192);  % 最多 8192 个样点
    exp_packed = zeros(n_out, 1, 'uint32');
    for i = 1:n_out
        i_s16 = int16(round(real(y_quant(i)) * 2^14));
        q_s16 = int16(round(imag(y_quant(i)) * 2^14));
        exp_packed(i) = bitor(bitshift(uint32(typecast(q_s16, 'uint16')), 16), ...
                               uint32(typecast(i_s16, 'uint16')));
    end
    fid_exp = fopen(fullfile(out_dir, 'expected_tx.bin'), 'w');
    fprintf(fid_exp, '%08x\n', exp_packed);
    fclose(fid_exp);

    %% 3. 参数
    fid_cfg = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid_cfg, 'MOD=%s\n', cfg.mod);
    fprintf(fid_cfg, 'ALPHA=%.2f\n', cfg.alpha);
    fprintf(fid_cfg, 'SPS=%d\n', cfg.sps);
    fprintf(fid_cfg, 'SPAN=%d\n', cfg.span);
    fprintf(fid_cfg, 'N_SYMBOLS=%d\n', cfg.nsym);
    fprintf(fid_cfg, 'N_IN=%d\n', n_in);
    fprintf(fid_cfg, 'N_OUT=%d\n', n_out);
    fclose(fid_cfg);

    fprintf('[generate_vectors] RRC 激励: rrc_stimulus.bin (%d syms)\n', n_in);
    fprintf('[generate_vectors] 黄金期望: expected_tx.bin (%d samples, Q2.14)\n', n_out);
end
