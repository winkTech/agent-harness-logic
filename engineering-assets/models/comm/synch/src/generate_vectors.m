function generate_vectors(rx_raw, rx_corrected, sync_info, cfg)
%% 导出同步测试向量供 RTL 仿真使用
%
%  输出 (到 models/comm/synch/vectors/):
%    sync_stimulus.bin     — RTL 输入激励: 接收信号 r (含 CFO/定时偏移/噪声)
%                            {Q[15:0], I[15:0]} uint32 hex, Q2.14
%    expected_sync_out.bin — 期望输出: CFO 校正后的样点, 同格式
%    vector_config.txt     — N_SAMPLES / EPSILON / N_PEAK / N_FINE / FS
%
%  修复记录:
%    - 原来只导期望输出、不导激励, TB 无从复现输入 -> 无法做逐样点对标;
%    - out_dir 用相对 CWD 的 '../vectors/', 换个工作目录就写到别处,
%      现改为按 mfilename 解析到治理规范 V-1 要求的权威位置;
%    - 原来引用 cfg.cfo, 而 config.m 定义的是 cfg.epsilon, 一旦被调用即报错
%      (本函数此前从未被任何脚本调用, 所以这个错一直没暴露)。

    here = fileparts(mfilename('fullpath'));            % models/comm/synch/src
    out_dir = fullfile(here, '..', 'vectors');
    if ~exist(out_dir, 'dir')
        mkdir(out_dir);
    end

    n = min([length(rx_raw), length(rx_corrected), 8192]);

    packed_in  = pack_q14(rx_raw(1:n));
    packed_out = pack_q14(rx_corrected(1:n));

    write_hex(fullfile(out_dir, 'sync_stimulus.bin'),     packed_in);
    write_hex(fullfile(out_dir, 'expected_sync_out.bin'), packed_out);

    fid_cfg = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    if fid_cfg < 0
        error('generate_vectors:openFailed', '无法写入 %s', out_dir);
    end
    fprintf(fid_cfg, 'N_SAMPLES=%d\n', n);
    fprintf(fid_cfg, 'FS=%.0f\n',      cfg.fs);
    fprintf(fid_cfg, 'EPSILON=%.6f\n', cfg.epsilon);
    fprintf(fid_cfg, 'TAU=%d\n',       cfg.tau);
    fprintf(fid_cfg, 'SNR_DB=%d\n',    cfg.snr_db);
    if isfield(sync_info, 'n_peak'),  fprintf(fid_cfg, 'N_PEAK=%d\n',  sync_info.n_peak);  end
    if isfield(sync_info, 'n_fine'),  fprintf(fid_cfg, 'N_FINE=%d\n',  sync_info.n_fine);  end
    if isfield(sync_info, 'epsilon'), fprintf(fid_cfg, 'EPS_EST=%.6f\n', sync_info.epsilon); end
    fclose(fid_cfg);

    fprintf('[generate_vectors] synch: 激励与期望各 %d 样点 -> %s\n', n, out_dir);
end

function p = pack_q14(x)
%  量化到 Q2.14 并打包成 {Q[15:0], I[15:0]}
    i_s16 = int16(max(-32768, min(32767, round(real(x(:)) * 2^14))));
    q_s16 = int16(max(-32768, min(32767, round(imag(x(:)) * 2^14))));
    p = bitor(bitshift(uint32(typecast(q_s16, 'uint16')), 16), ...
              uint32(typecast(i_s16, 'uint16')));
end

function write_hex(path, packed)
    fid = fopen(path, 'w');
    if fid < 0
        error('generate_vectors:openFailed', '无法写入 %s', path);
    end
    fprintf(fid, '%08x\n', packed);
    fclose(fid);
end
