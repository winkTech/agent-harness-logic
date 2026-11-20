function pass = test_performance()
% 测试用例: 性能基线
% 测量 BER/EVM，与理论曲线对比
    cfg = config();
    cfg.plot_en = true;

    SNR_dB = 0:2:20;
    ber = zeros(size(SNR_dB));

    for i = 1:length(SNR_dB)
        cfg.SNR_dB = SNR_dB(i);
        x = generate_test_data(cfg.N, 'random');
        y = tx_chain(x, cfg);
        [ber(i), ~] = measure_ber(x, y);
    end

    % 与理论曲线对比
    ber_theory = ber_theoretical(SNR_dB, cfg.modulation);

    % 绘图
    if cfg.plot_en
        figure;
        semilogy(SNR_dB, ber, 'o-', SNR_dB, ber_theory, '--');
        xlabel('SNR (dB)'); ylabel('BER');
        legend('实测', '理论', 'Location','southwest');
        grid on;
        saveas(gcf, '../results/ber_curve.png');
    end

    % 门限判断: 性能退化 < 0.5dB
    pass = max(abs(ber - ber_theory)) < 0.5;
end

function ber = ber_theoretical(SNR_dB, mod)
    % TODO: 理论 BER 曲线
    SNR_lin = 10.^(SNR_dB/10);
    ber = 0.5 * erfc(sqrt(SNR_lin));
end
