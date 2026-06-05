function generate_vectors(rx_signal, sync_info, cfg)
%% 导出同步测试向量供 RTL 仿真使用
%  输出:
%    expected_sync_out.bin — 期望输出 (pass-through + CFO校正后)
% ============================================================================

    out_dir = '../vectors/';
    if ~exist(out_dir, 'dir')
        mkdir(out_dir);
    end

    n = min(length(rx_signal), 8192);

    % 量化到 Q2.14
    i_s16 = int16(max(-32768, min(32767, round(real(rx_signal(1:n)) * 2^14))));
    q_s16 = int16(max(-32768, min(32767, round(imag(rx_signal(1:n)) * 2^14))));

    % 打包 {Q[15:0], I[15:0]} uint32
    packed = bitor(bitshift(uint32(typecast(q_s16, 'uint16')), 16), ...
                    uint32(typecast(i_s16, 'uint16')));

    fid = fopen(fullfile(out_dir, 'expected_sync_out.bin'), 'w');
    fprintf(fid, '%08x\n', packed);
    fclose(fid);

    % 参数
    fid_cfg = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid_cfg, 'N_SAMPLES=%d\n', n);
    fprintf(fid_cfg, 'FS=%.0f\n', cfg.fs);
    fprintf(fid_cfg, 'CFO=%.2f\n', cfg.cfo);
    fclose(fid_cfg);

    fprintf('[generate_vectors] sync expected output: %d samples\n', n);
end
