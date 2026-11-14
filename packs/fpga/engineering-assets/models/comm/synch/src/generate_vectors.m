function generate_vectors(r_float, t_long, cfg)
%% 导出 sync_top RTL 帧级测试向量 (ADR-003: 因果化 RTL 位真镜像)
%  功能: 生成 RTL 输入激励 + **位真 (bit-true) 期望输出**, 支撑 0 容差 cosim。
%  期望由本文件内的 sync_top RTL 整数语义镜像计算, 与 rtl/ 实现逐字对应:
%    检测:   p(m)=r(m)·conj(r(m-16)) (m<32 清零), C/P 递推 (减项 m<48 清零),
%            判决 b(m) = (m>=48) && (2·|floor(C/2^16)|² > floor(P/2^16)²),
%            9 连平顶 (run 饱和于 8), start=m-8, S_cfo=Σ_平顶 p(m) (首项含第
%            9 个越限样点); n_peak = start + floor((end-start)/2)
%    CFO:    φ = cordic_vec(floor(S/2^18)) (Q3.13, 14 迭代);
%            θ_inc = -(φ·16) (Q3.21); corr_start = end + 40
%    校正:   n>=corr_start: θ(n)=floor((acc+128)/256), acc±π回绕累加; 否则 θ=0
%            K 预缩放 floor((x·9949+8192)/2^14) -> 14 级 CORDIC 旋转 -> sat16
%    精定时: T1 符号量化 (值>0 取 +1, 否则 -1) 64 抽头相关, |R|² 峰值搜索
%            c ∈ [n_peak, n_peak+256] (严格 > 先到者胜); T2 防错锁:
%            pk>=n_peak+64 且 |R(pk-64)|² >= floor(|R(pk)|²/4) 则 n_fine=pk-64
%    输出:   m_axis = 校正流延迟 384 拍 -> 期望 = out(0 .. N-385)
%  任何一侧改动整数语义都必须同步另一侧, 否则 cosim 失配。
%
%  输入: r_float — 含 CFO/定时偏移/噪声的接收流 (run_synch_sim 构造);
%        t_long  — T1 时域 64 样点 (符号量化系数表导出);
%        cfg     — config 结构体 (元数据落盘用)
%  输出 (到 models/comm/synch/vectors/):
%    sync_stimulus.bin     — N 行 {Q[15:0],I[15:0]} uint32 hex (Q2.14)
%    expected_sync_out.bin — N-384 行, 位真期望 (0 容差判卷)
%    t1_sign_coeffs.txt    — 64 行 "a b" (±1), RTL P_SRE/P_SIM 逐位核对
%    vector_config.txt     — 参数与镜像结果 (N_PEAK/CORR_START/N_FINE 等)
%  关联: rtl/sync_detect.sv, rtl/sync_top.sv, rtl/cordic_rot_pipe.sv,
%        rtl/sync_correlator.sv, rtl/sync_track_out.sv, tb/tb_sync_cosim.sv

    here = fileparts(mfilename('fullpath'));            % models/comm/synch/src
    out_dir = fullfile(here, '..', 'vectors');
    if ~exist(out_dir, 'dir'), mkdir(out_dir); end

    P_DLY = 384;

    %% 1. 量化激励 (int 值即 RTL 全部输入)
    ri = q14(real(r_float(:)));
    rq = q14(imag(r_float(:)));
    N  = length(ri);

    %% 2. 检测镜像 (0-based m, MATLAB 下标 m+1)
    p_re = zeros(N,1); p_im = zeros(N,1); e = zeros(N,1);
    for m = 32:N-1
        p_re(m+1) = ri(m+1)*ri(m-15) + rq(m+1)*rq(m-15);
        p_im(m+1) = rq(m+1)*ri(m-15) - ri(m+1)*rq(m-15);
        e(m+1)    = ri(m-15)^2 + rq(m-15)^2;
    end
    C_re = 0; C_im = 0; P = 0;
    run = 0; inplat = false; consumed = false;
    S_re = 0; S_im = 0;
    plat_s = -1; plat_e = -1;
    for m = 0:N-1
        % 减项 m<48 清零 — 用显式分支: MATLAB 的 sub*p(m-15) 会先求值负索引
        if m >= 48
            C_re = C_re + p_re(m+1) - p_re(m-15);
            C_im = C_im + p_im(m+1) - p_im(m-15);
            P    = P    + e(m+1)    - e(m-15);
        else
            C_re = C_re + p_re(m+1);
            C_im = C_im + p_im(m+1);
            P    = P    + e(m+1);
        end
        cs_r = floor(C_re / 65536); cs_i = floor(C_im / 65536);
        ps   = floor(P / 65536);
        b    = (m >= 48) && (2*(cs_r^2 + cs_i^2) > ps^2);

        hit  = b && ~inplat && (run == 8);
        fall = inplat && ~b;
        if b
            if run ~= 8, run = run + 1; end
        else
            run = 0;
        end
        if hit
            inplat = true;
            if ~consumed, plat_s = m - 8; S_re = p_re(m+1); S_im = p_im(m+1); end
        elseif inplat && b
            if ~consumed, S_re = S_re + p_re(m+1); S_im = S_im + p_im(m+1); end
        elseif fall
            inplat = false;
            % 平顶接受判据: 长度 >= 64 (RTL P_MINPLAT 同式, 拒斜坡瞬态假平顶);
            % 被拒平顶后下一次 hit 会重置 plat_s 与 S (与 RTL 检测器一致)
            if ~consumed && (m - plat_s) >= 64
                plat_e = m; consumed = true;
            end
        end
    end
    assert(consumed, 'generate_vectors: 检测镜像未产生平顶 (无法导出)');
    n_peak     = plat_s + floor((plat_e - plat_s)/2);
    corr_start = plat_e + 40;

    %% 3. CFO 求角 + NCO + 旋转镜像
    phi  = cordic_vec(floor(S_re/2^18), floor(S_im/2^18));   % Q3.13
    tinc = -(phi * 16);                                      % Q3.21
    PI_Q21 = 6588416; TWO_PI_Q21 = 13176832;

    out_i = zeros(N,1); out_q = zeros(N,1);
    acc = 0;
    for m = 0:N-1
        if m >= corr_start
            theta = floor((acc + 128) / 256);                % Q3.13
            a2 = acc + tinc;
            if a2 > PI_Q21,      a2 = a2 - TWO_PI_Q21;
            elseif a2 < -PI_Q21, a2 = a2 + TWO_PI_Q21;
            end
            acc = a2;
        else
            theta = 0;
        end
        kx = floor((ri(m+1)*9949 + 8192) / 16384);
        ky = floor((rq(m+1)*9949 + 8192) / 16384);
        [xr, yr] = cordic_rot(kx, ky, theta);
        out_i(m+1) = sat16(xr);
        out_q(m+1) = sat16(yr);
    end

    %% 4. 精定时镜像 (符号量化相关 + 峰值搜索 + T2 防错锁)
    sre = (real(t_long(:)) > 0)*2 - 1;                       % 0 取 -1
    sim_ = (imag(t_long(:)) > 0)*2 - 1;
    % 存档到 +320 (后继判别要读 pk+64), 峰值窗仍 [n_peak, n_peak+256]
    r2c = containers.Map('KeyType','double','ValueType','double');
    pk_val = 0; pk_idx = -1;
    for c = n_peak : n_peak + 320
        m_end = c + 63;
        if m_end > N-1, break; end
        Rr = 0; Ri = 0;
        for k = 0:63
            a = sre(k+1); b2 = sim_(k+1);
            oi = out_i(c+k+1); oq = out_q(c+k+1);
            Rr = Rr + a*oi + b2*oq;
            Ri = Ri + a*oq - b2*oi;
        end
        r2 = Rr^2 + Ri^2;
        r2c(c) = r2;
        if c <= n_peak + 256 && r2 > pk_val, pk_val = r2; pk_idx = c; end
    end
    % T2 防错锁 (后继判别, 与 sync_track_out 同式): 真 T1 的 pk+64 = 全强 T2;
    % T2 的 pk+64 = 数据区噪声。后继强 => pk 即 T1; 弱 => pk 是 T2 取 pk-64
    if isKey(r2c, pk_idx+64) && r2c(pk_idx+64) >= floor(pk_val/4)
        n_fine = pk_idx;
    elseif pk_idx >= n_peak + 64
        n_fine = pk_idx - 64;
    else
        n_fine = pk_idx;
    end

    %% 5. 落盘
    write_hex(fullfile(out_dir, 'sync_stimulus.bin'),     ri, rq);
    write_hex(fullfile(out_dir, 'expected_sync_out.bin'), ...
              out_i(1:N-P_DLY), out_q(1:N-P_DLY));

    fid = fopen(fullfile(out_dir, 't1_sign_coeffs.txt'), 'w');
    for k = 1:64, fprintf(fid, '%d %d\n', sre(k), sim_(k)); end
    fclose(fid);

    eps_mirror = 2 * (phi/8192) / pi;
    fid = fopen(fullfile(out_dir, 'vector_config.txt'), 'w');
    fprintf(fid, 'BASIS=causal RTL bit-true mirror (ADR-003)\n');
    fprintf(fid, 'N_SAMPLES=%d\nN_EXPECTED=%d\nDLY=%d\n', N, N-P_DLY, P_DLY);
    fprintf(fid, 'EPSILON=%.6f\nTAU=%d\nSNR_DB=%d\n', cfg.epsilon, cfg.tau, cfg.snr_db);
    fprintf(fid, 'N_PEAK=%d\nCORR_START=%d\nPHI_Q13=%d\nEPS_EST_MIRROR=%.6f\n', ...
        n_peak, corr_start, phi, eps_mirror);
    fprintf(fid, 'N_FINE=%d\nT1_TRUE=%d\nPLAT=[%d,%d]\n', ...
        n_fine, cfg.tau + 192, plat_s, plat_e);
    fclose(fid);

    fprintf('[generate_vectors] 镜像: 平顶 [%d,%d] n_peak=%d corr_start=%d\n', ...
        plat_s, plat_e, n_peak, corr_start);
    fprintf('[generate_vectors] 镜像: eps_est=%.4f (真值 %.4f), n_fine=%d (真值 %d)\n', ...
        eps_mirror, cfg.epsilon, n_fine, cfg.tau + 192);
    fprintf('[generate_vectors] 激励 %d 行, 期望 %d 行 -> %s\n', N, N-P_DLY, out_dir);
end

%% ===== RTL 位真镜像子函数 (与 cordic_cv/cordic_rot_pipe 常数逐字一致) =====

function z = cordic_vec(x, y)
% cordic_cv 向量模式镜像: 求 angle(x+jy), Q3.13
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
% cordic_rot_pipe 镜像: (x,y) 旋转 z (Q3.13), 含增益 A≈1.6468
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

function write_hex(path, vi, vq)
% {Q_s16, I_s16} -> uint32 hex 逐行
    vi = int16(vi(:)); vq = int16(vq(:));
    u = bitor(bitshift(uint32(typecast(vq, 'uint16')), 16), ...
              uint32(typecast(vi, 'uint16')));
    fid = fopen(path, 'w');
    fprintf(fid, '%08x\n', u);
    fclose(fid);
end
