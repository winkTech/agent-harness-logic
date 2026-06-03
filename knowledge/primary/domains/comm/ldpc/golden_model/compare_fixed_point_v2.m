%% LDPC 定点 vs 浮点 BER 性能对比 (精简版)
% 仅测试有希望的定点格式

clear;
addpath(pwd); addpath(fullfile(pwd, 'src')); addpath(fullfile(pwd, 'tests'));
config;
H = generate_h_matrix(cfg);
fprintf('=== 定点化 BER 性能对比 ===\n\n');

schemes = {
    'Float',     0, 0, '浮点基准'
    'Q(10,4)',  10, 4, '10-bit, 范围[-32,32), step=0.0625'
    'Q(9,4)',    9, 4, '9-bit,  范围[-16,16), step=0.0625'
    'Q(8,3)',    8, 3, '8-bit,  范围[-16,16), step=0.125 (参考)'
};

SNR_list = 0:0.5:3.5;
max_err  = 100;
min_bits = 30000;

BER = zeros(size(schemes,1), length(SNR_list));

for s = 1:size(schemes,1)
    name = schemes{s,1}; bits = schemes{s,2}; frac = schemes{s,3};
    fprintf('[%d/%d] %s\n', s, size(schemes,1), name);

    for snr_idx = 1:length(SNR_list)
        snr_db = SNR_list(snr_idx);
        snr_lin = 10^(snr_db/10);
        sigma2 = 1/(2*cfg.R*snr_lin); sigma = sqrt(sigma2);

        total_bits = 0; bit_errs = 0; num_frames = 0;

        while bit_errs < max_err && total_bits < min_bits * 3
            num_frames = num_frames + 1;
            info = randi([0 1], cfg.K, 1);
            code = ldpc_encode_80211n(info, H, cfg);
            tx = 1 - 2 * double(code);
            rx = tx + sigma * randn(cfg.N, 1);
            llr_in = 2 * rx / sigma2;

            if bits == 0
                dec_info = ldpc_decoder_ms_pure(llr_in, H, cfg.max_iter, cfg.scale_factor);
            else
                qc.total_bits = bits; qc.frac_bits = frac;
                qc.llr_sat = 2^(bits-frac-1) - 2^(-frac);
                dec_info = ldpc_decoder_ms_fixed(llr_in, H, cfg.max_iter, cfg.scale_factor, qc);
            end

            bit_errs = bit_errs + sum(dec_info ~= info);
            total_bits = total_bits + cfg.K;
        end

        BER(s, snr_idx) = bit_errs / total_bits;
        fprintf('  SNR=%.1f: BER=%.2e (%d frames, %d errs)\n', ...
            snr_db, BER(s, snr_idx), num_frames, bit_errs);
    end
    fprintf('\n');
end

save('fixed_point_ber_results.mat', 'schemes', 'SNR_list', 'BER');

% Plot
figure;
colors = lines(size(schemes,1));
for s = 1:size(schemes,1)
    semilogy(SNR_list, BER(s,:), '.-', 'Color', colors(s,:), ...
        'LineWidth', 1.5, 'MarkerSize', 10); hold on;
end
hold off; grid on;
xlabel('SNR (dB)'); ylabel('BER');
title('LDPC Fixed-Point BER Comparison');
legend(schemes(:,1), 'Location', 'southwest');
saveas(gcf, 'fixed_point_ber.png');
fprintf('Saved: fixed_point_ber.png, fixed_point_ber_results.mat\n');
