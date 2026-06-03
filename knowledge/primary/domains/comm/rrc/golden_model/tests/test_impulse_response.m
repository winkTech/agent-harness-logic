function [pass, detail] = test_impulse_response()
    rng(0);  % fix random seed for reproducibility
% 测试5: 冲激响应 — 验证 ISI 特性
% RRC + RRC = RC → 在最佳采样点应为零 ISI

    cfg.alpha = 0.5; cfg.sps = 4;
    cfg.span = 16;  % 长跨度保精度
    cfg.plot_en = false; cfg.verbose = false;
    cfg.save_vectors = false;

    % 生成 RRC 系数
    [h, ~] = rrc_coeff_gen(cfg);

    % RC = RRC * RRC (自卷积)
    rc = conv(h, h);
    rc = rc / max(abs(rc));  % 归一化

    % 提取最佳采样点 (每 sps 个样点)
    center = (length(rc) + 1) / 2;
    idx = center : cfg.sps : length(rc);
    idx = idx(idx <= length(rc));
    rc_sampled = rc(idx);

    % 中心点应为 1
    assert(abs(rc_sampled(1) - 1) < 0.01, '中心点 ≠ 1');

    % 其他点应接近 0 (ISI 指标)
    isi_power = sum(abs(rc_sampled(2:end)).^2) / abs(rc_sampled(1)).^2;
    isi_db = 10 * log10(isi_power);

    % ISI 应 < -40 dB
    assert(isi_db < -40, 'ISI 过高: %.2f dB', isi_db);

    pass = true;
    detail = sprintf('ISI=%.1f dB (span=%d)', isi_db, cfg.span);
end
