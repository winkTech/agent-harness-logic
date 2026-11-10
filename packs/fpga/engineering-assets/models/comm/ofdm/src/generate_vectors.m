function generate_vectors(tx_signal, tx_info, cfg)
%GENERATE_VECTORS  导出 RTL cosim 向量 (比特层激励 + 位真期望)
%
%   支撑 ofdm_tx_top 的 G-B-03 **0 容差** 判卷。
%
%   产物 (../vectors/):
%     tx_bits.hex        激励: 每行一个比特组 (LSB 对齐), 48 组/符号
%                        —— DUT 入口是比特流, 故激励必须在比特层
%     expected_tx.hex    期望: 每行一个样点 {Q3.13_Q[15:0], Q3.13_I[15:0]} (uint32)
%                        —— 由 rtl_mirror_tx 定点位真产出, **非浮点量化**
%     freq_grid.hex      中间量: 频域整数网格 (Q2.14), 仅供失配定位, 不参与判卷
%     vector_config.txt  参数
%
%   1.2.0 相对 1.1.0 的变更 (ADR-004 阶段3 排期项):
%     - 期望值由「浮点 golden 直接量化 + ±1 LSB 容差」改为「定点位真镜像 + 0 容差」。
%       浮点量化与定点逐级舍入存在系统差, 只能做容差判卷, 不满足 G-B-03。
%     - 频域缩放修正: 原按 x32767 (Q1.15) 导出, 与 config.m 声明的 IFFT 输入
%       Q2.14 (x16384) 不符 (MODEL-STATUS §4 第一条)。现由镜像按 Q2.14 产出。
%     - 激励层级由「频域网格」改为「比特流」, 与 DUT 接口对齐 —— 原 freq_*.bin
%       是 golden 的频域中间量, 与 DUT 入口不同层, 据此比对在语义上不成立。
%
%   入参保持 1.1.0 签名以兼容 run_ofdm_sim.m; tx_signal 不再用于产生期望值
%   (它是浮点结果), 仅用于长度自检。

    here    = fileparts(mfilename('fullpath'));
    out_dir = fullfile(here, '..', 'vectors');
    if ~exist(out_dir, 'dir'), mkdir(out_dir); end

    % ---- 位真镜像: 由同一比特流产出激励与期望 --------------------------
    mir = rtl_mirror_tx(tx_info.tx_bits, cfg.mod_type, cfg.N_sym);

    n_exp = cfg.N_sym * (cfg.N + cfg.N_cp);
    if numel(mir.samples) ~= n_exp
        error('generate_vectors:len', '镜像样点数 %d 与预期 %d 不符', ...
              numel(mir.samples), n_exp);
    end
    if numel(tx_signal) ~= n_exp
        warning('generate_vectors:floatLen', ...
                '浮点链样点数 %d 与镜像 %d 不一致 (仅提示, 判卷以镜像为准)', ...
                numel(tx_signal), n_exp);
    end

    % ---- 1. 激励: 比特组 --------------------------------------------------
    fid = fopen(fullfile(out_dir, 'tx_bits.hex'), 'w');
    fprintf(fid, '%02x\n', mir.bit_groups);
    fclose(fid);

    % ---- 2. 期望: {Q, I} 打包 uint32 (匹配 m_axis_tdata) -------------------
    i16 = int16(real(mir.samples));
    q16 = int16(imag(mir.samples));
    u32 = bitor(bitshift(uint32(typecast(q16, 'uint16')), 16), ...
                 uint32(typecast(i16, 'uint16')));
    fid = fopen(fullfile(out_dir, 'expected_tx.hex'), 'w');
    fprintf(fid, '%08x\n', u32);
    fclose(fid);

    % ---- 3. 中间量: 频域网格 (Q2.14), 失配定位用 --------------------------
    g  = mir.freq_grid(:);
    gu = bitor(bitshift(uint32(typecast(int16(imag(g)), 'uint16')), 16), ...
                uint32(typecast(int16(real(g)), 'uint16')));
    fid = fopen(fullfile(out_dir, 'freq_grid.hex'), 'w');
    fprintf(fid, '%08x\n', gu);
    fclose(fid);

    % ---- 4. 参数 ----------------------------------------------------------
    fid = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid, 'FFT_N=%d\n',         cfg.N);
    fprintf(fid, 'CP_LEN=%d\n',        cfg.N_cp);
    fprintf(fid, 'N_SYM=%d\n',         cfg.N_sym);
    fprintf(fid, 'N_SAMPLES=%d\n',     n_exp);
    fprintf(fid, 'N_GROUPS=%d\n',      numel(mir.bit_groups));
    fprintf(fid, 'MOD=%s\n',           cfg.mod_type);
    fprintf(fid, 'FREQ_SCALE=%d\n',    16384);    % Q2.14, 见 config.m
    fprintf(fid, 'TIME_SCALE=%d\n',    8192);     % Q3.13
    fprintf(fid, 'TOLERANCE_LSB=%d\n', 0);        % 位真, 0 容差
    fprintf(fid, 'SOURCE=rtl_mirror_tx (bit-true mirror)\n');
    fclose(fid);

    fprintf('[generate_vectors] 激励 %d 比特组, 期望 %d 样点 (位真, 0 容差) -> %s\n', ...
            numel(mir.bit_groups), n_exp, out_dir);
end
