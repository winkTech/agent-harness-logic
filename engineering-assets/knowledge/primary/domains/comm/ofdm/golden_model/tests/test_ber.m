function pass = test_ber()
%% BER 测试: 理想信道下应为0
    cfg = config();
    cfg.plot_en = false;
    cfg.save_vectors = false;

    [tx_signal, tx_info] = tx_chain(cfg);
    rx_bits = rx_chain(tx_signal, cfg);

    ber = sum(abs(tx_info.tx_bits - rx_bits)) / length(tx_info.tx_bits);
    pass = ber < 1e-10;

    fprintf('  BER = %g %s\n', ber, string(pass));
end
