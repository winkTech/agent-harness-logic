function pass = test_modulations()
%% 多调制方式测试: 验证BPSK/QPSK/16QAM/64QAM在理想信道下都工作
    mod_types = {'BPSK', 'QPSK', '16QAM', '64QAM'};
    pass_all = true;

    for i = 1:length(mod_types)
        cfg = config();
        cfg.mod_type = mod_types{i};
        cfg.plot_en = false;
        cfg.save_vectors = false;

        [tx_signal, tx_info] = tx_chain(cfg);
        rx_bits = rx_chain(tx_signal, cfg);

        ber = sum(abs(tx_info.tx_bits - rx_bits)) / length(tx_info.tx_bits);
        ok = ber < 1e-10;

        fprintf('  %s: BER = %g %s\n', mod_types{i}, ber, string(ok));
        pass_all = pass_all && ok;
    end

    pass = pass_all;
end
