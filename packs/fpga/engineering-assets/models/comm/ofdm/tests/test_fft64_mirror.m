function pass = test_fft64_mirror()
%% fft64 定点镜像测试
%  A. 反验: 本镜像在 ifft/P_W=20 下必须与**已认证**的 rtl_mirror_tx 逐位一致。
%     rtl_mirror_tx 已对 ofdm_tx_top 的 RTL 做到 2560 样点 0 失配, 故它即 RTL 真值;
%     反验通过才说明结构/计数器/旋转指数/舍入点全部对齐, 换方向的 fft 分支才可信。
%  B. 溢出判定: s20 在满幅对抗输入下回绕, s21 不回绕 (需求门禁 2026-08-03 的 s21 裁定依据)。
    N = 64; ONE = 2^14; Q = 2^15 - 1;
    S20 = 2^19 - 1; S21 = 2^20 - 1;
    mods = {'BPSK','QPSK','16QAM','64QAM'}; nbs = [1 2 4 6]; N_sym = 8;

    % ---- A. 反验 ----
    okA = true;
    for k = 1:numel(mods)
        rng(4242 + k);
        bits = randi([0 1], N_sym*48*nbs(k), 1);
        ref = rtl_mirror_tx(bits, mods{k}, N_sym);
        body = zeros(N, N_sym);
        for s = 1:N_sym
            body(:, s) = ref.samples((s-1)*80 + 16 + (1:N));
        end
        mine = rtl_mirror_fft64(ref.freq_grid, 'ifft', 'natural', 20);
        nmis = sum(abs(mine.samples(:) - body(:)) > 0);
        if nmis ~= 0
            fprintf('  [A] %s 失配 %d/%d\n', mods{k}, nmis, numel(body));
            okA = false;
        end
    end

    % ---- B. 溢出判定 (按输出 bin 逐个对抗构造, 取最坏) ----
    worst = 0;
    for kk = 0:N-1
        n = (0:N-1).'; th = 2*pi*n*kk/N;
        sr = ones(N,1); sr(cos(th) < 0) = -1;
        si = ones(N,1); si(sin(th) < 0) = -1;
        r = rtl_mirror_fft64(Q*sr - 1i*Q*si, 'fft', 'natural', 24);  % 宽内部, 只量真实峰值
        worst = max(worst, max(r.stage_peak));
    end
    okB = (worst > S20) && (worst <= S21);

    % ---- C. 正向数值: 与浮点 fft_chain 的偏差须在量化量级 ----
    %  原测试只有 A(ifft 位真) 与 B(溢出), 正向分支的数值正确性无人把关 ——
    %  正是这个缺口让"只翻旋转因子表、漏翻 BF2II 平凡因子"的缺陷溜了过去。
    %  判据用信号自身幅度做标尺, 而不是一个绝对 LSB 数, 避免再次误判量级。
    config; cfg.N_sym = 4; cfg.plot_en = false; cfg.mod_type = 'QPSK'; cfg.mod_order = 2;
    rng(99); evalc('[~, tx_info] = tx_chain(cfg);');
    ts = tx_info.time_sym;
    pk = max(max(abs(real(ts(:)))), max(abs(imag(ts(:)))));
    ts = ts * (Q/ONE) / pk;
    xi = round(real(ts)*ONE) + 1i*round(imag(ts)*ONE);
    fx = rtl_mirror_fft64(xi, 'fft', 'natural', 21);
    ref = fft_chain(double(xi)/ONE, cfg) * ONE;
    errC = max(abs(fx.samples(:) - ref(:)));
    okC = errC < 0.01 * max(abs(ref(:)));      % 量化量级, 而非信号量级
    fprintf('  [C] 正向 vs 浮点: 最大误差 %.1f LSB (信号幅度 %.0f LSB): %s\n', ...
            errC, max(abs(ref(:))), string(okC));

    fprintf('  [A] 反验 rtl_mirror_tx: %s | [B] 最坏移位前峰值 %.3f (s20 %.3f / s21 %.3f): %s\n', ...
            string(okA), worst/ONE, S20/ONE, S21/ONE, string(okB));
    pass = okA && okB && okC;
end
