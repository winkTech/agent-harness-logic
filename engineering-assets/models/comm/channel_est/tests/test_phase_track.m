function [pass, detail] = test_phase_track()
    rng(1);
% 测试2: 导频残余相位跟踪 — CPE 估计精度与均衡增益 (ADR-002)
% 注入 300 Hz 残余 CFO (逐符号公共相位斜坡 ~7.5e-3 rad/sym, 50 符号累计 ~0.38 rad),
% 4 导频 CPE 估计须跟住, 且相位跟踪后的均衡 EVM 必须优于不跟踪。
    cfg.N = 64; cfg.N_cp = 16; cfg.fs = 20e6;
    cfg.N_data = 48; cfg.N_pilot = 4;
    cfg.data_idx  = [-26:-22, -20:-8, -6:-1, 1:6, 8:20, 22:26] + 33;
    cfg.pilot_idx = [-21, -7, 7, 21] + 33;
    cfg.delay_profiles = [0, 0.2, 0.5, 0.8] * 1e-6;
    cfg.path_gains     = [0, -3, -6, -10];
    cfg.channel_type = 'rayleigh'; cfg.snr_db = 25;
    cfg.nsym = 50; cfg.M = 4; cfg.residual_cfo_hz = 300;

    fr = sim_frame(cfg);
    H0 = lts_channel_est(fr.Y_lts, cfg.N);
    pilot_val = [1; 1; -1; 1];

    err = zeros(cfg.nsym, 1);
    ev_t = 0; ev_u = 0;
    for m = 1:cfg.nsym
        [H_corr, cpe] = pilot_phase_track(fr.Y_syms(:, m), H0, cfg.pilot_idx, pilot_val);
        err(m) = abs(angle(exp(1j*(cpe - fr.cpe_true(m)))));
        Xt = fr.Y_syms(cfg.data_idx, m) ./ H_corr(cfg.data_idx);
        Xu = fr.Y_syms(cfg.data_idx, m) ./ H0(cfg.data_idx);
        ev_t = ev_t + mean(abs(Xt - fr.X_syms(cfg.data_idx, m)).^2);
        ev_u = ev_u + mean(abs(Xu - fr.X_syms(cfg.data_idx, m)).^2);
    end

    assert(max(err) < 0.1, 'CPE 估计误差 %.3f rad 过大 (门限 0.1)', max(err));
    assert(ev_t < ev_u, '相位跟踪未带来均衡增益 (%.4g >= %.4g)', ev_t, ev_u);
    pass = true;
    detail = sprintf('max|CPE err|=%.3f rad, EVM %.2f%% -> %.2f%%', ...
        max(err), 100*sqrt(ev_u/cfg.nsym), 100*sqrt(ev_t/cfg.nsym));
end
