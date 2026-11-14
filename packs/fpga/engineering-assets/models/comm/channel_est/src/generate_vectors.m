function generate_vectors(cfg)
%% 导出信道估计 RTL 帧级测试向量 (ADR-002: LTS-LS + 导频 CPE 跟踪)
%  功能: 生成 RTL 输入激励 + **位真 (bit-true) 期望输出**, 支撑 0 容差 cosim。
%  期望由本文件内的 RTL 整数语义镜像计算 (LTS 平均舍入 / 导频积累加 /
%  CORDIC 14 迭代求角与旋转 / round+饱和), 与 rtl/ 实现逐字对应 ——
%  任何一侧改动定点语义都必须同步另一侧, 否则 cosim 失配。
%
%  输入 cfg (可缺省, 见 default_cfg): 复用 sim_frame.m 的帧级激励配置
%    (channel_type/delay_profiles/path_gains/snr_db/nsym/residual_cfo_hz/rng_seed)
%
%  输出文件 (到 ../vectors/):
%    rx_chEst_frame.hex        — RTL 激励: (2+nsym)×64 行 (LTS1,LTS2,数据符号)
%    expected_chEst_frame.hex  — 位真期望: nsym×64 行 (逐字判卷, 0 容差)
%    vector_config.txt         — 参数与镜像精度统计
%
%  格式约定 (与 tb_chEst_cosim.sv 一致):
%    Q2.14: ×2^14, int16 饱和; {Q_s16[15:0], I_s16[15:0]} 打包 uint32 hex 一行
%
%  关联: rtl/lts_estimator.sv, rtl/cpe_tracker.sv, rtl/cordic_cv.sv,
%        tb/tb_chEst_cosim.sv, sim_frame.m, lts_seq.m

    if nargin < 1, cfg = struct(); end
    cfg = default_cfg(cfg);
    rng(cfg.rng_seed);

    out_dir = fullfile(fileparts(mfilename('fullpath')), '..', 'vectors');
    if ~exist(out_dir, 'dir'), mkdir(out_dir); end

    N = cfg.N; nsym = cfg.nsym;

    %% 1. 帧级激励 (浮点) -> Q2.14 量化 (量化后的整数即 RTL 全部输入)
    fr = sim_frame(cfg);
    Ylts_i = q14(real(fr.Y_lts));   Ylts_q = q14(imag(fr.Y_lts));    % [N×2]
    Ysym_i = q14(real(fr.Y_syms));  Ysym_q = q14(imag(fr.Y_syms));   % [N×nsym]

    %% 2. RTL 位真镜像
    % 2.1 LTS 符号表 (lts_estimator P_LTS_SEQ 同源: lts_seq): ±1/0
    Xl = real(lts_seq(N));
    guard = (Xl == 0);                        % 保护带+DC (0-based k<6,k>58,k=32)

    % 2.2 H_LTS = floor((s*Y1 + s*Y2 + 1)/2); 保护带/DC = (16384, 0)
    Hfx_i = floor((Xl.*Ylts_i(:,1) + Xl.*Ylts_i(:,2) + 1) / 2);
    Hfx_q = floor((Xl.*Ylts_q(:,1) + Xl.*Ylts_q(:,2) + 1) / 2);
    Hfx_i(guard) = 16384;  Hfx_q(guard) = 0;

    % 2.3 逐数据符号: 导频积 -> CORDIC CPE -> 旋转 -> round/sat 输出
    pil_idx = [11, 25, 39, 53] + 1;           % 0-based -> MATLAB 1-based
    % 802.11a 的 P 序列: (-21,-7,7,21) -> (+1,+1,+1,-1), **负号在 +21** (即 k=53)。
    % 原为 [1,1,-1,1] 且注释写着 "cpe_tracker: 仅 k=39 取负" —— **golden 跟着 RTL 写**,
    % 正是治理要防的本末倒置; 它没被拦住是因为这次写入不在 file-protection 的路径上。
    % owner 2026-08-09 裁定订正, 改由 cpe_tracker 跟随本文件。
    pil_val = [1, 1, 1, -1];                  % 负号在 k=53 (+21)
    exp_i = zeros(N, nsym);  exp_q = zeros(N, nsym);
    cpe_mirror = zeros(nsym, 1);

    for m = 1:nsym
        % **逐符号极性** (owner 2026-08-11 裁定, 方案 A): 与 sim_frame 及
        % models/comm/ofdm 的 subcarrier_map 同规则, 按符号序 ±1 交替、首符号 +1。
        % 镜像必须与 RTL 逐位相同 —— cpe_tracker 用数据符号计数器产生同一序列,
        % 在锁存 S 时按极性取负 (极性对四个导频相同, 负一次 S 比逐个翻转便宜)。
        pol = 1 - 2*mod(m-1, 2);
        S_re = 0; S_im = 0;
        for p = 1:4
            yi = Ysym_i(pil_idx(p), m); yq = Ysym_q(pil_idx(p), m);
            hi = Hfx_i(pil_idx(p));     hq = Hfx_q(pil_idx(p));
            t_re = yi*hi + yq*hq;                 % Y·conj(H) 实部
            t_im = yq*hi - yi*hq;                 % Y·conj(H) 虚部
            S_re = S_re + pol*pil_val(p)*t_re;
            S_im = S_im + pol*pil_val(p)*t_im;
        end
        cpe = cordic_vec(floor(S_re/2^14), floor(S_im/2^14));   % Q3.13
        [c, s] = cordic_rot(9949, 0, cpe);                      % ≈Q2.14
        cpe_mirror(m) = cpe / 2^13;
        exp_i(:,m) = sat16(floor((Hfx_i.*c - Hfx_q.*s + 8192) / 2^14));
        exp_q(:,m) = sat16(floor((Hfx_i.*s + Hfx_q.*c + 8192) / 2^14));
    end

    %% 3. 落盘
    write_hex(fullfile(out_dir, 'rx_chEst_frame.hex'), ...
        [Ylts_i, Ysym_i], [Ylts_q, Ysym_q]);
    write_hex(fullfile(out_dir, 'expected_chEst_frame.hex'), exp_i, exp_q);

    % 镜像精度自证 (仅报告, 不参与判卷): CPE 镜像 vs 浮点 angle
    cpe_float = zeros(nsym, 1);
    for m = 1:nsym
        % 极性同上 —— 这条自证若漏了 pol, 它会与镜像差 pi 而把"精度自证"变成噪声源
        Sf = sum((Ysym_i(pil_idx,m) + 1j*Ysym_q(pil_idx,m)) ...
            .* conj(Hfx_i(pil_idx) + 1j*Hfx_q(pil_idx)) .* ((1 - 2*mod(m-1,2)) * pil_val(:)));
        cpe_float(m) = angle(Sf);
    end
    cpe_err = max(abs(wrap_pi(cpe_mirror - cpe_float)));

    fid = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid, 'BASIS=LTS-LS + pilot CPE tracking (ADR-002)\n');
    fprintf(fid, 'N_FFT=%d\nNSYM=%d\n', N, nsym);
    fprintf(fid, 'CHANNEL=%s\nDELAY_US=%s\nSNR_DB=%.1f\n', cfg.channel_type, ...
        mat2str(cfg.delay_profiles*1e6), cfg.snr_db);
    fprintf(fid, 'RESIDUAL_CFO_HZ=%.1f\nRNG_SEED=%d\n', cfg.residual_cfo_hz, cfg.rng_seed);
    fprintf(fid, 'Q14_SCALE=16384\nCPE_TRUE=%s\n', mat2str(fr.cpe_true.', 4));
    fprintf(fid, 'CPE_MIRROR=%s\n', mat2str(cpe_mirror.', 4));
    fprintf(fid, 'CPE_MIRROR_VS_FLOAT_MAX_ERR_RAD=%.3e\n', cpe_err);
    fclose(fid);

    fprintf('[generate_vectors] 帧向量已写入 %s: 激励 %d 行, 期望 %d 行\n', ...
        out_dir, (2+nsym)*N, nsym*N);
    fprintf('[generate_vectors] CPE 镜像 vs 浮点最大偏差 %.3e rad (CORDIC 量化)\n', cpe_err);
end

%% ===== RTL 位真镜像子函数 =====

function z = cordic_vec(x, y)
% cordic_cv 向量模式镜像: 求 angle(x+jy), Q3.13
% 迭代/预旋转/常数与 rtl/cordic_cv.sv 逐字一致
    PI_Q = 25736;
    ATAN = [6434 3798 2007 1019 511 256 128 64 32 16 8 4 2 1];
    if x < 0
        if y >= 0, z = PI_Q; else, z = -PI_Q; end
        x = -x; y = -y;
    else
        z = 0;
    end
    for i = 0:13
        if y < 0, d = 1; else, d = -1; end
        xn = x - d*floor(y/2^i);
        yn = y + d*floor(x/2^i);
        z  = z - d*ATAN(i+1);
        x = xn; y = yn;
    end
end

function [x, y] = cordic_rot(x, y, z)
% cordic_cv 旋转模式镜像: (x,y) 旋转 z (Q3.13), 含增益 A≈1.6468
% 求 e^{jz} 时以 (9949,0)=(K·2^14,0) 启动 (K=1/A 预补偿)
    PI_Q = 25736; PI_HALF_Q = 12868;
    ATAN = [6434 3798 2007 1019 511 256 128 64 32 16 8 4 2 1];
    if z > PI_HALF_Q
        z = z - PI_Q; x = -x; y = -y;
    elseif z < -PI_HALF_Q
        z = z + PI_Q; x = -x; y = -y;
    end
    for i = 0:13
        if z >= 0, d = 1; else, d = -1; end
        xn = x - d*floor(y/2^i);
        yn = y + d*floor(x/2^i);
        z  = z - d*ATAN(i+1);
        x = xn; y = yn;
    end
end

function v = q14(v)
% Q2.14 量化: round 半值远离零, int16 饱和 (返回 double 存整数值)
    v = round(v * 16384);
    v = min(max(v, -32768), 32767);
end

function v = sat16(v)
    v = min(max(v, -32768), 32767);
end

function w = wrap_pi(w)
    w = mod(w + pi, 2*pi) - pi;
end

function write_hex(path, vi, vq)
% {Q_s16, I_s16} -> uint32 hex, 按列 (符号) 顺序逐行
    vi = int16(vi(:)); vq = int16(vq(:));
    u = bitor(bitshift(uint32(typecast(vq, 'uint16')), 16), ...
              uint32(typecast(vi, 'uint16')));
    fid = fopen(path, 'w');
    fprintf(fid, '%08x\n', u);
    fclose(fid);
end

function cfg = default_cfg(cfg)
% 缺省 = 验收信道 (0.8us 多径) + 300 Hz 残余 CFO, 4 数据符号
    d = struct('N', 64, 'N_cp', 16, 'fs', 20e6, 'M', 16, 'N_data', 48, ...
        'data_idx', [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33, ...
        'pilot_idx', [-21, -7, 7, 21] + 33, ...
        'channel_type', 'rayleigh', ...
        'delay_profiles', [0, 0.2, 0.5, 0.8]*1e-6, ...
        'path_gains', [0, -3, -6, -9], ...
        'snr_db', 20, 'nsym', 4, 'residual_cfo_hz', 300, 'rng_seed', 20260731);
    fn = fieldnames(d);
    for k = 1:numel(fn)
        if ~isfield(cfg, fn{k}), cfg.(fn{k}) = d.(fn{k}); end
    end
end
